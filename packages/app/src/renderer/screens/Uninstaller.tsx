/**
 * Uninstaller — apps list · detail pane with ownedPaths tree preview ·
 * uninstall runs through the engine and ends at the shared ApprovalGate.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppInfo } from '@contracts';
import { useStore } from '../store';
import { fmtBytes, isBlocked } from '../format';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { ApprovalGate } from '../components/ApprovalGate';
import { ProgressStream } from '../components/ProgressStream';
import { EmptyState, ErrorState, SkeletonRows } from '../components/States';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
}

export function Uninstaller(): JSX.Element {
  const apps = useStore((s) => s.apps);
  const appsLoading = useStore((s) => s.appsLoading);
  const appsError = useStore((s) => s.appsError);
  const loadApps = useStore((s) => s.loadApps);
  const status = useStore((s) => s.status);
  const flow = useStore((s) => s.flow);
  const plan = useStore((s) => s.plan);
  const selected = useStore((s) => s.selected);
  const scanError = useStore((s) => s.scanError);
  const execResult = useStore((s) => s.execResult);
  const startUninstall = useStore((s) => s.startUninstall);
  const resetScan = useStore((s) => s.resetScan);
  const toggle = useStore((s) => s.toggle);
  const approveSelected = useStore((s) => s.approveSelected);

  const [query, setQuery] = useState('');
  const [selKey, setSelKey] = useState<string | null>(null);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  const filtered = useMemo(() => {
    const list = apps ?? [];
    const q = query.trim().toLowerCase();
    const f = q
      ? list.filter((a) => a.name.toLowerCase().includes(q) || a.key.toLowerCase().includes(q))
      : list;
    return [...f].sort((a, b) => a.name.localeCompare(b.name));
  }, [apps, query]);

  const app = filtered.find((a) => a.key === selKey) ?? (apps ?? []).find((a) => a.key === selKey) ?? null;
  const mine = flow === 'uninstall';
  const verdicts = mine && plan ? plan.verdicts.filter((v) => v.status === 'proposed') : [];
  const selectedVerdicts = verdicts.filter((v) => selected[v.id]);
  const selBytes = selectedVerdicts.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);

  return (
    <div>
      <h1>Uninstaller</h1>
      <p className="sec">
        Removes the app plus everything the graph attributes to it via OWNED_BY / INSTALLS_TO edges.
      </p>

      {appsError && <ErrorState node="apps.list" message={appsError} />}
      {mine && scanError && <ErrorState node="engine" message={scanError} />}

      <div className="panes" style={{ marginTop: 16 }}>
        {/* left: app list */}
        <div>
          <input
            type="search"
            placeholder={`Search ${apps?.length ?? 0} apps…`}
            aria-label="Search apps"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="card applist">
            {appsLoading && !apps ? (
              <SkeletonRows rows={8} />
            ) : filtered.length === 0 ? (
              <EmptyState icon="⊞" title="No apps found" body="The engine indexes installed applications during a scan." />
            ) : (
              filtered.map((a) => (
                <button
                  className={`appline ${a.key === selKey ? 'sel' : ''}`}
                  aria-selected={a.key === selKey}
                  key={a.key}
                  onClick={() => {
                    setSelKey(a.key);
                    if (mine && status !== 'idle') resetScan();
                  }}
                >
                  <span className="aicon">{initials(a.name)}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>{a.name}</b>
                    <small>
                      {a.version ? `v${a.version}` : 'unknown version'}
                      {a.publisher ? ` · ${a.publisher}` : ''}
                    </small>
                  </span>
                  <span className="num sec">{fmtBytes(a.sizeBytes)}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* right: detail / gate */}
        <div>
          {!app ? (
            <div className="card">
              <EmptyState
                icon="⊞"
                title="Select an application"
                body="The detail pane previews every path the graph attributes to the app before anything is proposed for removal."
              />
            </div>
          ) : (
            <DetailPane
              app={app}
              mine={mine}
              status={status}
              onUninstall={() => void startUninstall(app.key)}
            />
          )}

          {app && mine && status === 'gate' && verdicts.length > 0 && (
            <>
              <div className="card" style={{ marginTop: 16 }}>
                <div className="tree" role="tree" aria-label="What will be removed">
                  {verdicts.map((v) => {
                    const blocked = isBlocked(v.provenance.confidence);
                    const edge =
                      typeof v.detail.edge === 'string' ? v.detail.edge : v.action === 'uninstall' ? 'BUNDLE' : 'OWNED_BY';
                    const owned = Array.isArray(v.detail.ownedPaths)
                      ? (v.detail.ownedPaths as unknown[]).filter((p): p is string => typeof p === 'string')
                      : [];
                    return (
                      <div key={v.id} role="treeitem" aria-selected={!!selected[v.id]}>
                        <label style={{ cursor: blocked ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={!!selected[v.id]}
                            disabled={blocked}
                            onChange={() => toggle(v.id)}
                          />{' '}
                          {typeof v.detail.installPath === 'string' ? v.detail.installPath : v.subjectKey}
                        </label>{' '}
                        <span className="sz num">{fmtBytes(v.sizeBytes)}</span>{' '}
                        <span className="edge">{edge}</span>
                        {!v.smartSelected && !blocked && (
                          <span className="muted" style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-xs)' }}>
                            {' '}
                            — unchecked by default
                          </span>
                        )}
                        {blocked && (
                          <span className="muted" style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-xs)' }}>
                            {' '}
                            — blocked: {String(v.detail.blockedReason ?? 'shared or protected path')}
                          </span>
                        )}
                        {owned.map((p, i) => (
                          <div key={p}>
                            <span className="tw">{i === owned.length - 1 ? '└─' : '├─'}</span> {p}{' '}
                            <span className="edge">OWNED_BY</span>
                            <span className="muted" style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-xs)' }}>
                              {' '}
                              — removed with the bundle
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>

              <ApprovalGate
                summary={
                  <span>
                    <b className="num">{selectedVerdicts.length} paths</b> selected{' '}
                    <span className="muted">· unchecked items are kept</span>
                  </span>
                }
                actionLabel={`Review & Uninstall ${fmtBytes(selBytes)}`}
                disabled={selectedVerdicts.length === 0}
                confirmTitle={`Uninstall ${app.name}?`}
                confirmBullets={[
                  `${app.name} and ${Math.max(0, selectedVerdicts.length - 1)} support path${
                    selectedVerdicts.length - 1 === 1 ? '' : 's'
                  } (${fmtBytes(selBytes)}) move to Trash`,
                  `${verdicts.length - selectedVerdicts.length} unchecked path${
                    verdicts.length - selectedVerdicts.length === 1 ? ' is' : 's are'
                  } kept`,
                  'Receipt with per-path Undo is written; restore puts every file back',
                ]}
                confirmLabel="Uninstall"
                danger
                items={selectedVerdicts}
                onConfirm={approveSelected}
              />
            </>
          )}

          {app && mine && status === 'scanning' && (
            <div style={{ marginTop: 16 }}>
              <ProgressStream phases={['scan', 'verify', 'merge']} />
            </div>
          )}

          {app && mine && (status === 'executing' || status === 'done') && (
            <div className="card" style={{ marginTop: 16 }}>
              {status === 'executing' ? (
                <SkeletonRows rows={3} />
              ) : (
                <EmptyState
                  ok
                  title={execResult ? `${app.name} uninstalled — ${fmtBytes(execResult.bytesFreed)} freed` : 'Done'}
                  body={
                    execResult
                      ? `${execResult.executed} paths moved to Trash${
                          execResult.receipts[0] ? ` · receipt #${execResult.receipts[0].id}` : ''
                        }`
                      : undefined
                  }
                  action={
                    <button
                      className="btn"
                      onClick={() => {
                        resetScan();
                        void useStore.getState().loadApps(true);
                      }}
                    >
                      Back to apps
                    </button>
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailPane({
  app,
  mine,
  status,
  onUninstall,
}: {
  app: AppInfo;
  mine: boolean;
  status: string;
  onUninstall: () => void;
}): JSX.Element {
  const busy = mine && status !== 'idle' && status !== 'error';
  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span className="aicon" style={{ width: 34, height: 34, fontSize: 'var(--fs-md)' }}>
          {initials(app.name)}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 'var(--fs-lg)' }}>{app.name}</b>
          <br />
          <span className="muted mono">{app.key}</span>
        </span>
        <ConfidenceBadge confidence={0.95} label="traversal" />
        {!busy && (
          <button className="btn danger-ghost" onClick={onUninstall}>
            Uninstall…
          </button>
        )}
      </div>
      <div className="tree" aria-label="Owned paths preview">
        {app.installPath && (
          <div>
            {app.installPath} <span className="sz num">{fmtBytes(app.sizeBytes)}</span>{' '}
            <span className="edge">BUNDLE</span>
          </div>
        )}
        {app.ownedPaths.length === 0 ? (
          <div className="muted" style={{ fontFamily: 'var(--font-ui)' }}>
            No additional owned paths in the graph yet — run a scan to populate ownership edges.
          </div>
        ) : (
          app.ownedPaths.map((p, i) => (
            <div key={p}>
              <span className="tw">{i === app.ownedPaths.length - 1 ? '└─' : '├─'}</span> {p}{' '}
              <span className="edge">OWNED_BY</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
