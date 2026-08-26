// Pool de conexiones SeedLink reutilizables
// Si dos usuarios usan la misma estacion, reutilizan la misma conexion
// Las estaciones se cargan dinamicamente desde el FDSN de IRIS al arrancar

import { seedlink, miniseed } from 'seisplotjs/nodeonly';
import { DateTime } from 'luxon';
import { execFile } from 'child_process';

const SEEDLINK_URL = 'wss://rtserve.earthscope.org/seedlink';
const FDSN_STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';

// Estaciones de fallback (se usan si la consulta FDSN falla al arrancar)
const FALLBACK_STATIONS = [
  { code: 'IU-ANMO', network: 'IU', station: 'ANMO', name: 'Albuquerque, USA', lat: 34.95, lon: -106.46 },
  { code: 'IU-SSPA', network: 'IU', station: 'SSPA', name: 'State College, USA', lat: 40.80, lon: -77.87 },
  { code: 'G-LPAZ', network: 'G', station: 'LPAZ', name: 'La Paz, Bolivia', lat: -16.29, lon: -68.13 },
  { code: 'II-NNA', network: 'II', station: 'NNA', name: 'Nana, Peru', lat: -12.06, lon: -77.01 },
];

// Pool global de estaciones (se carga al arrancar el servidor)
export let GLOBAL_STATIONS = [...FALLBACK_STATIONS];

// Cargar estaciones dinamicamente desde el FDSN de IRIS
// Usa curl porque el servidor IRIS envia headers HTTP malformados (Duplicate Content-Length)
// que el parser HTTP de Node rechaza
export async function loadStationsFromFDSN() {
  return new Promise((resolve) => {
    const url = `${FDSN_STATION_URL}?format=text&level=station&channel=BHZ&starttime=2026-01-01&includerestricted=false`;
    console.log(`[FDSN] Consultando estaciones desde IRIS...`);

    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = execFile(
      curl,
      ['-sL', '--max-time', '60', '-H', 'Connection: close', url],
      { maxBuffer: 50 * 1024 * 1024, timeout: 70000 },
      (err, stdout) => {
        if (err) {
          console.warn(`[FDSN] Error cargando estaciones: ${err.message}`);
          console.warn(`[FDSN] Usando fallback (${FALLBACK_STATIONS.length} estaciones)`);
          return resolve();
        }
        try {
          const lines = stdout.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
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

            stations.push({
              code: `${network}-${stationCode}`,
              network,
              station: stationCode,
              name: siteName,
              lat,
              lon,
            });
          }

          if (stations.length > 0) {
            GLOBAL_STATIONS = stations;
            console.log(`[FDSN] ${stations.length} estaciones cargadas dinamicamente`);
          } else {
            console.warn(`[FDSN] Sin estaciones, usando fallback (${FALLBACK_STATIONS.length})`);
          }
        } catch (parseErr) {
          console.warn(`[FDSN] Error procesando respuesta: ${parseErr.message}`);
        }
        resolve();
      }
    );
  });
}

// Estructura de ConnectionEntry (sin tipos TypeScript)
// { station, connection, detector, subscribers, connected, lastDataTime }

const connectionPool = new Map();

// Haversine para distancia
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Encontrar las estaciones mas cercanas a una ubicacion dentro de un radio
export function findNearbyStations(lat, lon, radiusKm, maxStations = 3) {
  const nearby = GLOBAL_STATIONS.map((s) => ({
    ...s,
    distance: haversineKm(lat, lon, s.lat, s.lon),
  }))
    .filter((s) => s.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxStations);

  // Si no hay estaciones dentro del radio, tomar las 2 mas cercanas
  if (nearby.length === 0) {
    const closest = GLOBAL_STATIONS.map((s) => ({
      ...s,
      distance: haversineKm(lat, lon, s.lat, s.lon),
    }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);
    return closest;
  }

  return nearby;
}

// Suscribir un usuario a las estaciones cercanas
// Reutiliza conexiones existentes si otro usuario ya las esta usando
export async function subscribeUserToStations(
  clientId,
  userLat,
  userLon,
  radiusKm,
  onDataCallback,
  onAlertCallback
) {
  const stations = findNearbyStations(userLat, userLon, radiusKm);
  const subscribedStations = [];

  for (const station of stations) {
    let entry = connectionPool.get(station.code);

    if (!entry) {
      // Crear nueva conexion si no existe
      entry = {
        station,
        connection: null,
        detector: null,
        subscribers: new Set(),
        connected: false,
        lastDataTime: 0,
      };
      connectionPool.set(station.code, entry);
      connectToStation(entry, onDataCallback, onAlertCallback);
    }

    // Agregar usuario como suscriptor
    entry.subscribers.add(clientId);
    subscribedStations.push({
      code: station.code,
      name: station.name,
      distance: station.distance,
      connected: entry.connected,
    });
  }

  return subscribedStations;
}

// Desuscribir un usuario de todas sus estaciones
export function unsubscribeUser(clientId) {
  for (const [code, entry] of connectionPool.entries()) {
    entry.subscribers.delete(clientId);
    // Si nadie mas usa esta estacion, cerrar la conexion
    if (entry.subscribers.size === 0 && entry.connection) {
      console.log(`[POOL] Cerrando conexion ${code} (sin suscriptores)`);
      try {
        entry.connection.close();
      } catch (e) {
        // ignore
      }
      connectionPool.delete(code);
    }
  }
}

// Obtener estaciones suscritas de un usuario
export function getUserStations(clientId) {
  const stations = [];
  for (const [code, entry] of connectionPool.entries()) {
    if (entry.subscribers.has(clientId)) {
      stations.push({
        code,
        name: entry.station.name,
        connected: entry.connected,
        subscribers: entry.subscribers.size,
      });
    }
  }
  return stations;
}

// Obtener estadisticas del pool
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
    })),
  };
}

// Conectar a una estacion SeedLink
function connectToStation(entry, onDataCallback, onAlertCallback) {
  const station = entry.station;
  const commands = [
    `STATION ${station.network} ${station.station}`,
    'SELECT 00BHZ.D',
  ];

  console.log(`[POOL] Conectando a ${station.code} (${station.name})`);

  try {
    const startTime = DateTime.utc().minus({ seconds: 10 });
    const slConn = new seedlink.SeedlinkConnection(
      SEEDLINK_URL,
      commands,
      (packet) => {
        handleMiniseedPacket(entry, packet, onDataCallback, onAlertCallback);
      },
      (error) => {
        console.error(`[POOL] Error ${station.code}:`, error.message);
        entry.connected = false;
        scheduleReconnect(entry, onDataCallback, onAlertCallback);
      }
    );
    slConn.setOnClose(() => {
      console.warn(`[POOL] Conexion cerrada ${station.code}`);
      entry.connected = false;
      scheduleReconnect(entry, onDataCallback, onAlertCallback);
    });
    slConn.setTimeCommand(startTime);
    slConn.connect().then(() => {
      console.log(`[POOL] Conectado ${station.code}`);
      entry.connection = slConn;
      entry.connected = true;
    }).catch((err) => {
      console.error(`[POOL] Error al conectar ${station.code}:`, err.message);
      scheduleReconnect(entry, onDataCallback, onAlertCallback);
    });
  } catch (err) {
    console.error(`[POOL] Error creando conexion ${station.code}:`, err.message);
    scheduleReconnect(entry, onDataCallback, onAlertCallback);
  }
}

const reconnectTimers = new Map();

function scheduleReconnect(entry, onDataCallback, onAlertCallback) {
  const key = entry.station.code;
  if (reconnectTimers.has(key)) return;
  reconnectTimers.set(
    key,
    setTimeout(() => {
      reconnectTimers.delete(key);
      if (entry.subscribers.size > 0) {
        connectToStation(entry, onDataCallback, onAlertCallback);
      }
    }, 5000)
  );
}

function handleMiniseedPacket(entry, packet, onDataCallback, onAlertCallback) {
  try {
    const msRecord = packet.miniseed;
    if (!msRecord) return;

    const segments = miniseed.seismogramSegmentPerChannel([msRecord]);
    if (!segments || segments.length === 0) return;

    const segment = segments[0];
    const samples = segment.y;
    if (!samples || samples.length === 0) return;

    entry.lastDataTime = Date.now();

    // Enviar waveform a todos los suscriptores de esta estacion
    if (onDataCallback) {
      onDataCallback(entry, samples, segment.sampleRate, segment.channelCode);
    }

    // Procesar con detector y enviar alertas
    if (onAlertCallback) {
      onAlertCallback(entry, samples, segment.sampleRate, segment.channelCode);
    }
  } catch (err) {
    console.warn(`[POOL] Error procesando ${entry.station.code}:`, err.message);
  }
}