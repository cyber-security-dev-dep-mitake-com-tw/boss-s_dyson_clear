/**
 * VirtualTable — simple windowing, no external dependency. Renders only the
 * visible slice of rows plus spacer rows above/below.
 */
import { useRef, useState, type ReactNode } from 'react';

interface VirtualTableProps<T> {
  rows: T[];
  rowHeight: number;
  maxHeight: number;
  colgroup?: ReactNode;
  header: ReactNode; // a <tr>
  renderRow: (row: T, index: number) => ReactNode; // a <tr> (stable key required)
  overscan?: number;
  footNote?: ReactNode;
}

export function VirtualTable<T>({
  rows,
  rowHeight,
  maxHeight,
  colgroup,
  header,
  renderRow,
  overscan = 8,
  footNote,
}: VirtualTableProps<T>): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const viewport = Math.min(maxHeight, rows.length * rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
  const end = Math.min(rows.length, start + visible);
  const topPad = start * rowHeight;
  const bottomPad = Math.max(0, (rows.length - end) * rowHeight);
  const windowed = rows.length * rowHeight > maxHeight;

  return (
    <div>
      <div
        ref={ref}
        style={{ maxHeight, overflowY: 'auto' }}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <table>
          {colgroup}
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-raised)', zIndex: 2 }}>
            {header}
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr aria-hidden="true" style={{ height: topPad }}>
                <td style={{ padding: 0, border: 0 }} colSpan={99} />
              </tr>
            )}
            {rows.slice(start, end).map((row, i) => renderRow(row, start + i))}
            {bottomPad > 0 && (
              <tr aria-hidden="true" style={{ height: bottomPad }}>
                <td style={{ padding: 0, border: 0 }} colSpan={99} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {windowed && (
        <div className="virt">
          ⋮ {rows.length.toLocaleString()} rows (virtualized) ⋮ {footNote}
        </div>
      )}
    </div>
  );
}
