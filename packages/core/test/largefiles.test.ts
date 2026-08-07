import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { utimes } from 'node:fs/promises';
import { GraphStore } from '../src/graph/store.js';
import { WorkflowEmitter } from '../src/workflow/events.js';
import { scanLargeFiles } from '../src/scanners/largefiles.js';
import { makeTmpDir, write, cleanup } from './helpers.js';
import type { ScannerResult } from '../src/scanners/types.js';

const THRESHOLD = 1000;

describe('large files scanner', () => {
  let root: string;
  let db: GraphStore;
  let result: ScannerResult;

  beforeAll(async () => {
    root = await makeTmpDir();
    db = new GraphStore(':memory:');
    await write(root, 'small.bin', Buffer.alloc(THRESHOLD - 1)); // below threshold
    await write(root, 'at-threshold.bin', Buffer.alloc(THRESHOLD)); // >= threshold, fresh atime
    await write(root, 'huge.bin', Buffer.alloc(4 * THRESHOLD)); // >= 4x → smart
    const stale = await write(root, 'stale.bin', Buffer.alloc(THRESHOLD + 5));
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000); // atime > 180d
    await utimes(stale, old, old);
    const emit = new WorkflowEmitter('t', () => void 0);
    result = await scanLargeFiles({ root, db, emit, largeThresholdBytes: THRESHOLD });
  });
  afterAll(async () => {
    db.close();
    await cleanup(root);
  });

  const byName = (n: string) => result.candidates.find((c) => c.subjectKey.endsWith(n));

  it('only files >= threshold become candidates', () => {
    expect(byName('small.bin')).toBeUndefined();
    expect(byName('at-threshold.bin')).toBeDefined();
    expect(byName('huge.bin')).toBeDefined();
    expect(byName('stale.bin')).toBeDefined();
    expect(result.scannedFiles).toBe(4);
  });

  it('smartSelected: >= 4x threshold', () => {
    expect(byName('huge.bin')!.smartSelected).toBe(true);
  });

  it('smartSelected: >= threshold AND atime older than 180d', () => {
    expect(byName('stale.bin')!.smartSelected).toBe(true);
  });

  it('NOT smartSelected: over threshold but fresh atime and < 4x', () => {
    expect(byName('at-threshold.bin')!.smartSelected).toBe(false);
  });

  it("carries provenance rule 'large.threshold'", () => {
    expect(byName('huge.bin')!.provenance.rule).toBe('large.threshold');
  });
});
