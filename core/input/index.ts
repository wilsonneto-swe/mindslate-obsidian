/** input: the keymap decision table, the edit-session rules, clipboard helpers, the drop-target rule and the multi-selection (all pure). */
export { ZOOM_STEP, keyToCommand, preventsDefault } from './keymap.js';
export type { ArrowDir, KeyCommand, KeyContext, KeyLike } from './keymap.js';
export { commitText, liveToModelText, resolveEndEdit } from './edit-session.js';
export type { EndEditAction, EndEditFacts } from './edit-session.js';
export { looksLikeOutline, parseClipboard, pasteAsOneNodeText, subtreeToMarkdown, subtreesToMarkdown } from './clipboard.js';
export { addNodes, clickToggle, marqueeHits, marqueeSelection, onlyRoot, selectedIds, toggleNode } from './selection.js';
export type { NodeSelection, WorldRect } from './selection.js';
export { CHILD_PAD, EDGE_PAD, MAX_DIST, dropTarget, insertionPoint, isNoop, rectDist, subtreeIds } from './dragdrop.js';
export type { Box, DropKind, DropTarget, InsertionPoint } from './dragdrop.js';
