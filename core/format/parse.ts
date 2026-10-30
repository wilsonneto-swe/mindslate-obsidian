/**
 * Dependency-free, line-based reader for the H1 + nested-list mind map format (R18).
 *
 * It follows CommonMark's container rules (tab stops of 4, content column = marker + 1-4 spaces,
 * lazy paragraph continuation, fences inside item bodies) closely enough that markdown-it and
 * legacy remark (Obsidian's Reading view) see the same tree; the tests cross-check that.
 *
 * Every parsed node is frozen and registered in the document's provenance map (R6) so the writer
 * can re-emit its raw lines when the editor hands the same node back.
 */
import { RE, linkDefStart, readFoldSuffix, unescapeLine, unescapeRoot } from './escape.js';
import { lead, markerAt, splitLines, stripCols, type Line, type Marker } from './lines.js';
import { trimClosingHashes, trimEndBlank } from './trim.js';
import type {
  Eol,
  GroupProvenance,
  ListStyle,
  MapDocument,
  MapNode,
  NodeProvenance,
  OwnSegment,
  ParseOptions,
  TextRange,
} from './types.js';

export const BOM = '﻿';

const ATX_ANY = /^#{1,6}(?:[ \t]|$)/;
const H1 = /^#(?:[ \t]|$)/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const FOLD_ONLY = /^<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->[ \t]*$/;
const PLACEHOLDER = /^<!--[ \t]*-->[ \t]*$/;

/**
 * Blocks that interrupt a paragraph, and so can never be lazy / continuation text (CommonMark 4.1,
 * 4.5, 4.6, 5.1 and HTML blocks 1-6). The writer uses the same test to decide when a regenerated
 * body needs a blank line after the text (R8).
 */
export const interrupts = (s: string): boolean =>
  ATX_ANY.test(s) || RE.fence.test(s) || RE.quote.test(s) || RE.thematic.test(s) || RE.html1to6.test(s);

/** Marker-line content that starts a non-paragraph block: the item has no text, only body (R8). */
const firstLineBlock = (s: string): boolean => interrupts(s) || RE.html7.test(s) || linkDefStart(s);

/** Matches the closing fence for an opening run of the same character, at least as long. */
function fenceCloser(open: string): RegExp {
  const ch = open.charAt(0) === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${ch}{${open.length},}[ \\t]*$`);
}

const textAt = (lines: readonly Line[], i: number): string => lines[i]?.text ?? '';

/**
 * Multi-line opaque blocks outside the map (fences, %% / $$ blocks, HTML comments): the heading
 * and map-start scans skip them (R3/R4). Returns the end index (exclusive) or -1.
 */
function opaqueEnd(lines: readonly Line[], i: number): number {
  const L = lead(textAt(lines, i));
  if (L.col > 3) return -1;
  const f = FENCE_OPEN.exec(L.rest);
  if (f) {
    const close = fenceCloser(f[1] ?? '```');
    for (let j = i + 1; j < lines.length; j++) if (close.test(textAt(lines, j))) return j + 1;
    return lines.length;
  }
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['%%', '%%'],
    ['$$', '$$'],
    ['<!--', '-->'],
  ];
  for (const [open, close] of pairs) {
    if (!L.rest.startsWith(open) || L.rest.slice(open.length).includes(close)) continue;
    for (let j = i + 1; j < lines.length; j++) if (textAt(lines, j).includes(close)) return j + 1;
    return lines.length;
  }
  return -1;
}

/**
 * R1 (refined by the ENCODING rule of the desktop file layer): the EOL is the majority line
 * ending; the first line break decides ties.
 */
export function detectEol(src: string): Eol {
  let crlf = 0;
  let lf = 0;
  let first: Eol | null = null;
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) {
    const isCrlf = i > 0 && src.charCodeAt(i - 1) === 0x0d;
    if (isCrlf) crlf++;
    else lf++;
    first ??= isCrlf ? '\r\n' : '\n';
  }
  if (crlf > lf) return '\r\n';
  if (lf > crlf) return '\n';
  return first ?? '\n';
}

// ---------------------------------------------------------------------------------------------
// List items

interface Group {
  kids: Builder[];
  indent: string | undefined;
  style: ListStyle | undefined;
}

/** Mutable record of one item while scanning; becomes a frozen MapNode + NodeProvenance. */
interface Builder {
  readonly mk: Marker;
  readonly start: number;
  /** Last line that belongs to this item itself (not to a descendant). */
  lastOwn: number;
  /** Last own line before the first child; -1 while the item has no children. */
  rawEnd: number;
  /**
   * Own lines that follow a child (a body continued after or between the children, R8), as line
   * ranges keyed by the index of the child they follow. The writer re-emits each segment right
   * after its child while the children group is untouched, so such an item is never regenerated
   * (and its paragraphs never reordered) by an edit elsewhere.
   */
  readonly segments: Map<number, { start: number; end: number }>;
  readonly textLines: string[];
  /**
   * The item's lines that hold its marker and its text paragraph, counted from `start` (0 when the marker
   * line opens a body block: a fence, a quote, an HTML block...). The writer re-emits the own lines after
   * them verbatim when only the text changed (R6/R8, NodeProvenance.textEnd).
   */
  textEnd: number;
  readonly body: string[];
  readonly trivia: readonly string[];
  collapsed: boolean;
  readonly group: Group;
}

interface Frame {
  readonly b: Builder;
  readonly contentCol: number;
  /** What a lazy / indented continuation line extends: the text paragraph or the body. */
  lazy: 'text' | 'body' | null;
  /** Inside a fenced block of the body: the closer to look for. */
  fence: RegExp | null;
  /** The marker line had no content: a following line can still become the text. */
  emptyStart: boolean;
  /** Inside a `%%` / `$$` / `<!--` block of the body: the closer to look for (R8/R16 refinement). */
  maskClose: string | null;
}

export interface ItemsResult {
  readonly children: readonly MapNode[];
  readonly group: GroupProvenance;
  readonly nodes: Map<MapNode, NodeProvenance>;
  /** Index of the last line that belongs to the list. */
  readonly last: number;
  readonly foldsInFile: boolean;
}

const styleOf = (mk: Marker): ListStyle =>
  mk.num !== null ? { ordered: true, delim: mk.delim ?? '.', start: Number(mk.num) } : { ordered: false, ch: mk.marker };

/**
 * A line-start `%%` / `$$` block that does not close on its own line, or an HTML comment: the closer to look
 * for (null when the block is one line), or undefined when the text opens no such block (a one-line `%% x %%`
 * is plain text: it continues a paragraph).
 */
function blockCloser(rest: string): string | null | undefined {
  const mt = /^(%%|\$\$)/.exec(rest)?.[1];
  if (mt !== undefined && !rest.slice(2).includes(mt)) return mt;
  if (rest.startsWith('<!--')) return rest.slice(4).includes('-->') ? null : '-->';
  return undefined;
}

/**
 * The first line after the comment block that starts at line `i` and the blank lines and further such blocks
 * (at column `contentCol` or deeper) that follow it: its index, and its column when it is a list item marker in
 * the child window of an item whose content starts at `contentCol` (-1 otherwise). `memo` keeps the last scan,
 * so a run of many comment blocks is scanned once, not once per block.
 */
interface BlockRunEnd {
  readonly from: number;
  readonly at: number;
  readonly contentCol: number;
  readonly markerCol: number;
}
function endOfBlockRun(lines: readonly Line[], i: number, closer: string | null, contentCol: number, memo: { last: BlockRunEnd | null }): BlockRunEnd {
  const m = memo.last;
  if (m !== null && m.contentCol === contentCol && i > m.from && i < m.at) return m;
  let close = closer;
  let j = i;
  for (;;) {
    if (close !== null) {
      // skip to the closing line of this block
      j++;
      while (j < lines.length && !textAt(lines, j).includes(close)) j++;
    }
    j++;
    // blank lines in between
    while (j < lines.length && lead(textAt(lines, j)).rest === '') j++;
    if (j >= lines.length) return (memo.last = { from: i, at: lines.length, contentCol, markerCol: -1 });
    const t = textAt(lines, j);
    const L = lead(t);
    const next = L.col >= contentCol ? blockCloser(L.rest) : undefined;
    if (next !== undefined) {
      close = next; // another block before the item: skip it too
      continue;
    }
    const child = markerAt(t) !== null && L.col >= contentCol && L.col < contentCol + 4;
    return (memo.last = { from: i, at: j, contentCol, markerCol: child ? L.col : -1 });
  }
}

/**
 * R16 (refined): true when the comment block that starts at line `i` (column `col`), followed by nothing but
 * blank lines and other such blocks, sits right above a list item that becomes the FIRST child of the open item
 * whose content starts at `contentCol`, at a column no deeper than the block's. The block is that child's
 * leading trivia, exactly as it is above any later child; otherwise it is the open item's body (R8).
 */
function aboveFirstChild(lines: readonly Line[], i: number, closer: string | null, contentCol: number, col: number, memo: { last: BlockRunEnd | null }): boolean {
  const end = endOfBlockRun(lines, i, closer, contentCol, memo);
  return end.markerCol >= 0 && end.markerCol <= col;
}

/** Parses the list that starts at line `from` (which must be a marker line). */
export function parseItems(lines: readonly Line[], from: number): ItemsResult {
  const rootGroup: Group = { kids: [], indent: undefined, style: undefined };
  const stack: Frame[] = [];
  let pending: string[] = [];
  let mask: string | null = null;
  let last = from;
  let folds = false;
  const runMemo: { last: BlockRunEnd | null } = { last: null }; // aboveFirstChild: one scan per run of comment blocks

  const addChild = (parent: Builder | null, group: Group, child: Builder): void => {
    if (!group.kids.length) {
      group.indent = child.mk.indent;
      group.style = styleOf(child.mk);
      if (parent && parent.rawEnd < 0) parent.rawEnd = parent.lastOwn;
    }
    group.kids.push(child);
  };
  const addBody = (f: Frame, text: string, i: number): void => {
    const b = f.b;
    // `pending` holds exactly the lines just before `i` (blank lines and masked blocks).
    const kids = b.group.kids.length;
    if (kids) {
      // An own line after the children extends (or opens) the segment that follows the last child
      // so far; the blank lines before it belong to the segment too (R8).
      const seg = b.segments.get(kids - 1);
      if (seg) seg.end = i;
      else b.segments.set(kids - 1, { start: i - pending.length, end: i });
    }
    for (const t of pending) b.body.push(lead(t).rest === '' ? '' : stripCols(t, f.contentCol));
    pending = [];
    b.body.push(stripCols(text, f.contentCol));
    b.lastOwn = last = i;
  };

  for (let i = from; i < lines.length; i++) {
    const t = textAt(lines, i);
    const L = lead(t);
    const top = stack[stack.length - 1];
    if (top && top.maskClose !== null) {
      // A %% / $$ / <!-- block that opened inside an item's content is that item's body up to its
      // closer, whatever the indentation of its inner lines (Obsidian hides the whole block).
      addBody(top, t, i);
      if (t.includes(top.maskClose)) top.maskClose = null;
      continue;
    }
    if (top && top.fence) {
      if (L.rest !== '' && L.col < top.contentCol) top.fence = null;
      else {
        addBody(top, t, i);
        if (top.fence.test(stripCols(t, top.contentCol))) top.fence = null;
        continue;
      }
    }
    // R16: a line-start %% / $$ block between items is trivia of the next item.
    if (mask !== null) {
      pending.push(t);
      if (t.includes(mask)) mask = null;
      continue;
    }
    if (L.rest === '') {
      pending.push(t);
      for (const s of stack) s.lazy = null;
      continue;
    }
    let k = 0;
    while (k < stack.length && L.col >= (stack[k]?.contentCol ?? 0)) k++;
    const fit = k ? (stack[k - 1] ?? null) : null;
    const mt = /^(%%|\$\$)/.exec(L.rest);
    const mtOpen = mt?.[1];
    const opensMask = mtOpen !== undefined && !L.rest.slice(2).includes(mtOpen);
    const isComment = L.rest.startsWith('<!--');
    if (opensMask || isComment) {
      const closer = opensMask ? mtOpen : L.rest.slice(4).includes('-->') ? null : '-->';
      // R8 refinement: a block indented to an open item's content column is that item's content
      // by every Markdown parser: its body, masked up to the closer so nothing inside is read as an
      // item. It owns the block when it has no children yet, or when the block sits below the
      // children's indent (a body after the children). At the children's indent it is a comment
      // BETWEEN nested items: trivia of the next one (R16), exactly like at the top level. Making
      // it trivia of the next sibling instead would move it with that sibling and delete it with it.
      // R16 refined: a block right above the item that becomes the item's FIRST child (at that child's
      // column or deeper; blank lines and other such blocks may sit in between) is that child's trivia
      // too, as above any later child: a comment written above a node moves with the node, and a node
      // that lands first in a group (a drag, Alt+Enter) keeps its comment instead of handing it to the
      // parent as a note.
      const kidsIndent = fit?.b.group.indent;
      const ownsBlock =
        fit !== null &&
        (fit.b.group.kids.length === 0
          ? !aboveFirstChild(lines, i, closer ?? null, fit.contentCol, L.col, runMemo)
          : kidsIndent !== undefined && L.col < lead(kidsIndent).col);
      if (fit !== null && ownsBlock) {
        stack.length = k;
        for (const s of stack) s.lazy = null;
        addBody(fit, t, i);
        if (closer !== null && closer !== undefined) fit.maskClose = closer;
        continue;
      }
      // R16: a line-start block between items is trivia of the next item. Unlike %% a one-line HTML
      // comment counts too: an HTML block interrupts the open item, so without this the map would
      // end at the comment and every later node would be invisible postamble. Marker lines never
      // start with '<!--' (the placeholder and fold comments follow a marker), and node text that
      // starts with '<!--' is written escaped (R10b), so only hand-written comment lines land here.
      if (closer !== null && closer !== undefined) mask = closer;
      pending.push(t);
      for (const s of stack) s.lazy = null;
      continue;
    }
    const mk = markerAt(t);
    const deepest = stack[stack.length - 1] ?? null;
    // CommonMark 5.2 (also markdown-it and legacy remark): an ordered list not starting at 1
    // cannot interrupt the open paragraph (R8), whether that paragraph is the item's text or a
    // paragraph of its body (`lazy` is 'text' or 'body' while one is open).
    const cannotInterrupt =
      mk !== null &&
      mk.num !== null &&
      Number(mk.num) !== 1 &&
      fit !== null &&
      fit === deepest &&
      fit.lazy !== null &&
      !fit.emptyStart &&
      pending.length === 0;
    if (mk && !cannotInterrupt && (fit ? L.col < fit.contentCol + 4 : L.col <= 3)) {
      stack.length = k;
      const b: Builder = {
        mk,
        start: i,
        lastOwn: i,
        rawEnd: -1,
        segments: new Map(),
        textLines: [],
        textEnd: 1,
        body: [],
        trivia: pending,
        collapsed: false,
        group: { kids: [], indent: undefined, style: undefined },
      };
      pending = [];
      last = i;
      addChild(fit ? fit.b : null, fit ? fit.b.group : rootGroup, b);
      const f: Frame = { b, contentCol: mk.contentCol, lazy: null, fence: null, emptyStart: false, maskClose: null };
      const c = trimEndBlank(mk.content);
      if (c === '') {
        f.lazy = 'text';
        f.emptyStart = true;
      } else if (PLACEHOLDER.test(c)) {
        // R12: the placeholder is an empty node.
      } else if (FOLD_ONLY.test(c)) {
        b.collapsed = true;
        folds = true;
      } else if (firstLineBlock(c)) {
        b.body.push(c);
        b.textEnd = 0; // the marker line is the first line of the body
        const fo = FENCE_OPEN.exec(c);
        if (fo) f.fence = fenceCloser(fo[1] ?? '```');
      } else {
        b.textLines.push(c);
        f.lazy = 'text';
      }
      stack.push(f);
      continue;
    }
    const deep = stack[stack.length - 1];
    if (
      deep &&
      deep.lazy &&
      pending.length === 0 &&
      (L.col >= deep.contentCol
        ? !(L.col < deep.contentCol + 4 && interrupts(L.rest))
        : !interrupts(L.rest) && !deep.emptyStart)
    ) {
      if (deep.lazy === 'text') {
        deep.b.textLines.push(trimEndBlank(L.rest));
        deep.b.textEnd = i - deep.b.start + 1;
        deep.b.lastOwn = last = i;
        deep.emptyStart = false;
      } else {
        addBody(deep, t, i);
      }
      continue;
    }
    if (!fit) break; // R4: the map ends at the first line that belongs to no item
    stack.length = k;
    for (const s of stack) s.lazy = null;
    const rel = stripCols(t, fit.contentCol);
    addBody(fit, t, i);
    const fo = /^ {0,3}(`{3,}|~{3,})/.exec(rel);
    if (fo) fit.fence = fenceCloser(fo[1] ?? '```');
    else if (!interrupts(rel.trimStart()) && lead(rel).col < 4) fit.lazy = 'body';
  }

  const nodes = new Map<MapNode, NodeProvenance>();
  const finish = (b: Builder, children: readonly MapNode[]): MapNode => {
    const mk = b.mk;
    const ch = mk.num !== null ? null : mk.marker;
    let tl = b.textLines.filter((l, j) => j > 0 || l !== '');
    let collapsed = b.collapsed;
    const lastText = tl[tl.length - 1];
    if (lastText !== undefined) {
      const f = readFoldSuffix(lastText);
      let text = f.text;
      if (f.fold) {
        collapsed = true;
        folds = true;
        // R10f: the writer escapes a literal fold-looking suffix (one backslash) before appending
        // the real one; now that the real suffix is gone, undo that escape so the text reads back
        // as typed. A second backslash-free suffix (hand-written) stays literal.
        const literal = readFoldSuffix(text);
        if (!literal.fold) text = literal.text;
      }
      tl[tl.length - 1] = text;
      if (tl.length === 1 && PLACEHOLDER.test(text)) tl = [];
    }
    // R8: trimmed text lines, unescaped (R10), joined with '\n'.
    const text = tl
      .filter((l) => l !== '')
      .map((l, j) => unescapeLine(l, j === 0, ch))
      .join('\n');
    const bodyLines = [...b.body];
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    const body = bodyLines.length ? bodyLines.join('\n') : undefined;
    const node: MapNode = Object.freeze({
      text,
      children,
      ...(collapsed ? { collapsed: true } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    const rawEnd = b.rawEnd < 0 ? b.lastOwn : b.rawEnd;
    const rawAfter: ReadonlyArray<OwnSegment | null> = b.group.kids.map((_, j) => {
      const seg = b.segments.get(j);
      if (!seg) return null;
      // `prev` is the line the segment followed in the file (the last line of child j's subtree): the
      // writer compares it with what it just emitted to know whether the segment still follows the
      // same line (see serialize.ts emitSegment).
      return { lines: lines.slice(seg.start, seg.end + 1).map((l) => l.text), prev: textAt(lines, seg.start - 1) };
    });
    nodes.set(node, {
      marker: mk.marker,
      indent: mk.indent,
      contentCol: mk.contentCol,
      text,
      body,
      collapsed,
      bareEmpty: mk.content.trim() === '',
      raw: lines.slice(b.start, rawEnd + 1).map((l) => l.text),
      textEnd: Math.min(b.textEnd, rawEnd - b.start + 1),
      rawAfter,
      trivia: b.trivia,
      startLine: b.start,
      lastOwnLine: b.lastOwn,
      children: { nodes: children, indent: b.group.indent, style: b.group.style },
    });
    return node;
  };
  // Post-order over an explicit stack (not recursion): a file nested thousands of levels deep must
  // parse without a RangeError, since the shells promise that parseDocument never throws.
  const finishGroup = (kids: readonly Builder[]): readonly MapNode[] => {
    interface Pending {
      readonly b: Builder | null;
      next: number;
      readonly done: MapNode[];
    }
    const stack: Pending[] = [{ b: null, next: 0, done: [] }];
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) return Object.freeze([]);
      const group = top.b ? top.b.group.kids : kids;
      const nb = group[top.next];
      if (nb !== undefined) {
        top.next++;
        stack.push({ b: nb, next: 0, done: [] });
        continue;
      }
      stack.pop();
      const children: readonly MapNode[] = Object.freeze(top.done);
      if (top.b === null) return children;
      const node = finish(top.b, children);
      stack[stack.length - 1]?.done.push(node);
    }
  };
  const children = finishGroup(rootGroup.kids);
  return {
    children,
    group: { nodes: children, indent: rootGroup.indent, style: rootGroup.style },
    nodes,
    last,
    foldsInFile: folds,
  };
}

/**
 * R6: the indent unit is what the first nested level adds to its parent's indent: '\t' when that
 * indent uses a tab, else the column difference as spaces (at least 2, a marker plus its space). The
 * difference, not the child's absolute indent, so that an indented top-level list (`  - a` with
 * `    - b` under it) gives new children the same 2-space step as the existing ones.
 */
function detectIndentUnit(children: readonly MapNode[], nodes: ReadonlyMap<MapNode, NodeProvenance>): string {
  const withKids = children.find((c) => c.children.length > 0);
  const parent = withKids ? nodes.get(withKids) : undefined;
  const u = parent?.children.indent;
  if (parent === undefined || u === undefined || u.includes('\t')) return '\t';
  const step = lead(u).col - lead(parent.indent).col;
  return step >= 2 ? ' '.repeat(step) : '\t';
}

// ---------------------------------------------------------------------------------------------
// Document

interface Head {
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
}

export function parseDocument(input: string, opts: ParseOptions = { basename: 'Untitled' }): MapDocument {
  const basename = opts.basename;
  const bom = input.charCodeAt(0) === 0xfeff ? BOM : '';
  const src = bom ? input.slice(1) : input;
  const eol = detectEol(src);
  const lines = splitLines(src);
  const n = lines.length;
  const endOf = (i: number): number => lines[i]?.end ?? 0;
  const startOf = (i: number): number => lines[i]?.start ?? 0;

  // R2: frontmatter exists only when line 1 is exactly '---' and a later '---' or '...' closes it.
  let body = 0;
  let frontmatter: string | null = null;
  let frontmatterRange: TextRange | null = null;
  if (n && trimEndBlank(textAt(lines, 0)) === '---') {
    for (let j = 1; j < n; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(textAt(lines, j))) {
        body = j + 1;
        frontmatter = src.slice(0, endOf(j));
        frontmatterRange = { start: 0, end: endOf(j) };
        break;
      }
    }
  }

  // R3: the root is the first top-level H1 (ATX, or setext on read) outside opaque blocks and not
  // indented inside a list item.
  let head: Head | null = null;
  let paraStart = -1;
  let inList = false;
  let prevBlank = true;
  for (let i = body; i < n && !head; i++) {
    const t = textAt(lines, i);
    const L = lead(t);
    if (L.rest === '') {
      paraStart = -1;
      prevBlank = true;
      continue;
    }
    const ob = opaqueEnd(lines, i);
    if (ob > 0) {
      i = ob - 1;
      paraStart = -1;
      prevBlank = false;
      continue;
    }
    if (L.col === 0 && prevBlank && !markerAt(t)) inList = false;
    prevBlank = false;
    if (L.col <= 3 && H1.test(L.rest) && !(inList && L.col > 0)) {
      // LINEAR (escape.ts): the closing sequence and the trailing blanks without a backtracking expression
      const text = trimEndBlank(trimClosingHashes(L.rest.slice(1).replace(/^[ \t]+/, '')));
      head = { line: i, endLine: i, text: unescapeRoot(text) };
    } else if (L.col <= 3 && /^=+[ \t]*$/.test(L.rest) && paraStart >= 0) {
      head = {
        line: paraStart,
        endLine: i,
        text: lines
          .slice(paraStart, i)
          .map((l) => l.text.trim())
          .join(' '),
      };
    } else if (L.col <= 3 && markerAt(t)) {
      inList = true;
      paraStart = -1;
    } else if (L.col <= 3 && (ATX_ANY.test(L.rest) || RE.thematic.test(L.rest) || RE.quote.test(L.rest))) {
      paraStart = -1;
    } else if (L.col <= 3 && paraStart < 0 && !inList) {
      // A paragraph starts at indent <= 3 only: an indented (4+) line with no paragraph open is an
      // indented code block, and the `===` after it is a paragraph, not a setext underline.
      paraStart = i;
    }
  }

  // R4: the map starts at the first top-level list item after the root (or the body start) and
  // before the next heading; a marker line right after a paragraph line only counts when it can
  // interrupt that paragraph (a bullet with content, or an ordered marker starting at 1).
  let mapLine = -1;
  let insertLine = head ? head.endLine : -1;
  let para = false;
  /** `insertLine` as it was before the open paragraph started: where a list goes when that paragraph turns out to be a setext heading. */
  let beforePara = insertLine;
  for (let i = head ? head.endLine + 1 : body; i < n; i++) {
    const t = textAt(lines, i);
    const L = lead(t);
    if (L.rest === '') {
      para = false;
      continue;
    }
    const ob = opaqueEnd(lines, i);
    if (ob > 0) {
      i = ob - 1;
      insertLine = i;
      para = false;
      continue;
    }
    if (L.col <= 3 && ATX_ANY.test(L.rest)) break;
    if (L.col <= 3 && para && /^(?:=+|-+)[ \t]*$/.test(L.rest)) {
      // A setext heading ends the intro section (R14): the first list goes BEFORE the heading
      // text, never between the text and its underline (that would turn the heading into a
      // paragraph plus a thematic break).
      insertLine = beforePara;
      break;
    }
    const mk0 = L.col <= 3 ? markerAt(t) : null;
    if (mk0 && !(para && ((mk0.num !== null && Number(mk0.num) !== 1) || mk0.content.trim() === ''))) {
      mapLine = i;
      break;
    }
    if (!para) beforePara = insertLine;
    insertLine = i;
    // An indented (4+) line continues an open paragraph but never opens one (indented code), so the
    // paragraph state only changes on lines at indent <= 3.
    if (L.col <= 3) para = !interrupts(L.rest);
  }

  const items = mapLine >= 0 ? parseItems(lines, mapLine) : null;
  const children: readonly MapNode[] = items ? items.children : Object.freeze([]);
  const root: MapNode = Object.freeze({ text: head ? head.text : basename, children });
  const nodes = items ? items.nodes : new Map<MapNode, NodeProvenance>();
  const bodyStart = body ? endOf(body - 1) : 0;
  return {
    root,
    virtualRoot: head === null,
    basename,
    bom,
    eol,
    finalNewline: src.endsWith('\n'),
    frontmatter,
    frontmatterRange,
    indentUnit: items ? detectIndentUnit(children, nodes) : '\t',
    foldsInFile: items ? items.foldsInFile : false,
    source: src,
    layout: {
      head: head ? { start: startOf(head.line), end: endOf(head.endLine) } : null,
      bodyStart,
      insertAt: insertLine >= 0 ? endOf(insertLine) : bodyStart,
      map: items ? { start: startOf(mapLine), end: endOf(items.last) } : null,
    },
    provenance: {
      nodes,
      rootChildren: items ? items.group : { nodes: children, indent: undefined, style: undefined },
    },
  };
}
