/**
 * ApprovalGate — THE shared approval-gate furniture (DESIGN-NOTES, normative):
 * sticky summary bar → confirm modal titled as a question with a literal
 * "exactly what will happen" list (+ per-item provenance popover) → onConfirm.
 * Every destructive flow (clean / uninstall / kill / TRIM consent) uses this.
 * onConfirm is the ONLY call site of the executor for its flow.
 */
import { useId, useState, type ReactNode } from 'react';
import type { Verdict } from '@contracts';
import { fmtBytes } from '../format';
import { Modal } from './Modal';
import { ProvenancePopover } from './ProvenancePopover';

export interface ApprovalGateProps {
  /** Left side of the bar: "<b>142 items</b> selected · …". */
  summary: ReactNode;
  /** Primary button label — states the outcome, e.g. "Review & Clean 2.4 GB". */
  actionLabel: string;
  /** Disable the primary button (no selection, busy, …). */
  disabled?: boolean;
  busy?: boolean;
  /** Optional secondary button in the bar (Deselect all / Reset choices). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Confirm modal contents. */
  confirmTitle: string;
  confirmBullets: ReactNode[];
  confirmLabel: string;
  /** Danger styling for truly destructive confirms (Uninstall, Kill). */
  danger?: boolean;
  /** Selected verdicts, listed in the modal with provenance popovers. */
  items?: Verdict[];
  /** Consent checkbox text (elevation flows); confirm stays disabled until checked. */
  consentLabel?: string;
  onConfirm: () => void | Promise<void>;
}

export function ApprovalGate(props: ApprovalGateProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [working, setWorking] = useState(false);
  const titleId = useId();

  const close = (): void => {
    setOpen(false);
    setConsented(false);
  };

  const confirm = async (): Promise<void> => {
    setWorking(true);
    try {
      await props.onConfirm();
      close();
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <div className="approve-bar" role="region" aria-label="Approval bar">
        <span>{props.summary}</span>
        <span className="grow" />
        {props.secondaryLabel && (
          <button className="btn sm" onClick={props.onSecondary}>
            {props.secondaryLabel}
          </button>
        )}
        <button
          className="btn primary"
          disabled={props.disabled || props.busy}
          onClick={() => setOpen(true)}
        >
          {props.busy ? 'Working…' : props.actionLabel}
        </button>
      </div>

      {open && (
        <Modal titleId={titleId} onClose={close}>
          <h3 id={titleId}>{props.confirmTitle}</h3>
          <span className="sec">Exactly what will happen:</span>
          <ul className="what">
            {props.confirmBullets.map((b, i) => (
              <li key={i}>
                <span className="tick" aria-hidden="true">
                  ✓
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>

          {props.items && props.items.length > 0 && (
            <div className="items">
              {props.items.map((v) => (
                <div className="it" key={v.id}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {v.label} <span className="path">{v.subjectKey}</span>
                  </span>
                  <span className="num sec">{fmtBytes(v.sizeBytes)}</span>
                  <ProvenancePopover provenance={v.provenance} />
                </div>
              ))}
            </div>
          )}

          {props.consentLabel && (
            <label className="consent">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
              />
              <span>{props.consentLabel}</span>
            </label>
          )}

          <div className="actions">
            {/* Cancel first: it receives initial focus — destructive confirm never does. */}
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className={`btn ${props.danger ? 'danger' : 'primary'}`}
              disabled={working || (props.consentLabel ? !consented : false)}
              title={props.consentLabel && !consented ? 'Enabled once the consent box is checked' : undefined}
              onClick={() => void confirm()}
            >
              {working ? 'Working…' : props.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
