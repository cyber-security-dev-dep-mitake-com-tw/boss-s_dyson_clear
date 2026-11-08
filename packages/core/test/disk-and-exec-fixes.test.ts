import { describe, it, expect, afterEach } from 'vitest';
import { open, link, chmod } from 'node:fs/promises';
import path from 'node:path';
import { makeTmpDir, write, cleanup } from './helpers.js';
import { treeSize, allocatedSize } from '../src/scanners/walk.js';
import { collapseApfsVolumes, parseDiskutilPlist, type FsRow } from '../src/scanners/disk.js';
import { isMacProtectedCache, overlapsSpecificLocation } from '../src/scanners/junk.js';
import { GraphStore } from '../src/graph/store.js';
import { execPlan, describeExecError } from '../src/run.js';
import { prov } from '../src/graph/provenance.js';
import { verify } from '../src/verifier/verifier.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o755).catch(() => void 0);
    await cleanup(d);
  }
});

describe('treeSize — on-disk bytes (BUG: ~/Library reported 471 GB)', () => {
  it.skipIf(process.platform === 'win32')('counts a sparse file by allocated blocks, not apparent size', async () => {
    const root = await makeTmpDir();
    dirs.push(root);
    const fh = await open(path.join(root, 'sparse.img'), 'w');
    await fh.truncate(1024 ** 3); // 1 GiB apparent, ~0 allocated
    await fh.close();
    const size = await treeSize(root);
    expect(size).toBeLessThan(10 * 1024 * 1024);
  });

  it.skipIf(process.platform === 'win32')('counts a hard-linked inode once', async () => {
    const root = await makeTmpDir();
    dirs.push(root);
    const a = await write(root, 'a.bin', Buffer.alloc(64 * 1024, 1));
    await link(a, path.join(root, 'b.bin'));
    const one = allocatedSize({ size: 64 * 1024, blocks: 128 } as never);
    expect(await treeSize(root)).toBeLessThanOrEqual(one * 1.5);
  });
});

describe('collapseApfsVolumes — container-level usage (BUG: "/" showed 20.9 GB of 460 GB)', () => {
  const C = 494_384_795_648;
  const FREE = 34_132_836_352;
  const row = (fs: string, mount: string, used: number): FsRow => ({
    fs, type: 'APFS', size: C, used, available: FREE, use: (used / C) * 100, mount,
  });
  const rows: FsRow[] = [
    row('/dev/disk3s1s1', '/', 22_487_277_568),
    row('/dev/disk3s5', '/System/Volumes/Data', 408_872_165_376),
    row('/dev/disk3s6', '/System/Volumes/VM', 12_000_000_000),
    row('/dev/disk3s2', '/System/Volumes/Preboot', 11_800_000_000),
    { ...row('/dev/disk3s4', '/System/Volumes/Update', 960_000_000), type: 'HFS' }, // si mislabels APFS
    { ...row('/dev/disk3s1', '/System/Volumes/Update/mnt1', 22e9), type: 'HFS' },
    { fs: '/dev/disk1s2', type: 'HFS', size: 524288000, used: 2e7, available: 503975936, use: 4, mount: '/System/Volumes/xarts' },
    { fs: '/dev/disk2s1', type: 'HFS', size: 5368664064, used: 2e9, available: 3e9, use: 44, mount: '/System/Volumes/Update/SFR/mnt1' },
    { fs: '/dev/disk5s1', type: 'APFS', size: 2e9, used: 1e9, available: 1e9, use: 50, mount: '/Volumes/SweepDeck' },
    { fs: 'map auto_home', type: 'autofs', size: 0, used: 0, available: 0, use: 0, mount: '/System/Volumes/Data/home' },
  ];

  it('produces one boot row with used = size - available', () => {
    const out = collapseApfsVolumes(rows);
    const boot = out.filter((r) => r.fs === '/dev/disk3');
    expect(boot).toHaveLength(1);
    expect(boot[0].mount).toBe('/');
    expect(boot[0].used).toBe(C - FREE);
    expect(Math.round(boot[0].use)).toBe(93);
    expect(out[0].mount).toBe('/');
    expect(out.some((r) => r.mount.startsWith('/System/Volumes/'))).toBe(false);
    expect(out.some((r) => r.mount === '/Volumes/SweepDeck')).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('prefers exact diskutil container numbers for the boot container', () => {
    const out = collapseApfsVolumes(rows, { container: 'disk3', sizeBytes: C, freeBytes: 30e9, volumeName: 'Macintosh HD' });
    expect(out[0].available).toBe(30e9);
    expect(out[0].used).toBe(C - 30e9);
  });

  it('parses diskutil info -plist', () => {
    const xml = `<dict><key>APFSContainerFree</key>\n<integer>29947555840</integer><key>APFSContainerReference</key>
<string>disk3</string><key>APFSContainerSize</key><integer>494384795648</integer><key>VolumeName</key><string>Macintosh HD</string></dict>`;
    expect(parseDiskutilPlist(xml)).toEqual({
      container: 'disk3', sizeBytes: 494384795648, freeBytes: 29947555840, volumeName: 'Macintosh HD',
    });
    expect(parseDiskutilPlist('<dict/>')).toBeNull();
  });
});

describe('junk real-mode guards (BUG: EPERM on CloudKit / FamilyCircle)', () => {
  const caches = '/Users/u/Library/Caches';
  it('flags SIP/TCC-protected Apple caches', () => {
    for (const n of ['CloudKit', 'FamilyCircle', 'GeoServices', 'com.apple.homed', 'PassKit']) {
      expect(isMacProtectedCache(caches, n)).toBe(true);
    }
    for (const n of ['BraveSoftware', 'Homebrew', 'com.apple.Safari', 'io.sentry']) {
      expect(isMacProtectedCache(caches, n)).toBe(false);
    }
    expect(isMacProtectedCache('/Users/u/Library/Logs', 'CloudKit')).toBe(false);
  });

  it('drops broad entries that contain a more specific location', () => {
    const specific = [`${caches}/Google/Chrome`, `${caches}/com.apple.Safari`];
    expect(overlapsSpecificLocation(`${caches}/Google`, specific)).toBe(true);
    expect(overlapsSpecificLocation(`${caches}/com.apple.Safari`, specific)).toBe(true);
    expect(overlapsSpecificLocation(`${caches}/GoogleUpdater`, specific)).toBe(false);
  });
});

describe('execPlan — tasks complete cleanly (BUG: advise / EPERM failed receipts)', () => {
  async function setup() {
    const root = await makeTmpDir();
    dirs.push(root);
    const db = new GraphStore(':memory:');
    const runId = 'run-test';
    const p = prov('test@1', 'test.rule', {}, 0.95);
    const mk = (subjectKey: string, action: 'trash' | 'advise') =>
      db.addVerdict(
        { runId, category: 'junk', action, subjectKey, subjectType: 'File', label: path.basename(subjectKey), sizeBytes: 1, smartSelected: false, detail: {} },
        p,
      );
    db.createPlan('plan-test', runId, 0);
    return { root, db, mk };
  }

  it('never executes advise verdicts, even when approved', async () => {
    const { root, db, mk } = await setup();
    const f = await write(root, 'Caches/x.tmp', 'x');
    const advise = mk(f, 'advise');
    const trash = mk(await write(root, 'Caches/y.tmp', 'y'), 'trash');
    const res = await execPlan({ db, planId: 'plan-test', approveIds: [advise, trash], root });
    expect(res.failed).toBe(0);
    expect(res.executed).toBe(1);
    expect(res.receipts.map((r) => r.verdictId)).toEqual([trash]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'maps EPERM/EACCES to a friendly message and retires the verdict',
    async () => {
      const { root, db, mk } = await setup();
      const f = await write(root, 'Locked/z.tmp', 'z');
      await chmod(path.dirname(f), 0o555); // cannot rename out of a read-only dir
      const id = mk(f, 'trash');
      let res;
      try {
        res = await execPlan({ db, planId: 'plan-test', approveIds: [id], root });
      } finally {
        await chmod(path.dirname(f), 0o755);
      }
      expect(res.failed).toBe(1);
      expect(res.receipts[0].error).toMatch(/protected by macOS|skipped, nothing changed/);
      expect(db.getVerdict(id)?.status).toBe('rejected');
    },
  );

  it('describes ENOENT as already gone', () => {
    const e = Object.assign(new Error('x'), { code: 'ENOENT' });
    expect(describeExecError(e)).toMatch(/already gone/);
  });
});

describe('verifier — not-movable gate (BUG: EPERM receipts)', () => {
  it('rejects trash candidates the user cannot move', async () => {
    const p = prov('junk-scanner@1', 'mac.user-cache', { mtimeMs: 0 }, 0.95);
    const cand = (k: string) => ({
      category: 'junk' as const, action: 'trash' as const, subjectKey: k, subjectType: 'Directory' as const,
      label: k, sizeBytes: 1, smartSelected: true, provenance: p, detail: {},
    });
    const out = await verify([cand('/Users/u/Library/Caches/CloudKit'), cand('/Users/u/Library/Caches/ok')], {
      openFileCheck: async () => new Set(),
      unmovableCheck: async () => new Set(['/Users/u/Library/Caches/CloudKit']),
      home: undefined,
    } as never);
    expect(out[0].status).toBe('rejected');
    expect(out[0].verifierProvenance[0].rule).toBe('verify.not-movable');
    expect(out[1].status).toBe('proposed');
  });
});
