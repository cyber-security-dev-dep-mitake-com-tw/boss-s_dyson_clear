/**
 * Application scanner — populates Application nodes, INSTALLS_TO and OWNED_BY
 * edges (the graph traversal that powers the uninstaller's orphan cleanup).
 *
 * darwin: /Applications/*.app + ~/Applications/*.app; Info.plist read via
 *         `plutil -convert json -o -` (execFile, never a shell). Owned paths
 *         are correlated in ~/Library/{Application Support,Caches,Preferences,
 *         Logs,Containers,Saved Application State} by bundle id AND app name.
 * win32:  `reg query` of the HKLM/HKCU Uninstall keys (execFile reg.exe).
 * sandbox: <root>/Applications fixtures — a directory ending .app with
 *         Contents/Info.plist (JSON), or a *.appinfo.json file describing
 *         {name, version, bundleId, ownedPaths}.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFileBounded } from '../util/exec.js';
import { treeSize } from './walk.js';
import { prov } from '../graph/provenance.js';
import { emptyResult, type ScanContext, type ScannerResult } from './types.js';
import type { AppInfo } from '../contracts.js';
import type { GraphStore } from '../graph/store.js';

const SCANNER = 'apps-scanner@1';

const MAC_LIBRARY_SUBDIRS = [
  'Application Support',
  'Caches',
  'Preferences',
  'Logs',
  'Containers',
  'Saved Application State',
];

export async function scanApps(ctx: ScanContext): Promise<ScannerResult & { apps: AppInfo[] }> {
  const apps = ctx.root
    ? await enumerateSandboxApps(ctx.root)
    : process.platform === 'win32'
      ? await enumerateWindowsApps()
      : await enumerateMacApps(ctx.root);
  const result = emptyResult();
  for (const app of apps) {
    persistApp(ctx.db, app);
    result.scannedFiles++;
  }
  return { ...result, apps };
}

function persistApp(db: GraphStore, app: AppInfo): number {
  const appNode = db.upsertNode('Application', app.key, {
    name: app.name,
    version: app.version,
    publisher: app.publisher,
    installPath: app.installPath,
    sizeBytes: app.sizeBytes,
    platform: app.platform,
    installed: 1,
  });
  db.addProvenance(
    'node',
    appNode,
    prov(SCANNER, app.platform === 'win32' ? 'win.uninstall-key' : 'mac.app-bundle', { installPath: app.installPath }, 0.95),
  );
  if (app.installPath) {
    const dirNode = db.upsertNode('Directory', app.installPath, { path: app.installPath });
    db.upsertEdge(appNode, dirNode, 'INSTALLS_TO');
  }
  for (const owned of app.ownedPaths) {
    const ownedNode = db.upsertNode('Directory', owned, { path: owned });
    const edgeId = db.upsertEdge(ownedNode, appNode, 'OWNED_BY');
    db.addProvenance('edge', edgeId, prov(SCANNER, 'app.owned-path', { match: app.key }, 0.8));
  }
  return appNode;
}

// -- darwin -------------------------------------------------------------------

async function readInfoPlist(plistPath: string): Promise<Record<string, unknown> | null> {
  // Try plain JSON first (sandbox fixtures write JSON Info.plist).
  try {
    const raw = await readFile(plistPath, 'utf8');
    const v = JSON.parse(raw);
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>;
  } catch {
    /* fall through to plutil */
  }
  try {
    const { stdout } = await execFileBounded('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function enumerateMacApps(_root?: string): Promise<AppInfo[]> {
  const home = os.homedir();
  const dirs = ['/Applications', path.join(home, 'Applications')];
  const apps: AppInfo[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const bundlePath = path.join(dir, name);
      const info = await readInfoPlist(path.join(bundlePath, 'Contents', 'Info.plist'));
      if (!info) continue;
      const bundleId = str(info.CFBundleIdentifier);
      const appName = str(info.CFBundleName) ?? str(info.CFBundleDisplayName) ?? name.replace(/\.app$/, '');
      apps.push({
        key: bundleId ?? bundlePath,
        name: appName,
        version: str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion),
        publisher: null,
        installPath: bundlePath,
        sizeBytes: await safeTreeSize(bundlePath),
        platform: 'darwin',
        ownedPaths: bundleId ? await correlateMacOwnedPaths(home, bundleId, appName) : [],
      });
    }
  }
  return apps;
}

/** Owned support paths: match ~/Library subdir entries by bundle id AND app name. */
async function correlateMacOwnedPaths(home: string, bundleId: string, appName: string): Promise<string[]> {
  const owned: string[] = [];
  const idLower = bundleId.toLowerCase();
  const nameLower = appName.toLowerCase();
  for (const sub of MAC_LIBRARY_SUBDIRS) {
    const dir = path.join(home, 'Library', sub);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const eLower = entry.toLowerCase();
      const base = eLower.replace(/\.(plist|savedstate)$/, '');
      if (base === idLower || base === nameLower || eLower.startsWith(idLower + '.')) {
        owned.push(path.join(dir, entry));
      }
    }
  }
  return owned;
}

// -- win32 --------------------------------------------------------------------

const WIN_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

async function enumerateWindowsApps(exec: ExecFn = (c, a) => execFileBounded(c, a, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  for (const key of WIN_UNINSTALL_KEYS) {
    try {
      const { stdout } = await exec('reg.exe', ['query', key, '/s']);
      apps.push(...parseRegUninstallOutput(stdout));
    } catch {
      /* hive missing / access denied — best effort */
    }
  }
  return apps;
}

/** Parse `reg query ...\Uninstall /s` output. Exported for unit tests (mac-safe). */
export function parseRegUninstallOutput(stdout: string): AppInfo[] {
  const apps: AppInfo[] = [];
  let current: { key: string; values: Record<string, string> } | null = null;
  const flush = () => {
    if (!current) return;
    const v = current.values;
    if (v.DisplayName) {
      apps.push({
        key: current.key,
        name: v.DisplayName,
        version: v.DisplayVersion ?? null,
        publisher: v.Publisher ?? null,
        installPath: v.InstallLocation || null,
        sizeBytes: v.EstimatedSize ? parseInt(v.EstimatedSize, 16) * 1024 : null,
        platform: 'win32',
        ownedPaths: [],
      });
    }
    current = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HK(LM|CU|EY)/i.test(line.trim()) && line.includes('\\Uninstall\\')) {
      flush();
      current = { key: line.trim(), values: {} };
    } else if (current) {
      const m = line.match(/^\s{2,}(\S+)\s+REG_(?:SZ|EXPAND_SZ|DWORD|MULTI_SZ)\s+(.*)$/);
      if (m) current.values[m[1]] = m[2].trim();
    }
  }
  flush();
  return apps;
}

// -- sandbox ------------------------------------------------------------------

async function enumerateSandboxApps(root: string): Promise<AppInfo[]> {
  const dir = path.join(root, 'Applications');
  const apps: AppInfo[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return apps;
  }
  entries.sort();
  for (const name of entries) {
    const full = path.join(dir, name);
    if (name.endsWith('.app')) {
      const info = await readInfoPlist(path.join(full, 'Contents', 'Info.plist'));
      if (!info) continue;
      apps.push({
        key: str(info.CFBundleIdentifier) ?? str(info.bundleId) ?? full,
        name: str(info.CFBundleName) ?? str(info.name) ?? name.replace(/\.app$/, ''),
        version: str(info.CFBundleShortVersionString) ?? str(info.version),
        publisher: null,
        installPath: full,
        sizeBytes: await safeTreeSize(full),
        platform: process.platform === 'win32' ? 'win32' : 'darwin',
        ownedPaths: resolveOwned(root, info.ownedPaths),
      });
    } else if (name.endsWith('.appinfo.json')) {
      try {
        const info = JSON.parse(await readFile(full, 'utf8')) as Record<string, unknown>;
        apps.push({
          key: str(info.bundleId) ?? full,
          name: str(info.name) ?? name.replace(/\.appinfo\.json$/, ''),
          version: str(info.version),
          publisher: str(info.publisher),
          installPath: str(info.installPath),
          sizeBytes: null,
          platform: process.platform === 'win32' ? 'win32' : 'darwin',
          ownedPaths: resolveOwned(root, info.ownedPaths),
        });
      } catch {
        /* malformed fixture — skip */
      }
    }
  }
  return apps;
}

function resolveOwned(root: string, v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === 'string').map((p) => (path.isAbsolute(p) ? p : path.join(root, p)));
}

// -- helpers ------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function safeTreeSize(p: string): Promise<number | null> {
  try {
    await stat(p);
    return await treeSize(p);
  } catch {
    return null;
  }
}
