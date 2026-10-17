import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { EventArchive, collectEventWindows } from '../services/eventArchive.js';

const picks = [{ stationCode: 'CU-BCIP', channel: 'BHZ', pTime: '2026-10-16T05:23:02Z' }];
const getWindow = p => ({ ...p, sampleRate: 40, startTimeMs: 1000, samples: [-123, 0, 456] });

test('event samples round-trip losslessly outside Firestore metadata', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seismic-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new EventArchive({ directory });
  const result = await archive.capture('evt_test', picks, getWindow, { waitMs: 0 });
  assert.equal(result.status, 'stored');
  assert.equal(result.samples, undefined);
  const saved = JSON.parse(gunzipSync(await readFile(path.join(directory, result.file))));
  assert.deepEqual(saved.windows[0].samples, [-123, 0, 456]);
  assert.deepEqual(saved.picks, picks);
  assert.equal(saved.units, 'digital_counts');
});

test('missing windows, traversal, quota and disk failure are explicit and nonfatal', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seismic-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new EventArchive({ directory, maxBytes: 1 });
  assert.equal((await archive.capture('../bad', picks, getWindow)).reason, 'invalid_event_id');
  assert.equal((await archive.capture('missing', picks, () => null, { waitMs: 0 })).reason, 'missing_raw_windows');
  assert.equal((await archive.capture('full', picks, getWindow, { waitMs: 0 })).reason, 'archive_quota_exceeded');
  assert.deepEqual(await readdir(directory), []);
  const broken = new EventArchive({ directory: path.join(import.meta.filename, 'not-a-directory') });
  assert.equal((await broken.capture('broken', picks, getWindow, { waitMs: 0 })).status, 'failed');
});

test('captures are bounded and preserve partial station coverage', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seismic-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new EventArchive({ directory, maxConcurrent: 1 });
  const partial = [...picks, { stationCode: 'missing' }];
  const running = archive.capture('partial', partial, p => p.stationCode === 'missing' ? null : getWindow(p), { waitMs: 0 });
  assert.equal((await archive.capture('busy', picks, getWindow)).reason, 'archive_busy');
  const result = await running;
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingStations, ['missing']);
});

test('collector caches a captured window while waiting for other stations', async () => {
  let attempts = 0;
  const result = await collectEventWindows([...picks, { stationCode: 'later' }], p => {
    if (p.stationCode === 'later') return ++attempts === 1 ? null : getWindow(p);
    assert.equal(attempts, 0, 'captured station must not be read again');
    return getWindow(p);
  }, 500);
  assert.equal(result.windows.length, 2);
});
