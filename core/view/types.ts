/// <reference lib="dom" />
/** Public types of the composed editor (view/editor.ts): options, the handle, stats and the debug hooks. */
import type { Eol, MapDocument, MapNode } from '../format/types.js';
import type { History } from '../history/history.js';
import type { DropTarget } from '../input/dragdrop.js';
import type { Layout } from '../layout/types.js';
import type { ElementFactory } from '../render/element.js';
import type { MapColors } from '../render/theme.js';

/** What onView reports (zoom changes only). */
export interface ViewInfo {
  readonly zoom: number;
  readonly tx: number;
  readonly ty: number;
}

/** The camera as the debug hooks expose it (world -> screen: x * s + tx). */
export interface ViewState {
  readonly tx: number;
  readonly ty: number;
  readonly s: number;
}

/**
 * The view state of the open map that a shell may keep between visits (EditorHandle.getViewSnapshot /
 * restoreViewSnapshot). Nodes are named by PATH: the child indices from the root down ([] is the root), so a
 * snapshot stays meaningful for the same text parsed again (node ids are not).
 */
export interface ViewSnapshot {
  /** The collapsed nodes, each by its path. */
  readonly collapsed: ReadonlyArray<readonly number[]>;
  /** The selected node's path. */
  readonly selected: readonly number[];
  /** The camera: the zoom and the world -> screen translation, as onView reports them. */
  readonly view: ViewInfo;
  /**
   * Whether the selected node was whole on screen (getViewSnapshot gives it once the map has a size). KEEP-CAMERA:
   * restoreViewSnapshot then follows the rule of a resize: a selection that was whole on screen and that the viewport
   * cuts off now (the map opens again in a smaller window) is brought back on screen; one that was off screen, or a
   * snapshot without this field, leaves the camera exactly where `view` puts it.
   */
  readonly selectionShown?: boolean;
}

/**
 * A key the host keeps for itself (EditorOptions.hostKeys): Mod+O ('open'), Mod+N ('new') or Mod+1 ('fit'). The editor
 * neither acts on it nor prevents its default, while a node is selected or edited alike.
 */
export type HostKey = 'open' | 'new' | 'fit';

/**
 * What EditorHandle.perform does, each exactly what its key does on the selected node: 'add-child' (Tab), 'add-sibling'
 * (Enter), 'edit' (Space or F2: the text kept, the caret at the end), 'delete' (Delete: several selected, all of them),
 * 'toggle-collapse' (Mod+/), 'duplicate' (Mod+D). A read-only map refuses the edits as their keys do (onReadOnly).
 */
export type EditorAction = 'add-child' | 'add-sibling' | 'edit' | 'delete' | 'toggle-collapse' | 'duplicate';

export interface EditorOptions {
  /**
   * How the editor makes its HTML elements (render/element.ts ElementFactory): Obsidian's `createEl` in the plugin, the
   * page's DOM elsewhere.
   */
  readonly createElement: ElementFactory;
  /** The file text (default: "# <fileName basename>" + LF). */
  readonly markdown?: string;
  /** Used for the root when the file has no H1 (R3). Default 'Untitled.md'. */
  readonly fileName?: string;
  /** Mod = Cmd (true) or Ctrl (false). Default: detected from navigator.platform. */
  readonly isMac?: boolean;
  /** No edits at all (keys still navigate, zoom and collapse). */
  readonly readOnly?: boolean;
  /**
   * The map is read-only and the user just tried to change it: an editing key (Tab, Enter, Delete, Mod+D, Alt+arrows,
   * undo / redo), typing, Space / F2, a click again or a double-click on a node, a node dragged past the drag threshold
   * (once per press), a paste or a cut. Nothing changed; the host may show a hint. Navigation, collapse, zoom and copy
   * never fire it.
   */
  readonly onReadOnly?: () => void;
  /**
   * Fired when the FILE TEXT changes, with the whole file: never for navigation, and never for collapse/expand
   * except in a file that already stores folds (R10f: there the writer adds or removes the fold suffix).
   */
  readonly onChange?: (markdown: string) => void;
  readonly onState?: (stats: EditorStats) => void;
  /** Fired when the zoom changes (not on pans / keep-in-view animation frames). */
  readonly onView?: (view: ViewInfo) => void;
  /** An inline edit session starts (true) / ends (false): the desktop shell forwards it as setEditing. */
  readonly onEditing?: (editing: boolean) => void;
  /** Mod+S. */
  readonly onSave?: () => void;
  /** Mod+O. */
  readonly onOpen?: () => void;
  /** Mod+N. */
  readonly onNew?: () => void;
  /**
   * Keys the host keeps (default: none): the editor leaves them alone, no preventDefault, no edit committed, so the
   * host page's own shortcut runs (the Obsidian plugin keeps Mod+O, Mod+N and Mod+1 for Obsidian).
   */
  readonly hostKeys?: readonly HostKey[];
  /**
   * The colours the editor paints from script (default: DEFAULT_COLORS, the dark theme); every other colour is a CSS
   * custom property of editor.css. EditorHandle.setColors changes them later.
   */
  readonly colors?: Partial<MapColors>;
  /**
   * The host shows a menu of its own: a right-click on the map, or a long-press where the browser makes one a
   * contextmenu event. The node under the pointer is selected first (unless it is part of the selection already) and
   * the event's default is prevented; `onNode` says whether a node was under the pointer. Not inside the label being
   * edited (the browser's menu). Without this option the editor ignores contextmenu events.
   */
  readonly onContextMenu?: (event: MouseEvent, onNode: boolean) => void;
}

export interface EditorStats {
  readonly nodes: number;
  readonly visibleNodes: number;
  readonly undoSteps: number;
  readonly redoSteps: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly zoom: number;
  readonly selected: string;
  readonly editing: string | null;
  readonly fileName: string;
  /** The root's text: the file's H1, or its base name when it has none (getFileInfo().hasH1). */
  readonly rootText: string;
  /** getMarkdown() !== the text as loaded or last markSaved(). */
  readonly dirty: boolean;
  readonly readOnly: boolean;
  /** Delete would remove something: a node other than the root is selected and the map is editable. */
  readonly deletable: boolean;
  readonly lastUpdateMs: number;
  readonly lastInputMs: number;
  readonly inputTimings: readonly number[];
  readonly measure: { readonly entries: number; readonly batches: number; readonly measured: number };
  /**
   * `layouts` / `renders`: engine.layout() and renderer calls since the mount (a pan, zoom, hover, drag move or
   * keep-in-view animation adds none); `subtreesComputed`: layout memo misses since the last re-measure.
   */
  readonly layout: { readonly subtreesComputed: number; readonly layouts: number; readonly renders: number };
}

/** One history state: the tree, the selection and the parsed document wrapper the tree lives in. */
export interface EditorSnapshot {
  readonly root: MapNode;
  /** The selected node (the primary node of a multi-selection: the one the keyboard acts on). */
  readonly sel: string;
  readonly doc: MapDocument;
  /** The other selected nodes of a multi-selection (Undo of a batch delete or move selects them again). */
  readonly others?: readonly string[];
}

export interface ApplyMarkdownOptions {
  /** Keep the selection (and the collapse state) by node path across the re-parse. */
  readonly keepSelection?: boolean;
  /**
   * 'step' (default): the re-parse is ONE undo step (Undo brings the previous text back); for a replacement the
   * user chose (the Markdown panel's Apply, the web conflict bar's Reload). 'reset': the re-parsed text starts a
   * new history (no undo step, the undo and redo stacks are emptied); for the file reloaded or merged after
   * another program changed it, which Undo must not silently revert (a later save would remove that edit).
   */
  readonly history?: 'step' | 'reset';
}

export interface EditOptions {
  /** Select the whole text (typing replaces it) instead of placing the caret at the end. */
  readonly replace?: boolean;
}

export interface PerfResult {
  readonly visibleNodes: number;
  readonly nodes: number;
  readonly keystroke: { readonly medianSyncMs: number; readonly maxSyncMs: number; readonly medianTwoFramesMs: number };
  readonly structuralEditMedianMs: number;
  readonly panSyncMs: number;
  readonly measurer: { readonly entries: number; readonly batches: number; readonly measured: number };
}

export interface NodeBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cy: number;
  readonly depth: number;
}

export interface OverlayState {
  readonly ghost: boolean;
  readonly ghostText: string | null;
  readonly ghostBackground: string | null;
  readonly bar: boolean;
  readonly link: boolean;
  /** The canvas-coloured cover over the incoming fan segment of a dragged level-2+ node with siblings. */
  readonly cover: boolean;
  /** The ghost chip's client rect (it is clamped inside the viewport). */
  readonly ghostRect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null;
  readonly dimmed: number;
  readonly dimmedPaths: number;
  readonly dropParent: string | null;
  readonly grabbing: boolean;
}

/** A button's client rect (debug.plus). */
export interface PlusRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The "+" buttons of the single selected node (debug.plus): each button's client rect while it shows (null when it
 * does not: several or no editable node selected, an edit, a drag, a pan, a marquee, a zoom under 50 %, the root's
 * sibling button), and whether the dashed preview of a hovered or held button shows.
 */
export interface PlusState {
  readonly child: PlusRect | null;
  readonly sibling: PlusRect | null;
  readonly link: boolean;
}

/**
 * The collapse handles of a node (debug.handleState): `ring` is 'none' when the node shows no ring (a leaf,
 * a collapsed node, the root, an invisible node), 'visible' while it is shown (node, hover bridge or ring
 * hovered, the node selected, or the ring held; never during a node drag; the CSS fade may still be running)
 * and 'hidden' otherwise; `badge` is the count a
 * collapsed node's badge shows (ALL hidden descendants), else null.
 */
export interface HandleState {
  readonly ring: 'none' | 'hidden' | 'visible';
  readonly badge: number | null;
}

/** How the open file is written (EditorHandle.getFileInfo). */
export interface FileInfo {
  readonly eol: Eol;
  readonly bom: boolean;
  /** Detected indent unit of the list: '\t' or N spaces. */
  readonly indentUnit: string;
  /** False when the file has no H1 (the root is the file's basename and is not written until edited). */
  readonly hasH1: boolean;
  readonly finalNewline: boolean;
  /** The file persists collapsed nodes with the fold suffix (R10f). */
  readonly foldsInFile: boolean;
}

export interface WheelInfo {
  readonly dx: number;
  readonly dy: number;
  readonly mode: number;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** Test/debug hooks (used by the harness and the e2e suites; not a stable API). */
export interface EditorDebug {
  readonly root: MapNode;
  readonly sel: string;
  readonly editingId: string | null;
  readonly lay: Layout;
  readonly view: ViewState;
  readonly history: History<EditorSnapshot>;
  readonly doc: MapDocument;
  readonly lastWheel: WheelInfo | null;
  readonly isDragging: boolean;
  readonly dragTarget: DropTarget | null;
  /** Every selected node in document order (the primary is `sel`). */
  readonly selection: string[];
  /** A Shift+drag marquee is being drawn. */
  readonly isMarquee: boolean;
  /** Where the "+" buttons are (see PlusState). */
  plus(): PlusState;
  find(text: string): string | undefined;
  textOf(id: string): string | undefined;
  childrenTexts(id: string): string[];
  select(id: string): void;
  reveal(id: string): void;
  box(id: string): NodeBox | undefined;
  screenCenter(id: string): [number, number] | undefined;
  liveText(id: string): string | undefined;
  domCount(): { nodes: number; paths: number; badges: number; rings: number };
  /** The node under the mouse or pen pointer (its ring shows), else null. */
  readonly hoverId: string | null;
  /** Ring / badge state of a node (see HandleState). */
  handleState(id: string): HandleState;
  /** Client point of the centre of the node's ring (shown or not) or badge; null when it has neither. */
  handleCenter(id: string): [number, number] | null;
  branchColor(id: string): string | undefined;
  collapsedIds(): string[];
  pasteText(text: string): void;
  dragTimings(): number[];
  dropTargetAt(clientX: number, clientY: number, id?: string): DropTarget | null;
  toScreen(wx: number, wy: number): [number, number];
  overlay(): OverlayState;
  /**
   * Timings measured in the page (keystroke incl. a forced reflow, structural edit, pan). It types into the
   * deepest node and puts everything back (tree, selection, undo history; no onChange); refused while read-only.
   */
  perf(opts?: { keystrokes?: number }): Promise<PerfResult>;
}

export interface EditorHandle {
  /** The .md text; byte-identical to the loaded/applied text until the DOCUMENT changes. */
  getMarkdown(): string;
  /** Replace the map (resets the undo history, re-centres the view). */
  load(markdown: string, fileName?: string): void;
  /** Re-parse edited/external text: ONE undo step, or (history: 'reset') the start of a new history. */
  applyMarkdown(markdown: string, opts?: ApplyMarkdownOptions): void;
  /** The current text counts as saved from now on (dirty = false until the next change). */
  markSaved(): void;
  focus(): void;
  fit(): void;
  undo(): void;
  redo(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomTo(s: number): void;
  /** Start an inline edit on `id` (default: the selected node). */
  edit(id?: string, opts?: EditOptions): void;
  /** Select every visible node (Mod+A; the desktop's Edit > Select All); while a label is edited, its whole text instead. */
  selectAll(): void;
  /** Do what a key does to the selection (EditorAction), for a host's buttons and menus; nothing during a drag. */
  perform(action: EditorAction): void;
  /**
   * Whether the editor acts on this key event when it reaches the map now (the mode decides: selected or editing):
   * a command of the keymap other than native text editing, and not a key the host keeps (hostKeys). A host whose own
   * shortcuts run before the map's listener (the Obsidian plugin) lets the map have exactly these keys.
   */
  handlesKey(event: KeyboardEvent): boolean;
  /**
   * The colours painted from script (MapColors): the host's fields, DEFAULT_COLORS for the rest. Branches keep their
   * colour index; the map repaints at once (no layout, no onChange).
   */
  setColors(colors?: Partial<MapColors>): void;
  /** Commit an open inline edit (the shell calls it on window blur and before a save). */
  commitEdit(): void;
  setReadOnly(readOnly: boolean): void;
  /** The collapsed branches and the selection by node path, and the camera (view state a shell may keep between visits). */
  getViewSnapshot(): ViewSnapshot;
  /**
   * Put view state back, typically right after load() of the same text: collapse those branches (a file that stores
   * folds keeps its own, which are part of its text), select that node (a path the map does not have selects the root;
   * a node inside a collapsed branch selects that branch) and put the camera there (the zoom clamped to the editor's
   * range). View state only: no undo step, no onChange. An edit in progress is committed first. When the map is
   * re-measured right afterwards (mounted before its stylesheet applied, or into a hidden container), the camera is put
   * back again instead of the opening view. A selection that was whole on screen (`selectionShown`) and that this
   * viewport cuts off is brought back on screen, as after a resize (KEEP-CAMERA).
   */
  restoreViewSnapshot(snapshot: ViewSnapshot): void;
  getStats(): EditorStats;
  /** EOL, BOM, indent unit, H1 and fold persistence of the open file. */
  getFileInfo(): FileInfo;
  getFileName(): string;
  setFileName(name: string): void;
  readonly element: HTMLElement;
  destroy(): void;
  readonly debug: EditorDebug;
}
