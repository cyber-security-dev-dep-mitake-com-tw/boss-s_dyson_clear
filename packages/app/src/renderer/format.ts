import type { Provenance } from '@contracts';

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (Math.abs(v) >= 1024 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(v < 1 ? 2 : 1)} ${units[u]}`;
}

export function fmtWhen(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `Today ${hm}`;
  const y = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtAge(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  const days = Math.max(0, Math.floor((Date.now() - epochMs) / 86400_000));
  if (days < 1) return '<1 d';
  if (days < 14) return `${days} d`;
  if (days < 60) return `${Math.round(days / 7)} wk`;
  if (days < 540) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

export type ConfidenceBand = 'high' | 'medium' | 'low';

/** DESIGN-NOTES mapping: high >= 0.85, medium 0.6–0.85, low < 0.6. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

/** SAFETY-RULES §3.3: verdicts under 0.40 are Blocked — never checkable. */
export function isBlocked(confidence: number): boolean {
  return confidence < 0.4;
}

/** Best-effort mtime extraction from provenance evidence / detail for the Age column. */
export function evidenceMtime(prov: Provenance, detail: Record<string, unknown>): number | null {
  for (const src of [prov.evidence, detail]) {
    for (const key of ['mtime', 'mtimeMs', 'modifiedAt', 'lastOpened', 'atime']) {
      const v = src?.[key];
      if (typeof v === 'number' && v > 0) {
        // Accept both epoch-seconds and epoch-ms.
        return v < 10_000_000_000 ? v * 1000 : v;
      }
    }
  }
  return null;
}
