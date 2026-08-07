/**
 * Workflow event stream — every engine step is observable as a WorkflowEvent.
 * Sinks: JSONL on stdout (CLI / Robot Framework) or a callback (Electron main
 * forwards over the 'workflow:event' IPC channel).
 */
import type { Writable } from 'node:stream';
import type { WorkflowEvent, WorkflowEventType } from '../contracts.js';

export type EventSink = (ev: WorkflowEvent) => void;

/** Sink that writes one JSON object per line. */
export function jsonlSink(stream: Writable = process.stdout): EventSink {
  return (ev) => {
    stream.write(JSON.stringify(ev) + '\n');
  };
}

/** Sink that forwards to a callback (used by Electron main over IPC). */
export function callbackSink(cb: (ev: WorkflowEvent) => void): EventSink {
  return cb;
}

/** Fan a single event out to several sinks. */
export function teeSink(...sinks: EventSink[]): EventSink {
  return (ev) => {
    for (const s of sinks) s(ev);
  };
}

/** Bound emitter for one run — stamps ts/runId on every event. */
export class WorkflowEmitter {
  readonly events: WorkflowEvent[] = [];

  constructor(
    readonly runId: string,
    private readonly sink: EventSink,
    private readonly record = false,
  ) {}

  emit(phase: string, node: string, type: WorkflowEventType, data: Record<string, unknown> = {}): void {
    const ev: WorkflowEvent = { ts: Date.now(), runId: this.runId, phase, node, type, data };
    if (this.record) this.events.push(ev);
    this.sink(ev);
  }
}
