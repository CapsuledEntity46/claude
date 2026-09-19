import { itemDef } from './itemdefs';
import { canMerge, merge, makeStack, reviveStack, stackWeight, type ItemStack } from './item';

/** An item occupying a rectangle of grid cells. */
export interface PlacedItem {
  stack: ItemStack;
  x: number;
  y: number;
  /** Rotated 90 degrees — swaps the footprint's width and height. */
  rot: boolean;
}

export interface Footprint { w: number; h: number; }

export function footprintOf(stack: ItemStack, rot: boolean): Footprint {
  const d = itemDef(stack.id);
  return rot ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}

/**
 * A Tarkov/Rust style spatial grid container.
 *
 * Occupancy is tracked in a flat array of item indices so overlap tests are O(area)
 * rather than O(items).
 */
export class Container {
  readonly id: string;
  cols: number;
  rows: number;
  items: PlacedItem[] = [];
  /** Cell -> index into `items`, or -1. */
  private occ: Int16Array;
  /** Purely cosmetic label for the loot window. */
  label: string;
  /** Locked containers need a lockpick or a key. */
  locked = false;

  constructor(id: string, cols: number, rows: number, label = 'Container') {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.label = label;
    this.occ = new Int16Array(cols * rows).fill(-1);
  }

  get capacity(): number { return this.cols * this.rows; }

  private idx(x: number, y: number): number { return y * this.cols + x; }

  private reindex(): void {
    this.occ.fill(-1);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const fp = footprintOf(it.stack, it.rot);
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const cx = it.x + dx, cy = it.y + dy;
          if (cx < this.cols && cy < this.rows) this.occ[this.idx(cx, cy)] = i;
        }
      }
    }
  }

  /** Item occupying a cell, or null. */
  at(x: number, y: number): PlacedItem | null {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    const i = this.occ[this.idx(x, y)];
    return i < 0 ? null : this.items[i];
  }

  /** Is a w*h rectangle at (x,y) free? `ignore` lets an item test its own move. */
  canPlaceAt(x: number, y: number, fp: Footprint, ignore?: PlacedItem): boolean {
    if (x < 0 || y < 0 || x + fp.w > this.cols || y + fp.h > this.rows) return false;
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const i = this.occ[this.idx(x + dx, y + dy)];
        if (i >= 0 && this.items[i] !== ignore) return false;
      }
    }
    return true;
  }

  /** First free position for a footprint, scanning row-major. Tries rotation too. */
  findFit(stack: ItemStack): { x: number; y: number; rot: boolean } | null {
    for (const rot of [false, true]) {
      const fp = footprintOf(stack, rot);
      if (rot && fp.w === fp.h) continue; // square: rotation is a no-op
      for (let y = 0; y + fp.h <= this.rows; y++) {
        for (let x = 0; x + fp.w <= this.cols; x++) {
          if (this.canPlaceAt(x, y, fp)) return { x, y, rot };
        }
      }
    }
    return null;
  }

  /** Place at an explicit cell. Returns false if it doesn't fit. */
  placeAt(stack: ItemStack, x: number, y: number, rot = false): boolean {
    if (!this.canPlaceAt(x, y, footprintOf(stack, rot))) return false;
    this.items.push({ stack, x, y, rot });
    this.reindex();
    return true;
  }

  /**
   * Insert a stack, topping up existing stacks first.
   *
   * On success the passed-in stack object is the one stored (so callers keeping a
   * reference still see the right item). When only part of it fits, the stack's
   * `count` is reduced to the leftover and that leftover is returned.
   */
  add(stack: ItemStack): number {
    // Top up partial stacks of the same item first.
    for (const it of this.items) {
      if (stack.count <= 0) break;
      if (canMerge(it.stack, stack)) merge(it.stack, stack);
    }
    if (stack.count <= 0) return 0;

    const max = itemDef(stack.id).stack;
    let guard = 0;
    while (stack.count > 0 && guard++ < 1024) {
      const spot = this.findFit(stack);
      if (!spot) break;

      if (stack.count <= max) {
        // Whole thing fits in one cell-stack; store the original object.
        this.items.push({ stack, x: spot.x, y: spot.y, rot: spot.rot });
        this.reindex();
        return 0;
      }

      // More units than a single stack holds: peel off a full one and continue.
      const piece = makeStack(stack.id, max);
      stack.count -= max;
      this.items.push({ stack: piece, x: spot.x, y: spot.y, rot: spot.rot });
      this.reindex();
    }
    return stack.count;
  }

  /** Convenience: add by id/count. Returns units that didn't fit. */
  addItem(id: string, count = 1): number {
    let remaining = count;
    const max = itemDef(id).stack;
    let guard = 0;
    while (remaining > 0 && guard++ < 1024) {
      const chunk = Math.min(remaining, max);
      const left = this.add(makeStack(id, chunk));
      remaining -= chunk - left;
      if (left > 0) break; // container is full
    }
    return remaining;
  }

  remove(item: PlacedItem): boolean {
    const i = this.items.indexOf(item);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.reindex();
    return true;
  }

  removeStack(stack: ItemStack): boolean {
    const found = this.items.find((i) => i.stack === stack);
    return found ? this.remove(found) : false;
  }

  clear(): void {
    this.items.length = 0;
    this.occ.fill(-1);
  }

  /** Total units of an item id held. */
  countOf(id: string): number {
    let n = 0;
    for (const it of this.items) if (it.stack.id === id) n += it.stack.count;
    return n;
  }

  has(id: string, n = 1): boolean { return this.countOf(id) >= n; }

  /** Consume up to `n` units. Returns how many were actually taken. */
  take(id: string, n: number): number {
    let need = n;
    for (let i = this.items.length - 1; i >= 0 && need > 0; i--) {
      const it = this.items[i];
      if (it.stack.id !== id) continue;
      const taken = Math.min(need, it.stack.count);
      it.stack.count -= taken;
      need -= taken;
      if (it.stack.count <= 0) this.items.splice(i, 1);
    }
    if (need !== n) this.reindex();
    return n - need;
  }

  /** First stack matching a predicate. */
  find(pred: (s: ItemStack) => boolean): PlacedItem | undefined {
    return this.items.find((i) => pred(i.stack));
  }

  findAll(pred: (s: ItemStack) => boolean): PlacedItem[] {
    return this.items.filter((i) => pred(i.stack));
  }

  get weight(): number {
    let w = 0;
    for (const it of this.items) w += stackWeight(it.stack);
    return w;
  }

  get isEmpty(): boolean { return this.items.length === 0; }

  get usedCells(): number {
    let n = 0;
    for (const it of this.items) {
      const fp = footprintOf(it.stack, it.rot);
      n += fp.w * fp.h;
    }
    return n;
  }

  /**
   * Grow or shrink the grid (equipping/removing a backpack).
   * Items that no longer fit are returned so the caller can drop them.
   */
  resize(cols: number, rows: number): ItemStack[] {
    const evicted: ItemStack[] = [];
    const old = this.items;
    this.cols = cols;
    this.rows = rows;
    this.occ = new Int16Array(cols * rows).fill(-1);
    this.items = [];

    // Re-place in original order; anything that can't fit is evicted.
    for (const it of old) {
      const fp = footprintOf(it.stack, it.rot);
      if (this.canPlaceAt(it.x, it.y, fp)) {
        this.items.push(it);
        this.reindex();
        continue;
      }
      const spot = this.findFit(it.stack);
      if (spot) {
        this.items.push({ stack: it.stack, x: spot.x, y: spot.y, rot: spot.rot });
        this.reindex();
      } else {
        evicted.push(it.stack);
      }
    }
    return evicted;
  }

  /** Move an item within this container, or reposition after a rotation. */
  moveWithin(item: PlacedItem, x: number, y: number, rot: boolean): boolean {
    if (!this.canPlaceAt(x, y, footprintOf(item.stack, rot), item)) return false;
    item.x = x;
    item.y = y;
    item.rot = rot;
    this.reindex();
    return true;
  }

  /** Compact everything toward the top-left, largest items first. */
  sort(): void {
    const stacks = this.items.map((i) => i.stack);
    this.clear();
    stacks.sort((a, b) => {
      const da = itemDef(a.id), db = itemDef(b.id);
      const area = db.w * db.h - da.w * da.h;
      if (area !== 0) return area;
      return da.name.localeCompare(db.name);
    });
    for (const s of stacks) this.add(s);
  }

  serialize() {
    return {
      id: this.id, cols: this.cols, rows: this.rows, label: this.label, locked: this.locked,
      items: this.items.map((i) => ({ x: i.x, y: i.y, rot: i.rot, stack: { ...i.stack } })),
    };
  }

  static deserialize(d: ReturnType<Container['serialize']>): Container {
    const c = new Container(d.id, d.cols, d.rows, d.label);
    c.locked = d.locked;
    for (const raw of d.items) {
      // Skip items removed from the database between saves.
      try { itemDef(raw.stack.id); } catch { continue; }
      c.items.push({ x: raw.x, y: raw.y, rot: raw.rot, stack: reviveStack(raw.stack) });
    }
    c.reindex();
    return c;
  }
}
