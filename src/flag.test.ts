/**
 * FLAG-MINIMAL (flag.ts): the flag goes in and out of a note's frontmatter as ONE line, and every other byte stays.
 */
import { describe, expect, it } from 'vitest';
import { FLAG_KEY } from './constants.js';
import { flagValue, flaggedIn, hasFlag, setFlag } from './flag.js';

const BOM = String.fromCharCode(0xfeff);
const LINE = `${FLAG_KEY}: map`;

/** [input, with the flag on] pairs where turning it off again gives the input back exactly. */
const ROUND_TRIPS: ReadonlyArray<readonly [string, string, string]> = [
  ['an empty note', '', `---\n${LINE}\n---\n`],
  ['a map without frontmatter', '# Trip\n\n- Plan\n\t- Flights\n', `---\n${LINE}\n---\n# Trip\n\n- Plan\n\t- Flights\n`],
  ['CRLF without frontmatter', '# Trip\r\n\r\n- Plan\r\n', `---\r\n${LINE}\r\n---\r\n# Trip\r\n\r\n- Plan\r\n`],
  ['no final newline', 'just text', `---\n${LINE}\n---\njust text`],
  ['other keys', '---\ntags: [a, b]\ntitle: x\n---\nbody\n', `---\ntags: [a, b]\ntitle: x\n${LINE}\n---\nbody\n`],
  ['other keys, CRLF', '---\r\ntags: [a]\r\n---\r\n# T\r\n', `---\r\ntags: [a]\r\n${LINE}\r\n---\r\n# T\r\n`],
  ['a BOM and frontmatter', `${BOM}---\na: 1\n---\nx\n`, `${BOM}---\na: 1\n${LINE}\n---\nx\n`],
  ['a BOM without frontmatter', `${BOM}# T\n`, `${BOM}---\n${LINE}\n---\n# T\n`],
  ['a block that closes the file', '---\na: 1\n---', `---\na: 1\n${LINE}\n---`],
  ['blank lines and comments in the block', '---\n# a comment\n\nkey: v\n\n---\n\nText\n', `---\n# a comment\n\nkey: v\n\n${LINE}\n---\n\nText\n`],
  ['a nested value before it', '---\nlist:\n  - one\n  - two\n---\n', `---\nlist:\n  - one\n  - two\n${LINE}\n---\n`],
  ['an empty-looking note with only a blank line', '\n', `---\n${LINE}\n---\n\n`],
  ['a leading horizontal rule that closes nothing', '---\nnot closed\n', `---\n${LINE}\n---\n---\nnot closed\n`],
  ['`--- ` with a trailing space is no block', '--- \na: 1\n--- \n', `---\n${LINE}\n---\n--- \na: 1\n--- \n`],
  ['mixed line endings: the block keeps its own', '---\r\na: 1\n---\r\nbody\n', `---\r\na: 1\n${LINE}\r\n---\r\nbody\n`],
];

describe('FLAG-MINIMAL: on and off', () => {
  for (const [what, text, flagged] of ROUND_TRIPS) {
    it(`${what}: one line in, one line out`, () => {
      expect(setFlag(text, true)).toBe(flagged);
      expect(hasFlag(flagged)).toBe(true);
      expect(hasFlag(text)).toBe(false);
      expect(setFlag(flagged, false)).toBe(text);
      expect(setFlag(flagged, true)).toBe(flagged); // already on: the very same text
      expect(setFlag(text, false)).toBe(text); // already off
    });
  }

  it('an empty block gets the flag inside; taking it out removes the block, which then holds nothing (documented)', () => {
    expect(setFlag('---\n---\n# T\n', true)).toBe(`---\n${LINE}\n---\n# T\n`);
    expect(setFlag(`---\n${LINE}\n---\n# T\n`, false)).toBe('# T\n');
  });

  it('another value is replaced in place; quoted, commented and spaced forms count as on', () => {
    expect(setFlag(`---\na: 1\n${FLAG_KEY}: markdown\nb: 2\n---\n`, true)).toBe(`---\na: 1\n${LINE}\nb: 2\n---\n`);
    for (const v of ['map', '"map"', "'map'", 'map # why', 'map   ']) expect(hasFlag(`---\n${FLAG_KEY}: ${v}\n---\n`), v).toBe(true);
    for (const v of ['Map', 'maps', '', 'true', '"map']) expect(hasFlag(`---\n${FLAG_KEY}: ${v}\n---\n`), v).toBe(false);
    expect(flagValue(`---\n"${FLAG_KEY}": map\n---\n`)).toBe('map');
    expect(flagValue('# no block\n')).toBeNull();
    expect(flagValue(`---\nother: map\n---\n`)).toBeNull();
  });

  it('the key only at the top level of the block, never in the body or nested', () => {
    const body = `# T\n\n${LINE}\n`;
    expect(hasFlag(body)).toBe(false);
    expect(setFlag(body, true)).toBe(`---\n${LINE}\n---\n` + body);
    const nested = `---\nparent:\n  ${LINE}\n---\n`;
    expect(hasFlag(nested)).toBe(false);
    expect(setFlag(nested, true)).toBe(`---\nparent:\n  ${LINE}\n${LINE}\n---\n`);
  });

  it('a value written on the lines under the key goes with it, as one line in, the lines out', () => {
    const block = `---\na: 1\n${FLAG_KEY}:\n  - map\n  - x\nb: 2\n---\n`;
    expect(setFlag(block, true)).toBe(`---\na: 1\n${LINE}\nb: 2\n---\n`);
    expect(setFlag(block, false)).toBe('---\na: 1\nb: 2\n---\n');
  });

  it('two keys (hand-made): on keeps the first and replaces it, off removes both', () => {
    const twice = `---\n${FLAG_KEY}: markdown\nx: 1\n${FLAG_KEY}: other\n---\n`;
    expect(setFlag(twice, true)).toBe(`---\n${LINE}\nx: 1\n${FLAG_KEY}: other\n---\n`);
    expect(setFlag(twice, false)).toBe('---\nx: 1\n---\n');
  });

  it('round trips over generated notes: off(on(text)) is text, byte for byte', () => {
    const pool = ['# Title', '- item', '\t- child', '', 'para', 'a: b', '---', '...', '  indented', 'key:', `${FLAG_KEY}: map`];
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const eol = rnd(3) === 0 ? '\r\n' : '\n';
      const lines = Array.from({ length: rnd(8) }, () => pool[rnd(pool.length)] ?? '');
      const fm = rnd(2) === 0 ? ['---', ...Array.from({ length: rnd(3) + 1 }, () => ['a: 1', 'tags: [x]', '', '# c'][rnd(4)] ?? ''), '---'] : [];
      const text = (rnd(5) === 0 ? BOM : '') + [...fm, ...lines].join(eol) + (rnd(2) === 0 ? eol : '');
      if (hasFlag(text) || flagValue(text) !== null) continue; // a note that already has the key is covered above
      const on = setFlag(text, true);
      expect(hasFlag(on)).toBe(true);
      const inner = fm.slice(1, -1);
      if (fm.length > 0 && inner.length === 0) continue; // an empty block: removed with the flag (documented)
      expect(setFlag(on, false)).toBe(text);
      // exactly one line more
      expect(on.split('\n').length - text.split('\n').length).toBe(fm.length > 0 || text.startsWith(BOM + '---') ? (block3(text) ? 1 : 3) : 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('flaggedIn reads the parsed frontmatter of Obsidian\'s metadata cache', () => {
    expect(flaggedIn({ [FLAG_KEY]: 'map' })).toBe(true);
    expect(flaggedIn({ [FLAG_KEY]: 'Map' })).toBe(false);
    expect(flaggedIn({ [FLAG_KEY]: true })).toBe(false);
    expect(flaggedIn({ other: 'map' })).toBe(false);
    expect(flaggedIn(null)).toBe(false);
    expect(flaggedIn(undefined)).toBe(false);
  });
});

/** The text has a frontmatter block Obsidian recognises (the flag then goes inside it: one line). */
function block3(text: string): boolean {
  const t = text.startsWith(BOM) ? text.slice(1) : text;
  const lines = t.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---' || lines.length < 2 || !/\n/.test(t)) return false;
  return lines.slice(1, -1).includes('---') || (lines.length > 1 && lines[lines.length - 1] === '---');
}
