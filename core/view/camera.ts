/**
 * Camera math for the viewport: pan/zoom state { tx, ty, s } (world -> screen: x*s + tx), the dot
 * grid, keep-in-view, fit and the opening view. Pure functions; the editor applies the results to
 * the DOM (one transform on the world element, two background properties on the viewport).
 */
export interface Camera {
  readonly tx: number;
  readonly ty: number;
  readonly s: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Keep-in-view pan animation length. */
export const PAN_ANIMATION_MS = 140;

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** Zoom to `s2` (clamped) keeping the screen point (cx, cy) over the same world point. */
export function zoomAround(view: Camera, cx: number, cy: number, s2: number): Camera {
  const s = clamp(s2, MIN_ZOOM, MAX_ZOOM);
  const k = s / view.s;
  return { tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k, s };
}

/** Dot grid spacing on screen: scaled with the zoom, doubled while under 11 px to avoid moire. */
export function dotGridSpacing(spacing: number, s: number): number {
  let g = spacing * s;
  while (g < 11) g *= 2;
  return g;
}

/**
 * Minimal pan that brings the node box inside the viewport minus a margin (48 px, less on tiny
 * viewports; the left/top edge wins when the box is larger than the viewport). null = already visible.
 */
export function keepInViewDelta(L: Rect, view: Camera, vw: number, vh: number): { dx: number; dy: number } | null {
  if (!vw || !vh) return null;
  const m = Math.min(48, vw / 4, vh / 4);
  const x0 = L.x * view.s + view.tx;
  const y0 = L.y * view.s + view.ty;
  const x1 = x0 + L.w * view.s;
  const y1 = y0 + L.h * view.s;
  let dx = 0;
  let dy = 0;
  if (x1 > vw - m) dx = vw - m - x1;
  if (x0 + dx < m) dx = m - x0;
  if (y1 > vh - m) dy = vh - m - y1;
  if (y0 + dy < m) dy = m - y0;
  return dx || dy ? { dx, dy } : null;
}

/** The whole map centred, never above 100% (Mod+1, "Fit"). */
export function fitView(b: Rect, vw: number, vh: number): Camera {
  const m = Math.min(48, vw / 6, vh / 6);
  const s = clamp(Math.min((vw - 2 * m) / b.w, (vh - 2 * m) / b.h), MIN_ZOOM, 1);
  return { tx: (vw - b.w * s) / 2 - b.x * s, ty: (vh - b.h * s) / 2 - b.y * s, s };
}

/**
 * The view a freshly loaded map opens with: phones (< 600 px) fit; a map that fits at 100% is
 * centred; a medium map (fit scale >= 0.5) is fitted; a huge map opens at 100% with the root near
 * the left edge, vertically centred.
 */
export function openingView(b: Rect, root: Rect & { readonly cy: number }, vw: number, vh: number): Camera {
  const m = Math.min(48, vw / 6, vh / 6);
  if (vw < 600) return fitView(b, vw, vh);
  if (b.w + 2 * m <= vw && b.h + 2 * m <= vh) return { tx: (vw - b.w) / 2 - b.x, ty: (vh - b.h) / 2 - b.y, s: 1 };
  const fitScale = Math.min((vw - 2 * m) / b.w, (vh - 2 * m) / b.h);
  if (fitScale >= 0.5) return fitView(b, vw, vh);
  return { tx: Math.max(m - b.x, m) - root.x, ty: vh / 2 - root.cy, s: 1 };
}

/** Ease-out cubic, p in [0, 1]. */
export const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;

/** Screen point -> world point. */
export function toWorld(view: Camera, sx: number, sy: number): [number, number] {
  return [(sx - view.tx) / view.s, (sy - view.ty) / view.s];
}

/** World point -> screen point. */
export function toScreen(view: Camera, wx: number, wy: number): [number, number] {
  return [wx * view.s + view.tx, wy * view.s + view.ty];
}
