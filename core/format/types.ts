/**
 * Public types of the Markdown format layer (@markmind/core/format).
 *
 * The format has one job: turn ONE Markdown file (an `# H1` root followed by a nested bullet
 * list) into a tree and back while changing as few bytes as possible. The rules it follows are
 * R1-R18 from the format research (see docs/ARCHITECTURE.md, "The file format"); the tests under
 * packages/core/test/format are named after them.
 */

/**
 * A node as the editor sees it. Ids are the editor's business: the format never needs them.
 *
 * Parsed nodes are deep-frozen. Editors edit by path copying (a changed node and its ancestors
 * are new objects, untouched subtrees keep their identity); the writer uses that identity, and
 * falls back to text/position matching, to decide which lines it may re-emit verbatim (R6).
 */
export interface MapNode {
  readonly text: string;
  readonly children: readonly MapNode[];
  /** Folded in the UI. Persisted only as the `<!-- markmap: fold -->` opt-in suffix (R10f). */
  readonly collapsed?: boolean;
  /**
   * Extra block content of the list item that is not node text (R8): paragraphs after a blank
   * line, fenced code, quotes, HTML... Opaque to the editor. Editors MUST carry it when they copy
   * a node (spread the node: `{ ...node, text }`, which also keeps the `children` array the writer
   * uses to recognise the copy); a node without a `body` key inherits the body of the parsed node
   * it is matched with by identity or as a spread copy (and by a unique text only in a tree rebuilt
   * from scratch, where no parsed node identity survives); a node with `body: ''` drops it.
   */
  readonly body?: string;
}

/** Marker style of one sibling group (R13). */
export type ListStyle =
  | { readonly ordered: false; readonly ch: string }
  | { readonly ordered: true; readonly delim: string; readonly start: number };

export type Eol = '\n' | '\r\n';

/** Half-open [start, end) offsets into `MapDocument.source` (the input without its BOM). */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** What the parser remembers about one sibling group so the writer can keep its style (R6). */
export interface GroupProvenance {
  /** The children as parsed, by identity. */
  readonly nodes: readonly MapNode[];
  /** Indent string of the first parsed child (the group's indent while it is still valid). */
  readonly indent: string | undefined;
  /** Marker style taken from the first parsed child. */
  readonly style: ListStyle | undefined;
}

/** Own lines of an item that follow one of its children (a body continued after or between the children, R8). */
export interface OwnSegment {
  /** The lines as written, blank lines included. */
  readonly lines: readonly string[];
  /** The source line right before the segment (the last line of the child's subtree it followed). */
  readonly prev: string;
}

/** What the parser remembers about one list item so the writer can re-emit it verbatim (R6). */
export interface NodeProvenance {
  readonly marker: string;
  readonly indent: string;
  readonly contentCol: number;
  /** Parsed values: the writer may reuse `raw` only when the node still has these. */
  readonly text: string;
  readonly body: string | undefined;
  readonly collapsed: boolean;
  /** The marker line had no content at all (`-` alone), see R12. */
  readonly bareEmpty: boolean;
  /** The item's own lines from its marker line up to (not including) its first child. */
  readonly raw: readonly string[];
  /**
   * How many lines of `raw` hold the marker and the text paragraph (0 when the marker line opens a body block:
   * a fence, a quote, an HTML block). `raw.slice(textEnd)` is the item's own content after its text: the writer
   * re-emits it verbatim when only the text (or the marker number) changed and the content column did not (R6/R8).
   */
  readonly textEnd: number;
  /**
   * The item's own lines that follow each child, by child index (null when none follow that child):
   * a body continued after or between the children. Re-emitted in place while the children group
   * is untouched, so an edit elsewhere never reorders such an item's paragraphs.
   */
  readonly rawAfter: ReadonlyArray<OwnSegment | null>;
  /** Blank lines and masked comment blocks that precede the item and move with it (R16). */
  readonly trivia: readonly string[];
  /** Line indices into the split source (for tests and diagnostics). */
  readonly startLine: number;
  readonly lastOwnLine: number;
  readonly children: GroupProvenance;
}

export interface Provenance {
  /** Every parsed list node, keyed by identity. */
  readonly nodes: ReadonlyMap<MapNode, NodeProvenance>;
  /** The root's children group. */
  readonly rootChildren: GroupProvenance;
}

/** Byte offsets the writer needs to regenerate only the H1 line and the list region (R2). */
export interface DocumentLayout {
  /** The root heading line(s), or null when the root is virtual. */
  readonly head: TextRange | null;
  /** Offset right after the frontmatter (0 when there is none): where an H1 is inserted (R3). */
  readonly bodyStart: number;
  /** Offset after the intro section: where a first list is inserted (R14). */
  readonly insertAt: number;
  /** The map-list region, or null when the file has no list yet. */
  readonly map: TextRange | null;
}

export interface MapDocument {
  readonly root: MapNode;
  /** True when the file has no H1: the root text is the file's basename and is not in the file. */
  readonly virtualRoot: boolean;
  readonly basename: string;
  /** '' or '\uFEFF' (R1). */
  readonly bom: '' | '﻿';
  readonly eol: Eol;
  readonly finalNewline: boolean;
  /** The raw frontmatter block (without its trailing newline), or null (R2). */
  readonly frontmatter: string | null;
  readonly frontmatterRange: TextRange | null;
  /** Detected indent unit: '\t' or N spaces (R6). */
  readonly indentUnit: string;
  /** The file already uses `<!-- markmap: fold -->`: collapsed state is written back (R10f). */
  readonly foldsInFile: boolean;
  /** The input text without its BOM; everything outside the regenerated parts is sliced from it. */
  readonly source: string;
  readonly layout: DocumentLayout;
  readonly provenance: Provenance;
}

export interface ParseOptions {
  /** Root text when the file has no H1 (R3). */
  readonly basename: string;
}

export interface SerializeOptions {
  /** Override the detected indent unit for regenerated lines. */
  readonly indentUnit?: string;
  /** Override `doc.foldsInFile`: write collapsed nodes with the fold suffix. */
  readonly folds?: boolean;
  /**
   * LINEAGE: a stable key per node that an editor keeps across its path copies (the editor's node id;
   * `undefined` for a node it has no key for). With it, every node is matched with the parsed node of
   * the same key, wherever it was parsed and whatever it holds now: a node edited inside and then moved
   * (or the reverse) keeps its raw lines, its trivia and its body, and a keyed node whose key no parsed
   * node has is a new node that never takes a sibling's provenance. The keys of the parsed nodes must be
   * the ones the editor gave them (it keys the parsed objects it was handed).
   */
  readonly keyOf?: (node: MapNode) => string | undefined;
}

export interface ListOptions {
  readonly indentUnit?: string;
  readonly eol?: Eol;
  /** Write collapsed nodes with the fold suffix (default false). */
  readonly folds?: boolean;
}
