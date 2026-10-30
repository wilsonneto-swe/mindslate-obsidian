/**
 * @markmind/core/format: the Markdown reader/writer for ONE .md file (an H1 root + a nested
 * bullet list that reads well in Obsidian). Pure functions, no I/O, no Node-only APIs, no
 * dependencies: this runs in the browser page and in the Electron renderer alike.
 *
 * Typical use:
 *   const doc = parseDocument(text, { basename: baseName(fileName) });
 *   // edit doc.root by path copying (new objects on the edited path, identity elsewhere) ...
 *   const out = serializeDocument(doc, newRoot);   // byte-identical when newRoot === doc.root
 *
 * Contract for editors: keep the parsed node objects where nothing changed (path copying) and
 * spread a node when copying it so `body` survives; ids live in the editor, not in the format.
 */
export type {
  DocumentLayout,
  Eol,
  GroupProvenance,
  ListOptions,
  ListStyle,
  MapDocument,
  MapNode,
  NodeProvenance,
  OwnSegment,
  ParseOptions,
  Provenance,
  SerializeOptions,
  TextRange,
} from './types.js';
export { parseDocument } from './parse.js';
export { normalizeText, serializeDocument, serializeList } from './serialize.js';
export { parseOutline } from './outline.js';
export { baseName, headingLine, newFileText } from './names.js';
export { escapeLine, escapeRoot, unescapeLine, unescapeRoot } from './escape.js';
