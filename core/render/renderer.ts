/// <reference lib="dom" />
/**
 * The DOM + SVG renderer: one absolutely positioned <div class="mm-node"><div class="mm-label"> per
 * visible node, an SVG layer under them for the connectors, and the collapse handles (render/handles.ts)
 * as children of their node's element: <div class="mm-ring"> on an expanded node with visible children
 * (the root excepted), <div class="mm-badge"> (stub + count) on a collapsed one. Being children of the
 * node, the handles move with it, fade with it during a drag, paint above the connectors, and the node's
 * hover region includes them and the hover bridge between its box and its ring (the editor toggles mm-hover
 * on the node; CSS shows the ring while the node is hovered or selected, never during a node drag). Every attribute write is diffed against what the element already shows, so a
 * render after a pan or a selection change touches only what changed; the editor (view/editor.ts) owns
 * the state and calls render() after every relayout.
 */
import type { MapNode } from '../format/types.js';
import type { Layout, LayoutNode } from '../layout/types.js';
import { depthClass } from '../layout/types.js';
import type { TreeIndex } from '../model/tree.js';
import { branchColorOf, type BranchColors } from './colors.js';
import type { ElementFactory } from './element.js';
import { buildConnectors } from './connectors.js';
import { BADGE_GAP, BADGE_SIZE, RING_HIT, handleKind, hiddenCount, isPill } from './handles.js';
import { DEFAULT_COLORS, strokeFor, type MapColors, type Theme } from './theme.js';

export const SVGNS = 'http://www.w3.org/2000/svg';

/** The ring handle of an expanded node (a child element of the node, positioned relative to its box). */
export interface RingView {
  readonly el: HTMLDivElement;
  x: number;
  y: number;
  color: string;
}

/** The count badge (with its stub) of a collapsed node. */
export interface BadgeView {
  readonly el: HTMLDivElement;
  count: number;
  color: string;
  x: number;
  y: number;
  stroke: number;
  pill: boolean;
}

/** What the renderer keeps per visible node (the editor reads `label` and `text` while editing). */
export interface NodeView {
  readonly el: HTMLDivElement;
  readonly label: HTMLDivElement;
  /** The text the label shows (null forces a re-sync from the model on the next render). */
  text: string | null;
  dc: number;
  depth: number;
  expanded: string;
  x: number;
  y: number;
  /** The primary selected node (.mm-selected: the selection ring, the focus halo, its collapse ring shown). */
  selected: boolean | null;
  /** Another node of a multi-selection (.mm-multi: the selection ring). */
  multi: boolean | null;
  /** aria-selected: the primary or another selected node. */
  aria: boolean | null;
  ring: RingView | null;
  badge: BadgeView | null;
  /** The label width pinned for a wrapped text (NaN: none, the CSS max-content width; -1: not set yet). */
  w: number;
}

interface PathView {
  readonly el: SVGPathElement;
  d: string;
  color: string;
  width: number;
}

export interface RenderInput {
  readonly lay: Layout;
  readonly index: TreeIndex;
  /** The selected node (the primary of a multi-selection); null: none shown (the editor's REST). */
  readonly sel: string | null;
  /** The other selected nodes of a multi-selection (default: none). */
  readonly multi?: ReadonlySet<string>;
  readonly editingId: string | null;
  readonly colors: BranchColors;
}

const NONE: ReadonlySet<string> = new Set();

/** Connector key: the root fan has one path per level-1 child ('r>' + childId); every other parent one path. */
export const pathKey = (childDepth: number, parentId: string, firstChildId: string | undefined): string =>
  childDepth === 1 && firstChildId !== undefined ? 'r>' + firstChildId : parentId;

export class MapRenderer {
  readonly els = new Map<string, NodeView>();
  readonly paths = new Map<string, PathView>();
  private activeDesc: string | null = null;
  /**
   * The selection colour (a connector's fallback when its branch has none) and the collapsed root's badge colour
   * (EditorHandle.setColors replaces them; the next render repaints what changed).
   */
  paint: Pick<MapColors, 'selection' | 'rootBadge'> = DEFAULT_COLORS;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly world: HTMLElement,
    private readonly gPaths: SVGGElement,
    private readonly theme: Theme,
    /** Element ids never collide between two mounts. */
    readonly domId: (id: string) => string,
    /** Makes the node, label, ring and badge elements (the host's ElementFactory). */
    private readonly make: ElementFactory,
  ) {}

  render({ lay, index, sel, multi = NONE, editingId, colors }: RenderInput): void {
    const R = lay.nodes.get(lay.rootId);
    const l1: readonly string[] = R ? R.childIds : [];
    const seen = new Set<string>();
    for (const L of lay.order) {
      seen.add(L.id);
      let r = this.els.get(L.id);
      if (!r) {
        const el = this.make('div');
        el.className = 'mm-node';
        el.dataset['id'] = L.id;
        el.id = this.domId(L.id);
        el.setAttribute('role', 'treeitem');
        const label = this.make('div');
        label.className = 'mm-label';
        el.appendChild(label);
        r = { el, label, text: null, dc: -1, depth: -1, expanded: '', x: NaN, y: NaN, selected: null, multi: null, aria: null, ring: null, badge: null, w: -1 };
        this.els.set(L.id, r);
        this.world.appendChild(el);
      }
      const n = index.get(L.id)?.node;
      if (!n) continue;
      const dc = depthClass(L.depth);
      if (r.dc !== dc) {
        r.el.classList.remove('mm-d0', 'mm-d1', 'mm-d2');
        r.el.classList.add('mm-d' + dc);
        r.dc = dc;
      }
      if (r.depth !== L.depth) {
        r.el.setAttribute('aria-level', String(L.depth + 1));
        r.depth = L.depth;
      }
      const expanded = n.children.length ? String(!n.collapsed) : '';
      if (r.expanded !== expanded) {
        if (expanded) r.el.setAttribute('aria-expanded', expanded);
        else r.el.removeAttribute('aria-expanded');
        r.expanded = expanded;
      }
      if (r.text !== n.text && L.id !== editingId) {
        r.label.textContent = n.text;
        r.text = n.text;
      }
      if (L.id !== editingId) this.pinWidth(r, L, n);
      if (r.x !== L.x || r.y !== L.y) {
        r.el.style.transform = `translate(${L.x}px,${L.y}px)`;
        r.x = L.x;
        r.y = L.y;
      }
      this.mark(r, L.id, sel, multi);
      const kind = handleKind(L, n);
      if (kind === 'ring') this.ring(r, L, l1, colors);
      else if (r.ring) {
        r.ring.el.remove();
        r.el.classList.remove('mm-has-ring');
        r.ring = null;
      }
      if (kind === 'badge') this.badge(r, L, n, l1, colors);
      else if (r.badge) {
        r.badge.el.remove();
        r.badge = null;
      }
    }
    for (const [id, r] of this.els) {
      if (!seen.has(id)) {
        r.el.remove();
        this.els.delete(id);
      }
    }
    if (this.activeDesc !== sel) {
      if (sel === null) this.viewport.removeAttribute('aria-activedescendant');
      else this.viewport.setAttribute('aria-activedescendant', this.domId(sel));
      this.activeDesc = sel;
    }

    // connectors: one <path> per root->child edge and per non-root parent fan
    const seenP = new Set<string>();
    for (const c of buildConnectors(lay, this.theme)) {
      const k = pathKey(c.childDepth, c.parentId, c.childIds[0]);
      seenP.add(k);
      let p = this.paths.get(k);
      if (!p) {
        const el = document.createElementNS(SVGNS, 'path');
        this.gPaths.appendChild(el);
        p = { el, d: '', color: '', width: NaN };
        this.paths.set(k, p);
      }
      const l1id = c.childDepth === 1 ? c.childIds[0] : l1[lay.nodes.get(c.parentId)?.branch ?? -1];
      const color = (l1id !== undefined ? colors.color(l1id) : undefined) ?? colors.palette[0] ?? this.paint.selection;
      if (p.d !== c.d) p.el.setAttribute('d', (p.d = c.d));
      if (p.color !== color) p.el.setAttribute('stroke', (p.color = color));
      if (p.width !== c.width) p.el.setAttribute('stroke-width', String((p.width = c.width)));
    }
    for (const [k, p] of this.paths) {
      if (!seenP.has(k)) {
        p.el.remove();
        this.paths.delete(k);
      }
    }
  }

  /** The selection classes of one node: diffed, so an unchanged node costs three comparisons. */
  private mark(r: NodeView, id: string, sel: string | null, multi: ReadonlySet<string>): void {
    const isSel = sel !== null && id === sel;
    if (r.selected !== isSel) {
      r.el.classList.toggle('mm-selected', isSel);
      r.selected = isSel;
    }
    const isMulti = !isSel && multi.has(id);
    if (r.multi !== isMulti) {
      r.el.classList.toggle('mm-multi', isMulti);
      r.multi = isMulti;
    }
    const aria = isSel || isMulti;
    if (r.aria !== aria) {
      r.el.setAttribute('aria-selected', String(aria));
      r.aria = aria;
    }
  }

  /**
   * The selection marks alone, without a render (a marquee's live preview on every pointermove): no layout, no
   * connector, only the classes of the nodes whose marks change.
   */
  markSelection(sel: string | null, multi: ReadonlySet<string>): void {
    for (const [id, r] of this.els) this.mark(r, id, sel, multi);
  }

  /**
   * A text wrapped by its max-width is as wide as that max-width in CSS (width: max-content, capped), while the
   * layout, the connector stub, the collapse handles and the measurer (render/dom-measure.ts) use the tight
   * width of its widest line. The label of such a node is pinned to that width (half a pixel of slack, so the
   * widest line never wraps again on a rounding difference; CSS max-width still caps it, so no word from a
   * next line can move up), and so is the node element's own content box: the node box, its selection and
   * drop-parent rings are the layout box even where the measured line is wider than max-width (Chrome and
   * WebKit count the space hanging at a soft wrap: the label stops at max-width, the box does not). A label that
   * does not wrap keeps its natural width, which already is the tight width. Never while it is edited.
   */
  private pinWidth(r: NodeView, L: LayoutNode, n: MapNode): void {
    const st = this.theme.styles[depthClass(L.depth)];
    const lines = n.text.split('\n').length;
    const wrapped = L.h - 2 * st.padY > lines * st.lineHeight + 1;
    const w = wrapped ? Math.max(0, L.w - 2 * st.padX) : NaN;
    if (Object.is(r.w, w)) return;
    r.label.style.width = wrapped ? `${w + 0.5}px` : '';
    r.el.style.width = wrapped ? `${w}px` : '';
    r.w = w;
  }

  /** The label of a node being edited grows with its text: no pinned width until the edit ends. */
  freeWidth(r: NodeView): void {
    r.label.style.removeProperty('width');
    r.el.style.removeProperty('width');
    r.w = -1;
  }

  /**
   * The ring of an expanded node: centred on the end of its stub, (w + stub, h / 2) in the node's own box. The node
   * gets .mm-has-ring: its transparent hover bridge across the 8 px between its box and the ring (editor.css; for
   * presses and double-clicks that strip is empty canvas, see the editor's pressedNode).
   */
  private ring(r: NodeView, L: LayoutNode, l1: readonly string[], colors: BranchColors): void {
    let g = r.ring;
    if (!g) {
      const el = this.make('div');
      el.className = 'mm-ring';
      el.dataset['id'] = L.id;
      el.title = 'Collapse';
      el.setAttribute('aria-hidden', 'true'); // the treeitem's aria-expanded and Mod+/ carry it for assistive tech
      g = { el, x: NaN, y: NaN, color: '' };
      r.ring = g;
      r.el.appendChild(el);
      r.el.classList.add('mm-has-ring');
    }
    const x = L.w + this.theme.stub - RING_HIT / 2;
    const y = L.h / 2 - RING_HIT / 2;
    if (g.x !== x || g.y !== y) {
      g.el.style.transform = `translate(${x}px,${y}px)`;
      g.x = x;
      g.y = y;
    }
    const color = this.branchColor(L, l1, colors);
    if (g.color !== color) {
      g.el.style.setProperty('--mm-c', color);
      g.color = color;
    }
  }

  /** The badge of a collapsed node: a BADGE_GAP px stub from the box's right edge, then the count. */
  private badge(r: NodeView, L: LayoutNode, n: MapNode, l1: readonly string[], colors: BranchColors): void {
    let b = r.badge;
    if (!b) {
      const el = this.make('div');
      el.className = 'mm-badge';
      el.dataset['id'] = L.id;
      el.title = 'Expand';
      el.setAttribute('aria-hidden', 'true');
      b = { el, count: -1, color: '', x: NaN, y: NaN, stroke: NaN, pill: false };
      r.badge = b;
      r.el.appendChild(el);
    }
    const count = hiddenCount(n);
    if (b.count !== count) {
      b.el.textContent = String(count);
      b.count = count;
      const pill = isPill(count);
      if (b.pill !== pill) {
        b.el.classList.toggle('mm-pill', pill);
        b.pill = pill;
      }
    }
    const x = L.w + BADGE_GAP;
    const y = L.h / 2 - BADGE_SIZE / 2;
    if (b.x !== x || b.y !== y) {
      b.el.style.transform = `translate(${x}px,${y}px)`;
      b.x = x;
      b.y = y;
    }
    const color = this.branchColor(L, l1, colors);
    if (b.color !== color) {
      b.el.style.setProperty('--mm-c', color);
      b.color = color;
    }
    const stroke = strokeFor(this.theme, L.depth + 1); // the fan this stub stands in for
    if (b.stroke !== stroke) {
      b.el.style.setProperty('--mm-sw', stroke + 'px');
      b.stroke = stroke;
    }
  }

  branchColor(L: LayoutNode, level1Ids: readonly string[], colors: BranchColors): string {
    return branchColorOf(colors, L, level1Ids, this.paint.rootBadge);
  }

  /**
   * Fade (or restore) the dragged subtrees and their connectors: every node of `ids`, their fans, and the root edge of
   * each dragged node (`draggedIds`: one node, or the top-level nodes of a dragged multi-selection).
   */
  setDragging(ids: Iterable<string>, draggedIds: Iterable<string>, on: boolean): void {
    for (const x of ids) {
      const r = this.els.get(x);
      if (r) r.el.classList.toggle('mm-dragging', on);
      const p = this.paths.get(x);
      if (p) p.el.classList.toggle('mm-dragging', on);
    }
    for (const d of draggedIds) {
      const own = this.paths.get('r>' + d);
      if (own) own.el.classList.toggle('mm-dragging', on);
    }
  }

  domCount(): { nodes: number; paths: number; badges: number; rings: number } {
    let badges = 0;
    let rings = 0;
    for (const r of this.els.values()) {
      if (r.badge) badges++;
      if (r.ring) rings++;
    }
    return { nodes: this.els.size, paths: this.paths.size, badges, rings };
  }

  /** Remove every element (load/destroy); the handles go with their node. */
  reset(): void {
    for (const r of this.els.values()) r.el.remove();
    this.els.clear();
    for (const p of this.paths.values()) p.el.remove();
    this.paths.clear();
    this.activeDesc = null;
  }
}
