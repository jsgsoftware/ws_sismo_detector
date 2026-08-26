// Detector sismico con maquina de estados y analisis multi-eje
// Basado en deteccion de secuencia: ruido -> P -> S (no umbral simple)

// Umbrales (en g)
export const UMBRAL_RUIDO = 0.005;
export const UMBRAL_P = 0.012;
export const UMBRAL_S = 0.045;
export const UMBRAL_FUERTE = 0.080;

// Tiempos de confirmacion (ms)
const P_CONFIRM_WINDOW_MS = 3000;
const P_TO_S_MAX_WAIT_MS = 30000;
const S_CONFIRM_WINDOW_MS = 2000;
const COOLDOWN_MS = 60000;
const FALSE_ALARM_WINDOW_MS = 2000;

// Velocidades de onda
export const VP = 6.1;
export const VS = 3.5;

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
  }

  reset() {
    this.state = 'NORMAL';
    this.stateChangeTime = Date.now();
    this.pWaveTime = 0;
    this.sWaveTime = 0;
    this.energyHistory = [];
    this.preEventEnergy = 0;
    this.postEventEnergy = 0;
    this.postEventSampleCount = 0;
  }

  setState(newState) {
    if (this.state !== newState) {
      console.log(`[ESTADO] ${this.state} -> ${newState}`);
      this.state = newState;
      this.stateChangeTime = Date.now();
    }
  }

  // Procesar una lectura de 3 ejes (acelerometro) o eje unico (EarthScope)
  process(amp, axes) {
    const now = Date.now();
    const absAmp = Math.abs(amp);
    this.lastAmplitude = absAmp;

    let verticalEnergy = 0;
    let horizontalEnergy = 0;
    let vhRatio = 1;
    let waveType = 'unknown';

    if (axes) {
      verticalEnergy = axes.z * axes.z;
      horizontalEnergy = axes.x * axes.x + axes.y * axes.y;
      if (horizontalEnergy > 0) {
        vhRatio = verticalEnergy / horizontalEnergy;
        if (vhRatio > 1.3) waveType = 'P';
        else if (vhRatio < 0.77) waveType = 'S';
        else waveType = 'unknown';
      }
    } else {
      verticalEnergy = absAmp * absAmp;
      horizontalEnergy = 0;
      vhRatio = 1;
      waveType = 'unknown';
    }

    if (this.state === 'NORMAL' && absAmp < UMBRAL_RUIDO) {
      this.noiseBaseline = this.noiseBaseline * 0.95 + absAmp * 0.05;
      this.noiseSampleCount++;
    }

    const totalEnergy = verticalEnergy + horizontalEnergy;
    this.energyHistory.push(totalEnergy);
    if (this.energyHistory.length > this.maxEnergyHistory) {
      this.energyHistory.shift();
    }

    return this.runStateMachine(absAmp, totalEnergy, verticalEnergy, horizontalEnergy, vhRatio, waveType, now);
  }

  runStateMachine(amp, totalEnergy, verticalEnergy, horizontalEnergy, vhRatio, waveType, now) {
    const elapsed = now - this.stateChangeTime;

    switch (this.state) {
      case 'NORMAL': {
        if (amp >= UMBRAL_FUERTE) {
          this.preEventEnergy = this.getRecentEnergy(50);
          this.postEventEnergy = 0;
          this.postEventSampleCount = 0;
          this.setState('POSSIBLE_S');
          return this.makeResult('Posible S', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'Sacudida fuerte detectada', false, null);
        }
        if (amp >= UMBRAL_S) {
          this.preEventEnergy = this.getRecentEnergy(50);
          this.postEventEnergy = 0;
          this.postEventSampleCount = 0;
          this.setState('POSSIBLE_S');
          return this.makeResult('Posible S', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'Posible onda S detectada', false, null);
        }
        if (amp >= UMBRAL_P) {
          this.preEventEnergy = this.getRecentEnergy(50);
          this.postEventEnergy = 0;
          this.postEventSampleCount = 0;
          this.pWaveTime = now;
          this.setState('POSSIBLE_P');
          return this.makeResult('Posible P', '#f59e0b', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', 'Posible onda P - confirmando...', false, null);
        }
        if (amp >= UMBRAL_RUIDO) {
          return this.makeResult('Sospechoso', '#eab308', amp, verticalEnergy, horizontalEnergy, vhRatio, 'unknown', 'Movimiento sospechoso', false, null);
        }
        return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Sin actividad', false, null);
      }

      case 'POSSIBLE_P': {
        this.postEventEnergy += totalEnergy;
        this.postEventSampleCount++;

        if (amp < UMBRAL_RUIDO && elapsed > FALSE_ALARM_WINDOW_MS) {
          this.setState('NORMAL');
          return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Falsa alarma - vuelve a normal', false, null);
        }

        if (elapsed > P_CONFIRM_WINDOW_MS) {
          const avgPreEnergy = this.preEventEnergy / Math.max(1, 50);
          const avgPostEnergy = this.postEventEnergy / Math.max(1, this.postEventSampleCount);

          if (avgPostEnergy > avgPreEnergy * 3 && amp >= UMBRAL_P) {
            this.setState('CONFIRMED_P');
            return this.makeResult('P fuerte', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', 'ONDA P CONFIRMADA - la onda S puede llegar pronto', true, 'P');
          } else {
            this.setState('NORMAL');
            return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Falsa alarma - senal no sostenida', false, null);
          }
        }

        if (amp >= UMBRAL_S) {
          this.setState('CONFIRMED_P');
          return this.makeResult('P fuerte', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', 'ONDA P CONFIRMADA - transicion a S', true, 'P');
        }

        return this.makeResult('Posible P', '#f59e0b', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', `Confirmando P... (${elapsed}ms)`, false, null);
      }

      case 'CONFIRMED_P': {
        if (amp >= UMBRAL_FUERTE) {
          this.sWaveTime = now;
          this.setState('CONFIRMED_S');
          return this.makeResult('Sacudida fuerte', '#dc2626', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'ONDA S CONFIRMADA - SACUDIDA FUERTE', true, 'FUERTE');
        }
        if (amp >= UMBRAL_S) {
          this.sWaveTime = now;
          this.setState('POSSIBLE_S');
          return this.makeResult('Posible S', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'Posible onda S - confirmando...', false, null);
        }

        if (elapsed > P_TO_S_MAX_WAIT_MS) {
          this.setState('NORMAL');
          return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'No llego onda S - reset', false, null);
        }

        return this.makeResult('P fuerte', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', `Onda P confirmada - esperando S (${Math.round((P_TO_S_MAX_WAIT_MS - elapsed) / 1000)}s)`, false, null);
      }

      case 'POSSIBLE_S': {
        if (amp >= UMBRAL_FUERTE) {
          this.sWaveTime = now;
          this.setState('CONFIRMED_S');
          return this.makeResult('Sacudida fuerte', '#dc2626', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'ONDA S CONFIRMADA - SACUDIDA FUERTE', true, 'FUERTE');
        }

        if (elapsed > S_CONFIRM_WINDOW_MS) {
          if (amp >= UMBRAL_S) {
            this.sWaveTime = now;
            this.setState('CONFIRMED_S');
            return this.makeResult('Posible S', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'ONDA S CONFIRMADA', true, 'S');
          } else {
            this.setState('CONFIRMED_P');
            return this.makeResult('P fuerte', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'P', 'Falsa S - sigue en P', false, null);
          }
        }

        return this.makeResult('Posible S', '#ea580c', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', `Confirmando S... (${elapsed}ms)`, false, null);
      }

      case 'CONFIRMED_S': {
        this.setState('ALARM');
        return this.makeResult('Sacudida fuerte', '#dc2626', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', 'ALARMA SISMICA ACTIVA', true, 'S');
      }

      case 'ALARM': {
        if (elapsed > COOLDOWN_MS && amp < UMBRAL_RUIDO) {
          this.setState('NORMAL');
          return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Evento terminado - vuelta a normal', false, null);
        }
        return this.makeResult('Sacudida fuerte', '#dc2626', amp, verticalEnergy, horizontalEnergy, vhRatio, 'S', `Alarma activa (${Math.round(elapsed / 1000)}s)`, false, null);
      }

      case 'COOLDOWN': {
        if (elapsed > COOLDOWN_MS) {
          this.setState('NORMAL');
          return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Enfriamiento completado', false, null);
        }
        return this.makeResult('Normal', '#64748b', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', `Enfriamiento (${Math.round((COOLDOWN_MS - elapsed) / 1000)}s)`, false, null);
      }

      default:
        this.setState('NORMAL');
        return this.makeResult('Normal', '#22c55e', amp, verticalEnergy, horizontalEnergy, vhRatio, 'noise', 'Sin actividad', false, null);
    }
  }

  getRecentEnergy(count) {
    const start = Math.max(0, this.energyHistory.length - count);
    let sum = 0;
    for (let i = start; i < this.energyHistory.length; i++) {
      sum += this.energyHistory[i];
    }
    return sum;
  }

  makeResult(level, color, pga, verticalEnergy, horizontalEnergy, vhRatio, waveType, message, shouldAlert, alertType) {
    return {
      state: this.state,
      level,
      color,
      pga,
      verticalEnergy,
      horizontalEnergy,
      vhRatio,
      waveType,
      message,
      shouldAlert,
      alertType,
    };
  }

  getState() {
    return this.state;
  }
}

// ===== Formulas de distancia y atenuacion =====

export function distanceFromSPDelay(spDelaySeconds) {
  return 8.21 * spDelaySeconds;
}

export function earlyWarningTime(distanceKm) {
  return distanceKm * (1 / VS - 1 / VP);
}

export function arrivalTimes(distanceKm) {
  const pArrival = distanceKm / VP;
  const sArrival = distanceKm / VS;
  return { pArrival, sArrival, spGap: sArrival - pArrival };
}

export function pgaAtDistance(magnitude, distanceKm) {
  return Math.pow(10, -0.9 + 0.5 * magnitude - Math.log10(distanceKm + 10));
}

export function feltRadius(magnitude) {
  return Math.pow(10, 2.1 + 0.5 * magnitude) - 10;
}