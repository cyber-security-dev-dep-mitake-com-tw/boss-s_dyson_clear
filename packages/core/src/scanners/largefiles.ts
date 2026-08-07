/**
 * Large-file scanner. Streams the walk (never buffers the whole tree), skips
 * symlinks, and swallows EACCES so the task keeps going.
 *
 * smartSelected = size >= 4x threshold, OR (size >= threshold AND atime older
 * than 180 days). Provenance rule 'large.threshold'.
 */
import os from 'node:os';
import path from 'node:path';
import { walk } from './walk.js';
import { prov } from '../graph/provenance.js';
import { emptyResult, type ScanContext, type ScannerResult } from './types.js';

const SCANNER = 'large-scanner@1';
const STALE_MS = 180 * 24 * 60 * 60 * 1000;

export const DEFAULT_LARGE_THRESHOLD = 100 * 1024 * 1024; // 100MB

export async function scanLargeFiles(ctx: ScanContext): Promise<ScannerResult> {
  const result = emptyResult();
  const root = ctx.root ?? os.homedir();
  const threshold = ctx.largeThresholdBytes;
  const now = Date.now();
  let progress = 0;

  for await (const entry of walk(root, { signal: ctx.signal, onError: () => void 0 })) {
    if (entry.dirent !== 'file') continue;
    result.scannedFiles++;
    if (++progress % 5000 === 0) {
      ctx.emit.emit('scan', 'scanner.large', 'task_progress', { done: progress });
    }
    const size = entry.stats.size;
    if (size < threshold) continue;

    const stale = now - entry.stats.atimeMs > STALE_MS;
    const smartSelected = size >= 4 * threshold || (size >= threshold && stale);
    const p = prov(
      SCANNER,
      'large.threshold',
      { path: entry.path, sizeBytes: size, thresholdBytes: threshold, atimeMs: entry.stats.atimeMs, stale },
      0.9,
    );
    const nodeId = ctx.db.upsertNode('File', entry.path, {
      path: entry.path,
      sizeBytes: size,
      mtimeMs: entry.stats.mtimeMs,
      atimeMs: entry.stats.atimeMs,
      ext: path.extname(entry.path).toLowerCase(),
    });
    ctx.db.addProvenance('node', nodeId, p);
    result.candidates.push({
      category: 'large',
      action: 'trash',
      subjectKey: entry.path,
      subjectType: 'File',
      label: `Large file: ${path.basename(entry.path)}`,
      sizeBytes: size,
      smartSelected,
      provenance: p,
      detail: { thresholdBytes: threshold, staleAtime: stale },
      nodeId,
    });
  }
  return result;
}
