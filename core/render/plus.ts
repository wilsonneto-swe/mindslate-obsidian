/**
 * The "+" buttons of a single selected node (pure geometry; view/editor.ts draws them, hit-tests them and shows
 * them only while exactly one node is selected on an editable map and nothing is edited, dragged, panned or
 * marquee-selected).
 *
 * Two small round buttons sit where the new node will appear, in world coordinates (they pan and zoom with the
 * map and never change the layout):
 *  ADD CHILD (what Tab does)
 *    - a leaf: right of the node at its vertical centre, PLUS_LEAF_GAP px past its right edge;
 *    - a collapsed node: right of its count badge, past the badge's real width (a 3-digit pill is wider than
 *      the circle), PLUS_BADGE_GAP px after it;
 *    - an expanded node with visible children: in the children's column (aligned with their left edges), just
 *      under the last child's subtree band, where Tab's new last child appears.
 *  ADD SIBLING BELOW (what Enter does), never for the root: just under the node's subtree band, left-aligned
 *  with the node, in the gap where Enter's new sibling appears.
 *
 * A button under a band keeps PLUS_MAX_OFFSET px from it when there is room, else it sits in the middle of the
 * free space below (`freeBelow`: up to the nearest node box or collapse handle under it). Collisions are
 * impossible by construction: sibling bands are disjoint and a box, its handle and its connectors stay inside
 * their band (connectors also stay left of the children's column), so the only thing below a band is the gap
 * to the next band. The tightest gap is 12 px (two leaves at depth 2 and deeper): the 18 px button then
 * reaches 3 px into the paddings of the two boxes, never into their labels. Beside a leaf or a collapsed node
 * nothing else can be at that height (its band is its own box). render/plus.test.ts checks all of this on
 * random trees, connectors included.
 */
import type { MapNode } from '../format/types.js';
import type { Layout } from '../layout/types.js';
import { previewPath } from './connectors.js';
import { BADGE_GAP, RING_HIT, badgeWidth, handleKind, handleRect, hiddenCount, ringCenter } from './handles.js';
import type { Theme } from './theme.js';

/** Button diameter (world px at zoom 1). */
export const PLUS_SIZE = 18;
/** A leaf's child button: px between the node's right edge and the button. */
export const PLUS_LEAF_GAP = 22;
/** A collapsed node's child button: px between its count badge and the button. */
export const PLUS_BADGE_GAP = 8;
/** A button under a band: at most this many px below it (less when the gap to the next band is tight). */
export const PLUS_MAX_OFFSET = 8;
/** Below this zoom the buttons hide (they would be smaller than 9 px on screen). */
export const PLUS_MIN_ZOOM = 0.5;

export type PlusKind = 'child' | 'sibling';

export interface PlusSpot {
  readonly kind: PlusKind;
  /** Top-left corner of the button, world px (the button is PLUS_SIZE px square). */
  readonly x: number;
  readonly y: number;
  /** The dashed preview connector, from where the new node's connector starts to the button's left edge (SVG path, world px). */
  readonly link: string;
}

export interface PlusSpots {
  readonly child: PlusSpot;
  /** Null for the root (it has no siblings). */
  readonly sibling: PlusSpot | null;
}

export interface PlusInput {
  readonly lay: Layout;
  /** The selected node. */
  readonly id: string;
  /** Its model object (collapsed or not, children or not). */
  readonly node: MapNode;
  /** The model object of any visible node: the collapse handles of the nodes below a band are obstacles too. */
  readonly nodeOf: (id: string) => MapNode | undefined;
  readonly theme: Pick<Theme, 'hGap' | 'hGapRoot' | 'stub' | 'curvature' | 'rootInset'>;
  /** The real width of the node's count badge when it is collapsed (the DOM's); badgeWidth's estimate otherwise. */
  readonly badgeW?: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Horizontal margin of the obstacle search: a box or handle that ends this close to a button's side counts as above or below it. */
const SIDE_MARGIN = 3;

/**
 * The free height below world y `top` over the x-range [x0, x1] (widened by SIDE_MARGIN): the distance to the nearest
 * node box or collapse handle that starts at or below `top` and overlaps that range horizontally (Infinity when there
 * is none). A ring counts with its 24 px hit circle (RING_HIT), a badge with its stub.
 */
export function freeBelow(
  lay: Layout,
  nodeOf: (id: string) => MapNode | undefined,
  stub: number,
  x0: number,
  x1: number,
  top: number,
): number {
  let min = Infinity;
  const consider = (x: number, y: number, w: number): void => {
    if (x < x1 + SIDE_MARGIN && x + w > x0 - SIDE_MARGIN && y >= top - 0.5 && y < min) min = y;
  };
  for (const L of lay.order) {
    consider(L.x, L.y, L.w);
    const n = nodeOf(L.id);
    const kind = n === undefined ? null : handleKind(L, n);
    if (kind === 'ring') {
      const [cx, cy] = ringCenter(L, stub);
      consider(cx - RING_HIT / 2, cy - RING_HIT / 2, RING_HIT);
    } else if (kind === 'badge' && n !== undefined) {
      const r = handleRect(L, n, stub);
      if (r !== null) consider(r.x, r.y, r.w);
    }
  }
  return min - top;
}

/** Where a button goes under a band that ends at world y `bottom`, with `free` px free below it: its top. */
export const underBand = (bottom: number, free: number): number => bottom + Math.min(PLUS_MAX_OFFSET, (free - PLUS_SIZE) / 2);

/** The two buttons of node `id`, or null when it is not laid out (hidden in a collapsed branch). */
export function plusSpots({ lay, id, node, nodeOf, theme, badgeW }: PlusInput): PlusSpots | null {
  const L = lay.nodes.get(id);
  if (L === undefined) return null;
  const half = PLUS_SIZE / 2;
  const right = L.x + L.w;
  let child: PlusSpot;
  if (handleKind(L, node) === 'badge') {
    const end = right + BADGE_GAP + (badgeW ?? badgeWidth(hiddenCount(node)));
    const x = end + PLUS_BADGE_GAP;
    child = { kind: 'child', x, y: L.cy - half, link: `M${r2(end)} ${r2(L.cy)}H${r2(x)}` };
  } else if (L.childIds.length > 0) {
    const last = lay.nodes.get(L.childIds[L.childIds.length - 1] ?? '');
    const col = right + (L.depth === 0 ? theme.hGapRoot : theme.hGap);
    const bottom = last !== undefined ? last.bandTop + last.bandH : L.y + L.h;
    const y = underBand(bottom, freeBelow(lay, nodeOf, theme.stub, col, col + PLUS_SIZE, bottom));
    child = { kind: 'child', x: col, y, link: previewPath(L, { x: col, y: y + half }, theme) };
  } else {
    const x = right + PLUS_LEAF_GAP;
    child = { kind: 'child', x, y: L.cy - half, link: previewPath(L, { x, y: L.cy }, theme) };
  }
  let sibling: PlusSpot | null = null;
  const P = L.parentId === null ? undefined : lay.nodes.get(L.parentId);
  if (P !== undefined) {
    const bottom = L.bandTop + L.bandH;
    const y = underBand(bottom, freeBelow(lay, nodeOf, theme.stub, L.x, L.x + PLUS_SIZE, bottom));
    sibling = { kind: 'sibling', x: L.x, y, link: previewPath(P, { x: L.x, y: y + half }, theme) };
  }
  return { child, sibling };
}
