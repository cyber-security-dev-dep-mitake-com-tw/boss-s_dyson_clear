/** App shell per wireframe 00 — sidebar nav, content region, status bar. */
import { useEffect } from 'react';
import { useStore, type ViewId } from './store';
import { Dashboard } from './screens/Dashboard';
import { SmartClean } from './screens/SmartClean';
import { Uninstaller } from './screens/Uninstaller';
import { LargeFiles } from './screens/LargeFiles';
import { Duplicates } from './screens/Duplicates';
import { DiskStatus } from './screens/DiskStatus';
import { Processes } from './screens/Processes';
import { Receipts } from './screens/Receipts';
import { ReceiptToast } from './components/ReceiptToast';
import { EmptyState } from './components/States';

const NAV: Array<{ id: ViewId; icon: string; label: string }> = [
  { id: 'dashboard', icon: '⌂', label: 'Dashboard' },
  { id: 'smart-clean', icon: '✦', label: 'Smart Clean' },
  { id: 'uninstaller', icon: '⊞', label: 'Uninstaller' },
  { id: 'large-files', icon: '▤', label: 'Large Files' },
  { id: 'duplicates', icon: '⧉', label: 'Duplicates' },
  { id: 'disk-status', icon: '◔', label: 'Disk Status' },
  { id: 'processes', icon: '≡', label: 'Processes' },
];

function Screen({ view }: { view: ViewId }): JSX.Element {
  switch (view) {
    case 'dashboard':
      return <Dashboard />;
    case 'smart-clean':
      return <SmartClean />;
    case 'uninstaller':
      return <Uninstaller />;
    case 'large-files':
      return <LargeFiles />;
    case 'duplicates':
      return <Duplicates />;
    case 'disk-status':
      return <DiskStatus />;
    case 'processes':
      return <Processes />;
    case 'receipts':
      return <Receipts />;
    case 'settings':
      return (
        <EmptyState
          icon="⚙"
          title="Settings"
          body="No configurable settings in v1 — safety rules are structural and cannot be disabled."
        />
      );
  }
}

function StatusBar(): JSX.Element {
  const status = useStore((s) => s.status);
  const runId = useStore((s) => s.runId);
  const phases = useStore((s) => s.phases);
  const scanError = useStore((s) => s.scanError);
  const receipts = useStore((s) => s.receipts);

  let dot = '';
  let text = 'Engine ready';
  if (status === 'scanning' || status === 'executing') {
    dot = 'busy';
    const running = Object.entries(phases).find(([, p]) => p.state === 'run');
    if (running) {
      const [name, p] = running;
      const pct = p.total > 0 ? ` ${Math.round((p.done / p.total) * 100)}%` : '';
      const label: Record<string, string> = {
        scan: 'Scanning',
        verify: 'Verifying',
        merge: 'Merging plan',
        gate: 'Waiting at gate',
        exec: 'Executing',
      };
      text = `${label[name] ?? name}…${pct}`;
    } else {
      text = status === 'executing' ? 'Executing…' : 'Scanning…';
    }
  } else if (status === 'gate') {
    dot = 'busy';
    text = 'Waiting at approval gate';
  } else if (status === 'error') {
    dot = 'err';
    text = scanError ? `Engine error` : 'Error';
  }

  return (
    <footer className="statusbar">
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{text}</span>
      {runId && (
        <span className="num mono" style={{ fontSize: 10 }}>
          run {runId.slice(0, 8)}
        </span>
      )}
      <span className="grow" />
      <span>
        {receipts ? `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}` : 'no receipts yet'}
      </span>
      <span>v{window.appInfo?.version ?? '0.0.0'}</span>
    </footer>
  );
}

export function App(): JSX.Element {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const handleEvent = useStore((s) => s.handleEvent);
  const loadReceipts = useStore((s) => s.loadReceipts);

  // Single workflow-event subscription for the whole renderer.
  useEffect(() => {
    const unsubscribe = window.sweepdeck.onWorkflowEvent((ev) => handleEvent(ev));
    void loadReceipts();
    return unsubscribe;
  }, [handleEvent, loadReceipts]);

  // Cmd/Ctrl+1…7 switches views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        setView(NAV[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          SweepDeck
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'active' : ''}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              <span className="ic" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <nav className="nav" aria-label="Secondary">
          <button
            className={view === 'receipts' ? 'active' : ''}
            aria-current={view === 'receipts' ? 'page' : undefined}
            onClick={() => setView('receipts')}
          >
            <span className="ic" aria-hidden="true">
              ✎
            </span>
            Receipts &amp; Undo
          </button>
          <button
            className={view === 'settings' ? 'active' : ''}
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => setView('settings')}
          >
            <span className="ic" aria-hidden="true">
              ⚙
            </span>
            Settings
          </button>
        </nav>
      </aside>

      <main className="main">
        <div className="content">
          <Screen view={view} />
        </div>
      </main>

      <StatusBar />
      <ReceiptToast />
    </div>
  );
}
