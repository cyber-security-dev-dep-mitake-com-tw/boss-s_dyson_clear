import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: string;
  ok?: boolean;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

/** Dashed-ring illustration + one sentence + the one primary action. */
export function EmptyState({ icon = '✦', ok, title, body, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      <div className={`ring ${ok ? 'ok' : ''}`} aria-hidden="true">
        {ok ? '✓' : icon}
      </div>
      <div>
        <h2>{title}</h2>
        {body && (
          <p className="sec" style={{ maxWidth: 460, marginTop: 4 }}>
            {body}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/** task_failed / IPC errors: warning-bordered card naming the node, message copyable. */
export function ErrorState({ node, message }: { node: string; message: string }): JSX.Element {
  return (
    <div className="errcard" role="alert">
      <span className="node">⚠ {node}</span>
      <div className="msg">{message}</div>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel" key={i} style={{ width: `${90 - (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}
