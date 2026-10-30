/**
 * Structural and geometric invariants of the band layout, as checkable functions (used by the
 * property tests and available to the browser harness). They throw on the first violation.
 */
import { depthClass, type Layout, type LayoutNode, type LayoutTheme } from './types.js';

export const EPS = 1e-6;

/** Everything a renderer consumes, so layouts can be deep-compared. */
export function snapshot(lay: Layout): Array<Array<string | number | null>> {
  return lay.order.map((L) => [
    L.id, L.depth, L.side, L.x, L.y, L.w, L.h, L.cy, L.parentId, L.childIds.join(','),
    (L.lines ?? []).map((l) => l.text).join('\n'),
  ]);
}

export function overlaps(a: LayoutNode, b: LayoutNode): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** Sweep over x: returns the first overlapping pair or null. O(n log n + k). */
export function findOverlap(lay: Layout): [LayoutNode, LayoutNode] | null {
  const arr = [...lay.order].sort((a, b) => a.x - b.x);
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j];
      if (b === undefined || b.x >= a.x + a.w - EPS) break;
      if (overlaps(a, b)) return [a, b];
    }
  }
  return null;
}

interface Extent {
  top: number;
  bottom: number;
}

/** Vertical extent of each visible subtree, computed from node boxes only (independent of layout internals). */
export function subtreeExtents(lay: Layout): Map<string, Extent> {
  const ext = new Map<string, Extent>();
  for (let i = lay.order.length - 1; i >= 0; i--) {
    const L = lay.order[i];
    if (L === undefined) continue;
    let top = L.y;
    let bottom = L.y + L.h;
    for (const c of L.childIds) {
      const e = ext.get(c);
      if (!e) throw new Error(`child ${c} placed before its parent ${L.id}`);
      if (e.top < top) top = e.top;
      if (e.bottom > bottom) bottom = e.bottom;
    }
    ext.set(L.id, { top, bottom });
  }
  return ext;
}

const fail = (msg: string): never => {
  throw new Error(msg);
};
const nodeOf = (lay: Layout, id: string): LayoutNode => lay.nodes.get(id) ?? fail(`layout has no node ${id}`);
const extOf = (ext: Map<string, Extent>, id: string): Extent => ext.get(id) ?? fail(`no extent for ${id}`);

/** Assert every structural/geometric invariant of the band layout (throws with a message). */
export function assertLayoutInvariants(lay: Layout, theme: LayoutTheme): void {
  const pair = findOverlap(lay);
  if (pair) fail(`boxes overlap: ${pair[0].id} ${JSON.stringify(pair[0])} vs ${pair[1].id} ${JSON.stringify(pair[1])}`);
  const ext = subtreeExtents(lay);
  for (const L of lay.order) {
    const st = theme.styles[depthClass(L.depth)];
    for (const ln of L.lines ?? []) if (ln.width > st.maxWidth + EPS) fail(`line wider than maxWidth in ${L.id}`);
    if (Math.abs(L.y + L.h / 2 - L.cy) >= EPS) fail(`cy is not the box middle in ${L.id}`);
    if (!L.childIds.length) continue;
    const kids = L.childIds.map((id) => nodeOf(lay, id));
    const groups = L.depth === 0 ? [kids.filter((k) => k.side > 0), kids.filter((k) => k.side < 0)] : [kids];
    for (const g of groups) {
      if (!g.length) continue;
      // (1) parent vertically centred on its children block
      const top = Math.min(...g.map((k) => extOf(ext, k.id).top));
      const bottom = Math.max(...g.map((k) => extOf(ext, k.id).bottom));
      if (Math.abs(L.cy - (top + bottom) / 2) >= EPS) fail(`parent ${L.id} not centred: cy=${L.cy} block=[${top},${bottom}]`);
      // (2) children aligned one gap to the right (left on the left side)
      const gap = L.depth === 0 ? theme.hGapRoot : theme.hGap;
      for (const k of g) {
        if (k.side > 0) {
          if (Math.abs(k.x - (L.x + L.w + gap)) >= EPS) fail(`child ${k.id} x`);
        } else if (Math.abs(k.x + k.w - (L.x - gap)) >= EPS) fail(`left child ${k.id} x`);
      }
      // (3) siblings keep document order top->bottom (left side of the root: clockwise = bottom->top)
      const first = g[0];
      const ordered = L.depth === 0 && first !== undefined && first.side < 0 ? [...g].reverse() : g;
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1];
        const b = ordered[i];
        if (a === undefined || b === undefined) continue;
        const prev = extOf(ext, a.id);
        const cur = extOf(ext, b.id);
        const dc = depthClass(L.depth + 1);
        if (cur.top - prev.bottom < (theme.siblingGap[dc] ?? 0) - EPS) fail(`sibling subtrees too close under ${L.id}`);
      }
    }
  }
}
