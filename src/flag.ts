/**
 * FLAG: the frontmatter line `mindslate: map` (constants.ts FLAG_KEY, FLAG_VALUE) makes a note open as a mind map
 * everywhere (auto-open.ts). The plugin writes and removes it with a MINIMAL text edit (FLAG-MINIMAL): one line is
 * inserted, replaced or deleted, and the `---` block around it is created only for a note that has none and removed only
 * when the flag was all it held. Every other byte of the note stays as it was: the other keys and their order, comments,
 * blank lines, line endings (a new line takes the block's own, or the note's), a BOM, the text after the block. Opening
 * a note as a map never writes it; only the "Always open this note as a mind map" toggle does, through vault.process.
 *
 * The block is found the way Obsidian finds properties (getFrontMatterInfo): the note starts with a `---` line and a
 * later line that is exactly `---` closes it. A leading BOM is looked past and kept.
 */
import { FLAG_KEY, FLAG_VALUE } from './constants.js';

const BOM = '\uFEFF';

/** One line of a text with its own line ending ('' for a last line without one). */
interface Line {
  readonly text: string;
  readonly eol: string;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) {
      out.push({ text: text.slice(pos), eol: '' });
      break;
    }
    const cr = nl > pos && text[nl - 1] === '\r';
    out.push({ text: text.slice(pos, cr ? nl - 1 : nl), eol: cr ? '\r\n' : '\n' });
    pos = nl + 1;
  }
  return out;
}

const join = (lines: readonly Line[]): string => lines.map((l) => l.text + l.eol).join('');

/** The frontmatter block: line 0 opens it, `close` closes it (inner lines between), or null when there is none. */
function block(lines: readonly Line[]): { readonly close: number } | null {
  const first = lines[0];
  if (first === undefined || first.text !== '---' || first.eol === '') return null;
  for (let i = 1; i < lines.length; i++) if (lines[i]?.text === '---') return { close: i };
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A top-level line of the key (quoted or not): `mindslate: map`, `"mindslate": map`. */
const KEY_LINE = new RegExp(`^(?:${escapeRe(FLAG_KEY)}|"${escapeRe(FLAG_KEY)}"|'${escapeRe(FLAG_KEY)}')[ \\t]*:(?:[ \\t]|$)`);
/** A line that continues the value above it (a block scalar or a list under the key): indented, or empty. */
const continues = (l: Line): boolean => /^[ \t]/.test(l.text);

/** The YAML scalar of a key line: quotes and a trailing comment removed. */
function scalarOf(line: string): string {
  let v = line.slice(line.indexOf(':') + 1).trim();
  if ((v.startsWith('"') && v.includes('"', 1)) || (v.startsWith("'") && v.includes("'", 1))) return v.slice(1, v.indexOf(v[0] ?? '', 1));
  const hash = v.search(/[ \t]#/);
  if (hash >= 0) v = v.slice(0, hash).trimEnd();
  return v;
}

/** The inner lines of the key (its line and the lines that continue its value), as [start, end) indices. */
function keyRanges(lines: readonly Line[], close: number): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let i = 1; i < close; i++) {
    if (!KEY_LINE.test(lines[i]?.text ?? '')) continue;
    let end = i + 1;
    while (end < close && continues(lines[end] as Line)) end++;
    out.push([i, end]);
    i = end - 1;
  }
  return out;
}

/** The note's text without its BOM, and the BOM. */
function unBom(text: string): { readonly bom: string; readonly body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text };
}

/** The value written for the flag in the note's frontmatter (the first one), or null when the note has none. */
export function flagValue(text: string): string | null {
  const lines = splitLines(unBom(text).body);
  const b = block(lines);
  if (b === null) return null;
  const first = keyRanges(lines, b.close)[0];
  return first === undefined ? null : scalarOf(lines[first[0]]?.text ?? '');
}

/** The note opens as a map: its frontmatter says `mindslate: map`. */
export function hasFlag(text: string): boolean {
  return flagValue(text) === FLAG_VALUE;
}

/** The flag in parsed frontmatter (Obsidian's metadata cache): what auto-open decides on. */
export function flaggedIn(frontmatter: unknown): boolean {
  return typeof frontmatter === 'object' && frontmatter !== null && (frontmatter as Record<string, unknown>)[FLAG_KEY] === FLAG_VALUE;
}

/** The line ending a new line takes: the note's first one, else LF. */
function eolOf(lines: readonly Line[]): string {
  return lines.find((l) => l.eol !== '')?.eol ?? '\n';
}

/**
 * The note with the flag on or off (FLAG-MINIMAL). On: a note without frontmatter gets the block `---`, the flag, `---`
 * on top; a block without the key gets the flag as its last line; a key with another value gets its line replaced (with
 * the lines that continued that value). Off: the key's lines go, and the block with them when nothing else is left in
 * it. A note that already is as asked comes back as the very same string.
 */
export function setFlag(text: string, on: boolean): string {
  const { bom, body } = unBom(text);
  const lines = splitLines(body);
  const b = block(lines);
  const flagLine = `${FLAG_KEY}: ${FLAG_VALUE}`;
  if (b === null) {
    if (!on) return text;
    const eol = eolOf(lines);
    return bom + `---${eol}${flagLine}${eol}---${eol}` + body;
  }
  const ranges = keyRanges(lines, b.close);
  const first = ranges[0];
  if (on) {
    if (first !== undefined) {
      if (scalarOf(lines[first[0]]?.text ?? '') === FLAG_VALUE && first[1] === first[0] + 1) return text;
      const eol = lines[first[0]]?.eol ?? '\n';
      return bom + join([...lines.slice(0, first[0]), { text: flagLine, eol }, ...lines.slice(first[1])]);
    }
    const eol = lines[0]?.eol ?? '\n'; // the block's own line ending
    return bom + join([...lines.slice(0, b.close), { text: flagLine, eol }, ...lines.slice(b.close)]);
  }
  if (first === undefined) return text;
  const drop = new Set<number>();
  for (const [s, e] of ranges) for (let i = s; i < e; i++) drop.add(i);
  const inner = lines.slice(1, b.close).filter((_, i) => !drop.has(i + 1));
  if (inner.length === 0) return bom + join(lines.slice(b.close + 1)); // the flag was all the block held
  return bom + join(lines.filter((_, i) => !drop.has(i)));
}
