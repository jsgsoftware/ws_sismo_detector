// instrumentResponse.js
// Convierte counts digitales crudos a unidades fisicas (m/s) usando la
// respuesta instrumental obtenida via StationXML.
// Usa seisplotjs.transfer para aplicar la desconvolucion completa.

import * as seisplotjs from 'seisplotjs/nodeonly';
const { transfer, convertToSacPoleZero, gainCorrect } = seisplotjs.transfer;
const { Seismogram } = seisplotjs.seismogram;
import { SEISMIC_CONFIG } from '../seismicConfig.js';

// Cache de SacPoleZero por NSLC (es pesado calcularlo)
const sacPzCache = new Map();

// Convierte una StationXML Response a SacPoleZero (formato de polos/ceros)
// y lo cachea para reutilizar
export function getSacPoleZero(response) {
  if (!response) return null;

  const cacheKey = response?.instrumentSensitivity?.sensitivity ?? Math.random();
  if (sacPzCache.has(cacheKey)) {
    return sacPzCache.get(cacheKey);
  }

  try {
    const sacPz = convertToSacPoleZero(response);
    sacPzCache.set(cacheKey, sacPz);
    return sacPz;
  } catch (err) {
    console.warn('[RESP] Error convirtiendo a SacPoleZero:', err.message);
    return null;
  }
}

// Convierte un SeismogramSegment de counts a unidades fisicas (m/s)
// usando la respuesta instrumental completa (polos, ceros, gain, etapas).
// Aplica: desconvolucion instrumento + filtrado band-pass
//
// Parametros:
//   segment: SeismogramSegment con los counts crudos
//   response: StationXML Response object de seisplotjs
//   sampleRate: sample rate de la señal
//
// Devuelve:
//   SeismogramSegment con valores en m/s (velocidad del suelo)
//   o null si no se puede desconvolucionar
export function convertCountsToVelocity(segment, response, sampleRate) {
  if (!segment || !response) {
    console.warn('[RESP] Segment o response nulo, no se puede convertir');
    return null;
  }

  try {
    const sacPz = getSacPoleZero(response);
    if (!sacPz) {
      console.warn('[RESP] No se pudo obtener SacPoleZero');
      return null;
    }

    // Bandas del filtro para la transferencia
    // lowCut < lowPass < highPass < highCut
    const { lowHz, highHz } = SEISMIC_CONFIG.filter;
    const nyquist = sampleRate / 2;

    // Asegurar que las frecuencias esten dentro del rango valido
    const lowCut = Math.max(0.001, lowHz * 0.5);
    const lowPass = Math.max(0.002, lowHz);
    const highPass = Math.min(nyquist * 0.8, highHz);
    const highCut = Math.min(nyquist * 0.9, highHz * 1.5);

    // Crear un Seismogram a partir del segment (transfer requiere Seismogram)
    const seismogram = new Seismogram([segment]);

    // Aplicar transferencia: desconvolucion + filtrado
    // Esto convierte counts -> m/s aplicando poles/zeros y gain
    const corrected = transfer.transferSacPZSegment(
      segment,
      sacPz,
      lowCut,
      lowPass,
      highPass,
      highCut
    );

    if (!corrected) {
      console.warn('[RESP] Transfer devolvio null');
      return null;
    }

    // El segmento corregido esta en m/s (velocidad del suelo)
    return corrected;
  } catch (err) {
    console.warn('[RESP] Error en convertCountsToVelocity:', err.message);
    return null;
  }
}

// Conversion rapida usando solo la sensibilidad instrumental (fallback)
// NO es una desconvolucion completa, solo aplica el factor de escala
// Menos preciso pero util si no hay polos/ceros disponibles
export function applySensitivityOnly(segment, instrumentSensitivity) {
  if (!segment || !instrumentSensitivity) return null;

  try {
    return gainCorrect(segment, instrumentSensitivity);
  } catch (err) {
    console.warn('[RESP] Error en applySensitivityOnly:', err.message);
    return null;
  }
}

// Extraer valores de un segment como array de numeros (para procesamiento)
export function segmentToFloatArray(segment) {
  if (!segment || !segment.y) return [];
  return Array.from(segment.y).map((v) => Number(v));
}

// Extraer timestamp real de un sample del miniSEED
export function getSampleTimestamp(segment, index) {
  if (!segment) return null;
  try {
    return segment.timeOfSample(index);
  } catch (err) {
    return null;
  }
}

// Tiempo de inicio real del segment (del miniSEED, no Date.now())
export function getSegmentStartTime(segment) {
  if (!segment) return null;
  try {
    return segment.startTime;
  } catch (err) {
    return null;
  }
}