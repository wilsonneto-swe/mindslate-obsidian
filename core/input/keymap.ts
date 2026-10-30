/**
 * The keymap as a pure decision table: a key event + the editor's mode -> the command to run (or
 * null when the key is not ours). The editor (view/editor.ts) executes the command; this module has
 * no DOM so the whole table is unit-tested in Node.
 *
 * Mod = Cmd on macOS, Ctrl elsewhere. On Windows/Linux AltGr arrives as Ctrl+Alt and is a character,
 * never a shortcut. See the README keymap for the user-facing description of every row.
 */

export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly keyCode?: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
}

export interface KeyContext {
  readonly isMac: boolean;
  /** An inline edit session is open (the label is contenteditable and focused). */
  readonly editing: boolean;
  /** A node is being dragged, or a marquee drawn: Esc cancels it, every other key is swallowed. */
  readonly dragging: boolean;
}

export type ArrowDir = 'left' | 'right' | 'up' | 'down';

export type KeyCommand =
  /** Esc during a node drag or a marquee: cancel it. */
  | { readonly type: 'cancel-drag' }
  /** preventDefault and nothing else (any key but Esc during a drag or a marquee, Tab during an IME composition, Alt+Space when idle). */
  | { readonly type: 'swallow' }
  /** Leave the key to the browser: native text editing, the copy/cut/paste events. */
  | { readonly type: 'native' }
  | { readonly type: 'line-break' }
  | { readonly type: 'add-parent' }
  | { readonly type: 'add-sibling'; readonly where: 'before' | 'after' }
  | { readonly type: 'add-child' }
  | { readonly type: 'select-parent' }
  | { readonly type: 'cancel-edit' }
  | { readonly type: 'save' }
  | { readonly type: 'open' }
  | { readonly type: 'new' }
  | { readonly type: 'zoom'; readonly factor: number }
  | { readonly type: 'zoom-reset' }
  | { readonly type: 'fit' }
  | { readonly type: 'toggle-collapse' }
  | { readonly type: 'duplicate' }
  | { readonly type: 'start-edit' }
  | { readonly type: 'reorder'; readonly delta: -1 | 1 }
  | { readonly type: 'arrow'; readonly dir: ArrowDir }
  | { readonly type: 'delete' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /** Mod+A when no label is edited: every visible node joins the selection. */
  | { readonly type: 'select-all' }
  /** Esc when no label is edited: a multi-selection goes back to its primary node (nothing else happens). */
  | { readonly type: 'clear-selection' }
  /** A printable key, dead key or IME start while idle: start editing with the text selected and let the browser deliver the keystroke. */
  | { readonly type: 'type-to-replace' };

export const ZOOM_STEP = 1.25;

const DIRS: Readonly<Record<string, ArrowDir>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** The editor calls preventDefault for every command except the ones the browser must still see. */
export function preventsDefault(c: KeyCommand): boolean {
  return c.type !== 'native' && c.type !== 'type-to-replace';
}

const is = (e: KeyLike, ...keys: string[]): boolean => keys.includes(e.key);

export function keyToCommand(e: KeyLike, ctx: KeyContext): KeyCommand | null {
  const altGr = !ctx.isMac && e.ctrlKey && e.altKey;
  const mod = ctx.isMac ? e.metaKey : e.ctrlKey && !altGr;
  const isSlash = e.code === 'Slash' || e.key === '/' || e.key === '?';
  const composing = e.isComposing === true || e.keyCode === 229;

  if (ctx.dragging) {
    // A node is being dragged: Esc cancels the drag; every other key is swallowed WITH preventDefault, so Tab
    // cannot move the focus out of the editor (a later Esc would never reach it and the release would drop),
    // Space/Enter cannot activate a control and nothing may change the tree under the pointer.
    return e.key === 'Escape' ? { type: 'cancel-drag' } : { type: 'swallow' };
  }

  if (ctx.editing) {
    if (composing) {
      // The IME owns Enter/Esc while composing. Tab must still never leave the editor: the browser's
      // default would move focus to the next control and the blur would commit a half-finished composition.
      return e.key === 'Tab' ? { type: 'swallow' } : { type: 'native' };
    }
    if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) return { type: 'line-break' };
    if (e.key === 'Enter' && e.altKey) return { type: 'add-parent' };
    if (e.key === 'Enter' && mod) return { type: 'add-sibling', where: 'before' };
    if (e.key === 'Enter') return { type: 'add-sibling', where: 'after' };
    if (e.key === 'Tab' && !e.shiftKey) return { type: 'add-child' };
    if (e.key === 'Tab' && e.shiftKey) return { type: 'select-parent' };
    if (e.key === 'Escape') return { type: 'cancel-edit' };
    if (mod && is(e, 's', 'S')) return { type: 'save' };
    if (mod && is(e, 'o', 'O')) return { type: 'open' };
    if (mod && is(e, 'n', 'N')) return { type: 'new' };
    if (mod && is(e, '=', '+')) return { type: 'zoom', factor: ZOOM_STEP }; // the browser would page-zoom
    if (mod && is(e, '-', '_')) return { type: 'zoom', factor: 1 / ZOOM_STEP };
    if (mod && e.key === '0') return { type: 'zoom-reset' };
    if (mod && (e.key === '1' || e.code === 'Digit1')) return { type: 'fit' };
    if (mod && isSlash) return { type: 'toggle-collapse' };
    if (mod && !e.shiftKey && is(e, 'd', 'D')) return { type: 'duplicate' }; // Chrome would open the bookmark dialog
    return { type: 'native' }; // arrows, Mod+Z inside the text, Space, Mod+C/X/V, ...: native text editing
  }

  if (e.key === 'Tab' && e.shiftKey) return { type: 'select-parent' };
  if (e.key === 'Tab') return { type: 'add-child' };
  if (e.key === 'Enter' && e.altKey) return { type: 'add-parent' };
  if (e.key === 'Enter' && mod) return { type: 'add-sibling', where: 'before' };
  if (e.key === 'Enter') return { type: 'add-sibling', where: 'after' };
  // text kept, caret at the end (Space must not scroll the page)
  if (e.key === 'F2' || (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey)) return { type: 'start-edit' };
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return { type: 'reorder', delta: e.key === 'ArrowUp' ? -1 : 1 };
  const dir = DIRS[e.key];
  if (dir !== undefined && !mod && !e.altKey) return { type: 'arrow', dir };
  if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) return { type: 'delete' };
  if (mod && isSlash) return { type: 'toggle-collapse' };
  if (mod && !e.shiftKey && is(e, 'd', 'D')) return { type: 'duplicate' };
  if (mod && is(e, 'z', 'Z')) return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
  if (mod && !ctx.isMac && is(e, 'y', 'Y')) return { type: 'redo' };
  if (mod && is(e, '=', '+')) return { type: 'zoom', factor: ZOOM_STEP };
  if (mod && is(e, '-', '_')) return { type: 'zoom', factor: 1 / ZOOM_STEP };
  if (mod && e.key === '0') return { type: 'zoom-reset' };
  if (mod && (e.key === '1' || e.code === 'Digit1')) return { type: 'fit' };
  if (mod && is(e, 's', 'S')) return { type: 'save' };
  if (mod && is(e, 'o', 'O')) return { type: 'open' };
  if (mod && is(e, 'n', 'N')) return { type: 'new' };
  if (mod && is(e, 'c', 'x', 'v', 'C', 'X', 'V')) return { type: 'native' }; // the copy/cut/paste events do the work
  if (mod && !e.shiftKey && is(e, 'a', 'A')) return { type: 'select-all' }; // not the page's text (the label's own while editing)
  if (e.key === 'Escape') return { type: 'clear-selection' };
  // Alt/Option+Space (a NBSP character on macOS): neither the keep-edit nor type-to-replace, and no page scroll.
  if ((e.key === ' ' || e.key === '\u00a0') && e.altKey) return { type: 'swallow' };
  // Printable key, dead key (´ ~ ^ on US-Intl/ABNT layouts, also via AltGr) or IME start: type-to-replace.
  // Not with Ctrl on macOS (Ctrl+D/K/H/Y are Chrome's Emacs bindings, which would act on the selected
  // text) nor with the Windows key.
  const printable = e.key.length === 1 || e.key === 'Dead' || e.keyCode === 229;
  if (printable && !e.metaKey && (ctx.isMac ? !e.ctrlKey : altGr || (!e.ctrlKey && !e.altKey))) return { type: 'type-to-replace' };
  return null;
}
