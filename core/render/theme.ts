/**
 * Visual constants (px at zoom 1), tuned to match Whimsical's dark theme.
 * Depth class: 0 = root, 1 = first level, 2 = everything deeper. The CSS in view/editor.css
 * repeats the font sizes, paddings and colours; keep both in step.
 *
 * THEMING: THEME.colors and PALETTE are the DARK theme, the look of the desktop and web apps. The stylesheet reads
 * every colour of its own from a custom property with that theme's value as the fallback (view/editor.css,
 * `var(--mm-canvas, #0E1526)`); the colours the editor paints from script are a MapColors object
 * (EditorOptions.colors, EditorHandle.setColors), DEFAULT_COLORS unless a host gives others. With neither set the
 * map looks exactly as it always did.
 */
import type { LayoutTheme, TextStyle } from '../layout/types.js';

export const PALETTE: readonly string[] = Object.freeze([
  '#9D7CFF', // purple
  '#4E8DF5', // blue
  '#22B5A5', // teal
  '#E2B53E', // gold
  '#E0505F', // crimson
  '#F08A3C', // orange
  '#7CC45A', // green (7th+ branches)
  '#E46FB5', // pink
]);

export const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface ThemeColors {
  readonly background: string;
  readonly dot: string;
  readonly dotSpacing: number;
  readonly rootFill: string;
  readonly rootText: string;
  readonly text1: string;
  readonly text2: string;
  readonly selection: string;
  /** Badge (and stub) colour of a collapsed root, which has no branch colour; its count is drawn dark on it. */
  readonly rootBadge: string;
}

export interface Theme extends LayoutTheme {
  /** Straight horizontal stub out of a non-root parent. */
  readonly stub: number;
  /** Root connectors start this far *inside* the root box (the box is painted on top). */
  readonly rootInset: number;
  /** Bezier control-point distance as a fraction of the horizontal run. */
  readonly curvature: number;
  /** Indexed by the CHILD's depth (clamped to last). */
  readonly strokeByDepth: readonly number[];
  readonly colors: ThemeColors;
  readonly fontFamily: string;
  readonly ascent: number;
}

const style = (s: TextStyle): TextStyle => Object.freeze(s);

export const THEME: Theme = Object.freeze({
  styles: [
    style({ key: 'd0', fontSize: 28, lineHeight: 36, fontWeight: 600, maxWidth: 440, padX: 22, padY: 13 }),
    style({ key: 'd1', fontSize: 22, lineHeight: 30, fontWeight: 400, maxWidth: 520, padX: 6, padY: 3 }),
    style({ key: 'd2', fontSize: 20, lineHeight: 27, fontWeight: 400, maxWidth: 520, padX: 6, padY: 3 }),
  ] as const,
  hGapRoot: 120, // root box right edge  -> level-1 box left edge
  hGap: 66, // parent box right edge -> child box left edge (= stub + curve run)
  stub: 20,
  rootInset: 14,
  curvature: 0.5,
  siblingGap: Object.freeze([0, 24, 12]), // band-to-band gap between two leaf siblings, by depth class
  subtreeGap: Object.freeze([0, 36, 18]), // ... when either neighbour shows children
  strokeByDepth: Object.freeze([3, 3, 3, 2.5, 2]),
  colors: Object.freeze({
    background: '#0E1526',
    dot: '#26324B',
    dotSpacing: 22,
    rootFill: '#2A3448',
    rootText: '#FFFFFF',
    text1: '#EEF1F7',
    text2: '#DCE1EA',
    selection: '#5B9BFF',
    rootBadge: '#9fb0d0',
  }),
  fontFamily: FONT_FAMILY,
  ascent: 0.77,
});

export const strokeFor = (theme: Theme, childDepth: number): number =>
  theme.strokeByDepth[Math.min(childDepth, theme.strokeByDepth.length - 1)] ?? 2;

/**
 * The colours the editor paints from script (inline styles and SVG attributes, which no stylesheet reaches). Every
 * other colour is a custom property of view/editor.css.
 */
export interface MapColors {
  /**
   * The branch colours: a first-level branch takes one when the map opens (by position) or when it is created (the
   * least used), and keeps its index for the session (render/colors.ts). Its connectors, its rings and badges, its
   * "+" buttons and its drag ghost are drawn in it.
   */
  readonly palette: readonly string[];
  /** The selection colour where script paints it: the root's "+" buttons, the drop preview into the root, a dragged group's ghost. */
  readonly selection: string;
  /** The badge (and its stub) of a collapsed root, which has no branch colour; its numerals are --mm-root-badge-text. */
  readonly rootBadge: string;
}

/** The dark theme's script colours: PALETTE, THEME.colors.selection and THEME.colors.rootBadge. */
export const DEFAULT_COLORS: MapColors = Object.freeze({
  palette: PALETTE,
  selection: THEME.colors.selection,
  rootBadge: THEME.colors.rootBadge,
});

/**
 * The colours to paint with: every field the host gives (a palette needs at least one colour), DEFAULT_COLORS for the
 * rest. A field the host leaves out is the default again, not the value of an earlier call.
 */
export function resolveColors(given: Partial<MapColors> | undefined): MapColors {
  const palette = given?.palette !== undefined && given.palette.length > 0 ? Object.freeze([...given.palette]) : DEFAULT_COLORS.palette;
  return Object.freeze({
    palette,
    selection: given?.selection ?? DEFAULT_COLORS.selection,
    rootBadge: given?.rootBadge ?? DEFAULT_COLORS.rootBadge,
  });
}
