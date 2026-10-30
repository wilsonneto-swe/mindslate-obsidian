/**
 * AUTO-OPEN: a note with the flag (flag.ts) opens as a mind map wherever Obsidian opens it in a tab: the file explorer,
 * a link, the quick switcher, search, back and forward, a new tab. Obsidian asks a leaf for a Markdown view
 * (WorkspaceLeaf.setViewState with type `markdown`); the plugin's patch (main.ts, patch.ts) asks this module whether to
 * hand it the map view instead. It does when:
 *  - the request is for a Markdown view of a `.md` file,
 *  - the workspace is ready: while Obsidian puts the saved layout back at startup every leaf keeps the type it was saved
 *    with (a map is saved as a map; a note the user switched to Markdown stays Markdown),
 *  - the user did not choose Markdown for that note in that tab ("Open as Markdown": STICKY-MARKDOWN, for as long as the
 *    tab lives, back and forward included, until the user opens the note as a map there again),
 *  - and the note carries the flag (Obsidian's metadata cache: its parsed frontmatter).
 * Hover previews and embeds are no tabs: they keep showing the note as Markdown.
 */

/** What the user chose for a note in a tab: "Open as mind map" or "Open as Markdown". */
export type Choice = 'map' | 'markdown';

export interface OpenRequest {
  /** The view type asked for. */
  readonly type: string;
  /** The file in the requested state (state.file), when there is one. */
  readonly path: string | null;
  /** Obsidian has finished restoring the saved layout (workspace.layoutReady). */
  readonly layoutReady: boolean;
  /** The user's choice for this note in this tab (undefined: none). */
  readonly choice: Choice | undefined;
  /** The note has the flag. */
  readonly flagged: boolean;
}

/** The request becomes a map view (see the module comment). */
export function opensAsMap(r: OpenRequest): boolean {
  if (r.type !== 'markdown' || r.path === null || !r.path.toLowerCase().endsWith('.md') || !r.layoutReady || !r.flagged) return false;
  return r.choice !== 'markdown';
}

/** The path a choice follows when its note is renamed or moved (a folder rename moves every note inside it). */
export function renamedPath(path: string, oldPath: string, newPath: string): string | null {
  if (path === oldPath) return newPath;
  if (path.startsWith(oldPath + '/')) return newPath + path.slice(oldPath.length);
  return null;
}
