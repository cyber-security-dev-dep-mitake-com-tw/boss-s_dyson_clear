/**
 * Smart Clean — category checkboxes → live phase stream → results grouped by
 * provenance.rule with confidence badges → selection → the shared ApprovalGate.
 */
import { useMemo, useState } from 'react';
import type { Verdict } from '@contracts';
import { useStore } from '../store';
import { fmtBytes, isBlocked } from '../format';
import { ProgressStream } from '../components/ProgressStream';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { ApprovalGate } from '../components/ApprovalGate';
import { EmptyState, ErrorState } from '../components/States';

const SUBCATS = [
  { id: 'caches', name: 'User caches', hint: 'App & browser caches', on: true },
  { id: 'temp', name: 'Temp files', hint: '/tmp, app temp dirs', on: true },
  { id: 'logs', name: 'Logs', hint: 'Older than 7 days', on: true },
  { id: 'browser', name: 'Browser caches', hint: 'Chrome, Safari, Edge', on: true },
  { id: 'trash', name: 'Trash', hint: 'Empty items > 30 days', on: false },
] as const;

interface RuleGroup {
  rule: string;
  verdicts: Verdict[];
  bytes: number;
  confidence: number;
  blocked: boolean;
  blockReason: string | null;
}

function groupByRule(verdicts: Verdict[]): RuleGroup[] {
  const map = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const list = map.get(v.provenance.rule) ?? [];
    list.push(v);
    map.set(v.provenance.rule, list);
  }
  const groups: RuleGroup[] = [];
  for (const [rule, vs] of map) {
    const blocked = vs.every((v) => isBlocked(v.provenance.confidence));
    const reason = blocked
      ? (typeof vs[0].detail.blockedReason === 'string' && vs[0].detail.blockedReason) ||
        'blocked by verifier'
      : null;
    groups.push({
      rule,
      verdicts: vs,
      bytes: vs.reduce((s, v) => s + (v.sizeBytes ?? 0), 0),
      confidence: Math.max(...vs.map((v) => v.provenance.confidence)),
      blocked,
      blockReason: reason,
    });
  }
  return groups.sort((a, b) => b.bytes - a.bytes);
}

/** Human title from a rule id like "mac.browser-cache.chrome". */
function ruleTitle(rule: string): string {
  const last = rule.split('.').slice(1).join(' ').replace(/-/g, ' ');
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : rule;
}

export function SmartClean(): JSX.Element {
  const status = useStore((s) => s.status);
  const flow = useStore((s) => s.flow);
  const plan = useStore((s) => s.plan);
  const selected = useStore((s) => s.selected);
  const scanErrors = useStore((s) => s.scanErrors);
  const scanError = useStore((s) => s.scanError);
  const scannedFiles = useStore((s) => s.scannedFiles);
  const execResult = useStore((s) => s.execResult);
  const startScan = useStore((s) => s.startScan);
  const cancelScan = useStore((s) => s.cancelScan);
  const resetScan = useStore((s) => s.resetScan);
  const toggle = useStore((s) => s.toggle);
  const setMany = useStore((s) => s.setMany);
  const clearSelection = useStore((s) => s.clearSelection);
  const approveSelected = useStore((s) => s.approveSelected);

  const [subcats, setSubcats] = useState<Record<string, boolean>>(
    Object.fromEntries(SUBCATS.map((c) => [c.id, c.on])),
  );

  const mine = flow === 'clean';
  const verdicts = useMemo(
    () => (mine && plan ? plan.verdicts.filter((v) => v.status === 'proposed') : []),
    [mine, plan],
  );
  const groups = useMemo(() => groupByRule(verdicts), [verdicts]);

  const selectedVerdicts = verdicts.filter((v) => selected[v.id]);
  const selBytes = selectedVerdicts.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);
  const skippedGroups = groups.filter((g) => g.blocked).length;

  // ---- state 1: choose categories ----
  if (!mine || status === 'idle' || (status === 'error' && !mine)) {
    return (
      <div>
        <h1>Smart Clean</h1>
        <p className="sec">Caches, temp files, logs and trash — scanned, verified, then approved by you.</p>
        {scanError && flow === 'clean' && <ErrorState node="engine" message={scanError} />}
        <div className="anno">Choose categories</div>
        <div className="cats">
          {SUBCATS.map((c) => (
            <label className="cat card" key={c.id}>
              <input
                type="checkbox"
                checked={subcats[c.id]}
                onChange={(e) => setSubcats({ ...subcats, [c.id]: e.target.checked })}
              />
              <span>
                <b>{c.name}</b>
                <small>{c.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            disabled={!Object.values(subcats).some(Boolean)}
            onClick={() => void startScan('clean', ['junk'])}
          >
            Scan selected
          </button>
        </div>
      </div>
    );
  }

  // ---- state: engine failed ----
  if (status === 'error') {
    return (
      <div>
        <h1>Smart Clean</h1>
        <ErrorState node="engine" message={scanError ?? 'unknown error'} />
        <button className="btn" onClick={resetScan}>
          Back
        </button>
      </div>
    );
  }

  // ---- state 2: live phase stream ----
  if (status === 'scanning') {
    return (
      <div>
        <h1>Smart Clean</h1>
        <div className="anno">Live phase stream</div>
        <ProgressStream phases={['scan', 'verify', 'merge']} />
        {scanErrors.map((e, i) => (
          <ErrorState node={e.node} message={e.message} key={i} />
        ))}
        <div style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => void cancelScan()}>
            Cancel scan
          </button>
        </div>
      </div>
    );
  }

  // ---- state 4: done ----
  if (status === 'done' || status === 'executing') {
    if (status === 'done' && !execResult) {
      return (
        <div>
          <h1>Smart Clean</h1>
          <div className="card" style={{ marginTop: 16 }}>
            <EmptyState
              ok
              title="Nothing worth cleaning"
              body={`Scanned ${scannedFiles.toLocaleString()} files — no candidates passed the safety verifier.`}
              action={
                <button className="btn" onClick={resetScan}>
                  Scan again
                </button>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div>
        <h1>Smart Clean</h1>
        {status === 'executing' ? (
          <>
            <div className="anno">Executing approved items</div>
            <ProgressStream phases={['gate', 'exec']} />
          </>
        ) : (
          <div className="card" style={{ marginTop: 16 }}>
            <EmptyState
              ok
              title={`Cleaned ${fmtBytes(execResult?.bytesFreed ?? 0)}`}
              body={`${execResult?.executed ?? 0} items moved to Trash${
                execResult?.failed ? ` · ${execResult.failed} failed safe (see receipts)` : ''
              }. Undo any time from Dashboard → Recent receipts.`}
              action={
                <button className="btn primary" onClick={resetScan}>
                  New scan
                </button>
              }
            />
          </div>
        )}
      </div>
    );
  }

  // ---- state 3: gate — results grouped by provenance.rule ----
  return (
    <div>
      <h1>Smart Clean</h1>
      <p className="sec">
        Results grouped by rule · smart-select pre-checked. Blocked groups are shown for
        transparency and cannot be selected.
      </p>
      {scanErrors.map((e, i) => (
        <ErrorState node={e.node} message={e.message} key={i} />
      ))}

      <div style={{ marginTop: 16 }}>
        {groups.map((g) => {
          const ids = g.verdicts.map((v) => v.id);
          const allOn = ids.every((id) => selected[id]);
          const someOn = ids.some((id) => selected[id]);
          return (
            <details className="group card" open={!g.blocked} key={g.rule}>
              <summary>
                <span className="caret">▶</span>
                <input
                  type="checkbox"
                  aria-label={`Select group ${ruleTitle(g.rule)}`}
                  checked={allOn && !g.blocked}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn && !allOn;
                  }}
                  disabled={g.blocked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setMany(ids.filter((id) => !isBlockedId(g, id)), e.target.checked)}
                />
                <b>
                  {ruleTitle(g.rule)}
                  {g.blocked && (
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {' '}
                      — skipped, {g.blockReason}
                    </span>
                  )}
                </b>
                <span className="mono muted">{g.rule}</span>
                <ConfidenceBadge confidence={g.confidence} />
                <span className="grow" />
                <span className="sec">
                  {g.verdicts.length} item{g.verdicts.length === 1 ? '' : 's'}
                </span>
                <b className={`num ${g.blocked ? 'muted' : ''}`}>{fmtBytes(g.bytes)}</b>
              </summary>
              <div className="rows">
                {g.verdicts.map((v) => {
                  const blocked = isBlocked(v.provenance.confidence);
                  return (
                    <div className={`vrow ${blocked ? 'disabled' : ''}`} key={v.id}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${v.label}`}
                        checked={!!selected[v.id]}
                        disabled={blocked}
                        onChange={() => toggle(v.id)}
                      />
                      <span>
                        {v.label}
                        {blocked && (
                          <span className="muted"> — {String(v.detail.blockedReason ?? 'blocked')}</span>
                        )}
                        <br />
                        <span className="path">{v.subjectKey}</span>
                      </span>
                      <span className="num sec">{fmtBytes(v.sizeBytes)}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>

      <ApprovalGate
        summary={
          <span>
            <b className="num">{selectedVerdicts.length} items</b> selected{' '}
            <span className="muted">
              {skippedGroups > 0 && `· ${skippedGroups} group${skippedGroups === 1 ? '' : 's'} skipped `}
              · smart-select applied
            </span>
          </span>
        }
        actionLabel={`Review & Clean ${fmtBytes(selBytes)}`}
        disabled={selectedVerdicts.length === 0}
        secondaryLabel="Deselect all"
        onSecondary={clearSelection}
        confirmTitle={`Move ${selectedVerdicts.length} item${selectedVerdicts.length === 1 ? '' : 's'} to Trash?`}
        confirmBullets={[
          `${selectedVerdicts.length} files (${fmtBytes(selBytes)}) move to the system Trash — nothing is permanently deleted`,
          ...(skippedGroups > 0
            ? [`${skippedGroups} group${skippedGroups === 1 ? '' : 's'} skipped automatically (blocked by the safety verifier)`]
            : []),
          'A receipt is written for every item — one-click Undo restores original paths',
        ]}
        confirmLabel="Move to Trash"
        items={selectedVerdicts}
        onConfirm={approveSelected}
      />
    </div>
  );
}

function isBlockedId(group: RuleGroup, id: number): boolean {
  const v = group.verdicts.find((x) => x.id === id);
  return v ? isBlocked(v.provenance.confidence) : true;
}
