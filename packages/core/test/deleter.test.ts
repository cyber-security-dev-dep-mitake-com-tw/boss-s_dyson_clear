import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { symlink, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Deleter, ProtectedPathError } from '../src/executor/deleter.js';
import { GraphStore } from '../src/graph/store.js';
import { writeReceipt, undoReceipt } from '../src/executor/receipts.js';
import { makeTmpDir, write, cleanup } from './helpers.js';

describe('Deleter', () => {
  let base: string; // temp area
  let sandbox: string; // the only allowRoot
  let outside: string; // sibling dir NOT in allowRoots
  let quarantine: string;
  let deleter: Deleter;

  beforeEach(async () => {
    base = await makeTmpDir();
    sandbox = path.join(base, 'sandbox');
    outside = path.join(base, 'outside');
    quarantine = path.join(base, 'quarantine');
    await write(sandbox, 'Caches/junk.dat', 'junk-bytes');
    await write(outside, 'precious.txt', 'do not touch');
    deleter = new Deleter({ allowRoots: [sandbox], quarantineDir: quarantine });
  });
  afterEach(() => cleanup(base));

  it('throws ProtectedPathError for a path outside allowRoots — STRUCTURAL, no flags', async () => {
    await expect(deleter.trash(path.join(outside, 'precious.txt'))).rejects.toThrow(ProtectedPathError);
    await expect(readFile(path.join(outside, 'precious.txt'), 'utf8')).resolves.toBe('do not touch');
  });

  it('throws ProtectedPathError for a symlink escaping the allowlist', async () => {
    const link = path.join(sandbox, 'sneaky-link');
    await symlink(path.join(outside, 'precious.txt'), link);
    await expect(deleter.trash(link)).rejects.toThrow(ProtectedPathError);
    await expect(readFile(path.join(outside, 'precious.txt'), 'utf8')).resolves.toBe('do not touch');
  });

  it('re-checks the hard-deny list even when allowRoots would permit it', async () => {
    const wideOpen = new Deleter({ allowRoots: ['/'], quarantineDir: quarantine });
    await expect(wideOpen.trash('/System/Library')).rejects.toThrow(ProtectedPathError);
    await expect(wideOpen.trash('/usr/bin')).rejects.toThrow(ProtectedPathError);
  });

  it('refuses to trash items already inside quarantine', async () => {
    const q = new Deleter({ allowRoots: [base], quarantineDir: quarantine });
    await write(quarantine, 'tag/x.dat', 'x');
    await expect(q.trash(path.join(quarantine, 'tag/x.dat'))).rejects.toThrow(ProtectedPathError);
  });

  it('moves the target into quarantine and reports bytes', async () => {
    const target = path.join(sandbox, 'Caches/junk.dat');
    const res = await deleter.trash(target);
    expect(res.bytesFreed).toBe(10);
    expect(res.trashRef.startsWith(quarantine)).toBe(true);
    await expect(stat(target)).rejects.toThrow(); // gone from original location
    await expect(readFile(res.trashRef, 'utf8')).resolves.toBe('junk-bytes'); // intact in quarantine
  });

  it('quarantine move + undo restores the original file', async () => {
    const db = new GraphStore(':memory:');
    const target = path.join(sandbox, 'Caches/junk.dat');
    const res = await deleter.trash(target);
    const receipt = writeReceipt(db, {
      verdictId: null,
      action: 'trash',
      path: target,
      trashRef: res.trashRef,
      bytesFreed: res.bytesFreed,
      ok: true,
      error: null,
    });

    const undo = await undoReceipt(db, receipt.id);
    expect(undo.ok).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('junk-bytes');

    // an undo receipt is recorded; a second undo refuses (target exists again / ref gone)
    const receipts = db.listReceipts();
    expect(receipts.some((r) => r.action === 'undo' && r.ok)).toBe(true);
    const again = await undoReceipt(db, receipt.id);
    expect(again.ok).toBe(false);
    db.close();
  });

  it('undo refuses when the original path is occupied', async () => {
    const db = new GraphStore(':memory:');
    const target = path.join(sandbox, 'Caches/junk.dat');
    const res = await deleter.trash(target);
    const receipt = writeReceipt(db, {
      verdictId: null, action: 'trash', path: target, trashRef: res.trashRef,
      bytesFreed: res.bytesFreed, ok: true, error: null,
    });
    await write(sandbox, 'Caches/junk.dat', 'NEW CONTENT');
    const undo = await undoReceipt(db, receipt.id);
    expect(undo.ok).toBe(false);
    await expect(readFile(target, 'utf8')).resolves.toBe('NEW CONTENT');
    db.close();
  });
});
