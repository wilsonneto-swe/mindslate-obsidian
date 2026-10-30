/** Text measurement interfaces and the layout's output types. Pure data, no DOM. */

/** One depth class of text (0 = root, 1 = first level, 2 = deeper). `key` is part of the measure cache key. */
export interface TextStyle {
  readonly key: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: number;
  readonly maxWidth: number;
  readonly padX: number;
  readonly padY: number;
}

export interface TextLine {
  readonly text: string;
  readonly width: number;
}

/** What a measurer returns: the tight box of the wrapped text. `lines` is null for a DOM measurer. */
export interface TextMetrics {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly TextLine[] | null;
}

export type MeasureText = (text: string, style: TextStyle) => TextMetrics;

/** The part of the theme the layout needs (the render theme extends it with colours and strokes). */
export interface LayoutTheme {
  readonly styles: readonly [TextStyle, TextStyle, TextStyle];
  /** Root box right edge -> level-1 box left edge. */
  readonly hGapRoot: number;
  /** Parent box right edge -> child box left edge. */
  readonly hGap: number;
  /** Band-to-band gap between two leaf siblings, by depth class. */
  readonly siblingGap: readonly number[];
  /** ... when either neighbour shows children. */
  readonly subtreeGap: readonly number[];
}

export type Side = 1 | -1 | 0;

export interface LayoutNode {
  readonly id: string;
  readonly depth: number;
  /** +1 right of the root, -1 left (balanced mode), 0 for the root. */
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Vertical middle of the box. */
  readonly cy: number;
  readonly parentId: string | null;
  /** Visible children, in document order. */
  readonly childIds: readonly string[];
  /** Index of the level-1 ancestor among the root's children (the colour key); -1 for the root. */
  readonly branch: number;
  readonly lines: readonly TextLine[] | null;
  /** The horizontal band the whole subtree owns. */
  readonly bandTop: number;
  readonly bandH: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type LayoutMode = 'right' | 'balanced';

export interface Layout {
  readonly nodes: ReadonlyMap<string, LayoutNode>;
  /** Visible nodes in pre-order (DFS). */
  readonly order: readonly LayoutNode[];
  readonly rootId: string;
  readonly mode: LayoutMode;
  readonly bounds: Bounds;
}

export const depthClass = (d: number): 0 | 1 | 2 => (d > 2 ? 2 : d < 1 ? 0 : d === 1 ? 1 : 2);
