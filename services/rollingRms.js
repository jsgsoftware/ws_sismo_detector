// Fixed-memory RMS window. Rebase once per wrap to bound rounding drift;
// the full-window pass is amortized over capacity samples.
export class RollingRms {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid RMS capacity');
    this.values = new Float64Array(capacity);
    this.reset();
  }
  reset() {
    this.values.fill(0);
    this.index = 0;
    this.count = 0;
    this.sum = 0;
  }
  push(value) {
    const square = value * value;
    this.sum += square - this.values[this.index];
    this.values[this.index] = square;
    this.count = Math.min(this.count + 1, this.values.length);
    this.index = (this.index + 1) % this.values.length;
    if (this.index === 0) {
      this.sum = 0;
      for (const v of this.values) this.sum += v;
    }
  }
  get rms() { return this.count ? Math.sqrt(Math.max(0, this.sum) / this.count) : 0; }
}
