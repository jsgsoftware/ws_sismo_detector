// Bounded raw-count ring, independent of the detection band-pass and sensitivity.
export class RawWindow {
  constructor(rate, seconds = 60) {
    this.rate = rate;
    this.values = new Float64Array(Math.ceil(rate * seconds));
    this.count = 0; this.position = 0; this.last = null;
  }
  append(samples, startMs) {
    const dt = 1000 / this.rate;
    if (this.last != null && Math.abs(startMs - this.last - dt) > dt * 0.25) this.count = 0;
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) { this.count = 0; continue; }
      this.values[this.position] = samples[i];
      this.position = (this.position + 1) % this.values.length;
      this.count = Math.min(this.count + 1, this.values.length);
    }
    this.last = startMs + (samples.length - 1) * dt;
  }
  snapshot(pTimeMs) {
    const dt = 1000 / this.rate;
    const first = this.last - (this.count - 1) * dt;
    const start = pTimeMs - 30000, end = pTimeMs + 14000;
    if (!this.count || first > start + dt * 0.25 || this.last < end - dt * 0.25) return null;
    const offset = Math.round((start - first) / dt);
    const length = Math.round(44 * this.rate) + 1;
    if (offset < 0 || offset + length > this.count) return null;
    const oldest = (this.position - this.count + this.values.length) % this.values.length;
    return { startTimeMs: first + offset * dt, pTimeMs, sampleRate: this.rate,
      samples: Array.from({ length }, (_, i) => this.values[(oldest + offset + i) % this.values.length]) };
  }
}
