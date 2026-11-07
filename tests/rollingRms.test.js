import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { RollingRms } from '../services/rollingRms.js';
import { StaLtaDetector } from '../services/phasePicker.js';

class ReferenceWindow {
  constructor(capacity) { this.capacity = capacity; this.reset(); }
  reset() { this.values = []; }
  push(v) {
    this.values.push(v);
    if (this.values.length > this.capacity) this.values.shift();
  }
  get count() { return this.values.length; }
  get rms() {
    let sum = 0;
    for (const v of this.values) sum += v * v;
    return this.count ? Math.sqrt(sum / this.count) : 0;
  }
}

test('rolling RMS matches full-window reference across wraps, silence and resets', () => {
  for (const capacity of [1, 20, 40, 800, 2000]) {
    const actual = new RollingRms(capacity), expected = new ReferenceWindow(capacity);
    for (let i = 0; i < 12000; i++) {
      const value = i < 6000 ? Math.sin(i * 0.37) * 1e-5 : 0;
      actual.push(value); expected.push(value);
      assert.equal(actual.count, expected.count);
      assert.ok(Math.abs(actual.rms - expected.rms) < 1e-12);
      if (i === 4000) { actual.reset(); expected.reset(); }
    }
    assert.equal(actual.rms, 0);
    assert.equal(actual.values.length, capacity);
  }
});

test('optimized detector retains reference states and pick timestamps', () => {
  for (const rate of [20, 40, 100]) {
    const actual = new StaLtaDetector('BHZ', rate);
    const expected = new StaLtaDetector('BHZ', rate);
    expected.staBuffer = new ReferenceWindow(expected.staWindow);
    expected.ltaBuffer = new ReferenceWindow(expected.ltaWindow);
    let picks = 0;
    for (let i = 0; i < rate * 150; i++) {
      const seconds = i / rate;
      const burst = (seconds > 25 && seconds < 29) || (seconds > 100 && seconds < 104);
      const sample = (burst ? 1e-4 : 1e-8) * Math.sin(i * 0.7);
      const timestamp = DateTime.fromMillis(1700000000000 + i * 1000 / rate);
      const a = actual.process(sample, timestamp), b = expected.process(sample, timestamp);
      assert.equal(a.state, b.state);
      assert.equal(a.type, b.type);
      assert.equal(a.pPickTime?.toMillis(), b.pPickTime?.toMillis());
      assert.ok(Math.abs(a.ratio - b.ratio) < 1e-7);
      if (a.type === 'P_DETECTED') picks++;
    }
    assert.ok(picks >= 2, 'detector must rearm for the second burst');
  }
});

test('RMS benchmark (local calculation only, not whole-server throughput)', () => {
  const samples = Float64Array.from({length: 100000}, (_, i) => Math.sin(i * 0.7) * 1e-5);
  const measure = Window => {
    const window = new Window(2000);
    const start = performance.now();
    let checksum = 0;
    for (const sample of samples) { window.push(sample); checksum += window.rms; }
    return { ms: performance.now() - start, checksum };
  };
  measure(RollingRms); // warm up
  const reference = measure(ReferenceWindow), optimized = measure(RollingRms);
  assert.ok(Math.abs(reference.checksum - optimized.checksum) < 1e-8);
  console.log(`RMS benchmark: reference=${reference.ms.toFixed(1)}ms optimized=${optimized.ms.toFixed(1)}ms`);
});
