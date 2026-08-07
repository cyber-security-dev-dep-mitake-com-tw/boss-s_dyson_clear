/**
 * Junk scanner — caches, temp files, logs, trash.
 *
 * SANDBOX MODE (ctx.root set — the deterministic Robot Framework surface):
 *   junk = files inside any directory named (case-insensitive)
 *   Caches/Cache/tmp/Temp/Logs/.Trash, plus files matching *.tmp or *.log
 *   anywhere; NEVER flags anything under a directory named Documents, Desktop
 *   or Pictures. Rules 'sandbox.junk.<kind>', confidence 0.9 (cache dirs) /
 *   0.7 (loose *.tmp / *.log).
 *
 * REAL MODE: per-OS curated CacheLocation table. Each location becomes a
 * CacheLocation node with CONTAINS edges to its entries; browser locations get
 * OWNED_BY edges to the browser Application node.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import { walk, treeSize } from './walk.js';
import { prov } from '../graph/provenance.js';
import { emptyResult, type Candidate, type ScanContext, type ScannerResult } from './types.js';

const SCANNER = 'junk-scanner@1';

const JUNK_DIR_NAMES = new Set(['caches', 'cache', 'tmp', 'temp', 'logs', '.trash']);
const PROTECTED_DIR_NAMES = new Set(['documents', 'desktop', 'pictures']);

export async function scanJunk(ctx: ScanContext): Promise<ScannerResult> {
  return ctx.root ? scanSandbox(ctx, ctx.root) : scanReal(ctx);
}

// -- sandbox ------------------------------------------------------------------

function segmentNames(root: string, filePath: string): string[] {
  // split on either separator — walk() emits host-native paths, but this keeps
  // the classification identical for POSIX-shaped fixtures on any host
  return path.relative(root, path.dirname(filePath)).split(/[\\/]+/).filter(Boolean);
}

async function scanSandbox(ctx: ScanContext, root: string): Promise<ScannerResult> {
  const result = emptyResult();
  const errors: string[] = [];
  for await (const entry of walk(root, {
    signal: ctx.signal,
    onError: (p, e) => errors.push(`${p}: ${String(e)}`),
  })) {
    if (entry.dirent !== 'file') continue;
    result.scannedFiles++;

    const parents = segmentNames(root, entry.path).map((s) => s.toLowerCase());
    if (parents.some((s) => PROTECTED_DIR_NAMES.has(s))) continue; // never under Documents/Desktop/Pictures

    const junkParent = parents.find((s) => JUNK_DIR_NAMES.has(s));
    const ext = path.extname(entry.path).toLowerCase();
    const looseJunk = ext === '.tmp' || ext === '.log';
    if (!junkParent && !looseJunk) continue;

    const kind = junkParent ? junkParent.replace(/^\./, '') : ext.slice(1);
    const rule = `sandbox.junk.${kind}`;
    const confidence = junkParent ? 0.9 : 0.7;
    const nodeId = ctx.db.upsertNode('File', entry.path, {
      path: entry.path,
      sizeBytes: entry.stats.size,
      mtimeMs: entry.stats.mtimeMs,
      ext,
    });
    ctx.db.addProvenance(
      'node',
      nodeId,
      prov(SCANNER, rule, { matched: junkParent ?? `*${ext}` }, confidence),
    );
    result.candidates.push({
      category: 'junk',
      action: 'trash',
      subjectKey: entry.path,
      subjectType: 'File',
      label: junkParent
        ? `${path.basename(entry.path)} (in ${junkParent} dir)`
        : `${path.basename(entry.path)} (loose ${ext} file)`,
      sizeBytes: entry.stats.size,
      // SAFETY-RULES §3.3: smart-select only in the Safe band (>= 0.90);
      // loose *.tmp/*.log matches (0.7) are listed unchecked. (BUG-001)
      smartSelected: confidence >= 0.9,
      provenance: prov(
        SCANNER,
        rule,
        { path: entry.path, matched: junkParent ?? `*${ext}`, mtimeMs: entry.stats.mtimeMs },
        confidence,
      ),
      detail: { kind, root },
      nodeId,
    });
  }
  return result;
}

// -- real mode ----------------------------------------------------------------

interface CacheLocation {
  dir: string;
  kind: string;
  rule: string;
  confidence: number;
  browser?: string; // browser name → OWNED_BY edge to its Application node
  adviseOnly?: boolean;
}

function macLocations(home: string): CacheLocation[] {
  const L = (p: string) => path.join(home, 'Library', p);
  return [
    { dir: L('Caches'), kind: 'user-cache', rule: 'mac.user-cache', confidence: 0.8 },
    { dir: L('Logs'), kind: 'logs', rule: 'mac.user-logs', confidence: 0.8 },
    { dir: '/private/tmp', kind: 'tmp', rule: 'mac.private-tmp', confidence: 0.6 },
    { dir: path.join(home, '.Trash'), kind: 'trash', rule: 'mac.user-trash', confidence: 0.9 },
    // browser caches
    { dir: L('Caches/Google/Chrome'), kind: 'browser-cache', rule: 'mac.browser-cache.chrome', confidence: 0.85, browser: 'Google Chrome' },
    { dir: L('Caches/Microsoft Edge'), kind: 'browser-cache', rule: 'mac.browser-cache.edge', confidence: 0.85, browser: 'Microsoft Edge' },
    { dir: L('Caches/Firefox'), kind: 'browser-cache', rule: 'mac.browser-cache.firefox', confidence: 0.85, browser: 'Firefox' },
    { dir: L('Caches/com.apple.Safari'), kind: 'browser-cache', rule: 'mac.browser-cache.safari', confidence: 0.85, browser: 'Safari' },
  ];
}

function winLocations(home: string): CacheLocation[] {
  const env = process.env;
  const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const temp = env.TEMP ?? path.join(local, 'Temp');
  return [
    { dir: temp, kind: 'tmp', rule: 'win.temp', confidence: 0.8 },
    { dir: path.join(local, 'Temp'), kind: 'tmp', rule: 'win.localappdata-temp', confidence: 0.8 },
    { dir: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), kind: 'browser-cache', rule: 'win.browser-cache.chrome', confidence: 0.85, browser: 'Google Chrome' },
    { dir: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), kind: 'browser-cache', rule: 'win.browser-cache.edge', confidence: 0.85, browser: 'Microsoft Edge' },
    { dir: path.join(local, 'Mozilla', 'Firefox', 'Profiles'), kind: 'browser-cache', rule: 'win.browser-cache.firefox', confidence: 0.85, browser: 'Firefox' },
    // Recycle Bin listing — advise only, never auto-trash
    { dir: 'C:\\$Recycle.Bin', kind: 'trash', rule: 'win.recycle-bin', confidence: 0.9, adviseOnly: true },
  ];
}

async function scanReal(ctx: ScanContext): Promise<ScannerResult> {
  const result = emptyResult();
  const home = os.homedir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const locations = process.platform === 'win32' ? winLocations(home) : macLocations(home);

  for (const loc of locations) {
    if (ctx.signal?.aborted) break;
    let entries: string[];
    try {
      entries = await readdir(loc.dir);
    } catch {
      continue; // location absent — normal
    }

    const locNodeId = ctx.db.upsertNode('CacheLocation', loc.dir, {
      path: loc.dir,
      kind: loc.kind,
      ...(loc.browser ? { browser: loc.browser } : {}),
    });
    ctx.db.addProvenance('node', locNodeId, prov(SCANNER, loc.rule, { dir: loc.dir }, loc.confidence));

    let appNodeId: number | null = null;
    if (loc.browser) {
      appNodeId = ctx.db.upsertNode('Application', `browser:${loc.browser}`, { name: loc.browser });
      ctx.db.upsertEdge(locNodeId, appNodeId, 'OWNED_BY');
    }

    let locBytes = 0;
    for (const name of entries) {
      if (ctx.signal?.aborted) break;
      const full = path.join(loc.dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      // /private/tmp: only entries the current user owns
      if (loc.rule === 'mac.private-tmp' && uid !== null && st.uid !== uid) continue;

      const isDir = st.isDirectory();
      const size = isDir ? await treeSize(full, { signal: ctx.signal }) : st.size;
      locBytes += size;
      result.scannedFiles++;

      const nodeId = ctx.db.upsertNode(isDir ? 'Directory' : 'File', full, {
        path: full,
        sizeBytes: size,
        mtimeMs: st.mtimeMs,
      });
      ctx.db.upsertEdge(locNodeId, nodeId, 'CONTAINS');
      if (appNodeId !== null) ctx.db.upsertEdge(nodeId, appNodeId, 'OWNED_BY');

      const p = prov(SCANNER, loc.rule, { path: full, kind: loc.kind, mtimeMs: st.mtimeMs }, loc.confidence);
      ctx.db.addProvenance('node', nodeId, p);
      result.candidates.push({
        category: 'junk',
        action: loc.adviseOnly ? 'advise' : 'trash',
        subjectKey: full,
        subjectType: isDir ? 'Directory' : 'File',
        label: loc.browser ? `${loc.browser} cache: ${name}` : `${loc.kind}: ${name}`,
        sizeBytes: size,
        // §3.3: preselect only in the Safe band (verifier enforces this too)
        smartSelected: !loc.adviseOnly && size > 0 && loc.confidence >= 0.9,
        provenance: p,
        detail: { kind: loc.kind, location: loc.dir, ...(loc.browser ? { browser: loc.browser } : {}) },
        nodeId,
      });
    }
    ctx.db.upsertNode('CacheLocation', loc.dir, { sizeBytes: locBytes });
  }
  return result;
}
