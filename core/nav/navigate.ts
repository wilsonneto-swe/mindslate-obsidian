/**
 * Arrow-key navigation over a computed layout (pure; only visible nodes exist in `lay`).
 *
 * Left/Right ("toward root" / "away from root", mirrored on the left side of a balanced map):
 *   away   -> the child remembered in lastChild[node] if still visible, else the child whose
 *             cy is nearest to node.cy (tie: the upper one). Leaf/collapsed -> no move
 *             (the editor expands a collapsed node first).
 *   toward -> parent.
 *   root   -> Right/Left: the remembered child on that side if still visible, else the nearest child.
 * Up/Down (the "column" rule, used by the random-tree tests; the editor itself moves between
 * SIBLINGS only, see view/editor.ts `arrow`):
 *   1. Same side, same depth d: the nearest node strictly above/below (by cy).
 *   2. If there is none at depth d, retry with d-1, d-2, ... 1 (nearest node in a shallower column).
 *   3. Otherwise stay. The root never moves up/down.
 */
import type { Layout, LayoutNode } from '../layout/types.js';

export type Direction = 'left' | 'right' | 'up' | 'down';

const EPS = 0.5;

function nearestChild(lay: Layout, n: LayoutNode, ids: readonly string[]): string {
  let best: { c: LayoutNode; d: number } | null = null;
  for (const id of ids) {
    const c = lay.nodes.get(id);
    if (!c) continue;
    const d = Math.abs(c.cy - n.cy);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && c.cy < best.c.cy)) best = { c, d };
  }
  return best ? best.c.id : n.id;
}

const columnCache = new WeakMap<Layout, Map<string, LayoutNode[]>>();

/** Per-(side, depth) columns sorted by cy, built once per layout. */
export function columns(lay: Layout): Map<string, LayoutNode[]> {
  const cached = columnCache.get(lay);
  if (cached) return cached;
  const cols = new Map<string, LayoutNode[]>();
  for (const L of lay.order) {
    if (L.depth === 0) continue;
    const key = L.side + ':' + L.depth;
    let col = cols.get(key);
    if (!col) cols.set(key, (col = []));
    col.push(L);
  }
  for (const col of cols.values()) col.sort((a, b) => a.cy - b.cy);
  columnCache.set(lay, cols);
  return cols;
}

function lowerBound(col: readonly LayoutNode[], y: number): number {
  let lo = 0;
  let hi = col.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((col[mid]?.cy ?? Infinity) < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function navigate(lay: Layout, id: string, dir: Direction, lastChild: ReadonlyMap<string, string> = new Map()): string {
  const n = lay.nodes.get(id);
  if (!n) return id;
  if (dir === 'left' || dir === 'right') {
    const towardSide = dir === 'right' ? 1 : -1;
    if (n.depth === 0) {
      const rem = lastChild.get(id);
      if (rem !== undefined && n.childIds.includes(rem) && lay.nodes.get(rem)?.side === towardSide) return rem;
      return nearestChild(lay, n, n.childIds.filter((c) => lay.nodes.get(c)?.side === towardSide));
    }
    if (towardSide === n.side) {
      if (!n.childIds.length) return id;
      const rem = lastChild.get(id);
      if (rem !== undefined && n.childIds.includes(rem)) return rem;
      return nearestChild(lay, n, n.childIds);
    }
    return n.parentId ?? id;
  }
  if (n.depth === 0) return id;
  const sign = dir === 'down' ? 1 : -1;
  const cols = columns(lay);
  for (let d = n.depth; d >= 1; d--) {
    const col = cols.get(n.side + ':' + d);
    if (!col) continue;
    if (sign > 0) {
      const i = lowerBound(col, n.cy + EPS);
      const hit = col[i];
      if (hit) return hit.id;
    } else {
      const i = lowerBound(col, n.cy - EPS) - 1;
      const hit = col[i];
      if (i >= 0 && hit) return hit.id;
    }
  }
  return id;
}
