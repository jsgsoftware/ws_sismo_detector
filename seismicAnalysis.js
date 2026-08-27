// seismicAnalysis.js
// REESCRITO: reemplaza umbrales fijos por STA/LTA + V/H discrimination
// Mantiene funciones de distancia/atenuacion para compatibilidad

import { SEISMIC_CONFIG } from './seismicConfig.js';

// =====================================================================
//  DEPRECATED - Umbrales viejos sobre counts crudos (NO USAR)
//  Se mantienen solo para compatibilidad con codigo que aun los referencia
// =====================================================================
export const UMBRAL_RUIDO = 0.005;
export const UMBRAL_P = 0.012;
export const UMBRAL_S = 0.045;
export const UMBRAL_FUERTE = 0.080;

// Velocidades de onda (usadas por eventLocator y phasePicker)
export const VP = SEISMIC_CONFIG.velocities.Vp;
export const VS = SEISMIC_CONFIG.velocities.Vs;

// =====================================================================
//  Detector viejo (DEPRECATED) - mantener para no romper imports
//  El nuevo detector esta en services/phasePicker.js
// =====================================================================
export class SeismicDetector {
  constructor() {
    this.state = 'NORMAL';
    this.stateChangeTime = Date.now();
    this.noiseBaseline = 0;
    this.noiseSampleCount = 0;
    this.maxNoiseSamples = 100;
    this.pWaveTime = 0;
    this.sWaveTime = 0;
    this.energyHistory = [];
    this.maxEnergyHistory = 200;
    this.lastAmplitude = 0;
    this.preEventEnergy = 0;
    this.postEventEnergy = 0;
    this.postEventSampleCount = 0;
    console.warn('[DEPRECATED] SeismicDetector: usar services/phasePicker.js en su lugar');
  }

  reset() {
    this.state = 'NORMAL';
    this.stateChangeTime = Date.now();
    this.pWaveTime = 0;
    this.sWaveTime = 0;
    this.energyHistory = [];
  }

  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      this.stateChangeTime = Date.now();
    }
  }

  process(amp, axes) {
    // DEPRECATED: passthrough sin deteccion real
    const absAmp = Math.abs(amp);
    return {
      state: this.state,
      level: 'Normal',
      color: '#22c55e',
      pga: absAmp,
      verticalEnergy: absAmp * absAmp,
      horizontalEnergy: 0,
      vhRatio: 1,
      waveType: 'unknown',
      message: 'Detector deprecado - usar phasePicker',
      shouldAlert: false,
      alertType: null,
    };
  }

  getState() { return this.state; }
}

// =====================================================================
//  Funciones de distancia (mantenidas, mejoradas)
// =====================================================================

// Distancia hipocentral aproximada a partir del retardo S-P
// D = (Vp * Vs) / (Vp - Vs) * deltaT
export function distanceFromSPDelay(spDelaySeconds) {
  const { Vp, Vs } = SEISMIC_CONFIG.velocities;
  return (Vp * Vs) / (Vp - Vs) * spDelaySeconds;
}

// Tiempo de aviso previo (segundos antes de que llegue S)
export function earlyWarningTime(distanceKm) {
  const { Vp, Vs } = SEISMIC_CONFIG.velocities;
  return distanceKm * (1 / Vs - 1 / Vp);
}

// Tiempos de llegada teoricos
export function arrivalTimes(distanceKm) {
  const { Vp, Vs } = SEISMIC_CONFIG.velocities;
  const pArrival = distanceKm / Vp;
  const sArrival = distanceKm / Vs;
  return { pArrival, sArrival, spGap: sArrival - pArrival };
}

// =====================================================================
//  Funciones de atenuacion (mantenidas para compatibilidad)
// =====================================================================

// PGA estimado a partir de magnitud y distancia (modelo simple)
export function pgaAtDistance(magnitude, distanceKm) {
  return Math.pow(10, -0.9 + 0.5 * magnitude - Math.log10(distanceKm + 10));
}

// Radio de perceptibilidad
export function feltRadius(magnitude) {
  return Math.pow(10, 2.1 + 0.5 * magnitude) - 10;
}