/**
 * Disk Status — volume cards with usage bars, SMART chip (or "unavailable"),
 * breakdown treemap-lite, TRIM advisory card with command + copy button.
 * v1 never executes elevated commands; the consent modal is still the gate.
 */
import { useEffect, useId, useState } from 'react';
import type { VolumeStatus } from '@contracts';
import { useStore } from '../store';
import { fmtBytes } from '../format';
import { Modal } from '../components/Modal';
import { EmptyState, ErrorState, SkeletonRows } from '../components/States';

const CHART = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c7)', 'var(--c6)', 'var(--c8)'];

function SmartChip({ v }: { v: VolumeStatus }): JSX.Element {
  if (!v.smart || v.smart.status === null) {
    return (
      <span className="chipbadge na">
        <span className="cdot" /> SMART: unavailable
      </span>
    );
  }
  const ok = /verified|ok|passed|good/i.test(v.smart.status);
  return (
    <span className={`chipbadge ${ok ? 'ok' : 'warn'}`}>
      <span className="cdot" /> SMART: {v.smart.status}
    </span>
  );
}

function VolumeCard({ v }: { v: VolumeStatus }): JSX.Element {
  const pct = Math.round(v.usePercent);
  const low = v.availableBytes / v.sizeBytes < 0.3;
  return (
    <div className="card volcard">
      <div className="top">
        <b style={{ fontSize: 'var(--fs-lg)' }}>{v.label || v.mount}</b>
        <span className="mono muted">
          {v.fsType}
          {v.isSSD === true ? ' · SSD' : v.isSSD === false ? ' · HDD' : ''}
        </span>
        <span className="grow" />
        <SmartChip v={v} />
      </div>
      <div className="bar" role="img" aria-label={`${pct} percent used`} style={{ height: 10 }}>
        <i className={low ? 'hot' : ''} style={{ width: `${pct}%` }} />
      </div>
      <div className="vmeta">
        <span>
          <b className="num" style={{ color: 'var(--text-1)' }}>
            {fmtBytes(v.usedBytes)}
          </b>{' '}
          used
        </span>
        <span>
          <b className="num" style={{ color: 'var(--text-1)' }}>
            {fmtBytes(v.availableBytes)}
          </b>{' '}
          free
        </span>
        <span>
          of {fmtBytes(v.sizeBytes)} · {pct}%
        </span>
        {low && <span style={{ color: 'var(--warning)' }}>⚠ under 30% free — consider a clean</span>}
      </div>
    </div>
  );
}

export function DiskStatus(): JSX.Element {
  const disk = useStore((s) => s.disk);
  const diskLoading = useStore((s) => s.diskLoading);
  const diskError = useStore((s) => s.diskError);
  const loadDisk = useStore((s) => s.loadDisk);
  const setToast = useStore((s) => s.setToast);

  const [trimOpen, setTrimOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [trimBusy, setTrimBusy] = useState(false);
  const titleId = useId();

  useEffect(() => {
    void loadDisk();
  }, [loadDisk]);

  const advice = disk?.trimAdvice ?? null;
  const breakdown = disk ? [...disk.breakdown].sort((a, b) => b.bytes - a.bytes).slice(0, 8) : [];
  const maxBytes = breakdown[0]?.bytes ?? 1;

  const runTrim = async (): Promise<void> => {
    setTrimBusy(true);
    try {
      const res = await window.sweepdeck.diskTrim({ consent: true });
      setToast({
        kind: res.ok ? 'success' : 'info',
        title: res.ok ? 'TRIM command completed' : 'TRIM advisory',
        detail: res.error ?? res.output ?? undefined,
      });
    } catch (err) {
      setToast({ kind: 'error', title: 'TRIM failed', detail: String((err as Error)?.message ?? err) });
    } finally {
      setTrimBusy(false);
      setTrimOpen(false);
      setConsented(false);
    }
  };

  return (
    <div>
      <h1>Disk Status</h1>
      <p className="sec">
        Usage, SMART health (best-effort) and TRIM advice. SweepDeck never elevates without explicit
        consent — and v1 never elevates at all: it shows you the exact command instead.
      </p>

      {diskError && <ErrorState node="disk.status" message={diskError} />}
      {diskLoading && !disk && (
        <div className="card" style={{ marginTop: 16 }}>
          <SkeletonRows rows={4} />
        </div>
      )}

      {disk && (
        <>
          <div className="vols" style={{ marginTop: 16 }}>
            {disk.volumes.map((v) => (
              <VolumeCard v={v} key={v.mount} />
            ))}
          </div>

          <div className="card tmap">
            <h2>
              Where the space goes{' '}
              <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--fs-sm)' }}>
                — top-level breakdown of the home volume
              </span>
            </h2>
            {breakdown.length === 0 ? (
              <EmptyState icon="◔" title="No breakdown yet" body="Run a scan to size top-level directories." />
            ) : (
              <div className="tgrid" role="img" aria-label={`Treemap: ${breakdown.map((b) => `${b.path} ${fmtBytes(b.bytes)}`).join(', ')}`}>
                {breakdown.map((b, i) => (
                  <div
                    className="tcell"
                    key={b.path}
                    style={{
                      background: CHART[i % CHART.length],
                      flexGrow: Math.max(1, Math.round((b.bytes / maxBytes) * 8)),
                      flexBasis: 96 + Math.round((b.bytes / maxBytes) * 160),
                    }}
                  >
                    {b.path}
                    <small>{fmtBytes(b.bytes)}</small>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card trim">
            <span style={{ fontSize: 20, color: 'var(--accent)' }} aria-hidden="true">
              ◆
            </span>
            <span className="grow">
              <b>TRIM advisory</b>
              <br />
              <span className="sec">{advice?.message ?? 'No TRIM information available.'}</span>
              {advice?.command && (
                <>
                  <br />
                  <span className="mono muted">would run: {advice.command}</span>{' '}
                  <button
                    className="btn sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(advice.command ?? '');
                      setToast({ kind: 'info', title: 'Command copied', detail: advice.command ?? '' });
                    }}
                  >
                    Copy
                  </button>
                </>
              )}
            </span>
            <button
              className="btn"
              disabled={!advice?.command}
              title={!advice?.command ? (advice?.autoTrimLikely ? 'The OS already trims automatically' : 'No TRIM command applicable') : undefined}
              onClick={() => setTrimOpen(true)}
            >
              Review TRIM command…
            </button>
          </div>
        </>
      )}

      {trimOpen && advice?.command && (
        <Modal titleId={titleId} onClose={() => { setTrimOpen(false); setConsented(false); }}>
          <h3 id={titleId}>Run TRIM with administrator privileges?</h3>
          <span className="sec">Exactly what will happen:</span>
          <div className="cmd">$ {advice.command}</div>
          <ul className="what">
            <li>
              <span className="tick">✓</span>
              <span>
                SweepDeck v1 is advisory: it will NOT execute this command. You get the exact command
                back to run yourself in a terminal.
              </span>
            </li>
            <li>
              <span className="tick">✓</span>
              <span>If you run it yourself, the OS prompts for your administrator password — SweepDeck never sees it</span>
            </li>
            <li>
              <span className="tick">✓</span>
              <span>{advice.autoTrimLikely ? 'Your OS most likely trims automatically already — a manual pass is optional' : 'A reboot may be required for the change to take effect'}</span>
            </li>
          </ul>
          <label className="consent">
            <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
            <span>I understand this concerns an elevated system command and may require a reboot</span>
          </label>
          <div className="actions">
            <button className="btn" onClick={() => { setTrimOpen(false); setConsented(false); }}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!consented || trimBusy}
              title={!consented ? 'Enabled once the consent box is checked' : undefined}
              onClick={() => void runTrim()}
            >
              {trimBusy ? 'Working…' : 'Get command'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
