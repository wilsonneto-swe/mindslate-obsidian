/** THEME and CONTRAST (theme.ts): the map's colours in Obsidian's light and dark themes. */
import { PALETTE } from '../core/index.js';
import { describe, expect, it } from 'vitest';
import { DARK_PALETTE, LIGHT_PALETTE, MIN_GRAPHIC_CONTRAST, contrastRatio, isDarkColor, mapColors, parseColor } from './theme.js';

// Obsidian 1.13's own backgrounds (app.css): --background-primary, -primary-alt and -secondary of each theme
const LIGHT_BACKGROUNDS = ['#ffffff', '#fafafa', '#f6f6f6'];
const DARK_BACKGROUNDS = ['#1e1e1e', '#242424', '#262626'];

/** The hue of a colour in degrees. */
function hue(css: string): number {
  const [r, g, b] = (parseColor(css) ?? [0, 0, 0]).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('THEME', () => {
  it('parseColor and contrastRatio (WCAG)', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#7048E8')).toEqual([112, 72, 232]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30]);
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual([10, 20, 30]);
    expect(parseColor('hsl(0, 0%, 0%)')).toBeNull();
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777', '#777')).toBeCloseTo(1, 5);
    expect(Number.isNaN(contrastRatio('x', '#fff'))).toBe(true);
    expect(isDarkColor('#1e1e1e')).toBe(true);
    expect(isDarkColor('#ffffff')).toBe(false);
  });

  it('CONTRAST: every branch colour of the light palette is 3:1 or more on Obsidian\'s light backgrounds, and its badge numerals (white) too', () => {
    for (const c of LIGHT_PALETTE) {
      for (const bg of LIGHT_BACKGROUNDS) expect(contrastRatio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
      expect(contrastRatio(c, '#ffffff'), `white on ${c}`).toBeGreaterThanOrEqual(4.5); // numerals are text
    }
  });

  it('CONTRAST: the core\'s dark palette is 3:1 or more on Obsidian\'s dark backgrounds', () => {
    expect(DARK_PALETTE).toBe(PALETTE);
    for (const c of DARK_PALETTE) for (const bg of DARK_BACKGROUNDS) expect(contrastRatio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
  });

  it('a branch keeps its hue across a theme switch: the palettes are in the same order of hues', () => {
    expect(LIGHT_PALETTE).toHaveLength(DARK_PALETTE.length);
    LIGHT_PALETTE.forEach((c, i) => {
      const d = Math.abs(hue(c) - hue(DARK_PALETTE[i] ?? ''));
      expect(Math.min(d, 360 - d), `${c} vs ${DARK_PALETTE[i]}`).toBeLessThan(25);
    });
  });

  it('mapColors: the palette of the theme, the accent as the selection colour, the muted text as the root badge', () => {
    expect(mapColors({ dark: true, accent: 'rgb(1, 2, 3)', muted: 'rgb(4, 5, 6)' })).toEqual({ palette: DARK_PALETTE, selection: 'rgb(1, 2, 3)', rootBadge: 'rgb(4, 5, 6)' });
    expect(mapColors({ dark: false, accent: '#7852ee', muted: '#5c5c5c' }).palette).toBe(LIGHT_PALETTE);
  });
});
