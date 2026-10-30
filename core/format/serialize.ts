/**
 * Writer: regenerates only the root heading line (when its text changed) and the map-list region
 * (R2); inside the region, only the sibling groups and items that changed (R6).
 */
import { escapeFoldSuffix, escapeLine, RE } from './escape.js';
import { lead, markerAt, stripCols } from './lines.js';
import { trimBlank, trimEndBlankLines, trimEndLineBreaks } from './trim.js';
import { headingLine } from './names.js';
import { matchGroup, type GroupMatch, type MatchScope, type Pair } from './pairing.js';
import { interrupts } from './parse.js';
import type {
  GroupProvenance,
  ListOptions,
  ListStyle,
  MapDocument,
  MapNode,
  NodeProvenance,
  OwnSegment,
  SerializeOptions,
} from './types.js';

const FOLD = '<!-- markmap: fold -->';
const DEFAULT_STYLE: ListStyle = { ordered: false, ch: '-' };
const NO_PROVENANCE: ReadonlyMap<MapNode, NodeProvenance> = new Map();

/** R7/R11: the text lines as written: spaces/tabs trimmed, empty lines dropped, CRLF normalised. */
export function normalizeText(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimBlank)
    .filter((s) => s !== '');
}

const isBlankLine = (l: string): boolean => lead(l).rest === '';

/**
 * R8/R15: true when a non-blank line placed right after an open paragraph would be read as part of
 * that paragraph (continuation text, or its setext underline) instead of starting a block of its
 * own. `col` is the line's indentation relative to the paragraph's content column: 4 or more is
 * indented code, which never interrupts a paragraph.
 */
const joinsParagraph = (rest: string, col: number): boolean =>
  rest !== '' && (col >= 4 || !interrupts(rest) || RE.setext.test(rest));

export interface EmitContext extends MatchScope {
  /** Indent unit for regenerated nested items. */
  readonly unit: string;
  /** Write collapsed nodes with the fold suffix (R10f). */
  readonly folds: boolean;
  /** Provenance of the parsed nodes (empty for a fresh list). */
  readonly prov: ReadonlyMap<MapNode, NodeProvenance>;
  /** Style for a group without a parsed style (tests use it to exercise every marker kind). */
  readonly styleOf?: (parent: MapNode, depth: number) => ListStyle | undefined;
  /**
   * The tree was rebuilt from scratch (no parsed node identity survives anywhere, and no lineage
   * keys): the editor does not model bodies, so a unique-text match may carry one. False for an
   * identity-preserving editor, where a node without a `body` key is a NEW node (see bodyOf).
   */
  readonly inheritByText?: boolean;
  /** The parsed top-level group (its first item counts as a first item for the R16 refinement). */
  readonly rootGroup?: GroupProvenance;
}

/**
 * The body to write for `kid`: its own `body` when the key is present; otherwise the body of the
 * parsed node it is matched with by identity, by lineage (the editor's key) or as a spread copy (an
 * in-place edit that kept the children array). In a rebuilt tree (`ctx.inheritByText`) a unique-text
 * match carries a body too, and so does a positional match whose text is unchanged: the same node in
 * the same place, which an unchanged save must not strip of its note just because a sibling has the
 * same text (two `[ ] task` items with details). A positional match with a different text is an edit
 * and never carries a body, and neither does a 2b claim (a kid holding some of a sibling's children is
 * not necessarily that sibling: a child dragged into it). In an identity-preserving tree an editor
 * spreads the nodes it edits, so a key-less node there is a new node, and giving it a sibling's body
 * because the texts happen to agree (two '' nodes: one deleted, one just created) would duplicate or
 * resurrect content.
 */
function bodyOf(kid: MapNode, pair: Pair | null, o: NodeProvenance | undefined, ctx: EmitContext): string | undefined {
  if ('body' in kid) return kid.body;
  if (!pair || !o) return undefined;
  if (pair.kind === 'identity' || pair.kind === 'key' || pair.kind === 'copy') return o.body;
  if (ctx.inheritByText !== true) return undefined;
  if (pair.kind === 'text') return o.body;
  return pair.kind === 'position' && o.text === kid.text ? o.body : undefined;
}

/**
 * The parsed nodes that live somewhere in `root`'s tree (by identity, or by lineage key), and whether
 * any parsed node object survives at all (an identity-preserving editor). Iterative: deep trees.
 */
function liveParsed(
  root: MapNode,
  prov: ReadonlyMap<MapNode, NodeProvenance>,
  keyOf: ((node: MapNode) => string | undefined) | undefined,
  byKey: ReadonlyMap<string, MapNode> | undefined,
): { alive: Set<MapNode>; anyKnown: boolean } {
  const alive = new Set<MapNode>();
  let anyKnown = false;
  const stack: MapNode[] = [...root.children];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (prov.has(node)) {
      alive.add(node);
      anyKnown = true;
    } else if (keyOf !== undefined && byKey !== undefined) {
      const key = keyOf(node);
      const parsed = key === undefined ? undefined : byKey.get(key);
      if (parsed !== undefined) alive.add(parsed);
    }
    for (const c of node.children) stack.push(c);
  }
  return { alive, anyKnown };
}

const hasComment = (t: readonly string[]): boolean => t.some((l) => !isBlankLine(l));
const blanks = (n: number): string[] => Array.from({ length: n }, () => '');
/** The blank lines a trivia block opens with (the gap before the item, or before its comment). */
const leadBlanks = (t: readonly string[]): readonly string[] => {
  const k = t.findIndex((l) => !isBlankLine(l));
  return k < 0 ? t : t.slice(0, k);
};
/** The trivia from its first comment line on: what travels with the node (R16), blank lines inside included. */
const commentPart = (t: readonly string[]): readonly string[] => {
  const k = t.findIndex((l) => !isBlankLine(l));
  return k < 0 ? [] : t.slice(k);
};
/**
 * R16: comment trivia written before an item that is now at another column than it was parsed at (moved to
 * another depth, re-indented under a renumbered parent) moves with the item: each line loses the item's old
 * indent and gets the new one. Left at its old column the comment would close the list items between the two
 * columns, and the items after it would be read under another parent.
 */
const reindent = (t: readonly string[], fromCol: number, toIndent: string): readonly string[] =>
  t.map((l) => (isBlankLine(l) ? l : toIndent + stripCols(l, fromCol)));

/** The parsed nodes that were the FIRST item of their parsed group, the top level included (cached per provenance). */
const firstItemCache = new WeakMap<ReadonlyMap<MapNode, NodeProvenance>, ReadonlySet<MapNode>>();
function firstItems(prov: ReadonlyMap<MapNode, NodeProvenance>, rootGroup: GroupProvenance | null): ReadonlySet<MapNode> {
  let set = rootGroup === null ? undefined : firstItemCache.get(prov);
  if (set === undefined) {
    const s = new Set<MapNode>();
    const top = rootGroup?.nodes[0];
    if (top !== undefined) s.add(top);
    for (const p of prov.values()) {
      const f = p.children.nodes[0];
      if (f !== undefined) s.add(f);
    }
    if (rootGroup !== null) firstItemCache.set(prov, s);
    set = s;
  }
  return set;
}

/** A group's spacing between items: the fewest blank lines before any parsed item but the first (0 without one). */
function spacingOf(group: GroupProvenance | null, prov: ReadonlyMap<MapNode, NodeProvenance>): number {
  let min = Infinity;
  for (const n of group?.nodes.slice(1) ?? []) min = Math.min(min, (prov.get(n)?.trivia ?? []).filter(isBlankLine).length);
  return min === Infinity ? 0 : min;
}

/**
 * R16 refined: the leading trivia written before kid `i` of a group (`prevBlanks`: the blank lines written
 * before kid i - 1).
 *  - The blank lines before the FIRST item separate the list from the parent's text or note (at the top
 *    level they are outside the region): they belong to that slot, not to whichever node is first. The
 *    parsed first item in place writes its trivia as parsed; any other node landing first writes the parsed
 *    first item's blank lines, so a reorder, a move or a new first item never turns a tight list loose.
 *  - Every other item keeps its own leading trivia: blank lines and comment blocks move and are deleted
 *    with it. A node that WAS the first item of its parsed group carried only that separator, so at a later
 *    position it takes the group's spacing between items instead.
 *  - A new item takes the blank lines written before the item before it (a loose list stays loose), or,
 *    right after the first item, the group's spacing between items.
 *  - A comment block in the trivia always travels with its node (with the blank lines between it and the
 *    item): wherever the node lands, the slot's blank lines come first, then the node's comment, re-indented
 *    when the item is written at another column than it was parsed at (`kIndent`, see reindent).
 */
function leadingTrivia(
  ctx: EmitContext,
  group: GroupProvenance | null,
  pair: Pair | null,
  i: number,
  depth: number,
  prevBlanks: number,
  kIndent?: string,
): readonly string[] {
  const o = pair ? ctx.prov.get(pair.node) : undefined;
  const first = group?.nodes[0];
  let t: readonly string[];
  if (o !== undefined && i === 0 && pair?.node === first) t = o.trivia;
  else {
    let gap: readonly string[];
    if (i === 0) gap = first === undefined ? [] : leadBlanks(ctx.prov.get(first)?.trivia ?? []);
    else if (o !== undefined && pair !== null && !firstItems(ctx.prov, ctx.rootGroup ?? null).has(pair.node)) gap = leadBlanks(o.trivia);
    else gap = blanks(o !== undefined || i === 1 ? spacingOf(group, ctx.prov) : prevBlanks);
    const own = o === undefined ? [] : commentPart(o.trivia);
    t = own.length ? [...gap, ...own] : gap;
  }
  if (o !== undefined && kIndent !== undefined && hasComment(t)) {
    const from = lead(o.indent).col;
    if (lead(kIndent).col !== from) t = reindent(t, from, kIndent);
  }
  return depth === 1 && i === 0 ? t.filter((l) => !isBlankLine(l)) : t;
}

/**
 * R8: a reused item's own lines that followed child `i` go right back after that child's subtree.
 * A segment that opens with a non-blank line which does not interrupt a paragraph relied on the
 * exact last line of the child it followed (a closed fence, an HTML block); when that line was
 * regenerated differently (the child was edited in place), a blank line keeps the segment from
 * being swallowed as the child's lazy continuation (R15 inside the region).
 */
function emitSegment(seg: OwnSegment | null | undefined, out: string[]): void {
  if (!seg) return;
  const first = lead(seg.lines[0] ?? '');
  if (joinsParagraph(first.rest, 0) && out[out.length - 1] !== seg.prev) out.push('');
  out.push(...seg.lines);
}

/** One nesting level of the writer: the children of `parent`, emitted at `depth` (1 = top level). */
interface Level {
  readonly parent: MapNode;
  /** Provenance of the parent's parsed children. */
  readonly group: GroupProvenance | null;
  readonly depth: number;
  /** The parent's indent and content column (the children's indent must land inside its window). */
  readonly pIndent: string;
  readonly pContentCol: number;
  /** A match computed by the caller (the parent needed it to decide its own reuse). */
  readonly match: GroupMatch | undefined;
  /** The parent's own-line segments to emit after each child (reused parents only). */
  readonly after: ReadonlyArray<OwnSegment | null> | undefined;
}

/**
 * Emits the children of `parent` as list lines at `depth` (1 = top level), given the parent's
 * indent and content column and the provenance of the parent's parsed children (`group`).
 *
 * Each nesting level runs as a generator that yields the child levels it needs emitted; this
 * driver keeps those generators on an explicit stack, so a file nested thousands of levels deep is
 * written without a RangeError (the shells rely on the writer never throwing on a parsed tree).
 */
export function emitChildren(
  parent: MapNode,
  group: GroupProvenance | null,
  depth: number,
  pIndent: string,
  pContentCol: number,
  out: string[],
  ctx: EmitContext,
  match?: GroupMatch,
  after?: ReadonlyArray<OwnSegment | null>,
): void {
  const stack: Generator<Level, void, void>[] = [
    emitLevel({ parent, group, depth, pIndent, pContentCol, match, after }, out, ctx),
  ];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const step = top.next();
    if (step.done) stack.pop();
    else stack.push(emitLevel(step.value, out, ctx));
  }
}

function* emitLevel(level: Level, out: string[], ctx: EmitContext): Generator<Level, void, void> {
  const { parent, group, depth, pIndent, pContentCol, match, after } = level;
  const kids = parent.children;
  if (!kids.length) return;
  const st: ListStyle = group?.style ?? ctx.styleOf?.(parent, depth) ?? DEFAULT_STYLE;
  // A child indent is valid when it is whitespace that lands inside the parent's content-column
  // window (CommonMark 5.2), or within 3 columns at the top level.
  const ok = (s: string): boolean => {
    const c = lead(s).col;
    return s.trim() === '' && (depth === 1 ? c <= 3 : c >= pContentCol && c < pContentCol + 4);
  };
  let indent: string;
  if (group?.indent !== undefined && ok(group.indent)) indent = group.indent;
  else if (depth === 1) indent = '';
  else {
    // R5: parent indent + unit, repeated until the column reaches the parent's content column;
    // if that overshoots the window, fall back to spaces up to the content column (ED9).
    indent = pIndent + ctx.unit;
    for (let g = 0; lead(indent).col < pContentCol && g < 8; g++) indent += ctx.unit;
    if (!ok(indent)) indent = ' '.repeat(pContentCol);
  }
  const { pairs, untouched } = match ?? matchGroup(kids, group?.nodes ?? null, ctx);
  const provOf = (p: Pair | null): NodeProvenance | undefined => (p ? ctx.prov.get(p.node) : undefined);
  // R13 refinement (CommonMark 5.2): an ordered list that interrupts the parent's paragraph
  // (no blank line before its first item) must start at 1, or every parser reads it as text.
  const blankBeforeFirst = leadingTrivia(ctx, group, pairs[0] ?? null, 0, depth, 0).some(isBlankLine);
  let start = st.ordered ? (depth >= 2 && !blankBeforeFirst ? 1 : st.start) : 0;
  // CommonMark markers have at most 9 digits (lines.ts MARK): a regenerated group whose numbering
  // would overflow restarts at 1, or the overflowing item is read back as continuation text (R13).
  if (st.ordered && start + kids.length - 1 > 999_999_999) start = 1;
  let prevBlanks = 0;

  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid === undefined) continue;
    const pair = pairs[i] ?? null;
    const o = provOf(pair);
    // R6/R13: an untouched group keeps each item's own marker and indent (mixed bullets, odd
    // numbering); a touched group is normalised to the group's style.
    let marker = st.ordered ? `${start + i}${st.delim}` : st.ch;
    let kIndent = indent;
    if (untouched && o) {
      marker = o.marker;
      if (ok(o.indent)) kIndent = o.indent;
    }
    const ch = /^\d/.test(marker) ? null : marker;
    const fold = !!kid.collapsed && ctx.folds;
    // R16 (refined, see leadingTrivia): an item keeps its leading trivia, the blank lines before the
    // first item stay with that slot, a new item copies the spacing of the list; the first top-level
    // item has none because the region starts at its marker line.
    const trivia = leadingTrivia(ctx, group, pair, i, depth, prevBlanks, kIndent);
    out.push(...trivia);
    prevBlanks = trivia.filter(isBlankLine).length;

    const body = bodyOf(kid, pair, o, ctx);
    // R12 refinement: the first item of EVERY group (depth 1 too) gets the placeholder when
    // empty; a bare '-' right after any paragraph (an intro line, the parent's text) is a setext
    // underline. A hand-typed bare '-' is rewritten only when its group is touched or the item
    // itself is regenerated (R12/R6): an untouched group keeps the user's bytes.
    const firstChildEmpty = i === 0;
    const childGroup = o ? o.children : null;
    let childMatch: GroupMatch | undefined;
    let reuse =
      o !== undefined &&
      o.text === kid.text &&
      o.body === body &&
      o.collapsed === fold &&
      o.indent === kIndent &&
      o.marker === marker &&
      !(!untouched && kid.text === '' && firstChildEmpty && o.bareEmpty);
    if (reuse && o && o.rawAfter.some((s) => s !== null)) {
      // Own lines that follow the children are re-emitted in place only while the children group
      // keeps its membership and order: a normalised group could change a child's content column
      // and make the parent's trailing body a continuation of that child.
      childMatch = matchGroup(kid.children, childGroup?.nodes ?? null, ctx);
      if (!childMatch.untouched) reuse = false;
    }
    if (reuse && o) {
      out.push(...o.raw);
      yield {
        parent: kid,
        group: childGroup,
        depth: depth + 1,
        pIndent: kIndent,
        pContentCol: o.contentCol,
        match: childMatch,
        after: o.rawAfter,
      };
      emitSegment(after?.[i], out);
      continue;
    }

    // Regenerate the item: text lines (R7, escaped per R10), then the body (R8), then children.
    const esc = normalizeText(kid.text).map((l, j) => escapeLine(l, j === 0, ch));
    const lastIdx = esc.length - 1;
    if (lastIdx >= 0) esc[lastIdx] = escapeFoldSuffix(esc[lastIdx] ?? '');
    if (fold) {
      if (lastIdx >= 0) esc[lastIdx] = (esc[lastIdx] ?? '') + ' ' + FOLD;
      else esc.push(FOLD);
    }
    const cont = kIndent + ' '.repeat(marker.length + 1);
    const contentCol = lead(kIndent).col + marker.length + 1;
    const segments = o !== undefined && o.rawAfter.some((s) => s !== null);
    // R6/R8: an item whose text (or fold suffix, or number) changed but whose columns and note did not
    // writes only its new text lines: its own lines after the text (the note with its own indentation,
    // blank lines, code...) go out verbatim, and the lines that followed a child go back after that child
    // while the children group is untouched, so a paragraph between two children never moves above them.
    // The old text was not empty, so nothing after it could continue its paragraph, and nothing can
    // continue the new one either (only interrupting blocks or blank lines followed it).
    if (
      o !== undefined &&
      esc.length > 0 &&
      o.text !== '' &&
      o.textEnd > 0 &&
      body === o.body &&
      contentCol === o.contentCol &&
      lead(kIndent).col === lead(o.indent).col
    ) {
      if (segments) childMatch ??= matchGroup(kid.children, childGroup?.nodes ?? null, ctx);
      if (!segments || childMatch?.untouched === true) {
        out.push(kIndent + marker + ' ' + (esc[0] ?? ''));
        for (const l of esc.slice(1)) out.push(cont + l);
        out.push(...o.raw.slice(o.textEnd));
        yield {
          parent: kid,
          group: childGroup,
          depth: depth + 1,
          pIndent: kIndent,
          pContentCol: contentCol,
          match: childMatch,
          after: o.rawAfter,
        };
        emitSegment(after?.[i], out);
        continue;
      }
    }
    const bodyLines = body !== undefined && body !== '' ? body.replace(/\r\n?/g, '\n').split('\n') : [];
    while (bodyLines.length && (bodyLines[bodyLines.length - 1] ?? '').trim() === '') bodyLines.pop();
    let first: string;
    if (esc.length) {
      first = ' ' + (esc[0] ?? '');
      // R8: a body whose first line would continue the text's paragraph (a plain line that followed
      // a placeholder or a link reference definition, indented code, a setext-looking line) gets a
      // blank line first, so the reader gives text and body back instead of one merged text.
      // Blocks that interrupt a paragraph (fences, quotes, headings, HTML 1-6) stay as they were.
      const b0 = lead(bodyLines[0] ?? '');
      if (bodyLines.length && joinsParagraph(b0.rest, b0.col)) bodyLines.unshift('');
    } else if (bodyLines.length && (bodyLines[0] ?? '').trim() !== '') {
      // R8: a body that starts right on the marker line (a fence, quote, heading or HTML block: the
      // only way the reader gives an item text '' and a body without a leading blank line) goes
      // back there, where the reader reads it as a first-line block again.
      first = ' ' + (bodyLines.shift() ?? '');
    } else if (bodyLines.length) {
      // The text was emptied while a paragraph body (blank line first) remains: the placeholder
      // keeps the item non-empty, so CommonMark keeps the paragraph inside it (an empty item ends
      // at the blank line) and the reader gives text '' + body back instead of promoting the
      // paragraph to the node text (R8/R12).
      first = ' <!-- -->';
    } else {
      // R12 refinement: an empty item whose first child is preceded by a blank line also needs
      // the placeholder. A bare marker followed by a blank line is an empty item that CommonMark
      // closes ("a list item can begin with at most one blank line"), and the indented children
      // would then become an indented code block.
      let placeholder = firstChildEmpty;
      if (!placeholder && kid.children.length) {
        childMatch ??= matchGroup(kid.children, childGroup?.nodes ?? null, ctx);
        placeholder = leadingTrivia(ctx, childGroup, childMatch.pairs[0] ?? null, 0, depth + 1, 0).some(isBlankLine);
      }
      first = placeholder ? ' <!-- -->' : '';
    }
    out.push(kIndent + marker + first);
    for (const l of esc.slice(1)) out.push(cont + l);
    for (const b of bodyLines) out.push(b.trim() === '' ? '' : cont + b);
    if (segments) {
      // The lines that followed a child are written with the body, before the children: a child that sat
      // deeper than the one before it was its sibling only because such a paragraph closed that one, so the
      // children are normalised to one indent (the group counts as touched) or it would be read back under it.
      childMatch ??= matchGroup(kid.children, childGroup?.nodes ?? null, ctx);
      if (childMatch.untouched) childMatch = { pairs: childMatch.pairs, untouched: false };
    }
    yield {
      parent: kid,
      group: childGroup,
      depth: depth + 1,
      pIndent: kIndent,
      pContentCol: contentCol,
      match: childMatch,
      after: undefined,
    };
    emitSegment(after?.[i], out);
  }
}

/**
 * R15: true when the line right after the region could be swallowed as a lazy continuation of
 * the last item (non-blank, and not a block start of its own).
 */
function needsGap(post: string): boolean {
  const m = /^\r?\n([^\r\n]*)/.exec(post);
  if (!m) return false;
  const line = m[1] ?? '';
  const L = lead(line);
  if (L.rest === '') return false;
  return !(
    L.col <= 3 &&
    (/^#{1,6}(?:[ \t]|$)/.test(L.rest) ||
      RE.thematic.test(L.rest) ||
      RE.fence.test(L.rest) ||
      RE.quote.test(L.rest) ||
      RE.html1to6.test(L.rest) ||
      markerAt(line))
  );
}

/** Full writer with an explicit emit context (the public entry points build the context). */
export function serializeWith(doc: MapDocument, root: MapNode, ctx: EmitContext): string {
  const { eol, source: src, bom } = doc;
  // An unchanged empty tree is the unchanged file, whatever the root object's identity: '' (or a
  // whitespace-only file) stays as it is until the user adds a node or renames the root, so an
  // editor that rebuilds its root never turns "open" into a write (R14 applies to the first node).
  if (root.text === doc.root.text && root.children.length === 0 && doc.root.children.length === 0) return bom + src;
  const out: string[] = [];
  emitChildren(root, doc.provenance.rootChildren, 1, '', 0, out, ctx);
  const list = out.join(eol);
  const headLine = headingLine(root.text);
  const rootChanged = root.text !== doc.root.text;
  // R14: an empty or whitespace-only file becomes '# <basename>' EOL EOL list EOL.
  if (src.trim() === '') return bom + headLine + eol + (list ? eol + list + eol : '');

  const { map, head, bodyStart, insertAt } = doc.layout;
  const at = map ? map.start : insertAt;
  const atEnd = map ? map.end : insertAt;
  let pre = src.slice(0, at);
  const post = src.slice(atEnd);
  if (rootChanged && head) {
    pre = src.slice(0, head.start) + headLine + src.slice(head.end, at);
  } else if (rootChanged) {
    // R3: renaming a virtual root inserts the H1 (and a blank line) at the start of the body.
    pre = src.slice(0, bodyStart) + (bodyStart ? eol + headLine + eol : headLine + eol + eol) + src.slice(bodyStart, at);
  }
  if (!list) {
    if (!map) return bom + pre + post;
    // R14: removing the region collapses the blank lines around it into one (or into the final
    // newline, keeping its presence or absence).
    const b = trimEndBlankLines(pre);
    const a = post.replace(/^(?:[ \t]*\r?\n)+/, '');
    if (!b) return bom + a;
    if (!a) return bom + b + (doc.finalNewline ? eol : '');
    return bom + b + eol + eol + a;
  }
  if (map) {
    // R15 guards a REGENERATED last line, whose new shape could swallow the next line as a lazy
    // continuation. A last line re-emitted verbatim leaves the file's own relationship with the
    // line after it alone (a root rename or an edit elsewhere must not add a blank line there).
    const lastLineStart = src.lastIndexOf('\n', map.end - 1) + 1;
    const lastRegenerated = (out[out.length - 1] ?? '') !== src.slice(lastLineStart, map.end);
    return bom + pre + list + (lastRegenerated && needsGap(post) ? eol : '') + post;
  }
  // R14: a first list goes after the intro section as EOL EOL list, plus one EOL when non-blank
  // content follows. A `pre` sliced from the source never ends with an EOL (the insert point is a
  // line end); only the H1 inserted for a renamed virtual root does, so those EOLs are stripped
  // before the single blank line is added. When the insert point is the very start of the body
  // (the file opens with a heading line) `post` starts with that line's text, not with an EOL, and
  // the list needs a whole blank line after it or the heading is glued onto the last item.
  if (pre === '') return bom + list + eol + (/^[ \t]*\r?\n/.test(post) || post === '' ? '' : eol) + post;
  const before = trimEndLineBreaks(pre);
  const after = post === '' ? '' : /^\r?\n/.test(post) ? (/^\r?\n[ \t]*\S/.test(post) ? eol : '') : eol + eol;
  return bom + before + eol + eol + list + after + post;
}

/**
 * Serialises `root` into the file `doc` was parsed from. Returns the input byte for byte when
 * `root` is `doc.root`; otherwise regenerates only the H1 line (if the root text changed) and the
 * list region, re-emitting every unchanged node's raw lines (R2/R6).
 *
 * `opts.keyOf` (LINEAGE): an editor with stable node ids that survive its path copies passes them, and
 * every node is then matched with the parsed node it descends from, wherever it is now; without it the
 * writer falls back to identity, spread copies, texts and positions (pairing.ts).
 */
export function serializeDocument(doc: MapDocument, root: MapNode, opts: SerializeOptions = {}): string {
  if (root === doc.root && opts.indentUnit === undefined && opts.folds === undefined) return doc.bom + doc.source;
  const prov = doc.provenance.nodes;
  const keyOf = opts.keyOf;
  let parsedByKey: Map<string, MapNode> | undefined;
  if (keyOf !== undefined) {
    parsedByKey = new Map();
    for (const node of prov.keys()) {
      const key = keyOf(node);
      if (key !== undefined && !parsedByKey.has(key)) parsedByKey.set(key, node);
    }
  }
  const { alive, anyKnown } = liveParsed(root, prov, keyOf, parsedByKey);
  return serializeWith(doc, root, {
    unit: opts.indentUnit ?? doc.indentUnit,
    folds: opts.folds ?? doc.foldsInFile,
    prov,
    alive,
    ...(keyOf !== undefined && parsedByKey !== undefined ? { keyOf, parsedByKey } : {}),
    inheritByText: keyOf === undefined && prov.size > 0 && !anyKnown,
    rootGroup: doc.provenance.rootChildren,
  });
}

const isNode = (x: MapNode | readonly MapNode[]): x is MapNode => !Array.isArray(x);

/**
 * A canonical list (R5) for the given node(s) as top-level items: one TAB per level by default,
 * `- ` markers, no fold suffixes unless asked. Meant for the clipboard; no trailing newline.
 */
export function serializeList(nodes: MapNode | readonly MapNode[], opts: ListOptions = {}): string {
  const list: readonly MapNode[] = isNode(nodes) ? [nodes] : nodes;
  const out: string[] = [];
  emitChildren({ text: '', children: list }, null, 1, '', 0, out, {
    unit: opts.indentUnit ?? '\t',
    folds: opts.folds ?? false,
    prov: NO_PROVENANCE,
  });
  return out.join(opts.eol ?? '\n');
}
