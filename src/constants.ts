/**
 * The plugin's names, in one module: `id` (mindslate) and `name` (Mindslate) in the repository's root manifest.json, which this
 * module reads at build time; the view type, the frontmatter key, the plugin folder (npm run obsidian:install, npm run
 * release) and every label follow from them.
 *
 * Changing `id` later moves the plugin's data folder and its frontmatter key: notes flagged with the old key open as
 * Markdown again until they are flagged anew.
 */
import manifest from '../manifest.json' with { type: 'json' };

/** The plugin id: its folder under <vault>/.obsidian/plugins/, its data, its view type and its frontmatter key. */
export const PLUGIN_ID: string = manifest.id;
/** The name Obsidian shows (settings, command palette prefix). */
export const PLUGIN_NAME: string = manifest.name;
/** The view type of a map leaf (workspace.json keeps it for the leaves that are open). */
export const VIEW_TYPE: string = PLUGIN_ID;
/** The frontmatter key of the flag: `mindslate: map` makes a note open as a map everywhere (FLAG). */
export const FLAG_KEY: string = PLUGIN_ID;
/** The flag's value. */
export const FLAG_VALUE = 'map';
/** The Lucide icon of the view, the ribbon button and the menu items. */
export const ICON = 'network';
/** A new map's file name before it gets a name of its own: `Untitled mind map.md`, `Untitled mind map 1.md`, ... */
export const NEW_MAP_NAME = 'Untitled mind map';
/** The class on the view's content element: the scope of every style of the plugin and of the core's sheet. */
export const VIEW_CLASS = 'mmv-view';
