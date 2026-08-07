/**
 * Uninstaller.
 * darwin: trash the .app bundle (Deleter with allowRoots /Applications +
 *         ~/Applications) then trash each OWNED_BY path (allowRoot ~/Library).
 * win32:  spawn the UninstallString via execFile after parsing — supports
 *         `MsiExec.exe /X{guid}` and quoted exe paths; NEVER shell:true.
 * sandbox: operates on fixture .app dirs under the sandbox root.
 */
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Deleter, defaultQuarantineDir } from './deleter.js';
import { writeReceipt } from './receipts.js';
import type { GraphStore } from '../graph/store.js';
import type { Receipt } from '../contracts.js';

const execFileP = promisify(execFile);

export interface UninstallResult {
  ok: boolean;
  receipts: Receipt[];
  error?: string;
  /** Orphaned owned paths offered for follow-up cleanup (win32). */
  orphanCandidates?: string[];
}

/** Parse an UninstallString into {cmd, args} without ever using a shell. Exported for tests. */
export function parseUninstallString(s: string): { cmd: string; args: string[] } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end === -1) return null;
    const cmd = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1).trim();
    return { cmd, args: rest ? rest.split(/\s+/) : [] };
  }
  // MsiExec.exe /X{GUID} and other unquoted forms
  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

export async function uninstallApp(
  db: GraphStore,
  appKey: string,
  opts: { root?: string; quarantineDir?: string; exec?: typeof execFileP } = {},
): Promise<UninstallResult> {
  const node = findAppNode(db, appKey);
  if (!node) return { ok: false, receipts: [], error: `application not found: ${appKey}` };
  const props = node.props as { installPath?: string; uninstallString?: string; platform?: string; name?: string };
  const receipts: Receipt[] = [];
  const home = os.homedir();

  // win32 real mode: run the UninstallString
  if (!opts.root && (props.platform === 'win32' || process.platform === 'win32')) {
    const parsed = props.uninstallString ? parseUninstallString(props.uninstallString) : null;
    if (!parsed) return { ok: false, receipts, error: 'no parseable UninstallString' };
    try {
      await (opts.exec ?? execFileP)(parsed.cmd, parsed.args);
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall', path: props.installPath ?? null,
        trashRef: null, bytesFreed: null, ok: true, error: null,
      }));
      markUninstalled(db, node.id);
      return { ok: true, receipts, orphanCandidates: ownedPaths(db, node.id) };
    } catch (err) {
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall', path: props.installPath ?? null,
        trashRef: null, bytesFreed: null, ok: false, error: String(err),
      }));
      return { ok: false, receipts, error: String(err) };
    }
  }

  // darwin / sandbox: trash bundle + owned paths through the Deleter
  const quarantine = opts.quarantineDir ?? (opts.root ? path.join(opts.root, '.sweepdeck-quarantine') : defaultQuarantineDir(home));
  const bundleRoots = opts.root ? [opts.root] : ['/Applications', path.join(home, 'Applications')];
  const ownedRoots = opts.root ? [opts.root] : [path.join(home, 'Library')];

  let allOk = true;
  if (props.installPath) {
    const bundleDeleter = new Deleter({ allowRoots: bundleRoots, quarantineDir: quarantine });
    try {
      const res = await bundleDeleter.trash(props.installPath);
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall', path: props.installPath,
        trashRef: res.trashRef, bytesFreed: res.bytesFreed, ok: true, error: null,
      }));
    } catch (err) {
      allOk = false;
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall', path: props.installPath,
        trashRef: null, bytesFreed: null, ok: false, error: String(err),
      }));
    }
  }

  const ownedDeleter = new Deleter({ allowRoots: ownedRoots, quarantineDir: quarantine });
  for (const owned of ownedPaths(db, node.id)) {
    try {
      const res = await ownedDeleter.trash(owned);
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall-owned', path: owned,
        trashRef: res.trashRef, bytesFreed: res.bytesFreed, ok: true, error: null,
      }));
    } catch (err) {
      receipts.push(writeReceipt(db, {
        verdictId: null, action: 'uninstall-owned', path: owned,
        trashRef: null, bytesFreed: null, ok: false, error: String(err),
      }));
    }
  }

  if (allOk) markUninstalled(db, node.id);
  return { ok: allOk, receipts };
}

function findAppNode(db: GraphStore, key: string): { id: number; props: Record<string, unknown> } | null {
  const id = db.getNodeId('Application', key);
  if (id === null) return null;
  const node = db.getNode(id);
  return node ? { id: node.id, props: node.props } : null;
}

function ownedPaths(db: GraphStore, appNodeId: number): string[] {
  const rows = db.db
    .prepare(
      `SELECT n.key AS p FROM edges e JOIN nodes n ON n.id = e.src
       WHERE e.dst = ? AND e.type = 'OWNED_BY' ORDER BY n.key`,
    )
    .all(appNodeId) as Array<{ p: string }>;
  return rows.map((r) => r.p);
}

function markUninstalled(db: GraphStore, nodeId: number): void {
  const node = db.getNode(nodeId);
  if (node) db.upsertNode('Application', node.key, { installed: 0 });
}
