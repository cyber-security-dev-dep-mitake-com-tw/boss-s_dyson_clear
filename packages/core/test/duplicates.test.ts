import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { GraphStore } from '../src/graph/store.js';
import { WorkflowEmitter } from '../src/workflow/events.js';
import { scanDuplicates, pickCanonical } from '../src/scanners/duplicates.js';
import { PARTIAL_CHUNK } from '../src/hashing/hash.js';
import { makeTmpDir, write, cleanup } from './helpers.js';
import type { ScannerResult } from '../src/scanners/types.js';

describe('duplicate scanner (entity resolution)', () => {
  let root: string;
  let db: GraphStore;
  let result: ScannerResult;

  beforeAll(async () => {
    root = await makeTmpDir();
    db = new GraphStore(':memory:');

    // identical trio — canonical should be the Documents copy
    const photo = Buffer.from('shared-photo-bytes-'.repeat(100));
    const canonical = await write(root, 'Documents/photo.jpg', photo);
    await write(root, 'Downloads/photo (1).jpg', photo);
    await write(root, 'Desktop-stuff/photo-copy.jpg', photo);
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await utimes(canonical, old, old); // also the oldest — unambiguous

    // partial-hash false-positive: same size+ext, identical head+tail 64KB,
    // DIFFERENT middle → full hash must keep them apart
    const size = PARTIAL_CHUNK * 3;
    const a = Buffer.alloc(size, 0);
    const b = Buffer.alloc(size, 0);
    a.fill(0xaa, PARTIAL_CHUNK + 100, PARTIAL_CHUNK + 200);
    b.fill(0xbb, PARTIAL_CHUNK + 100, PARTIAL_CHUNK + 200);
    await write(root, 'data/left.bin', a);
    await write(root, 'data/right.bin', b);

    // same size + ext, different content (blocked together, split by partial hash)
    await write(root, 'misc/one.txt', 'AAAAAAAA');
    await write(root, 'misc/two.txt', 'BBBBBBBB');

    // unique file
    await write(root, 'misc/unique.txt', 'only-me');

    const emit = new WorkflowEmitter('t', () => void 0);
    result = await scanDuplicates({ root, db, emit, largeThresholdBytes: 1 });
  });
  afterAll(async () => {
    db.close();
    await cleanup(root);
  });

  it('finds the identical files and proposes only NON-canonical members', () => {
    const dupPaths = result.candidates.map((c) => c.subjectKey).sort();
    expect(dupPaths).toEqual(
      [path.join(root, 'Desktop-stuff/photo-copy.jpg'), path.join(root, 'Downloads/photo (1).jpg')].sort(),
    );
    for (const c of result.candidates) {
      expect(c.smartSelected).toBe(true);
      expect(c.category).toBe('duplicate');
    }
  });

  it('canonical policy prefers the Documents copy; detail carries group info', () => {
    const c = result.candidates[0];
    expect(c.detail.canonicalPath).toBe(path.join(root, 'Documents/photo.jpg'));
    expect(c.detail.groupId).toBeTruthy();
    expect(c.detail.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates DUPLICATE_OF edges pointing at the canonical node', () => {
    const insight = db.query('duplicate-groups');
    expect(insight.rows).toHaveLength(1);
    expect(insight.rows[0].canonicalPath).toBe(path.join(root, 'Documents/photo.jpg'));
    expect(insight.rows[0].copies).toBe(2);
  });

  it('partial-hash collision candidates with different middles are NOT grouped', () => {
    const flagged = result.candidates.filter((c) => c.subjectKey.endsWith('.bin'));
    expect(flagged).toHaveLength(0);
  });

  it('same size+ext different content is NOT grouped', () => {
    const flagged = result.candidates.filter((c) => /(one|two)\.txt$/.test(c.subjectKey));
    expect(flagged).toHaveLength(0);
  });

  describe('pickCanonical merge policy', () => {
    const rec = (p: string, mtimeMs: number) => ({ path: p, size: 1, ext: '.x', mtimeMs });

    it('1. prefers Documents/Pictures/Desktop paths', () => {
      const winner = pickCanonical([rec('/u/Downloads/a.x', 1), rec('/u/Documents/a.x', 999)]);
      expect(winner.path).toBe('/u/Documents/a.x');
    });

    it('2. then oldest mtime', () => {
      const winner = pickCanonical([rec('/u/x/new.x', 200), rec('/u/y/old.x', 100)]);
      expect(winner.path).toBe('/u/y/old.x');
    });

    it('3. then shortest path', () => {
      const winner = pickCanonical([rec('/u/deeply/nested/a.x', 100), rec('/u/a.x', 100)]);
      expect(winner.path).toBe('/u/a.x');
    });
  });
});
