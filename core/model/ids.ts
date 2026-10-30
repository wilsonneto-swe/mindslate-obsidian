/**
 * Node ids live OUTSIDE the nodes (decided): editor nodes ARE the format's frozen MapNode objects
 * `{ text, children, collapsed?, body? }`, and a module-level WeakMap maps each object to a
 * session-local id. `idOf(node)` assigns a fresh id the first time it sees an object (parsed nodes
 * get theirs lazily); every path-copying primitive in tree.ts spreads the old node and registers
 * the copy under the SAME id, so ids are stable across edits, undo and redo (old snapshots are
 * mapped objects too). Ids are never written to the .md file.
 */
import type { MapNode } from '../format/types.js';

const ids = new WeakMap<MapNode, string>();
let seq = 0;

/** A fresh session-local id ('n1', 'n2', ... in base 36). */
export function newId(): string {
  return 'n' + (++seq).toString(36);
}

/** Restart the id sequence (tests). Ids already handed out stay attached to their objects. */
export function resetIds(start = 0): void {
  seq = start;
}

/** The id of a node object, assigned on first sight. */
export function idOf(node: MapNode): string {
  let id = ids.get(node);
  if (id === undefined) {
    id = newId();
    ids.set(node, id);
  }
  return id;
}

/** The id of a node object if it has one (never assigns). */
export function peekId(node: MapNode): string | undefined {
  return ids.get(node);
}

/** Attach `id` to `node` (a path copy keeps the id of the object it replaces; tests pin ids). */
export function registerId(node: MapNode, id: string): void {
  ids.set(node, id);
}
