/**
 * Verifier rules — pure, unit-testable path/candidate policy.
 * The verifier is a SEPARATE workflow step: no scanner ever grades its own
 * homework. Every decision here becomes provenance {scanner:'verifier@1',...}.
 */
import os from 'node:os';
import path from 'node:path';

export const VERIFIER = 'verifier@1';

/** Hard-deny roots — nothing under these is ever trashable. */
const PROTECTED_PREFIXES_POSIX = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/private/var/db',
  // SAFETY-RULES §2.1 alias forms (raw-string checks don't resolve symlinks)
  '/private/etc',
  '/etc',
  '/var/db',
];
const PROTECTED_PREFIXES_WIN = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
];

function isUnder(prefix: string, p: string): boolean {
  const rel = path.relative(prefix, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isUnderWin(prefix: string, p: string): boolean {
  const rel = path.win32.relative(prefix, p);
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

export interface PathVerdict {
  ok: boolean;
  rule?: string;
  reason?: string;
}

/**
 * Hard protected-path policy. `category` matters: /Applications is protected
 * EXCEPT for the uninstall flow.
 */
export function checkProtectedPath(
  p: string,
  opts: { category?: string; dbPath?: string; appDirs?: string[]; home?: string } = {},
): PathVerdict {
  const home = opts.home ?? os.homedir();
  const isWinPath = /^[A-Za-z]:[\\/]/.test(p);

  if (isWinPath) {
    const norm = path.win32.normalize(p);
    for (const prefix of PROTECTED_PREFIXES_WIN) {
      if (isUnderWin(prefix, norm)) {
        return { ok: false, rule: 'verify.protected-path', reason: `under protected root ${prefix}` };
      }
    }
    // depth < 2 from filesystem root (e.g. C:\ or C:\foo)
    const parts = norm.replace(/^[A-Za-z]:[\\/]?/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) {
      return { ok: false, rule: 'verify.shallow-path', reason: 'path depth < 2 from filesystem root' };
    }
    // self-protection (SAFETY-RULES §2.2): never the sweepdeck DB or app dirs
    if (opts.dbPath && /^[A-Za-z]:[\\/]/.test(opts.dbPath)) {
      const dbFile = path.win32.normalize(opts.dbPath);
      const nl = norm.toLowerCase();
      const dl = dbFile.toLowerCase();
      if (nl === dl || nl === `${dl}-wal` || nl === `${dl}-shm` || isUnderWin(dbFile, norm)) {
        return { ok: false, rule: 'verify.self-protect', reason: 'sweepdeck database' };
      }
    }
    for (const appDir of opts.appDirs ?? defaultAppDirs(home)) {
      if (/^[A-Za-z]:[\\/]/.test(appDir) && isUnderWin(path.win32.normalize(appDir), norm)) {
        return { ok: false, rule: 'verify.self-protect', reason: 'sweepdeck application directory' };
      }
    }
    return { ok: true };
  }

  const norm = path.normalize(p);
  for (const prefix of PROTECTED_PREFIXES_POSIX) {
    if (isUnder(prefix, norm)) {
      return { ok: false, rule: 'verify.protected-path', reason: `under protected root ${prefix}` };
    }
  }
  // /Library is protected, EXCEPT the user's own ~/Library
  if (isUnder('/Library', norm) && !isUnder(path.join(home, 'Library'), norm)) {
    return { ok: false, rule: 'verify.protected-path', reason: 'under system /Library' };
  }
  // /Applications is protected except for the uninstall category
  if (isUnder('/Applications', norm) && opts.category !== 'uninstall') {
    return { ok: false, rule: 'verify.protected-path', reason: '/Applications requires the uninstall flow' };
  }
  // depth < 2 from filesystem root: '/', '/foo'
  if (norm.split('/').filter(Boolean).length < 2) {
    return { ok: false, rule: 'verify.shallow-path', reason: 'path depth < 2 from filesystem root' };
  }
  // never the sweepdeck DB itself (or its WAL/SHM sidecars)
  if (opts.dbPath) {
    const dbFile = path.resolve(opts.dbPath);
    if (norm === dbFile || norm === `${dbFile}-wal` || norm === `${dbFile}-shm` || isUnder(dbFile, norm)) {
      return { ok: false, rule: 'verify.self-protect', reason: 'sweepdeck database' };
    }
  }
  for (const appDir of opts.appDirs ?? defaultAppDirs(home)) {
    if (isUnder(appDir, norm)) {
      return { ok: false, rule: 'verify.self-protect', reason: 'sweepdeck application directory' };
    }
  }
  return { ok: true };
}

export function defaultAppDirs(home: string = os.homedir()): string[] {
  return [path.join(home, '.sweepdeck')];
}

/** Junk must never touch the user's curated content dirs. */
export function isUnderUserContentDir(p: string): boolean {
  const parts = p.split(/[\\/]/).slice(0, -1);
  return parts.some((seg) => {
    const s = seg.toLowerCase();
    return s === 'documents' || s === 'desktop' || s === 'pictures';
  });
}

export const RECENT_MTIME_MS = 24 * 60 * 60 * 1000;
export const MIN_CONFIDENCE = 0.5;
/** SAFETY-RULES §3.3: smartSelected ⇔ Safe band (confidence >= 0.90). */
export const SMART_SELECT_MIN_CONFIDENCE = 0.9;
