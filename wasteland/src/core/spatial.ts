/**
 * Uniform spatial hash for broad-phase queries.
 *
 * Rebuilt each tick from the live entity list — with a few hundred entities this
 * is far cheaper than maintaining incremental buckets, and it never goes stale.
 */
export interface HasPosition { x: number; y: number; }

export class SpatialHash<T extends HasPosition> {
  private buckets = new Map<number, T[]>();
  private readonly invCell: number;

  constructor(cellSize = 128) {
    this.invCell = 1 / cellSize;
  }

  private key(cx: number, cy: number): number {
    // Pack two signed 16-bit cell coords into one integer key.
    return ((cx + 32768) << 16) | ((cy + 32768) & 0xffff);
  }

  clear(): void { this.buckets.clear(); }

  insert(item: T): void {
    const cx = Math.floor(item.x * this.invCell);
    const cy = Math.floor(item.y * this.invCell);
    const k = this.key(cx, cy);
    const b = this.buckets.get(k);
    if (b) b.push(item);
    else this.buckets.set(k, [item]);
  }

  rebuild(items: Iterable<T>): void {
    this.clear();
    for (const it of items) this.insert(it);
  }

  /** All items in cells overlapping the given circle (broad phase — may over-report). */
  query(x: number, y: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const minX = Math.floor((x - radius) * this.invCell);
    const maxX = Math.floor((x + radius) * this.invCell);
    const minY = Math.floor((y - radius) * this.invCell);
    const maxY = Math.floor((y + radius) * this.invCell);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (b) for (const it of b) out.push(it);
      }
    }
    return out;
  }

  /** Items whose cells overlap an axis-aligned rectangle. */
  queryRect(x: number, y: number, w: number, h: number, out: T[] = []): T[] {
    out.length = 0;
    const minX = Math.floor(x * this.invCell);
    const maxX = Math.floor((x + w) * this.invCell);
    const minY = Math.floor(y * this.invCell);
    const maxY = Math.floor((y + h) * this.invCell);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (b) for (const it of b) out.push(it);
      }
    }
    return out;
  }

  /** Nearest item passing an optional filter, within `radius`. */
  nearest(x: number, y: number, radius: number, filter?: (t: T) => boolean): T | null {
    const candidates = this.query(x, y, radius);
    let best: T | null = null;
    let bestD2 = radius * radius;
    for (const c of candidates) {
      if (filter && !filter(c)) continue;
      const dx = c.x - x, dy = c.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) { bestD2 = d2; best = c; }
    }
    return best;
  }
}
