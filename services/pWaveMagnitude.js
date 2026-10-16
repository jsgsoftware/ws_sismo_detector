import { epicentralDistanceKm } from './eventLocator.js';

// Experimental adapter, NOT a validated implementation of EPIC.
// Kuyuk & Allen (2013), doi:10.1002/2013GL058580, equation 2:
// M = 1.23 log10(Pd [cm]) + 1.38 log10(epicentral distance [km]) + 5.39.
export function magnitudeFromPd(pdCm, distanceKm) {
  if (!Number.isFinite(pdCm) || pdCm <= 0 || !Number.isFinite(distanceKm)
    || distanceKm <= 0 || distanceKm > 250) return null;
  return 1.23 * Math.log10(pdCm) + 1.38 * Math.log10(distanceKm) + 5.39;
}

// Constant-memory four-second velocity window. Pre-trigger mean removes baseline.
// Trapezoidal integration followed by a causal 2-pole Butterworth low-pass at 3 Hz.
// Instrument sensitivity is NOT a full frequency-response deconvolution.
export class PWaveWindow {
  constructor(rate) {
    if (!Number.isFinite(rate) || rate < 20 || rate > 100) throw new RangeError('Invalid sample rate');
    this.rate = rate;
    this.baseline = new Float64Array(Math.round(rate * 2));
    this.position = 0; this.count = 0; this.sum = 0; this.pending = null;
    const k = Math.tan(Math.PI * 3 / rate), norm = 1 / (1 + Math.SQRT2 * k + k * k);
    this.b0 = k * k * norm; this.b1 = 2 * this.b0; this.b2 = this.b0;
    this.a1 = 2 * (k * k - 1) * norm;
    this.a2 = (1 - Math.SQRT2 * k + k * k) * norm;
  }
  push(velocity, timeMs, candidate = null, confirmed = false, cancel = false) {
    if (!Number.isFinite(velocity) || !Number.isFinite(timeMs)) { this.pending = null; this.count = 0; return null; }
    if (cancel) this.pending = null;
    if (candidate && this.count >= this.baseline.length) {
      this.pending = { pick: candidate, baseline: this.sum / this.baseline.length,
        start: timeMs, last: timeMs, previous: velocity - this.sum / this.baseline.length,
        displacement: 0, x1: 0, x2: 0, y1: 0, y2: 0, pdCm: 0, confirmed: false };
    }
    const p = this.pending;
    let result = null;
    if (p) {
      p.confirmed ||= confirmed;
      const dt = (timeMs - p.last) / 1000;
      if (dt < 0 || dt > 1.5 / this.rate) this.pending = null;
      else if (dt > 0) {
        const current = velocity - p.baseline;
        p.displacement += (p.previous + current) * dt / 2;
        const y = this.b0 * p.displacement + this.b1 * p.x1 + this.b2 * p.x2
          - this.a1 * p.y1 - this.a2 * p.y2;
        p.x2 = p.x1; p.x1 = p.displacement; p.y2 = p.y1; p.y1 = y;
        p.pdCm = Math.max(p.pdCm, Math.abs(y) * 100);
        p.previous = current; p.last = timeMs;
        if (timeMs - p.start >= 4000 - 0.01) {
          if (p.confirmed) result = { ...p.pick, pdCm: p.pdCm, pWindowSeconds: 4 };
          this.pending = null;
        }
      }
    }
    this.sum += velocity - this.baseline[this.position];
    this.baseline[this.position] = velocity;
    this.position = (this.position + 1) % this.baseline.length;
    this.count++;
    if (this.position === 0) this.sum = this.baseline.reduce((a, b) => a + b, 0);
    return result;
  }
}

export function estimatePWaveMagnitude(picks, location) {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
    || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) return null;
  const stations = new Map();
  for (const p of picks) {
    if (!p.stationCode || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
      || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || p.pWindowSeconds !== 4) continue;
    const distanceKm = epicentralDistanceKm(location.latitude, location.longitude, p.lat, p.lon);
    // Reject windows likely to include S. Conservative policy using this server's
    // simplified surface travel times, not a measured S arrival or depth estimate.
    if (distanceKm * (1 / 3.5 - 1 / 6.1) <= 4) continue;
    const magnitude = magnitudeFromPd(p.pdCm, distanceKm);
    if (magnitude != null) stations.set(p.stationCode, { stationCode: p.stationCode, magnitude, pdCm: p.pdCm, distanceKm });
  }
  if (stations.size < 3) return null;
  const stationMagnitudes = [...stations.values()];
  const sorted = stationMagnitudes.map(s => s.magnitude).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const magnitude = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { magnitude, magnitudeType: 'M_Pd', magnitudeStatus: 'experimental',
    magnitudeMethod: 'KuyukAllen2013-Pd-approximate-processing', preliminaryMagnitude: true,
    stationMagnitudes, magnitudeUncertainty: null, pWindowSeconds: 4 };
}
