/**
 * Verifier — the independent safety gate between scanners and the plan.
 * Takes ALL candidates (regardless of which scanner produced them) and:
 *   - REJECTS anything under protected paths / the sweepdeck DB / app dirs,
 *   - REJECTS junk under Documents/Desktop/Pictures,
 *   - DOWNGRADES 'trash' → 'advise' for low confidence, recently-touched
 *     files (real mode), or files currently held open (lsof, best-effort).
 * Every decision is recorded as provenance {scanner:'verifier@1', rule, ...}.
 */
import { execFileBounded } from '../util/exec.js';
import { prov } from '../graph/provenance.js';
import type { Candidate } from '../scanners/types.js';
import type { Provenance } from '../contracts.js';
import {
  VERIFIER,
  checkProtectedPath,
  isUnderUserContentDir,
  MIN_CONFIDENCE,
  RECENT_MTIME_MS,
  SMART_SELECT_MIN_CONFIDENCE,
} from './rules.js';

export interface VerifiedCandidate extends Candidate {
  status: 'proposed' | 'rejected';
  /** Verifier decisions to persist alongside the scanner provenance. */
  verifierProvenance: Provenance[];
}

export interface VerifyOptions {
  /** Sandbox root, when scanning a confined test tree. */
  root?: string;
  dbPath?: string;
  appDirs?: string[];
  /** Injectable for tests; darwin-only lsof batch. */
  openFileCheck?: (paths: string[]) => Promise<Set<string>>;
}

export async function verify(candidates: Candidate[], opts: VerifyOptions = {}): Promise<VerifiedCandidate[]> {
  const out: VerifiedCandidate[] = [];
  const now = Date.now();
  const pathLike = (c: Candidate) => c.subjectType === 'File' || c.subjectType === 'Directory' || c.subjectType === 'CacheLocation';

  // Best-effort open-file check over the trash candidates (real mode only —
  // the sandbox surface stays deterministic and fast).
  let openPaths = new Set<string>();
  if (!opts.root && process.platform === 'darwin') {
    const targets = candidates.filter((c) => c.action === 'trash' && pathLike(c)).map((c) => c.subjectKey);
    openPaths = await (opts.openFileCheck ?? lsofOpenPaths)(targets);
  } else if (opts.openFileCheck) {
    const targets = candidates.filter((c) => c.action === 'trash' && pathLike(c)).map((c) => c.subjectKey);
    openPaths = await opts.openFileCheck(targets);
  }

  for (const c of candidates) {
    const decisions: Provenance[] = [];
    let status: 'proposed' | 'rejected' = 'proposed';
    let action = c.action;

    if (pathLike(c)) {
      // 1. hard protected-path policy
      const pv = checkProtectedPath(c.subjectKey, {
        category: c.action === 'uninstall' ? 'uninstall' : c.category,
        dbPath: opts.dbPath,
        appDirs: opts.appDirs,
      });
      if (!pv.ok) {
        status = 'rejected';
        decisions.push(prov(VERIFIER, pv.rule!, { path: c.subjectKey, reason: pv.reason }, 1));
      }

      // 2. junk never touches Documents/Desktop/Pictures
      if (status !== 'rejected' && c.category === 'junk' && isUnderUserContentDir(c.subjectKey)) {
        status = 'rejected';
        decisions.push(
          prov(VERIFIER, 'verify.junk.user-content-dir', { path: c.subjectKey, reason: 'under Documents/Desktop/Pictures' }, 1),
        );
      }
    }

    if (status !== 'rejected' && action === 'trash') {
      // 3. low scanner confidence → advise
      if (c.provenance.confidence < MIN_CONFIDENCE) {
        action = 'advise';
        decisions.push(
          prov(VERIFIER, 'verify.low-confidence', { confidence: c.provenance.confidence, min: MIN_CONFIDENCE }, 0.9),
        );
      }
      // 4. recently-modified cache (real mode only — sandbox fixtures are freshly created)
      const mtimeMs = Number((c.provenance.evidence as { mtimeMs?: unknown }).mtimeMs ?? NaN);
      if (!opts.root && action === 'trash' && Number.isFinite(mtimeMs) && now - mtimeMs < RECENT_MTIME_MS) {
        action = 'advise';
        decisions.push(prov(VERIFIER, 'verify.recent-mtime', { mtimeMs, windowMs: RECENT_MTIME_MS }, 0.8));
      }
      // 5. held open by a process → advise
      if (action === 'trash' && openPaths.has(c.subjectKey)) {
        action = 'advise';
        decisions.push(prov(VERIFIER, 'verify.open-file', { path: c.subjectKey, reason: 'held open by a process' }, 0.9));
      }
    }

    // SAFETY-RULES §3.3: smartSelected ⇔ Safe band (confidence >= 0.90) and no
    // downgrade fired. Enforced centrally — no scanner can preselect below it.
    let smartSelected = c.smartSelected;
    if (smartSelected && c.provenance.confidence < SMART_SELECT_MIN_CONFIDENCE) {
      smartSelected = false;
      decisions.push(
        prov(
          VERIFIER,
          'verify.smart-select-band',
          { confidence: c.provenance.confidence, min: SMART_SELECT_MIN_CONFIDENCE },
          1,
        ),
      );
    } else if (smartSelected && (status === 'rejected' || action === 'advise')) {
      smartSelected = false; // rejected/downgraded items are never preselected
    }

    if (decisions.length === 0) {
      decisions.push(prov(VERIFIER, 'verify.pass', {}, 1));
    }
    out.push({ ...c, action, status, smartSelected, verifierProvenance: decisions });
  }
  return out;
}

/** darwin: batched `lsof -Fn -- <paths>`; every error is swallowed. */
async function lsofOpenPaths(paths: string[]): Promise<Set<string>> {
  const open = new Set<string>();
  const BATCH = 100;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    try {
      const { stdout } = await execFileBounded('lsof', ['-Fn', '--', ...batch], { timeout: 3000 });
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n')) open.add(line.slice(1));
      }
    } catch (err: unknown) {
      // lsof exits 1 when nothing is open — but still prints hits it found
      const stdout = (err as { stdout?: string }).stdout;
      if (typeof stdout === 'string') {
        for (const line of stdout.split('\n')) {
          if (line.startsWith('n')) open.add(line.slice(1));
        }
      }
    }
  }
  return open;
}
