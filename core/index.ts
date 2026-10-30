/**
 * @markmind/core: the editor core shared by the desktop and web shells.
 *
 * Rules for this package:
 *  - ZERO runtime dependencies (enforced: package.json "dependencies" must stay empty).
 *  - Pure, small modules; no DOM access outside src/render and src/view.
 *  - Every rule in docs/ARCHITECTURE.md has a test next to its implementation.
 *
 * Sub-areas (each is a folder with its own index.ts re-exporting its public surface):
 *  - format  : Markdown reader/writer (ONE .md file: H1 root + tab-indented bullets)
 *  - model   : immutable tree over the format's MapNode objects (ids in a WeakMap), edited by path copying
 *  - layout  : mind-map geometry (band layout, text measurement interfaces)
 *  - render  : DOM/SVG output (theme, connectors, branch colours, DOM measurer, renderer)
 *  - input   : the keymap table, the edit-session rules, clipboard and drop-target rule (pure)
 *  - nav     : spatial navigation between nodes
 *  - history : snapshot undo/redo with coalescing
 *  - view    : the composed editor the shells mount (mountEditor) and its camera math
 *
 * The stylesheet is a separate export: `import '../core/view/editor.css'`.
 */

export const VERSION = '0.1.1' as const;

export * from './format/index.js';
export * from './model/index.js';
export * from './layout/index.js';
export * from './render/index.js';
export * from './input/index.js';
export * from './nav/index.js';
export * from './history/index.js';
export * from './view/index.js';
