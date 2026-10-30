/** OUTSIDE-CHANGE (sync.ts) with the desktop app's line merge (MERGE-LINES) it uses in the plugin. */
import { describe, expect, it } from 'vitest';
import { merge3 } from './merge.js';
import { decideOutside } from './sync.js';

const BASE = '# Trip\n\n- Plan\n\t- Flights\n- See\n\t- Tower\n';

describe('OUTSIDE-CHANGE', () => {
  it("'same': the map already shows the text on disk", () => {
    expect(decideOutside(BASE, BASE, BASE, merge3)).toEqual({ kind: 'same' });
    const both = BASE + '- Eat\n';
    expect(decideOutside(BASE, both, both, merge3)).toEqual({ kind: 'same' });
  });

  it("'reload': nothing of the map's own is unsaved, the disk's text replaces it", () => {
    const theirs = BASE.replace('Flights', 'Trains');
    expect(decideOutside(BASE, BASE, theirs, merge3)).toEqual({ kind: 'reload', text: theirs });
  });

  it("'merged': unsaved map changes and the outside change touch different lines", () => {
    const ours = BASE.replace('- See\n', '- See\n\t- Museum\n');
    const theirs = BASE.replace('\t- Flights\n', '\t- Flights\n\t- Hotel\n');
    expect(decideOutside(BASE, ours, theirs, merge3)).toEqual({ kind: 'merged', text: '# Trip\n\n- Plan\n\t- Flights\n\t- Hotel\n- See\n\t- Museum\n\t- Tower\n' });
  });

  it("'conflict': both changed the same line: the file's version, nothing merged by guess", () => {
    const ours = BASE.replace('Flights', 'Planes');
    const theirs = BASE.replace('Flights', 'Trains');
    expect(decideOutside(BASE, ours, theirs, merge3)).toEqual({ kind: 'conflict', text: theirs });
  });

  it("a merge that gives the disk's text back is a plain reload", () => {
    const theirs = BASE + '- Eat\n';
    expect(decideOutside(BASE, BASE + '- Eat\n'.slice(0, 0), theirs, merge3).kind).toBe('reload');
    const fake = (): { ok: boolean; text: string } => ({ ok: true, text: theirs });
    expect(decideOutside(BASE, BASE + 'x', theirs, fake)).toEqual({ kind: 'reload', text: theirs });
  });
});
