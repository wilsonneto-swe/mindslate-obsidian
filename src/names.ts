/**
 * Names of new maps. "New mind map" creates `Untitled mind map.md` (constants.ts NEW_MAP_NAME; ` 1`, ` 2`... while the
 * name is taken, as Obsidian numbers "Untitled") in the folder Obsidian uses for new notes. The note holds only the flag:
 * without an H1 its root is its file name (R3), so renaming the note renames the root.
 *
 * NAME-FROM-ROOT: the first time the root of such a map gets a text of its own (the user typed it in the map), the note
 * takes that text as its name, the way a new note in Obsidian is named by typing its title. Only for a map made by the
 * command in this session, only while it still has its generated name, and only for a name that is free in its folder.
 */
import { NEW_MAP_NAME } from './constants.js';

/** The first free `<base>`, `<base> 1`, `<base> 2`... (`taken` answers for a base name without `.md`). */
export function untitledName(taken: (name: string) => boolean, base: string = NEW_MAP_NAME): string {
  if (!taken(base)) return base;
  for (let i = 1; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

/** A generated name: `Untitled mind map` or `Untitled mind map <n>`. */
export function isUntitledName(basename: string, base: string = NEW_MAP_NAME): boolean {
  return basename === base || (basename.startsWith(base + ' ') && /^\d+$/.test(basename.slice(base.length + 1)));
}

/** At most this many characters in a name taken from a root. */
export const MAX_NAME = 100;

/**
 * A note name for a root's text, or null when nothing usable is left: the first line; the characters a file name cannot
 * hold on one of Obsidian's systems (\ / : * ? " < > |) and those that break a [[link]] to it (# ^ [ ]) become spaces;
 * control, invisible and direction-changing characters go; white space collapses; no leading dot (a hidden file) and
 * no trailing dot or space; at most MAX_NAME characters.
 */
/** C0 and C1 controls, zero-width and direction-changing characters, a BOM: the characters a name drops. */
const hidden = (cp: number): boolean =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069) || cp === 0xfeff;

export function nameFromRoot(text: string): string | null {
  const first = text.split('\n')[0] ?? '';
  let s = [...first]
    .filter((ch) => !hidden(ch.codePointAt(0) ?? 0))
    .join('')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if ([...s].length > MAX_NAME) s = [...s].slice(0, MAX_NAME).join(''); // by code point: never half an emoji
  s = s.replace(/[. ]+$/, '');
  return s === '' ? null : s;
}
