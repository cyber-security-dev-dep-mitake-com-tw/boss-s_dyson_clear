/**
 * Processes — cpu/mem/unnecessary sortable table, score bars with reasons
 * tooltip, per-row kill behind the confirm-modal gate, login-items section.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { ProcInfo } from '@contracts';
import { useStore } from '../store';
import { fmtBytes } from '../format';
import { Modal } from '../components/Modal';
import { VirtualTable } from '../components/VirtualTable';
import { ErrorState, SkeletonRows } from '../components/States';

type SortKey = 'cpu' | 'mem' | 'score' | 'name';

function scoreColor(score: number): string {
  if (score >= 0.7) return 'var(--conf-low)';
  if (score >= 0.4) return 'var(--conf-med)';
  return 'var(--conf-high)';
}

function ScoreCell({ p }: { p: ProcInfo }): JSX.Element {
  if (p.isSystem || !p.unnecessary) {
    return <span className="muted">— system</span>;
  }
  const s = p.unnecessary.score;
  return (
    <span className="score">
      <span className="sbar">
        <i style={{ width: `${Math.round(s * 100)}%`, background: scoreColor(s) }} />
      </span>
      {p.unnecessary.reasons.length > 0 ? (
        <span className="tip num" tabIndex={0}>
          {s.toFixed(2)}
          <span className="bubble" role="tooltip">
            <b>Why {s.toFixed(2)} unnecessary?</b>
            <ul>
              {p.unnecessary.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <span className="prov">proc-analyzer heuristic · best-effort, downgrades only</span>
          </span>
        </span>
      ) : (
        <span className="sec num">{s.toFixed(2)}</span>
      )}
    </span>
  );
}

export function Processes(): JSX.Element {
  const procs = useStore((s) => s.procs);
  const procsError = useStore((s) => s.procsError);
  const loadProcs = useStore((s) => s.loadProcs);
  const killProc = useStore((s) => s.killProc);
  const setToast = useStore((s) => s.setToast);

  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDesc, setSortDesc] = useState(true);
  const [victim, setVictim] = useState<ProcInfo | null>(null);
  const [killing, setKilling] = useState(false);
  const titleId = useId();

  // refresh every 3 s while mounted; paused while a kill confirm is open.
  useEffect(() => {
    void loadProcs();
    const t = setInterval(() => {
      if (!victim) void loadProcs();
    }, 3000);
    return () => clearInterval(t);
  }, [loadProcs, victim]);

  const rows = useMemo(() => {
    const list = procs ?? [];
    const dir = sortDesc ? -1 : 1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'cpu':
          return dir * (a.cpuPercent - b.cpuPercent);
        case 'mem':
          return dir * (a.memBytes - b.memBytes);
        case 'score':
          return dir * ((a.unnecessary?.score ?? -1) - (b.unnecessary?.score ?? -1));
        default:
          return dir * b.name.localeCompare(a.name);
      }
    });
  }, [procs, sortKey, sortDesc]);

  const loginItems = useMemo(() => (procs ?? []).filter((p) => p.isLoginItem), [procs]);

  const sortHeader = (key: SortKey, label: string): JSX.Element => (
    <th
      className={`sortable ${sortKey === key ? 'sorted' : ''}`}
      aria-sort={sortKey === key ? (sortDesc ? 'descending' : 'ascending') : 'none'}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else {
          setSortKey(key);
          setSortDesc(true);
        }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  const doKill = async (): Promise<void> => {
    if (!victim) return;
    setKilling(true);
    const res = await killProc(victim.pid);
    setKilling(false);
    setVictim(null);
    setToast(
      res.ok
        ? {
            kind: 'success',
            title: `${victim.name} terminated`,
            detail: `${fmtBytes(victim.memBytes)} freed · kill logged to receipts (kills cannot be undone)`,
          }
        : { kind: 'error', title: `Could not kill ${victim.name}`, detail: res.error ?? 'unknown error' },
    );
  };

  return (
    <div>
      <h1>Processes</h1>
      <p className="sec">
        {(procs ?? []).length} processes · refreshed every 3 s. System processes are dimmed and
        cannot be killed from here.
      </p>

      {procsError && <ErrorState node="procs.list" message={procsError} />}

      <div className="card" style={{ overflow: 'visible', marginTop: 16 }}>
        {!procs ? (
          <SkeletonRows rows={8} />
        ) : (
          <VirtualTable
            rows={rows}
            rowHeight={48}
            maxHeight={480}
            header={
              <tr>
                <th>Name</th>
                <th>PID</th>
                {sortHeader('cpu', 'CPU %')}
                {sortHeader('mem', 'Memory')}
                {sortHeader('score', 'Unnecessary')}
                <th>User</th>
                <th />
              </tr>
            }
            renderRow={(p: ProcInfo) => (
              <tr key={p.pid} className={p.isSystem ? 'sys' : ''} style={{ height: 48 }}>
                <td>
                  <b>{p.name}</b>
                  {p.isLoginItem && (
                    <>
                      {' '}
                      <span className="badge conf-low" style={{ fontSize: 10 }}>
                        login item
                      </span>
                    </>
                  )}
                </td>
                <td className="num sec">{p.pid}</td>
                <td className="num">{p.cpuPercent.toFixed(1)}</td>
                <td className="num">{fmtBytes(p.memBytes)}</td>
                <td>
                  <ScoreCell p={p} />
                </td>
                <td className="sec">{p.user ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className={`btn sm ${p.isSystem ? '' : 'danger-ghost'}`}
                    disabled={p.isSystem}
                    title={p.isSystem ? 'System process — protected' : undefined}
                    onClick={() => setVictim(p)}
                  >
                    Kill…
                  </button>
                </td>
              </tr>
            )}
          />
        )}
      </div>

      <div className="sect">
        <h2>
          Startup items{' '}
          <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--fs-sm)' }}>
            — detected login items; toggling ships after v1 (engine has no disable channel yet)
          </span>
        </h2>
        <div className="card">
          {loginItems.length === 0 ? (
            <div className="sitem">
              <span className="muted">No login items detected among running processes.</span>
            </div>
          ) : (
            loginItems.map((p) => (
              <div className="sitem" key={p.pid}>
                <span className="grow">
                  <b>{p.name}</b>
                  <br />
                  <span className="muted mono">{p.command}</span>
                </span>
                {p.unnecessary && p.unnecessary.score >= 0.7 && (
                  <span className="sec" style={{ color: '#f0a184' }}>
                    flagged: {p.unnecessary.reasons[0] ?? 'likely unnecessary'}
                  </span>
                )}
                <button
                  className="switch"
                  role="switch"
                  aria-checked="true"
                  aria-label={`${p.name} enabled`}
                  disabled
                  title="Startup-item toggling is not available in v1"
                />
              </div>
            ))
          )}
        </div>
      </div>

      {victim && (
        <Modal titleId={titleId} onClose={() => setVictim(null)}>
          <h3 id={titleId}>
            Kill {victim.name} (pid {victim.pid})?
          </h3>
          <span className="sec">Exactly what will happen:</span>
          <ul className="what">
            <li>
              <span className="tick">✓</span>
              <span>SIGTERM is sent first; SIGKILL only if it is ignored</span>
            </li>
            <li>
              <span className="tick">✓</span>
              <span>Frees ~{fmtBytes(victim.memBytes)} of memory now</span>
            </li>
            {victim.isLoginItem && (
              <li>
                <span className="warn">⚠</span>
                <span>It is a login item, so it returns at next login</span>
              </li>
            )}
            <li>
              <span className="warn">⚠</span>
              <span>The kill is logged to a receipt — kills cannot be undone, only logged</span>
            </li>
          </ul>
          <div className="actions">
            <button className="btn" onClick={() => setVictim(null)}>
              Cancel
            </button>
            <button className="btn danger" disabled={killing} onClick={() => void doKill()}>
              {killing ? 'Killing…' : 'Kill process'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
