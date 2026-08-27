// magnitudeCalculator.js
// Calcula magnitud local (ML) usando la formula de Hutton-Boore (California)
// con simulacion de respuesta Wood-Anderson.
//
// ML = log10(A_mm) + a * log10(R_km) + b * R_km + c
//
// donde:
//   A_mm = amplitud pico en nanometros (despues de simular Wood-Anderson)
//   R_km = distancia hipocentral
//   a, b, c = coeficientes de atenuacion
//
// La magnitud se calcula por estacion y se combina con la mediana.

import { SEISMIC_CONFIG } from '../seismicConfig.js';
import { hypocentralDistanceKm } from './eventLocator.js';

// Calcular ML para una estacion
//
// Parametros:
//   peakVelocityMs: amplitud pico en m/s (despues de desconvolucion)
//   epicenter: { latitude, longitude, depth }
//   stationLat, stationLon: coordenadas de la estacion
//
// Devuelve: { magnitude, stationCode, distanceKm }
export function estimateLocalMagnitude(peakVelocityMs, epicenter, stationLat, stationLon, stationCode) {
  if (peakVelocityMs == null || peakVelocityMs <= 0) return null;

  const { a, b, c } = SEISMIC_CONFIG.magnitude.attenuation;
  const { staticMagnification, period, damping } = SEISMIC_CONFIG.magnitude.woodAnderson;

  // Distancia hipocentral
  const distanceKm = hypocentralDistanceKm(
    epicenter.latitude, epicenter.longitude, epicenter.depth, stationLat, stationLon
  );

  if (distanceKm <= 0) return null;

  // Simular respuesta Wood-Anderson
  // El WA tiene magnificacion 2800 y periodo 0.8s
  // Para una velocidad de suelo (m/s), el desplazamiento WA en nm es:
  //   A_wa = V * T / (2 * pi) * magnification * 1e9  (nm)
  // Esto es una aproximacion: asume que la amplitud pico de velocidad
  // corresponde al desplazamiento pico para el periodo dominante del WA.
  const displacementMeters = peakVelocityMs * period / (2 * Math.PI);
  const amplitudeNm = displacementMeters * staticMagnification * 1e9;  // nanometros

  if (amplitudeNm <= 0) return null;

  // Formula ML (Hutton-Boore)
  // ML = log10(A_nm) + a * log10(R_km) + b * R_km + c
  const ml = Math.log10(amplitudeNm) + a * Math.log10(distanceKm) + b * distanceKm + c;

  return {
    magnitude: ml,
    stationCode,
    distanceKm,
    peakVelocityMs,
    amplitudeNm,
  };
}

// Combinar magnitudes de varias estaciones usando la mediana
// (mas robusta que el promedio frente a outliers)
export function combineMagnitudes(stationMagnitudes) {
  if (!stationMagnitudes || stationMagnitudes.length === 0) return null;

  // Filtrar valores invalidos
  const valid = stationMagnitudes.filter((m) => m != null && !isNaN(m.magnitude));
  if (valid.length === 0) return null;

  // Extraer solo las magnitudes
  const mags = valid.map((m) => m.magnitude).sort((a, b) => a - b);

  // Mediana
  let median;
  const mid = Math.floor(mags.length / 2);
  if (mags.length % 2 === 0) {
    median = (mags[mid - 1] + mags[mid]) / 2;
  } else {
    median = mags[mid];
  }

  // Desviacion estandar como medida de confianza
  const mean = mags.reduce((s, m) => s + m, 0) / mags.length;
  const variance = mags.reduce((s, m) => s + (m - mean) ** 2, 0) / mags.length;
  const stdDev = Math.sqrt(variance);

  // Confianza: inversa de la desviacion estandar
  const confidence = Math.max(0, Math.min(1, 1 - stdDev / 1.0));

  return {
    magnitude: median,
    magnitudeType: 'ML',
    stationMagnitudes: valid,
    confidence,
    stdDev,
  };
}

// Calcular magnitud combinada para un evento con picks de varias estaciones
// picks: [{ stationCode, peakVelocityMs, lat, lon }]
// epicenter: { latitude, longitude, depth }
export function calculateEventMagnitude(picks, epicenter) {
  if (!picks || !epicenter) return null;

  const stationMags = picks
    .map((p) => {
      if (p.peakVelocityMs == null || p.lat == null || p.lon == null) return null;
      return estimateLocalMagnitude(
        p.peakVelocityMs,
        epicenter,
        p.lat, p.lon,
        p.stationCode
      );
    })
    .filter((m) => m != null);

  return combineMagnitudes(stationMags);
}