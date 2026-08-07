/**
 * ipc.ts — ipcMain.handle for every channel in the frozen IPC map.
 *
 * Every payload is structurally validated by hand (no external validator).
 * The renderer NEVER sends filesystem paths for deletion — only verdict ids,
 * receipt ids, pids, app keys and plan/run ids. Anything else is rejected.
 */
import { ipcMain } from 'electron';
import { IPC, type GraphQueryId, type ScanCategory } from '@contracts';
import type { Engine } from './engine';

const SCAN_CATEGORIES: readonly ScanCategory[] = [
  'junk',
  'large',
  'duplicate',
  'apps',
  'processes',
  'disk',
];

const GRAPH_QUERY_IDS: readonly GraphQueryId[] = [
  'app-cache-aggregation',
  'duplicate-groups',
  'orphaned-files',
  'top-space-owners',
];

function bad(channel: string, why: string): never {
  throw new Error(`Invalid payload for ${channel}: ${why}`);
}

function asRecord(channel: string, p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) bad(channel, 'expected an object');
  return p as Record<string, unknown>;
}

function nonEmptyString(channel: string, v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) bad(channel, `${field} must be a non-empty string`);
  return v as string;
}

function positiveInt(channel: string, v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)
    bad(channel, `${field} must be a positive integer`);
  return v as number;
}

export function registerIpc(engine: Engine): void {
  ipcMain.handle(IPC.scanStart, async (_e, payload: unknown) => {
    const p = asRecord(IPC.scanStart, payload);
    if (!Array.isArray(p.categories) || p.categories.length === 0)
      bad(IPC.scanStart, 'categories must be a non-empty array');
    for (const c of p.categories) {
      if (!SCAN_CATEGORIES.includes(c as ScanCategory))
        bad(IPC.scanStart, `unknown scan category "${String(c)}"`);
    }
    let roots: string[] | undefined;
    if (p.roots !== undefined) {
      if (!Array.isArray(p.roots)) bad(IPC.scanStart, 'roots must be an array of strings');
      roots = p.roots.map((r, i) => nonEmptyString(IPC.scanStart, r, `roots[${i}]`));
    }
    return engine.scanStart(p.categories as ScanCategory[], roots);
  });

  ipcMain.handle(IPC.scanCancel, async (_e, payload: unknown) => {
    const p = asRecord(IPC.scanCancel, payload);
    return engine.scanCancel(nonEmptyString(IPC.scanCancel, p.runId, 'runId'));
  });

  ipcMain.handle(IPC.planGet, async (_e, payload: unknown) => {
    const p = asRecord(IPC.planGet, payload);
    return engine.planGet(nonEmptyString(IPC.planGet, p.runId, 'runId'));
  });

  // THE HUMAN GATE — only verdict ids cross this boundary, never paths.
  ipcMain.handle(IPC.planApprove, async (_e, payload: unknown) => {
    const p = asRecord(IPC.planApprove, payload);
    const planId = nonEmptyString(IPC.planApprove, p.planId, 'planId');
    if (!Array.isArray(p.verdictIds) || p.verdictIds.length === 0)
      bad(IPC.planApprove, 'verdictIds must be a non-empty array (absence of approvals is a refusal)');
    const verdictIds = p.verdictIds.map((v, i) =>
      positiveInt(IPC.planApprove, v, `verdictIds[${i}]`),
    );
    return engine.planApprove(planId, verdictIds);
  });

  ipcMain.handle(IPC.appsList, async () => engine.appsList());

  ipcMain.handle(IPC.appsUninstall, async (_e, payload: unknown) => {
    const p = asRecord(IPC.appsUninstall, payload);
    return engine.appsUninstall(nonEmptyString(IPC.appsUninstall, p.key, 'key'));
  });

  ipcMain.handle(IPC.procsList, async () => engine.procsList());

  ipcMain.handle(IPC.procsKill, async (_e, payload: unknown) => {
    const p = asRecord(IPC.procsKill, payload);
    return engine.procsKill(positiveInt(IPC.procsKill, p.pid, 'pid'));
  });

  ipcMain.handle(IPC.diskStatus, async () => engine.diskStatus());

  // v1 is ADVISORY: SweepDeck never executes elevated commands. We return the
  // command + instructions; consent is still structurally required.
  ipcMain.handle(IPC.diskTrim, async (_e, payload: unknown) => {
    const p = asRecord(IPC.diskTrim, payload);
    if (p.consent !== true) bad(IPC.diskTrim, 'consent must be exactly true');

    let advice: { supported: boolean; message: string; command: string | null } | null = null;
    try {
      advice = (await engine.diskStatus()).trimAdvice;
    } catch (err) {
      if (process.platform === 'darwin') {
        return { ok: false, error: 'macOS APFS trims automatically; no action needed' };
      }
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }

    if (process.platform === 'darwin' && !advice?.command) {
      return { ok: false, error: 'macOS APFS trims automatically; no action needed' };
    }
    if (!advice?.supported) {
      return { ok: false, error: advice?.message ?? 'TRIM is not supported on this system' };
    }
    if (!advice.command) {
      return { ok: false, error: advice.message || 'No TRIM command applicable for this system' };
    }
    return {
      ok: false,
      output: advice.command,
      error: `SweepDeck v1 does not execute elevated commands. To run TRIM manually, execute: ${advice.command}`,
    };
  });

  ipcMain.handle(IPC.graphQuery, async (_e, payload: unknown) => {
    const p = asRecord(IPC.graphQuery, payload);
    const queryId = nonEmptyString(IPC.graphQuery, p.queryId, 'queryId') as GraphQueryId;
    if (!GRAPH_QUERY_IDS.includes(queryId))
      bad(IPC.graphQuery, `unknown queryId "${queryId}" (canned queries only — never raw SQL)`);
    let params: Record<string, unknown> | undefined;
    if (p.params !== undefined) {
      if (p.params === null || typeof p.params !== 'object' || Array.isArray(p.params))
        bad(IPC.graphQuery, 'params must be a plain object');
      params = p.params as Record<string, unknown>;
    }
    return engine.graphQuery(queryId, params);
  });

  ipcMain.handle(IPC.receiptsList, async () => engine.receiptsList());

  ipcMain.handle(IPC.receiptsUndo, async (_e, payload: unknown) => {
    const p = asRecord(IPC.receiptsUndo, payload);
    return engine.receiptsUndo(positiveInt(IPC.receiptsUndo, p.receiptId, 'receiptId'));
  });
}
