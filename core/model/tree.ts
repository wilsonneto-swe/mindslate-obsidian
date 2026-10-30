/**
 * Immutable mind-map tree over the format's MapNode objects.
 *
 * Every operation is a pure function (root, ...) -> newRoot. Only the edited node and its
 * ancestors are re-created (path copying); every untouched subtree is the *same object* in the
 * old and new tree. That gives us O(depth) undo snapshots, layout memoisation keyed by node
 * identity and, above all, the format's minimal-diff writer: an untouched parsed node re-emits
 * its raw lines byte for byte and keeps its body (see src/format/README.md "Port notes").
 *
 * The contract every primitive here follows (decided):
 *  - a copy SPREADS the old node (`{ ...node, ...changes }`): `body` survives, and when only the
 *    text or the flag changes the frozen `children` array is kept, which is how the writer
 *    recognises a spread copy of a parsed node;
 *  - the copy is registered under the SAME id (ids live in a WeakMap, see ids.ts);
 *  - `mkNode(text)` creates a node WITHOUT a `body` key: a new node never inherits a body;
 *  - the `collapsed` key is present only when true, like the parser writes it.
 */
import type { MapNode } from '../format/types.js';
import { idOf, newId, registerId } from './ids.js';

const freeze = Object.freeze;
const EMPTY: readonly MapNode[] = freeze([]);

interface Mutable {
  text: string;
  children: readonly MapNode[];
  collapsed?: boolean;
  body?: string;
}

export interface Patch {
  readonly text?: string;
  readonly children?: readonly MapNode[];
  readonly collapsed?: boolean;
  readonly body?: string;
}

export interface MkNodeOptions {
  /** Pin the id (tests, deterministic random trees). */
  readonly id?: string;
  readonly collapsed?: boolean;
}

/** A fresh node (no `body` key). `collapsed` is kept only when there are children. */
export function mkNode(text = '', children: readonly MapNode[] = EMPTY, opts: MkNodeOptions = {}): MapNode {
  const kids = children.length ? freeze([...children]) : freeze([]);
  const node: MapNode = freeze(opts.collapsed && kids.length ? { text, children: kids, collapsed: true } : { text, children: kids });
  registerId(node, opts.id ?? newId());
  return node;
}

/** `{ ...node, ...changes }`, frozen, registered under the id of `node`. */
export function patch(node: MapNode, changes: Patch): MapNode {
  const o: Mutable = { ...node, ...changes };
  if (o.collapsed === false) delete o.collapsed; // same shape as a parsed node: the flag exists only when true
  const next: MapNode = freeze(o);
  registerId(next, idOf(node));
  return next;
}

/** A deep copy with NEW ids on every node (Mod+D). Spreads, so an explicit body is copied along. */
export function cloneTree(node: MapNode): MapNode {
  const copy: MapNode = freeze({ ...node, children: freeze(node.children.map(cloneTree)) });
  registerId(copy, newId());
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Index

export interface IndexEntry {
  readonly node: MapNode;
  readonly parentId: string | null;
  readonly index: number;
  readonly depth: number;
}

export type TreeIndex = ReadonlyMap<string, IndexEntry>;

/** id -> { node, parentId, index, depth } (O(n); cached per root object by indexOf). */
export function buildIndex(root: MapNode): Map<string, IndexEntry> {
  const idx = new Map<string, IndexEntry>();
  const stack: Array<[MapNode, string | null, number, number]> = [[root, null, 0, 0]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [n, parentId, index, depth] = top;
    const id = idOf(n);
    idx.set(id, { node: n, parentId, index, depth });
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c !== undefined) stack.push([c, id, i, depth + 1]);
    }
  }
  return idx;
}

const indexCache = new WeakMap<MapNode, Map<string, IndexEntry>>();

export function indexOf(root: MapNode): TreeIndex {
  let i = indexCache.get(root);
  if (!i) indexCache.set(root, (i = buildIndex(root)));
  return i;
}

export function entryOf(root: MapNode, id: string): IndexEntry {
  const e = indexOf(root).get(id);
  if (!e) throw new Error(`unknown node ${id}`);
  return e;
}

// ---------------------------------------------------------------------------------------------
// Path-copying primitives

/** Replace node `id` by fn(node) and path-copy its ancestors. */
export function updateNode(root: MapNode, id: string, fn: (node: MapNode) => MapNode): MapNode {
  const idx = indexOf(root);
  const e = entryOf(root, id);
  let replaced = fn(e.node);
  if (replaced === e.node) return root;
  let childIndex = e.index;
  let pid = e.parentId;
  while (pid !== null) {
    const p = idx.get(pid);
    if (!p) throw new Error(`unknown node ${pid}`);
    const kids = [...p.node.children];
    kids[childIndex] = replaced;
    replaced = patch(p.node, { children: freeze(kids) });
    childIndex = p.index;
    pid = p.parentId;
  }
  return replaced;
}

const setKids = (n: MapNode, kids: readonly MapNode[]): MapNode =>
  patch(n, { children: freeze([...kids]), collapsed: kids.length ? !!n.collapsed : false });

export const setText = (root: MapNode, id: string, text: string): MapNode =>
  updateNode(root, id, (n) => (n.text === text ? n : patch(n, { text })));

export const setCollapsed = (root: MapNode, id: string, collapsed: boolean): MapNode =>
  updateNode(root, id, (n) => (!n.children.length || !!n.collapsed === collapsed ? n : patch(n, { collapsed })));

export const toggleCollapsed = (root: MapNode, id: string): MapNode => setCollapsed(root, id, !entryOf(root, id).node.collapsed);

/** Insert `child` into parent's children at `index` (-1 = append). Expands the parent. */
export function insertChild(root: MapNode, parentId: string, index: number, child: MapNode): MapNode {
  return updateNode(root, parentId, (p) => {
    const kids = [...p.children];
    const at = index < 0 || index > kids.length ? kids.length : index;
    kids.splice(at, 0, child);
    return patch(p, { children: freeze(kids), collapsed: false });
  });
}

/** Tab. */
export const addChild = (root: MapNode, parentId: string, child: MapNode): MapNode => insertChild(root, parentId, -1, child);

/** Enter (after) / Mod+Enter (before). */
export function addSibling(root: MapNode, id: string, sib: MapNode, where: 'before' | 'after' = 'after'): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) throw new Error('root has no siblings');
  return insertChild(root, e.parentId, e.index + (where === 'after' ? 1 : 0), sib);
}

/** Alt+Enter: insert `wrapper` between `id` and its parent. */
export function addParent(root: MapNode, id: string, wrapper: MapNode): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) throw new Error('cannot wrap root');
  return updateNode(root, e.parentId, (p) => {
    const kids = [...p.children];
    kids[e.index] = setKids(wrapper, [e.node]);
    return patch(p, { children: freeze(kids) });
  });
}

export function removeNode(root: MapNode, id: string): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) throw new Error('cannot remove root');
  return updateNode(root, e.parentId, (p) =>
    setKids(
      p,
      p.children.filter((_, i) => i !== e.index),
    ),
  );
}

export function isAncestor(root: MapNode, ancestorId: string, id: string): boolean {
  const idx = indexOf(root);
  for (let a: string | null = id; a !== null; ) {
    if (a === ancestorId) return true;
    const e = idx.get(a);
    a = e ? e.parentId : null;
  }
  return false;
}

/** Move subtree `id` under `newParentId` at `index` (index in the *current* children list). */
export function moveNode(root: MapNode, id: string, newParentId: string, index: number): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) throw new Error('cannot move root');
  if (isAncestor(root, id, newParentId)) throw new Error('cannot move a node into its own subtree');
  let at = index;
  if (e.parentId === newParentId && index > e.index) at = index - 1;
  return insertChild(removeNode(root, id), newParentId, at, e.node);
}

/** Alt+Up / Alt+Down: reorder among siblings. */
export function reorder(root: MapNode, id: string, delta: number): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) return root;
  const siblings = entryOf(root, e.parentId).node.children;
  const to = Math.max(0, Math.min(siblings.length - 1, e.index + delta));
  if (to === e.index) return root;
  return updateNode(root, e.parentId, (p) => {
    const kids = [...p.children];
    kids.splice(e.index, 1);
    kids.splice(to, 0, e.node);
    return patch(p, { children: freeze(kids) });
  });
}

/** Become the last child of the previous sibling. */
export function indent(root: MapNode, id: string): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null || e.index === 0) return root;
  const prev = entryOf(root, e.parentId).node.children[e.index - 1];
  if (prev === undefined) return root;
  return moveNode(root, id, idOf(prev), prev.children.length);
}

/** Become the next sibling of the parent. */
export function outdent(root: MapNode, id: string): MapNode {
  const e = entryOf(root, id);
  if (e.parentId === null) return root;
  const p = entryOf(root, e.parentId);
  if (p.parentId === null) return root;
  return moveNode(root, id, p.parentId, p.index + 1);
}

/** Selection to use after deleting `id`: previous sibling, else next sibling, else parent. */
export function selectionAfterDelete(root: MapNode, id: string): string {
  const e = entryOf(root, id);
  if (e.parentId === null) throw new Error('cannot delete root');
  const sibs = entryOf(root, e.parentId).node.children;
  const prev = e.index > 0 ? sibs[e.index - 1] : undefined;
  if (prev !== undefined) return idOf(prev);
  const next = sibs[e.index + 1];
  if (next !== undefined) return idOf(next);
  return e.parentId;
}

// ---------------------------------------------------------------------------------------------
// View state (collapse) and whole-tree helpers

/** Ids of the collapsed nodes: collapse is view state and is carried across undo/redo. */
export function collapsedIds(root: MapNode): Set<string> {
  const ids = new Set<string>();
  const st: MapNode[] = [root];
  for (let n = st.pop(); n !== undefined; n = st.pop()) {
    if (n.collapsed) ids.add(idOf(n));
    for (const c of n.children) st.push(c);
  }
  return ids;
}

/**
 * The same tree with `collapsed` = ids.has(id) on every node. Only paths where a flag differs are
 * re-created; a node whose children did not change keeps its `children` array (a spread copy).
 */
export function withCollapsed(root: MapNode, ids: ReadonlySet<string>): MapNode {
  const fix = (n: MapNode): MapNode => {
    const kids = n.children.map(fix);
    const want = ids.has(idOf(n)) && n.children.length > 0;
    let kidsChanged = false;
    for (let i = 0; !kidsChanged && i < kids.length; i++) if (kids[i] !== n.children[i]) kidsChanged = true;
    if (!kidsChanged && want === !!n.collapsed) return n;
    return patch(n, kidsChanged ? { children: freeze(kids), collapsed: want } : { collapsed: want });
  };
  return fix(root);
}

export function countNodes(root: MapNode): number {
  let n = 0;
  const st: MapNode[] = [root];
  for (let x = st.pop(); x !== undefined; x = st.pop()) {
    n++;
    for (const c of x.children) st.push(c);
  }
  return n;
}

const sizeMemo = new WeakMap<MapNode, number>();

/**
 * countNodes(node), memoised per node object (nodes are immutable, so a size never changes). After an edit
 * only the new objects on the edited path are counted again: the collapse badge of a node that hides a big
 * subtree costs O(1) per render instead of O(hidden nodes). Iterative (no recursion limit on deep trees).
 */
export function subtreeSize(node: MapNode): number {
  const hit = sizeMemo.get(node);
  if (hit !== undefined) return hit;
  const st: Array<[MapNode, boolean]> = [[node, false]];
  for (let top = st.pop(); top !== undefined; top = st.pop()) {
    const [n, kidsDone] = top;
    if (kidsDone) {
      let size = 1;
      for (const c of n.children) size += sizeMemo.get(c) ?? 0;
      sizeMemo.set(n, size);
    } else if (!sizeMemo.has(n)) {
      st.push([n, true]);
      for (const c of n.children) if (!sizeMemo.has(c)) st.push([c, false]);
    }
  }
  return sizeMemo.get(node) ?? 1;
}

/**
 * Two trees hold the same DOCUMENT when texts, bodies and structure match; `collapsed` is view
 * state and only counts when the file persists folds (`withFolds`). Short-circuits on shared
 * subtrees, so comparing a tree with its predecessor costs O(edited path).
 */
export function sameDoc(a: MapNode, b: MapNode, withFolds = false): boolean {
  if (a === b) return true;
  if (a.text !== b.text || a.body !== b.body || a.children.length !== b.children.length) return false;
  if (withFolds && !!a.collapsed !== !!b.collapsed) return false;
  for (let i = 0; i < a.children.length; i++) {
    const x = a.children[i];
    const y = b.children[i];
    if (x === undefined || y === undefined || !sameDoc(x, y, withFolds)) return false;
  }
  return true;
}

/**
 * sameDoc, and node for node the same nodes (the same ids): what the editor's getMarkdown() shortcut needs.
 * Two content-identical siblings swapped (a node and its Mod+D copy, Alt+Up) are the same document but not
 * the same nodes: the writer gives each node its own bytes (an untouched one its raw lines, a copy the
 * canonical ones), so the text must be written again instead of reusing the cached one. A collapse toggle
 * keeps every id, so it still costs O(path). Short-circuits on shared subtrees; iterative.
 */
export function sameNodes(a: MapNode, b: MapNode, withFolds = false): boolean {
  const stack: Array<[MapNode, MapNode]> = [[a, b]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [x, y] = top;
    if (x === y) continue;
    if (idOf(x) !== idOf(y) || x.text !== y.text || x.body !== y.body || x.children.length !== y.children.length) return false;
    if (withFolds && !!x.collapsed !== !!y.collapsed) return false;
    for (let i = 0; i < x.children.length; i++) {
      const cx = x.children[i];
      const cy = y.children[i];
      if (cx === undefined || cy === undefined) return false;
      stack.push([cx, cy]);
    }
  }
  return true;
}

/** Child indices from the root down to `id`, or null when `id` is not in the tree. */
export function pathOf(root: MapNode, id: string): number[] | null {
  const idx = indexOf(root);
  const path: number[] = [];
  for (let cur: string | null = id; cur !== null; ) {
    const e = idx.get(cur);
    if (!e) return null;
    if (e.parentId !== null) path.push(e.index);
    cur = e.parentId;
  }
  return path.reverse();
}

/** The node at a child-index path, or undefined when the path leaves the tree. */
export function nodeAtPath(root: MapNode, path: readonly number[]): MapNode | undefined {
  let cur: MapNode | undefined = root;
  for (const i of path) {
    cur = cur.children[i];
    if (cur === undefined) return undefined;
  }
  return cur;
}
