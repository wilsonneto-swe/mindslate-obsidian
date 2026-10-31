/**
 * A small stand-in for the `obsidian` module in unit tests (vitest.config.ts aliases it): Obsidian provides the real
 * one at runtime, and the npm package holds types only. Just what the plugin's modules use, behaving as far as the
 * tests need: WorkspaceLeaf.prototype.setViewState (the method main.ts patches), the file classes, normalizePath.
 */
export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, '');
  }
  get extension(): string {
    const dot = this.name.lastIndexOf('.');
    return dot < 0 ? '' : this.name.slice(dot + 1);
  }
}

export class TFolder extends TAbstractFile {
  isRoot(): boolean {
    return this.path === '/' || this.path === '';
  }
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
}

/** A leaf that records the view states it was asked for. */
export class WorkspaceLeaf {
  readonly states: ViewState[] = [];
  view: unknown = null;
  async setViewState(state: ViewState, _eState?: unknown): Promise<void> {
    this.states.push(state);
  }
}

export class MarkdownView {}
export class Plugin {}
export class TextFileView {}
export class Scope {
  register(): void {}
}
export class Menu {}
export class Keymap {
  static isModEvent(): boolean {
    return false;
  }
}
export class Notice {
  constructor(readonly message: string) {}
  hide(): void {}
}
export const Platform = { isMobile: false, isMacOS: true, isPhone: false };

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
