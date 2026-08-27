// phasePicker.js
// Detector de fases P y S usando STA/LTA, energia y relacion V/H.
// Reemplaza el detector anterior de umbrales fijos sobre counts.

import { SEISMIC_CONFIG } from '../seismicConfig.js';
import { rms } from './signalProcessing.js';

// Estados del detector
export const PickerState = {
  IDLE: 'IDLE',
  STA_LTA_TRIGGERED: 'STA_LTA_TRIGGERED',
  P_DETECTED: 'P_DETECTED',
  S_DETECTED: 'S_DETECTED',
  EVENT_IN_PROGRESS: 'EVENT_IN_PROGRESS',
  COOLDOWN: 'COOLDOWN',
};

// Clase para deteccion STA/LTA en un canal
export class StaLtaDetector {
  constructor(channelCode, sampleRate) {
    this.channelCode = channelCode;
    this.sampleRate = sampleRate;

    const { staSeconds, ltaSeconds, triggerOn, triggerOff } = SEISMIC_CONFIG.staLta;
    this.staWindow = Math.floor(staSeconds * sampleRate);
    this.ltaWindow = Math.floor(ltaSeconds * sampleRate);
    this.triggerOn = triggerOn;
    this.triggerOff = triggerOff;

    // Buffers circulares para STA y LTA
    this.staBuffer = [];
    this.ltaBuffer = [];
    this.maxStaBuffer = this.staWindow;
    this.maxLtaBuffer = this.ltaWindow;

    this.state = PickerState.IDLE;
    this.stateChangeTime = null;  // timestamp real del sample (DateTime)
    this.lastRatio = 0;

    this.pPickTime = null;   // DateTime del pick P
    this.sPickTime = null;   // DateTime del pick S
    this.pAmplitude = 0;
    this.sAmplitude = 0;
    this.peakAmplitude = 0;
    this.peakVelocity = 0;
  }

  // Procesar una muestra individual con su timestamp real
  // sample: valor fisico (m/s)
  // timestamp: DateTime de luxon del sample
  process(sample, timestamp) {
    if (sample == null || timestamp == null) return null;

    const absSample = Math.abs(sample);

    // Actualizar buffers
    this.staBuffer.push(absSample);
    if (this.staBuffer.length > this.maxStaBuffer) this.staBuffer.shift();

    this.ltaBuffer.push(absSample);
    if (this.ltaBuffer.length > this.maxLtaBuffer) this.ltaBuffer.shift();

    // Actualizar peak
    if (absSample > this.peakAmplitude) {
      this.peakAmplitude = absSample;
      this.peakVelocity = absSample;  // ya en m/s
    }

    // Necesitamos suficientes samples para LTA
    if (this.ltaBuffer.length < this.ltaWindow) {
      return { state: this.state, ratio: 0 };
    }

    // Calcular STA y LTA (RMS)
    const sta = rms(this.staBuffer);
    const lta = rms(this.ltaBuffer);
    const ratio = lta > 0 ? sta / lta : 0;
    this.lastRatio = ratio;

    return this.runStateMachine(ratio, absSample, timestamp);
  }

  runStateMachine(ratio, amplitude, timestamp) {
    const { minConfirmingStations } = SEISMIC_CONFIG.correlation;
    const { triggerOn, triggerOff } = this;

    switch (this.state) {
      case PickerState.IDLE: {
        if (ratio >= triggerOn) {
          // Disparo STA/LTA: posible onda P
          this.state = PickerState.STA_LTA_TRIGGERED;
          this.stateChangeTime = timestamp;
          this.pPickTime = timestamp;
          this.pAmplitude = amplitude;
          return {
            state: this.state,
            ratio,
            amplitude,
            pPickTime: timestamp,
            type: 'P_PICK_CANDIDATE',
          };
        }
        return { state: this.state, ratio, amplitude };
      }

      case PickerState.STA_LTA_TRIGGERED: {
        // Confirmar P: el ratio debe mantenerse alto
        if (ratio >= triggerOff) {
          this.state = PickerState.P_DETECTED;
          this.stateChangeTime = timestamp;
          return {
            state: this.state,
            ratio,
            amplitude,
            pPickTime: this.pPickTime,
            type: 'P_DETECTED',
          };
        }
        // Falsa alarma
        this.state = PickerState.IDLE;
        this.pPickTime = null;
        return { state: this.state, ratio, amplitude };
      }

      case PickerState.P_DETECTED: {
        // Despues de P, buscar S (cae bajo triggerOff = evento terminado)
        if (ratio < triggerOff) {
          this.state = PickerState.EVENT_IN_PROGRESS;
          return { state: this.state, ratio, amplitude };
        }
        return { state: this.state, ratio, amplitude };
      }

      case PickerState.EVENT_IN_PROGRESS: {
        // Evento en curso, capturar peak
        return { state: this.state, ratio, amplitude };
      }

      case PickerState.COOLDOWN: {
        // Enfriamiento despues del evento
        if (ratio < triggerOff) {
          this.reset();
          return { state: PickerState.IDLE, ratio, amplitude };
        }
        return { state: this.state, ratio, amplitude };
      }

      default:
        this.state = PickerState.IDLE;
        return { state: this.state, ratio, amplitude };
    }
  }

  // Detectar S usando V/H ratio y aumento de energia horizontal
  // verticalSamples: array de valores Z
  // horizontalSamples: array de valores sqrt(N^2 + E^2)
  // timestamp: DateTime
  detectSFromVH(verticalAmp, horizontalAmp, timestamp) {
    if (!verticalAmp || !horizontalAmp) return null;

    const { vhRatioP, vhRatioS } = SEISMIC_CONFIG.phaseDiscrimination;
    const vhRatio = verticalAmp / horizontalAmp;

    // S solo si ya detectamos P y V/H < umbral de S
    if (this.state === PickerState.P_DETECTED ||
        this.state === PickerState.EVENT_IN_PROGRESS) {
      if (vhRatio < vhRatioS && horizontalAmp > this.pAmplitude * 1.5) {
        this.sPickTime = timestamp;
        this.sAmplitude = horizontalAmp;
        this.state = PickerState.S_DETECTED;
        return {
          state: this.state,
          sPickTime: timestamp,
          vhRatio,
          type: 'S_DETECTED',
        };
      }
    }

    return { state: this.state, vhRatio };
  }

  // Reset del detector
  reset() {
    this.state = PickerState.IDLE;
    this.stateChangeTime = null;
    this.pPickTime = null;
    this.sPickTime = null;
    this.pAmplitude = 0;
    this.sAmplitude = 0;
    this.peakAmplitude = 0;
    this.peakVelocity = 0;
    this.staBuffer = [];
    this.ltaBuffer = [];
    this.lastRatio = 0;
  }

  getState() { return this.state; }
  getPPickTime() { return this.pPickTime; }
  getSPickTime() { return this.sPickTime; }
  getPeakVelocity() { return this.peakVelocity; }
  getLastRatio() { return this.lastRatio; }
}

// Calcular energia horizontal = sqrt(N^2 + E^2) para un par de muestras
export function horizontalEnergy(nSample, eSample) {
  if (nSample == null || eSample == null) return 0;
  return Math.sqrt(nSample * nSample + eSample * eSample);
}

// Detectar pick P combinando STA/LTA del vertical con V/H ratio
export function isPPick(zRatio, vhRatio, prevVhRatio) {
  const { vhRatioP } = SEISMIC_CONFIG.phaseDiscrimination;
  const { minStaLtaForP } = SEISMIC_CONFIG.staLta;

  // P: STA/LTA alto + V/H alto (predominio vertical)
  if (zRatio >= minStaLtaForP && vhRatio > vhRatioP) {
    return true;
  }
  // Si no tenemos V/H, usar solo STA/LTA
  if (zRatio >= minStaLtaForP && vhRatio == null) {
    return true;
  }
  return false;
}

// Detectar pick S: despues de P, V/H bajo + energia horizontal alta
export function isSPick(vhRatio, horizontalAmp, pAmplitude) {
  const { vhRatioS } = SEISMIC_CONFIG.phaseDiscrimination;

  if (vhRatio == null) return false;
  // S: V/H bajo (predominio horizontal) + amplitud mayor que P
  return vhRatio < vhRatioS && horizontalAmp > pAmplitude * 1.5;
}