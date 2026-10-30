/**
 * PATCH: a method replaced by a wrapper, undone when the plugin unloads, written by hand (no monkey-around). The plugin
 * patches one method, WorkspaceLeaf.prototype.setViewState (AUTO-OPEN, as the Kanban plugin does).
 *  - The wrapper calls the original through `wrap`, so other plugins' patches of the same method keep working.
 *  - Undo: when the method is still the wrapper, the original goes back. When another plugin wrapped the method after
 *    this one (its wrapper calls this one), taking this one out would break that chain: the wrapper stays and turns into
 *    a plain pass-through to the original instead. Either way the plugin's code no longer runs.
 */
// The methods patched are of any shape: the wrapper passes `this` and every argument through unchanged.
type Passing = (this: unknown, ...args: unknown[]) => unknown;

export function patchMethod<T extends object, K extends keyof T>(target: T, key: K, wrap: (original: T[K]) => T[K]): () => void {
  const original = target[key];
  if (typeof original !== 'function') throw new Error(`patchMethod: ${String(key)} is not a method`);
  const replacement = wrap(original) as unknown as Passing;
  const passOn = original as unknown as Passing;
  let active = true;
  const patched: Passing = function (this: unknown, ...args: unknown[]): unknown {
    return active ? replacement.apply(this, args) : passOn.apply(this, args);
  };
  target[key] = patched as unknown as T[K];
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    active = false;
    if (target[key] === (patched as unknown as T[K])) target[key] = original;
  };
}
