/**
 * Connector geometry (Whimsical-style).
 *
 * Root -> level-1 child c (one path per child, coloured by c's branch):
 *   S = (root.right - rootInset, root.cy)        // starts under the root box, which is painted on top
 *   E = (c.left, c.cy)                           // child's box left edge, vertical middle
 *   d = M S  C (S.x + k*dx, S.y) (E.x - k*dx, E.y) E      with dx = E.x - S.x, k = curvature (0.5)
 *
 * Non-root parent p -> its children (one path per parent, coloured by p's branch):
 *   A = (p.right, p.cy), B = (A.x + stub, p.cy)
 *   d = M A H B.x                                // straight stub
 *       for each child c:  |c.cy - p.cy| < 0.5  ?  M B L E     (single/centred child: straight)
 *                                               :  M B C (B.x + k*dx, B.y) (E.x - k*dx, E.y) E
 * Both tangents are horizontal, so every curve leaves the stub smoothly and enters the child
 * horizontally. On the left side of a balanced map everything is mirrored (right <-> left).
 */
import type { Layout, LayoutNode } from '../layout/types.js';
import { strokeFor, type Theme } from './theme.js';

const r2 = (v: number): number => Math.round(v * 100) / 100;

export function bezier(x0: number, y0: number, x1: number, y1: number, k: number): string {
  const dx = (x1 - x0) * k;
  return `M${r2(x0)} ${r2(y0)}C${r2(x0 + dx)} ${r2(y0)} ${r2(x1 - dx)} ${r2(y1)} ${r2(x1)} ${r2(y1)}`;
}

export interface Connector {
  readonly parentId: string;
  readonly childIds: readonly string[];
  readonly childDepth: number;
  /** Index of the first-level ancestor (colour key); the caller maps it to a colour. */
  readonly branch: number;
  readonly width: number;
  readonly d: string;
}

export function buildConnectors(lay: Layout, theme: Theme): Connector[] {
  const out: Connector[] = [];
  const k = theme.curvature;
  for (const p of lay.order) {
    if (!p.childIds.length) continue;
    if (p.depth === 0) {
      for (const cid of p.childIds) {
        const c = lay.nodes.get(cid);
        if (!c) continue;
        const s = c.side;
        const sx = s > 0 ? p.x + p.w - theme.rootInset : p.x + theme.rootInset;
        const ex = s > 0 ? c.x : c.x + c.w;
        out.push({ parentId: p.id, childIds: [cid], childDepth: 1, branch: c.branch, width: strokeFor(theme, 1), d: bezier(sx, p.cy, ex, c.cy, k) });
      }
      continue;
    }
    const s = p.side;
    const ax = s > 0 ? p.x + p.w : p.x;
    const bx = ax + s * theme.stub;
    let d = `M${r2(ax)} ${r2(p.cy)}H${r2(bx)}`;
    for (const cid of p.childIds) {
      const c = lay.nodes.get(cid);
      if (c) d += fanSegment(p, c, theme);
    }
    out.push({ parentId: p.id, childIds: p.childIds, childDepth: p.depth + 1, branch: p.branch, width: strokeFor(theme, p.depth + 1), d });
  }
  return out;
}

/**
 * One child's segment of a non-root parent's fan: from the end of the parent's stub to the child's box edge
 * (straight when the child is centred on the parent). The drag dimming covers exactly this segment.
 */
export function fanSegment(p: LayoutNode, c: LayoutNode, theme: Pick<Theme, 'stub' | 'curvature'>): string {
  const s = p.side < 0 ? -1 : 1;
  const bx = (s > 0 ? p.x + p.w : p.x) + s * theme.stub;
  const ex = s > 0 ? c.x : c.x + c.w;
  return Math.abs(c.cy - p.cy) < 0.5 ? `M${r2(bx)} ${r2(p.cy)}L${r2(ex)} ${r2(c.cy)}` : bezier(bx, p.cy, ex, c.cy, theme.curvature);
}

/** Dashed preview connector from the prospective parent to the insertion point (a drop, a "+" button), same geometry as above. */
export function previewPath(P: LayoutNode, ip: { readonly x: number; readonly y: number }, theme: Pick<Theme, 'stub' | 'curvature' | 'rootInset'>): string {
  if (P.depth === 0) return bezier(P.x + P.w - theme.rootInset, P.cy, ip.x, ip.y, theme.curvature);
  const ax = P.x + P.w;
  const bx = ax + theme.stub;
  const stub = `M${r2(ax)} ${r2(P.cy)}H${r2(bx)}`;
  return stub + (Math.abs(ip.y - P.cy) < 0.5 ? `M${r2(bx)} ${r2(P.cy)}L${r2(ip.x)} ${r2(ip.y)}` : bezier(bx, P.cy, ip.x, ip.y, theme.curvature));
}
