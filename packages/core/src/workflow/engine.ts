/**
 * Task-graph workflow engine (deer-workflow style, zero deps).
 *
 * The scan is a DIAMOND:
 *   phase 'scan'  — parallel scanners (a failed scanner resolves to null and
 *                   emits task_failed; SIBLINGS CONTINUE — never fail-fast a
 *                   filesystem walk)
 *   phase 'verify'— independent verifier over all candidates
 *   phase 'merge' — build CleanPlan + persist verdicts
 *   gate_waiting  — the HUMAN GATE (CLI stops; `exec` is a separate command)
 *   phase 'exec'  — executor → receipts
 */
import os from 'node:os';
import type { WorkflowEmitter } from './events.js';

export interface Task<T> {
  name: string;
  run: () => Promise<T>;
}

export interface TaskFailure {
  node: string;
  message: string;
}

/**
 * Run all tasks concurrently. A rejection resolves that slot to null and emits
 * task_failed; sibling tasks keep running to completion (no fail-fast).
 */
export async function parallel<T>(
  emitter: WorkflowEmitter,
  phase: string,
  tasks: Array<Task<T>>,
  failures?: TaskFailure[],
): Promise<Array<T | null>> {
  return Promise.all(
    tasks.map(async (t) => {
      emitter.emit(phase, t.name, 'task_started');
      try {
        const result = await t.run();
        emitter.emit(phase, t.name, 'task_finished');
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures?.push({ node: t.name, message });
        emitter.emit(phase, t.name, 'task_failed', { message });
        return null;
      }
    }),
  );
}

/**
 * Per-item pipeline: each item flows through the stages IN ORDER, but items do
 * not wait for each other (no global barrier between stages). A stage throwing
 * for one item nulls that item's slot; other items continue.
 */
export async function pipeline<I, O = unknown>(
  items: I[],
  stages: Array<(input: any, item: I) => Promise<unknown>>,
  opts: { concurrency?: number; onError?: (item: I, err: unknown) => void } = {},
): Promise<Array<O | null>> {
  const limit = createLimiter(opts.concurrency ?? Math.max(1, os.cpus().length - 1));
  return Promise.all(
    items.map((item) =>
      limit(async () => {
        try {
          let acc: unknown = item;
          for (const stage of stages) acc = await stage(acc, item);
          return acc as O;
        } catch (err) {
          opts.onError?.(item, err);
          return null;
        }
      }),
    ),
  );
}

/** Phase grouping: emits phase_started / phase_finished around fn. */
export async function phase<T>(
  emitter: WorkflowEmitter,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  emitter.emit(name, `phase.${name}`, 'phase_started');
  try {
    return await fn();
  } finally {
    emitter.emit(name, `phase.${name}`, 'phase_finished');
  }
}

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Bounded-concurrency helper (p-limit style, inline). Default cpus-1 — used by
 * the duplicate hasher pool so full-hashing never saturates the machine.
 */
export function createLimiter(concurrency: number = Math.max(1, os.cpus().length - 1)): Limiter {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (v) => {
            next();
            resolve(v);
          },
          (e) => {
            next();
            reject(e);
          },
        );
      };
      if (active < max) run();
      else queue.push(run);
    });
}
