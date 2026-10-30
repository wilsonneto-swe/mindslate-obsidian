/**
 * VIEW-STATE: each note's map opens again as it was left (collapsed branches, the selection, the zoom and the pan),
 * after closing it, after another note in the same tab, after a restart. The core gives and takes that state by node
 * PATH (EditorHandle.getViewSnapshot / restoreViewSnapshot), so it stays meaningful for the same text read again; this
 * store keeps one snapshot per note path in the plugin's data (data.json in the plugin's folder: per vault, per device).
 *  - CAP: at most MAX_NOTES notes, the ones used longest ago go first; a snapshot keeps at most MAX_COLLAPSED folds.
 *  - FOLLOW: a renamed or moved note (or folder) keeps its state under the new path; a deleted note loses it.
 *  - TOLERANT: whatever data.json holds (an older or newer shape, a hand edit), a bad entry is dropped, never thrown.
 */
import type { ViewSnapshot } from '../core/index.js';
import { renamedPath } from './auto-open.js';

export const MAX_NOTES = 200;
export const MAX_COLLAPSED = 2000;
export const STORE_VERSION = 1;

export interface StoredView {
  readonly snapshot: ViewSnapshot;
  /** When it was saved (ms since the epoch): the oldest goes first beyond the cap. */
  readonly at: number;
}

export interface ViewStateData {
  readonly version: number;
  readonly notes: Readonly<Record<string, StoredView>>;
}

const isPath = (p: unknown): p is number[] => Array.isArray(p) && p.length <= 256 && p.every((i) => Number.isInteger(i) && i >= 0);
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A snapshot as the core takes it, or null when `v` is not one. */
export function validSnapshot(v: unknown): ViewSnapshot | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const view = s['view'] as Record<string, unknown> | undefined;
  if (!Array.isArray(s['collapsed']) || !isPath(s['selected']) || typeof view !== 'object' || view === null) return null;
  if (!isNum(view['zoom']) || !isNum(view['tx']) || !isNum(view['ty']) || view['zoom'] <= 0) return null;
  const collapsed = s['collapsed'].filter(isPath).slice(0, MAX_COLLAPSED);
  const out: ViewSnapshot = { collapsed, selected: s['selected'], view: { zoom: view['zoom'], tx: view['tx'], ty: view['ty'] } };
  return typeof s['selectionShown'] === 'boolean' ? { ...out, selectionShown: s['selectionShown'] } : out;
}

export class ViewStateStore {
  private readonly notes = new Map<string, StoredView>();

  /** From what the plugin's data held (anything: TOLERANT). */
  constructor(data: unknown, private readonly cap: number = MAX_NOTES) {
    const notes = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['notes'] : undefined;
    if (typeof notes !== 'object' || notes === null) return;
    const entries: Array<[string, StoredView]> = [];
    for (const [path, v] of Object.entries(notes as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null;
      const snapshot = typeof e === 'object' && e !== null ? validSnapshot(e['snapshot']) : null;
      const at = typeof e === 'object' && e !== null && isNum(e['at']) ? e['at'] : 0;
      if (snapshot !== null && path !== '') entries.push([path, { snapshot, at }]);
    }
    entries.sort((a, b) => a[1].at - b[1].at); // oldest first: the map's order is the eviction order
    for (const [p, v] of entries) this.notes.set(p, v);
    this.trim();
  }

  get size(): number {
    return this.notes.size;
  }

  get(path: string): ViewSnapshot | undefined {
    return this.notes.get(path)?.snapshot;
  }

  /** Keep the snapshot of `path` (the newest entry now); false when it is the one already kept (nothing to save). */
  set(path: string, snapshot: ViewSnapshot, now: number = Date.now()): boolean {
    const valid = validSnapshot(snapshot);
    if (valid === null) return false;
    const old = this.notes.get(path);
    if (old !== undefined && JSON.stringify(old.snapshot) === JSON.stringify(valid)) return false;
    this.notes.delete(path);
    this.notes.set(path, { snapshot: valid, at: now });
    this.trim();
    return true;
  }

  /** FOLLOW a rename or a move (of the note, or of a folder above it). True when something moved. */
  rename(oldPath: string, newPath: string): boolean {
    let moved = false;
    for (const [p, v] of [...this.notes]) {
      const to = renamedPath(p, oldPath, newPath);
      if (to === null || to === p) continue;
      this.notes.delete(p);
      this.notes.set(to, v);
      moved = true;
    }
    return moved;
  }

  /** A deleted note (or folder) takes its state along. True when something went. */
  delete(path: string): boolean {
    let gone = false;
    for (const p of [...this.notes.keys()]) {
      if (p === path || p.startsWith(path + '/')) gone = this.notes.delete(p) || gone;
    }
    return gone;
  }

  toJSON(): ViewStateData {
    return { version: STORE_VERSION, notes: Object.fromEntries(this.notes) };
  }

  private trim(): void {
    while (this.notes.size > this.cap) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
  }
}
