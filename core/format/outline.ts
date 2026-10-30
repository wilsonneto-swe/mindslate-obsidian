/**
 * Pasted text -> nodes. Three shapes are accepted:
 *  - a Markdown list (the first non-blank line is a list item): read with the file reader, so
 *    mixed markers, numbers, continuation lines and escapes behave exactly as in a file; any
 *    lines left after the list are appended as a plain outline;
 *  - a document starting with an H1: one node (the heading) with the map as its children;
 *  - anything else: a plain outline, one node per non-blank line, nesting by indentation column,
 *    an optional marker stripped, the text taken literally.
 *
 * A marker is only an ordered one when a Markdown reader would start a list with it in pasted
 * prose: its number is 0 or 1, or it continues the previous sibling's number at the same column
 * (CommonMark 5.2: an ordered list that interrupts a paragraph must start at 1). "2026. Plan" or
 * "12. 50" pasted as plain text keep their numbers; "1. a / 2. b" is still a list.
 */
import { lead, markerAt, splitLines, type Marker } from './lines.js';
import { parseDocument, parseItems } from './parse.js';
import { trimEndBlank } from './trim.js';
import type { MapNode } from './types.js';

interface Acc {
  readonly col: number;
  readonly text: string;
  /** The ordered number stripped from this line, or null (bullet, or no marker). */
  readonly num: number | null;
  readonly kids: Acc[];
}

/** An ordered marker that opens a list on its own: `1.`, `1)` or `0.` (CommonMark 5.2). */
const startsList = (mk: Marker): boolean => mk.num !== null && Number(mk.num) <= 1;

function plainOutline(lines: readonly string[]): MapNode[] {
  const root: Acc = { col: -1, text: '', num: null, kids: [] };
  const stack: Acc[] = [root];
  for (const line of lines) {
    const L = lead(line);
    if (L.rest === '') continue;
    while (stack.length > 1 && (stack[stack.length - 1]?.col ?? -1) >= L.col) stack.pop();
    const parent = stack[stack.length - 1] ?? root;
    const prev = parent.kids[parent.kids.length - 1];
    const mk = markerAt(line);
    let text = L.rest;
    let num: number | null = null;
    if (mk && mk.num === null) {
      text = mk.content;
    } else if (mk) {
      const n = Number(mk.num);
      const continues = prev !== undefined && prev.num !== null && prev.col === L.col && prev.num + 1 === n;
      if (startsList(mk) || continues) {
        text = mk.content;
        num = n;
      }
    }
    const node: Acc = { col: L.col, text: trimEndBlank(text), num, kids: [] };
    parent.kids.push(node);
    stack.push(node);
  }
  const build = (a: Acc): MapNode => Object.freeze({ text: a.text, children: Object.freeze(a.kids.map(build)) });
  return root.kids.map(build);
}

export function parseOutline(text: string): MapNode[] {
  const norm = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/^([ \t]*)•[ \t]+/gm, '$1- ');
  const lines = splitLines(norm);
  const first = lines.findIndex((l) => lead(l.text).rest !== '');
  if (first < 0) return [];
  const firstText = lines[first]?.text ?? '';
  const L = lead(firstText);
  const mk = L.col <= 3 ? markerAt(firstText) : null;
  // A pasted list is read with the file reader, unless its first marker is an ordered one that no
  // reader would start a list with in prose ("2026. Plan"): then the whole paste is plain text.
  if (mk && (mk.num === null || startsList(mk))) {
    const items = parseItems(lines, first);
    return [...items.children, ...plainOutline(lines.slice(items.last + 1).map((l) => l.text))];
  }
  if (L.col <= 3 && /^#(?:[ \t]|$)/.test(L.rest)) {
    const doc = parseDocument(norm, { basename: '' });
    if (!doc.virtualRoot) return [Object.freeze({ text: doc.root.text, children: doc.root.children })];
  }
  return plainOutline(lines.slice(first).map((l) => l.text));
}
