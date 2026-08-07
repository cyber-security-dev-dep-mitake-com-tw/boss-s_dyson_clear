/**
 * Duplicates — groups with crowned (disabled) canonical copy, per-member
 * Keep/Remove segments, smart-select-all, shared ApprovalGate.
 */
import { useMemo } from 'react';
import type { Verdict } from '@contracts';
import { useStore } from '../store';
import { fmtBytes } from '../format';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { ApprovalGate } from '../components/ApprovalGate';
import { ProgressStream } from '../components/ProgressStream';
import { EmptyState, ErrorState } from '../components/States';

interface DupGroup {
  groupId: string;
  canonicalPath: string | null;
  hash: string | null;
  members: Verdict[];
  removableBytes: number;
}

function buildGroups(verdicts: Verdict[]): DupGroup[] {
  const map = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const gid = String(v.detail.groupId ?? v.provenance.evidence['groupId'] ?? v.id);
    const list = map.get(gid) ?? [];
    list.push(v);
    map.set(gid, list);
  }
  const groups: DupGroup[] = [];
  for (const [groupId, members] of map) {
    const first = members[0];
    const canonical =
      (typeof first.detail.canonicalPath === 'string' && first.detail.canonicalPath) ||
      (typeof first.detail.canonical === 'string' && first.detail.canonical) ||
      null;
    const hash =
      (typeof first.provenance.evidence['hash'] === 'string' && (first.provenance.evidence['hash'] as string)) ||
      (typeof first.detail.hash === 'string' && (first.detail.hash as string)) ||
      null;
    groups.push({
      groupId,
      canonicalPath: canonical,
      hash,
      members,
      removableBytes: members.reduce((s, v) => s + (v.sizeBytes ?? 0), 0),
    });
  }
  return groups.sort((a, b) => b.removableBytes - a.removableBytes);
}

export function Duplicates(): JSX.Element {
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
  const clearSelection = useStore((s) => s.clearSelection);
  const applySmartSelection = useStore((s) => s.applySmartSelection);
  const approveSelected = useStore((s) => s.approveSelected);

  const mine = flow === 'duplicate';
  const verdicts = useMemo(
    () =>
      mine && plan
        ? plan.verdicts.filter((v) => v.category === 'duplicate' && v.status === 'proposed')
        : [],
    [mine, plan],
  );
  const groups = useMemo(() => buildGroups(verdicts), [verdicts]);

  const selectedVerdicts = verdicts.filter((v) => selected[v.id]);
  const selBytes = selectedVerdicts.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);
  const removable = verdicts.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);

  if (!mine || status === 'idle') {
    return (
      <div>
        <h1>Duplicates</h1>
        <p className="sec">
          Matching: size/ext blocking → partial hash → full SHA-256. The canonical copy is never
          selected for removal.
        </p>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon="⧉"
            title="No duplicate scan yet"
            body="Entity-resolution dedupe verifies every match with a full content hash before it can be proposed."
            action={
              <button className="btn primary" onClick={() => void startScan('duplicate', ['duplicate'])}>
                Scan for duplicates
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
        <h1>Duplicates</h1>
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
        <h1>Duplicates</h1>
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
        <h1>Duplicates</h1>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            ok={status === 'done'}
            icon="⧉"
            title={
              status === 'executing'
                ? 'Removing duplicate copies…'
                : execResult
                  ? `Removed ${execResult.executed} duplicates — ${fmtBytes(execResult.bytesFreed)} freed`
                  : 'No duplicates found'
            }
            body={status === 'done' && execResult ? 'Canonical copies untouched.' : undefined}
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
      <h1>Duplicates</h1>
      <p className="sec">
        {groups.length} group{groups.length === 1 ? '' : 's'} · {fmtBytes(removable)} removable. The
        canonical copy is never selected for removal.
      </p>

      <div className="headrow" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={applySmartSelection}>
          ✦ Smart select all
        </button>
        <span className="sec">
          keeps the canonical copy in every group — oldest path in the most permanent location
        </span>
        <span className="grow" />
      </div>

      {groups.map((g) => {
        const first = g.members[0];
        return (
          <div className="card dgroup" key={g.groupId}>
            <div className="dhead">
              <b>{first.label}</b>
              {g.hash && <span className="mono muted">sha256 {g.hash.slice(0, 8)}…</span>}
              <ConfidenceBadge confidence={first.provenance.confidence} label="match" />
              <span style={{ flex: 1 }} />
              <span className="sec">
                {g.members.length + 1} copies ·{' '}
                <b className="num" style={{ color: 'var(--text-1)' }}>
                  {fmtBytes(g.removableBytes)} removable
                </b>
              </span>
            </div>

            {g.canonicalPath && (
              <div className="copy canon">
                <span>
                  <span className="crown">♛ canonical — kept</span>
                  <br />
                  <span className="path">{g.canonicalPath}</span>
                </span>
                <span className="num sec">{fmtBytes(first.sizeBytes)}</span>
                <span className="seg" role="group" aria-label="Keep or remove">
                  <button className="keep on" disabled>
                    Keep
                  </button>
                  <button className="rm" disabled title="Canonical copy cannot be removed">
                    Remove
                  </button>
                </span>
              </div>
            )}

            {g.members.map((v) => {
              const on = !!selected[v.id];
              return (
                <div className="copy" key={v.id}>
                  <span>
                    <b>{v.label}</b>
                    <br />
                    <span className="path">{v.subjectKey}</span>
                  </span>
                  <span className="num sec">{fmtBytes(v.sizeBytes)}</span>
                  <span className="seg" role="group" aria-label={`Keep or remove ${v.subjectKey}`}>
                    <button className={`keep ${on ? '' : 'on'}`} onClick={() => toggle(v.id, false)}>
                      Keep
                    </button>
                    <button className={`rm ${on ? 'on' : ''}`} onClick={() => toggle(v.id, true)}>
                      Remove
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}

      <ApprovalGate
        summary={
          <span>
            <b className="num">{selectedVerdicts.length} copies</b> marked for removal{' '}
            <span className="muted">· {groups.length} canonicals kept</span>
          </span>
        }
        actionLabel={`Review & Clean ${fmtBytes(selBytes)}`}
        disabled={selectedVerdicts.length === 0}
        secondaryLabel="Reset choices"
        onSecondary={clearSelection}
        confirmTitle={`Remove ${selectedVerdicts.length} duplicate cop${selectedVerdicts.length === 1 ? 'y' : 'ies'}?`}
        confirmBullets={[
          `${selectedVerdicts.length} duplicate copies (${fmtBytes(selBytes)}) move to Trash`,
          `One canonical copy stays in place for every group — you lose no content`,
          'All matches verified by full SHA-256, not just name or size',
          'Receipt written; Undo restores every copy to its original path',
        ]}
        confirmLabel="Move to Trash"
        items={selectedVerdicts}
        onConfirm={approveSelected}
      />
    </div>
  );
}
