/**
 * Process scanner — activity-monitor data + "unnecessary" heuristic.
 *
 * Heuristic score (0..1) = weighted sum:
 *   cpu > 20% sustained            +0.3
 *   mem > 1GB                      +0.3
 *   not a system user / not under an OS path allowlist  +0.2
 *   is a login item                +0.2
 *
 * Login items: darwin — osascript System Events (best-effort) plus
 * ~/Library/LaunchAgents plists; win32 — reg query Run keys. Everything is
 * try/catch'd: this scanner must NEVER crash a scan.
 *
 * In sandbox mode (ctx.root set) the scanner returns nothing — live process
 * tables are inherently non-deterministic and the sandbox is the deterministic
 * Robot Framework surface.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import si from 'systeminformation';
import { execFileBounded } from '../util/exec.js';
import { prov } from '../graph/provenance.js';
import { emptyResult, type ScanContext, type ScannerResult } from './types.js';
import type { ProcInfo } from '../contracts.js';

const SCANNER = 'proc-scanner@1';

const OS_PATH_ALLOWLIST = ['/usr', '/System', '/sbin', '/bin', 'C:\\Windows'];
const SYSTEM_USERS = new Set(['root', '_windowserver', 'system', 'local service', 'network service']);

export async function scanProcesses(ctx: ScanContext): Promise<ScannerResult & { procs: ProcInfo[] }> {
  if (ctx.root) return { ...emptyResult(), procs: [] }; // sandbox: deterministic no-op

  const result = emptyResult();
  const procs = await listProcesses();
  for (const p of procs) {
    const nodeId = ctx.db.upsertNode('Process', String(p.pid), {
      pid: p.pid,
      name: p.name,
      command: p.command,
      cpuPercent: p.cpuPercent,
      memBytes: p.memBytes,
      user: p.user,
      started: p.started,
    });
    result.scannedFiles++;
    if (p.unnecessary && p.unnecessary.score >= 0.5) {
      const pr = prov(SCANNER, 'proc.unnecessary-heuristic', { reasons: p.unnecessary.reasons, pid: p.pid }, p.unnecessary.score);
      ctx.db.addProvenance('node', nodeId, pr);
      result.candidates.push({
        category: 'process',
        action: 'advise', // killing is always an explicit user action
        subjectKey: String(p.pid),
        subjectType: 'Process',
        label: `Process ${p.name} (pid ${p.pid})`,
        sizeBytes: null,
        smartSelected: false,
        provenance: pr,
        detail: { pid: p.pid, cpuPercent: p.cpuPercent, memBytes: p.memBytes, reasons: p.unnecessary.reasons },
        nodeId,
      });
    }
  }
  return { ...result, procs };
}

/** Full process listing with heuristics (public API for the app / CLI). */
export async function listProcesses(): Promise<ProcInfo[]> {
  let data: Awaited<ReturnType<typeof si.processes>>;
  try {
    data = await si.processes();
  } catch {
    return [];
  }
  const loginItems = await getLoginItems();
  const self = process.pid;
  return data.list
    .filter((p) => p.pid !== self)
    .map((p) => {
      const memBytes = Math.round((p.memRss ?? 0) * 1024);
      const cpuPercent = p.cpu ?? 0;
      const user = p.user ?? null;
      const cmdPath = p.path || p.command || '';
      const isSystem =
        (user !== null && SYSTEM_USERS.has(user.toLowerCase())) ||
        OS_PATH_ALLOWLIST.some((a) => cmdPath.startsWith(a));
      const isLoginItem = loginItems.has((p.name ?? '').toLowerCase());

      let score = 0;
      const reasons: string[] = [];
      if (cpuPercent > 20) {
        score += 0.3;
        reasons.push('high cpu (>20% sustained)');
      }
      if (memBytes > 1024 ** 3) {
        score += 0.3;
        reasons.push('high memory (>1GB)');
      }
      if (!isSystem) {
        score += 0.2;
        reasons.push('not an OS process');
      }
      if (isLoginItem) {
        score += 0.2;
        reasons.push('login item');
      }
      return {
        pid: p.pid,
        name: p.name ?? String(p.pid),
        command: p.command ?? '',
        cpuPercent,
        memBytes,
        user,
        started: p.started ?? null,
        unnecessary: reasons.length > 0 ? { score: Math.min(1, Number(score.toFixed(2))), reasons } : null,
        isLoginItem,
        isSystem,
      } satisfies ProcInfo;
    });
}

/** Best-effort login item names (lowercased). Never throws. */
export async function getLoginItems(): Promise<Set<string>> {
  const items = new Set<string>();
  try {
    if (process.platform === 'darwin') {
      try {
        // BUG-002: a TCC-blocked osascript ignores SIGTERM; execFileBounded
        // sends SIGKILL and hard-settles so `procs list` can never hang.
        const { stdout } = await execFileBounded(
          'osascript',
          ['-e', 'tell application "System Events" to get the name of every login item'],
          { timeout: 4000 },
        );
        for (const name of stdout.split(',')) {
          const n = name.trim().toLowerCase();
          if (n) items.add(n);
        }
      } catch {
        /* automation permission denied — fine */
      }
      // ~/Library/LaunchAgents plists
      try {
        const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
        for (const f of await readdir(dir)) {
          if (!f.endsWith('.plist')) continue;
          const label = f.replace(/\.plist$/, '');
          items.add(label.toLowerCase());
          items.add((label.split('.').pop() ?? label).toLowerCase());
        }
      } catch {
        /* no LaunchAgents */
      }
    } else if (process.platform === 'win32') {
      for (const hive of [
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      ]) {
        try {
          const { stdout } = await execFileBounded('reg.exe', ['query', hive], { timeout: 4000 });
          for (const line of stdout.split(/\r?\n/)) {
            const m = line.match(/^\s{2,}(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+/);
            if (m) items.add(m[1].toLowerCase());
          }
        } catch {
          /* key missing */
        }
      }
    }
  } catch {
    /* never crash */
  }
  return items;
}

/** LaunchAgents plist read helper kept for future startup-disable feature. */
export async function readLaunchAgentLabel(plistPath: string): Promise<string | null> {
  try {
    const raw = await readFile(plistPath, 'utf8');
    const m = raw.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
