/**
 * Receipts — the audit trail of every executed action, and undo.
 * undo(receiptId) moves the quarantined item (trashRef) back to its original
 * path, provided nothing new occupies that path.
 */
import { mkdir, rename, rm, stat, lstat, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { GraphStore } from '../graph/store.js';
import type { Receipt } from '../contracts.js';

export function writeReceipt(db: GraphStore, r: Omit<Receipt, 'id' | 'executedAt'> & { executedAt?: number }): Receipt {
  const executedAt = r.executedAt ?? Date.now();
  const id = db.addReceipt({ ...r, executedAt });
  return { ...r, id, executedAt };
}

export interface UndoResult {
  ok: boolean;
  error?: string;
  receipt?: Receipt;
}

export async function undoReceipt(db: GraphStore, receiptId: number): Promise<UndoResult> {
  const receipt = db.getReceipt(receiptId);
  if (!receipt) return { ok: false, error: `receipt ${receiptId} not found` };
  if (!receipt.ok) return { ok: false, error: 'receipt records a failed action — nothing to undo' };
  if (!receipt.trashRef || !receipt.path) {
    return { ok: false, error: `receipt action '${receipt.action}' is not undoable (no trashRef)` };
  }

  try {
    await stat(receipt.trashRef);
  } catch {
    return { ok: false, error: `quarantined item missing: ${receipt.trashRef}` };
  }
  try {
    await stat(receipt.path);
    return { ok: false, error: `original path already exists: ${receipt.path}` };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: String(err) };
    }
  }

  try {
    await mkdir(path.dirname(receipt.path), { recursive: true });
    try {
      await rename(receipt.trashRef, receipt.path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyBack(receipt.trashRef, receipt.path);
        await rm(receipt.trashRef, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const undoRec = writeReceipt(db, {
    verdictId: receipt.verdictId,
    action: 'undo',
    path: receipt.path,
    trashRef: receipt.trashRef,
    bytesFreed: receipt.bytesFreed !== null ? -receipt.bytesFreed : null,
    ok: true,
    error: null,
  });
  if (receipt.verdictId !== null) db.updateVerdictStatus(receipt.verdictId, 'undone');
  return { ok: true, receipt: undoRec };
}

async function copyBack(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(src)) {
      await copyBack(path.join(src, name), path.join(dest, name));
    }
  } else if (st.isFile()) {
    await copyFile(src, dest);
  }
}
