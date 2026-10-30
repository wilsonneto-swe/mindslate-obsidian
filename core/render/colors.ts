/**
 * Session-sticky branch colours.
 *  - On load: colour = palette[index % P] (so a freshly opened file is deterministic).
 *  - Afterwards existing branches keep their colour through reorder/insert/delete.
 *  - A new first-level branch takes the least-used colour, preferring the one after its
 *    previous sibling's colour and avoiding both neighbours' colours.
 * Nothing is written to the .md file.
 */
import type { LayoutNode } from '../layout/types.js';

export class BranchColors {
  readonly palette: readonly string[];
  readonly byId = new Map<string, number>();

  constructor(palette: readonly string[]) {
    this.palette = palette;
  }

  sync(level1Ids: readonly string[]): this {
    const P = this.palette.length;
    if (this.byId.size === 0) {
      level1Ids.forEach((id, i) => this.byId.set(id, i % P));
      return this;
    }
    // Colours of branches that are gone are remembered (undo/redo and a reverted Apply bring the same ids
    // back); only the live branches count when a new branch picks the least-used colour.
    const counts = new Array<number>(P).fill(0);
    for (const id of level1Ids) {
      const ci = this.byId.get(id);
      if (ci !== undefined) counts[ci] = (counts[ci] ?? 0) + 1;
    }
    for (let i = 0; i < level1Ids.length; i++) {
      const id = level1Ids[i];
      if (id === undefined || this.byId.has(id)) continue;
      const prevId = level1Ids[i - 1];
      const nextId = level1Ids[i + 1];
      const prev = prevId !== undefined ? (this.byId.get(prevId) ?? -1) : -1;
      const next = nextId !== undefined ? this.byId.get(nextId) : undefined;
      let best = 0;
      let bestScore = Infinity;
      for (let step = 1; step <= P; step++) {
        const c = (((prev + step) % P) + P) % P;
        const score = (counts[c] ?? 0) * 10 + (c === prev ? 5 : 0) + (c === next ? 5 : 0) + step * 1e-3;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      this.byId.set(id, best);
      counts[best] = (counts[best] ?? 0) + 1;
    }
    return this;
  }

  /**
   * The same assignments over another palette (a theme switch: EditorHandle.setColors). Every branch keeps its colour
   * INDEX, so it keeps its place in the palette's order of hues; a shorter palette wraps the indices around.
   */
  withPalette(palette: readonly string[]): BranchColors {
    const next = new BranchColors(palette);
    const P = palette.length;
    for (const [id, ci] of this.byId) next.byId.set(id, P > 0 ? ci % P : ci);
    return next;
  }

  /** Pre-assign a colour index (carries branch colours over a re-parse, where every node gets a new id). */
  assign(id: string, colorIndex: number): this {
    this.byId.set(id, colorIndex);
    return this;
  }

  colorIndex(id: string): number | undefined {
    return this.byId.get(id);
  }

  color(id: string): string | undefined {
    const ci = this.byId.get(id);
    return ci === undefined ? undefined : this.palette[ci];
  }
}

/** The colour of a laid-out node: its level-1 ancestor's branch colour (the root, which has none, gets `rootColor`: its collapse badge). */
export function branchColorOf(colors: BranchColors, L: LayoutNode, level1Ids: readonly string[], rootColor: string): string {
  if (L.depth === 0) return rootColor;
  const l1 = L.depth === 1 ? L.id : level1Ids[L.branch];
  return (l1 !== undefined ? colors.color(l1) : undefined) ?? colors.palette[0] ?? rootColor;
}
