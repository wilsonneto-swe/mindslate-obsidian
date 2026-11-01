/** render: connector geometry, sticky branch colours, the theme, the DOM measurer, the collapse handles, the "+" buttons and the DOM/SVG renderer. */
export type { ElementFactory } from './element.js';
export { DEFAULT_COLORS, FONT_FAMILY, PALETTE, THEME, resolveColors, strokeFor } from './theme.js';
export type { MapColors, Theme, ThemeColors } from './theme.js';
export { bezier, buildConnectors, fanSegment, previewPath } from './connectors.js';
export type { Connector } from './connectors.js';
export { BranchColors, branchColorOf } from './colors.js';
export { createDomMeasurer } from './dom-measure.js';
export type { DomMeasurer, MeasurePair } from './dom-measure.js';
export {
  BADGE_DIGIT_W,
  BADGE_GAP,
  BADGE_PILL_PAD,
  BADGE_SIZE,
  RING_HIT,
  RING_R,
  RING_REACH,
  RING_STROKE,
  badgeRect,
  badgeWidth,
  boundsWithHandles,
  boxWithHandle,
  handleKind,
  handleRect,
  hiddenCount,
  isPill,
  ringCenter,
} from './handles.js';
export type { HandleKind } from './handles.js';
export { PLUS_BADGE_GAP, PLUS_LEAF_GAP, PLUS_MAX_OFFSET, PLUS_MIN_ZOOM, PLUS_SIZE, freeBelow, plusSpots, underBand } from './plus.js';
export type { PlusInput, PlusKind, PlusSpot, PlusSpots } from './plus.js';
export { MapRenderer, SVGNS, pathKey } from './renderer.js';
export type { BadgeView, NodeView, RenderInput, RingView } from './renderer.js';
