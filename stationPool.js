// stationPool.js
// REESCRITO: pool de conexiones SeedLink con descubrimiento de canales Z/N/E,
// obtencion de respuesta instrumental (StationXML), conversion counts->m/s,
// filtrado de señal y deteccion STA/LTA con timestamp real del miniSEED.

import { seedlink, miniseed } from 'seisplotjs/nodeonly';
import { DateTime } from 'luxon';
import { execFile } from 'child_process';
import { SEISMIC_CONFIG } from './seismicConfig.js';
import { discoverChannels, getInstrumentResponse } from './services/stationMetadata.js';
import { convertCountsToVelocity, applySensitivityOnly, getSegmentStartTime } from './services/instrumentResponse.js';
import { preprocessSignal, segmentToFloatArray } from './services/signalProcessing.js';
import { StaLtaDetector, PickerState, horizontalEnergy } from './services/phasePicker.js';
import { registerPPick, registerSPick, getActiveEvents } from './services/eventCorrelator.js';
import { locateEpicenter, epicentralDistanceKm, estimateSArrivalSeconds } from './services/eventLocator.js';
import { calculateEventMagnitude } from './services/magnitudeCalculator.js';

const SEEDLINK_URL = 'wss://rtserve.earthscope.org/seedlink';
const FDSN_STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';

// Estaciones de fallback (se usan si la consulta FDSN falla al arrancar)
const FALLBACK_STATIONS = [
  { code: 'IU-ANMO', network: 'IU', station: 'ANMO', name: 'Albuquerque, USA', lat: 34.95, lon: -106.46 },
  { code: 'IU-SSPA', network: 'IU', station: 'SSPA', name: 'State College, USA', lat: 40.80, lon: -77.87 },
  { code: 'G-LPAZ', network: 'G', station: 'LPAZ', name: 'La Paz, Bolivia', lat: -16.29, lon: -68.13 },
  { code: 'II-NNA', network: 'II', station: 'NNA', name: 'Nana, Peru', lat: -12.06, lon: -77.01 },
];

export let GLOBAL_STATIONS = [...FALLBACK_STATIONS];

// Cargar estaciones dinamicamente desde el FDSN de IRIS
export async function loadStationsFromFDSN() {
  const url = `${FDSN_STATION_URL}?format=text&level=station&channel=BHZ&starttime=2026-01-01&includerestricted=false`;
  console.log(`[FDSN] Consultando estaciones desde IRIS...`);

  const curlResult = await loadWithCurl(url);
  if (curlResult) return;

  console.log(`[FDSN] curl fallo, intentando archivo local stations.txt...`);
  const fileResult = await loadFromFile('stations.txt');
  if (fileResult) return;

  console.warn(`[FDSN] Usando fallback (${FALLBACK_STATIONS.length} estaciones)`);
}

function parseStationsText(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const stations = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const network = parts[0].trim();
    const stationCode = parts[1].trim();
    const lat = parseFloat(parts[2]);
    const lon = parseFloat(parts[3]);
    const siteName = parts[5] ? parts[5].trim() : `${network}-${stationCode}`;
    if (!network || !stationCode || isNaN(lat) || isNaN(lon)) continue;
    stations.push({ code: `${network}-${stationCode}`, network, station: stationCode, name: siteName, lat, lon });
  }
  return stations;
}

function loadWithCurl(url) {
  return new Promise((resolve) => {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFile(curl, ['-sL', '--max-time', '60', '-H', 'Connection: close', url],
      { maxBuffer: 50 * 1024 * 1024, timeout: 70000 },
      (err, stdout) => {
        if (err || !stdout) { if (err) console.warn(`[FDSN] curl error: ${err.message}`); return resolve(false); }
        const stations = parseStationsText(stdout);
        if (stations.length > 0) {
          GLOBAL_STATIONS = stations;
          console.log(`[FDSN] ${stations.length} estaciones cargadas (curl)`);
          resolve(true);
        } else { resolve(false); }
      });
  });
}

function loadFromFile(path) {
  return new Promise((resolve) => {
    import('fs').then((fs) => {
      fs.readFile(path, 'utf8', (err, data) => {
        if (err) { console.warn(`[FDSN] No se pudo leer ${path}: ${err.message}`); return resolve(false); }
        const stations = parseStationsText(data);
        if (stations.length > 0) {
          GLOBAL_STATIONS = stations;
          console.log(`[FDSN] ${stations.length} estaciones cargadas (${path})`);
          resolve(true);
        } else { resolve(false); }
      });
    });
  });
}

// =====================================================================
//  Pool de conexiones
// =====================================================================

const connectionPool = new Map();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function findNearbyStations(lat, lon, radiusKm, maxStations = 3) {
  const nearby = GLOBAL_STATIONS.map((s) => ({ ...s, distance: haversineKm(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxStations);

  if (nearby.length === 0) {
    return GLOBAL_STATIONS.map((s) => ({ ...s, distance: haversineKm(lat, lon, s.lat, s.lon) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);
  }
  return nearby;
}

export async function subscribeUserToStations(clientId, userLat, userLon, radiusKm, onDataCallback, onAlertCallback) {
  const stations = findNearbyStations(userLat, userLon, radiusKm);
  const subscribedStations = [];

  for (const station of stations) {
    let entry = connectionPool.get(station.code);
    if (!entry) {
      entry = {
        station,
        connections: {},        // una conexion por canal (Z, N, E)
        detectors: {},           // un StaLtaDetector por canal
        responses: {},           // respuesta instrumental por canal
        channels: null,          // inventario de canales Z/N/E
        subscribers: new Set(),
        connected: false,
        lastDataTime: 0,
        userLocations: new Map(), // clientId -> {lat, lon}
      };
      connectionPool.set(station.code, entry);
      await setupStation(entry, onDataCallback, onAlertCallback);
    }

    entry.subscribers.add(clientId);
    entry.userLocations.set(clientId, { lat: userLat, lon: userLon });
    subscribedStations.push({ code: station.code, name: station.name, distance: station.distance, connected: entry.connected });
  }
  return subscribedStations;
}

// Configurar una estacion: descubrir canales, obtener respuestas, conectar SeedLink
async function setupStation(entry, onDataCallback, onAlertCallback) {
  const { station } = entry;
  console.log(`[POOL] Configurando ${station.code} (${station.name})`);

  // 1. Descubrir canales Z/N/E disponibles
  const channels = await discoverChannels(station.network, station.station);
  entry.channels = channels;

  // 2. Obtener respuesta instrumental para cada canal disponible
  const channelsToConnect = [];
  if (channels.z) {
    const respZ = await getInstrumentResponse(station.network, station.station, channels.z.location, channels.z.channel);
    if (respZ) entry.responses[channels.z.channel] = respZ;
    channelsToConnect.push({ ...channels.z, component: 'Z' });
  }
  if (channels.n) {
    const respN = await getInstrumentResponse(station.network, station.station, channels.n.location, channels.n.channel);
    if (respN) entry.responses[channels.n.channel] = respN;
    channelsToConnect.push({ ...channels.n, component: 'N' });
  }
  if (channels.e) {
    const respE = await getInstrumentResponse(station.network, station.station, channels.e.location, channels.e.channel);
    if (respE) entry.responses[channels.e.channel] = respE;
    channelsToConnect.push({ ...channels.e, component: 'E' });
  }

  // 3. Crear un detector STA/LTA por canal
  for (const ch of channelsToConnect) {
    const sampleRate = ch.sampleRate || 1;
    entry.detectors[ch.channel] = new StaLtaDetector(ch.channel, sampleRate);
  }

  // 4. Conectar SeedLink para cada canal
  for (const ch of channelsToConnect) {
    connectToStationChannel(entry, ch, onDataCallback, onAlertCallback);
  }
}

// Conectar a un canal especifico via SeedLink
function connectToStationChannel(entry, channelInfo, onDataCallback, onAlertCallback) {
  const { station } = entry;
  const commands = [
    `STATION ${station.network} ${station.station}`,
    `SELECT ${channelInfo.location}.${channelInfo.channel}.D`,
  ];

  console.log(`[POOL] Conectando a ${station.code} canal ${channelInfo.channel} (${channelInfo.component})`);

  try {
    const startTime = DateTime.utc().minus({ seconds: 30 });
    const slConn = new seedlink.SeedlinkConnection(SEEDLINK_URL, commands,
      (packet) => {
        handleMiniseedPacket(entry, channelInfo, packet, onDataCallback, onAlertCallback);
      },
      (error) => {
        console.error(`[POOL] Error ${station.code}/${channelInfo.channel}:`, error.message);
        entry.connected = false;
        scheduleReconnect(entry, channelInfo, onDataCallback, onAlertCallback);
      }
    );
    slConn.setOnClose(() => {
      console.warn(`[POOL] Conexion cerrada ${station.code}/${channelInfo.channel}`);
      entry.connected = false;
      scheduleReconnect(entry, channelInfo, onDataCallback, onAlertCallback);
    });
    slConn.setTimeCommand(startTime);
    slConn.connect().then(() => {
      console.log(`[POOL] Conectado ${station.code}/${channelInfo.channel}`);
      entry.connections[channelInfo.channel] = slConn;
      entry.connected = true;
    }).catch((err) => {
      console.error(`[POOL] Error al conectar ${station.code}/${channelInfo.channel}:`, err.message);
      scheduleReconnect(entry, channelInfo, onDataCallback, onAlertCallback);
    });
  } catch (err) {
    console.error(`[POOL] Error creando conexion ${station.code}/${channelInfo.channel}:`, err.message);
    scheduleReconnect(entry, channelInfo, onDataCallback, onAlertCallback);
  }
}

const reconnectTimers = new Map();

function scheduleReconnect(entry, channelInfo, onDataCallback, onAlertCallback) {
  const key = `${entry.station.code}_${channelInfo.channel}`;
  if (reconnectTimers.has(key)) return;
  reconnectTimers.set(key, setTimeout(() => {
    reconnectTimers.delete(key);
    if (entry.subscribers.size > 0) {
      connectToStationChannel(entry, channelInfo, onDataCallback, onAlertCallback);
    }
  }, 5000));
}

// Procesar un paquete miniSEED: convertir a m/s, filtrar, detectar
function handleMiniseedPacket(entry, channelInfo, packet, onDataCallback, onAlertCallback) {
  try {
    const msRecord = packet.miniseed;
    if (!msRecord) return;

    const segments = miniseed.seismogramSegmentPerChannel([msRecord]);
    if (!segments || segments.length === 0) return;

    const segment = segments[0];
    const samples = segment.y;
    if (!samples || samples.length === 0) return;

    const sampleRate = segment.sampleRate;
    const channelCode = segment.channelCode;
    const response = entry.responses[channelCode];
    entry.lastDataTime = Date.now();

    // === 1. CONVERTIR COUNTS -> m/s (gainCorrect con sensibilidad instrumental) ===
    let physicalSegment = null;
    if (response) {
      // Usar gainCorrect: aplica la sensibilidad para convertir counts -> m/s
      // (desconvolucion completa con polos/ceros requiere level=response que
      // tiene problemas de parsing con StationXML 1.1 de EarthScope)
      physicalSegment = applySensitivityOnly(segment, response.sensitivity);
    }
    if (!physicalSegment) {
      // Sin respuesta instrumental: no podemos procesar fisicamente
      // Enviar counts crudos al cliente (para visualizacion) pero no detectar
      if (onDataCallback) onDataCallback(entry, channelInfo, samples, sampleRate, channelCode, 'counts');
      return;
    }

    // === 2. FILTRAR (demean + detrend + bandpass) ===
    const filteredSegment = preprocessSignal(physicalSegment, sampleRate);
    if (!filteredSegment) return;

    const filteredSamples = segmentToFloatArray(filteredSegment);
    if (!filteredSamples || filteredSamples.length === 0) return;

    // === 3. Enviar waveform fisica (m/s) al cliente ===
    if (onDataCallback) {
      onDataCallback(entry, channelInfo, filteredSamples, sampleRate, channelCode, 'm/s');
    }

    // === 4. DETECCION STA/LTA con timestamp real ===
    if (onAlertCallback) {
      onAlertCallback(entry, channelInfo, filteredSegment, sampleRate, channelCode);
    }
  } catch (err) {
    console.warn(`[POOL] Error procesando ${entry.station.code}/${channelCode}:`, err.message);
  }
}

export function unsubscribeUser(clientId) {
  for (const [code, entry] of connectionPool.entries()) {
    entry.subscribers.delete(clientId);
    entry.userLocations.delete(clientId);
    if (entry.subscribers.size === 0) {
      console.log(`[POOL] Cerrando conexion ${code} (sin suscriptores)`);
      for (const [chanCode, conn] of Object.entries(entry.connections)) {
        try { conn.close(); } catch (e) {}
      }
      connectionPool.delete(code);
    }
  }
}

export function getUserStations(clientId) {
  const stations = [];
  for (const [code, entry] of connectionPool.entries()) {
    if (entry.subscribers.has(clientId)) {
      stations.push({ code, name: entry.station.name, connected: entry.connected, subscribers: entry.subscribers.size });
    }
  }
  return stations;
}

export function getPoolStats() {
  let totalConnections = 0;
  let totalSubscribers = 0;
  let connectedStations = 0;
  for (const [code, entry] of connectionPool.entries()) {
    totalConnections++;
    totalSubscribers += entry.subscribers.size;
    if (entry.connected) connectedStations++;
  }
  return {
    totalConnections,
    totalSubscribers,
    connectedStations,
    stations: Array.from(connectionPool.entries()).map(([code, e]) => ({
      code,
      name: e.station.name,
      subscribers: e.subscribers.size,
      connected: e.connected,
      channels: e.channels ? { z: e.channels.z?.channel, n: e.channels.n?.channel, e: e.channels.e?.channel } : null,
    })),
  };
}