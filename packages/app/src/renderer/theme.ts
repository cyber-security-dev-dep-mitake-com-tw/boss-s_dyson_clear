/**
 * theme.ts — turns design/tokens.json into CSS custom properties at startup.
 * Dark is the primary theme (:root); the tokens' `color.light` block becomes a
 * `prefers-color-scheme: light` override of the color roles only.
 */
import tokens from '@tokens';

type ColorBlock = {
  bg: { base: string; raised: string; overlay: string; inset: string };
  text: { primary: string; secondary: string; muted: string; onAccent: string; disabled: string };
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentSubtle: string;
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;
  info: string;
  infoSubtle: string;
  confidence: { high: string; medium: string; low: string };
  chart: { categorical: string[]; track: string; gridline: string; free: string };
  border: string;
  borderStrong: string;
  focusRing: string;
  scrim: string;
};

function colorVars(c: ColorBlock): string {
  const lines: string[] = [
    `--bg-base:${c.bg.base}`,
    `--bg-raised:${c.bg.raised}`,
    `--bg-overlay:${c.bg.overlay}`,
    `--bg-inset:${c.bg.inset}`,
    `--text-1:${c.text.primary}`,
    `--text-2:${c.text.secondary}`,
    `--text-3:${c.text.muted}`,
    `--on-accent:${c.text.onAccent}`,
    `--text-disabled:${c.text.disabled}`,
    `--accent:${c.accent}`,
    `--accent-hover:${c.accentHover}`,
    `--accent-pressed:${c.accentPressed}`,
    `--accent-subtle:${c.accentSubtle}`,
    `--success:${c.success}`,
    `--success-subtle:${c.successSubtle}`,
    `--warning:${c.warning}`,
    `--warning-subtle:${c.warningSubtle}`,
    `--danger:${c.danger}`,
    `--danger-subtle:${c.dangerSubtle}`,
    `--info:${c.info}`,
    `--info-subtle:${c.infoSubtle}`,
    `--conf-high:${c.confidence.high}`,
    `--conf-med:${c.confidence.medium}`,
    `--conf-low:${c.confidence.low}`,
    `--track:${c.chart.track}`,
    `--gridline:${c.chart.gridline}`,
    `--free:${c.chart.free}`,
    `--border:${c.border}`,
    `--border-strong:${c.borderStrong}`,
    `--focus:${c.focusRing}`,
    `--scrim:${c.scrim}`,
  ];
  c.chart.categorical.forEach((hex, i) => lines.push(`--c${i + 1}:${hex}`));
  return lines.join(';');
}

function nonColorVars(): string {
  const f = tokens.font;
  const lines: string[] = [
    `--font-ui:${f.family.ui}`,
    `--mono:${f.family.mono}`,
    `--fs-xs:${f.size.xs}`,
    `--fs-sm:${f.size.sm}`,
    `--fs-md:${f.size.md}`,
    `--fs-lg:${f.size.lg}`,
    `--fs-xl:${f.size.xl}`,
    `--fs-xxl:${f.size.xxl}`,
  ];
  for (const [k, v] of Object.entries(tokens.space)) lines.push(`--sp-${k}:${v}`);
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`--r-${k}:${v}`);
  for (const [k, v] of Object.entries(tokens.shadow)) lines.push(`--sh-${k}:${v}`);
  for (const [k, v] of Object.entries(tokens.motion.duration)) lines.push(`--dur-${k}:${v}`);
  for (const [k, v] of Object.entries(tokens.motion.easing)) lines.push(`--ease-${k}:${v}`);
  return lines.join(';');
}

export function injectTheme(): void {
  const dark = tokens.color as unknown as ColorBlock;
  const light = (tokens.color as unknown as { light: ColorBlock }).light;
  const css = [
    `:root{${colorVars(dark)};${nonColorVars()}}`,
    `@media (prefers-color-scheme: light){:root{${colorVars(light)}}}`,
  ].join('\n');
  const style = document.createElement('style');
  style.id = 'sweepdeck-theme';
  style.textContent = css;
  document.head.appendChild(style);
}
