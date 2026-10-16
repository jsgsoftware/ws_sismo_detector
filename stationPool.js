import { readFile } from 'node:fs/promises';
import { miniseed } from 'seisplotjs/nodeonly';
import { StaLtaDetector } from './services/phasePicker.js';
import { preprocessSignal } from './services/signalProcessing.js';
import { epicentralDistanceKm as distance } from './services/eventLocator.js';
import { fetchText, loadLiveInventory, selectStrategicStations, STATION_LIMIT, MAX_DATA_AGE_MS } from './services/globalInventory.js';
import { SeedlinkFeed } from './services/seedlinkFeed.js';
import { RawWindow } from './services/rawWindow.js';

export let GLOBAL_STATIONS = [];

export async function loadStationsFromFDSN() {
  let text;
  try {
    text = await fetchText('https://service.earthscope.org/fdsnws/station/1/query?format=text&level=station&channel=BHZ,HHZ&includerestricted=false&endafter=' + new Date().toISOString().slice(0, 10));
  } catch (error) {
    console.warn('[FDSN] Catalog request failed:', error.message);
    try { text = await readFile(new URL('./stations.txt', import.meta.url), 'utf8'); }
    catch { return; }
  }
  const stations = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const p = line.split('|').map(v => v.trim());
    const lat = Number(p[2]), lon = Number(p[3]);
    if (p.length < 6 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const code = `${p[0]}-${p[1]}`;
    stations.set(code, { code, network: p[0], station: p[1], lat, lon, name: p[5] || code });
  }
  GLOBAL_STATIONS = [...stations.values()];
}

export function findNearbyStations(lat, lon, radiusKm, maxStations = 3, catalog = GLOBAL_STATIONS) {
  return catalog.map(s => ({ ...s, distance: distance(lat, lon, s.lat, s.lon) }))
    .filter(s => s.distance <= radiusKm).sort((a, b) => a.distance - b.distance).slice(0, maxStations);
}

export class GlobalMonitor {
  constructor({ inventory = loadLiveInventory, Feed = SeedlinkFeed, refreshMs = 15 * 60 * 1000 } = {}) {
    Object.assign(this, { inventory, Feed, refreshMs });
    this.entries = new Map(); this.users = new Map(); this.feeds = [];
    this.status = 'stopped'; this.stopped = true; this.lastError = null;
    this.lastRefreshAt = null; this.candidateCount = 0;
  }
  async start(onData, onAlert) {
    if (!this.stopped) return;
    this.stopped = false; this.onData = onData; this.onAlert = onAlert;
    await this.refresh();
  }
  async refresh() {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true; this.status = 'selecting';
    try {
      const candidates = await this.inventory(GLOBAL_STATIONS);
      if (this.stopped) return;
      this.candidateCount = candidates.length;
      const selected = selectStrategicStations(candidates);
      if (!selected.length) throw new Error('No recent calibrated vertical streams available');
      const signature = selected.map(s => `${s.code}.${s.location}.${s.channel}`).sort().join(',');
      if (signature !== this.signature) {
        // Close old groups before replacements: at most three sockets.
        this.feeds.forEach(f => f.stop());
        const previous = this.entries;
        this.entries = new Map(selected.map(station => {
          const old = previous.get(station.code);
          const same = old && old.station.location === station.location && old.station.channel === station.channel;
          return [station.code, { station, channels: { z: { ...station, component: 'Z' } },
            detectors: same ? old.detectors : {}, subscribers: new Set(), userLocations: new Map(),
            lastDataTime: 0, lastSampleAt: same ? old.lastSampleAt : null,
            packetCount: 0, processedPackets: 0, lastError: null }];
        }));
        for (const [id, user] of [...this.users]) this.subscribe(id, user.lat, user.lon, user.radiusKm);
        const groups = [[], [], []];
        selected.forEach((s, index) => groups[index % 3].push(s));
        this.feedStates = [];
        this.feeds = groups.filter(g => g.length).map((group, index) => new this.Feed(group,
          packet => this.handlePacket(packet), (state, error) => {
            this.feedStates[index] = { state, error: error || null };
            if (error) console.warn(`[SEEDLINK ${index}] ${error}`);
          }));
        this.signature = signature;
        this.feeds.forEach(f => f.start());
      } else {
        selected.forEach(station => { this.entries.get(station.code).station = station; });
      }
      this.lastRefreshAt = new Date().toISOString(); this.lastError = null; this.status = 'monitoring';
      console.log(`[GLOBAL] ${selected.length}/${STATION_LIMIT} selected from ${candidates.length} recent stations; ${this.feeds.length} sockets`);
    } catch (error) {
      this.lastError = error.message; this.status = 'degraded';
      console.error('[GLOBAL]', error.message);
    } finally {
      this.refreshing = false;
      if (!this.stopped) this.timer = setTimeout(() => this.refresh(), this.lastError ? 60000 : this.refreshMs);
    }
  }
  handlePacket(packet) {
    const header = packet.miniseed?.header;
    if (!header) return;
    const entry = this.entries.get(`${header.netCode}-${header.staCode}`);
    if (!entry || header.chanCode !== entry.station.channel || header.locCode.trim() !== entry.station.location) return;
    try {
      const segment = miniseed.seismogramSegmentPerChannel([packet.miniseed])[0];
      if (!segment?.y?.length) return;
      const end = segment.endTime.toMillis(), now = Date.now();
      if (!Number.isFinite(end) || now - end > MAX_DATA_AGE_MS || end > now + 5000) return;
      if (entry.lastSampleAt != null && segment.startTime.toMillis() <= entry.lastSampleAt) return;
      const { channel, sensitivity } = entry.station;
      const gap = entry.lastSampleAt != null && segment.startTime.toMillis() - entry.lastSampleAt > 2000;
      if (!entry.detectors[channel] || entry.detectors[channel].sampleRate !== segment.sampleRate || gap) {
        entry.detectors[channel] = new StaLtaDetector(channel, segment.sampleRate);
      }
      entry.lastDataTime = now; entry.lastSampleAt = end; entry.packetCount++;
      if (!entry.rawWindow || entry.rawWindow.rate !== segment.sampleRate || gap) entry.rawWindow = new RawWindow(segment.sampleRate);
      entry.rawWindow.append(segment.y, segment.startTime.toMillis());
      const physical = segment.cloneWithNewData(Float32Array.from(segment.y, n => n / sensitivity.sensitivity));
      physical.yUnit = 'm/s';
      const filtered = preprocessSignal(physical, segment.sampleRate);
      if (!filtered) { entry.lastError = 'Signal filter failed'; return; }
      entry.processedPackets++; entry.lastError = null;
      this.onData?.(entry, entry.channels.z, filtered.y, segment.sampleRate, channel, 'm/s');
      this.onAlert?.(entry, entry.channels.z, filtered, segment.sampleRate, channel, physical);
    } catch (error) {
      entry.lastError = error.message;
      console.warn(`[GLOBAL] ${entry.station.code}: ${error.message}`);
    }
  }
  subscribe(id, lat, lon, radiusKm) {
    this.unsubscribe(id); this.users.set(id, { lat, lon, radiusKm });
    for (const station of findNearbyStations(lat, lon, radiusKm, 3, [...this.entries.values()].map(e => e.station))) {
      const entry = this.entries.get(station.code);
      entry.subscribers.add(id); entry.userLocations.set(id, { lat, lon });
    }
    return this.userStations(id);
  }
  unsubscribe(id) {
    this.users.delete(id);
    for (const e of this.entries.values()) { e.subscribers.delete(id); e.userLocations.delete(id); }
    // User disconnects never control SeedLink lifetime.
  }
  isLive(e) { return e.lastDataTime > 0 && Date.now() - e.lastDataTime <= MAX_DATA_AGE_MS && Date.now() - e.lastSampleAt <= MAX_DATA_AGE_MS; }
  userStations(id) {
    return [...this.entries.values()].filter(e => e.subscribers.has(id)).map(e => ({ code: e.station.code,
      name: e.station.name, connected: this.isLive(e), subscribers: e.subscribers.size }));
  }
  stats() {
    const entries = [...this.entries.values()];
    return { mode: 'global', stationLimit: STATION_LIMIT, status: this.status, lastError: this.lastError,
      lastRefreshAt: this.lastRefreshAt, availableCandidates: this.candidateCount,
      selectedStations: entries.length, totalConnections: this.feeds.length,
      totalSubscribers: this.users.size, connectedStations: entries.filter(e => this.isLive(e)).length,
      feeds: this.feedStates || [], stations: entries.map(e => ({ code: e.station.code, name: e.station.name,
        lat: e.station.lat, lon: e.station.lon, connected: this.isLive(e), subscribers: e.subscribers.size,
        channels: { z: e.station.channel }, location: e.station.location,
        lastDataTime: e.lastDataTime || null, dataAgeMs: e.lastSampleAt ? Date.now() - e.lastSampleAt : null,
        packetCount: e.packetCount, processedPackets: e.processedPackets, lastError: e.lastError })) };
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.feeds.forEach(f => f.stop()); this.status = 'stopped'; }
}

const monitor = new GlobalMonitor();
export const startGlobalMonitoring = (onData, onAlert) => monitor.start(onData, onAlert);
export const stopGlobalMonitoring = () => monitor.stop();
export const subscribeUserToStations = (id, lat, lon, radius) => monitor.subscribe(id, lat, lon, radius);
export const unsubscribeUser = id => monitor.unsubscribe(id);
export const getUserStations = id => monitor.userStations(id);
export const getPoolStats = () => monitor.stats();
export function getRawPWindow(pick) {
  const entry = monitor.entries.get(pick.stationCode);
  if (!entry || entry.station.channel !== pick.channel || entry.station.location !== pick.location) return null;
  const window = entry.rawWindow?.snapshot(pick.pTime.toMillis());
  return window ? { ...window, stationCode: pick.stationCode, network: entry.station.network,
    station: entry.station.station, location: entry.station.location, channel: entry.station.channel,
    lat: entry.station.lat, lon: entry.station.lon } : null;
}
