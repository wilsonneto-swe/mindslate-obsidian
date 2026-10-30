/** New maps' names (names.ts): Untitled numbering and NAME-FROM-ROOT. */
import { describe, expect, it } from 'vitest';
import { MAX_NAME, isUntitledName, nameFromRoot, untitledName } from './names.js';

describe('names', () => {
  it('untitledName: the first free of `Untitled mind map`, ` 1`, ` 2`...', () => {
    expect(untitledName(() => false)).toBe('Untitled mind map');
    const taken = new Set(['Untitled mind map', 'Untitled mind map 1']);
    expect(untitledName((n) => taken.has(n))).toBe('Untitled mind map 2');
  });

  it('isUntitledName: only the generated names', () => {
    for (const n of ['Untitled mind map', 'Untitled mind map 1', 'Untitled mind map 42']) expect(isUntitledName(n), n).toBe(true);
    for (const n of ['Untitled mind map x', 'Untitled mind map 1a', 'Untitled', 'Trip', 'Untitled mind map ']) expect(isUntitledName(n), n).toBe(false);
  });

  it('nameFromRoot: the first line, without what a file name or a link cannot hold', () => {
    expect(nameFromRoot('Trip to Japan')).toBe('Trip to Japan');
    expect(nameFromRoot('Q3: plan / review')).toBe('Q3 plan review');
    expect(nameFromRoot('a\\b*c?d"e<f>g|h#i^j[k]l')).toBe('a b c d e f g h i j k l');
    expect(nameFromRoot('  ..hidden  ')).toBe('hidden');
    expect(nameFromRoot('Ends with dots...')).toBe('Ends with dots');
    expect(nameFromRoot('Line one\nline two')).toBe('Line one');
    expect(nameFromRoot('zero' + String.fromCharCode(0x200b) + 'width' + String.fromCharCode(0x202e))).toBe('zerowidth');
    expect(nameFromRoot('   ')).toBeNull();
    expect(nameFromRoot('///')).toBeNull();
    const long = nameFromRoot('x'.repeat(150));
    expect(long).toHaveLength(MAX_NAME);
    const emoji = String.fromCodePoint(0x1f600);
    expect(nameFromRoot(emoji.repeat(120))).toBe(emoji.repeat(MAX_NAME)); // never half a code point
  });
});
