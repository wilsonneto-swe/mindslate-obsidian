/**
 * Band layout for a left-to-right mind map ("right" mode) with an optional "balanced" mode
 * (first-level branches split between the right and left side; the product uses "right").
 *
 * Pass 1 (post-order, memoised): measureSubtree(node, depth) -> { w, h, bandH, blockH, kids, offsets }
 *   w,h     : the node's own box (text box + padding)
 *   blockH  : height of its children stacked vertically (child bands + gaps)
 *   bandH   : max(h, blockH) -> the horizontal strip the whole subtree owns
 *   offsets : top of each child's band, relative to the top of the children block
 * Pass 2 (pre-order): place(node, x, bandTop)
 *   cy = bandTop + bandH/2; the node box AND its children block are both centred on cy,
 *   children's left edges are aligned at parent.right + gap (120 px from the root, 66 elsewhere).
 *
 * Because every subtree lives in its own band and sibling bands are disjoint, node boxes can never
 * overlap and a connector (which stays inside its parent's band, between the parent's right edge
 * and its children's left edge) never crosses another node.
 *
 * Incremental relayout: pass-1 results are cached in a WeakMap keyed by the immutable node object
 * (+ depth class). After an edit only the edited node and its ancestors are new objects, so pass 1
 * recomputes O(depth) subtrees; pass 2 is a cheap O(n) placement. Pans, zooms and node drags never
 * call layout() at all.
 */
import type { MapNode } from '../format/types.js';
import { idOf } from '../model/ids.js';
import { depthClass, type Bounds, type Layout, type LayoutMode, type LayoutNode, type LayoutTheme, type MeasureText, type Side, type TextLine } from './types.js';

const EMPTY: readonly never[] = Object.freeze([]);
const visibleKids = (n: MapNode): boolean => !n.collapsed && n.children.length > 0;

interface Measure {
  readonly w: number;
  readonly h: number;
  readonly lines: readonly TextLine[] | null;
  readonly bandH: number;
  readonly blockH: number;
  readonly kids: readonly Measure[];
  readonly offsets: readonly number[];
}

interface Placed {
  id: string;
  depth: number;
  side: Side;
  x: number;
  y: number;
  w: number;
  h: number;
  cy: number;
  parentId: string | null;
  childIds: readonly string[];
  branch: number;
  lines: readonly TextLine[] | null;
  bandTop: number;
  bandH: number;
}

export interface LayoutEngineOptions {
  readonly theme: LayoutTheme;
  readonly measureText: MeasureText;
  readonly mode?: LayoutMode;
  /** Order of the left-side branches in balanced mode: clockwise lists them bottom -> top. */
  readonly leftOrder?: 'clockwise' | 'document';
}

export interface LayoutEngine {
  layout(root: MapNode): Layout;
  /** `layouts`: layout() calls (never reset); `subtreesComputed`: pass-1 memo misses since the last reset(). */
  readonly stats: { subtreesComputed: number; layouts: number };
  readonly theme: LayoutTheme;
  /** Drop every cached subtree measure (theme/font change). */
  reset(): void;
  /**
   * Drop the cached measures of these node objects: a node whose box changed while the object did not (the
   * live label of an inline edit grew a line the model text does not have yet) and its ancestors, whose
   * measures hold its band.
   */
  invalidate(nodes: Iterable<MapNode>): void;
}

export function createLayoutEngine({ theme, measureText, mode = 'right', leftOrder = 'clockwise' }: LayoutEngineOptions): LayoutEngine {
  let memo = new WeakMap<MapNode, Array<Measure | undefined>>(); // node -> [m@dc0, m@dc1, m@dc2]
  const stats = { subtreesComputed: 0, layouts: 0 };

  function ownBox(node: MapNode, dc: 0 | 1 | 2): { w: number; h: number; lines: readonly TextLine[] | null } {
    const st = theme.styles[dc];
    const t = measureText(node.text, st);
    return { w: t.width + 2 * st.padX, h: t.height + 2 * st.padY, lines: t.lines };
  }

  // Vertical gap between two adjacent sibling bands (siblings have depth class dc).
  function gap(a: MapNode, b: MapNode, dc: number): number {
    const g = visibleKids(a) || visibleKids(b) ? theme.subtreeGap[dc] : theme.siblingGap[dc];
    return g ?? 0;
  }

  function stack(nodes: readonly MapNode[], ms: readonly Measure[], dc: number): { offsets: number[]; blockH: number } {
    const offsets = new Array<number>(nodes.length);
    let y = 0;
    for (let i = 0; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const cur = nodes[i];
      if (i > 0 && prev !== undefined && cur !== undefined) y += gap(prev, cur, dc);
      offsets[i] = y;
      y += ms[i]?.bandH ?? 0;
    }
    return { offsets, blockH: y };
  }

  function measureSubtree(node: MapNode, depth: number): Measure {
    const dc = depthClass(depth);
    let slot = memo.get(node);
    const hit = slot?.[dc];
    if (hit) return hit;
    stats.subtreesComputed++;
    const o = ownBox(node, dc);
    let kids: readonly Measure[] = EMPTY;
    let offsets: readonly number[] = EMPTY;
    let blockH = 0;
    if (visibleKids(node)) {
      kids = node.children.map((c) => measureSubtree(c, depth + 1));
      ({ offsets, blockH } = stack(node.children, kids, depthClass(depth + 1)));
    }
    const m: Measure = { w: o.w, h: o.h, lines: o.lines, bandH: Math.max(o.h, blockH), blockH, kids, offsets };
    if (!slot) memo.set(node, (slot = []));
    slot[dc] = m;
    return m;
  }

  /** Choose how many first-level children go right (prefix); the rest go left. */
  function balancedSplit(kids: readonly MapNode[], kms: readonly Measure[]): number {
    const n = kids.length;
    if (n < 2) return n;
    const h = (from: number, to: number): number => (from >= to ? 0 : stack(kids.slice(from, to), kms.slice(from, to), 1).blockH);
    let best = n;
    let bestDiff = Infinity;
    for (let k = 1; k <= n; k++) {
      const diff = Math.abs(h(0, k) - h(k, n));
      if (diff <= bestDiff) {
        bestDiff = diff;
        best = k;
      }
    }
    return best;
  }

  function layout(root: MapNode): Layout {
    stats.layouts++;
    const nodes = new Map<string, Placed>();
    const order: Placed[] = []; // pre-order (DFS) of visible nodes
    const rootId = idOf(root);
    const rb = ownBox(root, 0);
    const R: Placed = {
      id: rootId, depth: 0, side: 0, x: 0, y: -rb.h / 2, w: rb.w, h: rb.h, cy: 0,
      parentId: null, childIds: EMPTY, branch: -1, lines: rb.lines, bandTop: 0, bandH: 0,
    };
    nodes.set(rootId, R);
    order.push(R);

    const kids: readonly MapNode[] = visibleKids(root) ? root.children : EMPTY;
    const kms = kids.map((c) => measureSubtree(c, 1));
    const nRight = mode === 'balanced' ? balancedSplit(kids, kms) : kids.length;
    R.childIds = kids.map(idOf);
    let bandTop = 0;
    let bandBottom = 0;

    function place(node: MapNode, m: Measure, depth: number, x: number, top: number, side: Side, parent: Placed, branch: number): void {
      const cy = top + m.bandH / 2;
      const bx = side > 0 ? x : x - m.w;
      const id = idOf(node);
      const L: Placed = {
        id, depth, side, x: bx, y: cy - m.h / 2, w: m.w, h: m.h, cy,
        parentId: parent.id, childIds: EMPTY, branch, lines: m.lines, bandTop: top, bandH: m.bandH,
      };
      nodes.set(id, L);
      order.push(L);
      if (m.kids.length) {
        L.childIds = node.children.map(idOf);
        const cx = side > 0 ? bx + m.w + theme.hGap : bx - theme.hGap;
        const blockTop = cy - m.blockH / 2;
        for (let i = 0; i < m.kids.length; i++) {
          const c = node.children[i];
          const cm = m.kids[i];
          if (c !== undefined && cm !== undefined) place(c, cm, depth + 1, cx, blockTop + (m.offsets[i] ?? 0), side, L, branch);
        }
      }
    }

    function placeSide(side: Side, idxs: readonly number[]): void {
      if (!idxs.length) return;
      const ns = idxs.map((i) => kids[i]).filter((n): n is MapNode => n !== undefined);
      const ms = idxs.map((i) => kms[i]).filter((m): m is Measure => m !== undefined);
      const { offsets, blockH } = stack(ns, ms, 1);
      const top = -blockH / 2; // children block centred on the root (cy = 0)
      bandTop = Math.min(bandTop, top);
      bandBottom = Math.max(bandBottom, -top);
      const x = side > 0 ? R.w + theme.hGapRoot : -theme.hGapRoot;
      for (let k = 0; k < ns.length; k++) {
        const n = ns[k];
        const m = ms[k];
        const branch = idxs[k];
        if (n !== undefined && m !== undefined && branch !== undefined) place(n, m, 1, x, top + (offsets[k] ?? 0), side, R, branch);
      }
    }

    const right: number[] = [];
    const left: number[] = [];
    for (let i = 0; i < kids.length; i++) (i < nRight ? right : left).push(i);
    // Clockwise reading order: the left side lists the remaining branches bottom -> top.
    if (leftOrder === 'clockwise') left.reverse();
    placeSide(1, right);
    placeSide(-1, left);
    R.bandTop = Math.min(bandTop, R.y);
    R.bandH = Math.max(bandBottom, R.y + R.h) - R.bandTop;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const L of order) {
      if (L.x < minX) minX = L.x;
      if (L.y < minY) minY = L.y;
      if (L.x + L.w > maxX) maxX = L.x + L.w;
      if (L.y + L.h > maxY) maxY = L.y + L.h;
    }
    const bounds: Bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    const frozen: ReadonlyMap<string, LayoutNode> = nodes;
    return { nodes: frozen, order, rootId, mode, bounds };
  }

  return {
    layout,
    stats,
    theme,
    reset(): void {
      memo = new WeakMap();
      stats.subtreesComputed = 0;
    },
    invalidate(nodes: Iterable<MapNode>): void {
      for (const n of nodes) memo.delete(n);
    },
  };
}
