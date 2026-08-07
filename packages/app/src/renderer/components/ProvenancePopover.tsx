import type { Provenance } from '@contracts';
import { fmtWhen } from '../format';

/** One-click provenance disclosure: scanner, rule, evidence, confidence, time.
 *  A verdict without resolvable provenance is treated as Blocked upstream. */
export function ProvenancePopover({ provenance }: { provenance: Provenance }): JSX.Element {
  const evidence = Object.entries(provenance.evidence ?? {}).slice(0, 6);
  return (
    <details className="prov-pop">
      <summary aria-label="Show provenance">provenance</summary>
      <span className="bubble" role="note">
        <b>
          {provenance.scanner} · {provenance.rule}
        </b>
        <ul>
          {evidence.length === 0 ? (
            <li className="muted">no recorded evidence</li>
          ) : (
            evidence.map(([k, v]) => (
              <li key={k}>
                {k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </li>
            ))
          )}
        </ul>
        <span className="prov">
          confidence {provenance.confidence.toFixed(2)} · extracted {fmtWhen(provenance.extractedAt)}
        </span>
      </span>
    </details>
  );
}
