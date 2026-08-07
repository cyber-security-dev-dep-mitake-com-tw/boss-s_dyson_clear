/**
 * Deleter — trash-first executor primitive with STRUCTURAL safety:
 * a Deleter can only ever move paths that resolve (realpath, symlink-safe)
 * inside its allowRoots into its quarantine directory. There is no boolean
 * to bypass this — construct a different Deleter if you need different roots.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, stat, lstat, copyFile, unlink, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { treeSize } from '../scanners/walk.js';
import { checkProtectedPath } from '../verifier/rules.js';

export class ProtectedPathError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`refusing to touch protected path: ${path} (${reason})`);
    this.name = 'ProtectedPathError';
  }
}

export interface TrashResult {
  /** Where the item now lives inside quarantine — the undo handle. */
  trashRef: string;
  bytesFreed: number;
}

export class Deleter {
  private readonly allowRoots: string[];
  readonly quarantineDir: string;

  constructor(opts: { allowRoots: string[]; quarantineDir: string }) {
    if (opts.allowRoots.length === 0) throw new Error('Deleter requires at least one allowRoot');
    this.allowRoots = opts.allowRoots.map((r) => path.resolve(r));
    this.quarantineDir = path.resolve(opts.quarantineDir);
  }

  /** Symlink-safe containment + hard-deny re-check. Throws ProtectedPathError. */
  private async assertAllowed(target: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(target); // resolves symlinks — an escaping link fails containment
    } catch (err) {
      throw new ProtectedPathError(target, `cannot resolve: ${String(err)}`);
    }
    const resolvedRoots = await Promise.all(
      this.allowRoots.map(async (r) => {
        try {
          return await realpath(r);
        } catch {
          return r;
        }
      }),
    );
    const inside = resolvedRoots.some((root) => {
      const rel = path.relative(root, real);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inside) throw new ProtectedPathError(target, 'outside allowRoots');

    // structural re-check of the hard-deny list, independent of the verifier
    const deny = checkProtectedPath(real, { category: 'uninstall' });
    if (!deny.ok) throw new ProtectedPathError(target, deny.reason ?? deny.rule ?? 'protected');

    // never trash something already inside quarantine (realpath both sides —
    // macOS tmpdirs live behind the /var → /private/var symlink)
    const qReal = await realpath(this.quarantineDir).catch(() => this.quarantineDir);
    const qRel = path.relative(qReal, real);
    if (qRel === '' || (!qRel.startsWith('..') && !path.isAbsolute(qRel))) {
      throw new ProtectedPathError(target, 'inside quarantine');
    }
    return real;
  }

  /**
   * Move `target` into quarantine (rename; cross-device falls back to
   * copy+unlink). Returns the trashRef used by undo.
   */
  async trash(target: string): Promise<TrashResult> {
    const real = await this.assertAllowed(target);
    const st = await lstat(real);
    const bytes = st.isDirectory() ? await treeSize(real) : st.size;

    const tag = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const destDir = path.join(this.quarantineDir, tag);
    await mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(real));

    try {
      await rename(real, dest);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyTree(real, dest);
        await rm(real, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return { trashRef: dest, bytesFreed: bytes };
  }

  /** Restore a quarantined item to `originalPath` (refuses to overwrite). */
  async restore(trashRef: string, originalPath: string): Promise<void> {
    const refResolved = path.resolve(trashRef);
    const rel = path.relative(this.quarantineDir, refResolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ProtectedPathError(trashRef, 'trashRef outside quarantine');
    }
    try {
      await stat(originalPath);
      throw new Error(`restore target already exists: ${originalPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await mkdir(path.dirname(originalPath), { recursive: true });
    try {
      await rename(refResolved, originalPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyTree(refResolved, originalPath);
        await rm(refResolved, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }
}

/** Recursive copy preserving structure (cross-device fallback). */
async function copyTree(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(src)) {
      await copyTree(path.join(src, name), path.join(dest, name));
    }
  } else if (st.isFile()) {
    await copyFile(src, dest);
  }
  // symlinks are intentionally not copied
}

/** Default quarantine location for real (non-sandbox) runs. */
export function defaultQuarantineDir(home: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(home, '.sweepdeck', 'quarantine', stamp);
}
