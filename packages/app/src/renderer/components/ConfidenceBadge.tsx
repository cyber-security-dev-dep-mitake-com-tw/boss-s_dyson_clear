import { confidenceBand } from '../format';

interface Props {
  confidence: number;
  /** Optional extra word after the number, e.g. "installer". */
  label?: string;
}

/** Dot + word + number — never color alone (DESIGN-NOTES accessibility). */
export function ConfidenceBadge({ confidence, label }: Props): JSX.Element {
  const band = confidenceBand(confidence);
  const word = band === 'high' ? 'high' : band === 'medium' ? 'medium' : 'low';
  const cls = band === 'high' ? 'conf-high' : band === 'medium' ? 'conf-med' : 'conf-low';
  return (
    <span className={`badge ${cls}`}>
      <span className="bdot" aria-hidden="true" />
      {label ? (
        <>
          <span className="num">{confidence.toFixed(2)}</span> {label}
        </>
      ) : (
        <>
          {word} · <span className="num">{confidence.toFixed(2)}</span>
        </>
      )}
    </span>
  );
}
