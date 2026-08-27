// eventCorrelator.js
// Correlaciona picks P de multiples estaciones para confirmar un evento sismico.
// Una sola estacion genera "possible_event"; 2+ estaciones generan "confirmed_event".

import { SEISMIC_CONFIG } from '../seismicConfig.js';

// Cola de picks recientes por estacion
// Forma: Map<stationCode, { pTime, amplitude, lat, lon, sampleRate }>
const recentPicks = new Map();

// Eventos en curso
// Forma: { id, picks: [], state, createdAt, originTime, location, magnitude }
const activeEvents = [];

let eventIdCounter = 0;

// Registrar un pick P de una estacion
// Devuelve un evento si se cumple la condicion de correlacion multi-estacion
export function registerPPick(pick) {
  const { minConfirmingStations, windowSeconds } = SEISMIC_CONFIG.correlation;

  recentPicks.set(pick.stationCode, pick);

  // Limpiar picks viejos (fuera de la ventana temporal)
  const now = pick.pTime;  // usar el timestamp real del pick
  for (const [code, p] of recentPicks.entries()) {
    const ageSeconds = Math.abs((now.toMillis() - p.pTime.toMillis()) / 1000);
    if (ageSeconds > windowSeconds) {
      recentPicks.delete(code);
    }
  }

  // Buscar picks compatibles dentro de la ventana
  const compatiblePicks = [];
  for (const [code, p] of recentPicks.entries()) {
    const diffSeconds = Math.abs((now.toMillis() - p.pTime.toMillis()) / 1000);
    if (diffSeconds <= windowSeconds) {
      compatiblePicks.push(p);
    }
  }

  if (compatiblePicks.length >= minConfirmingStations) {
    // Tenemos un evento confirmado
    const event = {
      id: `evt_${Date.now()}_${eventIdCounter++}`,
      picks: compatiblePicks,
      state: compatiblePicks.length >= SEISMIC_CONFIG.correlation.preferredStations
        ? 'CONFIRMED_EVENT'
        : 'CONFIRMED_EVENT',
      numStations: compatiblePicks.length,
      createdAt: new Date(),
      earliestPickTime: compatiblePicks.reduce((min, p) =>
        p.pTime < min ? p.pTime : min, compatiblePicks[0].pTime),
    };

    // Agregar a eventos activos (evitar duplicados)
    if (!activeEvents.find((e) => e.id === event.id)) {
      activeEvents.push(event);
    }

    return event;
  } else if (compatiblePicks.length === 1) {
    // Possible event de una sola estacion
    return {
      id: `possible_${Date.now()}_${eventIdCounter++}`,
      picks: compatiblePicks,
      state: 'POSSIBLE_EVENT',
      numStations: 1,
      createdAt: new Date(),
      earliestPickTime: compatiblePicks[0].pTime,
    };
  }

  return null;
}

// Registrar un pick S de una estacion
export function registerSPick(stationCode, sTime, amplitude) {
  for (const event of activeEvents) {
    const pick = event.picks.find((p) => p.stationCode === stationCode);
    if (pick) {
      pick.sTime = sTime;
      pick.sAmplitude = amplitude;
      return event;
    }
  }
  return null;
}

// Obtener eventos activos
export function getActiveEvents() {
  return activeEvents;
}

// Limpiar eventos viejos (mas de 5 minutos)
export function cleanupOldEvents() {
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000;
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    if (now - activeEvents[i].createdAt.getTime() > maxAgeMs) {
      activeEvents.splice(i, 1);
    }
  }
}

// Obtener picks recientes para debug
export function getRecentPicks() {
  return Array.from(recentPicks.values());
}

// Reset (para testing)
export function resetCorrelator() {
  recentPicks.clear();
  activeEvents.length = 0;
}