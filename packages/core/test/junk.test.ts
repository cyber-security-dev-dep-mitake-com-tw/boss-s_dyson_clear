import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphStore } from '../src/graph/store.js';
import { WorkflowEmitter } from '../src/workflow/events.js';
import { scanJunk } from '../src/scanners/junk.js';
import { makeTmpDir, write, cleanup } from './helpers.js';
import type { ScannerResult } from '../src/scanners/types.js';

describe('junk scanner (sandbox rules)', () => {
  let root: string;
  let db: GraphStore;
  let result: ScannerResult;

  beforeAll(async () => {
    root = await makeTmpDir();
    db = new GraphStore(':memory:');
    await write(root, 'Caches/chrome/gpu.bin', 'x');
    await write(root, 'tmp/scratch.dat', 'x');
    await write(root, 'Logs/app.log', 'x');
    await write(root, '.Trash/old.txt', 'x');
    await write(root, 'Downloads/loose.log', 'x'); // loose *.log
    await write(root, 'Downloads/junk.tmp', 'x'); // loose *.tmp
    await write(root, 'Documents/important.log', 'x'); // protected
    await write(root, 'Desktop/notes.tmp', 'x'); // protected
    await write(root, 'Pictures/Caches/fake.bin', 'x'); // protected (under Pictures)
    await write(root, 'Downloads/keep.txt', 'x'); // not junk
    const emit = new WorkflowEmitter('t', () => void 0);
    result = await scanJunk({ root, db, emit, largeThresholdBytes: 1 });
  });
  afterAll(async () => {
    db.close();
    await cleanup(root);
  });

  // subjectKey uses the host separator (walk emits native paths) — normalize
  // to '/' so these assertions hold on Windows too
  const norm = (p: string) => p.split(/[\\/]+/).join('/');
  const flagged = (suffix: string) => result.candidates.some((c) => norm(c.subjectKey).endsWith(suffix));

  it('flags files inside Caches/tmp/Logs/.Trash dirs', () => {
    expect(flagged('Caches/chrome/gpu.bin')).toBe(true);
    expect(flagged('tmp/scratch.dat')).toBe(true);
    expect(flagged('Logs/app.log')).toBe(true);
    expect(flagged('.Trash/old.txt')).toBe(true);
  });

  it('flags loose *.tmp and *.log anywhere', () => {
    expect(flagged('Downloads/loose.log')).toBe(true);
    expect(flagged('Downloads/junk.tmp')).toBe(true);
  });

  it('NEVER flags anything under Documents/Desktop/Pictures', () => {
    expect(flagged('Documents/important.log')).toBe(false);
    expect(flagged('Desktop/notes.tmp')).toBe(false);
    expect(flagged('Pictures/Caches/fake.bin')).toBe(false);
  });

  it('does not flag ordinary files', () => {
    expect(flagged('Downloads/keep.txt')).toBe(false);
  });

  it('uses sandbox.junk.<kind> rules with 0.9 / 0.7 confidence', () => {
    const cacheHit = result.candidates.find((c) => c.subjectKey.endsWith('gpu.bin'))!;
    expect(cacheHit.provenance.rule).toBe('sandbox.junk.caches');
    expect(cacheHit.provenance.confidence).toBe(0.9);
    const loose = result.candidates.find((c) => c.subjectKey.endsWith('loose.log'))!;
    expect(loose.provenance.rule).toBe('sandbox.junk.log');
    expect(loose.provenance.confidence).toBe(0.7);
  });

  it('upserts File nodes for every candidate', () => {
    for (const c of result.candidates) {
      expect(c.nodeId).toBeTypeOf('number');
      expect(db.getNode(c.nodeId!)?.key).toBe(c.subjectKey);
    }
  });
});
