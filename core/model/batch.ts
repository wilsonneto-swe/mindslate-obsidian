/**
 * Tree operations on several nodes at once: what a multi-selection does in one undo step (batch delete and
 * cut, a group drag, Alt+Up / Alt+Down on blocks of siblings). The contract of tree.ts holds: every function
 * is pure, path-copies by spreading (`patch`), registers each copy under the id of the node it replaces, and
 * keeps every untouched subtree as the SAME object, the moved nodes included, so ids stay stable and the
 * Markdown writer re-emits every untouched line byte for byte (model/document.ts, LINEAGE).
 *
 * TOP-LEVEL: of the given nodes, those without an ancestor among them, in document order (`topLevel`). A
 * node whose ancestor is also given is carried along with that ancestor (ancestors win), so a subtree is
 * never removed or moved twice. The ROOT is never removed or moved: removeNodes, moveNodes, reorderNodes and
 * selectionAfterRemove ignore it, as if it had not been given (it would otherwise win over every node).
 */
import type { MapNode } from '../format/types.js';
import { idOf } from './ids.js';
import { entryOf, indexOf, isAncestor, patch, sameNodes, type TreeIndex } from './tree.js';

const freeze = Object.freeze;

/**
 * The top-level nodes among `ids`, in document order (pre-order): a node with an ancestor in `ids` is left
 * out (ancestors win), an id the tree does not hold is ignored, and each node counts once. The root wins
 * over every other node when it is given (the batch functions below leave it out first).
 */
export function topLevel(root: MapNode, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  const out: string[] = [];
  if (want.size === 0) return out;
  // pre-order walk: a hit is recorded and its subtree skipped (its descendants are carried along with it)
  const stack: MapNode[] = [root];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    const id = idOf(n);
    if (want.has(id)) {
      out.push(id);
      if (out.length === want.size) break; // every given node found
      continue;
    }
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c !== undefined) stack.push(c);
    }
  }
  return out;
}

/** topLevel without the root: the nodes a batch removes or moves. */
const batchOf = (root: MapNode, ids: Iterable<string>): string[] => {
  const rid = idOf(root);
  return topLevel(root, [...ids].filter((id) => id !== rid));
};

/** Every proper ancestor of these nodes (the nodes whose children change when they go away). */
function ancestorsOf(idx: TreeIndex, ids: Iterable<string>, into: Set<string> = new Set()): Set<string> {
  for (const id of ids) {
    for (let p = idx.get(id)?.parentId ?? null; p !== null && !into.has(p); p = idx.get(p)?.parentId ?? null) into.add(p);
  }
  return into;
}

/** A copy of `n` with these children (a parent losing its last child loses its collapsed flag, as in tree.ts). */
const withKids = (n: MapNode, kids: readonly MapNode[]): MapNode =>
  patch(n, { children: freeze([...kids]), collapsed: kids.length ? !!n.collapsed : false });

/**
 * Remove the top-level nodes of `ids` with their subtrees (the root is ignored). Only the paths above the
 * removed nodes are copied; every other node is the same object. Nothing to remove: the same root.
 */
export function removeNodes(root: MapNode, ids: Iterable<string>): MapNode {
  const gone = new Set(batchOf(root, ids));
  if (gone.size === 0) return root;
  const dirty = ancestorsOf(indexOf(root), gone);
  const rebuild = (n: MapNode): MapNode => {
    if (!dirty.has(idOf(n))) return n;
    return withKids(
      n,
      n.children.filter((c) => !gone.has(idOf(c))).map(rebuild),
    );
  };
  return rebuild(root);
}

/**
 * The selection after removing `ids` (batch delete, cut): the previous sibling of the first removed node in
 * document order, else the next sibling of it that stays, else its parent (the single-node rule of
 * tree.ts selectionAfterDelete, for a group). The previous sibling always stays: it comes before the first
 * removed node and shares its parent, which stays too. Nothing to remove: the root.
 */
export function selectionAfterRemove(root: MapNode, ids: Iterable<string>): string {
  const gone = batchOf(root, ids);
  const first = gone[0];
  if (first === undefined) return idOf(root);
  const set = new Set(gone);
  const e = entryOf(root, first);
  const parentId = e.parentId ?? idOf(root);
  const sibs = entryOf(root, parentId).node.children;
  const prev = e.index > 0 ? sibs[e.index - 1] : undefined;
  if (prev !== undefined) return idOf(prev);
  for (let i = e.index + 1; i < sibs.length; i++) {
    const s = sibs[i];
    if (s !== undefined && !set.has(idOf(s))) return idOf(s);
  }
  return parentId;
}

/**
 * Move the top-level nodes of `ids` (the root is ignored), in document order, as one group under
 * `newParentId`. `index` is a position in the CURRENT children of the new parent, as for tree.ts moveNode
 * and the drop rule (input/dragdrop.ts): the group lands right before the first child at or after `index`
 * that is not moved itself, or last when there is none. The new parent expands (a drop on a collapsed node
 * appends behind its hidden children and opens it). The moved nodes are the very same objects; only the
 * paths above their old and new places are copied. Throws when the new parent is inside a moved subtree;
 * a move that changes nothing returns the same root (no undo step).
 */
export function moveNodes(root: MapNode, ids: Iterable<string>, newParentId: string, index: number): MapNode {
  const moving = batchOf(root, ids);
  if (moving.length === 0) return root;
  const idx = indexOf(root);
  const target = entryOf(root, newParentId);
  for (const m of moving) if (isAncestor(root, m, newParentId)) throw new Error('cannot move a node into its own subtree');
  const set = new Set(moving);
  const nodes = moving.map((id) => entryOf(root, id).node);
  let anchor: string | null = null;
  const kids0 = target.node.children;
  for (let i = Math.max(0, index); i < kids0.length; i++) {
    const c = kids0[i];
    if (c !== undefined && !set.has(idOf(c))) {
      anchor = idOf(c);
      break;
    }
  }
  const dirty = ancestorsOf(idx, set);
  dirty.add(newParentId);
  ancestorsOf(idx, [newParentId], dirty);
  const rebuild = (n: MapNode): MapNode => {
    const id = idOf(n);
    if (!dirty.has(id)) return n;
    const kids = n.children.filter((c) => !set.has(idOf(c))).map(rebuild);
    if (id !== newParentId) return withKids(n, kids);
    const at = anchor === null ? kids.length : kids.findIndex((c) => idOf(c) === anchor);
    kids.splice(at < 0 ? kids.length : at, 0, ...nodes);
    return patch(n, { children: freeze(kids), collapsed: false });
  };
  const next = rebuild(root);
  // the same nodes in the same places (a drop on the group's own slot): nothing moved, no new tree
  return sameNodes(next, root) ? root : next;
}

/** One step of reorderNodes among one parent's children: every maximal run of moving siblings shifts by one. */
function stepBlocks(kids: readonly MapNode[], moving: ReadonlySet<string>, dir: -1 | 1): MapNode[] {
  const out = [...kids];
  const on = (i: number): boolean => {
    const c = out[i];
    return c !== undefined && moving.has(idOf(c));
  };
  if (dir < 0) {
    for (let i = 0; i < out.length; ) {
      if (!on(i)) {
        i++;
        continue;
      }
      let j = i;
      while (on(j + 1)) j++;
      if (i > 0) {
        // the block [i..j] moves up by one: the sibling above it goes below it
        const [above] = out.splice(i - 1, 1);
        if (above !== undefined) out.splice(j, 0, above);
      }
      i = j + 1;
    }
  } else {
    for (let j = out.length - 1; j >= 0; ) {
      if (!on(j)) {
        j--;
        continue;
      }
      let i = j;
      while (on(i - 1)) i--;
      if (j < out.length - 1) {
        // the block [i..j] moves down by one: the sibling below it goes above it
        const [below] = out.splice(j + 1, 1);
        if (below !== undefined) out.splice(i, 0, below);
      }
      j = i - 1;
    }
  }
  return out;
}

/**
 * What Mod+/ (or the selection bar's Collapse / Expand) does to several nodes: every given node that has
 * children folds, or, when every one of them is folded already, they all unfold. Unlike the moves, this is not
 * limited to top-level nodes (a selected child keeps its own fold inside a folded parent). The root is ignored
 * here too: folding it would hide every other node of the selection. `null` when no given node has children.
 */
export function foldPlan(root: MapNode, ids: Iterable<string>): { readonly ids: string[]; readonly collapse: boolean } | null {
  const idx = indexOf(root);
  const rid = idOf(root);
  const nodes: Array<[string, MapNode]> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const n = idx.get(id)?.node;
    if (id === rid || seen.has(id) || n === undefined || n.children.length === 0) continue;
    seen.add(id);
    nodes.push([id, n]);
  }
  if (nodes.length === 0) return null;
  const collapse = !nodes.every(([, n]) => n.collapsed === true);
  return { ids: nodes.filter(([, n]) => (n.collapsed === true) !== collapse).map(([id]) => id), collapse };
}

/**
 * Alt+Up (`delta` -1) / Alt+Down (+1) on several nodes: each top-level node of `ids` (the root is ignored)
 * moves one step among its siblings; adjacent moving siblings move together as a block, and a block at the
 * edge of its sibling list stays where it is. A larger |delta| repeats the step. Only the paths above the
 * reordered parents are copied; nothing moved: the same root.
 */
export function reorderNodes(root: MapNode, ids: Iterable<string>, delta: number): MapNode {
  const moving = new Set(batchOf(root, ids));
  const steps = Math.trunc(Math.abs(delta));
  if (moving.size === 0 || steps === 0) return root;
  const dir: -1 | 1 = delta < 0 ? -1 : 1;
  const idx = indexOf(root);
  const parents = new Set<string>();
  for (const id of moving) {
    const p = idx.get(id)?.parentId;
    if (p !== null && p !== undefined) parents.add(p);
  }
  const reordered = new Map<string, readonly MapNode[]>();
  for (const pid of parents) {
    const before = entryOf(root, pid).node.children;
    let kids: readonly MapNode[] = before;
    for (let s = 0; s < steps; s++) kids = stepBlocks(kids, moving, dir);
    if (kids.some((c, i) => c !== before[i])) reordered.set(pid, kids);
  }
  if (reordered.size === 0) return root;
  const dirty = ancestorsOf(idx, reordered.keys());
  for (const pid of reordered.keys()) dirty.add(pid);
  const rebuild = (n: MapNode): MapNode => {
    const id = idOf(n);
    if (!dirty.has(id)) return n;
    const kids = (reordered.get(id) ?? n.children).map(rebuild);
    return patch(n, { children: freeze(kids) });
  };
  return rebuild(root);
}
