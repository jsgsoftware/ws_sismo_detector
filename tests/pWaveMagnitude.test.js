import test from 'node:test';
import assert from 'node:assert/strict';
import { PWaveWindow, magnitudeFromPd, estimatePWaveMagnitude } from '../services/pWaveMagnitude.js';

test('published equation uses cm/km and rejects missing or out-of-domain values', () => {
  assert.ok(Math.abs(magnitudeFromPd(0.01, 100) - 5.69) < 1e-12);
  for (const pd of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(magnitudeFromPd(pd, 100), null);
  for (const distance of [null, 0, 251, Infinity]) assert.equal(magnitudeFromPd(1, distance), null);
});

function windowResult(rate, gap = false, confirm = true) {
  const window = new PWaveWindow(rate);
  for (let i = -rate * 2; i < 0; i++) window.push(0, i * 1000 / rate);
  let result;
  for (let i = 0; i <= rate * 4; i++) {
    const value = 1e-5 * Math.cos(2 * Math.PI * i / rate);
    const next = window.push(value, i * 1000 / rate + (gap && i > rate ? 100 : 0),
      i === 0 ? { stationCode: 'A' } : null, confirm && i === 1);
    if (i < rate * 4) assert.equal(next, null);
    if (next) result = next;
  }
  return result;
}

test('four-second window integrates velocity, low-passes and converts meters to cm', () => {
  for (const rate of [20, 40, 100]) {
    const result = windowResult(rate);
    assert.equal(result.pWindowSeconds, 4);
    assert.ok(result.pdCm > 0.0001 && result.pdCm < 0.0003);
  }
});
test('gaps and unconfirmed candidates cannot produce estimates', () => {
  assert.equal(windowResult(40, true), undefined);
  assert.equal(windowResult(40, false, false), undefined);
});
test('aggregation requires three unique usable stations, preserves unknown depth', () => {
  const location = {latitude: 0, longitude: 0, depth: null};
  const picks = [1, 1.1, 1.2].map((lat, i) => ({stationCode: String(i), lat, lon: 0, pdCm: 0.01, pWindowSeconds: 4,
    responseCorrected: true, responseMethod: 'ObsPy-evalresp-DISP-all-stages'}));
  const result = estimatePWaveMagnitude(picks, location);
  assert.equal(result.magnitudeType, 'M_Pd');
  assert.equal(result.preliminaryMagnitude, true);
  assert.equal(result.magnitudeUncertainty, null);
  assert.equal(location.depth, null);
  assert.equal(estimatePWaveMagnitude(picks.slice(0, 2), location), null);
  assert.equal(estimatePWaveMagnitude([picks[0], picks[0], picks[0]], location), null);
  assert.equal(estimatePWaveMagnitude(picks.map(p => ({...p, lat: 0.01})), location), null);
  assert.equal(estimatePWaveMagnitude(picks.map(p => ({...p, lat: 10})), location), null);
  assert.equal(estimatePWaveMagnitude(picks.map(p => ({...p, responseCorrected: false})), location), null);
});
