/**
 * The multi-selection as pure functions; view/editor.ts keeps the state and draws it.
 *
 * A selection is a PRIMARY node, the one the keyboard acts on (Tab, Enter, typing, the arrows start from it;
 * there is always one), and the OTHER selected nodes in the order they were added. Shift+click and Mod+click
 * toggle a node (`toggleNode`): a node toggled on becomes the primary and the previous primary stays selected;
 * toggling the primary off hands that role back to the node added last. Shift+drag on the empty canvas draws a
 * marquee whose touched node boxes are added (`marqueeHits`, `addNodes`), and Mod+A adds every visible node.
 */
import type { Layout } from '../layout/types.js';

export interface NodeSelection {
  /** The node the keyboard acts on. */
  readonly primary: string;
  /** The other selected nodes, oldest first; never the primary, never twice. */
  readonly others: readonly string[];
}

/** Shift+click / Mod+click on `id`: on (it becomes the primary) or off (the only selected node stays selected). */
export function toggleNode(s: NodeSelection, id: string): NodeSelection {
  if (id === s.primary) {
    const last = s.others[s.others.length - 1];
    if (last === undefined) return s;
    return { primary: last, others: s.others.slice(0, -1) };
  }
  if (s.others.includes(id)) return { primary: s.primary, others: s.others.filter((x) => x !== id) };
  return { primary: id, others: [...s.others, s.primary] };
}

/**
 * The root selected alone (as when a map opens, or after a click on it) counts as nothing chosen yet: a Shift/Mod+click
 * on another node, or a marquee that does not touch the root, starts the multi-selection from those nodes instead of
 * keeping the root in it (batch actions never act on the root anyway). Any other selection is extended.
 */
export const onlyRoot = (s: NodeSelection, rootId: string): boolean => s.primary === rootId && s.others.length === 0;

/** Shift+click / Mod+click on `id` (toggleNode), from the selection as the editor holds it. */
export function clickToggle(s: NodeSelection, id: string, rootId: string): NodeSelection {
  return onlyRoot(s, rootId) && id !== rootId ? { primary: id, others: [] } : toggleNode(s, id);
}

/** What a marquee that touches `hits` (document order) makes of the selection it started from. */
export function marqueeSelection(base: NodeSelection, hits: readonly string[], rootId: string): NodeSelection {
  const first = hits[0];
  if (first !== undefined && onlyRoot(base, rootId) && !hits.includes(rootId)) return { primary: first, others: hits.slice(1) };
  return addNodes(base, hits);
}

/** Add nodes to the selection (a marquee, Mod+A): the primary stays the primary; new nodes are appended in order. */
export function addNodes(s: NodeSelection, ids: Iterable<string>): NodeSelection {
  const others = [...s.others];
  const have = new Set(others);
  have.add(s.primary);
  for (const id of ids) {
    if (have.has(id)) continue;
    have.add(id);
    others.push(id);
  }
  return others.length === s.others.length ? s : { primary: s.primary, others };
}

/** Every selected node, the primary included. */
export const selectedIds = (s: NodeSelection): string[] => [s.primary, ...s.others];

/** A rectangle in world coordinates (the marquee), corners in any order. */
export interface WorldRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The visible nodes whose boxes a marquee touches (an edge counts), in layout (document) order. O(visible nodes),
 * no DOM: the editor runs it on every pointermove of a marquee.
 */
export function marqueeHits(lay: Layout, r: WorldRect): string[] {
  const x0 = Math.min(r.x0, r.x1);
  const x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1);
  const y1 = Math.max(r.y0, r.y1);
  const out: string[] = [];
  for (const L of lay.order) if (L.x <= x1 && L.x + L.w >= x0 && L.y <= y1 && L.y + L.h >= y0) out.push(L.id);
  return out;
}
