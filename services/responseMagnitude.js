import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimatePWaveMagnitude } from './pWaveMagnitude.js';

let busy = false;
export const unknownMagnitude = reason => ({ magnitude: null, magnitudeType: null,
  magnitudeStatus: 'unknown', magnitudeReason: reason, magnitudeMethod: null,
  magnitudeUncertainty: null, preliminaryMagnitude: true, stationMagnitudes: [] });

export function measureWindows(windows) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.MAGNITUDE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [fileURLToPath(new URL('../scripts/measure_pd.py', import.meta.url))],
      { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } },
      (error, stdout) => {
        if (error) return reject(new Error('response_worker_failed'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('invalid_worker_output')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(windows));
  });
}

// Only one event at a time; no unbounded queue or per-packet deconvolution.
export async function calculateResponseMagnitude(picks, location, getWindow, {
  enabled = process.env.P_WAVE_MAGNITUDE_ENABLED === 'true', measure = measureWindows,
  waitMs = 20000,
} = {}) {
  if (!enabled) return unknownMagnitude('response_estimator_disabled');
  if (busy) return unknownMagnitude('response_worker_busy');
  busy = true;
  try {
    const selected = [...new Map(picks.map(p => [p.stationCode, p])).values()].slice(0, 8);
    const deadline = Date.now() + waitMs;
    let windows;
    do {
      windows = selected.map(getWindow).filter(Boolean);
      if (windows.length === selected.length || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (true);
    if (windows.length < 3) return unknownMagnitude('insufficient_raw_windows');
    const measurements = await measure(windows);
    const measured = selected.map(p => {
      const m = measurements.find(m => m.stationCode === p.stationCode && !m.error);
      return m ? { ...p, ...m } : p;
    });
    const result = estimatePWaveMagnitude(measured, location);
    return result ? { ...result, responseMeasurements: measurements } : {
      ...unknownMagnitude('insufficient_valid_pd_measurements'), responseMeasurements: measurements };
  } catch {
    return unknownMagnitude('response_worker_failed');
  } finally { busy = false; }
}
