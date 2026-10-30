/**
 * 3-way merge of whole files, line by line (diff3), pure (no Node, no DOM): compiled for main and for the
 * renderer.
 *  - main, EXTERNAL-CHANGE while dirty: base = lastSynced.text, ours = the renderer's current text, theirs =
 *    what is on disk now. When ours' and theirs' changes merge, the caller adopts + saves the result;
 *    otherwise it adopts theirs and stashes ours.
 *  - the renderer, REVISION: base = the text main held when it replaced it (ExternalChange.base), ours =
 *    the map's text (edits main never received: a throttled push in flight, keys typed while the change
 *    waited for an inline edit to end), theirs = the change's text.
 *
 * MERGE-LINES: both sides are diffed against base line by line (Myers' shortest edit script, lines compared
 * whole, terminators included), and each side's changes (hunks: base lines [start, end) replaced by new
 * lines) are applied where the other side left the lines alone. Changes of the two sides that touch the
 * same base lines are a conflict, unless both made exactly the same change. Changes that only meet (one ends
 * where the other starts) compose where the structure stays unambiguous: a mind map's lines say where they
 * belong by their indentation, so new lines must not end up under another node than the one they were added
 * under. New lines right after lines the other side deleted or re-indented are taken only when they are no
 * deeper than every line the other side changed there (they close those items in both versions and hang on
 * the same parent: never a child added under a node the other side deleted); two insertions at the same place
 * go in the order that re-parents neither (a child added under the last node goes before a sibling appended
 * after it), in a fixed order when both orders do. A node one side moved (its lines taken out in one place and
 * put in at another) while the other side deleted, moved or renamed it is a conflict too: a line content (its
 * indentation and list marker aside) that one side takes out and the other puts in would otherwise be
 * resurrected or duplicated. Finally the merged text is checked line by line (PARENTS): every line must hang
 * under the same node as in the version that last changed its place (an inserted line as in its side; a base
 * line as in the side that moved it or its parent, as in base when neither did), or the merge is refused. That
 * catches what no local rule sees: two moves that together would orphan a node, lines one side added right
 * where the other side re-indented a node. Anything else is a conflict. Refusing is safe: the caller keeps both
 * versions. Nothing is ever placed by similarity: the earlier character-level merge relocated an
 * edit onto a similar line ("Week 3" became "Week 4 done") and reported success. The rules depend on base
 * positions and line contents only, never on which side made a change, so the merge is symmetric: theirs into
 * ours gives the same text as ours into theirs.
 */

export interface MergeResult {
  ok: boolean;
  /** The merged text when ok, else theirs (what the caller adopts while it stashes ours). */
  text: string;
  /** Number of ours' changes (line hunks) that went in / how many ours made (0/0 for the trivial cases). */
  applied: number;
  total: number;
}

/** A change of one side: base lines [start, end) replaced by `lines`; `tag` names it in line origins (see Placed). */
interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
  readonly tag: string;
}

/** Edit distances above this (lines inserted + deleted, after the common prefix and suffix) are not merged. */
export const MAX_EDIT_DISTANCE = 2000;

/** The lines of `text`, each with its own terminator ('\n' or '\r\n'); the last one may have none. */
export function splitKeepingEol(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(pos, end));
    pos = end;
  }
  return out;
}

/**
 * The equal-line pairs [i, j] of a longest common subsequence of `a` and `b` (Myers' O(ND) algorithm with the
 * trace of every round kept for the walk back), in order; null when the edit distance exceeds `maxD`.
 */
function matchingLines(a: readonly number[], b: readonly number[], maxD: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const rounds: Int32Array[] = []; // rounds[d][k + d] = the furthest x on diagonal k after round d
  let found = -1;
  for (let d = 0; d <= n + m; d++) {
    if (d > maxD) return null;
    const prev = rounds[d - 1];
    const v = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0 || prev === undefined) x = 0;
      else if (k === -d || (k !== d && (prev[k - 1 + d - 1] ?? 0) < (prev[k + 1 + d - 1] ?? 0))) x = prev[k + 1 + d - 1] ?? 0;
      else x = (prev[k - 1 + d - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    rounds.push(v);
    if (found >= 0) break;
  }
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = rounds[d - 1];
    if (prev === undefined) break;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[k - 1 + d - 1] ?? 0) < (prev[k + 1 + d - 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1] ?? 0;
    const startX = down ? prevX : prevX + 1; // after the one insertion (down) or deletion (right) of this round
    while (x > startX) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevX - prevK;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** The changes that turn `base` into `side`, in base order (never touching each other); null: too far apart. */
function hunks(base: readonly string[], side: readonly string[], ids: Map<string, number>, tag: string): Hunk[] | null {
  const id = (line: string): number => {
    let v = ids.get(line);
    if (v === undefined) ids.set(line, (v = ids.size));
    return v;
  };
  let pre = 0;
  while (pre < base.length && pre < side.length && base[pre] === side[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < side.length - pre && base[base.length - 1 - suf] === side[side.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf).map(id);
  const b = side.slice(pre, side.length - suf).map(id);
  const pairs = matchingLines(a, b, MAX_EDIT_DISTANCE);
  if (pairs === null) return null;
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (mi > i || mj > j) out.push({ start: pre + i, end: pre + mi, lines: side.slice(pre + j, pre + mj), tag: `${tag}${out.length}` });
    i = mi + 1;
    j = mj + 1;
  }
  return out;
}

/**
 * base[start, end) with the given hunks applied (inside the range, in base order, never overlapping), lines tagged.
 * A hunk that edits its lines in place (inPlace) keeps their base identity: a renamed node is still that node.
 */
function applyHunks(base: readonly string[], start: number, end: number, hs: readonly Hunk[]): Placed[] {
  const out: Placed[] = [];
  let p = start;
  for (const h of hs) {
    for (let q = p; q < h.start; q++) out.push({ line: base[q] ?? '', origin: `b${q}` });
    const same = inPlace(base, h);
    h.lines.forEach((line, k) => out.push({ line, origin: same ? `b${h.start + k}` : `${h.tag}.${k}` }));
    p = h.end;
  }
  for (let q = p; q < end; q++) out.push({ line: base[q] ?? '', origin: `b${q}` });
  return out;
}

const sameLines = (a: readonly Placed[], b: readonly Placed[]): boolean => a.length === b.length && a.every((l, i) => l.line === b[i]?.line);
const blank = (line: string): boolean => line.trim() === '';
/** A list item's marker line. */
const MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|\r?\n|$)/;
/** Columns of a line's leading whitespace (tab stops of 4, as the format reads them). */
function indentCol(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}
const leading = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';
/** A hunk that edits its lines in place: as many lines, each with the same indentation, a list item where one was. */
const inPlace = (base: readonly string[], h: Hunk): boolean =>
  h.lines.length === h.end - h.start &&
  h.lines.every((line, k) => {
    const was = base[h.start + k] ?? '';
    return leading(line) === leading(was) && MARKER.test(line) === MARKER.test(was) && blank(line) === blank(was);
  });

/** Columns of the first non-blank line of `lines` (Infinity when there is none). */
const firstCol = (lines: readonly string[]): number => {
  const l = lines.find((line) => !blank(line));
  return l === undefined ? Infinity : indentCol(l);
};
/** The smallest indentation among the non-blank lines (Infinity when there is none). */
const minCol = (lines: readonly string[]): number => lines.reduce((m, line) => (blank(line) ? m : Math.min(m, indentCol(line))), Infinity);

/**
 * Two insertions of different sides at the same base position: the order in which neither re-parents the other's
 * lines, or null when there is none. `b` may follow `a` when b's first line is no deeper than every line of `a`
 * (it closes a's items, so b's lines hang where they hung before; a's lines follow the same base line as before).
 * When both orders are faithful (two siblings appended at one level) the order is fixed by the texts, so the
 * merge stays symmetric; the same lines inserted by both sides go in once.
 */
function orderInsertions(a: Hunk, b: Hunk): readonly Hunk[] | null {
  const ab = firstCol(b.lines) <= minCol(a.lines);
  const ba = firstCol(a.lines) <= minCol(b.lines);
  if (ab && ba) {
    const ta = a.lines.join('');
    const tb = b.lines.join('');
    return ta === tb ? [a] : ta < tb ? [a, b] : [b, a];
  }
  if (ab) return [a, b];
  if (ba) return [b, a];
  return null;
}

/**
 * Whether two changes of different sides that meet at one base position compose: `e` ends where `l` starts
 * (`e` first in base order; at the same start an insertion comes first; two insertions at the same place are
 * ordered by orderInsertions first). See MERGE-LINES above.
 */
function compose(base: readonly string[], e: Hunk, l: Hunk): boolean {
  const eInsert = e.start === e.end;
  const lInsert = l.start === l.end;
  if (eInsert) return true; // e's new lines go before l's, after the same base line as before (insertions: ordered)
  if (!lInsert && l.lines.length === 0) return true; // l only deletes
  // e edited its lines in place (same count, same indentation): the lines after it keep their parents
  if (inPlace(base, e)) return true;
  // e deleted or re-indented lines: l's first new line must close them all (no deeper than any of them)
  const first = l.lines.find((line) => !blank(line));
  if (first === undefined) return true;
  const touched = [...base.slice(e.start, e.end), ...e.lines].filter((line) => !blank(line));
  return touched.every((line) => indentCol(first) <= indentCol(line));
}

/** A line with where it comes from: `b<i>` (base line i), `m<h>.<k>` / `y<h>.<k>` (line k of hunk h of ours / theirs). */
interface Placed {
  readonly line: string;
  readonly origin: string;
}



/**
 * PARENTS: the origin of the list item each non-blank line hangs under (the nearest list item above it that is
 * indented less), or '' at the top. Blank lines have none.
 */
function parentsOf(lines: readonly Placed[]): Map<string, string> {
  const parents = new Map<string, string>();
  const open: Array<{ col: number; origin: string }> = [];
  for (const { line, origin } of lines) {
    if (blank(line)) continue;
    const col = indentCol(line);
    while (open.length && (open[open.length - 1]?.col ?? 0) >= col) open.pop();
    parents.set(origin, open[open.length - 1]?.origin ?? '');
    if (MARKER.test(line)) open.push({ col, origin });
  }
  return parents;
}

/**
 * PARENTS: true when every line of the merged text hangs where the version that last placed it put it: a line a
 * side inserted as in that side, a base line as in the side that changed its parent (as in base when neither did;
 * the two sides must agree when both did).
 */
function parentsKept(base: readonly string[], mine: readonly Hunk[], yours: readonly Hunk[], merged: readonly Placed[]): boolean {
  const p0 = parentsOf(base.map((line, i) => ({ line, origin: `b${i}` })));
  const pm = parentsOf(applyHunks(base, 0, base.length, mine));
  const py = parentsOf(applyHunks(base, 0, base.length, yours));
  const now = parentsOf(merged);
  for (const [origin, parent] of now) {
    let want: string | undefined;
    if (origin.startsWith('m')) want = pm.get(origin);
    else if (origin.startsWith('y')) want = py.get(origin);
    else {
      const was = p0.get(origin);
      const a = pm.get(origin);
      const b = py.get(origin);
      if (a === was) want = b;
      else if (b === was || b === a) want = a;
      else return false; // both sides put this line under different nodes
    }
    if (want !== parent) return false;
  }
  return true;
}

/** A line's content for move detection: no indentation, list marker, line ending or surrounding spaces. */
const content = (line: string): string => line.trim().replace(/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/, '').trim();
const contentOk = (c: string): boolean => c !== '' && !/^<!--\s*-->$/.test(c);

/** True when a line content that `x` takes out of base is one that `y` puts in (a move against a delete, move or rename). */
function crossed(base: readonly string[], x: readonly Hunk[], y: readonly Hunk[]): boolean {
  const out = new Set<string>();
  for (const h of x) for (let q = h.start; q < h.end; q++) out.add(content(base[q] ?? ''));
  for (const h of y) for (const line of h.lines) {
    const c = content(line);
    if (contentOk(c) && out.has(c)) return true;
  }
  return false;
}

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  // Trivial cases first.
  if (ours === base) return { ok: true, text: theirs, applied: 0, total: 0 };
  if (theirs === base) return { ok: true, text: ours, applied: 0, total: 0 };
  if (ours === theirs) return { ok: true, text: ours, applied: 0, total: 0 };

  const b = splitKeepingEol(base);
  const ids = new Map<string, number>();
  const mine = hunks(b, splitKeepingEol(ours), ids, 'm');
  const yours = hunks(b, splitKeepingEol(theirs), ids, 'y');
  if (mine === null || yours === null) return { ok: false, text: theirs, applied: 0, total: mine?.length ?? 1 };
  if (crossed(b, mine, yours) || crossed(b, yours, mine)) return { ok: false, text: theirs, applied: 0, total: mine.length };

  const out: Placed[] = [];
  const keep = (q: number): void => {
    out.push({ line: b[q] ?? '', origin: `b${q}` });
  };
  let pos = 0;
  let i = 0;
  let j = 0;
  let applied = 0;
  let conflict = false;
  while (i < mine.length || j < yours.length) {
    const m0 = mine[i];
    const y0 = yours[j];
    const startsWithMine = m0 !== undefined && (y0 === undefined || m0.start <= y0.start);
    const first = startsWithMine ? m0 : y0;
    if (first === undefined) break;
    if (startsWithMine) i++;
    else j++;
    const group = { start: first.start, end: first.end, mine: startsWithMine ? [first] : [], yours: startsWithMine ? [] : [first] };
    // every change that overlaps or meets the group joins it (changes of one side never meet each other)
    for (;;) {
      const m = mine[i];
      const y = yours[j];
      if (m !== undefined && m.start <= group.end) {
        group.mine.push(m);
        group.end = Math.max(group.end, m.end);
        i++;
      } else if (y !== undefined && y.start <= group.end) {
        group.yours.push(y);
        group.end = Math.max(group.end, y.end);
        j++;
      } else break;
    }
    for (let q = pos; q < group.start; q++) keep(q);
    const asMine = applyHunks(b, group.start, group.end, group.mine);
    if (group.yours.length === 0) {
      out.push(...asMine);
      applied += group.mine.length;
    } else if (group.mine.length === 0) {
      out.push(...applyHunks(b, group.start, group.end, group.yours));
    } else {
      const asYours = applyHunks(b, group.start, group.end, group.yours);
      if (sameLines(asMine, asYours)) {
        // both sides made the same change
        out.push(...asMine);
        applied += group.mine.length;
      } else {
        // both sides changed lines here: they compose only when no two changes overlap and every meeting is clean
        const sorted = [...group.mine, ...group.yours].sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
        let clean = true;
        const all: Hunk[] = [];
        for (let k = 0; k < sorted.length; k++) {
          const h = sorted[k];
          const next = sorted[k + 1];
          if (h === undefined) continue;
          if (next !== undefined && h.start === h.end && next.start === h.start && next.end === next.start) {
            // two insertions at the same place (one per side): in the order that keeps both structures, if any
            const ordered = orderInsertions(h, next);
            if (ordered === null) clean = false;
            else all.push(...ordered);
            k++;
          } else all.push(h);
        }
        for (let k = 1; k < all.length && clean; k++) {
          const e = all[k - 1];
          const l = all[k];
          if (e === undefined || l === undefined) continue;
          if (l.start < e.end || (l.start === e.start && e.end > e.start && l.end > l.start)) clean = false;
          else if (l.start === e.end) clean = compose(b, e, l);
        }
        if (clean) {
          out.push(...applyHunks(b, group.start, group.end, all));
          applied += group.mine.length;
        } else {
          conflict = true;
          out.push(...asYours);
        }
      }
    }
    pos = group.end;
  }
  for (let q = pos; q < b.length; q++) keep(q);
  // PARENTS: no line may end up under another node than the version that placed it meant
  if (conflict || !parentsKept(b, mine, yours, out)) return { ok: false, text: theirs, applied: conflict ? applied : 0, total: mine.length };
  return { ok: true, text: out.map((p) => p.line).join(''), applied, total: mine.length };
}
