/**
 * The mind-map view: a TextFileView over the note's text with the core editor (mountEditor) filling the whole view.
 *
 * Obsidian owns the file. It reads the note into setViewData(text, true), asks getViewData() for the text when it
 * saves, and hands an outside change to setViewData(text, false). The view keeps:
 *  - SAVE-OBSIDIAN-STYLE: every change of the text (the core's onChange, typing included) asks for Obsidian's debounced
 *    save (requestSave: 2 s after the first change); Mod+S on the map saves at once; closing the view, another note in
 *    the same tab and quitting save too, a label being edited committed first. Opening a note never writes it.
 *  - OUTSIDE-CHANGE (sync.ts): the disk's text as it is (`isPlaintext = false`: no character merge by Obsidian), then
 *    'reload' in place (folds, selection, camera kept; HISTORY: a new undo history), 'merged' (line merge, saved at
 *    once), or 'conflict' (the file's version as one undo step, a notice that stays). DEFER-WHILE-EDITING: while a label
 *    is edited the outside text waits, and so do the map's saves.
 *  - VIEW-STATE (view-state.ts): folds, selection and camera per note, kept in the plugin's data; put back when the note
 *    opens again, else the map is fitted to the view (FIT-ON-OPEN, once it has a size).
 *  - KEYS: the view's Scope lets the map have exactly the keys it acts on now (EditorHandle.handlesKey), before
 *    Obsidian's hotkeys; every other key (Mod+P, Mod+W, Mod+O, Mod+N, Mod+1...) is Obsidian's (hostKeys).
 *  - THEME (theme.ts): styles.css maps the core's colours to Obsidian's variables; the script colours follow on
 *    `css-change` (applyTheme).
 *  - MOBILE: header buttons for Undo, Redo, Delete and Fit; Obsidian's edge swipes (sidebars, the pull-down action)
 *    never start inside the map (`data-ignore-swipe`); the core's touch handling does the rest (tap, tap again, the "+"
 *    buttons, one-finger drag, pinch).
 */
import { mountEditor, type EditorHandle, type EditorStats } from '../core/index.js';
import { Menu, Notice, Platform, Scope, TextFileView, normalizePath, type TFile, type WorkspaceLeaf } from 'obsidian';
// MERGE-LINES: the desktop app's line merge, pure and dependency-free (it is the same rule set; see sync.ts)
import { merge3 } from './merge.js';
import { ICON, PLUGIN_NAME, VIEW_CLASS, VIEW_TYPE } from './constants.js';
import type MindslatePlugin from './main.js';
import { decideOutside } from './sync.js';
import { mapColors, type ObsidianTheme } from './theme.js';

/** How long the camera and selection wait before they are kept (VIEW-STATE). */
const VIEW_SAVE_MS = 800;

export class MindMapView extends TextFileView {
  // not `editor`: Obsidian reads that name on Markdown views (its CodeMirror editor)
  private mapEditor: EditorHandle | null = null;
  /** The text this map last knew to be on disk (read, saved, or adopted): OUTSIDE-CHANGE's base. */
  private synced: string | null = null;
  /** An outside text that waits for the label being edited (DEFER-WHILE-EDITING). */
  private held: string | null = null;
  /** A label is being edited (the core's onEditing). */
  private editing = false;
  /** The map changes its text because of the file (an outside change, a rename): no save is asked for. */
  private applying = false;
  /** The map was loaded without a size (a background tab): it is fitted once it shows (FIT-ON-OPEN). */
  private fitWhenShown = false;
  private resizeObserver: ResizeObserver | null = null;
  private viewTimer: number | null = null;
  private stats: EditorStats | null = null;
  private conflictNotice: Notice | null = null;
  /**
   * NOTHING-LOST: the map's version after a 'conflict' (sync.ts), until the user acts on the map. Undo brings it back
   * while the view lives; a view that closes before the user did anything keeps it in a note of its own
   * (keepConflictCopy), since the undo history goes with the view.
   */
  private conflict: { readonly ours: string; readonly theirs: string } | null = null;
  /**
   * The map's text when its editor went away (onClose): what getViewData answers from then on, so nothing Obsidian
   * asks of a closed view can write anything but the map's last text (CLOSED-NEVER-WRITES).
   */
  private closedText: string | null = null;
  /** onClose has run: the view takes no text and writes nothing any more (CLOSED-NEVER-WRITES). */
  private closed = false;
  /** Mobile header buttons, enabled from the editor's state. */
  private readonly buttons: { undo?: HTMLElement; redo?: HTMLElement; remove?: HTMLElement } = {};

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MindslatePlugin,
  ) {
    super(leaf);
    // OUTSIDE-CHANGE: Obsidian hands over the disk's text as it is (its character merge is what Canvas and Bases opt
    // out of the same way); sync.ts decides what the map does with it.
    (this as unknown as { isPlaintext: boolean }).isPlaintext = false;
    // KEYS: the map's keys before Obsidian's hotkeys, and only those. A catch-all handler that returns true stops
    // Obsidian's handling of the key without preventing it, so it reaches the map's own listener; undefined hands
    // the key on to Obsidian's hotkeys (the parent scope).
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, (evt) => (this.ownsKey(evt) ? true : undefined));
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  override getIcon(): string {
    return ICON;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? PLUGIN_NAME;
  }

  /** Obsidian focuses a tab through its ephemeral state (opening a note, switching tabs): the map takes the keyboard. */
  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    if (typeof state === 'object' && state !== null && (state as { focus?: unknown }).focus === true) this.mapEditor?.focus();
  }

  /** The editor of this view (the e2e suite and the plugin's commands reach the map through it). */
  get map(): EditorHandle | null {
    return this.mapEditor;
  }

  /** An outside change waits for the label being edited (DEFER-WHILE-EDITING; read by the e2e suite). */
  get waitingOutside(): boolean {
    return this.held !== null;
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.contentEl.addClass(VIEW_CLASS);
    // MOBILE: Obsidian's swipe detector (sidebars, the pull-down action) skips touches that start inside this element
    this.contentEl.dataset['ignoreSwipe'] = 'true';
    // back to Markdown: a header button, except on a phone, whose narrow header keeps the map's own buttons and the
    // note's name; there "Open as Markdown" is in the tab's More options menu (main.ts, file-menu), as everywhere
    if (!Platform.isPhone) this.addAction('file-text', 'Open as Markdown', () => void this.plugin.openAsMarkdown(this.leaf));
    if (Platform.isMobile) {
      // phones have no keyboard shortcuts: the map's own actions in the header (the order on screen is right to left)
      this.addAction('maximize', 'Fit the map', () => this.mapEditor?.fit());
      this.buttons.remove = this.addAction('trash-2', 'Delete the selected nodes', () => this.mapEditor?.perform('delete'));
      this.buttons.redo = this.addAction('redo-2', 'Redo', () => this.mapEditor?.redo());
      this.buttons.undo = this.addAction('undo-2', 'Undo', () => this.mapEditor?.undo());
      this.syncButtons();
    }
    // VIEW-STATE: a pan or a zoom by hand is kept too (the core reports zoom changes only)
    this.registerDomEvent(this.contentEl, 'pointerup', () => this.scheduleViewSave());
    this.registerDomEvent(this.contentEl, 'wheel', () => this.scheduleViewSave(), { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.onShown());
    this.resizeObserver.observe(this.contentEl);
  }

  override async onClose(): Promise<void> {
    // the label being edited commits and the view state is kept while the map is still whole: Obsidian empties the
    // view's element before it unloads the file (the final save reads the editor's text, which needs no element)
    this.finishEdit();
    this.rememberView();
    await this.keepConflictCopy();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    await super.onClose();
    this.closed = true;
    this.closedText = this.mapEditor?.getMarkdown() ?? this.closedText;
    this.mapEditor?.destroy();
    this.mapEditor = null;
    this.conflictNotice?.hide();
  }

  // ---------- the text ----------

  getViewData(): string {
    if (this.mapEditor !== null) return this.mapEditor.getMarkdown();
    return this.closedText ?? this.data ?? '';
  }

  setViewData(data: string, clear: boolean): void {
    if (this.closed) return; // a late reload (Obsidian's modify event after the close) mounts nothing
    if (clear || this.mapEditor === null || this.synced === null) {
      this.loadNote(data);
      return;
    }
    if (this.editing) {
      this.held = data; // DEFER-WHILE-EDITING: the latest outside text waits for the edit to end
      return;
    }
    this.applyOutside(data);
  }

  clear(): void {
    // the next note arrives through setViewData(text, true), which loads it (a new undo history); nothing to keep here
    this.held = null;
    this.synced = null;
  }

  /** A note opens in this view: a fresh map, its view state put back or the map fitted (not `open`: View's own). */
  private loadNote(data: string): void {
    const file = this.file;
    const name = file?.name ?? 'Untitled.md';
    this.held = null;
    this.editing = false;
    this.conflict = null;
    this.closedText = null;
    this.conflictNotice?.hide();
    if (this.mapEditor === null) {
      this.mapEditor = mountEditor(this.contentEl, {
        markdown: data,
        fileName: name,
        hostKeys: ['open', 'new', 'fit'],
        colors: mapColors(this.readTheme()),
        onChange: () => {
          if (!this.applying) {
            this.requestSave();
            this.conflict = null; // the user acted on the map (Undo to their version included)
          }
          this.scheduleViewSave();
        },
        onEditing: (editing) => this.onEditing(editing),
        onState: (stats) => {
          this.stats = stats;
          this.syncButtons();
          this.scheduleViewSave();
        },
        onView: () => this.scheduleViewSave(),
        onSave: () => void this.saveNow(),
        onContextMenu: (evt, onNode) => this.showMenu(evt, onNode),
      });
    } else this.mapEditor.load(data, name);
    this.synced = data;
    const snapshot = file !== null ? this.plugin.viewStates.get(file.path) : undefined;
    if (snapshot !== undefined) this.mapEditor.restoreViewSnapshot(snapshot);
    else this.fitOnOpen();
    this.plugin.mapOpened(this);
  }

  /** FIT-ON-OPEN: now when the view has a size, else as soon as it gets one. */
  private fitOnOpen(): void {
    if (this.contentEl.clientWidth > 0 && this.contentEl.clientHeight > 0) {
      this.fitWhenShown = false;
      this.mapEditor?.fit();
    } else this.fitWhenShown = true;
  }

  private onShown(): void {
    if (!this.fitWhenShown || this.contentEl.clientWidth === 0 || this.contentEl.clientHeight === 0) return;
    this.fitWhenShown = false;
    // after the core's own resize handling, which measures a map mounted hidden first
    window.requestAnimationFrame(() => this.mapEditor?.fit());
  }

  /** OUTSIDE-CHANGE (sync.ts). */
  private applyOutside(theirs: string): void {
    const ed = this.mapEditor;
    if (ed === null) return;
    const base = this.synced ?? theirs;
    const ours = ed.getMarkdown();
    const outcome = decideOutside(base, ours, theirs, merge3);
    this.synced = theirs;
    if (outcome.kind === 'same') return;
    this.applying = true;
    try {
      ed.applyMarkdown(outcome.text, { keepSelection: true, history: outcome.kind === 'conflict' ? 'step' : 'reset' });
    } finally {
      this.applying = false;
    }
    const name = this.file?.basename ?? 'this note';
    if (outcome.kind === 'merged') {
      this.requestSave();
      void this.save();
      new Notice(`“${name}” changed outside the map. Both versions are merged in the map, and it is saved.`);
    } else if (outcome.kind === 'conflict') {
      this.conflict = { ours, theirs: outcome.text };
      this.conflictNotice?.hide();
      this.conflictNotice = new Notice(
        `“${name}” changed outside the map, and your unsaved changes in the map do not fit with it. The map shows the file's version now: Undo brings your version back (it is saved again then).`,
        0,
      );
    }
    this.scheduleViewSave();
  }

  private onEditing(editing: boolean): void {
    this.editing = editing;
    if (editing) return;
    // the core reports the end of an edit before it finishes its own bookkeeping: act right after it
    queueMicrotask(() => {
      if (this.editing) return;
      this.applyHeld();
      void this.plugin.rootEdited(this); // NAME-FROM-ROOT
    });
  }

  private applyHeld(): void {
    const t = this.held;
    if (t === null) return;
    this.held = null;
    this.applyOutside(t);
    if (this.mapEditor !== null && this.mapEditor.getMarkdown() !== this.synced) this.requestSave(); // the saves that waited
  }

  /** Commit a label being edited, and apply an outside change that waited for it. */
  private finishEdit(): void {
    this.mapEditor?.commitEdit();
    this.editing = false;
    this.applyHeld();
  }

  // ---------- saving ----------

  override async save(clear?: boolean): Promise<void> {
    // CLOSED-NEVER-WRITES: a save that comes after the map closed (a debounced save, the quit task racing the window's
    // close) writes nothing: the map's last text was saved when it closed (onClose, through the unload's save)
    if (this.closed || this.mapEditor === null) return;
    if (clear === true) this.finishEdit(); // close, unload, another note in this tab: the label commits first
    else if (this.held !== null) return; // DEFER-WHILE-EDITING: the debounced save waits for the edit to end
    const text = this.mapEditor?.getMarkdown() ?? null;
    await super.save(clear);
    if (text !== null && clear !== true) this.synced = text;
  }

  /**
   * NOTHING-LOST when the view goes (closed, another note, the plugin unloaded, Obsidian quitting) right after a conflict
   * the user did not act on: the map's version, which only the undo history held, is kept as a note next to this one,
   * `<name> (map version <date> <time>).md`, and a notice names it.
   */
  async keepConflictCopy(): Promise<void> {
    const c = this.conflict;
    const file = this.file;
    this.conflict = null;
    if (c === null || file === null || this.mapEditor === null || this.mapEditor.getMarkdown() !== c.theirs) return;
    const dir = file.parent === null || file.parent.isRoot() ? '' : file.parent.path + '/';
    const d = new Date();
    const two = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;
    let path = normalizePath(`${dir}${file.basename} (map version ${stamp}).md`);
    for (let i = 1; this.app.vault.getAbstractFileByPath(path) !== null; i++) path = normalizePath(`${dir}${file.basename} (map version ${stamp} ${i}).md`);
    try {
      await this.app.vault.create(path, c.ours);
      new Notice(`Your map version of “${file.basename}”, which did not fit with the change made elsewhere, is kept in “${path}”.`, 0);
    } catch (e) {
      console.error(`${PLUGIN_NAME}: could not keep the map version of ${file.path}`, e);
    }
  }

  /** Mod+S on the map: the label commits, the note is written now. */
  async saveNow(): Promise<void> {
    this.finishEdit();
    await this.save(); // Obsidian writes when the text differs from what it last read or wrote
  }

  // ---------- renames ----------

  override async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    if (file !== this.file || this.mapEditor === null) return;
    this.mapEditor.setFileName(file.name);
    // R3: a note without an H1 shows its name as the root; read it again under the new name (the text is unchanged)
    if (!this.mapEditor.getFileInfo().hasH1) {
      this.applying = true;
      try {
        this.mapEditor.applyMarkdown(this.mapEditor.getMarkdown(), { keepSelection: true, history: 'reset' });
      } finally {
        this.applying = false;
      }
    }
  }

  // ---------- keys ----------

  /** KEYS: the key event is for the map (the focus is inside it) and the map acts on it now. */
  private ownsKey(evt: KeyboardEvent): boolean {
    const ed = this.mapEditor;
    const target = evt.target as Node | null;
    if (ed === null || target === null || typeof target.nodeType !== 'number') return false;
    return ed.element.contains(target) && ed.handlesKey(evt);
  }

  // ---------- view state, theme, buttons, menu ----------

  /** VIEW-STATE: keep the map's folds, selection and camera for this note now. */
  rememberView(): void {
    if (this.viewTimer !== null) window.clearTimeout(this.viewTimer);
    this.viewTimer = null;
    if (this.mapEditor !== null && this.file !== null) this.plugin.keepViewState(this.file.path, this.mapEditor.getViewSnapshot());
  }

  private scheduleViewSave(): void {
    if (this.viewTimer !== null) window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => this.rememberView(), VIEW_SAVE_MS);
  }

  /** THEME: what Obsidian's variables resolve to here (a probe element: computed rgb(), whatever the theme writes). */
  readTheme(): ObsidianTheme {
    const probe = this.contentEl.createSpan({ cls: 'mmv-probe' });
    const doc = this.contentEl.ownerDocument; // a popout window has a document of its own
    const view = doc.defaultView ?? window;
    const read = (v: string, fallback: string): string => {
      probe.style.color = fallback;
      probe.style.color = `var(${v}, ${fallback})`;
      return view.getComputedStyle(probe).color || fallback;
    };
    const theme = { dark: doc.body.classList.contains('theme-dark'), accent: read('--interactive-accent', '#7852ee'), muted: read('--text-muted', '#5c5c5c') };
    probe.remove();
    return theme;
  }

  /** THEME: the script colours again (the stylesheet's follow by themselves). */
  applyTheme(): void {
    this.mapEditor?.setColors(mapColors(this.readTheme()));
  }

  private syncButtons(): void {
    const s = this.stats;
    const set = (el: HTMLElement | undefined, on: boolean): void => {
      if (el === undefined) return;
      el.toggleClass('is-disabled', !on);
      el.setAttribute('aria-disabled', String(!on));
    };
    set(this.buttons.undo, s?.canUndo === true);
    set(this.buttons.redo, s?.canRedo === true);
    set(this.buttons.remove, s?.deletable === true);
  }

  /** A right-click on the map (or a long-press where the system makes one a context menu): the node's actions. */
  private showMenu(evt: MouseEvent, onNode: boolean): void {
    const ed = this.mapEditor;
    if (ed === null) return;
    const menu = new Menu();
    const editable = this.stats?.readOnly !== true;
    if (onNode && editable) {
      const deletable = ed.getStats().deletable;
      menu.addItem((i) => i.setTitle('Add child').setIcon('corner-down-right').onClick(() => ed.perform('add-child')));
      menu.addItem((i) => i.setTitle('Add sibling').setIcon('plus').onClick(() => ed.perform('add-sibling')));
      menu.addItem((i) => i.setTitle('Edit text').setIcon('pencil').onClick(() => ed.perform('edit')));
      menu.addItem((i) => i.setTitle('Collapse or expand').setIcon('chevrons-down-up').onClick(() => ed.perform('toggle-collapse')));
      if (deletable) menu.addItem((i) => i.setTitle('Duplicate').setIcon('copy').onClick(() => ed.perform('duplicate')));
      if (deletable) menu.addItem((i) => i.setTitle('Delete').setIcon('trash-2').setWarning(true).onClick(() => ed.perform('delete')));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle('Fit the map').setIcon('maximize').onClick(() => ed.fit()));
    menu.addItem((i) => i.setTitle('Open as Markdown').setIcon('file-text').onClick(() => void this.plugin.openAsMarkdown(this.leaf)));
    menu.showAtMouseEvent(evt);
  }
}
