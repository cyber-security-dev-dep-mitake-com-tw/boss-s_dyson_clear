/**
 * Streaming async filesystem walker.
 * - Never follows symlinks (lstat semantics via withFileTypes + isSymbolicLink).
 * - EACCES / EPERM / ENOENT on a subtree are swallowed (recorded via onError)
 *   so a permission wall never kills a scan task.
 */
import { opendir } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

export interface WalkEntry {
  path: string;
  dirent: 'file' | 'dir';
  stats: Stats;
}

export interface WalkOptions {
  signal?: AbortSignal;
  onError?: (p: string, err: unknown) => void;
  /** Return false to skip descending into a directory. */
  shouldDescend?: (dirPath: string) => boolean;
}

export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (opts.signal?.aborted) return;
    const dirPath = stack.pop()!;
    let dir;
    try {
      dir = await opendir(dirPath);
    } catch (err) {
      opts.onError?.(dirPath, err);
      continue;
    }
    try {
      for await (const dirent of dir) {
        if (opts.signal?.aborted) return;
        const full = path.join(dirPath, dirent.name);
        try {
          if (dirent.isSymbolicLink()) continue; // never follow symlinks
          if (dirent.isDirectory()) {
            const stats = await lstat(full);
            yield { path: full, dirent: 'dir', stats };
            if (opts.shouldDescend?.(full) !== false) stack.push(full);
          } else if (dirent.isFile()) {
            const stats = await lstat(full);
            yield { path: full, dirent: 'file', stats };
          }
        } catch (err) {
          opts.onError?.(full, err); // EACCES etc — keep walking
        }
      }
    } catch (err) {
      opts.onError?.(dirPath, err);
    }
  }
}

/** Recursive size of a tree (symlink-safe, error-tolerant). */
export async function treeSize(root: string, opts: WalkOptions = {}): Promise<number> {
  let total = 0;
  try {
    const st = await lstat(root);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  for await (const entry of walk(root, opts)) {
    if (entry.dirent === 'file') total += entry.stats.size;
  }
  return total;
}
