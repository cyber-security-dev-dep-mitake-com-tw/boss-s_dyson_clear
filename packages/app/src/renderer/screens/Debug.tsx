/**
 * Debug (beta channel only) — environment info, live engine log, self-test and
 * bug-report export. Rendered only when window.sweepdeckDebug exists, which the
 * preload exposes only in __SWEEPDECK_BETA__ builds.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DebugLogEntry, SelfTestReport } from '../global';
import { EmptyState } from '../components/States';

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export function Debug(): JSX.Element {
  const api = window.sweepdeckDebug;
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<(typeof LEVELS)[number]>('info');
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.info().then(setInfo).catch((e: unknown) => setNote(String(e)));
    void api.logs().then(setLogs);
    return api.onLog((entry) => setLogs((prev) => [...prev.slice(-1999), entry]));
  }, [api]);

  const shown = useMemo(() => {
    const max = LEVELS.indexOf(minLevel);
    return logs.filter((l) => LEVELS.indexOf(l.level) <= max).slice(-300).reverse();
  }, [logs, minLevel]);
  const errorCount = logs.filter((l) => l.level === 'error').length;

  if (!api) {
    return <EmptyState icon="⚠" title="Debug tools unavailable" body="This is a production build." />;
  }

  const runSelfTest = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      setReport(await api.selfTest());
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportReport = async (): Promise<void> => {
    const res = await api.exportReport();
    setNote(res.ok ? `Bug report written to ${res.path}` : `Export failed: ${res.error}`);
  };

  const { rawDisk, ...env } = info ?? {};

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>
            Debug <span className="pill fail">BETA</span>
          </h1>
          <span className="sec">Beta-channel diagnostics — not present in production builds.</span>
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => void exportReport()}>
          Export bug report
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void runSelfTest()}>
          {busy ? 'Running…' : 'Run self-test'}
        </button>
      </div>

      {note && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <span className="mono sec">{note}</span>
        </div>
      )}

      {report && (
        <div className="sect">
          <h2>
            Self-test{' '}
            <span className={`pill ${report.ok ? 'ok' : 'fail'}`}>{report.ok ? '✓ pass' : '✕ fail'}</span>
          </h2>
          <div className="card" style={{ overflow: 'hidden' }}>
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>{c.ok ? <span className="pill ok">✓</span> : <span className="pill fail">✕</span>}</td>
                    <td className="sec" style={{ wordBreak: 'break-word' }}>
                      {c.detail}
                    </td>
                  </tr>
                ))}
                {report.errorsLogged.map((e, i) => (
                  <tr key={`err-${i}`}>
                    <td className="mono">{e.source}</td>
                    <td>
                      <span className="pill fail">error</span>
                    </td>
                    <td className="sec">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.reportPath && <p className="muted mono">{report.reportPath}</p>}
        </div>
      )}

      <div className="sect">
        <h2>Environment</h2>
        <div className="card" style={{ padding: 12 }}>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 'var(--fs-xs)' }}>
            {info ? JSON.stringify(env, null, 2) : 'loading…'}
          </pre>
        </div>
        <details className="card" style={{ padding: 12, marginTop: 8 }}>
          <summary>Raw disk inputs (systeminformation fsSize + diskutil)</summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-xs)' }}>
            {JSON.stringify(rawDisk ?? null, null, 2)}
          </pre>
        </details>
      </div>

      <div className="sect">
        <h2>
          Engine log <span className="muted">· {errorCount} error(s)</span>
        </h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {LEVELS.map((l) => (
            <button key={l} className={`btn sm ${minLevel === l ? 'primary' : ''}`} onClick={() => setMinLevel(l)}>
              {l}
            </button>
          ))}
        </div>
        <div className="card" style={{ maxHeight: 360, overflow: 'auto', padding: 8 }}>
          {shown.length === 0 ? (
            <span className="muted">No entries at this level.</span>
          ) : (
            shown.map((l, i) => (
              <div key={i} className="mono" style={{ fontSize: 'var(--fs-xs)', padding: '2px 0' }}>
                <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span>{' '}
                <span className={`pill ${l.level === 'error' ? 'fail' : l.level === 'warn' ? 'undone' : 'ok'}`}>{l.level}</span>{' '}
                <b>{l.source}</b> {l.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
