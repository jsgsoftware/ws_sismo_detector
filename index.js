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

// === Envio de push notifications via Expo Push Service ===
async function sendExpoPush(pushToken, title, body, data = {}) {
  try {
    const message = {
      to: pushToken,
      title,
      body,
      data: { ...data, type: 'seismic_alert' },
      sound: 'default',
      priority: 'high',
      channelId: 'sismo-alertas',
    };
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(message),
    });
    const result = await resp.json();
    console.log(`[PUSH] Enviado a ${pushToken.slice(0, 25)}...:`, result?.data?.status || result);
  } catch (e) {
    console.log('[PUSH] Error enviando push:', e.message);
  }
}

// Enviar push a un cliente especifico (si tiene pushToken)
function sendPushToClient(client, alert) {
  if (!client.pushToken) return;
  const mag = alert.magnitude != null ? `M${alert.magnitude.toFixed(1)}` : 'M?';
  const dist = alert.distanceKm != null ? ` a ${alert.distanceKm.toFixed(0)}km` : '';
  const sArrival = alert.estimatedSArrivalSeconds != null && alert.estimatedSArrivalSeconds > 0
    ? ` - Onda S en ${Math.round(alert.estimatedSArrivalSeconds)}s`
    : '';
  sendExpoPush(
    client.pushToken,
    `ALERTA SISMICA ${mag}`,
    `Sismo detectado${dist}${sArrival}`,
    alert
  );
}

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

// Listar clientes conectados con su clientId y ubicacion
app.get('/clients', (req, res) => {
  const list = [];
  for (const [clientId, client] of clients) {
    list.push({
      clientId,
      location: client.location,
      radiusKm: client.radiusKm,
      stations: client.stations?.map((s) => s.code) || [],
      connected: client.ws?.readyState === 1,  // OPEN
    });
  }
  res.json({ total: list.length, clients: list });
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
    if (msg.pushToken) {
      client.pushToken = msg.pushToken;
      console.log(`[SUB] Push token registrado para ${clientId}: ${msg.pushToken.slice(0, 25)}...`);
    }

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

  // 4b. Enviar push notification a clientes con pushToken (incluso si WS cerrado)
  for (const clientId of entry.subscribers) {
    const client = clients.get(clientId);
    if (!client || !client.location || !client.pushToken) continue;
    let userAlert = { ...alert };
    if (location) {
      userAlert.distanceKm = epicentralDistanceKm(location.latitude, location.longitude, client.location.latitude, client.location.longitude);
      userAlert.estimatedSArrivalSeconds = estimateSArrivalSeconds(location, client.location.latitude, client.location.longitude);
    }
    sendPushToClient(client, userAlert);
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

// =====================================================================
//  SIMULADOR: inyecta un sismo sintetico en el pipeline
//  Genera picks P escalonados en las estaciones suscritas, como si un
//  sismo real hubiera sido detectado. Pasa por correlacion → localizacion → ML → alerta.
// =====================================================================

import { DateTime } from 'luxon';

// GET /simulate?lat=LAT&lon=LON&mag=MAG&clientId=CLIENT_ID
// Simula un sismo de magnitud MAG en (LAT, LON) detectado por las estaciones activas.
// Si clientId se especifica, envia la alerta SOLO a ese cliente.
// Si no, envia a todos los clientes conectados.
app.get('/simulate', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 9.04;
    const lon = parseFloat(req.query.lon) || -79.42;
    const mag = parseFloat(req.query.mag) || 4.5;
    const targetClientId = req.query.clientId || null;

    console.log(`[SIM] Simulando sismo M${mag} en lat=${lat} lon=${lon}${targetClientId ? ` para cliente ${targetClientId}` : ' (broadcast)'}`);

    // Obtener estaciones activas del pool, o las mas cercanas si no hay
    let stationsToUse = [];
    const pool = getPoolStats();
    if (pool.totalConnections > 0) {
      // Usar estaciones activas del pool
      for (const s of pool.stations) {
        const stationInfo = GLOBAL_STATIONS.find((g) => g.code === s.code);
        if (stationInfo) {
          stationsToUse.push({
            code: s.code,
            name: s.name,
            lat: stationInfo.lat,
            lon: stationInfo.lon,
          });
        }
      }
    }

    // Si no hay estaciones activas, usar las 3 mas cercanas al epicentro simulado
    if (stationsToUse.length === 0) {
      const nearby = findNearbyStations(lat, lon, 1000);
      stationsToUse = nearby.map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon }));
    }

    if (stationsToUse.length === 0) {
      return res.json({ ok: false, error: 'No hay estaciones disponibles' });
    }

    // Tomar las primeras 3 estaciones
    const stations = stationsToUse.slice(0, 3);

    // Calcular tiempo de llegada P a cada estacion (Vp = 6.1 km/s)
    const { Vp, Vs } = SEISMIC_CONFIG.velocities;
    const originTime = DateTime.utc();

    // Para que la correlacion funcione (min 2 estaciones en 15s),
    // comprimir los tiempos de llegada: usar solo el offset relativo entre estaciones
    // sin esperar los 60s reales. Esto simula un sismo mas cercano.
    const baseDistance = Math.min(...stations.map(s => haversineKm(s.lat, s.lon, lat, lon)));
    const maxAllowedDelay = 12;  // segundos maximos entre la primera y ultima estacion

    // Amplitud sintetica en m/s (aproximada para M4-M6 a 50-500 km)
    // PGA ~ 10^(0.5*M - log10(R) - 0.9) en m/s^2, velocidad ~ PGA/omega
    // Simplificado: amplitud pico en m/s
    const picks = [];

    for (const sta of stations) {
      // Distancia estacion → epicentro
      const distKm = haversineKm(sta.lat, sta.lon, lat, lon);
      // Comprimir retardos para que todas las estaciones detecten dentro de la ventana de correlacion
      // El offset relativo se preserva (estacion mas lejana detecta despues)
      const relativeDelay = Math.min(maxAllowedDelay, (distKm - baseDistance) / Vp);
      const pTravelTime = 2 + relativeDelay;  // 2s base + offset relativo
      const pArrival = originTime.plus({ seconds: pTravelTime });

      // Amplitud pico sintetica en m/s (decrece con distancia, crece con magnitud)
      const peakVelocity = Math.pow(10, 0.5 * mag - Math.log10(distKm + 10) - 2.5);

      picks.push({
        stationCode: sta.code,
        pTime: pArrival,
        amplitude: peakVelocity,  // m/s
        lat: sta.lat,
        lon: sta.lon,
        sampleRate: 40,
        channel: 'BHZ',
        distanceKm: distKm,
      });

      console.log(`[SIM] ${sta.code}: P en ${pTravelTime.toFixed(1)}s (${distKm.toFixed(0)}km) amp=${peakVelocity.toExponential(2)} m/s`);
    }

    // Enviar respuesta inmediata
    res.json({
      ok: true,
      simulation: {
        magnitude: mag,
        latitude: lat,
        longitude: lon,
        originTime: originTime.toISO(),
        stations: picks.map((p) => ({
          code: p.stationCode,
          distanceKm: p.distanceKm,
          pArrivalSeconds: (p.pTime.toMillis() - originTime.toMillis()) / 1000,
          peakVelocity: p.amplitude,
        })),
      },
    });

    // Inyectar picks P escalonados en el correlador
    for (const pick of picks) {
      const delayMs = pick.pTime.toMillis() - Date.now();
      const delay = Math.max(0, delayMs);

      setTimeout(() => {
        console.log(`[SIM] Inyectando P pick en ${pick.stationCode}`);
        const event = registerPPick(pick);

        if (event && event.state === 'CONFIRMED_EVENT') {
          console.log(`[SIM] Evento confirmado con ${event.numStations} estaciones`);
          handleSimulatedEvent(event, lat, lon, mag, targetClientId);
        } else if (event && event.state === 'POSSIBLE_EVENT') {
          // Enviar possible_event a los clientes suscritos a esa estacion
          broadcastPossibleEvent(pick.stationCode, targetClientId);
        }
      }, delay);
    }

    // Inyectar pick S despues (para la estacion mas cercana)
    if (picks.length > 0) {
      const closest = picks[0];
      const sTravelTime = closest.distanceKm / Vs;
      const sArrival = originTime.plus({ seconds: sTravelTime });
      const sDelayMs = Math.max(0, sArrival.toMillis() - Date.now());

      setTimeout(() => {
        console.log(`[SIM] Inyectando S pick en ${closest.stationCode}`);
        registerSPick(closest.stationCode, sArrival, closest.amplitude * 2);
        broadcastSWave(closest.stationCode, sArrival, closest.amplitude * 2, targetClientId);
      }, sDelayMs);
    }
  } catch (err) {
    console.error('[SIM] Error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Procesar evento simulado confirmado
function handleSimulatedEvent(event, epicenterLat, epicenterLon, mag, targetClientId) {
  // Localizar epicentro (deberia aproximarse al lat/lon simulado)
  const location = locateEpicenter(event.picks);

  // Calcular magnitud ML
  const picksWithVelocity = event.picks.map((p) => ({
    ...p,
    peakVelocityMs: p.amplitude,
  }));
  const magnitudeResult = calculateEventMagnitude(picksWithVelocity, location || {
    latitude: epicenterLat,
    longitude: epicenterLon,
    depth: null,
  });

  // Construir alerta
  const alert = {
    type: 'earthquake_early_warning',
    originTime: location?.originTime?.toISOString() || new Date().toISOString(),
    latitude: location?.latitude ?? epicenterLat,
    longitude: location?.longitude ?? epicenterLon,
    depth: location?.depth ?? null,
    magnitude: magnitudeResult?.magnitude ?? mag,
    magnitudeType: magnitudeResult?.magnitudeType || 'ML',
    stationMagnitudes: magnitudeResult?.stationMagnitudes || [],
    stationsUsed: event.numStations,
    pWaveDetected: true,
    estimatedSArrivalSeconds: null,
    confidence: location?.confidence ?? 0.5,
    preliminaryLocation: location?.preliminaryLocation ?? true,
    residual: location?.residual ?? null,
    simulated: true,
  };

  // Enviar al cliente especifico o a todos
  for (const [clientId, client] of clients) {
    // Si se especifico un cliente, saltar los demas
    if (targetClientId && clientId !== targetClientId) continue;
    if (!client.location || client.ws.readyState !== client.ws.OPEN) continue;

    const userLat = client.location.latitude;
    const userLon = client.location.longitude;
    const userAlert = { ...alert };

    if (location) {
      userAlert.distanceKm = epicentralDistanceKm(location.latitude, location.longitude, userLat, userLon);
      userAlert.estimatedSArrivalSeconds = estimateSArrivalSeconds(location, userLat, userLon);
    } else {
      userAlert.distanceKm = epicentralDistanceKm(epicenterLat, epicenterLon, userLat, userLon);
      userAlert.estimatedSArrivalSeconds = epicentralDistanceKm(epicenterLat, epicenterLon, userLat, userLon) / SEISMIC_CONFIG.velocities.Vs;
    }

    client.ws.send(JSON.stringify(userAlert));
    console.log(`[SIM] Alerta enviada a ${clientId}`);
  }

  // Enviar push notification a clientes con pushToken (incluso si WS cerrado)
  for (const [clientId, client] of clients) {
    if (targetClientId && clientId !== targetClientId) continue;
    if (!client.location || !client.pushToken) continue;
    const userAlert = { ...alert };
    if (location) {
      userAlert.distanceKm = epicentralDistanceKm(location.latitude, location.longitude, client.location.latitude, client.location.longitude);
      userAlert.estimatedSArrivalSeconds = estimateSArrivalSeconds(location, client.location.latitude, client.location.longitude);
    } else {
      userAlert.distanceKm = epicentralDistanceKm(epicenterLat, epicenterLon, client.location.latitude, client.location.longitude);
      userAlert.estimatedSArrivalSeconds = userAlert.distanceKm / SEISMIC_CONFIG.velocities.Vs;
    }
    sendPushToClient(client, userAlert);
  }

  console.log(`[SIM] Alerta: M${alert.magnitude?.toFixed(1)} lat=${alert.latitude?.toFixed(2)} lon=${alert.longitude?.toFixed(2)} estaciones=${event.numStations}`);
}

// Enviar possible_event a un cliente especifico o a todos
function broadcastPossibleEvent(stationCode, targetClientId) {
  for (const [clientId, client] of clients) {
    if (targetClientId && clientId !== targetClientId) continue;
    if (client.ws.readyState !== client.ws.OPEN) continue;
    client.ws.send(JSON.stringify({
      type: 'possible_event',
      station: stationCode,
      pPickTime: new Date().toISOString(),
      numStations: 1,
    }));
  }
}

// Enviar s_wave_detected a un cliente especifico o a todos
function broadcastSWave(stationCode, sTime, amplitude, targetClientId) {
  for (const [clientId, client] of clients) {
    if (targetClientId && clientId !== targetClientId) continue;
    if (client.ws.readyState !== client.ws.OPEN) continue;
    client.ws.send(JSON.stringify({
      type: 's_wave_detected',
      station: stationCode,
      sPickTime: sTime?.toISO?.() || sTime?.toISOString?.(),
      amplitude,
    }));
  }
}

// Haversine para el simulador
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

console.log('Iniciando servidor de alertas sismicas con deteccion STA/LTA + multi-estacion');