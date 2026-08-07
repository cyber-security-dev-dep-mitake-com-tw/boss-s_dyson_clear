import { fmtBytes } from '../format';

export interface DonutSegment {
  label: string;
  bytes: number;
  color: string;
}

interface DonutProps {
  title: string;
  totalBytes: number;
  segments: DonutSegment[]; // used portions; free is derived
  usedBytes: number;
}

/** Volume donut (conic-gradient) + legend with values — role="img" with the numbers. */
export function Donut({ title, totalBytes, segments, usedBytes }: DonutProps): JSX.Element {
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  const pctUsed = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const stops: string[] = [];
  let acc = 0;
  for (const seg of segments) {
    const from = totalBytes > 0 ? (acc / totalBytes) * 100 : 0;
    acc += seg.bytes;
    const to = totalBytes > 0 ? (acc / totalBytes) * 100 : 0;
    stops.push(`${seg.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`);
  }
  stops.push(`var(--free) ${totalBytes > 0 ? ((acc / totalBytes) * 100).toFixed(2) : 0}% 100%`);

  return (
    <div className="card vol">
      <div className="donut-wrap">
        <div
          className="donut"
          role="img"
          aria-label={`${title}: ${fmtBytes(usedBytes)} of ${fmtBytes(totalBytes)} used`}
          style={{ background: `conic-gradient(${stops.join(',')})` }}
        />
        <div className="donut-center">
          <span>
            <b className="num">{pctUsed}%</b>
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              used
            </span>
          </span>
        </div>
      </div>
      <div className="legend">
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          {title}{' '}
          <span className="muted num">
            · {fmtBytes(usedBytes)} / {fmtBytes(totalBytes)}
          </span>
        </div>
        {segments.map((seg) => (
          <div className="lrow" key={seg.label}>
            <span className="sw" style={{ background: seg.color }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {seg.label}
            </span>
            <span className="grow" />
            <span className="num sec">{fmtBytes(seg.bytes)}</span>
          </div>
        ))}
        <div className="lrow">
          <span className="sw" style={{ background: 'var(--free)' }} />
          Free
          <span className="grow" />
          <span className="num sec">{fmtBytes(freeBytes)}</span>
        </div>
      </div>
    </div>
  );
}
