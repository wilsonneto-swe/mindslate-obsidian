/** AUTO-OPEN and STICKY-MARKDOWN (auto-open.ts): when Obsidian's request for a Markdown view becomes a map. */
import { describe, expect, it } from 'vitest';
import { opensAsMap, renamedPath, type OpenRequest } from './auto-open.js';

const base: OpenRequest = { type: 'markdown', path: 'Notes/Trip.md', layoutReady: true, choice: undefined, flagged: true };

describe('AUTO-OPEN', () => {
  it('a flagged note asked for as Markdown opens as a map', () => {
    expect(opensAsMap(base)).toBe(true);
    expect(opensAsMap({ ...base, path: 'Trip.MD' })).toBe(true);
  });

  it('never: an unflagged note, another view type, no file, another extension, while the saved layout is put back', () => {
    expect(opensAsMap({ ...base, flagged: false })).toBe(false);
    for (const type of ['mindslate', 'canvas', 'empty', 'pdf', 'image']) expect(opensAsMap({ ...base, type }), type).toBe(false);
    expect(opensAsMap({ ...base, path: null })).toBe(false);
    expect(opensAsMap({ ...base, path: 'Board.canvas' })).toBe(false);
    expect(opensAsMap({ ...base, path: 'Notes.md/inside.txt' })).toBe(false);
    expect(opensAsMap({ ...base, layoutReady: false })).toBe(false);
  });

  it('STICKY-MARKDOWN: the user chose Markdown for the note in this tab; choosing the map again lifts it', () => {
    expect(opensAsMap({ ...base, choice: 'markdown' })).toBe(false);
    expect(opensAsMap({ ...base, choice: 'map' })).toBe(true);
  });

  it('renamedPath: a note and every note under a renamed folder follow; others do not', () => {
    expect(renamedPath('A/Trip.md', 'A/Trip.md', 'B/Trip.md')).toBe('B/Trip.md');
    expect(renamedPath('A/Sub/Trip.md', 'A', 'Z')).toBe('Z/Sub/Trip.md');
    expect(renamedPath('AB/Trip.md', 'A', 'Z')).toBeNull(); // a sibling folder that only shares a prefix
    expect(renamedPath('Other.md', 'A/Trip.md', 'B/Trip.md')).toBeNull();
  });
});
