import { useEffect } from 'react';
import type { GraphInsight, Receipt } from '@contracts';
import { useStore } from '../store';
import { fmtBytes, fmtWhen } from '../format';
import { Donut, type DonutSegment } from '../components/Donut';
import { EmptyState, ErrorState } from '../components/States';

const CHART = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

/** Best-effort headline for a canned-insight row of unknown shape. */
function insightText(row: Record<string, unknown>): { head: string; sub: string } {
  const str = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  };
  const num = (keys: string[]): number | null => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === 'number') return v;
    }
    return null;
  };
  const name = str(['app', 'name', 'label', 'owner', 'path']) ?? 'Unknown';
  const bytes = num(['bytes', 'totalBytes', 'sizeBytes', 'size']);
  const count = num(['locations', 'count', 'files', 'paths']);
  const head = bytes !== null
    ? `${name} owns ${fmtBytes(bytes)}${count !== null ? ` across ${count} location${count === 1 ? '' : 's'}` : ''}`
    : name;
  const sub = str(['detail', 'paths', 'examples', 'note']) ?? '';
  return { head, sub };
}

function InsightCard({
  tag,
  insight,
  linkLabel,
  onLink,
}: {
  tag: string;
  insight: GraphInsight | undefined;
  linkLabel: string;
  onLink: () => void;
}): JSX.Element {
  const row = insight?.rows?.[0];
  const parsed = row ? insightText(row) : null;
  return (
    <div className="card insight">
      <span className="tag">{tag}</span>
      {parsed ? (
        <>
          <b>{parsed.head}</b>
          {parsed.sub && <span className="sec">{parsed.sub}</span>}
        </>
      ) : (
        <span className="sec">No data yet — run a scan to populate the graph.</span>
      )}
      <button className="link" onClick={onLink}>
        {linkLabel} →
      </button>
    </div>
  );
}

function ReceiptRow({ r }: { r: Receipt }): JSX.Element {
  const undoReceipt = useStore((s) => s.undoReceipt);
  const undoable = r.ok && r.trashRef !== null;
  return (
    <tr>
      <td className="num sec">{fmtWhen(r.executedAt)}</td>
      <td>{r.action}</td>
      <td className="sec">
        {r.path ?? '—'}{' '}
        <span className="mono muted">#{r.id}</span>
      </td>
      <td className="num" style={{ textAlign: 'right' }}>
        {fmtBytes(r.bytesFreed)}
      </td>
      <td>
        {r.ok ? (
          <span className="pill ok">✓ ok</span>
        ) : (
          <span className="pill fail" title={r.error ?? undefined}>
            ✕ {r.error ? r.error.slice(0, 40) : 'failed'}
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <button
          className="btn sm"
          disabled={!undoable}
          title={undoable ? undefined : 'Not undoable (no trash reference)'}
          onClick={() => void undoReceipt(r.id)}
        >
          Undo
        </button>
      </td>
    </tr>
  );
}

export function Dashboard(): JSX.Element {
  const disk = useStore((s) => s.disk);
  const diskError = useStore((s) => s.diskError);
  const receipts = useStore((s) => s.receipts);
  const insights = useStore((s) => s.insights);
  const setView = useStore((s) => s.setView);
  const loadDisk = useStore((s) => s.loadDisk);
  const loadReceipts = useStore((s) => s.loadReceipts);
  const loadInsight = useStore((s) => s.loadInsight);

  useEffect(() => {
    void loadDisk();
    void loadReceipts();
    void loadInsight('top-space-owners');
    void loadInsight('app-cache-aggregation');
    void loadInsight('orphaned-files');
  }, [loadDisk, loadReceipts, loadInsight]);

  const recent = (receipts ?? []).slice(0, 6);

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>Dashboard</h1>
          <span className="sec">
            {disk ? `${disk.volumes.length} volume${disk.volumes.length === 1 ? '' : 's'} tracked` : 'Engine status below'}
          </span>
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={() => setView('smart-clean')}>
          ✦ Quick Scan
        </button>
      </div>

      {diskError && <ErrorState node="disk.status" message={diskError} />}

      {disk && disk.volumes.length > 0 ? (
        <div className="grid2">
          {disk.volumes.slice(0, 4).map((v, vi) => {
            let segments: DonutSegment[];
            if (vi === 0 && disk.breakdown.length > 0) {
              const top = [...disk.breakdown].sort((a, b) => b.bytes - a.bytes).slice(0, 4);
              const rest = Math.max(0, v.usedBytes - top.reduce((s, d) => s + d.bytes, 0));
              segments = top.map((d, i) => ({ label: d.path, bytes: d.bytes, color: CHART[i] }));
              if (rest > 0) segments.push({ label: 'Other', bytes: rest, color: CHART[4] });
            } else {
              segments = [{ label: 'Used', bytes: v.usedBytes, color: CHART[0] }];
            }
            return (
              <Donut
                key={v.mount}
                title={v.label || v.mount}
                totalBytes={v.sizeBytes}
                usedBytes={v.usedBytes}
                segments={segments}
              />
            );
          })}
        </div>
      ) : !diskError ? (
        <EmptyState
          title="No volume data yet"
          body="The engine populates disk usage on first launch. If the engine is still building, this fills in automatically."
        />
      ) : null}

      <div className="insights">
        <InsightCard
          tag="Cache aggregation"
          insight={insights['app-cache-aggregation']}
          linkLabel="Review in Smart Clean"
          onLink={() => setView('smart-clean')}
        />
        <InsightCard
          tag="Top space owner"
          insight={insights['top-space-owners']}
          linkLabel="See large files"
          onLink={() => setView('large-files')}
        />
        <InsightCard
          tag="Orphaned files"
          insight={insights['orphaned-files']}
          linkLabel="Open Uninstaller"
          onLink={() => setView('uninstaller')}
        />
      </div>

      <div className="sect">
        <h2>Recent receipts</h2>
        {recent.length > 0 ? (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Detail</th>
                  <th style={{ textAlign: 'right' }}>Freed</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <ReceiptRow r={r} key={r.id} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card">
            <EmptyState
              icon="✎"
              title="No receipts yet"
              body="Every executed action writes a receipt with one-click Undo. They will appear here."
            />
          </div>
        )}
        <p className="muted" style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>
          Every receipt keeps its Trash reference until you empty the Trash — Undo restores files to
          their original path.
        </p>
      </div>
    </div>
  );
}
