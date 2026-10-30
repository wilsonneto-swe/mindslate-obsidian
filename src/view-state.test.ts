/** VIEW-STATE (view-state.ts): one snapshot per note, capped, following renames and deletes, tolerant of what it reads. */
import type { ViewSnapshot } from '../core/index.js';
import { describe, expect, it } from 'vitest';
import { MAX_COLLAPSED, ViewStateStore, validSnapshot } from './view-state.js';

const snap = (zoom: number, selected: number[] = [0]): ViewSnapshot => ({ collapsed: [[1], [2, 0]], selected, view: { zoom, tx: 10, ty: -20 } });

describe('VIEW-STATE', () => {
  it('keeps, gives back and serialises; the same snapshot again is no change', () => {
    const s = new ViewStateStore(null);
    expect(s.set('A.md', snap(1), 1000)).toBe(true);
    expect(s.set('A.md', snap(1), 2000)).toBe(false);
    expect(s.get('A.md')).toEqual(snap(1));
    expect(s.get('B.md')).toBeUndefined();
    const again = new ViewStateStore(JSON.parse(JSON.stringify(s.toJSON())));
    expect(again.get('A.md')).toEqual(snap(1));
    expect(again.toJSON().version).toBe(1);
  });

  it('CAP: beyond the cap the note used longest ago goes first (a note saved again counts as new)', () => {
    const s = new ViewStateStore(null, 3);
    s.set('1.md', snap(1), 1);
    s.set('2.md', snap(1), 2);
    s.set('3.md', snap(1), 3);
    s.set('1.md', snap(2), 4); // used again
    s.set('4.md', snap(1), 5);
    expect([...Object.keys(s.toJSON().notes)].sort()).toEqual(['1.md', '3.md', '4.md']);
    // read back from data in any order: the oldest by time are dropped
    const read = new ViewStateStore({ notes: { 'x.md': { snapshot: snap(1), at: 9 }, 'y.md': { snapshot: snap(1), at: 1 }, 'z.md': { snapshot: snap(1), at: 5 } } }, 2);
    expect(Object.keys(read.toJSON().notes).sort()).toEqual(['x.md', 'z.md']);
  });

  it('FOLLOW: a renamed note, a moved folder; a deleted note or folder takes its state along', () => {
    const s = new ViewStateStore(null);
    s.set('A/One.md', snap(1));
    s.set('A/Sub/Two.md', snap(2));
    s.set('AB/Three.md', snap(3));
    expect(s.rename('A/One.md', 'A/Uno.md')).toBe(true);
    expect(s.get('A/Uno.md')).toEqual(snap(1));
    expect(s.rename('A', 'Z')).toBe(true);
    expect(s.get('Z/Uno.md')).toEqual(snap(1));
    expect(s.get('Z/Sub/Two.md')).toEqual(snap(2));
    expect(s.get('AB/Three.md')).toEqual(snap(3)); // only shares a prefix
    expect(s.rename('Nope.md', 'X.md')).toBe(false);
    expect(s.delete('Z')).toBe(true);
    expect(s.size).toBe(1);
    expect(s.delete('AB/Three.md')).toBe(true);
    expect(s.delete('AB/Three.md')).toBe(false);
    expect(s.size).toBe(0);
  });

  it('TOLERANT: anything else in data.json is dropped quietly', () => {
    for (const data of [undefined, null, 42, 'x', [], { notes: null }, { notes: [] }]) expect(new ViewStateStore(data).size).toBe(0);
    const s = new ViewStateStore({
      notes: {
        'ok.md': { snapshot: snap(1), at: 1 },
        'no-view.md': { snapshot: { collapsed: [], selected: [] }, at: 1 },
        'bad-zoom.md': { snapshot: { collapsed: [], selected: [], view: { zoom: 0, tx: 0, ty: 0 } } },
        'bad-path.md': { snapshot: { collapsed: [], selected: [-1], view: { zoom: 1, tx: 0, ty: 0 } } },
        'nan.md': { snapshot: { collapsed: [], selected: [], view: { zoom: 1, tx: Number.NaN, ty: 0 } } },
        '': { snapshot: snap(1), at: 1 },
        'junk.md': 'junk',
      },
    });
    expect(Object.keys(s.toJSON().notes)).toEqual(['ok.md']);
  });

  it('validSnapshot: bad collapsed paths are dropped, the count capped, selectionShown kept', () => {
    const v = validSnapshot({ collapsed: [[0], [-1], 'x', [1.5], [2]], selected: [], view: { zoom: 2, tx: 1, ty: 2 }, selectionShown: true });
    expect(v).toEqual({ collapsed: [[0], [2]], selected: [], view: { zoom: 2, tx: 1, ty: 2 }, selectionShown: true });
    const many = validSnapshot({ collapsed: Array.from({ length: MAX_COLLAPSED + 50 }, (_, i) => [i]), selected: [], view: { zoom: 1, tx: 0, ty: 0 } });
    expect(many?.collapsed).toHaveLength(MAX_COLLAPSED);
    expect(validSnapshot(null)).toBeNull();
  });
});
