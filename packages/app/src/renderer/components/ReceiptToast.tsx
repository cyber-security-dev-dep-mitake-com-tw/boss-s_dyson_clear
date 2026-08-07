import { useEffect } from 'react';
import { useStore } from '../store';

/** Success/error toast; persists 10 s; Undo right in the toast. */
export function ReceiptToast(): JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const setToast = useStore((s) => s.setToast);
  const undoReceipt = useStore((s) => s.undoReceipt);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  if (!toast) return null;

  return (
    <div className="toast-wrap">
      <div className={`toast ${toast.kind}`} role="status">
        <span className="t-ic" aria-hidden="true">
          {toast.kind === 'error' ? '✕' : toast.kind === 'info' ? 'ℹ' : '✓'}
        </span>
        <span>
          <b>{toast.title}</b>
          {toast.detail && (
            <>
              <br />
              <span className="sec">{toast.detail}</span>
            </>
          )}
        </span>
        <span className="grow" />
        {toast.undoable && toast.receiptIds && toast.receiptIds.length > 0 && (
          <button
            className="btn sm"
            onClick={() => {
              for (const id of toast.receiptIds!) void undoReceipt(id);
              setToast(null);
            }}
          >
            Undo
          </button>
        )}
        <button className="btn sm" aria-label="Dismiss" onClick={() => setToast(null)}>
          ✕
        </button>
      </div>
    </div>
  );
}
