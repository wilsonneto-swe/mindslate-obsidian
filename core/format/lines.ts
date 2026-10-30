/**
 * Line primitives shared by the reader and the writer: splitting that keeps byte offsets,
 * tab-aware column math (tab stops of 4, as CommonMark and Obsidian) and list-marker detection
 * (R18).
 */
import { RE } from './escape.js';

export interface Line {
  /** Line text without its line ending. */
  readonly text: string;
  /** Offset of the first character. */
  readonly start: number;
  /** Offset right after the last text character (before `\r\n` / `\n`). */
  readonly end: number;
}

/** Splits on `\n`, dropping a `\r` right before it. The last line may be empty (final newline). */
export function splitLines(src: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl < 0 ? src.length : nl;
    const textEnd = end > pos && src.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
    out.push({ text: src.slice(pos, textEnd), start: pos, end: textEnd });
    pos = nl < 0 ? src.length : nl + 1;
  }
  return out;
}

export interface Lead {
  /** Column after the leading whitespace (tabs advance to the next multiple of 4). */
  readonly col: number;
  /** Number of leading whitespace characters. */
  readonly len: number;
  /** The text after the leading whitespace. */
  readonly rest: string;
}

export function lead(text: string): Lead {
  let col = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20) col++;
    else if (c === 0x09) col += 4 - (col % 4);
    else break;
    i++;
  }
  return { col, len: i, rest: text.slice(i) };
}

/** Removes up to `n` columns of leading whitespace; a tab that overshoots is split into spaces. */
export function stripCols(text: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < text.length && col < n) {
    const c = text.charCodeAt(i);
    if (c === 0x20) {
      col++;
      i++;
      continue;
    }
    if (c !== 0x09) break;
    const nc = col + 4 - (col % 4);
    if (nc > n) return ' '.repeat(nc - n) + text.slice(i + 1);
    col = nc;
    i++;
  }
  return text.slice(i);
}

export interface Marker {
  /** Column of the marker. */
  readonly indentCol: number;
  /** The leading whitespace as written. */
  readonly indent: string;
  /** `-`, `+`, `*`, `12.` or `12)`. */
  readonly marker: string;
  /** Digits of an ordered marker, or null for bullets. */
  readonly num: string | null;
  /** `.` or `)` for ordered markers, or null. */
  readonly delim: string | null;
  /** Column where the item's content starts (marker + 1..4 spaces, else marker + 1). */
  readonly contentCol: number;
  /** Text after the marker and its spacing. */
  readonly content: string;
}

/** CommonMark list markers: bullets, or 1-9 digits followed by `.` or `)`. */
const MARK = /^([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)/;

/** Detects a list item marker at the start of a line (a thematic break is not a marker). */
export function markerAt(text: string): Marker | null {
  const L = lead(text);
  if (RE.thematic.test(L.rest)) return null;
  const m = MARK.exec(L.rest);
  if (!m) return null;
  const marker = m[1] ?? '';
  let col = L.col + marker.length;
  let i = L.len + marker.length;
  const markEnd = col;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20) col++;
    else if (c === 0x09) col += 4 - (col % 4);
    else break;
    i++;
  }
  const content = text.slice(i);
  // CommonMark 5.2: 1-4 spaces after the marker belong to it; an empty item or 5+ spaces
  // (indented code inside the item) put the content column right after the marker + 1 space.
  const contentCol = content === '' || col - markEnd > 4 ? markEnd + 1 : col;
  return {
    indentCol: L.col,
    indent: text.slice(0, L.len),
    marker,
    num: m[2] ?? null,
    delim: m[3] ?? null,
    contentCol,
    content,
  };
}
