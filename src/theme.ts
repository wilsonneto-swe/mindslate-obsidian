/**
 * THEME: the map follows Obsidian's theme, light and dark and the accent colour, and switches live (main.ts listens to
 * the workspace's `css-change` event). Two halves:
 *  - the stylesheet's colours are the core's custom properties (--mm-canvas, --mm-accent, ...), which styles.css sets on
 *    the view to Obsidian's own variables (--background-primary, --interactive-accent, ...): they follow by themselves;
 *  - the colours the core paints from script (MapColors: the branch palette, the selection colour, a collapsed root's
 *    badge) are resolved from those variables at the view and handed to EditorHandle.setColors (mapColors below).
 * The branch palette keeps its hues in both themes (a branch keeps its colour index): the core's dark palette on a dark
 * background, LIGHT_PALETTE, the same hues darker, on a light one. CONTRAST: connectors, rings and badges need 3:1
 * against the canvas (WCAG's non-text contrast); theme.test.ts checks both palettes against Obsidian's backgrounds.
 */
import { PALETTE, type MapColors } from '../core/index.js';

/** The branch colours on a dark canvas: the core's own (the desktop and web apps). */
export const DARK_PALETTE: readonly string[] = PALETTE;

/** The branch colours on a light canvas, in the core's order of hues (purple, blue, teal, gold, crimson, orange, green, pink). */
export const LIGHT_PALETTE: readonly string[] = Object.freeze(['#7048E8', '#1F66D1', '#0B7C72', '#956A00', '#C42F45', '#B5520C', '#2E7D1F', '#B83280']);

/** The minimum contrast of a branch colour against the canvas (connectors and handles are graphics: 3:1). */
export const MIN_GRAPHIC_CONTRAST = 3;

/** [r, g, b] (0-255) of a hex (#rgb, #rrggbb) or rgb()/rgba() colour, or null for anything else. */
export function parseColor(css: string): [number, number, number] | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex !== null) {
    const h = hex[1] ?? '';
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two colours (1 to 21); NaN when either is not a colour parseColor reads. */
export function contrastRatio(a: string, b: string): number {
  const x = parseColor(a);
  const y = parseColor(b);
  if (x === null || y === null) return Number.NaN;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether a canvas colour is dark (the palette to use when the theme's class does not say). */
export function isDarkColor(css: string): boolean {
  const c = parseColor(css);
  return c !== null && luminance(c) < 0.18;
}

/** What the view reads from Obsidian's variables when the theme changes. */
export interface ObsidianTheme {
  /** body.theme-dark (Obsidian's own switch). */
  readonly dark: boolean;
  /** --interactive-accent, resolved. */
  readonly accent: string;
  /** --text-muted, resolved: a collapsed root's badge (neutral, like the core's slate). */
  readonly muted: string;
}

/** The colours the core paints from script for this theme (EditorHandle.setColors). */
export function mapColors(t: ObsidianTheme): MapColors {
  return { palette: t.dark ? DARK_PALETTE : LIGHT_PALETTE, selection: t.accent, rootBadge: t.muted };
}
