/**
 * Snapshot undo/redo over immutable trees. The editor's state is { root, sel, doc } (doc = the
 * parsed MapDocument: front matter, suffix, EOL, indent unit... so that undoing an applyMarkdown
 * also restores the wrapper the tree was in). Structural sharing makes each snapshot cost O(depth)
 * new objects, so we simply keep states.
 *
 * Coalescing: push(state, key) with the same non-null `key` as the currently open session replaces
 * the present instead of adding a step. The editor opens a session per edit ("edit:<nodeId>"), so
 * a whole typing burst - and "create node + type its text" - is ONE step.
 *
 * Dropping a step (Esc cancels an edit, a brand-new node is removed again, a session changed nothing)
 * must leave the history exactly as it was before the step: the redo stack that the step's push
 * discarded comes back. `clearedFuture` remembers, per step (its stable "before" snapshot), the future
 * that push() cleared; undo() forgets it (after an undo the redo path is the step itself).
 */
export interface Snapshot {
  readonly root: object;
  readonly sel: string;
}

export interface HistoryOptions {
  readonly limit?: number;
}

export class History<S extends Snapshot> {
  present: S;
  readonly past: S[] = [];
  future: S[] = [];
  openKey: string | null = null;
  readonly limit: number;
  /** Step ("before" snapshot) -> the redo stack its push discarded (it comes back if the step is dropped). */
  private readonly clearedFuture = new WeakMap<S, S[]>();

  constructor(initial: S, { limit = 500 }: HistoryOptions = {}) {
    this.present = initial;
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * @param state     new snapshot
   * @param key       coalescing key (null = always a new step)
   * @param selBefore selection at the moment of the change (navigation is not recorded,
   *                  so the stored "before" state gets the live selection)
   */
  push(state: S, key: string | null = null, selBefore?: string): void {
    if (state.root === this.present.root) {
      this.present = state; // selection-only change: never an undo step
      return;
    }
    if (key !== null && key === this.openKey) {
      this.present = state;
      return;
    }
    const before: S = selBefore === undefined ? this.present : { ...this.present, sel: selBefore };
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    if (this.future.length) this.clearedFuture.set(before, this.future); // comes back if this step is dropped
    this.future = [];
    this.present = state;
    this.openKey = key;
  }

  /**
   * Replace the present without recording anything: for view-state changes (collapse/expand) and for
   * re-applying view state to a restored snapshot. Past, future and an open coalescing session are untouched.
   */
  replacePresent(state: S): void {
    this.present = state;
  }

  /** The stored "before" snapshot of the most recent step (identity is stable across undo/redo). */
  get lastStep(): S | null {
    return this.past[this.past.length - 1] ?? null;
  }

  /** End the current coalescing session (edit finished, Esc, blur, navigation...). */
  close(): void {
    this.openKey = null;
  }

  /**
   * Drop the most recent step without leaving a redo entry (Esc cancels an edit, a brand-new node is removed
   * again, a no-op edit session). The redo stack the step had discarded is restored: the history is exactly as
   * it was before the step.
   */
  dropStep(): S {
    const step = this.past.pop();
    if (step === undefined) return this.present;
    const cleared = this.clearedFuture.get(step);
    if (cleared) {
      this.future = cleared;
      this.clearedFuture.delete(step);
    }
    this.present = step;
    this.openKey = null;
    return this.present;
  }

  /** Drop the open session's step entirely (e.g. a new node left empty). */
  revert(): S {
    if (this.openKey === null) return this.present;
    return this.dropStep();
  }

  undo(): S | null {
    this.openKey = null;
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    this.clearedFuture.delete(prev); // undone: the redo path is this step now, not what it had discarded
    return this.present;
  }

  redo(): S | null {
    this.openKey = null;
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }
}
