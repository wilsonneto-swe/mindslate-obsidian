/**
 * Makes an HTML element, not yet attached: the host's own helper (Obsidian's `createEl` in the plugin, the page's DOM
 * elsewhere). The editor, the renderer and the text measurer never create HTML elements any other way, so the host
 * decides how they are made, and Obsidian's guideline about it holds inside the plugin.
 *
 * The elements must come from the window the editor's code runs in, as `document.createElement` there would make them:
 * the pointer handlers tell an event's target by `instanceof Element`, which an element from another window (an
 * iframe's, a popout's own) fails. The plugin's `createEl` is the main window's, where the plugin runs.
 */
export type ElementFactory = <K extends keyof HTMLElementTagNameMap>(tag: K) => HTMLElementTagNameMap[K];
