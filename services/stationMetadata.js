// stationMetadata.js
// Obtiene y cachea StationXML desde FDSN, descubre canales disponibles (Z/N/E)
// y la respuesta instrumental para cada canal.

import * as seisplotjs from 'seisplotjs/nodeonly';
const parseStationXml = seisplotjs.stationxml.parseStationXml;
import { DateTime } from 'luxon';
import { execFile } from 'child_process';
import { SEISMIC_CONFIG } from '../seismicConfig.js';

const FDSN_STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';

// Cache de StationXML por NSLC: { network, station, location, channel }
// Forma: Map<nslcKey, { response, channel, station, fetchedAt }>
const stationXmlCache = new Map();

// Cache del inventario de canales por estacion
// Forma: Map<stationCode, { z, n, e, fetchedAt }>
const channelInventoryCache = new Map();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function nslcKey(network, station, location, channel) {
  return `${network}.${station}.${location || '--'}.${channel}`;
}

// Descubrir que canales Z/N/E existen para una estacion
// Prioridad: BHZ > HHZ > HNZ para vertical
//           BHN > HHN > HNN para norte
//           BHE > HHE > HNE para este
export async function discoverChannels(network, stationCode) {
  const cacheKey = `${network}-${stationCode}`;
  const cached = channelInventoryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Canales a buscar, en orden de preferencia
  const zCandidates = ['BHZ', 'HHZ', 'HNZ', 'EHZ'];
  const nCandidates = ['BHN', 'HHN', 'HNN', 'EHN'];
  const eCandidates = ['BHE', 'HHE', 'HNE', 'EHE'];

  try {
    // Consultar FDSN station a nivel channel para ver que canales existen
    const url = `${FDSN_STATION_URL}?format=text&level=channel&network=${network}&station=${stationCode}&starttime=${DateTime.utc().toISODate()}&includerestricted=false`;

    const text = await fetchWithCurl(url);
    if (!text) {
      // Fallback: asumir BHZ solo
      const result = { z: { channel: 'BHZ', location: '00' }, n: null, e: null, fetchedAt: Date.now() };
      channelInventoryCache.set(cacheKey, result);
      return result;
    }

    // Parsear el texto: Network | Station | Location | Channel | Lat | Lon | Elev | Depth | Azimuth | Dip | SampleRate | ...
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const availableChannels = [];

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 7) continue;
      const net = parts[0].trim();
      const sta = parts[1].trim();
      const loc = parts[2].trim();
      const chan = parts[3].trim();
      const sampleRate = parseFloat(parts[10] || '0');

      if (net === network && sta === stationCode) {
        availableChannels.push({ channel: chan, location: loc, sampleRate });
      }
    }

    // Elegir el mejor canal de cada componente
    const pickBest = (candidates) => {
      for (const cand of candidates) {
        const found = availableChannels.find((c) => c.channel === cand);
        if (found) return found;
      }
      return null;
    };

    const z = pickBest(zCandidates);
    const n = pickBest(nCandidates);
    const e = pickBest(eCandidates);

    const result = { z, n, e, fetchedAt: Date.now() };
    channelInventoryCache.set(cacheKey, result);

    console.log(`[META] ${network}-${stationCode}: Z=${z ? z.channel : 'none'} N=${n ? n.channel : 'none'} E=${e ? e.channel : 'none'}`);

    return result;
  } catch (err) {
    console.warn(`[META] Error descubriendo canales ${network}-${stationCode}: ${err.message}`);
    const result = { z: { channel: 'BHZ', location: '00' }, n: null, e: null, fetchedAt: Date.now() };
    channelInventoryCache.set(cacheKey, result);
    return result;
  }
}

// Obtener la respuesta instrumental (StationXML) para un NSLC
// Usa level=channel (no level=response) porque el parser de seisplotjs
// falla con stages vacios del formato StationXML 1.1 de EarthScope.
// Devuelve la sensibilidad instrumental para gainCorrect (counts -> m/s).
export async function getInstrumentResponse(network, stationCode, locationCode, channelCode) {
  const key = nslcKey(network, stationCode, locationCode, channelCode);

  const cached = stationXmlCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const locParam = locationCode || '--';
    const startTime = DateTime.utc().minus({ days: 1 }).toISO();
    // Usar level=channel para obtener InstrumentSensitivity sin stages problematicos
    const url = `${FDSN_STATION_URL}?level=channel&format=xml&network=${network}&station=${stationCode}&location=${locParam}&channel=${channelCode}&starttime=${startTime}&includerestricted=false`;

    const xmlText = await fetchWithCurl(url);
    if (!xmlText) {
      console.warn(`[META] Sin StationXML para ${key}`);
      return null;
    }

    // Parsear StationXML con seisplotjs
    const domParser = new DOMParser();
    const xmlDocument = domParser.parseFromString(xmlText, 'text/xml');

    const networks = parseStationXml(xmlDocument);
    if (!networks || networks.length === 0) {
      console.warn(`[META] StationXML vacio para ${key}`);
      return null;
    }

    // Buscar el canal especifico
    let foundChannel = null;
    for (const net of networks) {
      if (net.networkCode !== network) continue;
      for (const sta of net.stations) {
        if (sta.stationCode !== stationCode) continue;
        for (const chan of sta.channels) {
          if (chan.channelCode === channelCode) {
            const chanLoc = chan.locationCode || '';
            const reqLoc = locationCode || '';
            if (chanLoc === reqLoc || (!chanLoc && !reqLoc)) {
              foundChannel = chan;
              break;
            }
          }
        }
      }
    }

    if (!foundChannel) {
      console.warn(`[META] Canal ${key} no encontrado`);
      return null;
    }

    if (!foundChannel.instrumentSensitivity) {
      console.warn(`[META] Sin sensibilidad para ${key}`);
      return null;
    }

    const result = {
      sensitivity: foundChannel.instrumentSensitivity,
      channel: foundChannel,
      response: null,  // no hay response completa, solo sensibilidad
      fetchedAt: Date.now(),
    };

    stationXmlCache.set(key, result);
    console.log(`[META] Sensibilidad obtenida para ${key} (sens=${foundChannel.instrumentSensitivity.sensitivity} ${foundChannel.instrumentSensitivity.inputUnits}->${foundChannel.instrumentSensitivity.outputUnits})`);

    return result;
  } catch (err) {
    console.warn(`[META] Error obteniendo StationXML para ${key}: ${err.message}`);
    return null;
  }
}

// Obtener coordenadas de la estacion desde StationXML
export async function getStationCoordinates(network, stationCode) {
  try {
    const url = `${FDSN_STATION_URL}?level=station&format=text&network=${network}&station=${stationCode}&starttime=${DateTime.utc().toISODate()}&includerestricted=false`;
    const text = await fetchWithCurl(url);
    if (!text) return null;

    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 5 && parts[0].trim() === network && parts[1].trim() === stationCode) {
        return {
          latitude: parseFloat(parts[2]),
          longitude: parseFloat(parts[3]),
          elevation: parseFloat(parts[4]),
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[META] Error obteniendo coords: ${err.message}`);
    return null;
  }
}

// Helper: fetch con curl porque el IRIS envia headers HTTP malformados
function fetchWithCurl(url) {
  return new Promise((resolve) => {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFile(
      curl,
      ['-sL', '--max-time', '30', '-H', 'Connection: close', url],
      { maxBuffer: 20 * 1024 * 1024, timeout: 35000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export { stationXmlCache, channelInventoryCache };