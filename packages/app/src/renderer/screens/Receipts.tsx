/** Receipts & Undo — the full append-only receipt log with per-receipt Undo. */
import { useEffect } from 'react';
import { useStore } from '../store';
import { fmtBytes, fmtWhen } from '../format';
import { EmptyState } from '../components/States';

export function Receipts(): JSX.Element {
  const receipts = useStore((s) => s.receipts);
  const loadReceipts = useStore((s) => s.loadReceipts);
  const undoReceipt = useStore((s) => s.undoReceipt);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  const list = receipts ?? [];

  return (
    <div>
      <h1>Receipts &amp; Undo</h1>
      <p className="sec">
        Every executed action — success or failure — produces exactly one receipt. Undo restores
        from the recorded Trash reference to the original path; it never overwrites.
      </p>

      {list.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon="✎"
            title="No receipts yet"
            body="Receipts appear here the first time an approved plan executes."
          />
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Action</th>
                <th>Path</th>
                <th style={{ textAlign: 'right' }}>Freed</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const undoable = r.ok && r.trashRef !== null;
                return (
                  <tr key={r.id}>
                    <td className="num sec">#{r.id}</td>
                    <td className="num sec">{fmtWhen(r.executedAt)}</td>
                    <td>{r.action}</td>
                    <td className="path">{r.path ?? '—'}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {fmtBytes(r.bytesFreed)}
                    </td>
                    <td>
                      {r.ok ? (
                        <span className="pill ok">✓ ok</span>
                      ) : (
                        <span className="pill fail" title={r.error ?? undefined}>
                          ✕ failed
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
