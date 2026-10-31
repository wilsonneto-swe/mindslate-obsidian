/**
 * Mindslate for Obsidian (names: constants.ts): a note opens as a keyboard-first mind map and stays an
 * ordinary Markdown note. The core editor (core/) draws and edits the map; this plugin hosts it in a view
 * (view.ts) and connects it to Obsidian:
 *  - OPEN: "Open as mind map" (the same tab), "Open as mind map in a split" (beside the Markdown view), "Open as
 *    Markdown" (commands, the file menu, the view's "More options" menu, the editor's context menu, the map's header
 *    button); opening a note as a map never writes it.
 *  - FLAG (flag.ts): "Always open this note as a mind map" toggles `mindslate: map` in the note's frontmatter,
 *    a minimal edit through vault.process; AUTO-OPEN (auto-open.ts) then opens it as a map wherever Obsidian opens it,
 *    through a hand-written patch of WorkspaceLeaf.setViewState (patch.ts), undone on unload. STICKY-MARKDOWN: a tab
 *    where the user chose Markdown keeps Markdown for that note.
 *  - NEW: "New mind map" (command and ribbon) creates a flagged note where Obsidian puts new notes, or (a folder's menu
 *    in the file explorer) in that folder, and opens it as a map with the root ready to type; NAME-FROM-ROOT (names.ts)
 *    names the note after it.
 *  - VIEW-STATE (view-state.ts): folds, selection and camera per note in the plugin's data, following renames and
 *    deletes. THEME (theme.ts): live on `css-change`.
 */
import type { ViewSnapshot } from '../core/index.js';
// the core's stylesheet (moved under the view's class at build time, vite.config.ts) and the plugin's: one styles.css
import '../core/view/editor.css';
import './styles.css';
import { Keymap, MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath, type PaneType, type ViewState } from 'obsidian';
import { opensAsMap, renamedPath, type Choice } from './auto-open.js';
import { FLAG_KEY, FLAG_VALUE, ICON, NEW_MAP_NAME, VIEW_TYPE } from './constants.js';
import { flaggedIn, hasFlag, setFlag } from './flag.js';
import { isUntitledName, nameFromRoot, untitledName } from './names.js';
import { patchMethod } from './patch.js';
import { ViewStateStore } from './view-state.js';
import { MindMapView } from './view.js';

/** What the plugin keeps in its data.json. */
interface PluginData {
  viewState?: unknown;
}

/** How long view-state changes gather before data.json is written. */
const DATA_SAVE_MS = 1500;

/**
 * OPEN-NEVER-WRITES: Obsidian's Markdown view holds a note's text with LF line endings, so when its tab closes it writes
 * a CRLF note back as LF although nothing was edited (Obsidian 1.13.7, with or without this plugin). "Open as mind map"
 * closes that view, and opening a note as a map must not change it: when the Markdown view has no change of its own
 * (not dirty, and its text is the text it read but for the line endings), it is told that this text is the saved one,
 * so it closes without a write. A view with real changes saves them as usual. TextFileView keeps the text it read or
 * wrote last in `lastSavedData` (not part of Obsidian's typed API): when that field is missing, nothing is done.
 */
function quietMarkdownClose(leaf: WorkspaceLeaf, file: TFile): void {
  const view = leaf.view as unknown as { file?: unknown; dirty?: unknown; lastSavedData?: unknown; getViewData?: () => string };
  if (!(leaf.view instanceof MarkdownView) || view.file !== file || view.dirty === true || typeof view.lastSavedData !== 'string') return;
  const shown = view.getViewData?.();
  const lf = (t: string): string => t.replace(/\r\n/g, '\n');
  if (typeof shown === 'string' && shown !== view.lastSavedData && lf(shown) === lf(view.lastSavedData)) view.lastSavedData = shown;
}

export default class MindslatePlugin extends Plugin {
  viewStates: ViewStateStore = new ViewStateStore(null);
  /** STICKY-MARKDOWN: the user's choice per tab and note (auto-open.ts). */
  private readonly choices = new WeakMap<WorkspaceLeaf, Map<string, Choice>>();
  /** NAME-FROM-ROOT: maps made by "New mind map" in this session that still have their generated name. */
  private readonly freshMaps = new Set<string>();
  private unpatch: (() => void) | null = null;
  private dataTimer: number | null = null;
  private themeFrame = 0;

  override async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as PluginData;
    this.viewStates = new ViewStateStore(data.viewState);

    this.registerView(VIEW_TYPE, (leaf) => new MindMapView(leaf, this));
    this.patchLeaves();

    this.addCommand({
      id: 'open-as-map',
      name: 'Open as mind map',
      icon: ICON,
      checkCallback: (checking) => {
        const target = this.markdownTarget();
        if (target === null) return false;
        if (!checking) void this.openAsMap(target.leaf, target.file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-as-map-in-split',
      name: 'Open as mind map in a split',
      icon: ICON,
      checkCallback: (checking) => {
        const target = this.markdownTarget();
        if (target === null) return false;
        if (!checking) void this.openAsMap(this.app.workspace.getLeaf('split', 'vertical'), target.file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-as-markdown',
      name: 'Open as Markdown',
      icon: 'file-text',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MindMapView);
        if (view === null || view.file === null) return false;
        if (!checking) void this.openAsMarkdown(view.leaf);
        return true;
      },
    });
    this.addCommand({
      id: 'new-map',
      name: 'New mind map',
      icon: ICON,
      callback: () => void this.newMap(),
    });
    this.addCommand({
      id: 'toggle-always-map',
      name: 'Always open this note as a mind map',
      icon: ICON,
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file === null || file.extension !== 'md') return false;
        if (!checking) void this.toggleFlag(file);
        return true;
      },
    });
    this.addCommand({
      id: 'fit-map',
      name: 'Fit the map to the view',
      icon: 'maximize',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MindMapView);
        if (view === null || view.map === null) return false;
        if (!checking) view.map.fit();
        return true;
      },
    });

    this.addRibbonIcon(ICON, 'New mind map', () => void this.newMap());

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        // NEW from a folder's menu in the file explorer (its empty space gives the vault's own folder): the map goes in
        // that folder, beside Obsidian's "New note" and "New canvas", and as they do, Mod+click opens it in a new tab
        if (file instanceof TFolder) {
          if (source === 'file-explorer-context-menu') {
            menu.addItem((i) =>
              i
                .setSection('action-primary')
                .setTitle('New mind map')
                .setIcon(ICON)
                .onClick((evt) => void this.newMap(file, Keymap.isModEvent(evt))),
            );
          }
          return;
        }
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const view = leaf?.view;
        if (view instanceof MindMapView && view.file === file) {
          menu.addItem((i) => i.setSection('open').setTitle('Open as Markdown').setIcon('file-text').onClick(() => void this.openAsMarkdown(view.leaf)));
        } else {
          // from a tab's own menu the note opens as a map in that tab, from anywhere else (the file explorer, a link)
          // in the tab Obsidian would open it in
          const target = leaf !== undefined && (source === 'more-options' || source === 'tab-header') ? leaf : null;
          menu.addItem((i) =>
            i
              .setSection('open')
              .setTitle('Open as mind map')
              .setIcon(ICON)
              .onClick(() => void this.openAsMap(target ?? this.app.workspace.getLeaf(false), file)),
          );
        }
        menu.addItem((i) =>
          i
            .setSection('action')
            .setTitle('Always open as mind map')
            .setIcon(ICON)
            .setChecked(this.isFlagged(file))
            .onClick(() => void this.toggleFlag(file)),
        );
      }),
    );
    // OPEN from the note's text: a right-click in its Markdown tab (editing view) opens the note as a map in that tab
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        const file = info.file;
        if (!(info instanceof MarkdownView) || !(file instanceof TFile) || file.extension !== 'md') return;
        const leaf = info.leaf;
        menu.addItem((i) =>
          i
            .setSection('view')
            .setTitle('Open as mind map')
            .setIcon(ICON)
            .onClick(() => void this.openAsMap(leaf, file)),
        );
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.viewStates.rename(oldPath, file.path)) this.scheduleData();
        this.app.workspace.iterateAllLeaves((leaf) => {
          const notes = this.choices.get(leaf);
          if (notes === undefined) return;
          for (const [path, choice] of [...notes]) {
            const to = renamedPath(path, oldPath, file.path);
            if (to === null) continue;
            notes.delete(path);
            notes.set(to, choice);
          }
        });
        // a fresh map renamed by hand (or by NAME-FROM-ROOT) keeps its new name
        this.freshMaps.delete(oldPath);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.viewStates.delete(file.path)) this.scheduleData();
        this.freshMaps.delete(file.path);
      }),
    );
    // THEME, live: a theme or a snippet (css-change); the accent colour, which Obsidian sets on <body> without that event
    this.registerEvent(this.app.workspace.on('css-change', () => this.refreshTheme()));
    const accent = new MutationObserver(() => this.refreshTheme());
    accent.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    this.register(() => accent.disconnect());
    this.registerEvent(
      this.app.workspace.on('quit', (tasks) => {
        tasks.add(async () => {
          const saves: Array<Promise<void>> = [];
          this.forEachMap((v) => {
            v.rememberView();
            saves.push(v.saveNow().then(() => v.keepConflictCopy()));
          });
          await Promise.all(saves);
          await this.flushData();
        });
      }),
    );
  }

  override onunload(): void {
    if (this.themeFrame !== 0) window.cancelAnimationFrame(this.themeFrame);
    this.unpatch?.();
    this.unpatch = null;
    this.forEachMap((v) => v.rememberView());
    void this.flushData();
  }

  // ---------- opening ----------

  /** The active Markdown tab and its note (where "Open as mind map" applies), or null. */
  private markdownTarget(): { leaf: WorkspaceLeaf; file: TFile } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    return view !== null && file instanceof TFile && file.extension === 'md' ? { leaf: view.leaf, file } : null;
  }

  private choose(leaf: WorkspaceLeaf, path: string, choice: Choice): void {
    const notes = this.choices.get(leaf) ?? new Map<string, Choice>();
    notes.set(path, choice);
    this.choices.set(leaf, notes);
  }

  /**
   * A tab shows a note as a map or as Markdown: the same note in another view, so no history entry (Back goes to the
   * note before, as after switching to reading view); the tab is focused.
   */
  private async switchView(leaf: WorkspaceLeaf, type: string, file: TFile): Promise<void> {
    if (type === VIEW_TYPE) quietMarkdownClose(leaf, file);
    const state: ViewState & { popstate: boolean } = { type, state: { file: file.path }, active: true, popstate: true };
    await leaf.setViewState(state);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** "Open as mind map": this tab shows the note as a map (the note is not written). */
  async openAsMap(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    this.choose(leaf, file.path, 'map');
    await this.switchView(leaf, VIEW_TYPE, file);
  }

  /** "Open as Markdown": this tab shows the note as Markdown, and keeps doing so for that note (STICKY-MARKDOWN). */
  async openAsMarkdown(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MindMapView) || view.file === null) return;
    const file = view.file;
    await view.saveNow(); // nothing waits in the map when the Markdown view reads the note
    this.choose(leaf, file.path, 'markdown');
    await this.switchView(leaf, 'markdown', file);
  }

  /** AUTO-OPEN: WorkspaceLeaf.setViewState hands a flagged note to the map view (patch.ts undoes it on unload). */
  private patchLeaves(): void {
    const stateFor = (leaf: WorkspaceLeaf, state: ViewState): ViewState => {
      const file = state.state?.['file'];
      const path = typeof file === 'string' ? file : null;
      const choice = path !== null ? this.choices.get(leaf)?.get(path) : undefined;
      const flagged = path !== null && state.type === 'markdown' && this.isFlaggedPath(path);
      return opensAsMap({ type: state.type, path, layoutReady: this.app.workspace.layoutReady, choice, flagged }) ? { ...state, type: VIEW_TYPE } : state;
    };
    this.unpatch = patchMethod(WorkspaceLeaf.prototype, 'setViewState', (original) =>
      function (this: WorkspaceLeaf, state: ViewState, eState?: unknown): Promise<void> {
        return original.call(this, stateFor(this, state), eState);
      },
    );
  }

  /** The note has the flag (Obsidian's metadata cache: the frontmatter as it parsed it). */
  isFlagged(file: TFile): boolean {
    return flaggedIn(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  private isFlaggedPath(path: string): boolean {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension === 'md' && this.isFlagged(file);
  }

  // ---------- the flag ----------

  /**
   * "Always open this note as a mind map": the flag on or off (FLAG-MINIMAL). Turned on from the note's Markdown tab, that
   * tab becomes the map first: Obsidian's Markdown view writes a note back with LF line endings when it closes after an
   * outside change (the flag edit is one), so it goes before the edit and the note keeps every byte but the flag.
   */
  async toggleFlag(file: TFile): Promise<void> {
    const on = !hasFlag(await this.app.vault.read(file));
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (on && view !== null && view.file === file) await this.openAsMap(view.leaf, file);
    // a map of this note saves first, so the frontmatter edit lands on what the map shows
    const saves: Array<Promise<void>> = [];
    this.forEachMap((v) => {
      if (v.file === file) saves.push(v.saveNow());
    });
    await Promise.all(saves);
    await this.app.vault.process(file, (text) => setFlag(text, on));
    new Notice(on ? `“${file.basename}” opens as a mind map from now on (${FLAG_KEY}: ${FLAG_VALUE}).` : `“${file.basename}” opens as Markdown again.`);
  }

  // ---------- new maps ----------

  /**
   * "New mind map": a flagged note, open as a map, its root ready to be typed (NAME-FROM-ROOT). It goes in `folder` (a
   * folder's menu) or else where Obsidian puts new notes (the command, the ribbon); `where` is the tab, as getLeaf takes
   * it (false: the current tab, as Obsidian's "New note").
   */
  async newMap(folder?: TFolder, where: PaneType | boolean = false): Promise<void> {
    const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
    const dir = parent.isRoot() ? '' : parent.path + '/';
    const base = untitledName((name) => this.app.vault.getAbstractFileByPath(normalizePath(`${dir}${name}.md`)) !== null, NEW_MAP_NAME);
    const file = await this.app.vault.create(normalizePath(`${dir}${base}.md`), setFlag('', true));
    this.freshMaps.add(file.path);
    const leaf = this.app.workspace.getLeaf(where);
    await this.openAsMap(leaf, file);
    if (leaf.view instanceof MindMapView) leaf.view.map?.edit(undefined, { replace: true });
  }

  /** The map's root got a text of its own: a fresh map takes it as its name (NAME-FROM-ROOT). */
  async rootEdited(view: MindMapView): Promise<void> {
    const file = view.file;
    const root = view.map?.getStats().rootText;
    if (file === null || root === undefined || !this.freshMaps.has(file.path) || !isUntitledName(file.basename)) return;
    const name = nameFromRoot(root);
    if (name === null || name === file.basename) return;
    const dir = file.parent === null || file.parent.isRoot() ? '' : file.parent.path + '/';
    const path = normalizePath(`${dir}${name}.md`);
    if (this.app.vault.getAbstractFileByPath(path) !== null) return; // taken: the note keeps its name
    this.freshMaps.delete(file.path);
    await this.app.fileManager.renameFile(file, path);
  }

  /** A map view loaded a note (view.ts): nothing to do yet but keep the fresh-map bookkeeping honest. */
  mapOpened(view: MindMapView): void {
    const file = view.file;
    if (file !== null && this.freshMaps.has(file.path) && !isUntitledName(file.basename)) this.freshMaps.delete(file.path);
  }

  // ---------- view state ----------

  /** VIEW-STATE: keep a note's map state (data.json is written a moment later). */
  keepViewState(path: string, snapshot: ViewSnapshot): void {
    if (this.viewStates.set(path, snapshot)) this.scheduleData();
  }

  private scheduleData(): void {
    if (this.dataTimer !== null) window.clearTimeout(this.dataTimer);
    this.dataTimer = window.setTimeout(() => void this.flushData(), DATA_SAVE_MS);
  }

  private async flushData(): Promise<void> {
    if (this.dataTimer !== null) window.clearTimeout(this.dataTimer);
    this.dataTimer = null;
    const data: PluginData = { viewState: this.viewStates.toJSON() };
    await this.saveData(data);
  }

  /** THEME: every map takes the theme's script colours again, once per frame however many changes come. */
  private refreshTheme(): void {
    if (this.themeFrame !== 0) return;
    this.themeFrame = window.requestAnimationFrame(() => {
      this.themeFrame = 0;
      this.forEachMap((v) => v.applyTheme());
    });
  }

  private forEachMap(fn: (view: MindMapView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof MindMapView) fn(leaf.view);
  }
}
