// signalProcessing.js
// Procesamiento de señal sismica: demean, detrend, filtrado band-pass
// Usa los filtros Butterworth de seisplotjs/oregondsp

import * as seisplotjs from 'seisplotjs/nodeonly';
const { rMean, removeTrend, createButterworth, applyFilter, envelope, differentiate, BAND_PASS } = seisplotjs.filter;
const { Seismogram } = seisplotjs.seismogram;
import { SEISMIC_CONFIG } from '../seismicConfig.js';

// Procesa un SeismogramSegment: demean + detrend + bandpass
// Devuelve un nuevo SeismogramSegment procesado
export function preprocessSignal(segment, sampleRate) {
  if (!segment || !segment.y || segment.y.length === 0) return null;

  try {
    // Crear Seismogram para usar las funciones de seisplotjs
    const seismogram = new Seismogram([segment]);

    // 1. Remover la media (demean)
    let processed = rMean(seismogram);

    // 2. Remover tendencia (detrend - linea de mejor ajuste)
    processed = removeTrend(processed);

    // 3. Filtrado band-pass Butterworth
    const { lowHz, highHz, numPoles } = SEISMIC_CONFIG.filter;
    const nyquist = sampleRate / 2;

    // Verificar que el filtro sea valido para el sample rate
    if (highHz >= nyquist) {
      console.warn(`[FILTER] highHz ${highHz} >= nyquist ${nyquist}, ajustando`);
    }
    const adjustedHighHz = Math.min(highHz, nyquist * 0.8);

    // Crear filtro Butterworth band-pass
    const bpFilter = createButterworth(
      numPoles,
      BAND_PASS,
      lowHz,
      adjustedHighHz,
      1 / sampleRate  // delta = periodo
    );

    // Aplicar filtro
    const filtered = applyFilter(bpFilter, processed);

    // Devolver el primer segmento del seismogram filtrado
    if (filtered && filtered.segments && filtered.segments.length > 0) {
      return filtered.segments[0];
    }

    return null;
  } catch (err) {
    console.warn('[FILTER] Error en preprocessSignal:', err.message);
    return null;
  }
}

// Calcula la envolvente de la señal (util para deteccion de ondas)
export function computeEnvelope(segment, sampleRate) {
  if (!segment) return null;
  try {
    const seismogram = new Seismogram([segment]);
    const envSeis = envelope(seismogram);
    if (envSeis && envSeis.segments && envSeis.segments.length > 0) {
      return envSeis.segments[0];
    }
    return null;
  } catch (err) {
    console.warn('[FILTER] Error computeEnvelope:', err.message);
    return null;
  }
}

// Diferenciar la señal (velocidad -> aceleracion o desplazamiento -> velocidad)
export function differentiateSignal(segment, sampleRate) {
  if (!segment) return null;
  try {
    const seismogram = new Seismogram([segment]);
    const diffSeis = differentiate(seismogram);
    if (diffSeis && diffSeis.segments && diffSeis.segments.length > 0) {
      return diffSeis.segments[0];
    }
    return null;
  } catch (err) {
    console.warn('[FILTER] Error differentiateSignal:', err.message);
    return null;
  }
}

// Extraer valores de un segment como array de numeros (para procesamiento)
export function segmentToFloatArray(segment) {
  if (!segment || !segment.y) return [];
  return Array.from(segment.y).map((v) => Number(v));
}

// Calcular valor RMS de un array de muestras
export function rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSq = 0;
  for (const s of samples) {
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

// Calcular pico absoluto
export function peakAmplitude(samples) {
  if (!samples || samples.length === 0) return 0;
  let peak = 0;
  for (const s of samples) {
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  return peak;
}