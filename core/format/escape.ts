/**
 * Line-start escaping for node text (R10) plus the fold-suffix (R10f) and root-text (R3) escapes.
 *
 * escapeLine(line, first, bulletChar) adds exactly one backslash when the line would otherwise
 * start a block inside its list item; unescapeLine removes exactly one under the same tests, so
 * the pair is bijective (R10e). The regular expressions follow the CommonMark block-start rules;
 * `obsBlock` and `ordered` are refinements found while testing against markdown-it and legacy
 * remark (see the prototype report: an unescaped `%%` line hides every later node in Obsidian,
 * and legacy remark accepts ordered markers with 10+ digits).
 *
 * LINEAR: every test here runs in time linear in the line's length. A file is not always the user's own (the web
 * page opens a GitHub file from a share link as it loads), and an expression that backtracks over a long crafted
 * line would freeze the page: the link reference definition test and the fold suffix are therefore decided by
 * hand-written scans that accept exactly the lines their original expressions matched (fuzz.test.ts FZ5).
 */
import { trimEndBlank } from './trim.js';

const HTML6 =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

export const RE = {
  bullet: /^[-+*](?:[ \t]|$)/,
  atx: /^#{1,6}(?:[ \t]|$)/,
  quote: /^>/,
  fence: /^(?:`{3,}|~{3,})/,
  thematic: /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  dashRun: /^-(?:[ \t]*-)+[ \t]*$/,
  starRun: /^\*(?:[ \t]*\*)+[ \t]*$/,
  html1to6: new RegExp(
    `^(?:<(?:script|pre|style|textarea)(?:[ \\t>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|</?(?:${HTML6})(?:[ \\t>]|/>|$))`,
    'i',
  ),
  html7:
    /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/,
  setext: /^(?:=+|-+)[ \t]*$/,
  tableDelimPrefix: /^\|?[ \t]*:?-+:?[ \t]*\|/,
  delimOnly: /^(?=[^|]*\|)(?=[^-]*-)[-:| \t]+$/,
  footnoteDef: /^\[\^[^\]\s]+\]:/,
  /**
   * A table delimiter row. LINEAR: the blanks between cells belong to the pipe that follows them, so a long run of
   * blanks is read once (the same lines as `/^(?=.*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$|.../`,
   * which split such a run between two `[ \t]*` in every way: quadratic, fuzz.test.ts FZ5).
   */
  tableDelim: /^(?=.*\|)\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*(?:[ \t]*\|)?[ \t]*$|^:?-+:?[ \t]*\|[ \t]*:?-+:?/,
  /** Obsidian block comments / math blocks start at line start (refinement of R10b). */
  obsBlock: /^(?:%%|\$\$)/,
  /** Any digit count: legacy remark (Obsidian Reading view) accepts 10+ digit markers (R10a). */
  ordered: /^(\d+)(\\*)([.)])(.*)$/,
} as const;

/** JavaScript's `\s`: white space and line terminators (one UTF-16 code unit). */
const isSpace = (c: number): boolean =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;
/** What `.` does not match without the s flag: the line terminators. */
const isLineTerminator = (c: number): boolean => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

// the states linkDefStart can be in (a bit set): between the escapes and plain characters of the label before (A)
// or after (B) its one required non-space character, or right after the "\" of an escape there (A_ESC, B_ESC)
const A = 1;
const A_ESC = 2;
const B = 4;
const B_ESC = 8;

/**
 * R10c: does `s` start like a link reference definition, "[label]:"? Exactly the lines that
 * `/^\[(?:[^\]\\]|\\.)*\S(?:[^\]\\]|\\.)*\]:/` matches: a label of escapes ("\" and any character) and characters
 * other than "]" and "\", around ONE character that is not white space (which may itself be a "]" or a lone "\"),
 * then "]:". That expression backtracks quadratically on a long line that starts with "[" and has no "]:" (LINEAR);
 * this follows every way it could match at once, one character at a time.
 */
export function linkDefStart(s: string): boolean {
  if (s.charCodeAt(0) !== 0x5b) return false;
  let st = A;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((st & B) !== 0 && c === 0x5d && s.charCodeAt(i + 1) === 0x3a) return true; // "]:" after the non-space character
    const plain = c !== 0x5d && c !== 0x5c;
    let next = 0;
    if ((st & A) !== 0) {
      if (plain) next |= A;
      else if (c === 0x5c) next |= A_ESC;
      if (!isSpace(c)) next |= B; // this character is the non-space one
    }
    if ((st & A_ESC) !== 0 && !isLineTerminator(c)) next |= A;
    if ((st & B) !== 0) {
      if (plain) next |= B;
      else if (c === 0x5c) next |= B_ESC;
    }
    if ((st & B_ESC) !== 0 && !isLineTerminator(c)) next |= B;
    if (next === 0) return false;
    st = next;
  }
  return false;
}

function leadingBackslashes(s: string): number {
  let k = 0;
  while (k < s.length && s.charCodeAt(k) === 0x5c) k++;
  return k;
}

const group = (m: RegExpExecArray, i: number): string => m[i] ?? '';

/** R10b (every line), R10c (first line only) and R10d (continuation lines only). */
function needsPrepend(s: string, first: boolean, bulletChar: string | null): boolean {
  if (
    RE.bullet.test(s) ||
    RE.atx.test(s) ||
    RE.quote.test(s) ||
    RE.fence.test(s) ||
    RE.thematic.test(s) ||
    RE.html1to6.test(s) ||
    RE.tableDelimPrefix.test(s) ||
    RE.delimOnly.test(s) ||
    RE.obsBlock.test(s)
  ) {
    return true;
  }
  if (first) {
    // `- - -` after a `- ` marker is a thematic break (same for `*`), a lone complete tag is an
    // HTML block of type 7, and `[x]: url` is a link reference definition.
    return (
      (bulletChar === '-' && RE.dashRun.test(s)) ||
      (bulletChar === '*' && RE.starRun.test(s)) ||
      RE.html7.test(s) ||
      linkDefStart(s)
    );
  }
  return RE.setext.test(s) || RE.tableDelim.test(s) || RE.footnoteDef.test(s);
}

/** An ordered marker only counts when followed by whitespace or the end of the line (R10a). */
const orderedBlock = (rest: string): boolean => rest === '' || /^[ \t]/.test(rest);

/**
 * Escape one line of node text. `first` is true for the node's first line; `bulletChar` is the
 * group's bullet character, or null for ordered groups (then no dash/star-run check applies).
 */
export function escapeLine(line: string, first: boolean, bulletChar: string | null = '-'): string {
  const m = RE.ordered.exec(line);
  if (m && orderedBlock(group(m, 4))) return group(m, 1) + '\\' + group(m, 2) + group(m, 3) + group(m, 4);
  const k = leadingBackslashes(line);
  return needsPrepend(line.slice(k), first, bulletChar) ? '\\' + line : line;
}

/** Inverse of escapeLine: removes exactly one backslash under the same tests (R10e). */
export function unescapeLine(line: string, first: boolean, bulletChar: string | null = '-'): string {
  const m = RE.ordered.exec(line);
  if (m && group(m, 2).length >= 1 && orderedBlock(group(m, 4))) {
    return group(m, 1) + group(m, 2).slice(1) + group(m, 3) + group(m, 4);
  }
  const k = leadingBackslashes(line);
  return k >= 1 && needsPrepend(line.slice(k), first, bulletChar) ? line.slice(1) : line;
}

/** The fold comment (markmap convention) from its `<!--` to the end of the line. */
const FOLD_TAIL = /^<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->[ \t]*$/;

/**
 * The fold suffix of a line: where it starts (the backslashes right before its `<` included) and how many there are,
 * or null. Exactly what `/(\\*)<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->[ \t]*$/` finds (its index and group 1),
 * whose scan from every position of a long run of backslashes is quadratic (LINEAR): the comment runs to the end
 * of the line and holds no `<` after its first character, so it can only start at the line's last `<!--`.
 */
function foldSuffix(line: string): { readonly at: number; readonly slashes: number } | null {
  const lt = line.lastIndexOf('<!--');
  if (lt < 0 || !FOLD_TAIL.test(line.slice(lt))) return null;
  let at = lt;
  while (at > 0 && line.charCodeAt(at - 1) === 0x5c) at--;
  return { at, slashes: lt - at };
}

/** A literal fold-looking suffix in text gets one more backslash before `<` (R10f). */
export function escapeFoldSuffix(line: string): string {
  const f = foldSuffix(line);
  return f ? line.slice(0, f.at) + '\\' + line.slice(f.at) : line;
}

/** Reads the raw last line of an item: a backslash-free suffix means collapsed (R10f). */
export function readFoldSuffix(line: string): { text: string; fold: boolean } {
  const f = foldSuffix(line);
  if (!f) return { text: line, fold: false };
  if (f.slashes === 0) return { text: trimEndBlank(line.slice(0, f.at)), fold: true };
  return { text: line.slice(0, f.at) + line.slice(f.at + 1), fold: false };
}

/**
 * Root (ATX H1) text (R3): newlines become spaces, the text is trimmed, and a trailing `#` run
 * preceded by start-of-text or whitespace (which would be a closing sequence) gets one backslash,
 * counting the backslashes already there: 'C #' -> 'C \#', 'C \#' -> 'C \\#'.
 */
export function escapeRoot(text: string): string {
  // each run of white space that holds a line break becomes one space (`/\s*\n\s*/g` in one pass: LINEAR)
  const s = text.replace(/\s+/g, (ws) => (ws.includes('\n') ? ' ' : ws)).trim();
  const m = /(^|[ \t])(\\*)(#+)$/.exec(s);
  return m ? s.slice(0, m.index + group(m, 1).length) + '\\' + group(m, 2) + group(m, 3) : s;
}

export function unescapeRoot(s: string): string {
  const m = /(^|[ \t])\\(\\*)(#+)$/.exec(s);
  return m ? s.slice(0, m.index + group(m, 1).length) + group(m, 2) + group(m, 3) : s;
}
