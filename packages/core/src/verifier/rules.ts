/**
 * Verifier rules — pure, unit-testable path/candidate policy.
 * The verifier is a SEPARATE workflow step: no scanner ever grades its own
 * homework. Every decision here becomes provenance {scanner:'verifier@1',...}.
 *
 * All classification is SHAPE-based, never process.platform-based: a path
 * starting with '/' is POSIX-shaped and gets posix rules; a path with a drive
 * letter (or UNC prefix) is win32-shaped and gets win32 rules. That way real
 * Windows paths hit the Windows rules on any host, and the POSIX test/sandbox
 * paths behave identically everywhere.
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
];
const PROTECTED_PREFIXES_WIN = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
];

export type PathShape = 'posix' | 'win32';

/** Classify by the STRING, not the host platform. */
export function pathShape(p: string): PathShape {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') ? 'win32' : 'posix';
}

/** Split into segments on either separator (drops empties). */
export function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function isAbsShaped(p: string, shape: PathShape): boolean {
  return shape === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') : p.startsWith('/');
}

/** Containment check using the path implementation matching the SHAPE. */
function isUnderShaped(prefix: string, p: string, shape: PathShape): boolean {
  const impl = shape === 'win32' ? path.win32 : path.posix;
  const rel = impl.relative(prefix, p);
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
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
  const shape = pathShape(p);
  const impl = shape === 'win32' ? path.win32 : path.posix;
  const norm = impl.normalize(p);

  if (shape === 'win32') {
    for (const prefix of PROTECTED_PREFIXES_WIN) {
      if (isUnderShaped(prefix, norm, 'win32')) {
        return { ok: false, rule: 'verify.protected-path', reason: `under protected root ${prefix}` };
      }
    }
    // depth < 2 from the filesystem root (e.g. C:\ or C:\foo); ignore the
    // drive token itself and, for UNC, the \\server\share prefix.
    const rawSegs = pathSegments(norm);
    const depthSegs = p.startsWith('\\\\')
      ? rawSegs.slice(2)
      : rawSegs.filter((s) => !/^[A-Za-z]:$/.test(s));
    if (depthSegs.length < 2) {
      return { ok: false, rule: 'verify.shallow-path', reason: 'path depth < 2 from filesystem root' };
    }
  } else {
    for (const prefix of PROTECTED_PREFIXES_POSIX) {
      if (isUnderShaped(prefix, norm, 'posix')) {
        return { ok: false, rule: 'verify.protected-path', reason: `under protected root ${prefix}` };
      }
    }
    // /Library is protected, EXCEPT the user's own ~/Library (only meaningful
    // when the home dir is itself POSIX-shaped).
    const posixHome = isAbsShaped(home, 'posix') ? home : null;
    if (
      isUnderShaped('/Library', norm, 'posix') &&
      !(posixHome && isUnderShaped(path.posix.join(posixHome, 'Library'), norm, 'posix'))
    ) {
      return { ok: false, rule: 'verify.protected-path', reason: 'under system /Library' };
    }
    // /Applications is protected except for the uninstall category
    if (isUnderShaped('/Applications', norm, 'posix') && opts.category !== 'uninstall') {
      return { ok: false, rule: 'verify.protected-path', reason: '/Applications requires the uninstall flow' };
    }
    // depth < 2 from filesystem root: '/', '/foo'
    if (pathSegments(norm).length < 2) {
      return { ok: false, rule: 'verify.shallow-path', reason: 'path depth < 2 from filesystem root' };
    }
  }

  // never the sweepdeck DB itself (or its WAL/SHM sidecars) — same-shape only
  if (opts.dbPath && pathShape(opts.dbPath) === shape && isAbsShaped(opts.dbPath, shape)) {
    const dbFile = impl.normalize(opts.dbPath);
    if (norm === dbFile || norm === `${dbFile}-wal` || norm === `${dbFile}-shm` || isUnderShaped(dbFile, norm, shape)) {
      return { ok: false, rule: 'verify.self-protect', reason: 'sweepdeck database' };
    }
  }
  // never the app's own directories — same-shape, absolute prefixes only
  for (const appDir of opts.appDirs ?? defaultAppDirs(home)) {
    if (pathShape(appDir) !== shape || !isAbsShaped(appDir, shape)) continue;
    if (isUnderShaped(impl.normalize(appDir), norm, shape)) {
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

/**
 * SAFETY-RULES §3.3: smartSelected (preselection) requires the Safe band —
 * scanner confidence >= 0.90 and no verifier downgrade. Enforced centrally in
 * the verifier so no scanner can preselect below the band.
 */
export const SMART_SELECT_MIN_CONFIDENCE = 0.9;
