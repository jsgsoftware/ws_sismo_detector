import { mkdir, readdir, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

// Capture immediately: magnitude processing can outlive the in-memory ring.
export async function collectEventWindows(picks, getWindow, waitMs = 20000) {
  const selected = [...new Map(picks.map(p => [p.stationCode, p])).values()];
  const captured = new Map();
  const deadline = Date.now() + waitMs;
  do {
    for (const pick of selected) {
      if (captured.has(pick.stationCode)) continue;
      const window = getWindow(pick);
      if (window) captured.set(pick.stationCode, window);
    }
    if (captured.size === selected.length || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (true);
  return { windows: [...captured.values()],
    missingStations: selected.filter(p => !captured.has(p.stationCode)).map(p => p.stationCode) };
}

export class EventArchive {
  constructor({ directory = process.env.EVENT_ARCHIVE_DIR || './data/event-waveforms',
    maxBytes = Number(process.env.EVENT_ARCHIVE_MAX_BYTES || 1073741824), maxConcurrent = 2 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid archive size limit');
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.writes = Promise.resolve();
  }

  async capture(eventId, picks, getWindow, options = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) return { status: 'failed', reason: 'invalid_event_id' };
    if (this.active >= this.maxConcurrent) return { status: 'unavailable', reason: 'archive_busy' };
    this.active++;
    try {
      const captured = await collectEventWindows(picks, getWindow, options.waitMs);
      if (!captured.windows.length) return { status: 'unavailable', reason: 'missing_raw_windows',
        missingStations: captured.missingStations };
      const buffer = await compress(JSON.stringify({ schemaVersion: 1, eventId,
        units: 'digital_counts', format: 'decoded-waveforms-json', prePSeconds: 30, postPSeconds: 14,
        createdAt: new Date().toISOString(), picks, ...captured }));
      // Serialize quota checks and writes, including across concurrent captures.
      const saving = this.writes.then(async () => {
        await mkdir(this.directory, { recursive: true });
        let used = 0;
        for (const file of await readdir(this.directory, { withFileTypes: true })) {
          if (file.isFile()) used += (await stat(path.join(this.directory, file.name))).size;
        }
        if (used + buffer.length > this.maxBytes) return { status: 'unavailable', reason: 'archive_quota_exceeded' };
        const file = `${eventId}.json.gz`;
        const temporary = path.join(this.directory, `${file}.pending`);
        await writeFile(temporary, buffer, { flag: 'wx' });
        await rename(temporary, path.join(this.directory, file));
        return { status: captured.missingStations.length ? 'partial' : 'stored', storage: 'server-local',
          file, bytes: buffer.length, stationsStored: captured.windows.length,
          missingStations: captured.missingStations, units: 'digital_counts', prePSeconds: 30, postPSeconds: 14 };
      });
      this.writes = saving.catch(() => {});
      return await saving;
    } catch {
      return { status: 'failed', reason: 'archive_capture_or_write_failed' };
    } finally { this.active--; }
  }
}
