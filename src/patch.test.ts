/**
 * PATCH (patch.ts) and the plugin's patch of WorkspaceLeaf.setViewState (AUTO-OPEN, main.ts) against the small
 * `obsidian` fake: installed, deciding, chained with another plugin's patch, and undone.
 */
import { describe, expect, it } from 'vitest';
import { FLAG_KEY, VIEW_TYPE } from './constants.js';
import MindslatePlugin from './main.js';
import { patchMethod } from './patch.js';
// the module main.ts gets for `obsidian` here (vitest.config.ts), imported by its path for its own types
import { TFile, WorkspaceLeaf } from '../test/fake-obsidian.js';

describe('PATCH', () => {
  it('wraps a method, passes `this` and the arguments through, and puts the original back', () => {
    const obj = {
      n: 1,
      add(x: number): number {
        return this.n + x;
      },
    };
    const original = obj.add;
    const undo = patchMethod(obj, 'add', (orig) =>
      function (this: typeof obj, x: number) {
        return orig.call(this, x) * 10;
      },
    );
    expect(obj.add(2)).toBe(30);
    undo();
    expect(obj.add).toBe(original);
    expect(obj.add(2)).toBe(3);
    undo(); // twice: nothing
    expect(obj.add).toBe(original);
  });

  it('a later patch of another plugin keeps working after ours is undone: ours becomes a pass-through', () => {
    const obj = { f: (x: number): number => x };
    const undoOurs = patchMethod(obj, 'f', (orig) => (x: number) => orig(x) + 100);
    const undoTheirs = patchMethod(obj, 'f', (orig) => (x: number) => orig(x) * 2);
    expect(obj.f(1)).toBe(202);
    undoOurs();
    expect(obj.f(1)).toBe(2); // theirs still runs, ours no longer does
    undoTheirs();
    expect(obj.f(1)).toBe(1);
  });
});

/** A plugin wired to a minimal fake app: which notes are flagged, whether the layout is ready. */
function pluginWith(flagged: Set<string>, layoutReady = true): { plugin: MindslatePlugin; unpatch: () => void } {
  const plugin = Object.create(MindslatePlugin.prototype) as MindslatePlugin;
  const files = new Map<string, TFile>();
  const fileOf = (p: string): TFile => {
    let f = files.get(p);
    if (f === undefined) files.set(p, (f = new TFile(p)));
    return f;
  };
  Object.assign(plugin, {
    choices: new WeakMap(),
    app: {
      workspace: { layoutReady },
      vault: { getAbstractFileByPath: (p: string) => fileOf(p) },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: flagged.has(f.path) ? { [FLAG_KEY]: 'map' } : {} }) },
    },
  });
  (plugin as unknown as { patchLeaves(): void }).patchLeaves();
  return { plugin, unpatch: () => (plugin as unknown as { unpatch: () => void }).unpatch() };
}

describe('AUTO-OPEN through the patched WorkspaceLeaf.setViewState', () => {
  it('a flagged note asked for as Markdown becomes the map; others stay; Open as Markdown sticks; unload undoes it', async () => {
    const original = WorkspaceLeaf.prototype.setViewState;
    const { plugin, unpatch } = pluginWith(new Set(['Map.md']));
    const leaf = new WorkspaceLeaf();
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    await leaf.setViewState({ type: 'markdown', state: { file: 'Note.md' } });
    await leaf.setViewState({ type: 'canvas', state: { file: 'Map.md' } });
    expect(leaf.states.map((s) => s.type)).toEqual([VIEW_TYPE, 'markdown', 'canvas']);
    (plugin as unknown as { choose(l: WorkspaceLeaf, p: string, c: string): void }).choose(leaf, 'Map.md', 'markdown');
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    expect(leaf.states.at(-1)?.type).toBe('markdown'); // STICKY-MARKDOWN in this tab
    const other = new WorkspaceLeaf();
    await other.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    expect(other.states.at(-1)?.type).toBe(VIEW_TYPE); // ...not in another one
    unpatch();
    expect(WorkspaceLeaf.prototype.setViewState).toBe(original);
    await other.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    expect(other.states.at(-1)?.type).toBe('markdown');
  });

  it('while Obsidian restores the saved layout, every tab keeps the type it was saved with', async () => {
    const { unpatch } = pluginWith(new Set(['Map.md']), false);
    const leaf = new WorkspaceLeaf();
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    expect(leaf.states[0]?.type).toBe('markdown');
    unpatch();
  });
});
