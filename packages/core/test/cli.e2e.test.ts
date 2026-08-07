/**
 * End-to-end CLI tests against the built dist/cli.js (the Robot Framework
 * surface). `npm test` builds first via the pretest script.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, write, cleanup } from './helpers.js';
import type { ScanSummary, CleanPlan, ExecResult, Verdict } from '../src/contracts.js';

const execFileP = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(pkgRoot, 'dist', 'cli.js');

interface CliRun {
  code: number;
  stdout: string;
  lines: unknown[];
}

async function cli(...args: string[]): Promise<CliRun> {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, lines: parseLines(stdout) };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', lines: parseLines(e.stdout ?? '') };
  }
}

function parseLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l)); // throws on non-JSONL — that IS the assertion
}

describe('sweepdeck-core CLI (e2e on a temp sandbox)', () => {
  let base: string;
  let root: string;
  let dbFile: string;
  let summary: ScanSummary;
  let plan: CleanPlan;
  let junkVerdict: Verdict;
  let trashReceiptId: number;
  const junkFile = () => path.join(root, 'Caches', 'stale.dat');

  beforeAll(async () => {
    expect(existsSync(CLI), `dist/cli.js missing — run npm run build first (${CLI})`).toBe(true);
    base = await makeTmpDir('sweepdeck-e2e-');
    root = path.join(base, 'fixture');
    dbFile = path.join(base, 'graph.db');
    await write(root, 'Caches/stale.dat', 'stale-cache-contents');
    await write(root, 'tmp/scratch.log', 'log');
    await write(root, 'Documents/keep.log', 'precious');
    await write(root, 'Downloads/big.bin', Buffer.alloc(5000, 1));
    await write(root, 'Documents/photo.jpg', 'same-bytes-here');
    await write(root, 'Downloads/photo-copy.jpg', 'same-bytes-here');
  }, 30000);
  afterAll(() => cleanup(base));

  it('scan --json emits parseable JSONL ending in a summary, and creates a plan', async () => {
    const res = await cli(
      'scan', '--root', root, '--db', dbFile,
      '--categories', 'junk,large,duplicate', '--large-threshold', '1000', '--json',
    );
    expect(res.code).toBe(0);
    const events = res.lines as Array<{ type: string; [k: string]: unknown }>;
    expect(events.length).toBeGreaterThan(5);

    const last = events[events.length - 1] as { type: string; summary: ScanSummary };
    expect(last.type).toBe('summary');
    summary = last.summary;
    expect(summary.planId).toBeTruthy();
    expect(summary.candidateCount).toBe(4); // 2 junk + 1 large + 1 duplicate
    expect(summary.errors).toEqual([]);

    const types = events.map((e) => e.type);
    expect(types).toContain('run_started');
    expect(types).toContain('gate_waiting');
    expect(types).toContain('run_finished');
    // diamond ordering: all scan tasks precede verify, verify precedes merge
    const phases = events.filter((e) => e.type === 'phase_started').map((e) => (e as { phase?: string }).phase);
    expect(phases).toEqual(['scan', 'verify', 'merge']);
  }, 30000);

  it('refuses to scan a protected root with exit 2', async () => {
    const res = await cli('scan', '--root', '/System', '--db', dbFile, '--json');
    expect(res.code).toBe(2);
    expect((res.lines[0] as { error: string }).error).toMatch(/protected/);
  });

  it('plan --run returns the persisted CleanPlan', async () => {
    const res = await cli('plan', '--run', summary.runId, '--db', dbFile, '--json');
    expect(res.code).toBe(0);
    plan = res.lines[0] as CleanPlan;
    expect(plan.planId).toBe(summary.planId);
    expect(plan.verdicts.length).toBeGreaterThanOrEqual(4);
    junkVerdict = plan.verdicts.find((v) => v.subjectKey === junkFile())!;
    expect(junkVerdict).toBeDefined();
    expect(junkVerdict.status).toBe('proposed');
    expect(junkVerdict.action).toBe('trash');
    const protectedDoc = plan.verdicts.find((v) => v.subjectKey.endsWith('Documents/keep.log'));
    expect(protectedDoc).toBeUndefined(); // never even a candidate
  });

  it('exec WITHOUT --approve-ids refuses with exit 2 (the human gate)', async () => {
    const res = await cli('exec', '--plan', plan.planId, '--db', dbFile, '--json');
    expect(res.code).toBe(2);
    expect(res.lines[0]).toEqual({ error: 'approval required' });
  });

  it('exec --dry-run reports but touches nothing', async () => {
    const before = await readFile(junkFile(), 'utf8');
    const res = await cli(
      'exec', '--plan', plan.planId, '--approve-ids', String(junkVerdict.id),
      '--dry-run', '--root', root, '--db', dbFile, '--json',
    );
    expect(res.code).toBe(0);
    const result = res.lines[0] as ExecResult;
    expect(result.executed).toBe(1);
    expect(result.receipts[0].action).toBe('dry-run');
    expect(result.receipts[0].ok).toBe(true);
    expect(result.receipts[0].trashRef).toBeNull();
    await expect(readFile(junkFile(), 'utf8')).resolves.toBe(before); // untouched
  });

  it('exec with approval moves ONLY the approved file to quarantine + receipt', async () => {
    const res = await cli(
      'exec', '--plan', plan.planId, '--approve-ids', String(junkVerdict.id),
      '--root', root, '--db', dbFile, '--json',
    );
    expect(res.code).toBe(0);
    const result = res.lines[0] as ExecResult;
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
    const receipt = result.receipts[0];
    expect(receipt.ok).toBe(true);
    expect(receipt.trashRef).toBeTruthy();
    trashReceiptId = receipt.id;

    await expect(stat(junkFile())).rejects.toThrow(); // moved out
    await expect(readFile(receipt.trashRef!, 'utf8')).resolves.toBe('stale-cache-contents');
    // unapproved siblings untouched
    await expect(readFile(path.join(root, 'tmp/scratch.log'), 'utf8')).resolves.toBe('log');
    await expect(readFile(path.join(root, 'Downloads/big.bin'))).resolves.toBeDefined();
  });

  it('undo --receipt restores the file from quarantine', async () => {
    const res = await cli('undo', '--receipt', String(trashReceiptId), '--db', dbFile, '--json');
    expect(res.code).toBe(0);
    expect((res.lines[0] as { ok: boolean }).ok).toBe(true);
    await expect(readFile(junkFile(), 'utf8')).resolves.toBe('stale-cache-contents');
  });

  it('apps list enumerates sandbox fixtures', async () => {
    await write(root, 'Applications/Demo.app/Contents/Info.plist',
      JSON.stringify({ CFBundleIdentifier: 'com.demo.app', CFBundleName: 'Demo', CFBundleShortVersionString: '2.1' }));
    const res = await cli('apps', 'list', '--root', root, '--db', dbFile, '--json');
    expect(res.code).toBe(0);
    const apps = res.lines[0] as Array<{ key: string; name: string; version: string }>;
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ key: 'com.demo.app', name: 'Demo', version: '2.1' });
  });
});
