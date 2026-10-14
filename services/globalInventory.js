import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { epicentralDistanceKm as distance } from './eventLocator.js';

export const STATION_LIMIT = 300;
export const MAX_DATA_AGE_MS = 60000;
const exec = promisify(execFile);

export async function fetchText(url) {
  const { stdout } = await exec(process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['-g', '-fsSL', '--max-time', '60', url], { timeout: 65000, maxBuffer: 40 * 1024 * 1024 });
  return stdout;
}

// FDSN channel text contains sensitivity and units; do not mistake sensor
// description (column 10) for sample rate (column 14).
export function parseChannels(text, now = Date.now()) {
  const channels = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length < 17) continue;
    const [network, station, location, channel] = p;
    const lat = Number(p[4]), lon = Number(p[5]);
    const scale = Number(p[11]), sampleRate = Number(p[14]);
    const start = Date.parse(p[15] + (p[15].endsWith('Z') ? '' : 'Z'));
    const end = p[16] ? Date.parse(p[16] + (p[16].endsWith('Z') ? '' : 'Z')) : Infinity;
    if (!/^[A-Z0-9]{1,2}$/.test(network) || !/^[A-Z0-9]{1,5}$/.test(station)
      || !/^[A-Z0-9]{0,2}$/.test(location) || !['BHZ', 'HHZ'].includes(channel)
      || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180
      || !(sampleRate >= 20 && sampleRate <= 100) || !(scale > 0)
      || p[13].toLowerCase() !== 'm/s' || !(start <= now && end > now)) continue;
    const item = { code: `${network}-${station}`, network, station, lat, lon,
      channel, location, sampleRate, start,
      sensitivity: { sensitivity: scale, inputUnits: 'm/s', outputUnits: 'counts' } };
    const key = `${network}.${station}.${location}.${channel}`;
    if (!channels.has(key) || channels.get(key).start < start) channels.set(key, item);
  }
  return channels;
}

export function availableStations(channels, streams, now = Date.now()) {
  const stations = new Map();
  for (const stream of streams) {
    const match = /^FDSN:([A-Z0-9]+)_([A-Z0-9]+)_([A-Z0-9]*)_([BH])_H_Z\/MSEED$/.exec(stream.id);
    if (!match) continue;
    const [, net, sta, loc, band] = match;
    const metadata = channels.get(`${net}.${sta}.${loc}.${band}HZ`);
    const ageMs = now - Date.parse(stream.end_time);
    if (!metadata || !Number.isFinite(ageMs) || ageMs < -5000 || ageMs > MAX_DATA_AGE_MS) continue;
    const candidate = { ...metadata, dataAgeMs: Math.max(0, ageMs) };
    // Prefer lower-rate BHZ when its latency is comparable to HHZ.
    const score = candidate.dataAgeMs + (band === 'H' ? 5000 : 0);
    const previous = stations.get(candidate.code);
    if (!previous || score < previous.score) stations.set(candidate.code, { ...candidate, score });
  }
  return [...stations.values()];
}

// Coverage heuristic, not a validated seismic-network design: farthest-point
// regional anchors, with up to two nearby partners for regional correlation.
// Panama is the first anchor; later anchors fill the largest geographic gaps.
export function selectStrategicStations(candidates, limit = STATION_LIMIT) {
  const pending = new Map(candidates.sort((a, b) => a.code.localeCompare(b.code)).map(s => [s.code, s]));
  const selected = [];
  const nearest = new Map();
  const add = (station) => {
    selected.push(station);
    pending.delete(station.code);
    for (const s of pending.values()) nearest.set(s.code, Math.min(nearest.get(s.code) ?? Infinity,
      distance(s.lat, s.lon, station.lat, station.lon)));
  };
  const cap = Math.max(0, Math.min(STATION_LIMIT, limit));
  while (pending.size && selected.length < cap) {
    const ranked = [...pending.values()].sort((a, b) => selected.length
      ? (nearest.get(b.code) - nearest.get(a.code)) || a.dataAgeMs - b.dataAgeMs
      : distance(a.lat, a.lon, 9, -79.5) - distance(b.lat, b.lon, 9, -79.5));
    const anchor = ranked[0];
    add(anchor);
    const partners = [...pending.values()].map(s => ({ s, d: distance(s.lat, s.lon, anchor.lat, anchor.lon) }))
      .filter(x => x.d >= 20 && x.d <= 500).sort((a, b) => a.d - b.d).slice(0, 2);
    for (const { s } of partners) if (selected.length < cap) add(s);
  }
  return selected;
}

export async function loadLiveInventory(catalog) {
  const date = new Date().toISOString().slice(0, 10);
  const [metadata, availability] = await Promise.all([
    fetchText(`https://service.earthscope.org/fdsnws/station/1/query?level=channel&format=text&channel=BHZ,HHZ&endafter=${date}&includerestricted=false`),
    fetchText('https://rtserve.earthscope.org/streams/json?match=FDSN:.*_[BH]_H_Z'),
  ]);
  const names = new Map(catalog.map(s => [s.code, s.name]));
  const candidates = availableStations(parseChannels(metadata), JSON.parse(availability).stream || []);
  return candidates.map(s => ({ ...s, name: names.get(s.code) || s.code }));
}
