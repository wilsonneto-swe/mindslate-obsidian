/**
 * The editor's writer: `serializeDocument` with the node ids as LINEAGE keys (format/types.ts
 * `SerializeOptions.keyOf`).
 *
 * Ids live in a WeakMap outside the nodes (ids.ts) and every path-copying primitive in tree.ts
 * registers its copy under the id of the object it replaces, so an id names one node through any
 * sequence of edits, moves, undo and redo. Handing the ids to the writer lets it pair every node with
 * the parsed node it descends from wherever it is now: an item edited inside and then moved, reordered
 * or dragged into a sibling keeps its raw lines, its trivia (comment lines) and its note byte for byte,
 * and a node created in this session (mkNode, cloneTree: a new id) never takes another node's
 * provenance. Without the ids the writer has to guess from identity, children arrays, texts and
 * positions (format/pairing.ts), and a guess can hand one node's note to its sibling.
 */
import { serializeDocument } from '../format/serialize.js';
import type { MapDocument, MapNode } from '../format/types.js';
import { peekId } from './ids.js';

/** `serializeDocument(doc, root)` keyed by the editor's node ids (byte-identical while `root === doc.root`). */
export function writeDocument(doc: MapDocument, root: MapNode): string {
  return serializeDocument(doc, root, { keyOf: peekId });
}
