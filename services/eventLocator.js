// eventLocator.js
// Localizacion preliminar del epicentro usando tiempos de llegada P
// de multiples estaciones y un modelo de velocidades simplificado.
//
// Metodo: busca en grilla el punto (lat, lon) cuyo origin time predicho
// minimiza el residual entre tiempos observados y teoricos.

import { SEISMIC_CONFIG } from '../seismicConfig.js';

// Distancia epicentral entre dos puntos (haversine, km)
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

// Localizar epicentro preliminar a partir de picks P de multiples estaciones
//
// picks: [{ stationCode, pTime (DateTime), lat, lon }]
//
// Devuelve:
//   { latitude, longitude, depth: null, originTime, residual, confidence, preliminaryLocation }
//
// Si no hay suficientes estaciones, devuelve null.
export function locateEpicenter(picks) {
  const { Vp } = SEISMIC_CONFIG.velocities;
  const { gridStepKm, maxResidual } = SEISMIC_CONFIG.location;

  if (!picks || picks.length < 2) {
    return null;
  }

  // Convertir tiempos a epoch ms para calculo
  const picksMs = picks.map((p) => ({
    ...p,
    pTimeMs: p.pTime.toMillis(),
  }));

  // Centro inicial: promedio de las estaciones
  let centerLat = picksMs.reduce((s, p) => s + p.lat, 0) / picksMs.length;
  let centerLon = picksMs.reduce((s, p) => s + p.lon, 0) / picksMs.length;

  // Busqueda en grilla: iterativamente reducir el paso
  let bestLat = centerLat;
  let bestLon = centerLon;
  let bestOrigin = 0;
  let bestResidual = Infinity;

  // Iteraciones de busqueda: grilla gruesa -> fina
  const steps = [1.0, 0.5, 0.25, 0.1, 0.05];  // grados

  for (const stepDeg of steps) {
    const stepKm = stepDeg * 111;  // ~111 km por grado
    let iterBestResidual = Infinity;
    let iterBestLat = bestLat;
    let iterBestLon = bestLon;

    // Probar puntos en una grilla alrededor del mejor actual
    const range = 2;  // +/- 2 pasos en cada direccion
    for (let dLat = -range; dLat <= range; dLat++) {
      for (let dLon = -range; dLon <= range; dLon++) {
        const testLat = bestLat + dLat * stepDeg;
        const testLon = bestLon + dLon * stepDeg;

        // Calcular origin time y residual para este punto
        const result = calculateResidual(testLat, testLon, picksMs);
        if (result.residual < iterBestResidual) {
          iterBestResidual = result.residual;
          iterBestLat = testLat;
          iterBestLon = testLon;
          bestOrigin = result.originTime;
        }
      }
    }

    bestResidual = iterBestResidual;
    bestLat = iterBestLat;
    bestLon = iterBestLon;
  }

  // Calcular confianza basada en residual y numero de estaciones
  const confidence = calculateConfidence(bestResidual, picks.length);

  // Profundidad: NO LA CALCULAMOS con este metodo simplificado
  // Necesitaria inversion con modelos de velocidad por profundidad
  return {
    latitude: bestLat,
    longitude: bestLon,
    depth: null,                    // explicitamente null (no se calcula)
    originTime: new Date(bestOrigin),
    residual: bestResidual,         // en segundos
    confidence,
    preliminaryLocation: true,
    numStations: picks.length,
  };
}

// Calcular residual para un punto de prueba
function calculateResidual(testLat, testLon, picksMs) {
  const { Vp } = SEISMIC_CONFIG.velocities;
  let sumObs = 0;
  let sumPred = 0;
  let sumSqResidual = 0;
  let count = 0;
  let originTimeSum = 0;

  for (const pick of picksMs) {
    const distanceKm = haversineKm(testLat, testLon, pick.lat, pick.lon);
    const predictedTravelTime = distanceKm / Vp;  // segundos
    const predictedArrivalMs = pick.pTimeMs - predictedTravelTime * 1000;
    originTimeSum += predictedArrivalMs;
    count++;
  }

  // Origin time = promedio de los tiempos estimados
  const originTime = originTimeSum / count;

  // Residual: diferencia entre arrival observado y predicho
  for (const pick of picksMs) {
    const distanceKm = haversineKm(testLat, testLon, pick.lat, pick.lon);
    const predictedArrival = originTime + (distanceKm / Vp) * 1000;
    const residual = (pick.pTimeMs - predictedArrival) / 1000;  // segundos
    sumSqResidual += residual * residual;
  }

  const rmsResidual = Math.sqrt(sumSqResidual / count);

  return { residual: rmsResidual, originTime };
}

// Confianza: basada en residual y numero de estaciones
function calculateConfidence(residual, numStations) {
  const { maxResidual, confidenceThreshold } = SEISMIC_CONFIG.location;

  // Factor por residual (0-1): menor residual = mayor confianza
  let residualFactor = 1 - Math.min(1, residual / maxResidual);

  // Factor por numero de estaciones
  let stationFactor = Math.min(1, numStations / 3);

  return residualFactor * stationFactor * confidenceThreshold * 2;
}

// Distancia epicentral desde el epicentro estimado a una ubicacion (usuario)
export function epicentralDistanceKm(epicenterLat, epicenterLon, userLat, userLon) {
  return haversineKm(epicenterLat, epicenterLon, userLat, userLon);
}

// Distancia hipocentral (incluyendo profundidad, si esta disponible)
export function hypocentralDistanceKm(epicenterLat, epicenterLon, depthKm, userLat, userLon) {
  const epiDist = haversineKm(epicenterLat, epicenterLon, userLat, userLon);
  if (depthKm == null || depthKm <= 0) return epiDist;
  return Math.sqrt(epiDist * epiDist + depthKm * depthKm);
}

// Estimar tiempo de llegada de onda S a la ubicacion del usuario
export function estimateSArrivalSeconds(epicenter, userLat, userLon) {
  const { Vp, Vs } = SEISMIC_CONFIG.velocities;
  const distanceKm = epicentralDistanceKm(epicenter.latitude, epicenter.longitude, userLat, userLon);
  return distanceKm / Vs;  // segundos hasta que llegue S
}

// Estimar tiempo de llegada de onda P
export function estimatePArrivalSeconds(epicenter, userLat, userLon) {
  const { Vp } = SEISMIC_CONFIG.velocities;
  const distanceKm = epicentralDistanceKm(epicenter.latitude, epicenter.longitude, userLat, userLon);
  return distanceKm / Vp;
}