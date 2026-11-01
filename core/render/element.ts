/**
 * Makes an HTML element, not yet attached: the host's own helper (Obsidian's `createEl` in the plugin, the page's DOM
 * elsewhere). The editor, the renderer and the text measurer never create HTML elements any other way, so the host
 * decides how they are made, and Obsidian's guideline about it holds inside the plugin.
 */
export type ElementFactory = <K extends keyof HTMLElementTagNameMap>(tag: K) => HTMLElementTagNameMap[K];
