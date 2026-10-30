/** view: the composed editor the shells mount (mountEditor), its camera math and its public types. */
export { detectMac, mountEditor } from './editor.js';
export { MAX_ZOOM, MIN_ZOOM, PAN_ANIMATION_MS, clamp, dotGridSpacing, easeOutCubic, fitView, keepInViewDelta, openingView, toScreen, toWorld, zoomAround } from './camera.js';
export type { Camera, Rect } from './camera.js';
export type {
  ApplyMarkdownOptions,
  EditorAction,
  HostKey,
  PlusRect,
  EditOptions,
  EditorDebug,
  EditorHandle,
  EditorOptions,
  EditorSnapshot,
  EditorStats,
  FileInfo,
  HandleState,
  NodeBox,
  OverlayState,
  PerfResult,
  PlusState,
  ViewInfo,
  ViewSnapshot,
  ViewState,
  WheelInfo,
} from './types.js';
