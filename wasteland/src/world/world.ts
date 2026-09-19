/**
 * Runtime world: spatial queries, collision, line of sight and the mutable
 * state layered on top of generated terrain (harvested nodes, looted
 * containers, player-built structures and deployables).
 */

import { RNG } from '../core/rng';
import { rayCircle, rayRect, resolveCircleRect, type Rect, type Vec2 } from '../core/math';
import { Container } from '../items/container';
import { rollLoot, type LootTableName } from '../items/lootTables';
import type { Station } from '../items/recipes';
import { Tile, TILES, TILE_SIZE, type Biome } from './tiles';
import { PROPS, type PropKind } from './props';
import type { Building, WallSeg } from './buildings';
import { generateWorld, WORLD_UNITS, type TownInfo, type WorldData } from './worldgen';

export interface Prop {
  id: number;
  kind: PropKind;
  x: number;
  y: number;
  hp: number;
  variant: number;
  buildingId: number;
  dead: boolean;
  /** Seconds until a harvested resource node comes back. */
  respawn: number;
  container?: Container;
  /** Loot is rolled lazily the first time a container is opened. */
  lootRolled: boolean;
}

/** Player-built structure piece. */
export type StructureKind = 'foundation' | 'wall' | 'doorway' | 'door' | 'floor';

/** Twig -> wood -> stone -> metal, matching Rust's upgrade path. */
export const TIER_NAMES = ['Twig', 'Wood', 'Stone', 'Sheet Metal'] as const;
export const TIER_HP = [60, 250, 500, 1000];
export const TIER_COST: readonly (readonly [string, number])[][] = [
  [['wood', 10]],
  [['wood', 100]],
  [['stone', 150]],
  [['metal_frag', 200]],
];
export const TIER_COLORS = ['#6b5a3e', '#8a6134', '#7d7d80', '#8d9298'];

export interface Structure {
  id: number;
  kind: StructureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
  hp: number;
  /** Doors only. */
  open: boolean;
}

export interface Deployable {
  id: number;
  /** `deploy` key from the item definition. */
  kind: string;
  itemId: string;
  x: number;
  y: number;
  hp: number;
  radius: number;
  container?: Container;
  /** Burn time remaining for campfires/furnaces. */
  fuel: number;
  lit: boolean;
  /** Traps fire once then need resetting. */
  armed: boolean;
  /** Water catchers slowly fill. */
  charge: number;
}

interface CellBuckets {
  walls: WallSeg[];
  props: number[];
}

const GRID_CELL = 128;

export class World {
  readonly data: WorldData;
  readonly rng: RNG;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly sizeUnits = WORLD_UNITS;

  props: Prop[] = [];
  structures: Structure[] = [];
  deployables: Deployable[] = [];

  private cells = new Map<number, CellBuckets>();
  private nextStructureId = 1;
  private nextDeployableId = 1;

  /** Bumped whenever structures/deployables change, so caches can invalidate. */
  buildVersion = 0;

  constructor(seed: number | string) {
    this.data = generateWorld(seed);
    this.rng = new RNG(this.data.seed ^ 0xabcd);
    this.tilesX = this.data.tilesX;
    this.tilesY = this.data.tilesY;

    // Instantiate props.
    this.props = this.data.props.map((seedProp, i) => {
      const def = PROPS[seedProp.kind];
      const p: Prop = {
        id: i,
        kind: seedProp.kind,
        x: seedProp.x,
        y: seedProp.y,
        hp: def.harvest ? def.harvest.hp : (def.hp ?? 100),
        variant: seedProp.variant,
        buildingId: seedProp.buildingId,
        dead: false,
        respawn: 0,
        lootRolled: false,
      };
      if (def.container) {
        p.container = new Container(`prop_${i}`, def.container.cols, def.container.rows, def.container.label);
        if (def.container.lockChance) p.container.locked = this.rng.bool(def.container.lockChance);
      }
      return p;
    });

    this.rebuildGrid();
  }

  get buildings(): Building[] { return this.data.buildings; }
  get towns(): TownInfo[] { return this.data.towns; }
  get spawn(): { x: number; y: number } { return this.data.spawn; }

  // -------------------------------------------------------------------------
  // Spatial index
  // -------------------------------------------------------------------------

  private cellKey(cx: number, cy: number): number { return ((cx + 4096) << 13) | ((cy + 4096) & 0x1fff); }

  private bucket(cx: number, cy: number): CellBuckets {
    const k = this.cellKey(cx, cy);
    let b = this.cells.get(k);
    if (!b) { b = { walls: [], props: [] }; this.cells.set(k, b); }
    return b;
  }

  private rebuildGrid(): void {
    this.cells.clear();
    for (const b of this.data.buildings) {
      for (const w of b.walls) {
        const cx0 = Math.floor(w.x / GRID_CELL), cy0 = Math.floor(w.y / GRID_CELL);
        const cx1 = Math.floor((w.x + w.w) / GRID_CELL), cy1 = Math.floor((w.y + w.h) / GRID_CELL);
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.bucket(cx, cy).walls.push(w);
      }
    }
    for (const p of this.props) {
      const def = PROPS[p.kind];
      const r = Math.max(def.radius, def.size * 0.5);
      const cx0 = Math.floor((p.x - r) / GRID_CELL), cy0 = Math.floor((p.y - r) / GRID_CELL);
      const cx1 = Math.floor((p.x + r) / GRID_CELL), cy1 = Math.floor((p.y + r) / GRID_CELL);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.bucket(cx, cy).props.push(p.id);
    }
  }

  /** Walls whose cells overlap a rect. May contain duplicates. */
  wallsNear(x: number, y: number, w: number, h: number, out: WallSeg[] = []): WallSeg[] {
    out.length = 0;
    const cx0 = Math.floor(x / GRID_CELL), cy0 = Math.floor(y / GRID_CELL);
    const cx1 = Math.floor((x + w) / GRID_CELL), cy1 = Math.floor((y + h) / GRID_CELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.cells.get(this.cellKey(cx, cy));
        if (!b) continue;
        for (const s of b.walls) if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  propsNear(x: number, y: number, w: number, h: number, out: Prop[] = []): Prop[] {
    out.length = 0;
    const cx0 = Math.floor(x / GRID_CELL), cy0 = Math.floor(y / GRID_CELL);
    const cx1 = Math.floor((x + w) / GRID_CELL), cy1 = Math.floor((y + h) / GRID_CELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.cells.get(this.cellKey(cx, cy));
        if (!b) continue;
        for (const id of b.props) {
          const p = this.props[id];
          if (!p.dead && !out.includes(p)) out.push(p);
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Terrain lookups
  // -------------------------------------------------------------------------

  tileAtTile(tx: number, ty: number): Tile {
    if (tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY) return Tile.DeepWater;
    return this.data.tiles[ty * this.tilesX + tx] as Tile;
  }

  tileAt(wx: number, wy: number): Tile {
    return this.tileAtTile(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE));
  }

  biomeAt(wx: number, wy: number): Biome {
    const tx = Math.floor(wx / TILE_SIZE), ty = Math.floor(wy / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY) return 0 as Biome;
    return this.data.biome[ty * this.tilesX + tx] as Biome;
  }

  isWater(wx: number, wy: number): boolean { return TILES[this.tileAt(wx, wy)].water; }

  speedAt(wx: number, wy: number): number { return TILES[this.tileAt(wx, wy)].speed; }

  inBounds(wx: number, wy: number): boolean {
    return wx > 8 && wy > 8 && wx < this.sizeUnits - 8 && wy < this.sizeUnits - 8;
  }

  /** The building whose footprint contains this point, if any. */
  buildingAt(wx: number, wy: number): Building | null {
    for (const b of this.data.buildings) {
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return b;
    }
    return null;
  }

  /** True when standing on an interior floor tile (drives temperature and roof fade). */
  isIndoors(wx: number, wy: number): boolean {
    return TILES[this.tileAt(wx, wy)].indoor;
  }

  townAt(wx: number, wy: number): TownInfo | null {
    for (const t of this.data.towns) {
      if (Math.hypot(t.x - wx, t.y - wy) <= t.radius) return t;
    }
    return null;
  }

  nearestTown(wx: number, wy: number): { town: TownInfo; dist: number } | null {
    let best: { town: TownInfo; dist: number } | null = null;
    for (const t of this.data.towns) {
      const d = Math.hypot(t.x - wx, t.y - wy);
      if (!best || d < best.dist) best = { town: t, dist: d };
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  private wallScratch: WallSeg[] = [];
  private propScratch: Prop[] = [];

  /**
   * Push a circle out of every solid thing nearby. Mutates `pos`.
   * Returns true if anything was hit.
   */
  resolveCollision(pos: Vec2, radius: number, opts: { ignoreProps?: boolean } = {}): boolean {
    let hit = false;
    const box = { x: pos.x - radius - 4, y: pos.y - radius - 4, w: radius * 2 + 8, h: radius * 2 + 8 };

    for (const w of this.wallsNear(box.x, box.y, box.w, box.h, this.wallScratch)) {
      if (!w.solid) continue;
      if (resolveCircleRect(pos, radius, w)) hit = true;
    }

    if (!opts.ignoreProps) {
      for (const p of this.propsNear(box.x, box.y, box.w, box.h, this.propScratch)) {
        const def = PROPS[p.kind];
        if (def.radius <= 0) continue;
        const dx = pos.x - p.x, dy = pos.y - p.y;
        const minDist = def.radius + radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        pos.x = p.x + (dx / d) * minDist;
        pos.y = p.y + (dy / d) * minDist;
        hit = true;
      }
    }

    for (const s of this.structures) {
      // Foundations and floors are surfaces you stand on, not walls.
      if (s.kind === 'floor' || s.kind === 'foundation') continue;
      if (s.kind === 'door' && s.open) continue;
      if (s.kind === 'doorway') continue;
      if (Math.abs(s.x + s.w / 2 - pos.x) > s.w / 2 + radius + 4) continue;
      if (Math.abs(s.y + s.h / 2 - pos.y) > s.h / 2 + radius + 4) continue;
      if (resolveCircleRect(pos, radius, s)) hit = true;
    }

    for (const d of this.deployables) {
      if (d.radius <= 0) continue;
      const dx = pos.x - d.x, dy = pos.y - d.y;
      const minDist = d.radius + radius;
      const dd2 = dx * dx + dy * dy;
      if (dd2 >= minDist * minDist || dd2 < 1e-9) continue;
      const dist = Math.sqrt(dd2);
      pos.x = d.x + (dx / dist) * minDist;
      pos.y = d.y + (dy / dist) * minDist;
      hit = true;
    }

    // Keep everything inside the island bounds.
    pos.x = Math.max(8, Math.min(this.sizeUnits - 8, pos.x));
    pos.y = Math.max(8, Math.min(this.sizeUnits - 8, pos.y));
    return hit;
  }

  /** Is this spot free enough to stand in? Used by spawners and deploy placement. */
  isClear(x: number, y: number, radius: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const probe = { x, y };
    const moved = this.resolveCollision(probe, radius);
    return !moved && Math.hypot(probe.x - x, probe.y - y) < 0.01;
  }

  // -------------------------------------------------------------------------
  // Ray casting
  // -------------------------------------------------------------------------

  /**
   * Cast a ray against the static world.
   * `sightOnly` ignores non-opaque geometry such as windows.
   */
  castRay(
    ox: number, oy: number, dx: number, dy: number, maxDist: number,
    opts: { sightOnly?: boolean } = {},
  ): { dist: number; wall?: WallSeg; prop?: Prop; structure?: Structure } | null {
    let best: { dist: number; wall?: WallSeg; prop?: Prop; structure?: Structure } | null = null;

    // Bounding box of the ray for the broad phase.
    const bx = Math.min(ox, ox + dx * maxDist), by = Math.min(oy, oy + dy * maxDist);
    const bw = Math.abs(dx * maxDist), bh = Math.abs(dy * maxDist);

    for (const w of this.wallsNear(bx - 8, by - 8, bw + 16, bh + 16, this.wallScratch)) {
      if (opts.sightOnly && !w.opaque) continue;
      if (!opts.sightOnly && !w.opaque) continue; // bullets pass through windows too
      const t = rayRect(ox, oy, dx, dy, w, maxDist);
      if (t >= 0 && (!best || t < best.dist)) best = { dist: t, wall: w };
    }

    for (const p of this.propsNear(bx - 40, by - 40, bw + 80, bh + 80, this.propScratch)) {
      const def = PROPS[p.kind];
      const r = def.blocksSight ? def.radius : def.radius * 0.7;
      if (r <= 0) continue;
      if (opts.sightOnly && !def.blocksSight) continue;
      const t = rayCircle(ox, oy, dx, dy, p.x, p.y, r);
      if (t >= 0 && t <= maxDist && (!best || t < best.dist)) best = { dist: t, prop: p };
    }

    for (const s of this.structures) {
      if (s.kind === 'floor' || s.kind === 'foundation' || s.kind === 'doorway') continue;
      if (s.kind === 'door' && s.open) continue;
      const t = rayRect(ox, oy, dx, dy, s, maxDist);
      if (t >= 0 && (!best || t < best.dist)) best = { dist: t, structure: s };
    }

    return best;
  }

  /** Unobstructed sight line between two points? */
  hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return true;
    const hit = this.castRay(ax, ay, dx / dist, dy / dist, dist, { sightOnly: true });
    return !hit || hit.dist >= dist - 2;
  }

  // -------------------------------------------------------------------------
  // Props: harvesting and looting
  // -------------------------------------------------------------------------

  /** Roll a container's contents the first time it's opened. */
  ensureLoot(prop: Prop, day: number): Container | null {
    if (!prop.container) return null;
    if (!prop.lootRolled) {
      prop.lootRolled = true;
      const def = PROPS[prop.kind];
      if (def.container) {
        const table = def.container.table as LootTableName;
        const localRng = new RNG((this.data.seed ^ (prop.id * 2654435761)) >>> 0);
        for (const stack of rollLoot(table, localRng, day)) prop.container.add(stack);
      }
    }
    return prop.container;
  }

  killProp(prop: Prop): void {
    prop.dead = true;
    const def = PROPS[prop.kind];
    // Resource nodes regrow so the world doesn't strip-mine itself empty.
    prop.respawn = def.harvest ? 240 + this.rng.float(0, 240) : Infinity;
  }

  update(dt: number): void {
    for (const p of this.props) {
      if (!p.dead || p.respawn === Infinity) continue;
      p.respawn -= dt;
      if (p.respawn <= 0) {
        p.dead = false;
        const def = PROPS[p.kind];
        p.hp = def.harvest ? def.harvest.hp : (def.hp ?? 100);
      }
    }

    // Campfires and furnaces burn through their fuel.
    for (const d of this.deployables) {
      if (!d.lit) continue;
      d.fuel -= dt;
      if (d.fuel <= 0) { d.fuel = 0; d.lit = false; }
    }
    // Water catchers fill up over time.
    for (const d of this.deployables) {
      if (d.kind === 'water_catcher') d.charge = Math.min(1, d.charge + dt / 90);
    }
  }

  // -------------------------------------------------------------------------
  // Player construction
  // -------------------------------------------------------------------------

  addStructure(kind: StructureKind, x: number, y: number, w: number, h: number, tier = 0): Structure {
    const s: Structure = {
      id: this.nextStructureId++, kind, x, y, w, h, tier,
      hp: TIER_HP[tier], open: false,
    };
    this.structures.push(s);
    this.buildVersion++;
    return s;
  }

  removeStructure(s: Structure): void {
    const i = this.structures.indexOf(s);
    if (i >= 0) { this.structures.splice(i, 1); this.buildVersion++; }
  }

  structureAt(x: number, y: number, pad = 0): Structure | null {
    for (const s of this.structures) {
      if (x >= s.x - pad && x <= s.x + s.w + pad && y >= s.y - pad && y <= s.y + s.h + pad) return s;
    }
    return null;
  }

  addDeployable(itemId: string, kind: string, x: number, y: number): Deployable {
    const d: Deployable = {
      id: this.nextDeployableId++, kind, itemId, x, y,
      hp: 300, radius: DEPLOY_RADIUS[kind] ?? 20,
      fuel: 0, lit: false, armed: true, charge: 0,
    };
    const cap = DEPLOY_STORAGE[kind];
    if (cap) {
      d.container = new Container(`deploy_${d.id}`, cap[0], cap[1], cap[2]);
      d.container.locked = false;
    }
    this.deployables.push(d);
    this.buildVersion++;
    return d;
  }

  removeDeployable(d: Deployable): void {
    const i = this.deployables.indexOf(d);
    if (i >= 0) { this.deployables.splice(i, 1); this.buildVersion++; }
  }

  deployableNear(x: number, y: number, radius: number, kind?: string): Deployable | null {
    let best: Deployable | null = null;
    let bestD = radius;
    for (const d of this.deployables) {
      if (kind && d.kind !== kind) continue;
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  /** Which crafting stations are in range of a point. */
  stationsNear(x: number, y: number, radius = 190): Set<Station> {
    const out = new Set<Station>();
    for (const d of this.deployables) {
      if (Math.hypot(d.x - x, d.y - y) > radius) continue;
      if (d.kind === 'campfire' && d.lit) out.add('campfire');
      else if (d.kind === 'furnace' && d.lit) out.add('furnace');
      else if (d.kind === 'workbench_1') out.add('bench1');
      else if (d.kind === 'workbench_2') out.add('bench2');
      else if (d.kind === 'workbench_3') out.add('bench3');
    }
    return out;
  }

  /** Rect of every solid cell for the minimap and map screen. */
  discoverAround(x: number, y: number, radius = 420): void {
    for (const t of this.data.towns) {
      if (!t.discovered && Math.hypot(t.x - x, t.y - y) < t.radius + radius) t.discovered = true;
    }
    for (const b of this.data.buildings) {
      if (b.discovered) continue;
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      if (Math.hypot(bx - x, by - y) < radius) b.discovered = true;
    }
  }

  /** Reveal the whole map (reading a map item). */
  revealAll(): void {
    for (const t of this.data.towns) t.discovered = true;
  }

  // -------------------------------------------------------------------------
  // Save / load of mutable state only — terrain regenerates from the seed.
  // -------------------------------------------------------------------------

  serialize() {
    return {
      seed: this.data.seed,
      props: this.props
        .filter((p) => p.dead || p.lootRolled || p.hp !== (PROPS[p.kind].harvest?.hp ?? PROPS[p.kind].hp ?? 100))
        .map((p) => ({
          id: p.id, hp: p.hp, dead: p.dead, respawn: p.respawn === Infinity ? -1 : p.respawn,
          lootRolled: p.lootRolled,
          container: p.container ? p.container.serialize() : null,
        })),
      structures: this.structures.map((s) => ({ ...s })),
      deployables: this.deployables.map((d) => ({
        ...d, container: d.container ? d.container.serialize() : null,
      })),
      towns: this.data.towns.map((t) => t.discovered),
      buildings: this.data.buildings.map((b) => b.discovered),
    };
  }

  load(save: ReturnType<World['serialize']>): void {
    for (const ps of save.props) {
      const p = this.props[ps.id];
      if (!p) continue;
      p.hp = ps.hp;
      p.dead = ps.dead;
      p.respawn = ps.respawn < 0 ? Infinity : ps.respawn;
      p.lootRolled = ps.lootRolled;
      if (ps.container && p.container) p.container = Container.deserialize(ps.container);
    }
    this.structures = save.structures.map((s) => ({ ...s }));
    this.nextStructureId = this.structures.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    this.deployables = save.deployables.map((d) => {
      const { container, ...rest } = d;
      const dep = { ...rest } as Deployable;
      if (container) dep.container = Container.deserialize(container);
      return dep;
    });
    this.nextDeployableId = this.deployables.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    save.towns.forEach((v, i) => { if (this.data.towns[i]) this.data.towns[i].discovered = v; });
    save.buildings.forEach((v, i) => { if (this.data.buildings[i]) this.data.buildings[i].discovered = v; });
    this.buildVersion++;
  }
}

/** Collision radius per deployable kind. */
const DEPLOY_RADIUS: Record<string, number> = {
  campfire: 22, furnace: 26, workbench_1: 34, workbench_2: 34, workbench_3: 34,
  storage_box: 26, large_box: 32, tool_cupboard: 24, sleeping_bag: 0,
  water_catcher: 24, bear_trap: 0, spikes: 0, door_wood: 0, door_metal: 0,
};

/** `[cols, rows, label]` for deployables that hold items. */
const DEPLOY_STORAGE: Record<string, [number, number, string]> = {
  storage_box: [6, 3, 'Storage Box'],
  large_box: [6, 5, 'Large Box'],
  tool_cupboard: [4, 3, 'Tool Cupboard'],
  campfire: [4, 2, 'Campfire'],
  furnace: [4, 2, 'Furnace'],
};

export { DEPLOY_RADIUS, DEPLOY_STORAGE };

/** Rect helper used by the build placement preview. */
export function structureRect(kind: StructureKind, gx: number, gy: number): Rect {
  const CELL = TILE_SIZE * 3;
  switch (kind) {
    case 'foundation':
    case 'floor':
      return { x: gx * CELL, y: gy * CELL, w: CELL, h: CELL };
    default:
      return { x: gx * CELL, y: gy * CELL, w: CELL, h: 12 };
  }
}
