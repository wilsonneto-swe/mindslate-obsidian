/**
 * Deterministic text measurer (no DOM) + greedy wrapping that mimics
 * CSS `white-space: pre-wrap; overflow-wrap: anywhere; max-width: <maxWidth>px`.
 *
 * In the editor the DOM is the source of truth for node sizes (render/dom-measure.ts); this module
 * exists so the layout can be unit-tested and benchmarked in Node. Widths are the classic
 * Helvetica AFM advance widths (Arial is metric-compatible).
 */
import type { MeasureText, TextLine, TextMetrics, TextStyle } from './types.js';

// prettier-ignore
const REGULAR = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,          // 32-47  (space .. /)
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,     // 48-64  (0-9 : ; < = > ? @)
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611, // A-Z
  278,278,278,469,556,333,                                                  // [ \ ] ^ _ `
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500, // a-z
  334,260,334,584,                                                          // { | } ~
];
// prettier-ignore
const BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
  722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  333,278,333,584,556,333,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
  389,280,389,584,
];

export type WidthOf = (codePoint: number, bold: boolean) => number;

/** Advance width in 1/1000 em. */
export function helveticaWidth(cp: number, bold: boolean): number {
  if (cp >= 32 && cp <= 126) return (bold ? BOLD : REGULAR)[cp - 32] ?? 600;
  if (cp === 9) return 4 * 278; // tab
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60)
  )
    return 1000; // CJK / Hangul / fullwidth
  if (cp >= 0x1f000) return 1150; // emoji-ish
  return 600;
}

/** A crude monospace measurer (every glyph = 0.6em) for tests with round numbers. */
export const monoWidth: WidthOf = () => 600;

type WrapStyle = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'maxWidth'> & { readonly fontWeight?: number };

function strWidth(s: string, cw: (cp: number) => number): number {
  let w = 0;
  for (const ch of s) w += cw(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Greedy wrap. Returns { width, height, lines }.
 * width = widest line (the node shrink-wraps to it, like `width: max-content` capped by max-width).
 */
export function wrapText(text: string, style: WrapStyle, widthOf: WidthOf = helveticaWidth): TextMetrics {
  const { fontSize, lineHeight, maxWidth, fontWeight = 400 } = style;
  const bold = fontWeight >= 600;
  const k = fontSize / 1000;
  const cw = (cp: number): number => widthOf(cp, bold) * k;
  const spaceW = cw(32);
  const lines: TextLine[] = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');
    let lt = '';
    let lw = 0;
    let started = false;
    const flush = (): void => {
      lines.push({ text: lt, width: lw });
      lt = '';
      lw = 0;
      started = false;
    };
    for (let i = 0; i < words.length; i++) {
      const word = words[i] ?? '';
      const ww = strWidth(word, cw);
      if (!started) {
        if (ww <= maxWidth) {
          lt = word;
          lw = ww;
        } else {
          // overflow-wrap:anywhere -> break the word between characters
          for (const ch of word) {
            const c = cw(ch.codePointAt(0) ?? 0);
            if (lw + c > maxWidth && lt !== '') flush();
            lt += ch;
            lw += c;
          }
        }
        started = true;
      } else if (lw + spaceW + ww <= maxWidth) {
        lt += ' ' + word;
        lw += spaceW + ww;
      } else {
        flush();
        i--; // retry this word at the start of a new line
      }
    }
    flush();
  }
  let width = 0;
  for (const l of lines) if (l.width > width) width = l.width;
  return { width, height: lines.length * lineHeight, lines };
}

export interface TextMeasurer extends MeasureText {
  stats(): { hits: number; misses: number; size: number };
  clear(): void;
}

export interface TextMeasurerOptions {
  readonly widthOf?: WidthOf;
  readonly maxEntries?: number;
}

/** Cached measurer: (text, style) -> metrics. Cache key = style.key + text. */
export function createTextMeasurer({ widthOf = helveticaWidth, maxEntries = 50_000 }: TextMeasurerOptions = {}): TextMeasurer {
  const cache = new Map<string, TextMetrics>();
  let hits = 0;
  let misses = 0;
  const measureText = (text: string, style: TextStyle): TextMetrics => {
    const key = style.key + '\u0001' + text;
    const hit = cache.get(key);
    if (hit) {
      hits++;
      return hit;
    }
    misses++;
    const r = wrapText(text, style, widthOf);
    if (cache.size >= maxEntries) cache.clear();
    cache.set(key, r);
    return r;
  };
  return Object.assign(measureText, {
    stats: () => ({ hits, misses, size: cache.size }),
    clear: () => cache.clear(),
  });
}
