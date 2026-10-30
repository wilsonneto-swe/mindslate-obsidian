/**
 * Matching the children of a node being written against the children that were parsed (R6).
 *
 * The editor edits by path copying: a changed node and its ancestors are new objects, every
 * untouched subtree keeps its identity. So, for one sibling group:
 *  1. a kid that IS a parsed node (identity) is that node, wherever it came from;
 *  L. LINEAGE (when the editor passes `SerializeOptions.keyOf`, its stable node ids): a kid whose key is
 *     the key of a parsed node is that node edited (a path copy keeps the id of the object it replaces),
 *     wherever that node was parsed (a node edited and then moved, or moved and then edited, is still
 *     itself); a keyed kid whose key belongs to no parsed node is NEW and is never paired by a guess
 *     (steps 2-4), so it never takes another node's body, trivia or raw lines;
 *  2. a kid that is a spread copy of a parsed node (`{ ...node, text }`: a text, collapsed or body
 *     edit in place) still holds that node's frozen `children` ARRAY, which no other node shares:
 *     it is that node too ('copy'). Texts are not a reliable successor signal for an edited node
 *     (clearing a node to '' while another sibling is '' is an everyday edit), the array is;
 *     2b. an edit INSIDE a node rebuilds its children array, but the array still holds parsed
 *     children by identity: the kid sharing the most of them with a parsed sibling is probably that
 *     sibling edited ('claim'), unless its own text names another unused sibling (a child dragged
 *     from X into its sibling Y makes Y hold X's children: Y is still Y);
 *  3. inside the gaps between in-order anchors (1, L, 2, 2b), a kid is matched to the unmatched
 *     parsed child with the same text when that text occurs exactly once among the gap's kids and
 *     exactly once among its parsed children (this also covers editors that rebuild every node
 *     object but keep the texts, and nodes moved inside the group);
 *  4. when a gap still has the same number of kids and parsed children left, they are matched by
 *     position: the kid is treated as an edited version of that parsed child.
 * A parsed child that is present elsewhere in the tree being written (`alive`: moved away by
 * identity or by key) is matched there and is never paired with another kid here by steps 2-4, or
 * its trivia (a comment line) and raw lines would be written twice.
 *
 * The group is "untouched" when it has the same length and every kid is matched with the parsed
 * child at the same index: then each item keeps its own marker and indent and only the edited
 * items are regenerated. Otherwise the group is normalised (R6/R13).
 *
 * The matching only chooses style hints (marker, indent, blank lines) and which raw lines may be
 * reused; what is written always comes from the kid itself, so a wrong match can never lose or
 * duplicate text. The one piece of content the match may carry is a `body` an editor did not
 * model, and only an identity, lineage or copy match carries it (serialize.ts `bodyOf`): with
 * two siblings of the same text, a text match could hand one sibling's body to the other, and
 * without step 2 an edited node whose new text equals a sibling's old text would take that
 * sibling's body (duplicating it) or a deleted sibling's (resurrecting it). A 2b claim is a guess
 * and never carries a body either.
 *
 * Everything is linear in the group size (hash maps, no LCS), so a 1000-sibling group is matched
 * exactly like a 3-sibling one: there is no size cliff where the writer silently degrades.
 */
import type { MapNode } from './types.js';

export type PairKind = 'identity' | 'key' | 'copy' | 'claim' | 'text' | 'position';

export interface Pair {
  /** The parsed node whose provenance applies to the kid. */
  readonly node: MapNode;
  readonly kind: PairKind;
}

export interface GroupMatch {
  /** One entry per kid: its parsed counterpart, or null for a new node. */
  readonly pairs: readonly (Pair | null)[];
  /** Same membership and order as parsed (edited-in-place items allowed). */
  readonly untouched: boolean;
}

/** What the matcher knows about the whole tree being written (built once per serialisation). */
export interface MatchScope {
  /** The parsed nodes (the ones with provenance). */
  readonly prov: { has(node: MapNode): boolean };
  /** Parsed nodes present somewhere in the tree being written, by identity or by key. */
  readonly alive?: { has(node: MapNode): boolean };
  /** The editor's stable key of a node (SerializeOptions.keyOf), with the parsed nodes by key. */
  readonly keyOf?: (node: MapNode) => string | undefined;
  readonly parsedByKey?: ReadonlyMap<string, MapNode>;
}

export function matchGroup(kids: readonly MapNode[], orig: readonly MapNode[] | null, scope: MatchScope): GroupMatch {
  const { prov, alive, keyOf, parsedByKey } = scope;
  const pairs: (Pair | null)[] = kids.map((k) => (prov.has(k) ? { node: k, kind: 'identity' } : null));
  // L: lineage. A keyed kid is decided here: the parsed node with its key, or nothing (a new node).
  const decided = kids.map((_, i) => pairs[i] !== null);
  if (keyOf !== undefined && parsedByKey !== undefined) {
    kids.forEach((k, i) => {
      if (decided[i]) return;
      const key = keyOf(k);
      if (key === undefined) return;
      decided[i] = true;
      const node = parsedByKey.get(key);
      if (node !== undefined) pairs[i] = { node, kind: 'key' };
    });
  }
  if (orig === null) return { pairs, untouched: false };

  const origIndex = new Map<MapNode, number>();
  orig.forEach((o, j) => origIndex.set(o, j));
  const usedOrig = new Set<number>();
  for (const p of pairs) {
    const j = p === null ? undefined : origIndex.get(p.node);
    if (j !== undefined) usedOrig.add(j);
  }
  // A parsed sibling that lives on elsewhere in the tree (moved away) is matched there: never guess it here.
  if (alive !== undefined) orig.forEach((o, j) => (alive.has(o) ? usedOrig.add(j) : undefined));
  const open = (i: number): boolean => pairs[i] === null && decided[i] !== true;

  // Spread copies (step 2a): the kid holds a parsed child's children array.
  const byChildren = new Map<readonly MapNode[], number>();
  orig.forEach((o, j) => {
    if (!usedOrig.has(j)) byChildren.set(o.children, j);
  });
  kids.forEach((k, i) => {
    if (!open(i)) return;
    const j = byChildren.get(k.children);
    const node = j === undefined ? undefined : orig[j];
    if (j === undefined || node === undefined || usedOrig.has(j)) return;
    pairs[i] = { node, kind: 'copy' };
    usedOrig.add(j);
  });
  // Step 2b: an edit INSIDE a node rebuilds its children array (path copying), but the array still
  // holds that node's parsed children by identity. The kid sharing the most children with an unused
  // parsed sibling is probably its edited version; ties go to an unchanged text, then to the nearest
  // position. A kid whose text is the text of exactly one unused parsed sibling is that sibling (step 3
  // pairs them) and claims no other: a child dragged from X into its sibling Y makes Y hold X's
  // children, and Y taking X's provenance would hand it X's raw lines and X's trivia.
  const ownerOf = new Map<MapNode, number>();
  orig.forEach((o, j) => {
    if (usedOrig.has(j)) return;
    for (const c of o.children) ownerOf.set(c, j);
  });
  if (ownerOf.size) {
    const unusedTexts = new Map<string, number>();
    orig.forEach((o, j) => {
      if (!usedOrig.has(j)) unusedTexts.set(o.text, (unusedTexts.get(o.text) ?? 0) + 1);
    });
    const claims: Array<{ i: number; j: number; shared: number }> = [];
    kids.forEach((k, i) => {
      if (!open(i)) return;
      const shared = new Map<number, number>();
      for (const c of k.children) {
        const j = ownerOf.get(c);
        if (j !== undefined) shared.set(j, (shared.get(j) ?? 0) + 1);
      }
      for (const [j, count] of shared) {
        if (k.text !== orig[j]?.text && unusedTexts.get(k.text) === 1) continue;
        claims.push({ i, j, shared: count });
      }
    });
    const sameText = (c: { i: number; j: number }): number => (kids[c.i]?.text === orig[c.j]?.text ? 0 : 1);
    claims.sort(
      (a, b) => b.shared - a.shared || sameText(a) - sameText(b) || Math.abs(a.i - a.j) - Math.abs(b.i - b.j) || a.i - b.i,
    );
    for (const { i, j } of claims) {
      const node = orig[j];
      if (pairs[i] !== null || usedOrig.has(j) || node === undefined) continue;
      pairs[i] = { node, kind: 'claim' };
      usedOrig.add(j);
    }
  }

  // Anchors: matches inside this group that are still in their parsed order.
  const anchors: Array<[number, number]> = [];
  let lastJ = -1;
  pairs.forEach((p, i) => {
    const j = p === null ? undefined : origIndex.get(p.node);
    if (j !== undefined && j > lastJ) {
      anchors.push([i, j]);
      lastJ = j;
    }
  });
  anchors.push([kids.length, orig.length]);

  let i0 = 0;
  let j0 = 0;
  for (const [i1, j1] of anchors) {
    const ki: number[] = [];
    for (let i = i0; i < i1; i++) if (open(i)) ki.push(i);
    const oj: number[] = [];
    for (let j = j0; j < j1; j++) if (!usedOrig.has(j)) oj.push(j);
    if (ki.length && oj.length) {
      // Unique texts on both sides pair directly.
      const origByText = new Map<string, number[]>();
      for (const j of oj) {
        const text = orig[j]?.text ?? '';
        const list = origByText.get(text);
        if (list) list.push(j);
        else origByText.set(text, [j]);
      }
      const kidCount = new Map<string, number>();
      for (const i of ki) {
        const text = kids[i]?.text ?? '';
        kidCount.set(text, (kidCount.get(text) ?? 0) + 1);
      }
      for (const i of ki) {
        const text = kids[i]?.text ?? '';
        const candidates = origByText.get(text);
        if (kidCount.get(text) !== 1 || candidates === undefined || candidates.length !== 1) continue;
        const j = candidates[0];
        const node = j === undefined ? undefined : orig[j];
        if (j === undefined || node === undefined) continue;
        pairs[i] = { node, kind: 'text' };
        usedOrig.add(j);
      }
      // Leftovers (new texts, or texts shared by several siblings) pair by position when the
      // counts agree: the typical path-copy edit of one or more items.
      const restK = ki.filter((i) => pairs[i] === null);
      const restO = oj.filter((j) => !usedOrig.has(j));
      if (restK.length === restO.length) {
        restK.forEach((i, idx) => {
          const j = restO[idx];
          const node = j === undefined ? undefined : orig[j];
          if (j === undefined || node === undefined) return;
          pairs[i] = { node, kind: 'position' };
          usedOrig.add(j);
        });
      }
    }
    i0 = i1 + 1;
    j0 = j1 + 1;
  }

  const untouched = kids.length === orig.length && pairs.every((p, i) => p !== null && p.node === orig[i]);
  return { pairs, untouched };
}
