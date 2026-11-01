/// <reference lib="dom" />
/**
 * The composed DOM + SVG mind-map editor: mountEditor(container, options) -> EditorHandle.
 *
 * A faithful port of the verified web demo's editor.js, built from the pure modules of this package:
 * model (immutable tree over the format's MapNode objects, ids in a WeakMap), layout (band layout,
 * memoised per node object), render (DOM measurer, connectors, sticky branch colours, the diffing
 * renderer), input (keymap table, edit-session rules, clipboard, drop-target rule), nav and history.
 * All state lives in this closure; the shells only talk to the handle.
 *
 * The document: `doc = parseDocument(text, { basename })`, `root = doc.root`. Every edit path-copies
 * by spreading, so untouched subtrees keep the parsed objects and `serializeDocument(doc, root)`
 * re-emits their raw lines byte for byte and keeps their bodies. getMarkdown() is cached per
 * (root, doc) with a structural shortcut, so collapsing/expanding (view state, never an undo step)
 * never changes the text unless the file itself persists folds.
 *
 * Collapse handles (render/handles.ts): a ring on the stub of an expanded node (shown while the node, its
 * hover bridge or the ring is hovered and while the node is selected; a click collapses) and a count badge on
 * a collapsed node (always shown; a click expands). Both toggle on the RELEASE of a press that stayed a click
 * or a tap (beginHandlePress / handleUp); a press on a handle never pans, drags or edits, and a click on one
 * moves the map only when the node's box is cut off by the viewport's edge (revealIfClipped).
 *
 * Multi-selection: `sel` is the PRIMARY node (the keyboard acts on it) and `others` the other selected nodes
 * (input/selection.ts). Shift+click and Mod+click toggle a node, Shift+drag on the empty canvas draws a marquee, Mod+A
 * selects every visible node, Esc goes back to the primary. Delete, Alt+Up / Alt+Down,
 * Mod+/, Mod+C / Mod+X, a drag of a selected node and the selection bar act on every top-level selected node but the
 * root (model/batch.ts), each in ONE undo step (folding is view state, as for one node). A single selected node on an
 * editable map shows two "+" buttons where Tab's child and Enter's sibling would appear (render/plus.ts).
 *
 * REST: a click or a tap on the empty canvas that does not move (no pan) leaves nothing shown as selected, for reading:
 * no selection mark, no "+" buttons, no active descendant. `sel` stays the keyboard's anchor. The first key that acts
 * on the selection (an arrow, Tab, Enter, typing, Space, F2, Delete, Mod+/, Mod+D, Alt+Up / Alt+Down, Mod+C / X / V,
 * or a host's perform()) only shows the selection again on that node, so the user sees what the next key acts on;
 * a click on a node selects it, and Mod+A, a marquee, Undo and Redo show what they select.
 */
import { baseName, newFileText, parseDocument } from '../format/index.js';
import type { MapDocument, MapNode } from '../format/types.js';
import { History } from '../history/history.js';
import { parseClipboard, pasteAsOneNodeText, subtreeToMarkdown, subtreesToMarkdown } from '../input/clipboard.js';
import { dropTarget, insertionPoint, isNoop, subtreeIds, type DropTarget } from '../input/dragdrop.js';
import { commitText, liveToModelText, resolveEndEdit } from '../input/edit-session.js';
import { keyToCommand, preventsDefault, type KeyCommand } from '../input/keymap.js';
import { addNodes, clickToggle, marqueeHits, marqueeSelection, type NodeSelection } from '../input/selection.js';
import { createLayoutEngine } from '../layout/engine.js';
import { depthClass, type Layout, type LayoutNode, type MeasureText, type TextMetrics, type TextStyle } from '../layout/types.js';
import * as B from '../model/batch.js';
import { writeDocument } from '../model/document.js';
import { idOf } from '../model/ids.js';
import * as T from '../model/tree.js';
import { navigate } from '../nav/navigate.js';
import { BranchColors } from '../render/colors.js';
import { fanSegment, previewPath } from '../render/connectors.js';
import { createDomMeasurer, type MeasurePair } from '../render/dom-measure.js';
import { BADGE_SIZE, boundsWithHandles, boxWithHandle, isPill } from '../render/handles.js';
import { PLUS_MIN_ZOOM, plusSpots, type PlusKind, type PlusSpots } from '../render/plus.js';
import { MapRenderer, SVGNS } from '../render/renderer.js';
import { THEME, resolveColors, strokeFor, type MapColors } from '../render/theme.js';
import { MAX_ZOOM, MIN_ZOOM, PAN_ANIMATION_MS, clamp, dotGridSpacing, easeOutCubic, fitView, keepInViewDelta, openingView, zoomAround } from './camera.js';
import type {
  ApplyMarkdownOptions,
  EditorAction,
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
  ViewSnapshot,
  ViewState,
  WheelInfo,
} from './types.js';

const EMPTY_W = 12; // width reserved for the caret of an empty node
const DRAG_THRESHOLD: Readonly<Record<string, number>> = { mouse: 4, pen: 4, touch: 8 }; // px of pointer travel that turns a press into a drag
const GHOST_CHARS = 28; // the drag ghost shows the first line of the text, truncated to this many characters
const DOUBLE_CLICK_MS = 1000; // a dblclick this soon after the click-again that started an edit completes that click
const PLUS_DOUBLE_MS = 500; // a press this soon after a click on a "+" (and as close) is the second click of a double-click
const MARQUEE_THRESHOLD = 4; // px a Shift+press on the canvas travels before the marquee shows
const NO_OTHERS: readonly string[] = Object.freeze([]);
/** REST: the key commands that act on the selection (or start from it); while resting they only show it again. */
const ACTS_ON_SELECTION: ReadonlySet<KeyCommand['type']> = new Set<KeyCommand['type']>([
  'arrow',
  'select-parent',
  'add-child',
  'add-sibling',
  'add-parent',
  'start-edit',
  'type-to-replace',
  'delete',
  'toggle-collapse',
  'duplicate',
  'reorder',
]);
let instanceSeq = 0;

/** Mod = Cmd? Detected from the browser when the shell passes no `isMac` option. */
export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

interface StartEditOptions {
  /** Select the whole text (typing replaces it). */
  readonly replace?: boolean;
  /** Caret at this client point (click again / double-click). */
  readonly point?: readonly [number, number];
}

interface EndEditOptions {
  /** Keep a still-empty brand-new node (Tab/Enter chain another new node onto it). */
  readonly keepEmpty?: boolean;
  /** Give the keyboard focus back to the viewport (false on a blur). */
  readonly refocus?: boolean;
  /** Esc: revert instead of committing. */
  readonly cancel?: boolean;
  /** Bring the selection into view when the edit's node goes away (false at a press on a collapse handle). */
  readonly reveal?: boolean;
}

interface Drag {
  /** The dragged nodes: the pressed one, or every top-level selected node but the root (a group), in document order. */
  readonly ids: readonly string[];
  /** The dragged subtrees (every visible node in them): never a drop target. */
  readonly excluded: Set<string>;
  readonly rect: DOMRect;
  readonly l1: readonly string[];
  readonly ghost: HTMLDivElement;
  /** Ghost chip size, read once when the drag starts: dragMove clamps the chip inside the viewport without a layout. */
  readonly gw: number;
  readonly gh: number;
  readonly bar: SVGRectElement;
  readonly link: SVGPathElement;
  /** The incoming fans that lead only to dragged level-2+ nodes (dimmed whole)... */
  readonly fans: readonly SVGPathElement[];
  /** ...and the canvas-coloured covers over the own segments of dragged nodes that have siblings that stay. */
  readonly covers: readonly SVGPathElement[];
  target: DropTarget | null;
  parentEl: HTMLElement | null;
  key: string;
  /** Last pointer position: a wheel pan/zoom during the drag re-aims the preview at it. */
  lastX: number;
  lastY: number;
}

/** A client point (a PointerEvent, or the last pointer position re-used after a wheel pan). */
interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

interface Press {
  readonly id: string;
  readonly pid: number;
  readonly type: string;
  readonly x0: number;
  readonly y0: number;
  editOnUp: boolean;
  /**
   * The press began on a node of a multi-selection: a drag moves every top-level selected node as one group, a click
   * (no drag) selects only the pressed node.
   */
  readonly group: boolean;
  /** The pointer travelled past the drag threshold: whatever it became, the release is no click. */
  moved: boolean;
  drag: Drag | null;
  /** A read-only map refused this press's drag (onReadOnly fired once for it). */
  refused: boolean;
}

/** Shift+drag on the empty canvas: a marquee whose touched node boxes join the selection on release. */
interface Marquee {
  readonly pid: number;
  readonly el: HTMLDivElement;
  /** The viewport's client rect at the start (the marquee is drawn in its coordinates, without a layout read per move). */
  readonly rect: DOMRect;
  /** Where it started, in world coordinates: a wheel pan or zoom during the marquee keeps that corner on the map. */
  readonly wx: number;
  readonly wy: number;
  /** ... and in client coordinates (the movement threshold). */
  readonly x0: number;
  readonly y0: number;
  /** The selection when it started (the marquee adds to it). */
  readonly base: NodeSelection;
  /** The node boxes it touches now, in document order. */
  hits: readonly string[];
  /** The selection it would make now (input/selection.ts marqueeSelection), shown on the map while it grows. */
  next: NodeSelection;
  /** ...its other nodes, as the renderer takes them. */
  preview: ReadonlySet<string>;
  moved: boolean;
  lastX: number;
  lastY: number;
}

/** What a held collapse handle or "+" button does on its click: collapse, expand, add a child, add a sibling below. */
type HandleKind = 'ring' | 'badge' | PlusKind;

/**
 * A primary pointer held down on a collapse handle (ring or badge) or a "+" button. The action waits for the release of
 * the same pointer and happens only when the press stayed a click or a tap (see beginHandlePress / handleUp).
 */
interface HandlePress {
  /** The handle's node (null when the commit at the press removed it). */
  readonly id: string | null;
  /** A ring (collapses its node), a badge (expands it) or a "+" button (adds a child or a sibling below). */
  readonly kind: HandleKind;
  readonly pid: number;
  readonly type: string;
  readonly x0: number;
  readonly y0: number;
  /** The pointer travelled past the drag threshold: no longer a click or a tap. */
  moved: boolean;
  /** The pressed handle element (marked .mm-pressed while held). */
  readonly el: HTMLElement | null;
  /** The camera and the layout at the press: when either changes, the release hit-tests the handle again. */
  readonly tx: number;
  readonly ty: number;
  readonly s: number;
  readonly lay: Layout;
}

interface MdCache {
  readonly root: MapNode | null;
  readonly doc: MapDocument | null;
  readonly text: string;
}

const nonNull = <X>(x: X | null | undefined): x is X => x !== null && x !== undefined;

/**
 * A shadow root, told by its node type rather than `instanceof ShadowRoot`: that constructor belongs to one window, and
 * an editor mounted in another one (a popout window, an iframe) has nodes of that window's classes.
 */
const isShadowRoot = (n: Node): n is ShadowRoot => n.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && 'host' in n;

export function mountEditor(container: HTMLElement, options: EditorOptions): EditorHandle {
  const theme = THEME;
  const make = options.createElement;
  const instance = ++instanceSeq;
  const isMac = options.isMac ?? detectMac();
  const ac = new AbortController();
  const sig: AddEventListenerOptions = { signal: ac.signal };
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (ev: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void => el.addEventListener(type, fn, { ...opts, ...sig });

  // ---------- DOM ----------
  const rootEl = make('div');
  rootEl.className = 'mm-root';
  const viewport = make('div');
  viewport.className = 'mm-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'tree');
  viewport.setAttribute('aria-label', 'Mind map');
  viewport.setAttribute('aria-multiselectable', 'true');
  const world = make('div');
  world.className = 'mm-world';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mm-edges');
  svg.setAttribute('aria-hidden', 'true');
  const gPaths = document.createElementNS(SVGNS, 'g');
  gPaths.setAttribute('class', 'mm-paths');
  svg.appendChild(gPaths);
  const gOverlay = document.createElementNS(SVGNS, 'g'); // drop preview (insertion bar + dashed connector) during a drag
  gOverlay.setAttribute('class', 'mm-overlay');
  svg.appendChild(gOverlay);
  world.appendChild(svg);
  // The "+" buttons of a single selected node (render/plus.ts): world coordinates (they pan and zoom with the map),
  // painted above the nodes; not in the Tab order (keyboard users have Tab and Enter) and hidden from assistive tech
  // (the keys carry the same actions).
  const plusLayer = make('div');
  plusLayer.className = 'mm-plus-layer';
  plusLayer.setAttribute('aria-hidden', 'true');
  const mkPlus = (kind: PlusKind, title: string): HTMLDivElement => {
    const el = make('div');
    el.className = 'mm-plus';
    el.dataset['kind'] = kind;
    el.title = title;
    plusLayer.appendChild(el);
    return el;
  };
  const plusChild = mkPlus('child', 'Add a child (Tab)');
  const plusSibling = mkPlus('sibling', 'Add a sibling (Enter)');
  world.appendChild(plusLayer);
  const plusLink = document.createElementNS(SVGNS, 'path'); // the dashed preview from the node to a hovered "+"
  plusLink.setAttribute('class', 'mm-plus-link');
  plusLink.setAttribute('visibility', 'hidden');
  gOverlay.appendChild(plusLink);
  viewport.appendChild(world);
  const measureHost = make('div');
  measureHost.className = 'mm-measure';
  measureHost.setAttribute('aria-hidden', 'true');
  // The selection bar (2+ selected nodes): bottom centre of the map, over it (a sibling of the viewport, so a press on
  // it is never a press on the canvas); its buttons never take the keyboard focus from the map.
  const modName = isMac ? 'Cmd' : 'Ctrl';
  const selBar = make('div');
  selBar.className = 'mm-selbar';
  selBar.setAttribute('role', 'toolbar');
  selBar.setAttribute('aria-label', 'Selection');
  const selCount = make('span');
  selCount.className = 'mm-selbar-count';
  const barSep = (): HTMLSpanElement => {
    const sep = make('span');
    sep.className = 'mm-selbar-sep';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  };
  const barButton = (cls: string, text: string, title: string): HTMLButtonElement => {
    const b = make('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.tabIndex = -1;
    return b;
  };
  const selDelete = barButton('mm-selbar-delete', 'Delete', 'Delete the selected nodes with their subtrees (Delete)');
  const selFold = barButton('mm-selbar-fold', 'Collapse', `Collapse the selected nodes (${modName}+/)`);
  const selClear = barButton('mm-selbar-clear', '×', 'Clear selection (Esc)');
  selClear.setAttribute('aria-label', 'Clear selection');
  selBar.append(selCount, barSep(), selDelete, selFold, barSep(), selClear);
  rootEl.appendChild(viewport);
  rootEl.appendChild(selBar);
  rootEl.appendChild(measureHost);
  container.appendChild(rootEl);
  const domId = (id: string): string => `mm-${instance}-${id}`; // element ids never collide between two mounts

  // ---------- state ----------
  const measureDom = createDomMeasurer(measureHost, make);
  // an empty node reserves caret width, unless the live label (Shift+Enter in an empty node) says otherwise
  const measure: MeasureText = (text: string, st: TextStyle): TextMetrics =>
    text === '' ? (measureDom.peek(text, st) ?? { width: EMPTY_W, height: st.lineHeight, lines: null }) : measureDom(text, st);
  const engine = createLayoutEngine({ theme, measureText: measure, mode: 'right' });
  const renderer = new MapRenderer(viewport, world, gPaths, theme, domId, make);
  // the colours painted from script (render/theme.ts MapColors): the host's, else the dark theme's (setColors)
  let paints = resolveColors(options.colors);
  renderer.paint = paints;
  let colors = new BranchColors(paints.palette);
  // the keys the host keeps for itself (EditorOptions.hostKeys): neither acted on nor prevented
  const hostKeys: ReadonlySet<string> = new Set(options.hostKeys ?? []);
  // Definitely assigned (`!`) by load(), which mountEditor calls before it returns: nothing reads them earlier (the
  // listeners and observers registered before that call only run in later tasks).
  let doc!: MapDocument; // parsed file wrapper (source, provenance, eol, indent unit...)
  let root!: MapNode; // the tree: doc.root after load, then path copies of it
  let lay!: Layout; // the layout of `root` (relayout)
  let history!: History<EditorSnapshot>; // undo/redo snapshots of { root, sel, doc }
  let fileName = options.fileName ?? 'Untitled.md';
  let readOnly = options.readOnly ?? false;
  let savedMarkdown = ''; // file text as loaded / last marked saved: dirty = getMarkdown() !== savedMarkdown
  let mdCache: MdCache = { root: null, doc: null, text: '' };
  let lastNotified: MapNode | null = null; // root object the last onChange was computed for
  let lastNotifiedText: string | null = null; // ...and the text it carried: onChange fires only when the TEXT changes (collapse never does)
  let notifiedZoom = NaN; // onView fires when the zoom changes, not on every pan/animation frame
  let heightFallback = false; // mounted into a container without a height: a min-height was applied once
  let sel = '';
  /** REST: nothing is shown as selected after a click on the empty canvas; `sel` is still the keyboard's anchor. */
  let resting = false;
  // the other selected nodes of a multi-selection, oldest first (never `sel`; only visible nodes: relayout prunes them)
  let others = new Set<string>();
  let editingId: string | null = null;
  // at startEdit: the text (a session that changes nothing leaves no undo step), the history's open key, and the tree
  // (the objects a live measurement may have been laid out with, see endEdit)
  let editStart: { readonly text: string; readonly openKey: string | null; readonly root: MapNode } | null = null;
  const creationStep = new Map<string, EditorSnapshot | null>(); // node id -> history step (its "before" snapshot) that created it: brand-new nodes left empty are removed again
  const lastChild = new Map<string, string>();
  const view = { tx: 0, ty: 0, s: 1 };
  let primed = new WeakMap<MapNode, number>(); // node object -> depth class already handed to the measurer
  let anim = 0;
  const perfStats = { lastUpdateMs: 0, lastInputMs: 0, inputTimings: [] as number[], dragMoveTimings: [] as number[] };
  let destroyed = false;
  let vpW = 0;
  let vpH = 0; // viewport size, kept by the ResizeObserver so layout-time reads stay off the hot path
  let openedHidden = false; // load() ran while the viewport had no size (display:none host): re-measure + centre when it shows
  let unstyled = false; // mounted before editor.css applied: re-measure + centre once it does (watchStyles)
  let styleRaf = 0;
  let lastWheel: WheelInfo | null = null;
  let renders = 0; // render() calls (getStats: a pan, zoom, hover or drag must not add any)
  let measuring = false; // debug.perf() is typing into the map: no onChange, no onEditing
  let marquee: Marquee | null = null; // a Shift+drag on the empty canvas in progress
  let panMoving = false; // a canvas pan that has moved the map (no "+" buttons meanwhile)
  let zoomedOut = false; // the zoom is below PLUS_MIN_ZOOM: no "+" buttons
  // the last click on a "+" button: a second press there that soon is the rest of a double-click (see pointerdown)
  let plusClick: { readonly at: number; readonly x: number; readonly y: number; readonly type: string } | null = null;
  // restoreViewSnapshot() while the map waits for a re-measure (mounted unstyled or hidden): the camera centerOnOpen
  // puts back instead of the opening view (and `reveal`: the selection was whole on screen, KEEP-CAMERA); load() drops it
  let pendingView: { readonly s: number; readonly tx: number; readonly ty: number; readonly reveal: boolean } | null = null;

  const rootId = (): string => idOf(root);
  // the multi-selection rides along in the snapshots: Undo of a batch delete or move selects those nodes again
  const snap = (): EditorSnapshot => ({ root, sel, doc, others: others.size ? [...others] : NO_OTHERS });
  /** The selection as the pure helpers take it (input/selection.ts); while resting, nothing chosen yet (the root alone). */
  const selection = (): NodeSelection => (resting ? { primary: rootId(), others: [] } : { primary: sel, others: [...others] });
  /** The node drawn as selected: none while resting (REST). */
  const shownSel = (): string | null => (resting ? null : sel);
  /** A marquee's primary as drawn: while resting, none until the marquee touches a node. */
  const marqueeShown = (m: Marquee): string | null => (resting && m.hits.length === 0 ? null : m.next.primary);
  /** Every selected node, the primary first. */
  const selectedAll = (): string[] => [sel, ...others];
  /**
   * The nodes a batch action takes (Delete, Alt+Up / Alt+Down, Mod+X, a group drag): every selected node but the root,
   * top-level only (a node whose ancestor is selected too goes along with it), in document order.
   */
  const batchIds = (): string[] => B.topLevel(root, selectedAll().filter((id) => id !== rootId()));
  /**
   * A selection the user can see: `id` itself when every ancestor is expanded, else its OUTERMOST collapsed
   * ancestor (the nearest node that is shown). The collapse state is never changed for it: collapse is view
   * state the user chose (and in a file that persists folds, part of the bytes).
   */
  function visibleSelection(r: MapNode, id: string): string {
    const idx = T.indexOf(r);
    let shown = id;
    for (let p = idx.get(id)?.parentId ?? null; p !== null; p = idx.get(p)?.parentId ?? null) {
      if (idx.get(p)?.node.collapsed) shown = p;
    }
    return shown;
  }
  /**
   * Undo/redo (and dropping a step) restore the DOCUMENT and the selection, never the view: the collapse
   * state the user has now is carried over onto the restored tree, and the history's present follows. A node
   * the current tree does not hold (a deleted or cut subtree that the undo brings back) keeps the collapse
   * state it has in the snapshot: in a file that persists folds that is its fold suffix, part of the bytes.
   * The restored selection is always visible (visibleSelection: a selection inside a branch collapsed since
   * moves to that branch), so the keys act on a node the user sees and Delete never removes one they cannot see.
   */
  function restore(st: EditorSnapshot): void {
    const current = T.indexOf(root);
    const ids = T.collapsedIds(root);
    for (const id of T.collapsedIds(st.root)) if (!current.has(id)) ids.add(id);
    root = T.withCollapsed(st.root, ids);
    sel = visibleSelection(root, st.sel);
    resting = false; // Undo / Redo show the selection they restore
    others = new Set((st.others ?? NO_OTHERS).filter((id) => id !== sel)); // hidden ones leave at the relayout
    doc = st.doc;
    history.replacePresent(snap());
  }
  const exists = (id: string): boolean => T.indexOf(root).has(id);
  /** A node created in this session, never committed with text, whose creation is still the latest history step. */
  function isFreshEmpty(id: string, r: MapNode = root): boolean {
    const e = T.indexOf(r).get(id);
    const step = creationStep.get(id);
    return e !== undefined && e.node.text === '' && step !== undefined && step !== null && step === history.lastStep;
  }
  function viewportSize(): [number, number] {
    if (!vpW || !vpH) {
      vpW = viewport.clientWidth;
      vpH = viewport.clientHeight;
    }
    return [vpW, vpH];
  }

  // ---------- layout + render ----------
  function visiblePairs(): MeasurePair[] {
    const out: MeasurePair[] = [];
    const walk = (n: MapNode, d: number): void => {
      const dc = depthClass(d);
      if (primed.get(n) !== dc) {
        if (n.text !== '') out.push({ text: n.text, st: theme.styles[dc] });
        primed.set(n, dc);
      }
      if (!n.collapsed) for (const c of n.children) walk(c, d + 1);
    };
    walk(root, 0);
    return out;
  }
  function relayout(): void {
    measureDom.prime(visiblePairs()); // batch: one forced reflow for every new/changed text
    lay = engine.layout(root);
    colors.sync(root.children.map((c) => idOf(c)));
    pruneOthers();
  }
  /**
   * Only nodes the user sees stay selected: a node removed, or hidden in a branch folded since, leaves the
   * multi-selection (Delete must never remove a node the user cannot see).
   */
  function pruneOthers(): void {
    if (others.size === 0) return;
    let changed = false;
    for (const id of others) {
      if (id !== sel && lay.nodes.has(id)) continue;
      others.delete(id);
      changed = true;
    }
    if (changed && history.present.root === root) history.replacePresent(snap());
  }
  const level1Ids = (): readonly string[] => lay.nodes.get(rootId())?.childIds ?? [];
  const branchColor = (L: LayoutNode, l1: readonly string[] = level1Ids()): string => renderer.branchColor(L, l1, colors);
  function render(): void {
    renders++;
    renderer.render({ lay, index: T.indexOf(root), sel: marquee !== null ? marqueeShown(marquee) : shownSel(), editingId, colors, multi: marquee?.preview ?? others });
    syncChrome();
  }
  /** The node objects from `id` up to the root of `r` (what a layout memo entry of `id` is part of). */
  function pathNodes(id: string, r: MapNode = root): MapNode[] {
    const idx = T.indexOf(r);
    const out: MapNode[] = [];
    for (let e = idx.get(id); e !== undefined; e = e.parentId === null ? undefined : idx.get(e.parentId)) out.push(e.node);
    return out;
  }
  /**
   * The .md text: byte-identical to the loaded/applied text until the DOCUMENT changes (memoised per tree +
   * wrapper). Collapsing/expanding creates a new tree object but not a new document, so a loose or numbered
   * file is never reformatted by it; `sameNodes` short-circuits on shared subtrees, so this is O(path) per
   * toggle. It compares ids too: a node swapped with its content-identical copy is the same document but
   * not the same nodes, and the writer gives each node its own bytes. A file that persists folds (R10f) is
   * the exception: there the writer handles the fold suffix.
   */
  function getMarkdown(): string {
    if (mdCache.root === root && mdCache.doc === doc) return mdCache.text;
    let text: string;
    if (mdCache.doc === doc && mdCache.root !== null && T.sameNodes(root, mdCache.root, doc.foldsInFile)) text = mdCache.text;
    else text = root === doc.root || T.sameNodes(root, doc.root, doc.foldsInFile) ? doc.bom + doc.source : writeDocument(doc, root);
    mdCache = { root, doc, text };
    return text;
  }
  function notify(): void {
    if (measuring) return;
    if (root !== lastNotified) {
      lastNotified = root;
      const text = getMarkdown();
      if (text !== lastNotifiedText) {
        lastNotifiedText = text;
        options.onChange?.(text);
      }
    }
    options.onState?.(getStats());
  }
  function update({ reveal = true }: { reveal?: boolean } = {}): void {
    const t0 = performance.now();
    relayout();
    render();
    perfStats.lastUpdateMs = performance.now() - t0;
    if (reveal) ensureVisible(sel);
    if (editingId === null) scheduleRehover(); // nodes may have moved under a still pointer (collapse, reorder, undo...)
    notify();
  }

  // ---------- viewport ----------
  /** The map's world bounds including the collapse handles (fit and the opening view frame them too). */
  function mapBounds(): { x: number; y: number; w: number; h: number } {
    const idx = T.indexOf(root);
    return boundsWithHandles(lay.bounds, lay.order, (id) => idx.get(id)?.node, theme.stub);
  }
  function applyView(): void {
    world.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.s})`;
    const g = dotGridSpacing(theme.colors.dotSpacing, view.s);
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${view.tx}px ${view.ty}px`;
    if (options.onView && view.s !== notifiedZoom) {
      // zoom changes only: a keep-in-view animation pans ~8 frames and must not make the host rewrite its DOM
      notifiedZoom = view.s;
      options.onView({ zoom: view.s, tx: view.tx, ty: view.ty });
    }
    if (view.s < PLUS_MIN_ZOOM !== zoomedOut) {
      zoomedOut = !zoomedOut;
      syncChrome(); // the "+" buttons hide below 50 % (they would be tiny) and come back above it
    }
    scheduleRehover(); // the map moved under the pointer: the ring follows the node that is under it now
  }
  // Any direct manipulation (wheel, drag, zoom, fit) cancels a running keep-in-view animation.
  const stopAnim = (): void => window.cancelAnimationFrame(anim);
  function zoomAt(cx: number, cy: number, s2: number): void {
    stopAnim();
    const z = zoomAround(view, cx, cy, s2);
    view.tx = z.tx;
    view.ty = z.ty;
    view.s = z.s;
    applyView();
  }
  const zoomCenter = (s2: number): void => {
    const [vw, vh] = viewportSize();
    zoomAt(vw / 2, vh / 2, s2);
  };
  function animateView(tx: number, ty: number, ms = PAN_ANIMATION_MS): void {
    window.cancelAnimationFrame(anim);
    const fx = view.tx;
    const fy = view.ty;
    const t0 = performance.now();
    const step = (t: number): void => {
      const p = Math.min(1, (t - t0) / ms);
      const e = easeOutCubic(p);
      view.tx = fx + (tx - fx) * e;
      view.ty = fy + (ty - fy) * e;
      applyView();
      if (p < 1) anim = window.requestAnimationFrame(step);
    };
    if (ms <= 0) {
      view.tx = tx;
      view.ty = ty;
      applyView();
    } else anim = window.requestAnimationFrame(step);
  }
  /**
   * Minimal pan that brings the node box (grown by its ring or badge: a selected node shows its handle) inside
   * the viewport minus a 48px margin (left/top edge wins).
   */
  function ensureVisible(id: string, ms = PAN_ANIMATION_MS): void {
    const L = lay.nodes.get(id);
    const n = T.indexOf(root).get(id)?.node;
    const [vw, vh] = viewportSize();
    if (!L || !n) return;
    const d = keepInViewDelta(boxWithHandle(L, n, theme.stub), view, vw, vh);
    if (d) animateView(view.tx + d.dx, view.ty + d.dy, ms);
  }
  /**
   * After a click on a collapse handle the map stays where it is (the handle was on screen). Only when the node's
   * box is cut off by the viewport's edge (its parents re-centred around the collapsed or expanded subtree and moved
   * it, or it was partly off screen already) does the usual keep-in-view bring it back. The new handle alone never
   * moves the map: a badge that appears partly past the right edge (it reaches 12 px further than the ring) stays.
   */
  function revealIfClipped(id: string, ms = PAN_ANIMATION_MS): void {
    const [vw, vh] = viewportSize();
    if (vw && vh && clippedIn(id, vw, vh)) ensureVisible(id, ms);
  }
  /** The node's box is cut off by (or outside) a viewport of this size with the current camera. */
  function clippedIn(id: string, vw: number, vh: number): boolean {
    const L = lay.nodes.get(id);
    if (!L) return false;
    const x0 = L.x * view.s + view.tx;
    const y0 = L.y * view.s + view.ty;
    return x0 < 0 || y0 < 0 || x0 + L.w * view.s > vw || y0 + L.h * view.s > vh;
  }
  function fitToScreen(): void {
    stopAnim();
    const [vw, vh] = viewportSize();
    if (!vw || !vh) return;
    const f = fitView(mapBounds(), vw, vh);
    view.s = f.s;
    view.tx = f.tx;
    view.ty = f.ty;
    applyView();
  }
  function centerOnOpen(): void {
    stopAnim();
    const [vw, vh] = viewportSize();
    if (!vw || !vh) {
      openedHidden = true; // nothing is rendered yet (display:none host): the ResizeObserver finishes the job
      return;
    }
    openedHidden = false;
    if (pendingView !== null) {
      // the host restored a camera before this re-measure (restoreViewSnapshot): that one, not the opening view
      const reveal = pendingView.reveal;
      view.s = pendingView.s;
      view.tx = pendingView.tx;
      view.ty = pendingView.ty;
      pendingView = null;
      applyView();
      if (reveal) revealIfClipped(sel, 0); // KEEP-CAMERA, now that the labels have their real size
      return;
    }
    const R = lay.nodes.get(rootId());
    if (!R) return;
    const o = openingView(mapBounds(), R, vw, vh);
    view.s = o.s;
    view.tx = o.tx;
    view.ty = o.ty;
    applyView();
  }

  // ---------- editing ----------
  function placeCaret(label: HTMLElement, replace: boolean, point: readonly [number, number] | undefined): void {
    const s = getSelection();
    if (s === null) return;
    let rg = document.createRange();
    if (replace) rg.selectNodeContents(label);
    else if (point !== undefined) {
      const pos = typeof document.caretPositionFromPoint === 'function' ? document.caretPositionFromPoint(point[0], point[1]) : null;
      if (pos !== null && label.contains(pos.offsetNode)) {
        rg.setStart(pos.offsetNode, pos.offset);
        rg.collapse(true);
      } else {
        const r2 = typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(point[0], point[1]) : null;
        if (r2 !== null && label.contains(r2.startContainer)) rg = r2;
        else {
          rg.selectNodeContents(label);
          rg.collapse(false);
        }
      }
    } else {
      rg.selectNodeContents(label);
      rg.collapse(false);
    }
    s.removeAllRanges();
    s.addRange(rg);
  }
  /** The map is read-only and the user tried to change it (EditorOptions.onReadOnly): nothing changes, the host is told. */
  function refused(): void {
    if (!measuring) options.onReadOnly?.();
  }
  let blurHandler: (() => void) | null = null;
  function startEdit(id: string, { replace = false, point }: StartEditOptions = {}): void {
    if (readOnly) {
      refused();
      return;
    }
    if (editingId === id) {
      // already editing this node (EditorHandle.edit() again, a double-click inside the label): the session
      // goes on (Esc still cancels to the text it started with); only the caret moves
      const cur = renderer.els.get(id);
      if (cur) {
        if (rootEl.ownerDocument.activeElement !== cur.label) cur.label.focus({ preventScroll: true });
        placeCaret(cur.label, replace, point);
      }
      return;
    }
    if (editingId !== null) endEdit();
    if (sel !== id || resting) select(id, { reveal: true }); // REST: a host's edit() shows the node it edits
    else clearOthers(); // typing, Space, F2, a click again: the primary node alone
    const r = renderer.els.get(id);
    if (!r) return;
    const e = T.indexOf(root).get(id);
    editingId = id;
    syncChrome(); // no "+" buttons while a label is edited
    editStart = { text: e ? e.node.text : '', openKey: history.openKey, root };
    r.el.classList.add('mm-editing');
    renderer.freeWidth(r); // the label grows with what is typed: no fixed width while it is edited
    try {
      r.label.contentEditable = 'plaintext-only';
    } catch {
      // the HTML spec (and Gecko before Firefox 136) throws a SyntaxError for an unknown value
    }
    if (r.label.contentEditable !== 'plaintext-only') r.label.contentEditable = 'true'; // Firefox < 136
    r.label.spellcheck = false;
    r.label.focus({ preventScroll: true });
    placeCaret(r.label, replace, point);
    const label = r.label;
    blurHandler = (): void => {
      if (editingId === id) endEdit({ refocus: false });
    };
    label.addEventListener('blur', blurHandler, sig);
    if (!measuring) options.onEditing?.(true);
    notify();
  }
  /**
   * Leave edit mode. Default: COMMIT what the label holds (Enter, Tab, blur, click-away, Mod+S, ...).
   * `cancel` (Esc): the text returns to what it was when this session started and the undo step the session
   * opened disappears; a node this very session created (Tab/Enter/Mod+Enter/Alt+Enter/Mod+D) is removed again,
   * typed text or not, together with the chain of still-empty new nodes it hangs on. The decision itself is
   * input/edit-session.ts `resolveEndEdit` (unit-tested); this function gathers the facts and applies the outcome.
   */
  function endEdit({ keepEmpty = false, refocus = true, cancel = false, reveal = true }: EndEditOptions = {}): void {
    const id = editingId;
    if (id === null) return;
    editingId = null;
    const start = editStart;
    editStart = null;
    const r = renderer.els.get(id);
    if (r) {
      if (blurHandler) r.label.removeEventListener('blur', blurHandler);
      blurHandler = null;
      r.label.contentEditable = 'false';
      r.el.classList.remove('mm-editing');
    }
    if (refocus) viewport.focus({ preventScroll: true });
    // live (zoomed, caret-line) measurements of this session go; the final text is measured once in the hidden host.
    // The layout memo of every object laid out with a live measurement goes too, or it would keep the live box: the
    // edited path of the current tree, and of the tree the session started from, whose objects a Shift+Enter that did
    // not change the model text (onInput) laid out live and which a cancel, a commit back to the starting text (both
    // restore that tree) or a later Undo brings back. Intermediate trees of the session are in no snapshot.
    measureDom.forgetLive();
    engine.invalidate(pathNodes(id));
    if (start !== null && start.root !== root) engine.invalidate(pathNodes(id, start.root));
    if (!measuring) options.onEditing?.(false);
    let e = T.indexOf(root).get(id);
    const session = 'edit:' + id;
    if (!cancel && e) {
      // what the file will hold (R7/R11): lines trimmed, empty lines dropped; the root is an H1 and one line
      const t = commitText(e.node.text, id === rootId());
      if (t !== e.node.text) {
        root = T.setText(root, id, t);
        history.push(snap(), session, sel); // coalesces into the session the typing opened
        e = T.indexOf(root).get(id);
      }
    }
    const step = creationStep.get(id);
    const action = resolveEndEdit({
      cancel,
      keepEmpty,
      exists: e !== undefined,
      text: e ? e.node.text : '',
      startText: start ? start.text : '',
      startOpenKey: start ? start.openKey : null,
      openKey: history.openKey,
      sessionKey: session,
      fresh: step !== undefined && step !== null && step === history.lastStep,
    });
    switch (action) {
      case 'revert-fresh':
      case 'drop-empty': {
        // The brand-new node goes (no undo step) - together with the brand-new empty nodes it was chained to
        // (Tab or Enter on an empty new node), so nothing empty is left behind.
        let st = history.dropStep();
        while (isFreshEmpty(st.sel, st.root)) st = history.dropStep();
        restore(st);
        remember(sel);
        update({ reveal });
        return;
      }
      case 'drop-step':
        if (r) r.text = null; // the label shows the live text: render() re-syncs it with the restored model
        restore(history.dropStep()); // the step this session opened goes: text, undo count, dirty, onChange as before
        update({ reveal: false });
        return;
      case 'close':
        if (r) r.text = null;
        history.close();
        update({ reveal: false });
        return;
      case 'commit':
        history.close();
        update({ reveal: false });
        return;
    }
  }
  function onInput(): void {
    if (editingId === null) return;
    const t0 = performance.now();
    const r = renderer.els.get(editingId);
    const L = lay.nodes.get(editingId);
    if (!r || !L) return;
    // plaintext-only keeps text nodes ("\n" for line breaks); fall back to innerText if markup sneaks in
    const live = r.label.childElementCount ? r.label.innerText : (r.label.textContent ?? '');
    // The browser keeps a trailing "\n" placeholder after a line break. It stays out of the model (and so
    // out of the file), but the live box must be as tall as the label: the measurement is cached for both.
    const text = liveToModelText(live);
    r.text = live;
    measureDom.setLive(live, theme.styles[depthClass(L.depth)], r.label, view.s, text);
    const next = T.setText(root, editingId, text);
    // Shift+Enter before any typing changes the label (a new, still empty line) but not the model text: the node
    // object stays the same, so its layout memo is dropped for the live box to be read again
    if (next === root) engine.invalidate(pathNodes(editingId));
    root = next;
    history.push(snap(), 'edit:' + editingId, sel);
    update();
    perfStats.lastInputMs = performance.now() - t0;
    perfStats.inputTimings.push(perfStats.lastInputMs);
    if (perfStats.inputTimings.length > 200) perfStats.inputTimings.shift();
  }

  // ---------- commands ----------
  /** Remember `id` as the last-visited child of its parent (ArrowRight returns to it). */
  function remember(id: string): void {
    const e = T.indexOf(root).get(id);
    if (e && e.parentId !== null) lastChild.set(e.parentId, id);
  }
  function commit(newRoot: MapNode, newSel: string, key: string | null = null): void {
    const before = sel;
    root = newRoot;
    sel = newSel;
    history.push(snap(), key, before);
    remember(newSel);
    update();
  }
  /** Select `id` alone (a click, the arrows, an edit...): a multi-selection goes back to that one node. */
  function select(id: string, { reveal = true }: { reveal?: boolean } = {}): void {
    if (!lay.nodes.get(id)) return;
    sel = id;
    resting = false;
    others.clear();
    history.push(snap()); // selection only: updates the present, never a step
    remember(id);
    render();
    if (reveal) ensureVisible(id);
    if (!measuring) options.onState?.(getStats());
  }
  /** A new multi-selection (a toggle, a marquee, Mod+A): view state only, the present follows (Undo restores it with a step). */
  function setSelection(next: NodeSelection): void {
    const changed = next.primary !== sel || next.others.length !== others.size || next.others.some((id) => !others.has(id));
    if (!changed && !resting) return;
    sel = next.primary;
    resting = false;
    others = new Set(next.others.filter((id) => id !== sel && lay.nodes.has(id)));
    history.replacePresent(snap());
    remember(sel);
    render();
    if (!measuring) options.onState?.(getStats());
  }
  /** Esc, a click on the empty canvas, the bar's ×, and the keys that act on the primary: back to the primary node alone. */
  function clearOthers(): void {
    if (others.size === 0) return;
    setSelection({ primary: sel, others: [] });
  }
  /** REST: a click or a tap on the empty canvas: nothing shown as selected; `sel` stays the keyboard's anchor. */
  function rest(): void {
    if (resting) return;
    resting = true;
    if (others.size) {
      others.clear();
      history.replacePresent(snap());
    }
    render();
    if (!measuring) options.onState?.(getStats());
  }
  /** REST ends on a key that acts on the selection: the selection shows again on its node, scrolled into view. */
  function wake(): void {
    if (!resting) return;
    resting = false;
    render();
    ensureVisible(sel);
    if (!measuring) options.onState?.(getStats());
  }
  /**
   * Shift+click / Mod+click on a node: in or out of the selection (the node toggled on becomes the primary). The root
   * selected alone counts as nothing chosen yet (input/selection.ts clickToggle).
   */
  function toggleSelected(id: string): void {
    if (lay.nodes.has(id)) setSelection(clickToggle(selection(), id, rootId()));
  }
  /** Mod+A: every visible node joins the selection; the primary stays the primary. */
  function selectAll(): void {
    setSelection(addNodes(selection(), lay.order.map((L) => L.id)));
  }
  /** Create an empty node with `fn` and start editing it; creation + typing share one undo step. */
  function create(fn: (n: MapNode) => MapNode): void {
    if (readOnly) {
      refused();
      return;
    }
    if (editingId !== null) endEdit({ keepEmpty: true });
    clearOthers(); // Tab, Enter and the "+" buttons act on the primary node alone
    const n = T.mkNode('');
    const id = idOf(n);
    commit(fn(n), id, 'edit:' + id); // creation opens the coalescing session for its typing
    creationStep.set(id, history.lastStep);
    startEdit(id);
  }
  const addChild = (id: string): void => create((n) => T.addChild(root, id, n));
  const addSibling = (id: string, where: 'before' | 'after'): void =>
    id === rootId() ? addChild(id) : create((n) => T.addSibling(root, id, n, where));
  function addParent(id: string): void {
    if (id === rootId()) {
      // new root above the current one: the old root becomes its only child
      create((n) => T.mkNode('', [root], { id: idOf(n) }));
      return;
    }
    create((n) => T.addParent(root, id, n));
  }
  function removeNode(id: string): void {
    if (readOnly) {
      refused();
      return;
    }
    if (id === rootId()) return;
    if (editingId !== null) endEdit({ keepEmpty: true });
    if (!exists(id)) return;
    commit(T.removeNode(root, id), T.selectionAfterDelete(root, id));
  }
  /**
   * Delete / Backspace, Mod+X and the bar's Delete on a multi-selection: every top-level selected node but the root goes
   * with its subtree, in ONE undo step (Undo brings them back selected). The selection moves to the nearest node that
   * stays: the previous sibling of the first removed node, else its next sibling that stays, else its parent.
   */
  function removeSelected(): void {
    if (readOnly) {
      refused();
      return;
    }
    if (editingId !== null) endEdit({ keepEmpty: true });
    const ids = batchIds();
    if (ids.length === 0) return;
    const next = B.selectionAfterRemove(root, ids);
    others.clear(); // the present keeps the selection: the undo step restores it
    commit(B.removeNodes(root, ids), next);
  }
  /** Alt+Up / Alt+Down on a multi-selection: each top-level selected node one step; adjacent ones as a block; ONE undo step. */
  function reorderSelected(delta: -1 | 1): void {
    if (readOnly) {
      refused();
      return;
    }
    const next = B.reorderNodes(root, batchIds(), delta);
    if (next !== root) commit(next, sel);
  }
  /**
   * Mod+/ (and the bar's Collapse / Expand) on a multi-selection: every selected node with children folds, or they all
   * unfold when all are folded (model/batch.ts foldPlan; never the root). View state, as for one node: no undo step,
   * no text change (except in a file that stores its folds). Selected nodes the fold hides leave the selection.
   */
  function foldSelected(): void {
    const plan = B.foldPlan(root, selectedAll());
    if (plan === null) return;
    const ids = T.collapsedIds(root);
    for (const id of plan.ids) {
      if (plan.collapse) ids.add(id);
      else ids.delete(id);
    }
    const next = T.withCollapsed(root, ids);
    if (next === root) return;
    root = next;
    sel = visibleSelection(root, sel); // a selected ancestor folded over the primary: that ancestor
    others.delete(sel);
    history.replacePresent(snap());
    remember(sel);
    update(); // the relayout drops the selected nodes the fold hides
  }
  /**
   * Collapse/expand is VIEW state (spec: session-only, never written): it replaces the history's present
   * without a step, leaves getMarkdown()/dirty untouched (see sameNodes) and therefore never fires onChange.
   */
  function setCollapsedView(id: string, collapsed: boolean, { reveal = true }: { reveal?: boolean } = {}): void {
    const next = T.setCollapsed(root, id, collapsed);
    if (next === root) return;
    root = next;
    sel = id;
    history.replacePresent(snap());
    remember(id);
    update({ reveal });
  }
  function toggleCollapse(id: string): void {
    const e = T.indexOf(root).get(id);
    if (e && e.node.children.length) setCollapsedView(id, !e.node.collapsed);
  }
  function expand(id: string, opts?: { reveal?: boolean }): void {
    const e = T.indexOf(root).get(id);
    if (e && e.node.collapsed) setCollapsedView(id, false, opts);
  }
  function collapse(id: string, opts?: { reveal?: boolean }): void {
    const e = T.indexOf(root).get(id);
    if (e && e.node.children.length && !e.node.collapsed) setCollapsedView(id, true, opts);
  }
  /**
   * A click or a tap on a collapse handle (the release of a press that stayed put, see beginHandlePress): the ring
   * collapses its node, the badge expands it (view state, as Mod+/). The edit in progress was committed at the press
   * (that may have removed a brand-new empty node, even the handle's own: then nothing toggles). The node ends up
   * selected and the keyboard focus on the map; the map moves only when the node's box is cut off (revealIfClipped).
   */
  function handleClick(id: string | null, kind: HandleKind): void {
    if (editingId !== null) endEdit({ reveal: false });
    if (kind === 'child' || kind === 'sibling') {
      // a "+" button: exactly what Tab / Enter do (an empty new node in edit mode: its label takes the focus)
      if (id === null || !exists(id)) viewport.focus({ preventScroll: true });
      else if (kind === 'child') addChild(id);
      else addSibling(id, 'after');
      return;
    }
    if (id !== null && exists(id)) {
      if (kind === 'ring') collapse(id, { reveal: false });
      else expand(id, { reveal: false });
      if (sel !== id || others.size || resting) select(id, { reveal: false }); // REST: the clicked node shows selected
      revealIfClipped(id);
    }
    viewport.focus({ preventScroll: true });
  }
  function duplicate(id: string): void {
    if (readOnly) {
      refused();
      return;
    }
    if (id === rootId()) return;
    if (editingId !== null) endEdit({ keepEmpty: true });
    clearOthers(); // Mod+D duplicates the primary node alone
    const e = T.indexOf(root).get(id);
    if (!e) return;
    const copy = T.cloneTree(e.node); // new ids on every node; spreads, so an explicit body is copied along
    const copyId = idOf(copy);
    commit(T.addSibling(root, id, copy, 'after'), copyId, 'edit:' + copyId);
    creationStep.set(copyId, history.lastStep); // brand-new like Tab/Enter: Esc before a commit removes it again
    startEdit(copyId, { replace: true });
  }
  function undo(): void {
    if (readOnly) {
      refused();
      return;
    }
    endEdit();
    const st = history.undo();
    if (st) {
      restore(st);
      remember(sel);
      update();
    } else notify();
  }
  function redo(): void {
    if (readOnly) {
      refused();
      return;
    }
    endEdit();
    const st = history.redo();
    if (st) {
      restore(st);
      remember(sel);
      update();
    } else notify();
  }
  function arrow(dir: 'left' | 'right' | 'up' | 'down'): void {
    const idx = T.indexOf(root);
    const e = idx.get(sel);
    if (!e) return;
    if (dir === 'left') {
      if (e.parentId !== null) select(e.parentId);
      return;
    }
    if (dir === 'right') {
      if (!e.node.children.length) return;
      if (e.node.collapsed) setCollapsedView(sel, false); // expand first (view state, no undo step)
      const to = navigate(lay, sel, 'right', lastChild); // last-visited child, else nearest vertically
      if (to !== sel) select(to);
      return;
    }
    if (e.parentId === null) return; // the root never moves up/down
    const sibs = idx.get(e.parentId)?.node.children ?? [];
    const j = e.index + (dir === 'down' ? 1 : -1);
    const target = sibs[j];
    if (target !== undefined) select(idOf(target)); // same parent only, no wrap
  }
  /** Shift+Tab: the parent of the current node (ending an edit first; a reverted empty node's parent still exists). */
  function selectParent(): void {
    const e = T.indexOf(root).get(sel);
    const parentId = e ? e.parentId : null;
    if (editingId !== null) endEdit();
    if (parentId !== null && exists(parentId)) select(parentId);
  }
  function pasteText(text: string): void {
    if (!text || editingId !== null) return;
    if (readOnly) {
      refused();
      return;
    }
    const nodes = parseClipboard(text);
    // pasted nodes are fresh objects with new ids (cloneTree spreads, so a body under a pasted item survives);
    // a text pasted as ONE node is stored as the file will hold it, like a committed edit (R7/R11: lines
    // trimmed, empty lines dropped), so the model never differs from what a save and a reload give back
    const one = nodes ? '' : commitText(pasteAsOneNodeText(text), false);
    if (!nodes && one === '') return;
    const kids = nodes ? nodes.map((n) => T.cloneTree(n)) : [T.mkNode(one)];
    const first = kids[0];
    if (first === undefined) return;
    others.clear(); // pasted under the primary node; the first pasted node is selected alone
    let r = root;
    for (const k of kids) r = T.addChild(r, sel, k);
    commit(r, idOf(first));
  }
  function reorder(delta: -1 | 1): void {
    if (readOnly) {
      refused();
      return;
    }
    commit(T.reorder(root, sel, delta), sel);
  }

  // ---------- input ----------
  /** The command a key stands for now, or null: not the editor's, or one the host keeps (EditorOptions.hostKeys). */
  function commandOf(e: KeyboardEvent): KeyCommand | null {
    const cmd = keyToCommand(e, { isMac, editing: editingId !== null, dragging: (press !== null && press.drag !== null) || marquee !== null });
    return cmd !== null && hostKeys.has(cmd.type) ? null : cmd;
  }
  function onKeyDown(e: KeyboardEvent): void {
    const cmd = commandOf(e);
    if (cmd === null) return;
    if (preventsDefault(cmd) || (resting && ACTS_ON_SELECTION.has(cmd.type))) e.preventDefault(); // REST: no keystroke goes anywhere either
    run(cmd);
  }
  /** Run a key command (onKeyDown) or an action a host asked for (EditorHandle.perform): the same code path. */
  function run(cmd: KeyCommand): void {
    if (resting && ACTS_ON_SELECTION.has(cmd.type)) {
      wake(); // REST: this key only shows the selection again, on the node the keyboard left
      return;
    }
    const id = editingId; // the node being edited: commands that commit first then act on it
    switch (cmd.type) {
      case 'native':
      case 'swallow':
        return;
      case 'cancel-drag':
        cancelPress();
        cancelMarquee();
        return;
      case 'select-all':
        selectAll();
        return;
      case 'clear-selection':
        clearOthers();
        return;
      case 'line-break':
        // plaintext-only: insertLineBreak inserts "\n" text (+ a trailing placeholder "\n");
        // insertText('\n') would create a <div><br></div> instead.
        document.execCommand('insertLineBreak');
        return;
      case 'add-parent':
        if (id !== null) endEdit({ keepEmpty: true });
        addParent(id ?? sel);
        return;
      case 'add-sibling':
        // the keymap's "add sibling" also on a still-empty new node; Esc/blur later removes the empty chain
        if (id !== null) endEdit({ keepEmpty: true });
        addSibling(id ?? sel, cmd.where);
        return;
      case 'add-child':
        if (id !== null) endEdit({ keepEmpty: true });
        addChild(id ?? sel);
        return;
      case 'select-parent':
        clearOthers();
        selectParent();
        return;
      case 'cancel-edit':
        endEdit({ cancel: true }); // the text returns to what it was; a brand-new node disappears
        return;
      case 'save':
        if (id !== null) endEdit();
        options.onSave?.();
        return;
      case 'open':
        if (id !== null) endEdit();
        options.onOpen?.();
        return;
      case 'new':
        if (id !== null) endEdit();
        options.onNew?.();
        return;
      case 'zoom':
        zoomCenter(view.s * cmd.factor); // zoom keys work while editing too (the browser would page-zoom)
        return;
      case 'zoom-reset':
        zoomCenter(1);
        return;
      case 'fit':
        fitToScreen();
        return;
      case 'toggle-collapse':
        if (id !== null) {
          endEdit(); // commit first, like Tab/Enter; a brand-new empty node is gone by then
          if (exists(id)) toggleCollapse(id);
        } else if (others.size) foldSelected();
        else toggleCollapse(sel);
        return;
      case 'duplicate':
        if (id !== null) {
          endEdit();
          if (exists(id)) duplicate(id);
        } else duplicate(sel);
        return;
      case 'start-edit':
        startEdit(sel); // text kept, caret at the end
        return;
      case 'reorder':
        if (others.size) reorderSelected(cmd.delta);
        else reorder(cmd.delta);
        return;
      case 'arrow':
        clearOthers(); // the arrows walk from the primary node, alone
        arrow(cmd.dir);
        return;
      case 'delete':
        if (others.size) removeSelected();
        else removeNode(sel);
        return;
      case 'undo':
        undo();
        return;
      case 'redo':
        redo();
        return;
      case 'type-to-replace':
        // Focus the label with its text selected and let the browser deliver this very keystroke (or IME
        // composition) into it - no preventDefault.
        startEdit(sel, { replace: true });
        return;
    }
  }
  on(rootEl, 'keydown', onKeyDown);
  /** EditorHandle.perform: each action is exactly what its key does (Tab, Enter, Space, Delete, Mod+/, Mod+D). */
  const ACTIONS: Readonly<Record<EditorAction, KeyCommand>> = {
    'add-child': { type: 'add-child' },
    'add-sibling': { type: 'add-sibling', where: 'after' },
    edit: { type: 'start-edit' },
    delete: { type: 'delete' },
    'toggle-collapse': { type: 'toggle-collapse' },
    duplicate: { type: 'duplicate' },
  };
  function perform(action: EditorAction): void {
    const cmd = ACTIONS[action];
    // like a key: nothing changes the tree under a node drag or a marquee
    if (destroyed || cmd === undefined || (press !== null && press.drag !== null) || marquee !== null) return;
    run(cmd);
  }
  on(world, 'input', onInput);
  // Mod+C / Mod+X / Mod+V: the keymap leaves the keys to the browser, which fires copy / cut / paste. They are
  // handled on the DOCUMENT (capture), not on the viewport: with the focus on a non-editable element Firefox
  // targets these events at the selection's container or at <body>, so a listener on the viewport never runs
  // there. They act only while the focus is inside this editor and no label is being edited (the label keeps
  // the browser's own text copy / cut / paste).
  const ownsClipboard = (e: ClipboardEvent): boolean => {
    const active = rootEl.ownerDocument.activeElement;
    return !destroyed && editingId === null && e.clipboardData !== null && active !== null && rootEl.contains(active);
  };
  const onCopyCut = (e: ClipboardEvent): void => {
    if (!ownsClipboard(e) || e.clipboardData === null) return;
    if (resting) {
      e.preventDefault(); // REST: nothing shown as selected is copied or cut; the selection shows again
      wake();
      return;
    }
    if (others.size) {
      // a multi-selection: every top-level selected subtree but the root, in document order, as ONE list
      const idx = T.indexOf(root);
      const nodes = batchIds()
        .map((id) => idx.get(id)?.node)
        .filter(nonNull);
      if (nodes.length === 0) return;
      e.clipboardData.setData('text/plain', subtreesToMarkdown(nodes));
      e.preventDefault();
      if (e.type === 'cut') removeSelected(); // ONE undo step (read-only: refused, the copy stays)
      return;
    }
    const entry = T.indexOf(root).get(sel);
    if (!entry) return;
    e.clipboardData.setData('text/plain', subtreeToMarkdown(entry.node));
    e.preventDefault();
    if (e.type === 'cut') removeNode(sel);
  };
  const onPaste = (e: ClipboardEvent): void => {
    if (!ownsClipboard(e) || e.clipboardData === null) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (resting) {
      wake(); // REST: a paste lands under a node the user sees
      return;
    }
    pasteText(text);
  };
  const clipOpts: AddEventListenerOptions = { capture: true, signal: ac.signal };
  rootEl.ownerDocument.addEventListener('copy', onCopyCut, clipOpts);
  rootEl.ownerDocument.addEventListener('cut', onCopyCut, clipOpts);
  rootEl.ownerDocument.addEventListener('paste', onPaste, clipOpts);
  // Belt and braces for browsers without `overflow: clip`: the viewport must never scroll (the caret
  // reveal after typing would shift the whole map away from where the model thinks it is).
  on(viewport, 'scroll', () => {
    if (viewport.scrollLeft || viewport.scrollTop) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  });

  // Pointers: a press on a node selects it (a press on the SELECTED node edits it on release, at the pointer),
  // a press on a non-root node that travels beyond the drag threshold drags the node with its subtree (see
  // input/dragdrop.ts), a drag on empty canvas / the middle button pans, and two touch points pinch-zoom around
  // their midpoint (the viewport has touch-action: none, so the page never zooms).
  const touches = new Map<number, [number, number]>(); // active touch pointers: pointerId -> [clientX, clientY]
  let pinch: { d0: number; s0: number; mid: [number, number] } | null = null; // while two fingers are down
  let pan: { readonly pid: number; readonly end: () => void } | null = null; // while a pan gesture is active
  let press: Press | null = null; // while a pointer is down on a node
  let handlePress: HandlePress | null = null; // while a primary pointer is down on a ring or a badge
  // The last press hit a live collapse handle. Firefox fires the click/dblclick of a press whose pointerdown and
  // pointerup targets differ at their common ancestor (with the viewport's capture, the viewport; without it, the
  // ring replaced by the badge in between gives the .mm-node), so the dblclick handler cannot tell a double-click on
  // a handle from one on the node by its target.
  let lastDownOnHandle = false;
  /** The edit the last click-again started (its pointerup time): the dblclick that completes it moves the caret. */
  let clickEdit: { readonly id: string; readonly at: number } | null = null;
  const endPan = (): void => {
    if (pan) {
      const p = pan;
      pan = null;
      p.end();
    }
  };
  const pinchGeometry = (): { d: number; mid: [number, number] } => {
    const [a, b] = [...touches.values()];
    if (a === undefined || b === undefined) return { d: 1, mid: [0, 0] };
    return { d: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  };

  // ---------- drag and drop of a node (with its subtree) ----------
  const ghostText = (text: string): string => {
    const line = text.split('\n')[0] ?? '';
    return line === '' ? '…' : line.length > GHOST_CHARS ? line.slice(0, GHOST_CHARS - 1).trimEnd() + '…' : line;
  };
  function beginDrag(p: Press, ev: PointerEvent): void {
    if (readOnly) return;
    // what moves: the pressed node, or (a press inside a multi-selection) every top-level selected node but the root
    const ids = p.group ? batchIds() : [p.id];
    const Ls = ids.map((id) => lay.nodes.get(id)).filter(nonNull);
    const first = Ls[0];
    if (first === undefined || Ls.length !== ids.length) return;
    if (editingId !== null) endEdit(); // (a press on a node already ended any other edit; belt and braces)
    stopAnim();
    setHover(null); // no ring during a drag (CSS hides them too); not left to the capture's boundary events
    const excluded = new Set<string>();
    for (const id of ids) for (const x of subtreeIds(lay, id)) excluded.add(x);
    const l1 = level1Ids();
    // the dragged subtrees and their connectors fade; the ghost chip follows the pointer in the branch colour
    renderer.setDragging(excluded, ids, true);
    // The connector INTO a level-2+ node is one segment of its parent's fan (one <path> per parent, see
    // render/connectors.ts), so it cannot carry the class alone: a fan that leads only to dragged nodes dims whole;
    // otherwise each dragged node's segment is covered with the canvas colour at 65% in the overlay group, which looks
    // exactly like opacity .35 on the segment (same stub-to-box geometry as the fan).
    const fans: SVGPathElement[] = [];
    const covers: SVGPathElement[] = [];
    const dragged = new Set(ids);
    for (const L of Ls) {
      const P = L.depth >= 2 && L.parentId !== null ? lay.nodes.get(L.parentId) : undefined;
      if (!P) continue;
      if (P.childIds.every((c) => dragged.has(c))) {
        const fan = renderer.paths.get(P.id)?.el;
        if (fan !== undefined && !fans.includes(fan)) {
          fan.classList.add('mm-dragging');
          fans.push(fan);
        }
        continue;
      }
      const cover = document.createElementNS(SVGNS, 'path');
      cover.setAttribute('class', 'mm-drop-cover');
      cover.setAttribute('d', fanSegment(P, L, theme));
      cover.setAttribute('stroke-width', String(strokeFor(theme, L.depth)));
      gOverlay.appendChild(cover);
      covers.push(cover);
    }
    const ghost = make('div');
    ghost.className = ids.length > 1 ? 'mm-ghost mm-ghost-multi' : 'mm-ghost';
    // a group reads "3 nodes" on the selection colour; one node shows its text on its branch colour
    ghost.textContent = ids.length > 1 ? `${ids.length} nodes` : ghostText(T.indexOf(root).get(first.id)?.node.text ?? '');
    ghost.style.background = ids.length > 1 ? paints.selection : branchColor(first, l1);
    viewport.appendChild(ghost);
    const gw = ghost.offsetWidth; // read once here: dragMove clamps the chip without a layout
    const gh = ghost.offsetHeight;
    const bar = document.createElementNS(SVGNS, 'rect');
    bar.setAttribute('class', 'mm-drop-bar');
    bar.setAttribute('width', '56');
    bar.setAttribute('height', '3');
    bar.setAttribute('rx', '1.5');
    bar.setAttribute('visibility', 'hidden');
    const link = document.createElementNS(SVGNS, 'path');
    link.setAttribute('class', 'mm-drop-link');
    link.setAttribute('visibility', 'hidden');
    gOverlay.appendChild(link);
    gOverlay.appendChild(bar);
    viewport.classList.add('mm-drag');
    p.drag = {
      ids,
      excluded,
      rect: viewport.getBoundingClientRect(),
      l1,
      ghost,
      gw,
      gh,
      bar,
      link,
      fans,
      covers,
      target: null,
      parentEl: null,
      key: '',
      lastX: ev.clientX,
      lastY: ev.clientY,
    };
    syncChrome(); // no "+" buttons and no selection bar during a drag
    dragMove(p, ev);
  }
  /**
   * pointermove during a drag (also re-run after a wheel pan/zoom with the last pointer position): move the ghost,
   * recompute the target (O(visible nodes)), update the preview. No layout.
   */
  function dragMove(p: Press, pt: ClientPoint): void {
    const t0 = performance.now();
    const d = p.drag;
    if (!d) return;
    d.lastX = pt.clientX;
    d.lastY = pt.clientY;
    const x = pt.clientX - d.rect.left;
    const y = pt.clientY - d.rect.top;
    // the chip sits at +14,+10 from the pointer and stays legible at the edges: clamped inside the viewport (overflow: clip)
    const gx = clamp(x + 14, 4, Math.max(4, d.rect.width - d.gw - 4));
    const gy = clamp(y + 10, 4, Math.max(4, d.rect.height - d.gh - 4));
    d.ghost.style.transform = `translate(${gx}px,${gy}px)`;
    // outside the map (toolbar, panel, beyond the window) there is no target: the preview hides and a release cancels
    const inside = x >= 0 && y >= 0 && x <= d.rect.width && y <= d.rect.height;
    const t = inside ? dropTarget(lay, p.id, (x - view.tx) / view.s, (y - view.ty) / view.s, d.excluded) : null;
    d.target = t;
    const key = t ? t.parentId + ':' + t.index : '';
    if (key !== d.key) {
      d.key = key;
      if (d.parentEl) d.parentEl.classList.remove('mm-drop-parent');
      d.parentEl = null;
      if (!t) {
        d.bar.setAttribute('visibility', 'hidden');
        d.link.setAttribute('visibility', 'hidden');
      } else {
        const pr = renderer.els.get(t.parentId);
        if (pr) {
          pr.el.classList.add('mm-drop-parent');
          d.parentEl = pr.el;
        }
        const ip = insertionPoint(lay, t, theme);
        d.bar.setAttribute('x', String(ip.x));
        d.bar.setAttribute('y', String(ip.y - 1.5));
        d.bar.removeAttribute('visibility');
        d.link.setAttribute('d', previewPath(ip.parent, ip, theme));
        d.link.setAttribute('stroke', ip.parent.depth === 0 ? paints.selection : branchColor(ip.parent, d.l1));
        d.link.removeAttribute('visibility');
      }
    }
    perfStats.dragMoveTimings.push(performance.now() - t0);
    if (perfStats.dragMoveTimings.length > 500) perfStats.dragMoveTimings.shift();
  }
  /**
   * End a drag: remove the visuals; with `drop`, move the node, or the group of selected nodes, to the target (ONE undo
   * step; a no-op leaves none).
   */
  function endDrag(p: Press, drop: boolean): void {
    const d = p.drag;
    p.drag = null;
    if (!d) return;
    renderer.setDragging(d.excluded, d.ids, false);
    for (const f of d.fans) f.classList.remove('mm-dragging');
    for (const c of d.covers) c.remove();
    if (d.parentEl) d.parentEl.classList.remove('mm-drop-parent');
    d.ghost.remove();
    d.bar.remove();
    d.link.remove();
    viewport.classList.remove('mm-drag');
    syncChrome();
    const t = d.target;
    if (!drop || !t || readOnly) return; // the map turned read-only mid-drag (main reported the file read-only): nothing moves
    const idx = T.indexOf(root);
    const pe = idx.get(t.parentId);
    if (!pe || d.ids.some((id) => !exists(id) || T.isAncestor(root, id, t.parentId))) return;
    // a collapsed target has no visible children: append behind the hidden ones (insertChild expands it)
    const at = pe.node.collapsed ? pe.node.children.length : t.index;
    if (p.group) {
      // the selected nodes move as one group, in document order, and stay selected (a no-op returns the same tree)
      const next = B.moveNodes(root, d.ids, t.parentId, at);
      if (next !== root) commit(next, sel);
      return;
    }
    const e = idx.get(p.id);
    if (!e || e.parentId === null) return;
    if (isNoop(lay, p.id, { parentId: t.parentId, index: at })) return; // same place: no change, no undo step
    commit(T.moveNode(root, p.id, t.parentId, at), p.id); // stays selected, revealed, remembered
  }

  // ---------- a pointer held down on a node ----------
  /** Belt and braces: Esc cancels a drag or a marquee even when the keyboard focus is not inside the editor (document, capture). */
  function docKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !((press !== null && press.drag !== null) || marquee !== null)) return;
    e.preventDefault();
    e.stopPropagation(); // this Esc only cancels the gesture: it must not also clear the selection (the editor's own Esc)
    cancelPress();
    cancelMarquee();
  }
  function startPress(e: PointerEvent, id: string, editOnUp: boolean, group: boolean): void {
    // the pressed node is selected (its ring shows for that); no other node is hovered while the pointer is held, and
    // not only once the capture's boundary events arrive with the first move. pressUp / cancelPress re-evaluate it.
    setHover(null);
    press = { id, pid: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, editOnUp, group, moved: false, drag: null, refused: false };
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has no capture */
    }
    viewport.addEventListener('pointermove', pressMove, sig);
    viewport.addEventListener('pointerup', pressUp, sig);
    viewport.addEventListener('pointercancel', pressCancel, sig);
    rootEl.ownerDocument.addEventListener('keydown', docKeyDown, { capture: true, signal: ac.signal });
  }
  function endPress(): Press | null {
    const p = press;
    press = null;
    viewport.removeEventListener('pointermove', pressMove);
    viewport.removeEventListener('pointerup', pressUp);
    viewport.removeEventListener('pointercancel', pressCancel);
    if (marquee === null) rootEl.ownerDocument.removeEventListener('keydown', docKeyDown, true);
    if (p) {
      try {
        viewport.releasePointerCapture(p.pid);
      } catch {
        /* already released */
      }
    }
    return p;
  }
  /** Esc, a second finger, pointercancel, destroy: whatever was pressed or dragged, nothing changes. */
  function cancelPress(): void {
    if (!press) return;
    const p = endPress();
    if (p && p.drag) endDrag(p, false);
    scheduleRehover();
  }
  /** The pointer that holds the press (a mouse is one pointer, whatever id a synthetic event gave it). */
  const holdsPress = (p: Press, ev: PointerEvent): boolean => ev.pointerId === p.pid || (ev.pointerType === 'mouse' && p.type === 'mouse');
  function pressMove(ev: PointerEvent): void {
    if (!press || !holdsPress(press, ev)) return;
    // A press whose release never arrived (a lost capture, a window switch mid-press): a mouse or pen moving
    // with its primary button up holds nothing, so the stale press goes instead of turning into a drag.
    if (ev.pointerType !== 'touch' && (ev.buttons & 1) === 0) {
      cancelPress();
      return;
    }
    if (ev.pointerId !== press.pid) return;
    if (!press.drag) {
      if (Math.hypot(ev.clientX - press.x0, ev.clientY - press.y0) < (DRAG_THRESHOLD[press.type] ?? DRAG_THRESHOLD['mouse'] ?? 4)) return;
      press.editOnUp = false; // it moved: the release edits nothing
      press.moved = true;
      if (press.id === rootId()) return; // the root is never dragged, and a press on it never pans
      if (readOnly) {
        // nothing is dragged; the host hears about it once per press (not on every move)
        if (!press.refused) {
          press.refused = true;
          refused();
        }
        return;
      }
      beginDrag(press, ev);
      return;
    }
    dragMove(press, ev);
  }
  function pressUp(ev: PointerEvent): void {
    if (!press || ev.pointerId !== press.pid) return;
    const p = endPress();
    if (!p) return;
    scheduleRehover(); // the hover cleared at the press follows the pointer again
    if (p.drag) {
      endDrag(p, true);
      return;
    }
    // a click (no drag) on a node of a multi-selection: that node alone is selected (a plain click's rule); a press that
    // travelled without a drag (the root, a read-only map) was no click and keeps the selection
    if (p.group) {
      if (!p.moved && exists(p.id)) select(p.id);
      return;
    }
    // a click on the node that was already selected: edit with the caret where the pointer is
    if (p.editOnUp && sel === p.id && editingId === null && exists(p.id)) {
      startEdit(p.id, { point: [ev.clientX, ev.clientY] });
      if (editingId === p.id) clickEdit = { id: p.id, at: ev.timeStamp };
    }
  }
  function pressCancel(ev: PointerEvent): void {
    if (press && ev.pointerId === press.pid) cancelPress();
  }

  /** The element under a client point (in this editor's shadow root when it is mounted in one). */
  function hitTest(x: number, y: number): Element | null {
    const host = rootEl.getRootNode();
    return (isShadowRoot(host) ? host : rootEl.ownerDocument).elementFromPoint(x, y);
  }
  /** Where a node is: [child index, text] from the root down (finds it again after a re-parse gave every node a new id). */
  function addressOf(id: string): Array<readonly [number, string]> {
    const idx = T.indexOf(root);
    const path: Array<readonly [number, string]> = [];
    for (let e = idx.get(id); e !== undefined && e.parentId !== null; e = idx.get(e.parentId)) path.unshift([e.index, e.node.text]);
    return path;
  }
  /** The node at that address in the current tree, or null when the path or any text along it differs. */
  function resolveAddress(path: ReadonlyArray<readonly [number, string]>): string | null {
    let n: MapNode | undefined = root;
    for (const [i, text] of path) {
      n = n.children[i];
      if (n === undefined || n.text !== text) return null;
    }
    return idOf(n);
  }

  // ---------- a pointer held down on a collapse handle (ring or badge) ----------
  /**
   * A primary press on a ring or a badge never pans, drags or edits. At the press, an edit in progress commits and
   * the keyboard focus moves to the map: a host field's blur happens now (the web shell applies its Markdown panel,
   * a re-parse that gives every node a new id: the handle's node is found again by its path and text). The handle
   * shows as pressed and holds the pointer capture. The toggle itself waits for the RELEASE of the same pointer
   * (handleUp): a click or a tap, i.e. the pointer stayed within the drag threshold, no second finger turned the
   * gesture into a pinch, and the release still lands on the same handle. A press that does not end in a click
   * changes nothing, not even the selection.
   */
  function beginHandlePress(e: PointerEvent, pressedId: string, kind: HandleKind): void {
    const before = root;
    const addr = addressOf(pressedId);
    if (editingId !== null) endEdit({ reveal: false }); // may remove a brand-new empty node (even this handle's own)
    viewport.focus({ preventScroll: true });
    // a press is direct manipulation: a keep-in-view animation still running (or just started by the host's apply)
    // stops here, so the handle stays under the pointer until the release
    stopAnim();
    const id = root !== before && !exists(pressedId) ? resolveAddress(addr) : pressedId;
    const r = id !== null ? renderer.els.get(id) : undefined;
    const el = (kind === 'ring' ? r?.ring?.el : kind === 'badge' ? r?.badge?.el : kind === 'child' ? plusChild : plusSibling) ?? null;
    el?.classList.add('mm-pressed'); // stays shown and tinted while held (the capture retargets :hover)
    if (kind === 'child' || kind === 'sibling') showPlusLink(kind);
    // where the map was: if it moves under the held pointer (wheel, zoom keys, a relayout), the release must still
    // land on this handle to count as a click (stillOnHandle)
    handlePress = { id, kind, pid: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, moved: false, el, tx: view.tx, ty: view.ty, s: view.s, lay };
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has no capture */
    }
  }
  /** The handle press ends without a toggle (pointercancel, a lost capture, a release elsewhere, a second finger, a stale press, destroy). */
  function dropHandlePress(keepCapture = false): HandlePress | null {
    const hp = handlePress;
    if (hp === null) return null;
    handlePress = null;
    hp.el?.classList.remove('mm-pressed');
    if (hp.kind === 'child' || hp.kind === 'sibling') hidePlusLink();
    if (!keepCapture) {
      try {
        viewport.releasePointerCapture(hp.pid);
      } catch {
        /* already released */
      }
    }
    return hp;
  }
  const beyondThreshold = (hp: HandlePress, x: number, y: number): boolean =>
    Math.hypot(x - hp.x0, y - hp.y0) >= (DRAG_THRESHOLD[hp.type] ?? DRAG_THRESHOLD['mouse'] ?? 4);
  /**
   * The pressed handle is still under the released pointer. When the map did not move during the press, the
   * pointer's own travel decides (beyondThreshold: a tap may drift a few px off a handle's edge). When it did move
   * (a wheel pan, zoom keys, a host's fit or zoom call, a relayout), the handle may have slid away from a pointer
   * that never moved: then ONE hit test at the release decides, as for a native click.
   */
  function stillOnHandle(hp: HandlePress, x: number, y: number): boolean {
    if (view.tx === hp.tx && view.ty === hp.ty && view.s === hp.s && lay === hp.lay) return true;
    const at = hitTest(x, y);
    return hp.el !== null && at !== null && at.closest('.mm-ring, .mm-badge, .mm-plus') === hp.el;
  }
  function handleUp(e: PointerEvent): void {
    if (handlePress === null || e.pointerId !== handlePress.pid) return;
    const hp = dropHandlePress();
    if (hp === null) return;
    if (!hp.moved && !beyondThreshold(hp, e.clientX, e.clientY) && stillOnHandle(hp, e.clientX, e.clientY)) {
      if (hp.kind === 'child' || hp.kind === 'sibling') plusClick = { at: e.timeStamp, x: e.clientX, y: e.clientY, type: e.pointerType };
      handleClick(hp.id, hp.kind);
    } else scheduleRehover(); // not a click: the hover frozen during the press follows the pointer again
  }
  /**
   * The node a press or a double-click acts on: the .mm-node around the event's target, except on a parent's hover
   * bridge (the transparent strip between its box and its ring, editor.css .mm-has-ring::before). The bridge only
   * keeps the hover while the pointer crosses to the ring; for presses it is empty canvas (a drag there pans, a click
   * or a double-click there never selects or edits). Events on the bridge target the node element itself, as do
   * events on the node's padding: the press point right of the layout box tells them apart (one rect read per press,
   * never on pointermove).
   */
  function pressedNode(e: MouseEvent): HTMLElement | null {
    const target = e.target instanceof Element ? e.target : null;
    const n = target?.closest<HTMLElement>('.mm-node') ?? null;
    if (n === null || !world.contains(n)) return null;
    if (target !== n || !n.classList.contains('mm-has-ring')) return n;
    const L = lay.nodes.get(n.dataset['id'] ?? '');
    if (!L) return n;
    const vr = viewport.getBoundingClientRect();
    return (e.clientX - vr.left - view.tx) / view.s > L.x + L.w ? null : n;
  }

  // ---------- marquee: Shift+drag on the empty canvas ----------
  /**
   * A Shift+press with a mouse or a pen on the empty canvas draws a marquee (screen space, the selection colour) once it
   * travels MARQUEE_THRESHOLD px: the nodes whose boxes it touches show as selected while it grows and join the selection
   * on the release. Esc, pointercancel, a lost capture, a release elsewhere, a buttonless move or a window blur cancel it
   * (the selection stays as it was). A wheel pan or zoom meanwhile keeps its first corner on the same spot of the map.
   * Class toggles only while it runs: no layout, no render.
   */
  function beginMarquee(e: PointerEvent): void {
    endPan();
    stopAnim();
    setHover(null);
    const rect = viewport.getBoundingClientRect();
    const el = make('div');
    el.className = 'mm-marquee-box';
    el.hidden = true; // until it moves: a Shift+click on the canvas draws nothing
    viewport.appendChild(el);
    const base = selection();
    marquee = {
      pid: e.pointerId,
      el,
      rect,
      wx: (e.clientX - rect.left - view.tx) / view.s,
      wy: (e.clientY - rect.top - view.ty) / view.s,
      x0: e.clientX,
      y0: e.clientY,
      base,
      hits: [],
      next: base,
      preview: new Set(others),
      moved: false,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has no capture */
    }
    viewport.classList.add('mm-marquee');
    viewport.addEventListener('pointermove', marqueeMove, sig);
    viewport.addEventListener('pointerup', marqueeUp, sig);
    viewport.addEventListener('pointercancel', marqueeCancelEvent, sig);
    rootEl.ownerDocument.addEventListener('keydown', docKeyDown, { capture: true, signal: ac.signal });
    syncChrome(); // no "+" buttons while a marquee is drawn
  }
  function marqueeMove(ev: PointerEvent): void {
    const m = marquee;
    if (m === null || ev.pointerId !== m.pid) return;
    // a mouse or pen moving without its button holds nothing: the release never arrived, so the marquee goes
    if (ev.pointerType !== 'touch' && (ev.buttons & 1) === 0) {
      cancelMarquee();
      return;
    }
    m.lastX = ev.clientX;
    m.lastY = ev.clientY;
    if (!m.moved && Math.hypot(ev.clientX - m.x0, ev.clientY - m.y0) < MARQUEE_THRESHOLD) return;
    m.moved = true;
    drawMarquee(m);
  }
  /** Draw the marquee from its first corner (where the map has it now) to the pointer (kept inside the map) and mark what it touches. */
  function drawMarquee(m: Marquee): void {
    const ax = m.wx * view.s + view.tx;
    const ay = m.wy * view.s + view.ty;
    const px = clamp(m.lastX - m.rect.left, 0, m.rect.width);
    const py = clamp(m.lastY - m.rect.top, 0, m.rect.height);
    const x0 = Math.min(ax, px);
    const y0 = Math.min(ay, py);
    const w = Math.abs(px - ax);
    const h = Math.abs(py - ay);
    m.el.hidden = false;
    m.el.style.transform = `translate(${x0}px,${y0}px)`;
    m.el.style.width = `${w}px`;
    m.el.style.height = `${h}px`;
    const hits = marqueeHits(lay, { x0: (x0 - view.tx) / view.s, y0: (y0 - view.ty) / view.s, x1: (x0 + w - view.tx) / view.s, y1: (y0 + h - view.ty) / view.s });
    if (hits.length === m.hits.length && hits.every((id, i) => id === m.hits[i])) return;
    m.hits = hits;
    m.next = marqueeSelection(m.base, hits, rootId());
    m.preview = new Set(m.next.others);
    renderer.markSelection(marqueeShown(m), m.preview);
    syncChrome(); // the bar counts them already
  }
  function marqueeUp(ev: PointerEvent): void {
    const m = marquee;
    if (m === null || ev.pointerId !== m.pid) return;
    endMarquee();
    if (m.moved && !(resting && m.hits.length === 0)) setSelection(m.next); // REST: a marquee over nothing selects nothing
    renderer.markSelection(shownSel(), others);
    syncChrome();
    scheduleRehover();
  }
  /** Esc, pointercancel, a lost capture, a stray release, a blur, the next press: the marquee goes, the selection stays as it was. */
  function cancelMarquee(): void {
    if (marquee === null) return;
    endMarquee();
    renderer.markSelection(shownSel(), others);
    syncChrome();
    scheduleRehover();
  }
  function endMarquee(): void {
    const m = marquee;
    marquee = null;
    if (m === null) return;
    m.el.remove();
    viewport.classList.remove('mm-marquee');
    viewport.removeEventListener('pointermove', marqueeMove);
    viewport.removeEventListener('pointerup', marqueeUp);
    viewport.removeEventListener('pointercancel', marqueeCancelEvent);
    if (press === null) rootEl.ownerDocument.removeEventListener('keydown', docKeyDown, true);
    try {
      viewport.releasePointerCapture(m.pid);
    } catch {
      /* already released */
    }
  }
  function marqueeCancelEvent(ev: PointerEvent): void {
    if (marquee !== null && ev.pointerId === marquee.pid) cancelMarquee();
  }

  // ---------- selection chrome: the "+" buttons and the selection bar ----------
  /** The real width of a collapsed node's pill badge, per count (a 3-digit count is wider than the estimate). */
  const pillWidths = new Map<number, number>();
  function realBadgeWidth(id: string, node: MapNode): number | undefined {
    if (node.collapsed !== true || node.children.length === 0) return undefined;
    const count = T.subtreeSize(node) - 1;
    if (!isPill(count)) return BADGE_SIZE;
    const known = pillWidths.get(count);
    if (known !== undefined) return known;
    const w = renderer.els.get(id)?.badge?.el.offsetWidth ?? 0; // one layout read per new count
    if (w > 0 && !unstyled) pillWidths.set(count, w);
    return w > 0 ? w : undefined;
  }
  const badgeOption = (id: string, node: MapNode): { badgeW?: number } => {
    const w = realBadgeWidth(id, node);
    return w === undefined ? {} : { badgeW: w };
  };
  // where the buttons are drawn: recomputed when the layout or the selection changes
  let plusAt: { readonly lay: Layout; readonly id: string; readonly spots: PlusSpots } | null = null;
  /** Exactly one node shown selected on an editable map, nothing edited, dragged, panned or marquee-selected, zoom 50 % or more. */
  const plusAllowed = (): boolean =>
    !readOnly &&
    !destroyed &&
    !resting &&
    editingId === null &&
    others.size === 0 &&
    marquee === null &&
    !panMoving &&
    pinch === null &&
    !(press !== null && press.drag !== null) &&
    view.s >= PLUS_MIN_ZOOM &&
    lay.nodes.has(sel);
  function updatePlus(): void {
    if (!plusAllowed()) {
      plusChild.classList.remove('mm-on');
      plusSibling.classList.remove('mm-on');
      if (handlePress === null) hidePlusLink();
      return;
    }
    if (plusAt === null || plusAt.lay !== lay || plusAt.id !== sel) {
      const idx = T.indexOf(root);
      const node = idx.get(sel)?.node;
      const L = lay.nodes.get(sel);
      const spots = node === undefined ? null : plusSpots({ lay, id: sel, node, nodeOf: (x) => idx.get(x)?.node, theme, ...badgeOption(sel, node) });
      if (spots === null || L === undefined) {
        plusChild.classList.remove('mm-on');
        plusSibling.classList.remove('mm-on');
        return;
      }
      plusAt = { lay, id: sel, spots };
      plusChild.style.transform = `translate(${spots.child.x}px,${spots.child.y}px)`;
      if (spots.sibling !== null) plusSibling.style.transform = `translate(${spots.sibling.x}px,${spots.sibling.y}px)`;
      // the node's branch colour (the root, which has none, the neutral selection colour)
      const color = L.depth === 0 ? paints.selection : branchColor(L);
      plusLayer.style.setProperty('--mm-c', color);
      plusLink.setAttribute('stroke', color);
      if (handlePress === null) hidePlusLink(); // the buttons moved: a preview drawn for the old spot goes
    }
    plusChild.classList.add('mm-on');
    plusSibling.classList.toggle('mm-on', plusAt.spots.sibling !== null);
  }
  /** The faint dashed preview from the node to the "+" under the pointer (or held). */
  function showPlusLink(kind: PlusKind): void {
    const spot = kind === 'child' ? plusAt?.spots.child : plusAt?.spots.sibling;
    if (spot === undefined || spot === null) return;
    plusLink.setAttribute('d', spot.link);
    plusLink.removeAttribute('visibility');
  }
  function hidePlusLink(): void {
    if (plusLink.getAttribute('visibility') !== 'hidden') plusLink.setAttribute('visibility', 'hidden');
  }
  for (const [el, kind] of [
    [plusChild, 'child'],
    [plusSibling, 'sibling'],
  ] as const) {
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'touch' && el.classList.contains('mm-on')) showPlusLink(kind);
    }, sig);
    el.addEventListener('pointerleave', () => {
      if (handlePress === null || handlePress.el !== el) hidePlusLink(); // a held "+" keeps its preview (the capture moved the pointer away)
    }, sig);
  }
  /** The bar: "N selected", Delete, Collapse or Expand (whichever applies; none when no selected node has children), ×. */
  function updateBar(count: number): void {
    const show = count > 1 && !(press !== null && press.drag !== null);
    selBar.classList.toggle('mm-on', show);
    if (!show) return;
    const text = `${count} selected`;
    if (selCount.textContent !== text) selCount.textContent = text;
    const plan = B.foldPlan(root, marquee !== null ? [marquee.next.primary, ...marquee.preview] : selectedAll());
    selFold.hidden = plan === null;
    const fold = plan === null || plan.collapse ? 'Collapse' : 'Expand';
    if (selFold.textContent !== fold) {
      selFold.textContent = fold;
      selFold.title = `${fold} the selected nodes (${modName}+/)`;
    }
    selDelete.setAttribute('aria-disabled', String(readOnly)); // a read-only map: the hint, nothing removed
  }
  /** The "+" buttons, the bar and the primary's halo follow the selection and the gestures (after every render). */
  function syncChrome(): void {
    if (destroyed) return;
    const count = (marquee !== null ? marquee.preview.size : others.size) + 1;
    viewport.classList.toggle('mm-multi-on', count > 1);
    updatePlus();
    updateBar(count);
  }
  const barAction = (b: HTMLButtonElement, run: () => void): void => {
    // never takes the focus from the map (the keys keep acting on the selection)
    b.addEventListener('pointerdown', (e) => e.preventDefault(), sig);
    b.addEventListener('mousedown', (e) => e.preventDefault(), sig);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (destroyed) return;
      run();
      viewport.focus({ preventScroll: true });
    }, sig);
  };
  barAction(selDelete, () => {
    if (others.size) removeSelected();
  });
  barAction(selFold, () => {
    if (others.size) foldSelected();
  });
  barAction(selClear, () => clearOthers());

  on(viewport, 'pointerdown', (e) => {
    // A pan whose release never arrived (a lost capture, a window switch) ends at the next press, whatever it hits:
    // a pointer cannot go down twice, and a new gesture must never keep moving the map.
    endPan();
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size >= 2) {
        // a second finger turns the gesture into a pinch; a pan, press, drag or handle tap in progress ends here
        // (nothing moves, nothing toggles: a pinch is not a tap)
        e.preventDefault();
        if (touches.size > 2) return;
        endPan();
        cancelPress();
        dropHandlePress(true); // the first finger stays captured: its moves keep driving the pinch
        if (editingId !== null) endEdit();
        stopAnim();
        setHover(null);
        const g = pinchGeometry();
        pinch = { d0: g.d, s0: view.s, mid: g.mid };
        syncChrome();
        return;
      }
    }
    // a handle press whose release never reached the map (a pointer cannot go down twice): it ends here, untoggled
    if (handlePress) dropHandlePress();
    if (press) {
      // another pointer while a node is held: ignored; the SAME pointer pressing again means its release was
      // lost (a pointer cannot go down twice), so that stale press ends here and this press counts
      if (!holdsPress(press, e)) return;
      cancelPress();
    }
    cancelMarquee(); // likewise a marquee whose release never arrived
    // The second click of a double-click on a "+" button: the first click created the node, whose label is being
    // edited now where the button was. Taken as one click: this press neither commits that empty node away nor
    // starts anything else.
    const pc = plusClick;
    plusClick = null;
    if (
      pc !== null &&
      e.button === 0 &&
      e.pointerType === pc.type &&
      e.timeStamp - pc.at < PLUS_DOUBLE_MS &&
      Math.hypot(e.clientX - pc.x, e.clientY - pc.y) <= (DRAG_THRESHOLD[e.pointerType] ?? 4) * 2 &&
      editingId !== null
    ) {
      lastDownOnHandle = true;
      e.preventDefault();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    // "+" buttons (a single selected node): what Tab / Enter do, on the release of a primary press that stayed put (like
    // a collapse handle: a press on one never selects, pans, drags or starts an edit). The middle button pans.
    const plusEl = target?.closest<HTMLElement>('.mm-plus') ?? null;
    if (plusEl !== null && e.button !== 1) {
      lastDownOnHandle = true;
      e.preventDefault();
      if (e.button === 0 && plusEl.classList.contains('mm-on')) beginHandlePress(e, sel, plusEl === plusSibling ? 'sibling' : 'child');
      return;
    }
    // Collapse handles: the ring (inside its node's element) collapses, the badge expands, on the release of a primary
    // press that stayed put (beginHandlePress / handleUp). A ring is a control only while it shows. Touch has no hover
    // (the pointerover a tap fires is not one), so under a finger the ring of a node that is not selected is invisible:
    // its spot is the empty canvas (a pan), never a collapse of a control the user cannot see. Another button on a
    // handle acts as on the canvas (the middle button pans).
    const ringEl = target?.closest<HTMLElement>('.mm-ring') ?? null;
    const handleEl = ringEl ?? target?.closest<HTMLElement>('.mm-badge') ?? null;
    const handleId = handleEl?.dataset['id'];
    const live = handleId !== undefined && !(ringEl !== null && e.pointerType === 'touch' && handleId !== shownSel()); // REST: no ring shows
    lastDownOnHandle = live;
    if (live && e.button === 0) {
      e.preventDefault();
      beginHandlePress(e, handleId, ringEl !== null ? 'ring' : 'badge');
      return;
    }
    const nodeEl = handleEl !== null ? null : pressedNode(e);
    let nodeId = nodeEl?.dataset['id'];
    if (e.button === 1 || !nodeEl || nodeId === undefined) {
      if (e.button !== 0 && e.button !== 1) return;
      if (editingId !== null && !nodeEl) endEdit();
      // focus first: a host field's blur (the web shell's Markdown panel applies on blur and re-parses the map) runs
      // its keep-in-view before stopAnim() and before the pan reads the view
      viewport.focus({ preventScroll: true });
      // Shift+drag with a mouse or a pen draws a marquee instead of panning (touch keeps panning)
      if (e.button === 0 && e.shiftKey && e.pointerType !== 'touch') {
        beginMarquee(e);
        e.preventDefault();
        return;
      }
      endPan();
      stopAnim();
      setHover(null); // no ring follows the pointer while the map is being panned
      const pid = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;
      const tx0 = view.tx;
      const ty0 = view.ty;
      const held = e.button === 1 ? 4 : 1; // the `buttons` bit of the button that started the pan (middle or primary)
      let moved = false;
      try {
        viewport.setPointerCapture(pid);
      } catch {
        /* a synthetic pointer has no capture */
      }
      viewport.classList.add('mm-panning');
      const move = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid || pinch) return;
        // like a press (pressMove): a mouse or pen moving without the button that started the pan holds nothing, so
        // the pan whose release was lost ends instead of making the map follow the hover
        if (ev.pointerType !== 'touch' && (ev.buttons & held) === 0) {
          endPan();
          return;
        }
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 2) return;
        if (!moved) {
          moved = true;
          panMoving = true;
          syncChrome(); // no "+" buttons while the map is dragged around
        }
        view.tx = tx0 + ev.clientX - sx;
        view.ty = ty0 + ev.clientY - sy;
        applyView();
      };
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return;
        endPan();
        // a click (or a tap) on the empty canvas that did not move: nothing shown as selected (REST)
        if (!moved && held === 1 && ev.type === 'pointerup') rest();
      };
      const end = (): void => {
        viewport.classList.remove('mm-panning');
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', up);
        viewport.removeEventListener('pointercancel', up);
        if (panMoving) {
          panMoving = false;
          syncChrome();
        }
        scheduleRehover(); // the pointer rests over whatever the pan brought under it
      };
      pan = { pid, end };
      viewport.addEventListener('pointermove', move, sig);
      viewport.addEventListener('pointerup', up, sig);
      viewport.addEventListener('pointercancel', up, sig);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (nodeId === editingId) return; // native caret placement (and text selection) inside the editor
    // Shift+click and Mod+click toggle the node in the selection: never an edit, a drag or a pan
    const toggle = e.shiftKey || (isMac ? e.metaKey : e.ctrlKey);
    // a press on a node of a multi-selection: a drag moves the whole selection, a click selects that node alone
    const group = !toggle && others.size > 0 && (nodeId === sel || others.has(nodeId));
    const again = !toggle && !group && nodeId === sel && editingId === null && !resting; // the node is already selected: the release edits it (unless it becomes a drag)
    if (editingId !== null) endEdit();
    else {
      // focus first: a host field's blur (the web shell applies its Markdown panel: a re-parse with new ids) happens
      // before the selection, and the pressed node is found again by its path and text
      const before = root;
      const addr = addressOf(nodeId);
      viewport.focus({ preventScroll: true });
      if (root !== before && !exists(nodeId)) {
        const found = resolveAddress(addr);
        if (found === null) {
          e.preventDefault();
          return;
        }
        nodeId = found;
      }
    }
    e.preventDefault();
    viewport.focus({ preventScroll: true });
    if (toggle) {
      if (exists(nodeId)) toggleSelected(nodeId);
      return;
    }
    if (!group && (sel !== nodeId || others.size || resting)) select(nodeId);
    startPress(e, nodeId, again, group && exists(nodeId) && (nodeId === sel || others.has(nodeId)));
  });
  on(viewport, 'pointermove', (e) => {
    const hp = handlePress;
    if (hp !== null && e.pointerId === hp.pid) {
      if (e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
        // a mouse or pen moving with its button up holds nothing: the release never arrived (a lost capture, a window
        // switch), so the stale handle press ends, untoggled
        dropHandlePress();
        scheduleRehover();
      } else if (!hp.moved && beyondThreshold(hp, e.clientX, e.clientY)) hp.moved = true; // no longer a click or a tap
    }
    if (e.pointerType !== 'touch') {
      // two numbers, no layout: where a hit test re-evaluates the hover after the map moves under a still pointer
      ptrX = e.clientX;
      ptrY = e.clientY;
      return;
    }
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (!pinch || touches.size < 2) return;
    e.preventDefault();
    const g = pinchGeometry();
    const rect = viewport.getBoundingClientRect();
    // zoom around the previous midpoint (keeps the world point under the fingers fixed), then follow the fingers
    zoomAt(pinch.mid[0] - rect.left, pinch.mid[1] - rect.top, pinch.s0 * (g.d / pinch.d0));
    view.tx += g.mid[0] - pinch.mid[0];
    view.ty += g.mid[1] - pinch.mid[1];
    pinch.mid = g.mid;
    applyView();
  });
  const touchEnd = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    touches.delete(e.pointerId);
    if (touches.size < 2 && pinch !== null) {
      pinch = null;
      syncChrome();
    }
  };
  on(viewport, 'pointerup', touchEnd);
  on(viewport, 'pointercancel', touchEnd);
  on(viewport, 'pointerup', handleUp);
  on(viewport, 'pointercancel', (e) => {
    if (handlePress !== null && e.pointerId === handlePress.pid) {
      dropHandlePress();
      scheduleRehover();
    }
  });
  // The capture of a held press, pan or handle was taken away (by the browser or another element; a button released
  // outside a cross-site or sandboxed iframe ends with lostpointercapture and no pointerup) or the window lost the
  // focus mid-gesture: nothing is held any more (a drag in progress is cancelled, a pan ends, nothing moves or
  // toggles). Only the viewport's own capture counts: a touch press first holds an implicit capture on the touched
  // element, whose loss to the viewport's setPointerCapture bubbles up here with that element as its target.
  on(viewport, 'lostpointercapture', (e) => {
    if (e.target !== viewport) return;
    if (press && e.pointerId === press.pid) cancelPress();
    if (pan && e.pointerId === pan.pid) endPan();
    if (marquee !== null && e.pointerId === marquee.pid) cancelMarquee();
    if (handlePress !== null && e.pointerId === handlePress.pid) {
      dropHandlePress(true);
      scheduleRehover();
    }
  });
  // A release that never reaches the viewport. setPointerCapture is only pending until the next pointer event, so
  // an element of the host page that takes the capture in the same pointerdown (a listener after the editor's)
  // overrides it silently: no gotpointercapture, no lostpointercapture, and the pointerup goes to that element. The
  // document sees every release first (capture phase); one for the held pointer that is not on its way to the
  // viewport ends the press, the pan or the handle press as a lost capture does: nothing toggles, drops or moves,
  // and nothing stays shown as held.
  const reachesViewport = (e: Event): boolean => {
    const path = e.composedPath();
    if (path.includes(viewport)) return true;
    const r = rootEl.getRootNode();
    return isShadowRoot(r) && path.includes(r.host); // a closed shadow root hides the viewport from the document
  };
  const strayRelease = (e: PointerEvent): void => {
    const id = e.pointerId;
    const held =
      (press !== null && press.pid === id) || (pan !== null && pan.pid === id) || (handlePress !== null && handlePress.pid === id) || (marquee !== null && marquee.pid === id);
    if (!held || reachesViewport(e)) return;
    if (press && press.pid === id) cancelPress();
    if (pan && pan.pid === id) endPan();
    if (marquee !== null && marquee.pid === id) cancelMarquee();
    if (handlePress !== null && handlePress.pid === id) {
      dropHandlePress();
      scheduleRehover();
    }
  };
  rootEl.ownerDocument.addEventListener('pointerup', strayRelease, { capture: true, signal: ac.signal });
  rootEl.ownerDocument.addEventListener('pointercancel', strayRelease, { capture: true, signal: ac.signal });
  rootEl.ownerDocument.defaultView?.addEventListener(
    'blur',
    () => {
      cancelPress();
      endPan();
      dropHandlePress();
      cancelMarquee();
    },
    { signal: ac.signal },
  );
  on(viewport, 'dblclick', (e) => {
    // Double-click = click (selects) + click again (its release edits at the pointer, see pressUp). With the pointer
    // captured on the viewport the browser retargets the compatibility click/dblclick events to the viewport itself,
    // so for a real double-click `closest('.mm-node')` is null here and this handler does nothing; it is only a
    // FALLBACK for a dblclick that reaches a node (no pointer capture, synthetic events). For the node being edited
    // the default must stay (the browser's own double-click word selection). A double-click on a collapse handle is
    // two toggles, never an edit: its target may be the handle, the viewport or (Firefox) the .mm-node (see
    // lastDownOnHandle), so the press that completed the double-click decides. The hover bridge right of a parent's
    // box is canvas here too (pressedNode).
    const target = e.target instanceof Element ? e.target : null;
    if (lastDownOnHandle || target?.closest('.mm-ring, .mm-badge, .mm-plus')) return;
    if (e.shiftKey || (isMac ? e.metaKey : e.ctrlKey)) return; // Shift / Mod + double-click: two toggles, never an edit
    const nodeEl = pressedNode(e);
    const nodeId = nodeEl?.dataset['id'];
    if (!nodeEl || nodeId === undefined) return;
    if (nodeId === editingId) {
      // A double-click on the SELECTED node: its first click already started the edit (click again, caret at
      // the pointer) and the second one landed in the editable label, where the browser selects a word. The
      // double-click edits with the caret at the point, so the caret goes back there. A double-click inside a
      // label that was already being edited keeps the browser's word selection (ordinary text editing).
      if (clickEdit !== null && clickEdit.id === nodeId && e.timeStamp - clickEdit.at < DOUBLE_CLICK_MS) {
        clickEdit = null;
        e.preventDefault();
        startEdit(nodeId, { point: [e.clientX, e.clientY] }); // same session: only the caret moves
      }
      return;
    }
    e.preventDefault();
    startEdit(nodeId, { point: [e.clientX, e.clientY] });
  });
  // A host's own menu (EditorOptions.onContextMenu; without it nothing happens here and the browser decides): a
  // right-click on the map, or a long-press where the browser turns one into a contextmenu event. The menu acts on the
  // selection, so the node under the pointer is selected first unless it is part of the selection already; a press, a
  // drag, a pan, a marquee or a handle press in progress ends without effect, and an edit commits. Inside the label being
  // edited the browser's own menu stays (spelling, cut, copy, paste).
  on(viewport, 'contextmenu', (e) => {
    const host = options.onContextMenu;
    if (host === undefined || destroyed) return;
    const target = e.target instanceof Element ? e.target : null;
    if (editingId !== null && target !== null && renderer.els.get(editingId)?.label.contains(target) === true) return;
    e.preventDefault();
    cancelPress();
    endPan();
    dropHandlePress();
    cancelMarquee();
    const nodeEl = target?.closest('.mm-ring, .mm-badge, .mm-plus') ? null : pressedNode(e);
    if (editingId !== null) endEdit({ reveal: false });
    const id = nodeEl?.dataset['id'];
    const onNode = id !== undefined && exists(id);
    if (onNode && (resting || (id !== sel && !others.has(id)))) select(id, { reveal: false }); // REST: shown before the menu
    host(e, onNode);
  });
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    ptrIn = true; // a wheel event is a mouse over the map: its position is where the hover is re-evaluated
    ptrX = e.clientX;
    ptrY = e.clientY;
    let dx = e.deltaX;
    let dy = e.deltaY;
    lastWheel = { dx, dy, mode: e.deltaMode, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      const [vw, vh] = viewportSize();
      dx *= vw;
      dy *= vh;
    }
    const rect = viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch arrives as ctrlKey+wheel in Chromium; Mod+wheel on a mouse
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.s * Math.exp(-clamp(dy, -50, 50) * 0.01));
    } else {
      // Shift+wheel pans sideways; not during a marquee, whose Shift is held for the marquee itself
      if (e.shiftKey && !dx && marquee === null) {
        dx = dy;
        dy = 0;
      }
      stopAnim();
      view.tx -= dx;
      view.ty -= dy;
      applyView();
    }
    // the world moved under a still pointer during a node drag: re-aim the drop preview at the pointer
    if (press && press.drag) dragMove(press, { clientX: press.drag.lastX, clientY: press.drag.lastY });
    // ...or during a marquee: its first corner stays on its spot of the map, the other at the pointer
    if (marquee !== null && marquee.moved) drawMarquee(marquee);
  };
  on(viewport, 'wheel', onWheel, { passive: false });
  on(selBar, 'wheel', onWheel, { passive: false }); // the bar floats over the map: the wheel still pans and zooms it
  // Hover: the node under a mouse or pen pointer (over its box, its hover bridge or its own ring, all of them the
  // node's element or inside it) shows its ring (CSS; the selected node shows it too). Boundary events only: one class
  // toggle each, no layout read, nothing on pointermove. Touch has no hover. While a handle is held, its node stays
  // hovered (the capture retargets the boundary events to the viewport). When the map moves under a still pointer,
  // scheduleRehover() re-evaluates it.
  let hoverEl: HTMLElement | null = null;
  let ptrIn = false; // a mouse or pen pointer is over the map...
  let ptrX = 0; // ...at this client point: where a re-hover hit-tests after the map moved under it
  let ptrY = 0;
  let rehoverTimer: number | undefined;
  const nodeElOf = (t: EventTarget | null): HTMLElement | null => {
    const el = t instanceof Element ? t.closest<HTMLElement>('.mm-node') : null;
    return el !== null && world.contains(el) ? el : null;
  };
  function setHover(el: HTMLElement | null): void {
    if (el === hoverEl) return;
    hoverEl?.classList.remove('mm-hover');
    hoverEl = el;
    el?.classList.add('mm-hover');
  }
  /**
   * The map moved under a still mouse or pen pointer (a wheel or trackpad pan or zoom, zoom keys, a keep-in-view
   * animation, a layout change, the end of a pan or a press). Browsers fire no boundary events for that, so the hover
   * is re-evaluated by ONE hit test at the last pointer position once the map has stopped moving for 50 ms (debounced:
   * nothing per frame while it scrolls; 50 ms is shorter than the ring's 60 ms fade-out delay, so a node that stays
   * under the pointer never flickers). Never on pointermove; skipped while a press, pan, pinch, drag or handle press
   * owns the pointer.
   */
  function scheduleRehover(): void {
    if (!ptrIn || destroyed) return;
    window.clearTimeout(rehoverTimer);
    rehoverTimer = window.setTimeout(rehover, 50);
  }
  function rehover(): void {
    rehoverTimer = undefined;
    if (!ptrIn || destroyed || press !== null || pan !== null || pinch !== null || handlePress !== null) return;
    const at = hitTest(ptrX, ptrY);
    setHover(at !== null && viewport.contains(at) ? nodeElOf(at) : null);
  }
  on(viewport, 'pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    ptrIn = true;
    ptrX = e.clientX;
    ptrY = e.clientY;
    if (handlePress !== null) return;
    setHover(nodeElOf(e.target));
  });
  on(viewport, 'pointerleave', (e) => {
    if (e.pointerType !== 'touch') ptrIn = false;
    setHover(null);
  });
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => {
          const cr = entries[entries.length - 1]?.contentRect;
          if (!cr) return;
          // KEEP-CAMERA: a resize keeps the selected node on screen only when it was whole on screen before (or no
          // size was known yet) and the new size cuts it off. The camera never moves otherwise: one a host restored
          // (restoreViewSnapshot), a node the user panned away from or one near an edge stays where it is.
          const shown = !vpW || !vpH || !clippedIn(sel, vpW, vpH);
          vpW = cr.width;
          vpH = cr.height;
          if (!heightFallback && cr.width > 0 && cr.height === 0) {
            // a visible container without a height (height: auto, nothing inside gives it one): the map would be 0 px tall
            heightFallback = true;
            rootEl.classList.add('mm-no-height');
            console.warn('mountEditor: the container has no height; falling back to min-height: 240px. Give the mount element a height.');
            return; // the observer fires again with the new size
          }
          if (!vpW || !vpH) return;
          if (unstyled && checkStyles()) return; // the sheet that sizes the viewport just applied: re-measured and centred
          if (openedHidden) {
            // mounted in a hidden container: the texts measured so far were zeros (uncached); measure for real now
            remeasure();
            return;
          }
          if (shown) revealIfClipped(sel, 0);
        })
      : null;
  if (ro) ro.observe(viewport);
  /** Forget every measurement and lay the map out again, centred as on open (it was measured hidden or unstyled). */
  function remeasure(): void {
    measureDom.clear();
    engine.reset();
    pillWidths.clear();
    primed = new WeakMap();
    relayout();
    render();
    centerOnOpen();
    options.onState?.(getStats());
  }

  // ---------- stylesheet ----------
  // Labels are measured in the DOM with the fonts editor.css gives them, and the measurements are cached per text,
  // so a map measured before the sheet applies would keep wrong widths for good. Vite emits the module script before
  // the stylesheet link, and WebKit may run the module first (Chromium and Firefox wait for the sheet): a mount can
  // happen unstyled. It is detected by the sheet's sentinel property and the map is re-measured once the sheet
  // applies: when a <link> finishes loading, when the viewport changes size (the sheet sizes it), or at the latest
  // on one of the next animation frames (a <style> added by a script).
  const styled = (): boolean => getComputedStyle(rootEl).getPropertyValue('--mm-editor-css').trim() !== '';
  const STYLE_WAIT_FRAMES = 600; // about 10 s of polling; the <link> load and resize checks keep listening after that
  function onSheetLoad(e: Event): void {
    if (e.target instanceof HTMLLinkElement) checkStyles();
  }
  /** True when the sheet applies (re-measuring the map if it was waiting for it). */
  function checkStyles(): boolean {
    if (!unstyled) return true;
    if (destroyed || !styled()) return false;
    unstyled = false;
    window.cancelAnimationFrame(styleRaf);
    document.removeEventListener('load', onSheetLoad, true);
    cancelPress(); // the layout changes: a drag (unlikely this early) must not keep aiming at the old one
    vpW = 0; // the viewport size read while unstyled is stale: viewportSize() reads it again
    vpH = 0;
    remeasure();
    return true;
  }
  function watchStyles(): void {
    if (styled()) return;
    unstyled = true;
    document.addEventListener('load', onSheetLoad, { capture: true, signal: ac.signal }); // load does not bubble: capture
    let frames = 0;
    const tick = (): void => {
      if (checkStyles() || destroyed) return;
      if (++frames < STYLE_WAIT_FRAMES) styleRaf = window.requestAnimationFrame(tick);
      else if (rootEl.isConnected) console.warn("mountEditor: the editor stylesheet does not apply; import '../core/view/editor.css'.");
    };
    styleRaf = window.requestAnimationFrame(tick);
  }

  // ---------- loading ----------
  function load(markdown: string, name?: string): void {
    cancelPress(); // nothing may change the tree under a dragging pointer
    cancelMarquee();
    if (editingId !== null) endEdit({ keepEmpty: true, refocus: false });
    if (name !== undefined && name !== '') fileName = name;
    doc = parseDocument(markdown, { basename: baseName(fileName) });
    root = doc.root; // the editor's nodes ARE the parsed objects (ids are assigned lazily by idOf)
    sel = rootId();
    resting = false;
    others = new Set();
    plusClick = null;
    editingId = null;
    editStart = null;
    creationStep.clear();
    history = new History<EditorSnapshot>(snap());
    colors = new BranchColors(paints.palette);
    lastChild.clear();
    primed = new WeakMap();
    renderer.reset();
    setHover(null);
    relayout();
    render();
    pendingView = null; // a camera restored for the previous map does not apply to this one
    centerOnOpen();
    lastNotified = root;
    lastNotifiedText = getMarkdown();
    savedMarkdown = lastNotifiedText;
    options.onState?.(getStats());
  }
  /**
   * A re-parse gives every node a new id, but branch colours stick to their branch for the session: match the
   * old and new first-level nodes by text (first unused match), then by position; the rest get the least-used
   * colour in the usual way (colors.sync).
   */
  function carryColors(oldRoot: MapNode, newRoot: MapNode): BranchColors {
    const next = new BranchColors(paints.palette);
    // every colour known so far stays known: undoing the re-parse brings the old ids back with their colours
    for (const [id, ci] of colors.byId) next.assign(id, ci);
    const byText = new Map<string, Array<{ i: number; ci: number }>>();
    oldRoot.children.forEach((c, i) => {
      const ci = colors.colorIndex(idOf(c));
      if (ci === undefined) return;
      let list = byText.get(c.text);
      if (!list) byText.set(c.text, (list = []));
      list.push({ i, ci });
    });
    const usedOld = new Set<number>();
    const unmatched: number[] = [];
    newRoot.children.forEach((c, i) => {
      const hit = (byText.get(c.text) ?? []).find((o) => !usedOld.has(o.i));
      if (hit) {
        usedOld.add(hit.i);
        next.assign(idOf(c), hit.ci);
      } else unmatched.push(i);
    });
    for (const i of unmatched) {
      const o = oldRoot.children[i];
      const n = newRoot.children[i];
      const ci = o !== undefined && !usedOld.has(i) ? colors.colorIndex(idOf(o)) : undefined;
      if (ci !== undefined && n !== undefined) {
        usedOld.add(i);
        next.assign(idOf(n), ci);
      }
    }
    return next;
  }
  /**
   * Re-parse edited/external Markdown. `history: 'step'` (the default) makes it ONE undo step (the file
   * wrapper - front matter, suffix, EOL - is part of the step): a replacement the user chose (the Markdown
   * panel's Apply, the web conflict bar's Reload). `history: 'reset'` makes the re-parsed text the start of a
   * new history (no step, nothing to undo or redo): a reload or merge of the file another program changed,
   * which Undo must never revert behind the user's back (the next save would delete the other program's edit).
   * `keepSelection` keeps the selection and the collapse state by node PATH across the re-parse (a file that
   * persists folds is the truth about folds, so only the selection is carried there); the selection stays
   * visible. An inline edit in progress is committed first and, when its label had the keyboard focus, is
   * opened again on the node at the same path (caret at the end), so the keys being typed keep landing in it.
   */
  function applyMarkdown(markdown: string, opts: ApplyMarkdownOptions = {}): void {
    cancelPress();
    cancelMarquee();
    others.clear(); // every node gets a new id: the selection is kept by path for the primary only
    const editPath = editingId !== null ? T.pathOf(root, editingId) : null;
    const editLabel = editingId !== null ? renderer.els.get(editingId)?.label : undefined;
    const labelFocused = editLabel !== undefined && rootEl.ownerDocument.activeElement === editLabel;
    if (editingId !== null) endEdit({ keepEmpty: true, refocus: false });
    const keep = opts.keepSelection === true;
    const selPath = keep ? T.pathOf(root, sel) : null;
    const collapsedPaths = keep ? [...T.collapsedIds(root)].map((id) => T.pathOf(root, id)).filter(nonNull) : [];
    const next = parseDocument(markdown, { basename: baseName(fileName) });
    let newRoot = next.root;
    if (keep && !next.foldsInFile && collapsedPaths.length) {
      const ids = new Set<string>(T.collapsedIds(newRoot));
      for (const p of collapsedPaths) {
        const n = T.nodeAtPath(newRoot, p);
        if (n !== undefined && n.children.length) ids.add(idOf(n));
      }
      newRoot = T.withCollapsed(newRoot, ids); // spread copies: the writer still sees the parsed nodes
    }
    const target = selPath !== null ? (T.nodeAtPath(newRoot, selPath) ?? newRoot) : newRoot;
    const newSel = visibleSelection(newRoot, idOf(target));
    lastNotified = null; // force an onChange even when the bytes are the ones just typed
    lastNotifiedText = null;
    colors = carryColors(root, newRoot);
    lastChild.clear();
    creationStep.clear();
    doc = next;
    if (opts.history === 'reset') {
      root = newRoot;
      sel = newSel;
      history = new History<EditorSnapshot>(snap());
      remember(sel);
      update();
    } else commit(newRoot, newSel);
    if (labelFocused && editPath !== null) {
      const n = T.nodeAtPath(root, editPath);
      if (!readOnly && n !== undefined && lay.nodes.has(idOf(n))) startEdit(idOf(n));
      else viewport.focus({ preventScroll: true });
    }
  }
  /** View state by node path (EditorHandle.getViewSnapshot): what a shell keeps so the map opens again as it was. */
  function getViewSnapshot(): ViewSnapshot {
    // in document order, so the same view state always gives the same snapshot
    const byPath = (a: readonly number[], b: readonly number[]): number => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
      return a.length - b.length;
    };
    const collapsed = [...T.collapsedIds(root)]
      .map((id) => T.pathOf(root, id))
      .filter(nonNull)
      .sort(byPath);
    const snapshot = { collapsed, selected: T.pathOf(root, sel) ?? [], view: { zoom: view.s, tx: view.tx, ty: view.ty } };
    // KEEP-CAMERA: whether the selection is whole on screen, once the map has a size and its labels their real one
    const [vw, vh] = unstyled || openedHidden ? [0, 0] : viewportSize();
    return vw && vh ? { ...snapshot, selectionShown: !clippedIn(sel, vw, vh) } : snapshot;
  }
  /**
   * Put view state back (EditorHandle.restoreViewSnapshot): the collapse state by path (only in a file that does not
   * store folds: there the text is the truth), the selection (kept visible) and the camera. Like a click on a collapse
   * handle it is view state: no undo step, no onChange (the text does not change), only onState and onView.
   */
  function restoreViewSnapshot(snapshot: ViewSnapshot): void {
    cancelPress();
    cancelMarquee();
    others.clear();
    if (editingId !== null) endEdit({ keepEmpty: true, refocus: false });
    stopAnim();
    const valid = (p: unknown): p is readonly number[] => Array.isArray(p) && p.every((i) => Number.isInteger(i) && i >= 0);
    if (!doc.foldsInFile && Array.isArray(snapshot.collapsed)) {
      const ids = new Set<string>();
      for (const p of snapshot.collapsed) {
        const n = valid(p) ? T.nodeAtPath(root, p) : undefined; // [] is the root (Mod+/ folds it too)
        if (n !== undefined && n.children.length) ids.add(idOf(n));
      }
      root = T.withCollapsed(root, ids);
    }
    const target = valid(snapshot.selected) ? T.nodeAtPath(root, snapshot.selected) : undefined;
    sel = visibleSelection(root, idOf(target ?? root));
    resting = false;
    history.replacePresent(snap());
    lastChild.clear();
    remember(sel);
    update({ reveal: false });
    const v = snapshot.view;
    if (v !== undefined && Number.isFinite(v.zoom) && Number.isFinite(v.tx) && Number.isFinite(v.ty)) {
      view.s = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
      view.tx = v.tx;
      view.ty = v.ty;
      applyView();
      // KEEP-CAMERA, as after a resize: a selection that was whole on screen and that this viewport cuts off (the map
      // opens again in a smaller window) comes back on screen; one the user had panned away from stays where it was
      const reveal = snapshot.selectionShown === true;
      // a re-measure still to come (an unstyled or hidden mount) re-centres as on open: this camera instead
      pendingView = unstyled || openedHidden ? { s: view.s, tx: view.tx, ty: view.ty, reveal } : null;
      if (pendingView === null && reveal) revealIfClipped(sel, 0);
    }
  }
  /** The current text counts as saved from now on (dirty = false until the next change). */
  function markSaved(): void {
    savedMarkdown = getMarkdown();
    options.onState?.(getStats());
  }
  function getStats(): EditorStats {
    return {
      nodes: T.countNodes(root),
      visibleNodes: lay.order.length,
      undoSteps: history.past.length,
      redoSteps: history.future.length,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      zoom: view.s,
      selected: sel,
      selectionShown: !resting,
      editing: editingId,
      fileName,
      rootText: root.text,
      dirty: getMarkdown() !== savedMarkdown,
      readOnly,
      deletable: !readOnly && !resting && batchIds().length > 0,
      lastUpdateMs: +perfStats.lastUpdateMs.toFixed(2),
      lastInputMs: +perfStats.lastInputMs.toFixed(2),
      inputTimings: perfStats.inputTimings.slice(),
      measure: measureDom.stats(),
      layout: { subtreesComputed: engine.stats.subtreesComputed, layouts: engine.stats.layouts, renders },
    };
  }
  /**
   * Browser-side timings (a debug hook for the e2e suites): keystroke cost incl. a forced reflow, structural
   * edit, pan. A measurement, not an edit: it refuses a read-only map, types into the deepest node with onChange,
   * onEditing and onState held back, and puts the tree, the selection, the undo history and the camera back exactly
   * as they were, so the text, the dirty flag, the view and the shells never see it.
   */
  async function perf({ keystrokes = 25 }: { keystrokes?: number } = {}): Promise<PerfResult> {
    if (readOnly) throw new Error('perf: the map is read-only');
    if (measuring) throw new Error('perf: already measuring');
    const frame = (): Promise<void> => new Promise((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => r())));
    const med = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const visibleNodes = lay.order.length;
    const nodes = T.countNodes(root);
    const deep = [...lay.order].sort((a, b) => b.depth - a.depth)[0];
    if (!deep) throw new Error('perf: empty layout');
    if (editingId !== null) endEdit();
    stopAnim(); // a keep-in-view pan still running would land after the camera is put back
    const saved = { root, sel, others: new Set(others), history, lastChild: new Map(lastChild), view: { ...view } };
    measuring = true;
    history = new History<EditorSnapshot>(snap()); // scratch history: the user's undo stack never sees the typing
    try {
      startEdit(deep.id);
      const sync: number[] = [];
      const frames: number[] = [];
      for (let i = 0; i < keystrokes; i++) {
        const t0 = performance.now();
        document.execCommand('insertText', false, 'x');
        void viewport.offsetHeight; // force style + layout like the browser would before painting
        sync.push(performance.now() - t0);
        const f0 = performance.now();
        await frame();
        frames.push(performance.now() - f0);
      }
      endEdit({ cancel: true });
      const keystroke = { medianSyncMs: +med(sync).toFixed(2), maxSyncMs: +Math.max(...sync).toFixed(2), medianTwoFramesMs: +med(frames).toFixed(1) };
      const st1: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        const n = T.mkNode('new branch ' + i);
        root = T.insertChild(saved.root, rootId(), 0, n);
        relayout();
        render();
        void viewport.offsetHeight;
        st1.push(performance.now() - t0);
      }
      const panTimes: number[] = [];
      stopAnim();
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        view.tx += 3;
        applyView();
        void viewport.offsetHeight;
        panTimes.push(performance.now() - t0);
      }
      return {
        visibleNodes,
        nodes,
        keystroke,
        structuralEditMedianMs: +med(st1).toFixed(2),
        panSyncMs: +med(panTimes).toFixed(3),
        measurer: measureDom.stats(),
      };
    } finally {
      if (editingId !== null) endEdit({ cancel: true });
      root = saved.root; // the same document, the same objects the history holds
      sel = saved.sel;
      others = saved.others;
      history = saved.history;
      lastChild.clear();
      for (const [k, v] of saved.lastChild) lastChild.set(k, v);
      // the camera too: the measured edit revealed the deepest node (a keep-in-view pan) and the pan loop moved it
      stopAnim();
      view.tx = saved.view.tx;
      view.ty = saved.view.ty;
      view.s = saved.view.s;
      applyView();
      measuring = false;
      update({ reveal: false });
    }
  }

  watchStyles();
  load(options.markdown ?? newFileText(baseName(fileName)), fileName);

  const textOf = (id: string): string | undefined => T.indexOf(root).get(id)?.node.text;
  const debug: EditorDebug = {
    get root(): MapNode {
      return root;
    },
    get sel(): string {
      return sel;
    },
    get editingId(): string | null {
      return editingId;
    },
    get lay(): Layout {
      return lay;
    },
    get view(): ViewState {
      return { ...view };
    },
    get history(): History<EditorSnapshot> {
      return history;
    },
    get doc(): MapDocument {
      return doc;
    },
    get lastWheel(): WheelInfo | null {
      return lastWheel;
    },
    get isDragging(): boolean {
      return press !== null && press.drag !== null;
    },
    get dragTarget(): DropTarget | null {
      return press && press.drag ? press.drag.target : null;
    },
    get selection(): string[] {
      const all = new Set(selectedAll());
      return lay.order.filter((L) => all.has(L.id)).map((L) => L.id);
    },
    get isMarquee(): boolean {
      return marquee !== null;
    },
    plus: (): PlusState => {
      const rect = (el: HTMLElement): PlusState['child'] => {
        if (!el.classList.contains('mm-on')) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      };
      return { child: rect(plusChild), sibling: rect(plusSibling), link: plusLink.getAttribute('visibility') !== 'hidden' };
    },
    find: (text: string): string | undefined => {
      const e = [...T.indexOf(root).values()].find((x) => x.node.text === text);
      return e ? idOf(e.node) : undefined;
    },
    textOf,
    childrenTexts: (id: string): string[] => (T.indexOf(root).get(id)?.node.children ?? []).map((c) => c.text),
    select: (id: string): void => select(id),
    reveal: (id: string): void => ensureVisible(id, 0),
    box: (id: string): NodeBox | undefined => {
      const L = lay.nodes.get(id);
      return L ? { x: L.x, y: L.y, w: L.w, h: L.h, cy: L.cy, depth: L.depth } : undefined;
    },
    screenCenter: (id: string): [number, number] | undefined => {
      const L = lay.nodes.get(id);
      if (!L) return undefined;
      const r = viewport.getBoundingClientRect();
      return [r.left + L.x * view.s + view.tx + (L.w * view.s) / 2, r.top + L.cy * view.s + view.ty];
    },
    liveText: (id: string): string | undefined => {
      const r = renderer.els.get(id);
      return r ? (r.label.textContent ?? '') : undefined;
    },
    domCount: () => renderer.domCount(),
    get hoverId(): string | null {
      return hoverEl?.dataset['id'] ?? null;
    },
    handleState: (id: string): HandleState => {
      const r = renderer.els.get(id);
      if (!r) return { ring: 'none', badge: null };
      // shown while the node is hovered or selected or the ring is held; never during a node drag (editor.css)
      const shown =
        !viewport.classList.contains('mm-drag') &&
        (r.el.classList.contains('mm-selected') || r.el.classList.contains('mm-hover') || r.ring?.el.classList.contains('mm-pressed') === true);
      return { ring: r.ring === null ? 'none' : shown ? 'visible' : 'hidden', badge: r.badge === null ? null : r.badge.count };
    },
    handleCenter: (id: string): [number, number] | null => {
      const r = renderer.els.get(id);
      const el = r?.ring?.el ?? r?.badge?.el;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    },
    branchColor: (id: string): string | undefined => {
      const L = lay.nodes.get(id);
      return L ? branchColor(L) : undefined;
    },
    collapsedIds: (): string[] => [...T.collapsedIds(root)],
    pasteText,
    dragTimings: (): number[] => perfStats.dragMoveTimings.slice(),
    /** The drop target the rule gives for a CLIENT point, for node `id` (default: the selected node). */
    dropTargetAt: (clientX: number, clientY: number, id: string = sel): DropTarget | null => {
      const r = viewport.getBoundingClientRect();
      return dropTarget(lay, id, (clientX - r.left - view.tx) / view.s, (clientY - r.top - view.ty) / view.s);
    },
    toScreen: (wx: number, wy: number): [number, number] => {
      const r = viewport.getBoundingClientRect();
      return [r.left + wx * view.s + view.tx, r.top + wy * view.s + view.ty];
    },
    /** What the drag visuals currently show (ghost chip, preview bar/connector, dimmed subtree, ring on the target parent). */
    overlay: (): OverlayState => {
      const ghost = viewport.querySelector<HTMLElement>('.mm-ghost');
      const parent = world.querySelector<HTMLElement>('.mm-node.mm-drop-parent');
      return {
        ghost: ghost !== null,
        ghostText: ghost ? ghost.textContent : null,
        ghostBackground: ghost ? ghost.style.background : null,
        bar: gOverlay.querySelector('.mm-drop-bar:not([visibility="hidden"])') !== null,
        link: gOverlay.querySelector('.mm-drop-link:not([visibility="hidden"])') !== null,
        cover: gOverlay.querySelector('.mm-drop-cover') !== null, // the dimming cover over the incoming fan segment of a level-2+ node
        ghostRect: ghost ? (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(ghost.getBoundingClientRect()) : null,
        dimmed: world.querySelectorAll('.mm-node.mm-dragging').length,
        dimmedPaths: gPaths.querySelectorAll('.mm-dragging').length,
        dropParent: parent ? (parent.dataset['id'] ?? null) : null,
        grabbing: viewport.classList.contains('mm-drag'),
      };
    },
    perf,
  };

  const handle: EditorHandle = {
    getMarkdown,
    load,
    applyMarkdown,
    markSaved,
    focus: () => viewport.focus({ preventScroll: true }),
    fit: fitToScreen,
    undo,
    redo,
    zoomIn: () => zoomCenter(view.s * 1.25),
    zoomOut: () => zoomCenter(view.s / 1.25),
    zoomTo: (s: number) => zoomCenter(clamp(s, MIN_ZOOM, MAX_ZOOM)),
    edit: (id?: string, opts: EditOptions = {}) => startEdit(id ?? sel, opts.replace === true ? { replace: true } : {}),
    selectAll: () => {
      const label = editingId !== null ? renderer.els.get(editingId)?.label : undefined;
      if (label !== undefined) placeCaret(label, true, undefined);
      else selectAll();
    },
    perform,
    handlesKey: (e: KeyboardEvent): boolean => {
      if (destroyed) return false;
      const cmd = commandOf(e);
      return cmd !== null && cmd.type !== 'native';
    },
    setColors: (given?: Partial<MapColors>) => {
      if (destroyed) return;
      paints = resolveColors(given);
      renderer.paint = paints;
      colors = colors.withPalette(paints.palette);
      plusAt = null; // the "+" buttons take their node's colour again
      render();
    },
    commitEdit: () => endEdit(),
    setReadOnly: (ro) => {
      if (ro && editingId !== null) endEdit();
      if (ro) cancelPress(); // a drag in progress ends without a drop
      readOnly = ro;
      syncChrome(); // no "+" buttons on a read-only map; the bar's Delete only hints
      options.onState?.(getStats());
    },
    getViewSnapshot,
    restoreViewSnapshot,
    getStats,
    getFileInfo: (): FileInfo => ({
      eol: doc.eol,
      bom: doc.bom !== '',
      indentUnit: doc.indentUnit,
      hasH1: !doc.virtualRoot,
      finalNewline: doc.finalNewline,
      foldsInFile: doc.foldsInFile,
    }),
    getFileName: () => fileName,
    setFileName: (n: string) => {
      if (n) fileName = n;
    },
    element: rootEl,
    destroy() {
      if (destroyed) return;
      // every edit session's end is reported (onEditing(false)): a shell that forwards it (the desktop's setEditing)
      // would otherwise keep main deferring its timer writes and outside changes. The edit commits, as on a blur.
      if (editingId !== null) endEdit({ refocus: false });
      destroyed = true;
      stopAnim();
      window.cancelAnimationFrame(styleRaf);
      window.clearTimeout(rehoverTimer);
      cancelPress();
      endPan();
      dropHandlePress();
      cancelMarquee();
      ac.abort();
      if (ro) ro.disconnect();
      rootEl.remove();
    },
    debug,
  };
  return handle;
}
