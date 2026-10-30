/**
 * Collapse / expand handles (pure geometry; the renderer draws them, the editor hit-tests and frames them).
 *
 * Collapse is VIEW state: a handle click never adds an undo step, never changes the file text (unless the
 * file already persists folds) and never fires onChange. The keyboard is unchanged (Mod+/ toggles, Right
 * on a collapsed node expands it and enters a child).
 *
 *  BADGE  on a collapsed node (it has children and is collapsed): a short horizontal stub BADGE_GAP px
 *         long from the node's right edge at its cy (same stroke width and branch colour as the fan it
 *         stands in for) ending in a round badge: a BADGE_SIZE px circle in the branch colour (a pill of
 *         radius 10 when the count has 3+ digits) holding the count of ALL hidden descendants in white
 *         12 px/600 tabular numerals. Always visible. A click or tap expands the node.
 *  RING   on an expanded node with visible children, the root excepted: a circle 2 * RING_REACH px
 *         across (RING_STROKE px stroke in the branch colour, filled with the root-box slate #2A3448, as
 *         measured on the Whimsical reference) centred on the end of its stub, where the children's
 *         curves start: (node.x + node.w + stub, node.cy). Visible while the pointer is over the node, its
 *         hover bridge or the ring, and while the node is selected. A RING_HIT px circle takes the click,
 *         which collapses the node.
 *
 * Both handles toggle on the RELEASE of a press that stayed a click or a tap (view/editor.ts).
 *
 * Handles never change the layout (the 66 / 120 px gap right of a node has room for them) and are part
 * of the bounds used by fit, the opening view and keep-in-view (handleRect, boxWithHandle, boundsWithHandles).
 */
import type { MapNode } from '../format/types.js';
import type { Bounds, LayoutNode } from '../layout/types.js';
import { subtreeSize } from '../model/tree.js';

/** Stub length: node right edge -> badge left edge. */
export const BADGE_GAP = 12;
/** Badge circle diameter = pill height. */
export const BADGE_SIZE = 20;
/** Horizontal padding of a 3+ digit pill. */
export const BADGE_PILL_PAD = 6;
/** Estimated width of one tabular digit at 12 px / 600, for the bounds of a pill (the DOM sizes the real one). */
export const BADGE_DIGIT_W = 7.5;
/** Ring radius (centre of the stroke) and stroke width: 20 px across with a 4 px stroke (editor.css .mm-ring::before). */
export const RING_R = 8;
export const RING_STROKE = 4;
/** The ring's outer radius: how far it reaches around the end of the stub (fit and keep-in-view bounds). */
export const RING_REACH = RING_R + RING_STROKE / 2;
/** Diameter of the ring's circular hit area. */
export const RING_HIT = 24;

export type HandleKind = 'ring' | 'badge';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The handle a visible node shows, or null (a leaf, or the root while expanded). */
export function handleKind(L: Pick<LayoutNode, 'depth' | 'childIds'>, node: MapNode): HandleKind | null {
  if (node.collapsed === true && node.children.length > 0) return 'badge';
  if (L.depth > 0 && L.childIds.length > 0) return 'ring';
  return null;
}

/** What a collapsed node's badge shows: the number of ALL its descendants (memoised per node object). */
export const hiddenCount = (node: MapNode): number => subtreeSize(node) - 1;

/** 3+ digits: the circle grows into a pill. */
export const isPill = (count: number): boolean => count >= 100;

/** Badge width in world px (a pill is estimated from its digit count). */
export const badgeWidth = (count: number): number =>
  isPill(count) ? 2 * BADGE_PILL_PAD + BADGE_DIGIT_W * String(count).length : BADGE_SIZE;

/** Centre of a node's ring: the end of its stub, where the children's curves start. */
export function ringCenter(L: Pick<LayoutNode, 'x' | 'w' | 'cy'>, stub: number): [number, number] {
  return [L.x + L.w + stub, L.cy];
}

/** The badge itself (without its stub). */
export function badgeRect(L: Pick<LayoutNode, 'x' | 'w' | 'cy'>, count: number): Rect {
  return { x: L.x + L.w + BADGE_GAP, y: L.cy - BADGE_SIZE / 2, w: badgeWidth(count), h: BADGE_SIZE };
}

/** World rect a node's handle paints (ring: its outer circle; badge: stub + badge), or null. */
export function handleRect(L: LayoutNode, node: MapNode, stub: number): Rect | null {
  const kind = handleKind(L, node);
  if (kind === 'ring') {
    const [cx, cy] = ringCenter(L, stub);
    const r = RING_REACH;
    return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
  }
  if (kind === 'badge') {
    const b = badgeRect(L, hiddenCount(node));
    return { x: L.x + L.w, y: b.y, w: b.x + b.w - (L.x + L.w), h: b.h };
  }
  return null;
}

const union = (a: Rect, b: Rect | null): Rect => {
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The node box grown to include its handle (keep-in-view: a selected node shows its ring or badge). */
export function boxWithHandle(L: LayoutNode, node: MapNode, stub: number): Rect {
  return union(L, handleRect(L, node, stub));
}

/** `bounds` (the node boxes) grown by every visible node's handle: what fit and the opening view frame. */
export function boundsWithHandles(
  bounds: Bounds,
  order: Iterable<LayoutNode>,
  nodeOf: (id: string) => MapNode | undefined,
  stub: number,
): Bounds {
  let b: Rect = bounds;
  for (const L of order) {
    const n = nodeOf(L.id);
    if (n !== undefined) b = union(b, handleRect(L, n, stub));
  }
  return b;
}
