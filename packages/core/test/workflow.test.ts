import { describe, it, expect } from 'vitest';
import { parallel, pipeline, phase, createLimiter, type TaskFailure } from '../src/workflow/engine.js';
import { WorkflowEmitter } from '../src/workflow/events.js';
import type { WorkflowEvent } from '../src/contracts.js';

function recorder(): { emitter: WorkflowEmitter; events: WorkflowEvent[] } {
  const events: WorkflowEvent[] = [];
  const emitter = new WorkflowEmitter('run-1', (ev) => events.push(ev));
  return { emitter, events };
}

describe('parallel', () => {
  it('a rejected task resolves to null and SIBLINGS CONTINUE', async () => {
    const { emitter, events } = recorder();
    const failures: TaskFailure[] = [];
    let slowFinished = false;
    const results = await parallel(
      emitter,
      'scan',
      [
        { name: 'a', run: async () => 'A' },
        {
          name: 'boom',
          run: async () => {
            throw new Error('EACCES wall');
          },
        },
        {
          name: 'slow',
          run: async () => {
            await new Promise((r) => setTimeout(r, 30));
            slowFinished = true;
            return 'SLOW';
          },
        },
      ],
      failures,
    );
    expect(results).toEqual(['A', null, 'SLOW']);
    expect(slowFinished).toBe(true); // no fail-fast
    expect(failures).toEqual([{ node: 'boom', message: 'EACCES wall' }]);
    const failedEv = events.find((e) => e.type === 'task_failed');
    expect(failedEv?.node).toBe('boom');
    expect(events.filter((e) => e.type === 'task_finished').map((e) => e.node).sort()).toEqual(['a', 'slow']);
  });
});

describe('pipeline', () => {
  it('runs stages in order per item without a global barrier', async () => {
    const log: string[] = [];
    const results = await pipeline<number, string>(
      [1, 2, 3],
      [
        async (n: number) => {
          // stagger so a global barrier would reorder stage entries
          await new Promise((r) => setTimeout(r, (4 - n) * 10));
          log.push(`s1:${n}`);
          return n * 10;
        },
        async (n: number, item) => {
          log.push(`s2:${item}`);
          return `item${item}=${n}`;
        },
      ],
      { concurrency: 3 },
    );
    expect(results).toEqual(['item1=10', 'item2=20', 'item3=30']);
    // per-item ordering: s1:i always precedes s2:i
    for (const i of [1, 2, 3]) {
      expect(log.indexOf(`s1:${i}`)).toBeLessThan(log.indexOf(`s2:${i}`));
    }
    // no global barrier: item 3 finishes stage 2 before item 1 finishes stage 1
    expect(log.indexOf('s2:3')).toBeLessThan(log.indexOf('s1:1'));
  });

  it('a stage error nulls that item only', async () => {
    const results = await pipeline<number, number>(
      [1, 2],
      [
        async (n: number) => {
          if (n === 1) throw new Error('bad item');
          return n;
        },
      ],
    );
    expect(results).toEqual([null, 2]);
  });
});

describe('phase + event sequence', () => {
  it('emits phase_started/phase_finished around the body, even on throw', async () => {
    const { emitter, events } = recorder();
    await phase(emitter, 'scan', async () => {
      emitter.emit('scan', 'scanner.x', 'task_started');
      emitter.emit('scan', 'scanner.x', 'task_finished');
    });
    await expect(phase(emitter, 'verify', async () => Promise.reject(new Error('x')))).rejects.toThrow();
    const types = events.map((e) => `${e.phase}:${e.type}`);
    expect(types).toEqual([
      'scan:phase_started',
      'scan:task_started',
      'scan:task_finished',
      'scan:phase_finished',
      'verify:phase_started',
      'verify:phase_finished', // finally-guaranteed
    ]);
    for (const ev of events) {
      expect(ev.runId).toBe('run-1');
      expect(typeof ev.ts).toBe('number');
    }
  });
});

describe('createLimiter', () => {
  it('bounds concurrency', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});
