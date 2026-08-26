import './polyfill.mjs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { SeismicDetector, arrivalTimes, earlyWarningTime, distanceFromSPDelay } from './seismicAnalysis.js';
import {
  subscribeUserToStations,
  unsubscribeUser,
  getUserStations,
  getPoolStats,
  findNearbyStations,
  loadStationsFromFDSN,
  GLOBAL_STATIONS,
} from './stationPool.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const clients = new Map();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    clients: clients.size,
    pool: getPoolStats(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    clients: clients.size,
    pool: getPoolStats(),
    stations: GLOBAL_STATIONS.length,
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ws.clientId = clientId;
  clients.set(clientId, {
    ws,
    location: null,
    radiusKm: 500,
    stations: [],
  });

  console.log(`Cliente conectado: ${clientId} (${clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Conectado al servidor de alertas sismicas',
    serverTime: new Date().toISOString(),
    clientId,
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleClientMessage(clientId, msg);
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    unsubscribeUser(clientId);
    clients.delete(clientId);
    console.log(`Cliente desconectado: ${clientId} (${clients.size} restantes)`);
  });

  ws.on('error', (err) => {
    console.warn(`Error cliente ${clientId}:`, err.message);
  });
});

async function handleClientMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;

  if (msg.type === 'subscribe' && msg.latitude && msg.longitude) {
    client.location = { latitude: msg.latitude, longitude: msg.longitude };
    client.radiusKm = msg.radiusKm || 500;

    // Suscribir al usuario a las estaciones cercanas (reutilizando conexiones)
    const stations = await subscribeUserToStations(
      clientId,
      msg.latitude,
      msg.longitude,
      client.radiusKm,
      onDataCallback,
      onAlertCallback
    );

    client.stations = stations;

    client.ws.send(JSON.stringify({
      type: 'subscribed',
      stations: stations,
      message: `Monitoreando ${stations.length} estaciones cercanas`,
    }));

    console.log(`[SUB] ${clientId} suscrito a: ${stations.map(s => s.code).join(', ')}`);
  }
}

// Throttle para envio de waveform
const waveformLastSent = new Map();

function onDataCallback(entry, samples, sampleRate, channelCode) {
  const now = Date.now();
  const key = entry.station.code;
  const lastSent = waveformLastSent.get(key) || 0;
  if (now - lastSent < 100) return;
  waveformLastSent.set(key, now);

  // Downsample para envio
  const maxPoints = 200;
  const step = Math.max(1, Math.floor(samples.length / maxPoints));
  const downsampled = [];
  for (let i = 0; i < samples.length; i += step) {
    downsampled.push(Math.round(samples[i] * 1000) / 1000);
  }

  // Enviar waveform a todos los suscriptores de esta estacion
  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'waveform',
        timestamp: new Date().toISOString(),
        samples: downsampled,
        sampleRate: sampleRate,
        channel: channelCode,
        station: entry.station.code,
        stationName: entry.station.name,
      }));
    }
  }
}

// Un detector por estacion
const stationDetectors = new Map();

function onAlertCallback(entry, samples, sampleRate, channelCode) {
  const stationCode = entry.station.code;

  if (!stationDetectors.has(stationCode)) {
    stationDetectors.set(stationCode, new SeismicDetector());
  }
  const detector = stationDetectors.get(stationCode);

  const now = Date.now();
  let lastAlertState = '';
  let lastLevelState = '';

  for (const s of samples) {
    const result = detector.process(s, null);

    if (result.shouldAlert && result.alertType) {
      const stateKey = `${result.alertType}_${result.state}`;
      if (stateKey !== lastAlertState) {
        lastAlertState = stateKey;
        broadcastAlert(entry, detector, result, now);
      }
    }

    if (result.state !== lastLevelState) {
      lastLevelState = result.state;
      broadcastLevelChange(entry, result, now);
    }
  }
}

function broadcastAlert(entry, detector, result, now) {
  let distance = 0;
  let warningTime = 0;

  if (result.alertType === 'S' || result.alertType === 'FUERTE') {
    const spDelay = detector.sWaveTime && detector.pWaveTime
      ? (detector.sWaveTime - detector.pWaveTime) / 1000
      : 0;
    if (spDelay > 0) {
      distance = distanceFromSPDelay(spDelay);
      warningTime = earlyWarningTime(distance);
    }
  }

  const alert = {
    type: 'earthquake_alert',
    timestamp: new Date(now).toISOString(),
    pga: result.pga,
    level: result.state,
    levelName: result.level,
    alertType: result.alertType,
    severity: result.alertType === 'FUERTE' || result.alertType === 'S' ? 'high' : 'medium',
    message: result.message,
    estimatedDistance: distance,
    earlyWarningTime: warningTime,
    station: entry.station.code,
    stationName: entry.station.name,
  };

  // Enviar solo a suscriptores de esta estacion
  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(alert));
    }
  }

  console.log(`[ALERTA ${result.alertType}] ${entry.station.code}: ${result.message} PGA=${result.pga.toFixed(4)}g`);
}

function broadcastLevelChange(entry, result, now) {
  const levelMsg = {
    type: 'level_change',
    timestamp: new Date(now).toISOString(),
    pga: result.pga,
    level: result.state,
    levelName: result.level,
    description: result.message,
    color: result.color,
    waveType: result.waveType,
    station: entry.station.code,
    stationName: entry.station.name,
  };

  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(levelMsg));
    }
  }
}

console.log('Iniciando servidor de alertas sismicas con pool de estaciones...');