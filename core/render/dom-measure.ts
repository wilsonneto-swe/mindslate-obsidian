/// <reference lib="dom" />
/**
 * DOM-backed text measurer with the same interface as layout/measure.ts:
 *   measureText(text, style) -> { width, height, lines: null }
 * width = tight width of the widest rendered line (Range rect), not the CSS box width, because a
 * wrapped block is always max-width wide in CSS while the connector stub must start right after
 * the text. Uncached texts are measured in batches inside an unscaled hidden host => one reflow.
 * Measurements taken while the host is not rendered (mounted inside display:none, or before the
 * container is attached to the document) are zeros: they are returned but never cached, so the
 * map lays out correctly once the editor re-measures after becoming visible.
 * With white-space: pre-wrap, Chrome and WebKit count the space that hangs at a soft wrap in the range's rect, so
 * the widest line of a wrapped text can measure up to one space past the style's max-width. That is the demo's
 * measurement and the layout keeps it (same geometry); the renderer pins the NODE box to the layout width
 * (renderer.ts pinWidth), so the box, its rings and its handles still line up with the layout.
 */
import type { MeasureText, TextMetrics, TextStyle } from '../layout/types.js';
import type { ElementFactory } from './element.js';

export interface MeasurePair {
  readonly text: string;
  readonly st: TextStyle;
}

export interface DomMeasurer extends MeasureText {
  /** Measure all uncached (text, style) pairs with a single forced layout. Returns how many were measured. */
  prime(pairs: readonly MeasurePair[]): number;
  /** Cached dimensions without measuring (undefined when unknown). */
  peek(text: string, st: TextStyle): TextMetrics | undefined;
  /**
   * Measure the live (contenteditable) label while typing; `scale` = current zoom. The result is
   * cached under `text` (what the label shows, incl. the browser's trailing line-break placeholder)
   * and under `alias` (the model text), so the layout of the edited node matches the DOM label.
   * Live entries are dropped by forgetLive() when the edit session ends.
   */
  setLive(text: string, st: TextStyle, labelEl: HTMLElement, scale: number, alias?: string): TextMetrics;
  forgetLive(): void;
  /** True when the host is attached and rendered (measurements can be trusted). */
  rendered(): boolean;
  clear(): void;
  stats(): { entries: number; batches: number; measured: number };
}

/** `make` creates the measured elements (the host's ElementFactory). */
export function createDomMeasurer(host: HTMLElement, make: ElementFactory): DomMeasurer {
  const cache = new Map<string, TextMetrics>();
  const transient = new Map<string, TextMetrics>(); // results from a non-rendered host: usable for this layout, never trusted again
  const live = new Set<string>(); // cache keys written by setLive() during the current edit session
  const range = document.createRange();
  const key = (text: string, st: TextStyle): string => st.key + '\u0001' + text;
  const tight = (el: HTMLElement): number => {
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  };
  const rendered = (): boolean => host.isConnected && host.getClientRects().length > 0;
  let batches = 0;
  let measured = 0;

  function prime(pairs: readonly MeasurePair[]): number {
    const seen = new Set<string>();
    const todo: Array<[string, MeasurePair]> = [];
    for (const p of pairs) {
      const k = key(p.text, p.st);
      if (cache.has(k) || seen.has(k)) continue;
      seen.add(k);
      todo.push([k, p]);
    }
    if (!todo.length) return 0;
    const ok = rendered();
    const els = todo.map(([, p]) => {
      const el = make('div');
      el.className = 'mm-m mm-' + p.st.key;
      el.textContent = p.text;
      return el;
    });
    // appended one by one: nothing reads layout until all are in, so the batch still costs one reflow
    for (const el of els) host.appendChild(el);
    for (let i = 0; i < todo.length; i++) {
      const entry = todo[i];
      const el = els[i];
      if (entry === undefined || el === undefined) continue;
      const st = entry[1].st;
      (ok ? cache : transient).set(entry[0], { width: tight(el), height: Math.max(el.offsetHeight, st.lineHeight), lines: null });
    }
    host.textContent = '';
    batches++;
    measured += todo.length;
    return todo.length;
  }

  const measureText = (text: string, st: TextStyle): TextMetrics => {
    const k = key(text, st);
    let r = cache.get(k);
    if (!r) {
      prime([{ text, st }]);
      r = cache.get(k) ?? transient.get(k) ?? { width: 0, height: st.lineHeight, lines: null };
    }
    return r;
  };

  return Object.assign(measureText, {
    prime,
    peek: (text: string, st: TextStyle): TextMetrics | undefined => cache.get(key(text, st)),
    setLive(text: string, st: TextStyle, labelEl: HTMLElement, scale: number, alias?: string): TextMetrics {
      const r: TextMetrics = { width: tight(labelEl) / scale, height: Math.max(labelEl.offsetHeight, st.lineHeight), lines: null };
      const k = key(text, st);
      cache.set(k, r);
      live.add(k);
      if (alias !== undefined && alias !== text) {
        const k2 = key(alias, st);
        cache.set(k2, r);
        live.add(k2);
      }
      return r;
    },
    forgetLive(): void {
      for (const k of live) cache.delete(k);
      live.clear();
    },
    rendered,
    clear(): void {
      cache.clear();
      transient.clear();
      live.clear();
    },
    stats: () => ({ entries: cache.size, batches, measured }),
  });
}
