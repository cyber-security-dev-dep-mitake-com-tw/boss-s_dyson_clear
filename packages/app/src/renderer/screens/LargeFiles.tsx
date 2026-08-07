/**
 * Large Files — sortable virtualized table (size/age), threshold input,
 * smart-select chips derived from provenance rules, shared ApprovalGate.
 */
import { useMemo, useState } from 'react';
import type { Verdict } from '@contracts';
import { useStore } from '../store';
import { evidenceMtime, fmtAge, fmtBytes, isBlocked } from '../format';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { VirtualTable } from '../components/VirtualTable';
import { ApprovalGate } from '../components/ApprovalGate';
import { ProgressStream } from '../components/ProgressStream';
import { EmptyState, ErrorState } from '../components/States';

const THRESHOLDS = [50, 100, 250, 500, 1024].map((mb) => mb * 1024 * 1024);

type SortKey = 'size' | 'age' | 'name';

function chipLabel(rule: string): string {
  const tail = rule.split('.').pop() ?? rule;
  return tail.replace(/-/g, ' ');
}

export function LargeFiles(): JSX.Element {
  const status = useStore((s) => s.status);
  const flow = useStore((s) => s.flow);
  const plan = useStore((s) => s.plan);
  const selected = useStore((s) => s.selected);
  const scanError = useStore((s) => s.scanError);
  const execResult = useStore((s) => s.execResult);
  const startScan = useStore((s) => s.startScan);
  const cancelScan = useStore((s) => s.cancelScan);
  const resetScan = useStore((s) => s.resetScan);
  const toggle = useStore((s) => s.toggle);
  const setMany = useStore((s) => s.setMany);
  const clearSelection = useStore((s) => s.clearSelection);
  const approveSelected = useStore((s) => s.approveSelected);

  const [thresholdIdx, setThresholdIdx] = useState(2);
  const [sortKey, setSortKey] = useState<SortKey>('size');
  const [sortDesc, setSortDesc] = useState(true);
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set());

  const mine = flow === 'large';
  const all = useMemo(
    () =>
      mine && plan
        ? plan.verdicts.filter((v) => v.category === 'large' && v.status === 'proposed')
        : [],
    [mine, plan],
  );

  const threshold = THRESHOLDS[thresholdIdx];
  const rows = useMemo(() => {
    const filtered = all.filter((v) => (v.sizeBytes ?? 0) >= threshold);
    const dir = sortDesc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'size') return dir * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
      if (sortKey === 'age') {
        const am = evidenceMtime(a.provenance, a.detail) ?? Date.now();
        const bm = evidenceMtime(b.provenance, b.detail) ?? Date.now();
        return dir * (bm - am); // older = "greater" age
      }
      return dir * a.label.localeCompare(b.label);
    });
  }, [all, threshold, sortKey, sortDesc]);

  const rules = useMemo(() => {
    const set = new Map<string, number>();
    for (const v of all) set.set(v.provenance.rule, (set.get(v.provenance.rule) ?? 0) + 1);
    return [...set.keys()].sort();
  }, [all]);

  const selectedVerdicts = all.filter((v) => selected[v.id]);
  const selBytes = selectedVerdicts.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);
  const totalBytes = all.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);

  const toggleChip = (rule: string): void => {
    const next = new Set(activeChips);
    const on = !next.has(rule);
    if (on) next.add(rule);
    else next.delete(rule);
    setActiveChips(next);
    const ids = rows.filter((v) => v.provenance.rule === rule && !isBlocked(v.provenance.confidence)).map((v) => v.id);
    setMany(ids, on);
  };

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

  if (!mine || status === 'idle') {
    return (
      <div>
        <h1>Large Files</h1>
        <p className="sec">Find the biggest files, smart-select the safe ones, and approve every removal yourself.</p>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon="▤"
            title="No large-file scan yet"
            body="Scanning walks your home volume, sizes every file and attaches age + ownership evidence from the graph."
            action={
              <button className="btn primary" onClick={() => void startScan('large', ['large'])}>
                Scan for large files
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div>
        <h1>Large Files</h1>
        <ErrorState node="engine" message={scanError ?? 'unknown error'} />
        <button className="btn" onClick={resetScan}>
          Back
        </button>
      </div>
    );
  }

  if (status === 'scanning') {
    return (
      <div>
        <h1>Large Files</h1>
        <div className="anno">Scanning</div>
        <ProgressStream phases={['scan', 'verify', 'merge']} />
        <div style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => void cancelScan()}>
            Cancel scan
          </button>
        </div>
      </div>
    );
  }

  if (status === 'done' || status === 'executing') {
    return (
      <div>
        <h1>Large Files</h1>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            ok={status === 'done'}
            icon="▤"
            title={
              status === 'executing'
                ? 'Executing…'
                : execResult
                  ? `Freed ${fmtBytes(execResult.bytesFreed)}`
                  : 'No large files above the threshold'
            }
            body={
              status === 'done' && execResult
                ? `${execResult.executed} files moved to Trash${
                    execResult.receipts[0] ? ` · receipt #${execResult.receipts[0].id}` : ''
                  }`
                : undefined
            }
            action={
              status === 'done' ? (
                <button className="btn primary" onClick={resetScan}>
                  New scan
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  // gate
  return (
    <div>
      <h1>Large Files</h1>
      <p className="sec">
        {rows.length.toLocaleString()} files over the threshold · {fmtBytes(totalBytes)} total. Table
        is virtualized — only visible rows render.
      </p>

      <div className="card toolbar" style={{ marginTop: 16 }}>
        <span className="lbl">Min size</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={0}
            max={THRESHOLDS.length - 1}
            value={thresholdIdx}
            aria-label="Size threshold"
            onChange={(e) => setThresholdIdx(Number(e.target.value))}
          />
          <b className="num">≥ {fmtBytes(threshold)}</b>
        </span>
        <span style={{ width: 1, height: 22, background: 'var(--border-strong)' }} />
        <span className="lbl">Smart select</span>
        <span className="chips" role="group" aria-label="Smart-select presets">
          {rules.length === 0 ? (
            <span className="muted">no rules matched</span>
          ) : (
            rules.map((rule) => (
              <button
                className={`chip ${activeChips.has(rule) ? 'on' : ''}`}
                aria-pressed={activeChips.has(rule)}
                key={rule}
                onClick={() => toggleChip(rule)}
              >
                {chipLabel(rule)}
              </button>
            ))
          )}
        </span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <VirtualTable
          rows={rows}
          rowHeight={44}
          maxHeight={440}
          header={
            <tr>
              <th style={{ width: 34 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={rows.length > 0 && rows.every((v) => selected[v.id] || isBlocked(v.provenance.confidence))}
                  onChange={(e) =>
                    setMany(
                      rows.filter((v) => !isBlocked(v.provenance.confidence)).map((v) => v.id),
                      e.target.checked,
                    )
                  }
                />
              </th>
              <th>Name</th>
              {sortHeader('size', 'Size')}
              {sortHeader('age', 'Age')}
              <th>Confidence</th>
              <th>Path</th>
            </tr>
          }
          renderRow={(v: Verdict) => {
            const blocked = isBlocked(v.provenance.confidence);
            const mtime = evidenceMtime(v.provenance, v.detail);
            return (
              <tr key={v.id} style={{ height: 44 }} className={blocked ? 'sys' : ''}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${v.label}`}
                    checked={!!selected[v.id]}
                    disabled={blocked}
                    onChange={() => toggle(v.id)}
                  />
                </td>
                <td>
                  <b>{v.label}</b>
                </td>
                <td className="num">{fmtBytes(v.sizeBytes)}</td>
                <td className="num sec">{fmtAge(mtime)}</td>
                <td>
                  <ConfidenceBadge
                    confidence={v.provenance.confidence}
                    label={chipLabel(v.provenance.rule)}
                  />
                </td>
                <td className="path">{v.subjectKey}</td>
              </tr>
            );
          }}
        />
      </div>

      <ApprovalGate
        summary={
          <span>
            <b className="num">
              {selectedVerdicts.length} file{selectedVerdicts.length === 1 ? '' : 's'}
            </b>{' '}
            selected{' '}
            <span className="muted">
              {activeChips.size > 0 && `· smart-select: ${[...activeChips].map(chipLabel).join(' + ')}`}
            </span>
          </span>
        }
        actionLabel={`Review & Clean ${fmtBytes(selBytes)}`}
        disabled={selectedVerdicts.length === 0}
        secondaryLabel="Clear selection"
        onSecondary={() => {
          clearSelection();
          setActiveChips(new Set());
        }}
        confirmTitle={`Move ${selectedVerdicts.length} large file${selectedVerdicts.length === 1 ? '' : 's'} to Trash?`}
        confirmBullets={[
          `${selectedVerdicts
            .slice(0, 3)
            .map((v) => `${v.label} (${fmtBytes(v.sizeBytes)})`)
            .join(', ')}${selectedVerdicts.length > 3 ? ` and ${selectedVerdicts.length - 3} more` : ''} move to Trash`,
          'Nothing is permanently deleted — everything is restorable until the Trash is emptied',
          'A receipt will list every path with one-click Undo',
        ]}
        confirmLabel="Move to Trash"
        items={selectedVerdicts}
        onConfirm={approveSelected}
      />
    </div>
  );
}
