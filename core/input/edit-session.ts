/**
 * The inline edit session's commit/cancel rules as pure functions, so the undo semantics are
 * unit-tested without a DOM. The editor (view/editor.ts) gathers the facts, asks `resolveEndEdit`
 * what to do and applies it to its history and tree.
 *
 * Decided semantics:
 *  - Esc CANCELS: the text returns to what it was when the session started and the undo step the
 *    session opened disappears (undo count, dirty flag, Markdown text and onChange exactly as before);
 *    a brand-new node (created this session and not yet committed) is removed even if text was typed,
 *    together with the chain of fresh empty nodes it hangs on.
 *  - Everything else COMMITS. Create+type is ONE undo step; a typing burst on an existing node is one
 *    step; a session that changes nothing leaves no step; a brand-new node left empty disappears on
 *    commit without a step.
 */
import { normalizeText } from '../format/index.js';

export interface EndEditFacts {
  /** Esc. */
  readonly cancel: boolean;
  /** Keep a still-empty brand-new node (Tab/Enter on it chain another new node; Esc later removes the chain). */
  readonly keepEmpty: boolean;
  /** The node still exists in the tree. */
  readonly exists: boolean;
  /** The node's current model text (already normalised for a commit). */
  readonly text: string;
  /** The model text when the session started. */
  readonly startText: string;
  /** history.openKey when the session started (the creation's coalescing key for a brand-new node). */
  readonly startOpenKey: string | null;
  /** history.openKey now. */
  readonly openKey: string | null;
  /** 'edit:<id>' of this node. */
  readonly sessionKey: string;
  /** The node was created in this session and its creation is still the latest history step. */
  readonly fresh: boolean;
}

export type EndEditAction =
  /** Esc on a brand-new node: drop its creation step (and the chain of fresh empty nodes it hangs on), reveal the selection. */
  | 'revert-fresh'
  /** The session opened a step that must go (Esc on an existing node, or a commit that changed nothing in the end). */
  | 'drop-step'
  /** Nothing to undo: just close the coalescing session. */
  | 'close'
  /** A brand-new node left empty disappears without a step (with the fresh empty chain under it). */
  | 'drop-empty'
  /** Keep what was typed: close the coalescing session. */
  | 'commit';

export function resolveEndEdit(f: EndEditFacts): EndEditAction {
  if (f.cancel) {
    // Brand-new node: the session that is ending is the one its creation opened (startOpenKey recorded the
    // creation's coalescing key) and its creation is still the latest step. A committed node re-edited later
    // (openKey null at startEdit) never counts as new, even when its creation is still the last undo step.
    if (f.exists && f.startOpenKey === f.sessionKey && f.fresh) return 'revert-fresh';
    if (f.exists && f.openKey === f.sessionKey && f.startOpenKey !== f.sessionKey) return 'drop-step';
    return 'close'; // the session changed nothing (or its step was closed by something else)
  }
  if (!f.keepEmpty && f.exists && f.text === '' && f.fresh) return 'drop-empty';
  // the session changed nothing in the end (F2 then blur, Shift+Enter then Enter...): the step it opened disappears
  if (f.exists && f.text === f.startText && f.openKey === f.sessionKey && f.startOpenKey !== f.sessionKey) return 'drop-step';
  return 'commit';
}

/**
 * The text a commit stores (R7/R11): lines trimmed of spaces/tabs, empty lines dropped; the root is an
 * H1 and holds ONE line (Shift+Enter line breaks become spaces, R3).
 */
export function commitText(text: string, isRoot: boolean): string {
  return normalizeText(text).join(isRoot ? ' ' : '\n');
}

/** The live label text as the model holds it while typing: CR dropped, the browser's trailing "\n" placeholder removed. */
export function liveToModelText(live: string): string {
  return live.replace(/\r/g, '').replace(/\n+$/, '');
}
