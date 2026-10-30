/**
 * model: the immutable tree the editor edits. Nodes ARE the format's MapNode objects; ids live
 * in a WeakMap (ids.ts); every operation path-copies by spreading (tree.ts).
 */
export { idOf, newId, peekId, registerId, resetIds } from './ids.js';
export { writeDocument } from './document.js';
export { foldPlan, moveNodes, removeNodes, reorderNodes, selectionAfterRemove, topLevel } from './batch.js';
export {
  addChild,
  addParent,
  addSibling,
  buildIndex,
  cloneTree,
  collapsedIds,
  countNodes,
  entryOf,
  indent,
  indexOf,
  insertChild,
  isAncestor,
  mkNode,
  moveNode,
  nodeAtPath,
  outdent,
  patch,
  pathOf,
  removeNode,
  reorder,
  sameDoc,
  sameNodes,
  selectionAfterDelete,
  setCollapsed,
  setText,
  subtreeSize,
  toggleCollapsed,
  updateNode,
  withCollapsed,
} from './tree.js';
export type { IndexEntry, MkNodeOptions, Patch, TreeIndex } from './tree.js';
export { mulberry32, randomTree } from './random-tree.js';
export type { RandomTreeOptions } from './random-tree.js';
export { SAMPLE_MD, sampleMap } from './sample.js';
