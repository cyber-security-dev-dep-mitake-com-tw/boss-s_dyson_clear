#!/usr/bin/env node
/**
 * sweepdeck-core — headless CLI (the Robot Framework test target).
 *
 *   scan  --categories junk,large,duplicate [--root <dir>] --db <file> --json
 *   plan  --run <runId> --db <file> --json
 *   exec  --plan <planId> --approve-ids 1,2 --db <file> --json [--dry-run]
 *   apps  list --json | uninstall --key <k> --json
 *   procs list --json | kill --pid <n> --json
 *   disk  status --json
 *   undo  --receipt <id> --db <file> --json
 *
 * Exit codes: 0 ok, 1 unexpected error, 2 refused (missing approval /
 * protected path). `exec` REFUSES without --approve-ids: the human gate.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GraphStore } from './graph/store.js';
import { jsonlSink } from './workflow/events.js';
import { runScan, execPlan, ApprovalRequiredError, ALL_CATEGORIES } from './run.js';
import { DEFAULT_LARGE_THRESHOLD } from './scanners/largefiles.js';
import { scanApps } from './scanners/apps.js';
import { listProcesses } from './scanners/processes.js';
import { getDiskStatus } from './scanners/disk.js';
import { checkProtectedPath } from './verifier/rules.js';
import { undoReceipt } from './executor/receipts.js';
import { uninstallApp } from './executor/uninstaller.js';
import { killProcess } from './executor/prockiller.js';
import { WorkflowEmitter } from './workflow/events.js';
import { CLI_EXIT, type ScanCategory } from './contracts.js';

interface Flags {
  json: boolean;
  db: string;
  root?: string;
  categories?: string;
  largeThreshold?: string;
  dryRun: boolean;
  approveIds?: string;
  run?: string;
  plan?: string;
  receipt?: string;
  key?: string;
  pid?: string;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Thrown to unwind to the single exit point (which flushes stdout first). */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fail(code: number, error: string, json: boolean): never {
  if (json) out({ error });
  else process.stderr.write(`error: ${error}\n`);
  throw new CliExit(code);
}

function parse(argv: string[]): { command: string; sub: string | null; flags: Flags } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      db: { type: 'string', default: path.join(os.homedir(), '.sweepdeck', 'graph.db') },
      root: { type: 'string' },
      categories: { type: 'string' },
      'large-threshold': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'approve-ids': { type: 'string' },
      run: { type: 'string' },
      plan: { type: 'string' },
      receipt: { type: 'string' },
      key: { type: 'string' },
      pid: { type: 'string' },
    },
  });
  return {
    command: positionals[0] ?? '',
    sub: positionals[1] ?? null,
    flags: {
      json: values.json ?? false,
      db: values.db!,
      root: values.root,
      categories: values.categories,
      largeThreshold: values['large-threshold'],
      dryRun: values['dry-run'] ?? false,
      approveIds: values['approve-ids'],
      run: values.run,
      plan: values.plan,
      receipt: values.receipt,
      key: values.key,
      pid: values.pid,
    },
  };
}

function parseCategories(s: string | undefined, json: boolean): ScanCategory[] | undefined {
  if (!s) return undefined;
  const cats = s.split(',').map((c) => c.trim()).filter(Boolean);
  for (const c of cats) {
    if (!(ALL_CATEGORIES as string[]).includes(c)) fail(CLI_EXIT.ERROR, `unknown category: ${c}`, json);
  }
  return cats as ScanCategory[];
}

function validateRoot(root: string | undefined, json: boolean): string | undefined {
  if (root === undefined) return undefined;
  const resolved = path.resolve(root);
  const check = checkProtectedPath(resolved, { appDirs: [] });
  if (!check.ok) {
    fail(CLI_EXIT.REFUSED, `refusing to scan protected root: ${resolved} (${check.reason})`, json);
  }
  if (!existsSync(resolved)) fail(CLI_EXIT.ERROR, `root does not exist: ${resolved}`, json);
  return resolved;
}

async function main(): Promise<number> {
  const { command, sub, flags } = parse(process.argv.slice(2));
  const json = flags.json;

  switch (command) {
    case 'scan': {
      const root = validateRoot(flags.root, json);
      const db = new GraphStore(flags.db);
      try {
        const threshold = flags.largeThreshold ? Number(flags.largeThreshold) : DEFAULT_LARGE_THRESHOLD;
        if (!Number.isFinite(threshold) || threshold <= 0) {
          fail(CLI_EXIT.ERROR, `invalid --large-threshold: ${flags.largeThreshold}`, json);
        }
        const sink = json ? jsonlSink(process.stdout) : () => void 0;
        const summary = await runScan(
          {
            db,
            root,
            categories: parseCategories(flags.categories, json),
            largeThresholdBytes: threshold,
          },
          sink,
        );
        if (json) {
          out({ type: 'summary', summary });
        } else {
          process.stdout.write(
            `run ${summary.runId}: scanned ${summary.scannedFiles} files, ` +
              `${summary.candidateCount} candidates, ${summary.reclaimableBytes} bytes reclaimable` +
              (summary.planId ? `\nplan: ${summary.planId} (run \`sweepdeck-core exec --plan ${summary.planId} --approve-ids ...\` to clean)` : '') +
              '\n',
          );
        }
        return CLI_EXIT.OK;
      } finally {
        db.close();
      }
    }

    case 'plan': {
      const ref = flags.run ?? flags.plan;
      if (!ref) fail(CLI_EXIT.ERROR, 'plan requires --run <runId> (or --plan <planId>)', json);
      const db = new GraphStore(flags.db);
      try {
        const plan = db.getPlan(ref);
        if (!plan) fail(CLI_EXIT.ERROR, `no plan for: ${ref}`, json);
        if (json) out(plan);
        else {
          process.stdout.write(`plan ${plan.planId} (run ${plan.runId}): ${plan.verdicts.length} verdicts, ${plan.totalReclaimableBytes} bytes\n`);
          for (const v of plan.verdicts) {
            process.stdout.write(`  #${v.id} [${v.status}] ${v.action} ${v.category}: ${v.subjectKey} (${v.sizeBytes ?? '?'} bytes)\n`);
          }
        }
        return CLI_EXIT.OK;
      } finally {
        db.close();
      }
    }

    case 'exec': {
      if (!flags.plan) fail(CLI_EXIT.ERROR, 'exec requires --plan <planId>', json);
      const ids = (flags.approveIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n));
      if (ids.length === 0) {
        // THE HUMAN GATE — refuse without explicit approvals
        out({ error: 'approval required' });
        return CLI_EXIT.REFUSED;
      }
      const root = validateRoot(flags.root, json);
      const db = new GraphStore(flags.db);
      try {
        const result = await execPlan({
          db,
          planId: flags.plan,
          approveIds: ids,
          dryRun: flags.dryRun,
          root,
        });
        if (json) out(result);
        else process.stdout.write(`executed ${result.executed}, failed ${result.failed}, freed ${result.bytesFreed} bytes\n`);
        return CLI_EXIT.OK;
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          out({ error: 'approval required' });
          return CLI_EXIT.REFUSED;
        }
        throw err;
      } finally {
        db.close();
      }
    }

    case 'apps': {
      const root = validateRoot(flags.root, json);
      const db = new GraphStore(flags.db);
      try {
        if (sub === 'list' || sub === null) {
          const emitter = new WorkflowEmitter('apps-list', () => void 0);
          const { apps } = await scanApps({ root, db, emit: emitter, largeThresholdBytes: DEFAULT_LARGE_THRESHOLD });
          if (json) out(apps);
          else for (const a of apps) process.stdout.write(`${a.name}\t${a.version ?? '?'}\t${a.key}\n`);
          return CLI_EXIT.OK;
        }
        if (sub === 'uninstall') {
          if (!flags.key) fail(CLI_EXIT.ERROR, 'apps uninstall requires --key <bundleId|uninstallKey>', json);
          // make sure the graph knows this app (fresh db case)
          const emitter = new WorkflowEmitter('apps-uninstall', () => void 0);
          await scanApps({ root, db, emit: emitter, largeThresholdBytes: DEFAULT_LARGE_THRESHOLD });
          const res = await uninstallApp(db, flags.key, { root });
          if (json) out(res);
          else process.stdout.write(res.ok ? `uninstalled ${flags.key}\n` : `failed: ${res.error ?? 'see receipts'}\n`);
          return res.ok ? CLI_EXIT.OK : CLI_EXIT.ERROR;
        }
        fail(CLI_EXIT.ERROR, `unknown apps subcommand: ${sub}`, json);
        break;
      } finally {
        db.close();
      }
    }

    case 'procs': {
      if (sub === 'list' || sub === null) {
        const procs = await listProcesses();
        if (json) out(procs);
        else for (const p of procs.slice(0, 30)) process.stdout.write(`${p.pid}\t${p.cpuPercent.toFixed(1)}%\t${(p.memBytes / 1048576).toFixed(0)}MB\t${p.name}\n`);
        return CLI_EXIT.OK;
      }
      if (sub === 'kill') {
        const pid = Number(flags.pid);
        if (!flags.pid || !Number.isInteger(pid)) fail(CLI_EXIT.ERROR, 'procs kill requires --pid <n>', json);
        const res = await killProcess(pid);
        if (json) out(res);
        else process.stdout.write(res.ok ? `killed ${pid}\n` : `refused/failed: ${res.error}\n`);
        return res.ok ? CLI_EXIT.OK : CLI_EXIT.REFUSED;
      }
      fail(CLI_EXIT.ERROR, `unknown procs subcommand: ${sub}`, json);
      break;
    }

    case 'disk': {
      if (sub === 'status' || sub === null) {
        const root = validateRoot(flags.root, json);
        const status = await getDiskStatus(root);
        if (json) out(status);
        else {
          for (const v of status.volumes) {
            process.stdout.write(`${v.mount}\t${v.fsType}\t${(v.usedBytes / 1e9).toFixed(1)}/${(v.sizeBytes / 1e9).toFixed(1)} GB (${v.usePercent.toFixed(0)}%)\n`);
          }
          process.stdout.write(`trim: ${status.trimAdvice.message}\n`);
        }
        return CLI_EXIT.OK;
      }
      fail(CLI_EXIT.ERROR, `unknown disk subcommand: ${sub}`, json);
      break;
    }

    case 'undo': {
      const id = Number(flags.receipt);
      if (!flags.receipt || !Number.isInteger(id)) fail(CLI_EXIT.ERROR, 'undo requires --receipt <id>', json);
      const db = new GraphStore(flags.db);
      try {
        const res = await undoReceipt(db, id);
        if (json) out(res);
        else process.stdout.write(res.ok ? `restored receipt ${id}\n` : `undo failed: ${res.error}\n`);
        return res.ok ? CLI_EXIT.OK : CLI_EXIT.ERROR;
      } finally {
        db.close();
      }
    }

    default:
      fail(
        CLI_EXIT.ERROR,
        `unknown command: ${command || '(none)'} — expected scan|plan|exec|apps|procs|disk|undo`,
        json,
      );
  }
  return CLI_EXIT.ERROR;
}

/** Exit only after stdout has drained — process.exit() would truncate piped JSON. */
function flushAndExit(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

main().then(
  (code) => flushAndExit(code),
  (err) => {
    if (err instanceof CliExit) {
      flushAndExit(err.code);
      return;
    }
    process.stdout.write(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) + '\n');
    flushAndExit(CLI_EXIT.ERROR);
  },
);
