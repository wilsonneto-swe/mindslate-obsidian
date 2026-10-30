/**
 * OUTSIDE-CHANGE: the note changed while its map is open (a Markdown tab of the same note saved, Obsidian Sync or another
 * device wrote it, another plugin edited it). Obsidian's TextFileView reads the file again and hands the text to the view
 * (setViewData(text, false)); the view does NOT take Obsidian's own merge (diff-match-patch, which drops a change it cannot
 * place without a word), it sets `isPlaintext = false` so Obsidian hands over the disk's text as it is, and decides here:
 *  - 'same': the map already shows that text (nothing to do; a save in flight that comes back);
 *  - 'reload': the map has no change of its own that is not on disk: it shows the new text in place, with its folds,
 *    selection and camera (applyMarkdown keepSelection; a new undo history, HISTORY: Undo never takes the other program's
 *    edit back behind the user's back);
 *  - 'merged': the map has changes of its own still waiting for the save (Obsidian's 2 s debounce) and they merge line
 *    by line with the new text (the desktop app's MERGE-LINES, src/merge.ts): the map shows the
 *    merged text, which is saved right away, and a notice says so;
 *  - 'conflict': they do not merge (both changed the same lines, or the result would put a line under another node):
 *    NOTHING-LOST: the map shows the file's version as ONE undo step, so Undo (Mod+Z, or the Undo button on a phone) brings
 *    the map's version back; nothing is written until the user acts, and a notice that stays says so. The file's version
 *    is on disk, the map's is one Undo away: neither side is dropped. When the view goes before the user acted (the tab
 *    closed, Obsidian quit), the undo history goes with it: the map's version is then kept as a note of its own next to
 *    this one (view.ts keepConflictCopy).
 * While a node's label is being edited the decision waits until the edit ends (DEFER-WHILE-EDITING, as in the other apps:
 * the label being typed in is never torn down), and the map's saves wait with it, so the text on disk is not overwritten
 * with a version that lacks the other program's edit.
 */

/** The result of a three-way merge (src/merge.ts merge3). */
export interface MergeLike {
  readonly ok: boolean;
  readonly text: string;
}

export type OutsideOutcome =
  | { readonly kind: 'same' }
  | { readonly kind: 'reload'; readonly text: string }
  | { readonly kind: 'merged'; readonly text: string }
  | { readonly kind: 'conflict'; readonly text: string };

/**
 * base: the text the map last knew to be on disk (loaded, saved, or adopted); ours: the map's text now; theirs: the
 * text on disk now.
 */
export function decideOutside(base: string, ours: string, theirs: string, merge: (base: string, ours: string, theirs: string) => MergeLike): OutsideOutcome {
  if (ours === theirs) return { kind: 'same' };
  if (ours === base) return { kind: 'reload', text: theirs };
  const m = merge(base, ours, theirs);
  if (m.ok && m.text !== theirs) return { kind: 'merged', text: m.text };
  if (m.ok) return { kind: 'reload', text: theirs }; // ours was already in theirs
  return { kind: 'conflict', text: theirs };
}
