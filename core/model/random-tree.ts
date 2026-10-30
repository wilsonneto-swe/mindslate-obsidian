/** Seeded random trees for property tests, benchmarks and the "2k" harness fixture. */
import type { MapNode } from '../format/types.js';
import { mkNode } from './tree.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'travel skill plan goal team lead feature review ticket beach museum weekly growth impact scope ' +
  'project design ship deploy test fix learn teach share notes idea map node branch leaf root ' +
  'internationalization responsibilities communication stakeholder alignment velocity roadmap a I of to in'
).split(' ');

function randText(rnd: () => number): string {
  const r = rnd();
  const words = (n: number): string =>
    Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)] ?? 'x').join(' ');
  if (r < 0.03) return ''; // empty node (fresh node in edit mode)
  if (r < 0.1) return words(25 + Math.floor(rnd() * 60)); // long paragraph -> many wrapped lines
  if (r < 0.13) return 'https://example.com/' + 'x'.repeat(60 + Math.floor(rnd() * 120)); // unbreakable
  if (r < 0.16) return words(3) + '\n' + words(4); // hard line break (Shift+Enter)
  if (r < 0.18) return '漢字テキスト ' + words(3) + ' 🙂'; // wide glyphs
  return words(1 + Math.floor(rnd() * 8));
}

interface Draft {
  readonly id: string;
  readonly text: string;
  readonly children: Draft[];
}

export interface RandomTreeOptions {
  /** Length of a guaranteed deep chain (>= 10 levels). */
  readonly chain?: number;
  /** Probability that an inner node is collapsed. */
  readonly collapseRate?: number;
}

/**
 * A deterministic tree of `n` nodes: ids are `r<seed>_<k>` (pinned, so two generations of the
 * same seed are identical, layout snapshots included), texts mix short labels, long paragraphs,
 * unbreakable URLs, hard line breaks and wide glyphs.
 */
export function randomTree(seed: number, n: number, { chain = 12, collapseRate = 0.04 }: RandomTreeOptions = {}): MapNode {
  const rnd = mulberry32(seed);
  let next = 0;
  const id = (): string => 'r' + seed + '_' + next++;
  const root: Draft = { id: id(), text: 'Root ' + seed, children: [] };
  const all: Draft[] = [root];
  let cur = root;
  for (let d = 0; d < Math.min(chain, n - 1); d++) {
    const c: Draft = { id: id(), text: randText(rnd), children: [] };
    cur.children.push(c);
    all.push(c);
    cur = c;
  }
  while (all.length < n) {
    // 55%: attach near recently created nodes (grows depth and bushy subtrees), else uniform
    const p =
      rnd() < 0.55
        ? all[all.length - 1 - Math.floor(rnd() * Math.min(25, all.length))]
        : all[Math.floor(rnd() * all.length)];
    const c: Draft = { id: id(), text: randText(rnd), children: [] };
    (p ?? root).children.push(c);
    all.push(c);
  }
  const freezeTree = (x: Draft): MapNode =>
    mkNode(x.text, x.children.map(freezeTree), {
      id: x.id,
      collapsed: x.children.length > 0 && x !== root && rnd() < collapseRate,
    });
  return freezeTree(root);
}
