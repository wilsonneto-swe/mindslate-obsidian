/**
 * Drop-target rule for dragging a node (with its subtree) to a new place. Pure functions over a
 * layout (layout/types.ts), no DOM: the editor calls dropTarget() on every pointermove and
 * insertionPoint() for the preview, both O(visible nodes) with cheap arithmetic, and never touches
 * the layout while a drag is active.
 *
 * dropTarget(lay, draggedId, px, py) -> { parentId, index, kind, refId, dist } | null  (px, py in WORLD units)
 *   candidates = visible nodes minus the dragged node and its descendants
 *   T = the candidate whose box is nearest to the pointer (distance to the rectangle); none within
 *       MAX_DIST -> null (the drop cancels)
 *   T is the root            -> child of the root at the index given by py among its visible children
 *   px > T.right + CHILD_PAD -> child of T at the index given by py among T's visible children
 *   otherwise                -> sibling of T: before T when py < T.cy, else after T
 * `index` is the position among the CURRENT visible children of `parentId` ("before the first child
 * whose cy is below the pointer, else last"); the dragged node itself counts when it is one of them
 * and model/tree.ts moveNode adjusts a same-parent move. A collapsed (or childless) T has no visible
 * children, so `index` is 0 there: the editor appends behind the hidden children and expands T.
 */
import type { Layout, LayoutNode, LayoutTheme } from '../layout/types.js';

/** World px: farther than this from every candidate = no target. */
export const MAX_DIST = 160;
/** World px right of a node's box: "make it a child of that node". */
export const CHILD_PAD = 8;
/** The insertion bar sits this far above the first / below the last child band. */
export const EDGE_PAD = 6;

export type DropKind = 'child' | 'before' | 'after';

export interface DropTarget {
  readonly parentId: string;
  /** Position among the current visible children of `parentId`. */
  readonly index: number;
  readonly kind: DropKind;
  /** The candidate node the rule picked (the new parent for 'child', the sibling otherwise). */
  readonly refId: string;
  readonly dist: number;
}

export type Box = Pick<LayoutNode, 'x' | 'y' | 'w' | 'h'>;

/** The dragged node and all its visible descendants (the nodes that can never be a target). */
export function subtreeIds(lay: Layout, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
    out.add(x);
    const L = lay.nodes.get(x);
    if (L) for (const c of L.childIds) stack.push(c);
  }
  return out;
}

/** Distance from a point to a node box (0 inside). */
export function rectDist(L: Box, px: number, py: number): number {
  const dx = Math.max(L.x - px, 0, px - (L.x + L.w));
  const dy = Math.max(L.y - py, 0, py - (L.y + L.h));
  return Math.hypot(dx, dy);
}

function indexByY(lay: Layout, childIds: readonly string[], py: number): number {
  for (let i = 0; i < childIds.length; i++) {
    const id = childIds[i];
    const c = id === undefined ? undefined : lay.nodes.get(id);
    if (c && c.cy > py) return i;
  }
  return childIds.length;
}

/**
 * @param lay       layout (lay.order = visible nodes in pre-order, lay.nodes = id -> box)
 * @param draggedId the node being dragged
 * @param px        pointer x in world coordinates
 * @param py        pointer y in world coordinates
 * @param excluded  optional precomputed subtreeIds(lay, draggedId) (the layout does not change during a drag)
 * @param maxDist   cutoff (default MAX_DIST)
 */
export function dropTarget(
  lay: Layout,
  draggedId: string,
  px: number,
  py: number,
  excluded: ReadonlySet<string> = subtreeIds(lay, draggedId),
  maxDist = MAX_DIST,
): DropTarget | null {
  let T: LayoutNode | null = null;
  let best = Infinity;
  for (const L of lay.order) {
    if (excluded.has(L.id)) continue;
    const d = rectDist(L, px, py);
    if (d < best) {
      best = d;
      T = L;
    }
  }
  if (!T || best > maxDist) return null;
  if (T.depth === 0 || px > T.x + T.w + CHILD_PAD) {
    return { parentId: T.id, index: indexByY(lay, T.childIds, py), kind: 'child', refId: T.id, dist: best };
  }
  const P = T.parentId === null ? undefined : lay.nodes.get(T.parentId);
  if (!P) return { parentId: T.id, index: indexByY(lay, T.childIds, py), kind: 'child', refId: T.id, dist: best };
  const i = P.childIds.indexOf(T.id);
  const before = py < T.cy;
  return { parentId: P.id, index: before ? i : i + 1, kind: before ? 'before' : 'after', refId: T.id, dist: best };
}

/** True when dropping `target` would leave the dragged node where it is (same parent, same effective position). */
export function isNoop(lay: Layout, draggedId: string, target: Pick<DropTarget, 'parentId' | 'index'> | null): boolean {
  const L = lay.nodes.get(draggedId);
  if (!L || !target || L.parentId === null || L.parentId !== target.parentId) return false;
  const P = lay.nodes.get(L.parentId);
  if (!P) return false;
  const i = P.childIds.indexOf(draggedId);
  return target.index === i || target.index === i + 1;
}

export interface InsertionPoint {
  readonly x: number;
  readonly y: number;
  readonly parent: LayoutNode;
}

/**
 * Where the insertion bar goes for `target`: x = the children's column of the new parent, y = between
 * the two sibling bands it lands between (EDGE_PAD above the first / below the last; the parent's cy
 * when it has no visible children). World units.
 */
export function insertionPoint(lay: Layout, target: Pick<DropTarget, 'parentId' | 'index'>, theme: Pick<LayoutTheme, 'hGap' | 'hGapRoot'>): InsertionPoint {
  const P = lay.nodes.get(target.parentId);
  if (!P) throw new Error(`insertionPoint: unknown parent ${target.parentId}`);
  const x = P.x + P.w + (P.depth === 0 ? theme.hGapRoot : theme.hGap);
  const kids = P.childIds;
  const at = (i: number): LayoutNode | undefined => {
    const id = kids[i];
    return id === undefined ? undefined : lay.nodes.get(id);
  };
  let y = P.cy;
  const first = at(0);
  const last = at(kids.length - 1);
  if (!kids.length || !first || !last) y = P.cy;
  else if (target.index <= 0) y = first.bandTop - EDGE_PAD;
  else if (target.index >= kids.length) y = last.bandTop + last.bandH + EDGE_PAD;
  else {
    const a = at(target.index - 1);
    const b = at(target.index);
    y = a && b ? (a.bandTop + a.bandH + b.bandTop) / 2 : P.cy;
  }
  return { x, y, parent: P };
}
