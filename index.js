import './polyfill.mjs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { SEISMIC_CONFIG } from './seismicConfig.js';
import {
  subscribeUserToStations,
  unsubscribeUser,
  getUserStations,
  getPoolStats,
  findNearbyStations,
  loadStationsFromFDSN,
  GLOBAL_STATIONS,
} from './stationPool.js';
import { PickerState } from './services/phasePicker.js';
import { registerPPick, registerSPick, getActiveEvents, cleanupOldEvents } from './services/eventCorrelator.js';
import { locateEpicenter, epicentralDistanceKm, estimateSArrivalSeconds } from './services/eventLocator.js';
import { calculateEventMagnitude } from './services/magnitudeCalculator.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const clients = new Map();

// === Logging de eventos para calibracion ===
const eventLog = [];

app.get('/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, pool: getPoolStats() });
});

app.get('/status', (req, res) => {
  res.json({
    clients: clients.size,
    pool: getPoolStats(),
    stations: GLOBAL_STATIONS.length,
    config: SEISMIC_CONFIG,
  });
});

app.get('/stations', (req, res) => {
  const { lat, lon, radius } = req.query;
  if (lat && lon) {
    const stations = findNearbyStations(parseFloat(lat), parseFloat(lon), parseFloat(radius || 500));
    res.json(stations);
  } else {
    res.json(GLOBAL_STATIONS);
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Servidor de alertas sismicas en http://localhost:${PORT}`);
  console.log(`WebSocket para clientes en ws://localhost:${PORT}/ws`);
  console.log(`Cargando estaciones desde IRIS FDSN...`);
  await loadStationsFromFDSN();
  console.log(`Estaciones globales disponibles: ${GLOBAL_STATIONS.length}`);
});

const wss = new WebSocketServer({ server, path: '/ws', clientTracking: true });

// === Ping/keepalive ===
const PING_INTERVAL_MS = 20000;
let pingTimer = null;

function startPingTimer() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const [clientId, client] of clients) {
      const ws = client.ws;
      if (ws.readyState === ws.OPEN) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
        try { ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })); } catch (e) {}
      } else if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
        clients.delete(clientId);
        unsubscribeUser(clientId);
      }
    }
    cleanupOldEvents();
  }, PING_INTERVAL_MS);
}
startPingTimer();

wss.on('connection', (ws) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ws.clientId = clientId;
  ws.isAlive = true;
  clients.set(clientId, { ws, location: null, radiusKm: 500, stations: [] });

  console.log(`Cliente conectado: ${clientId} (${clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Conectado al servidor de alertas sismicas',
    serverTime: new Date().toISOString(),
    clientId,
  }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') { ws.isAlive = true; return; }
      handleClientMessage(clientId, msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    unsubscribeUser(clientId);
    clients.delete(clientId);
    console.log(`Cliente desconectado: ${clientId} (${clients.size} restantes)`);
  });

  ws.on('error', (err) => { console.warn(`Error cliente ${clientId}:`, err.message); });
});

async function handleClientMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;

  if (msg.type === 'subscribe' && msg.latitude != null && msg.longitude != null) {
    client.location = { latitude: msg.latitude, longitude: msg.longitude };
    client.radiusKm = msg.radiusKm || 500;

    const stations = await subscribeUserToStations(
      clientId, msg.latitude, msg.longitude, client.radiusKm, onDataCallback, onAlertCallback
    );

    client.stations = stations;
    client.ws.send(JSON.stringify({
      type: 'subscribed',
      stations,
      message: `Monitoreando ${stations.length} estaciones cercanas`,
    }));
    console.log(`[SUB] ${clientId} suscrito a: ${stations.map(s => s.code).join(', ')}`);
  }
}

// === Throttle para envio de waveform ===
const waveformLastSent = new Map();

function onDataCallback(entry, channelInfo, samples, sampleRate, channelCode, unit) {
  const now = Date.now();
  const key = `${entry.station.code}_${channelCode}`;
  const lastSent = waveformLastSent.get(key) || 0;
  if (now - lastSent < 100) return;
  waveformLastSent.set(key, now);

  const maxPoints = 200;
  const step = Math.max(1, Math.floor(samples.length / maxPoints));
  const downsampled = [];
  for (let i = 0; i < samples.length; i += step) {
    downsampled.push(Math.round(samples[i] * 1e9) / 1e9);
  }

  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'waveform',
        timestamp: new Date().toISOString(),
        samples: downsampled,
        sampleRate,
        channel: channelCode,
        component: channelInfo.component,
        unit,  // 'm/s' o 'counts'
        station: entry.station.code,
        stationName: entry.station.name,
      }));
    }
  }
}

// === Callback de deteccion: recibe segmento filtrado en m/s ===
function onAlertCallback(entry, channelInfo, filteredSegment, sampleRate, channelCode) {
  const detector = entry.detectors[channelCode];
  if (!detector || !filteredSegment || !filteredSegment.y) return;

  const station = entry.station;
  const component = channelInfo.component;

  // Procesar cada muestra con su timestamp real del miniSEED
  for (let i = 0; i < filteredSegment.y.length; i++) {
    const value = filteredSegment.y[i];
    let timestamp = null;
    try { timestamp = filteredSegment.timeOfSample(i); } catch (e) { continue; }

    const result = detector.process(value, timestamp);

    // Si se detecto un pick P, registrarlo en el correlador
    if (result.type === 'P_DETECTED' && result.pPickTime) {
      const pick = {
        stationCode: station.code,
        pTime: result.pPickTime,
        amplitude: result.amplitude,
        lat: station.lat,
        lon: station.lon,
        sampleRate,
        channel: channelCode,
      };

      const event = registerPPick(pick);

      if (event && event.state === 'CONFIRMED_EVENT') {
        // Evento confirmado: localizar y calcular magnitud
        handleConfirmedEvent(entry, event, clientId => {
          const client = clients.get(clientId);
          if (client && client.ws.readyState === client.ws.OPEN) {
            client.ws.send(JSON.stringify(event));
          }
        });
      } else if (event && event.state === 'POSSIBLE_EVENT') {
        // Possible event de una sola estacion: no alertar todavia
        broadcastToSubscribers(entry, {
          type: 'possible_event',
          station: station.code,
          pPickTime: result.pPickTime?.toISO(),
          numStations: 1,
        });
      }
    }

    // Si se detecto un pick S
    if (result.type === 'S_DETECTED' && result.sPickTime) {
      registerSPick(station.code, result.sPickTime, result.amplitude);
      broadcastToSubscribers(entry, {
        type: 's_wave_detected',
        station: station.code,
        sPickTime: result.sPickTime?.toISO(),
        amplitude: result.amplitude,
      });
    }
  }
}

// Manejar evento confirmado: localizar + magnitud + alerta temprana
function handleConfirmedEvent(entry, event, broadcastFn) {
  const picks = event.picks;

  // 1. Localizar epicentro
  const location = locateEpicenter(picks);

  // 2. Calcular magnitud ML
  const picksWithVelocity = picks.map(p => ({
    ...p,
    peakVelocityMs: p.amplitude,  // amplitud del pick P (aproximacion)
  }));
  const magnitudeResult = calculateEventMagnitude(picksWithVelocity, location);

  // 3. Construir alerta
  const alert = {
    type: 'earthquake_early_warning',
    originTime: location?.originTime?.toISOString() || null,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    depth: location?.depth ?? null,  // null: no se calcula
    magnitude: magnitudeResult?.magnitude ?? null,
    magnitudeType: magnitudeResult?.magnitudeType || 'ML',
    stationMagnitudes: magnitudeResult?.stationMagnitudes || [],
    stationsUsed: event.numStations,
    pWaveDetected: true,
    estimatedSArrivalSeconds: null,  // se calcula por usuario
    confidence: location?.confidence ?? 0,
    preliminaryLocation: location?.preliminaryLocation ?? true,
    residual: location?.residual ?? null,
  };

  // 4. Enviar a cada usuario con su tiempo estimado de llegada S
  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (!client || !client.location) continue;
    if (client.ws.readyState !== client.ws.OPEN) continue;

    const userLat = client.location.latitude;
    const userLon = client.location.longitude;

    let userAlert = { ...alert };
    if (location) {
      userAlert.distanceKm = epicentralDistanceKm(location.latitude, location.longitude, userLat, userLon);
      userAlert.estimatedSArrivalSeconds = estimateSArrivalSeconds(location, userLat, userLon);
    } else {
      userAlert.distanceKm = null;
      userAlert.estimatedSArrivalSeconds = null;
    }

    client.ws.send(JSON.stringify(userAlert));
  }

  // 5. Log para calibracion
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventId: event.id,
    stations: picks.map(p => ({
      station: p.stationCode,
      channel: p.channel,
      pTime: p.pTime?.toISO(),
      amplitude: p.amplitude,
      lat: p.lat,
      lon: p.lon,
    })),
    location,
    magnitude: magnitudeResult,
  };
  eventLog.push(logEntry);
  console.log(`[EVENTO] M${alert.magnitude?.toFixed(1) ?? '?'} lat=${alert.latitude?.toFixed(2) ?? '?'} lon=${alert.longitude?.toFixed(2) ?? '?'} estaciones=${event.numStations}`);
}

function broadcastToSubscribers(entry, message) {
  const data = JSON.stringify(message);
  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(data);
    }
  }
}

console.log('Iniciando servidor de alertas sismicas con deteccion STA/LTA + multi-estacion');