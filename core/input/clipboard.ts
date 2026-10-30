/**
 * Clipboard helpers: a subtree -> Markdown list (Mod+C / Mod+X), and pasted text -> nodes (Mod+V).
 * The format layer does the real work (serializeList, parseOutline); this module is the gate that
 * decides whether a pasted text IS an outline or should become one node holding the text.
 */
import { parseOutline, serializeList } from '../format/index.js';
import type { MapNode } from '../format/types.js';

/** '- text' lines, one TAB per extra level, the given node as the first line, one trailing newline. */
export function subtreeToMarkdown(node: MapNode): string {
  return serializeList(node) + '\n';
}

/**
 * Several subtrees (the top-level nodes of a multi-selection, in document order) as ONE Markdown list: each
 * node a top-level item with its subtree under it, one trailing newline. Pasted, it gives the same nodes back.
 */
export function subtreesToMarkdown(nodes: readonly MapNode[]): string {
  return nodes.length === 0 ? '' : serializeList(nodes) + '\n';
}

const MARK = /^[ \t]*(?:[-*+•]|\d{1,9}[.)])(?:[ \t]+|$)/;

/**
 * True when `text` looks like a list or an outline: a line with a bullet / number marker, or at least
 * two non-blank lines with indentation. Anything else (a word, a sentence, a paragraph) pastes as one node.
 */
export function looksLikeOutline(text: string): boolean {
  const nonEmpty = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (!nonEmpty.length) return false;
  const hasMarker = nonEmpty.some((l) => MARK.test(l));
  const indented = nonEmpty.some((l) => /^[ \t]/.test(l));
  return hasMarker || (nonEmpty.length >= 2 && indented);
}

/**
 * The nodes a pasted text stands for (plain parsed nodes, no ids yet, no body keys), or null when the
 * text is not an outline and the caller pastes it as ONE node. `•` bullets count as `-`.
 */
export function parseClipboard(text: string): MapNode[] | null {
  if (!text || !looksLikeOutline(text)) return null;
  const norm = text.replace(/\r\n?/g, '\n').replace(/^([ \t]*)•[ \t]+/gm, '$1- ');
  const nodes = parseOutline(norm);
  return nodes.length ? nodes : null;
}

/** The one-node fallback: CRLF normalised, trailing newlines dropped. */
export function pasteAsOneNodeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}
