/**
 * ProgressStream — phase chips scan → verify → merge → gate → exec with live
 * counters fed by WorkflowEvents, plus the latest event as a mono ticker line.
 * Scans are never spinners (DESIGN-NOTES).
 */
import { PHASE_ORDER, useStore, type PhaseInfo } from '../store';

const PHASE_LABEL: Record<string, string> = {
  scan: 'Scan',
  verify: 'Verify',
  merge: 'Merge plan',
  gate: 'Gate',
  exec: 'Execute',
};

function phaseRow(name: string, info: PhaseInfo | undefined, active: boolean): JSX.Element {
  const state = info?.state ?? 'wait';
  const pct =
    info && info.total > 0 ? Math.min(100, Math.round((info.done / info.total) * 100)) : null;
  return (
    <div className="phase" key={name}>
      <span className="name">
        <span
          className={`st ${state}`}
          aria-label={state === 'run' ? 'running' : state}
        >
          {state === 'done' ? '✓' : state === 'failed' ? '!' : ''}
        </span>
        {PHASE_LABEL[name] ?? name}
      </span>
      <div className="bar">
        {state === 'done' ? (
          <i className="ok" style={{ width: '100%' }} />
        ) : state === 'run' ? (
          pct !== null ? (
            <i style={{ width: `${pct}%` }} />
          ) : (
            <i className="indet" />
          )
        ) : null}
      </div>
      <span className={`num ${state === 'wait' ? 'muted' : 'sec'}`} style={{ textAlign: 'right' }}>
        {state === 'wait'
          ? active
            ? 'waiting'
            : ''
          : state === 'done'
            ? info && info.total > 0
              ? `${info.total.toLocaleString()} done`
              : 'done'
            : pct !== null
              ? `${pct}%`
              : `${(info?.done ?? 0).toLocaleString()}`}
      </span>
    </div>
  );
}

export function ProgressStream({ phases: names }: { phases?: readonly string[] }): JSX.Element {
  const phases = useStore((s) => s.phases);
  const lastEvent = useStore((s) => s.lastEvent);
  const shown = names ?? PHASE_ORDER.slice(0, 3); // scan/verify/merge by default

  return (
    <div className="card">
      <div className="phases">{shown.map((n) => phaseRow(n, phases[n], true))}</div>
      <div className="evt" aria-live="polite">
        {lastEvent
          ? `${lastEvent.type} · ${lastEvent.phase} · ${lastEvent.node}${summarize(lastEvent.data)}`
          : 'waiting for engine events…'}
      </div>
    </div>
  );
}

function summarize(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${v}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? ` · ${parts.join(' ')}` : '';
}
