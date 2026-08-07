/**
 * Duplicate scanner — ENTITY RESOLUTION pipeline:
 *   1. BLOCKING  — group by (sizeBytes, ext); only blocks with >= 2 members
 *                  and size > 0 go on (cheap candidate generation).
 *   2. MATCHING  — sha256 of first+last 64KB (partial hash); survivors get a
 *                  full streaming sha256 in the bounded-concurrency hasher
 *                  pool (crypto streams + limiter — no worker_threads needed).
 *   3. FUSION    — DUPLICATE_OF edges pointing at the canonical member.
 *
 * CANONICAL (merge) POLICY, in order:
 *   1. prefer a path under a Documents / Pictures / Desktop directory
 *      (the user's curated copy wins over strays in Downloads etc.),
 *   2. then the oldest mtime (the original predates its copies),
 *   3. then the shortest path (least-buried copy).
 * smartSelected = every NON-canonical member.
 */
import os from 'node:os';
import path from 'node:path';
import { walk } from './walk.js';
import { partialHash, fullHash } from '../hashing/hash.js';
import { createLimiter } from '../workflow/engine.js';
import { prov } from '../graph/provenance.js';
import { emptyResult, type ScanContext, type ScannerResult } from './types.js';

const SCANNER = 'dup-scanner@1';
const PREFERRED_DIRS = new Set(['documents', 'pictures', 'desktop']);

interface FileRec {
  path: string;
  size: number;
  ext: string;
  mtimeMs: number;
}

export async function scanDuplicates(ctx: ScanContext): Promise<ScannerResult> {
  const result = emptyResult();
  const root = ctx.root ?? os.homedir();

  // 1. BLOCKING — collect candidates keyed by (size, ext)
  const blocks = new Map<string, FileRec[]>();
  for await (const entry of walk(root, { signal: ctx.signal, onError: () => void 0 })) {
    if (entry.dirent !== 'file') continue;
    result.scannedFiles++;
    if (entry.stats.size <= 0) continue;
    const rec: FileRec = {
      path: entry.path,
      size: entry.stats.size,
      ext: path.extname(entry.path).toLowerCase(),
      mtimeMs: entry.stats.mtimeMs,
    };
    const key = `${rec.size}:${rec.ext}`;
    const arr = blocks.get(key);
    if (arr) arr.push(rec);
    else blocks.set(key, [rec]);
  }

  const survivors = [...blocks.values()].filter((b) => b.length >= 2);

  // 2. MATCHING — partial hash, regroup, then full hash in the limiter pool
  const limit = createLimiter(); // default cpus-1
  const fullGroups = new Map<string, FileRec[]>();
  for (const block of survivors) {
    if (ctx.signal?.aborted) break;
    const partials = new Map<string, FileRec[]>();
    await Promise.all(
      block.map((rec) =>
        limit(async () => {
          try {
            const h = await partialHash(rec.path, rec.size);
            const arr = partials.get(h);
            if (arr) arr.push(rec);
            else partials.set(h, [rec]);
          } catch {
            /* unreadable — drop from matching */
          }
        }),
      ),
    );
    for (const group of partials.values()) {
      if (group.length < 2) continue;
      await Promise.all(
        group.map((rec) =>
          limit(async () => {
            try {
              const h = await fullHash(rec.path);
              const arr = fullGroups.get(h);
              if (arr) arr.push(rec);
              else fullGroups.set(h, [rec]);
            } catch {
              /* unreadable — drop */
            }
          }),
        ),
      );
    }
  }

  // 3. FUSION — pick canonical, emit DUPLICATE_OF edges + candidates
  let groupSeq = 0;
  for (const [hash, group] of fullGroups) {
    if (group.length < 2) continue;
    groupSeq++;
    const groupId = `dup-${groupSeq}`;
    const canonical = pickCanonical(group);
    const canonicalNode = ctx.db.upsertNode('File', canonical.path, {
      path: canonical.path,
      sizeBytes: canonical.size,
      mtimeMs: canonical.mtimeMs,
      ext: canonical.ext,
      hash,
    });

    for (const rec of group) {
      if (rec === canonical) continue;
      const nodeId = ctx.db.upsertNode('File', rec.path, {
        path: rec.path,
        sizeBytes: rec.size,
        mtimeMs: rec.mtimeMs,
        ext: rec.ext,
        hash,
      });
      const edgeId = ctx.db.upsertEdge(nodeId, canonicalNode, 'DUPLICATE_OF', { hash });
      const p = prov(
        SCANNER,
        'dup.full-hash',
        { hash, groupId, canonicalPath: canonical.path, sizeBytes: rec.size },
        0.99,
      );
      ctx.db.addProvenance('edge', edgeId, p);
      result.candidates.push({
        category: 'duplicate',
        action: 'trash',
        subjectKey: rec.path,
        subjectType: 'File',
        label: `Duplicate of ${path.basename(canonical.path)}`,
        sizeBytes: rec.size,
        smartSelected: true, // all non-canonical members
        provenance: p,
        detail: { groupId, canonicalPath: canonical.path, hash },
        nodeId,
      });
    }
  }
  return result;
}

/** Merge policy — see module doc. Exported for tests. */
export function pickCanonical(group: FileRec[]): FileRec {
  // shape-agnostic: split on either separator so POSIX-style paths classify
  // identically on any host (and real win32 paths work on Windows)
  const inPreferred = (rec: FileRec) =>
    rec.path
      .split(/[\\/]+/)
      .slice(0, -1)
      .some((seg) => PREFERRED_DIRS.has(seg.toLowerCase()));
  return [...group].sort((a, b) => {
    const prefA = inPreferred(a) ? 0 : 1;
    const prefB = inPreferred(b) ? 0 : 1;
    if (prefA !== prefB) return prefA - prefB; // 1. curated location
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs; // 2. oldest mtime
    if (a.path.length !== b.path.length) return a.path.length - b.path.length; // 3. shortest path
    return a.path.localeCompare(b.path); // deterministic tiebreak
  })[0];
}
