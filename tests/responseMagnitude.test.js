import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RawWindow } from '../services/rawWindow.js';
import { calculateResponseMagnitude } from '../services/responseMagnitude.js';
const { alertPayload } = createRequire(import.meta.url)('../functions/alertPayload.js');

test('raw-count ring spans packets, bounds memory and rejects discontinuities', () => {
  const buffer = new RawWindow(40);
  for (let second = 0; second < 80; second++) buffer.append(Array.from({length:40}, (_, i) => second*40+i), second*1000);
  const result = buffer.snapshot(55000);
  assert.equal(result.samples.length, 1761);
  assert.equal(result.samples[0], 1000);
  assert.equal(result.samples.at(-1), 2760);
  assert.equal(buffer.values.length, 2400);
  assert.equal(buffer.snapshot(75000), null);
  buffer.append([1, 2, 3], 90000);
  assert.equal(buffer.snapshot(55000), null);
});

const picks = [1, 1.1, 1.2].map((lat, i) => ({stationCode: String(i), lat, lon:0}));
const location = {latitude:0, longitude:0, depth:null};
test('disabled, missing data and worker failure never fall back to legacy ML', async () => {
  for (const options of [{enabled:false}, {enabled:true, waitMs:0},
    {enabled:true, waitMs:0, measure: async () => {throw new Error('offline');}}]) {
    const result = await calculateResponseMagnitude(picks, location,
      p => options.measure ? p : null, options);
    assert.equal(result.magnitude, null);
    assert.equal(result.magnitudeStatus, 'unknown');
  }
});
test('complete response measurements feed published equation and retain audit metadata', async () => {
  const result = await calculateResponseMagnitude(picks, location, p => p, {
    enabled:true, waitMs:0, measure: async windows => windows.map(p => ({stationCode:p.stationCode,
      pdCm:0.01, pWindowSeconds:4, responseCorrected:true, responseMethod:'ObsPy-evalresp-DISP-all-stages'})),
  });
  assert.equal(result.magnitudeType, 'M_Pd');
  assert.equal(result.responseMeasurements.length, 3);
});
test('concurrency is bounded to one worker with no queue', async () => {
  let release;
  const running = calculateResponseMagnitude(picks, location, p => p, {
    enabled:true, waitMs:0, measure: () => new Promise(resolve => { release = resolve; }),
  });
  const other = await calculateResponseMagnitude(picks, location, p => p, {enabled:true, waitMs:0});
  assert.equal(other.magnitudeReason, 'response_worker_busy');
  release([]); await running;
});
test('unknown magnitude/depth never become zero or blank-number FCM fields', () => {
  const payload = alertPayload({magnitude:null, depth:null, latitude:9, longitude:-79}, 'test', 100);
  assert.equal(payload.data.magnitude, undefined);
  assert.equal(payload.data.depth, undefined);
  assert.equal(payload.data.magnitudeStatus, 'unknown');
  assert.match(payload.notification.title, /no determinada/);
  assert.equal(alertPayload({magnitude:0}, 'test', 1).data.magnitude, '0');
});
