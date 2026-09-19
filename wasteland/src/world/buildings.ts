/**
 * Procedural building interiors.
 *
 * Each building is generated as: an outer shell with a doorway and windows, a
 * BSP-partitioned set of rooms joined by internal doorways, and a furniture pass
 * that fills rooms according to their role. Furniture doubles as the loot
 * containers, so "loot the houses in town" falls out of room generation.
 */

import { RNG } from '../core/rng';
import type { Rect } from '../core/math';
import type { PropKind } from './props';
import { Tile, TILE_SIZE } from './tiles';

export type RoomRole =
  | 'kitchen' | 'bedroom' | 'bathroom' | 'livingroom' | 'storage'
  | 'retail' | 'hardware' | 'office' | 'ward' | 'armory' | 'hall' | 'barn' | 'garage';

export type BuildingKind =
  | 'house_small' | 'house_large' | 'apartment' | 'farmhouse'
  | 'shop' | 'hardware_store' | 'diner' | 'gas_station'
  | 'warehouse' | 'barn' | 'church' | 'clinic' | 'police' | 'shed' | 'barracks';

export interface WallSeg extends Rect {
  /** Blocks movement. */
  solid: boolean;
  /** Blocks line of sight and bullets. Windows are solid but not opaque. */
  opaque: boolean;
  window: boolean;
}

export interface Room extends Rect {
  role: RoomRole;
}

export interface PropSpot {
  x: number;
  y: number;
  kind: PropKind;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  name: string;
  /** Footprint in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  walls: WallSeg[];
  rooms: Room[];
  /** Gaps in walls, used to paint floor through the threshold. */
  doorways: Rect[];
  floor: Tile;
  wallColor: string;
  roofColor: string;
  propSpots: PropSpot[];
  spawnSpots: { x: number; y: number }[];
  /** Has the player been inside? Controls minimap/map display. */
  discovered: boolean;
  /** Rough danger/reward level, 0..3. */
  tier: number;
}

interface KindConfig {
  /** Footprint in tiles. */
  tw: [number, number];
  th: [number, number];
  floor: Tile;
  wallColor: string;
  roofColor: string;
  /** Roles assigned to rooms, cycled/shuffled. */
  roles: RoomRole[];
  /** Target room size in tiles; larger means fewer, bigger rooms. */
  roomTiles: number;
  windows: boolean;
  doors: number;
  tier: number;
  label: string;
}

const CONFIG: Record<BuildingKind, KindConfig> = {
  house_small: { tw: [7, 9], th: [6, 7], floor: Tile.FloorWood, wallColor: '#7d6a55', roofColor: '#5c4636', roles: ['kitchen', 'bedroom', 'livingroom', 'bathroom'], roomTiles: 3.4, windows: true, doors: 1, tier: 0, label: 'House' },
  house_large: { tw: [10, 13], th: [8, 10], floor: Tile.FloorWood, wallColor: '#846f58', roofColor: '#543f31', roles: ['kitchen', 'bedroom', 'bedroom', 'livingroom', 'bathroom', 'storage'], roomTiles: 3.8, windows: true, doors: 2, tier: 0, label: 'House' },
  apartment: { tw: [13, 16], th: [10, 12], floor: Tile.FloorConcrete, wallColor: '#77777a', roofColor: '#4a4a4d', roles: ['kitchen', 'bedroom', 'bedroom', 'livingroom', 'bathroom', 'bathroom', 'storage', 'office'], roomTiles: 3.6, windows: true, doors: 2, tier: 1, label: 'Apartments' },
  farmhouse: { tw: [9, 11], th: [7, 9], floor: Tile.FloorWood, wallColor: '#8a7358', roofColor: '#5f4230', roles: ['kitchen', 'bedroom', 'livingroom', 'storage'], roomTiles: 4, windows: true, doors: 1, tier: 0, label: 'Farmhouse' },
  shop: { tw: [11, 14], th: [8, 10], floor: Tile.FloorTile, wallColor: '#8a8580', roofColor: '#4f4c48', roles: ['retail', 'retail', 'storage', 'office'], roomTiles: 5, windows: true, doors: 1, tier: 1, label: 'General Store' },
  hardware_store: { tw: [11, 14], th: [8, 10], floor: Tile.FloorConcrete, wallColor: '#7f7a72', roofColor: '#4a4741', roles: ['hardware', 'hardware', 'storage'], roomTiles: 5.5, windows: true, doors: 1, tier: 1, label: 'Hardware Store' },
  diner: { tw: [10, 12], th: [7, 9], floor: Tile.FloorTile, wallColor: '#8f8378', roofColor: '#57504a', roles: ['retail', 'kitchen', 'bathroom'], roomTiles: 4.5, windows: true, doors: 1, tier: 1, label: 'Diner' },
  gas_station: { tw: [9, 11], th: [6, 8], floor: Tile.FloorConcrete, wallColor: '#84807a', roofColor: '#4d4a46', roles: ['retail', 'storage', 'garage'], roomTiles: 4.5, windows: true, doors: 1, tier: 1, label: 'Fuel Station' },
  warehouse: { tw: [15, 19], th: [11, 14], floor: Tile.FloorConcrete, wallColor: '#6e7276', roofColor: '#41454a', roles: ['storage', 'storage', 'storage', 'office'], roomTiles: 7, windows: false, doors: 2, tier: 2, label: 'Warehouse' },
  barn: { tw: [13, 16], th: [9, 11], floor: Tile.Dirt, wallColor: '#8a4f3a', roofColor: '#5f3527', roles: ['barn', 'barn', 'storage'], roomTiles: 6.5, windows: false, doors: 2, tier: 1, label: 'Barn' },
  church: { tw: [10, 12], th: [14, 17], floor: Tile.FloorTile, wallColor: '#93908a', roofColor: '#4a4540', roles: ['hall', 'storage', 'office'], roomTiles: 8, windows: true, doors: 1, tier: 1, label: 'Chapel' },
  clinic: { tw: [12, 15], th: [9, 11], floor: Tile.FloorTile, wallColor: '#9a9a96', roofColor: '#53534f', roles: ['ward', 'ward', 'office', 'storage', 'bathroom'], roomTiles: 4.2, windows: true, doors: 1, tier: 2, label: 'Clinic' },
  police: { tw: [12, 14], th: [9, 11], floor: Tile.FloorConcrete, wallColor: '#6f7478', roofColor: '#3f4448', roles: ['armory', 'office', 'office', 'storage'], roomTiles: 4.4, windows: true, doors: 1, tier: 2, label: 'Police Station' },
  shed: { tw: [5, 6], th: [4, 5], floor: Tile.FloorWood, wallColor: '#7a6852', roofColor: '#4f3d2e', roles: ['storage'], roomTiles: 6, windows: false, doors: 1, tier: 0, label: 'Shed' },
  barracks: { tw: [14, 17], th: [10, 12], floor: Tile.FloorConcrete, wallColor: '#5f6659', roofColor: '#3a4036', roles: ['armory', 'armory', 'bedroom', 'storage', 'office'], roomTiles: 4.6, windows: true, doors: 2, tier: 3, label: 'Barracks' },
};

export const buildingSize = (kind: BuildingKind, rng: RNG): { w: number; h: number } => {
  const c = CONFIG[kind];
  return { w: rng.int(c.tw[0], c.tw[1]) * TILE_SIZE, h: rng.int(c.th[0], c.th[1]) * TILE_SIZE };
};

export const buildingConfig = (kind: BuildingKind): KindConfig => CONFIG[kind];

/** Furniture palettes per room role: `[propKind, weight]`, plus how many to place. */
const FURNITURE: Record<RoomRole, { count: [number, number]; palette: readonly (readonly [PropKind, number])[] }> = {
  kitchen: { count: [3, 5], palette: [['fridge', 20], ['stove', 18], ['counter', 22], ['sink', 18], ['table', 12], ['chair', 14], ['shelf', 8], ['trashbag', 8]] },
  bedroom: { count: [3, 4], palette: [['bed', 26], ['wardrobe', 24], ['desk', 14], ['shelf', 10], ['chair', 10], ['bookshelf', 8]] },
  bathroom: { count: [2, 3], palette: [['toilet', 30], ['sink', 24], ['bathtub', 22], ['medbox', 14], ['shelf', 8]] },
  livingroom: { count: [3, 5], palette: [['sofa', 26], ['table', 18], ['bookshelf', 16], ['desk', 12], ['chair', 16], ['shelf', 10], ['safe', 3]] },
  storage: { count: [3, 5], palette: [['crate_wood', 24], ['barrel', 22], ['shelf', 16], ['toolbox', 14], ['pallet', 12], ['locker', 8], ['crate_military', 4]] },
  retail: { count: [4, 6], palette: [['shelf', 34], ['counter', 18], ['crate_wood', 14], ['fridge', 10], ['trashbag', 8], ['safe', 4]] },
  hardware: { count: [4, 6], palette: [['shelf', 28], ['toolbox', 24], ['crate_wood', 18], ['barrel', 14], ['pallet', 10]] },
  office: { count: [3, 4], palette: [['desk', 28], ['chair', 20], ['bookshelf', 18], ['locker', 14], ['safe', 10], ['shelf', 10]] },
  ward: { count: [3, 5], palette: [['bed', 30], ['medbox', 26], ['sink', 12], ['shelf', 12], ['locker', 10]] },
  armory: { count: [3, 5], palette: [['locker', 26], ['ammo_box', 24], ['crate_military', 20], ['safe', 10], ['shelf', 10], ['toolbox', 8]] },
  hall: { count: [4, 7], palette: [['chair', 40], ['table', 16], ['bookshelf', 10], ['crate_wood', 8], ['safe', 4]] },
  barn: { count: [3, 5], palette: [['haybale', 32], ['crate_wood', 18], ['barrel', 14], ['toolbox', 12], ['pallet', 12], ['shelf', 8]] },
  garage: { count: [3, 4], palette: [['toolbox', 26], ['barrel', 22], ['tire', 20], ['shelf', 14], ['pallet', 12], ['crate_wood', 10]] },
};

const WALL_T = 10;

// ---------------------------------------------------------------------------
// Interval helpers for punching doorways and windows out of wall lines.
// ---------------------------------------------------------------------------

type Span = [number, number];

function subtractSpans(base: Span, holes: Span[]): Span[] {
  let out: Span[] = [base];
  for (const h of holes) {
    const next: Span[] = [];
    for (const s of out) {
      if (h[1] <= s[0] || h[0] >= s[1]) { next.push(s); continue; }
      if (h[0] > s[0]) next.push([s[0], h[0]]);
      if (h[1] < s[1]) next.push([h[1], s[1]]);
    }
    out = next;
  }
  return out.filter((s) => s[1] - s[0] > 0.5);
}

function intersectSpans(a: Span, b: Span): Span | null {
  const s = Math.max(a[0], b[0]);
  const e = Math.min(a[1], b[1]);
  return e - s > 0.5 ? [s, e] : null;
}

interface WallLine {
  horiz: boolean;
  /** The fixed axis coordinate (top edge for horizontal, left edge for vertical). */
  fixed: number;
  span: Span;
  doors: Span[];
  windows: Span[];
}

function emitLine(line: WallLine, out: WallSeg[]): void {
  const solidSpans = subtractSpans(line.span, line.doors);
  for (const s of solidSpans) {
    // Split each solid run into window and non-window pieces.
    const winParts: Span[] = [];
    for (const w of line.windows) {
      const i = intersectSpans(s, w);
      if (i) winParts.push(i);
    }
    const plain = subtractSpans(s, winParts);
    for (const p of plain) push(line, p, out, false);
    for (const p of winParts) push(line, p, out, true);
  }
}

function push(line: WallLine, span: Span, out: WallSeg[], window: boolean): void {
  const len = span[1] - span[0];
  if (len <= 0.5) return;
  out.push(
    line.horiz
      ? { x: span[0], y: line.fixed, w: len, h: WALL_T, solid: true, opaque: !window, window }
      : { x: line.fixed, y: span[0], w: WALL_T, h: len, solid: true, opaque: !window, window },
  );
}

// ---------------------------------------------------------------------------
// BSP room partitioning
// ---------------------------------------------------------------------------

interface Leaf extends Rect { }

function partition(area: Rect, targetSize: number, rng: RNG, depth = 0): Leaf[] {
  const minSide = targetSize * 0.62;
  const canSplitH = area.w > minSide * 2;
  const canSplitV = area.h > minSide * 2;
  const bigEnough = area.w > targetSize || area.h > targetSize;

  if (depth > 5 || !bigEnough || (!canSplitH && !canSplitV)) return [area];

  // Prefer splitting the longer axis so rooms stay roughly square.
  let splitVertical: boolean;
  if (canSplitH && canSplitV) splitVertical = area.w > area.h ? true : false;
  else splitVertical = canSplitH;

  if (splitVertical) {
    const min = area.x + minSide;
    const max = area.x + area.w - minSide;
    const cut = rng.float(min, max);
    return [
      ...partition({ x: area.x, y: area.y, w: cut - area.x, h: area.h }, targetSize, rng, depth + 1),
      ...partition({ x: cut, y: area.y, w: area.x + area.w - cut, h: area.h }, targetSize, rng, depth + 1),
    ];
  }
  const min = area.y + minSide;
  const max = area.y + area.h - minSide;
  const cut = rng.float(min, max);
  return [
    ...partition({ x: area.x, y: area.y, w: area.w, h: cut - area.y }, targetSize, rng, depth + 1),
    ...partition({ x: area.x, y: cut, w: area.w, h: area.y + area.h - cut }, targetSize, rng, depth + 1),
  ];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DOOR_W = 44;
const WINDOW_W = 46;

export function generateBuilding(
  id: number, kind: BuildingKind, x: number, y: number, w: number, h: number, rng: RNG,
): Building {
  const cfg = CONFIG[kind];
  const walls: WallSeg[] = [];
  const doorways: Rect[] = [];

  const right = x + w - WALL_T;
  const bottom = y + h - WALL_T;

  // --- outer shell as four lines ---
  const lines: WallLine[] = [
    { horiz: true, fixed: y, span: [x, x + w], doors: [], windows: [] },              // north
    { horiz: true, fixed: bottom, span: [x, x + w], doors: [], windows: [] },         // south
    { horiz: false, fixed: x, span: [y, y + h], doors: [], windows: [] },             // west
    { horiz: false, fixed: right, span: [y, y + h], doors: [], windows: [] },         // east
  ];

  // --- entrances ---
  const sides = rng.shuffle([0, 1, 2, 3]).slice(0, cfg.doors);
  for (const side of sides) {
    const line = lines[side];
    const lo = line.span[0] + 34;
    const hi = line.span[1] - 34 - DOOR_W;
    if (hi <= lo) continue;
    const at = rng.float(lo, hi);
    line.doors.push([at, at + DOOR_W]);
    doorways.push(
      line.horiz
        ? { x: at, y: line.fixed - 2, w: DOOR_W, h: WALL_T + 4 }
        : { x: line.fixed - 2, y: at, w: WALL_T + 4, h: DOOR_W },
    );
  }

  // --- windows along the outer shell ---
  if (cfg.windows) {
    for (const line of lines) {
      const length = line.span[1] - line.span[0];
      const n = Math.max(1, Math.floor(length / 150));
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.3)) continue;
        const slot = line.span[0] + 40 + (i + 0.5) * ((length - 80) / n) - WINDOW_W / 2;
        // Don't cut a window where a door already is.
        if (line.doors.some((d) => slot < d[1] + 12 && slot + WINDOW_W > d[0] - 12)) continue;
        line.windows.push([slot, slot + WINDOW_W]);
      }
    }
  }

  // --- interior rooms ---
  const interior: Rect = { x: x + WALL_T, y: y + WALL_T, w: w - WALL_T * 2, h: h - WALL_T * 2 };
  const leaves = partition(interior, cfg.roomTiles * TILE_SIZE, rng);

  // Internal partition walls: for every leaf, wall off its right and bottom edges
  // when they fall inside the interior, punching a doorway through each.
  const internalLines: WallLine[] = [];
  const EPS = 1.5;
  for (const leaf of leaves) {
    const rEdge = leaf.x + leaf.w;
    const bEdge = leaf.y + leaf.h;

    if (rEdge < interior.x + interior.w - EPS) {
      let line = internalLines.find((l) => !l.horiz && Math.abs(l.fixed - rEdge) < EPS);
      if (!line) {
        line = { horiz: false, fixed: rEdge, span: [leaf.y, bEdge], doors: [], windows: [] };
        internalLines.push(line);
      } else {
        line.span = [Math.min(line.span[0], leaf.y), Math.max(line.span[1], bEdge)];
      }
      const lo = leaf.y + 22, hi = bEdge - 22 - DOOR_W;
      if (hi > lo) {
        const at = rng.float(lo, hi);
        line.doors.push([at, at + DOOR_W]);
        doorways.push({ x: rEdge - 2, y: at, w: WALL_T + 4, h: DOOR_W });
      }
    }

    if (bEdge < interior.y + interior.h - EPS) {
      let line = internalLines.find((l) => l.horiz && Math.abs(l.fixed - bEdge) < EPS);
      if (!line) {
        line = { horiz: true, fixed: bEdge, span: [leaf.x, rEdge], doors: [], windows: [] };
        internalLines.push(line);
      } else {
        line.span = [Math.min(line.span[0], leaf.x), Math.max(line.span[1], rEdge)];
      }
      const lo = leaf.x + 22, hi = rEdge - 22 - DOOR_W;
      if (hi > lo) {
        const at = rng.float(lo, hi);
        line.doors.push([at, at + DOOR_W]);
        doorways.push({ x: at, y: bEdge - 2, w: DOOR_W, h: WALL_T + 4 });
      }
    }
  }

  for (const line of [...lines, ...internalLines]) emitLine(line, walls);

  // --- assign roles ---
  const rolePool = rng.shuffle([...cfg.roles]);
  const rooms: Room[] = leaves.map((leaf, i) => ({
    x: leaf.x, y: leaf.y, w: leaf.w, h: leaf.h,
    role: rolePool[i % rolePool.length],
  }));

  // --- furnish ---
  const propSpots: PropSpot[] = [];
  const spawnSpots: { x: number; y: number }[] = [];
  for (const room of rooms) {
    const fur = FURNITURE[room.role];
    const target = rng.int(fur.count[0], fur.count[1]);
    const placed: { x: number; y: number }[] = [];

    for (let attempt = 0; attempt < target * 6 && placed.length < target; attempt++) {
      const kindPick = rng.weighted(fur.palette, (p) => p[1])[0];
      // Hug the walls — furniture in the middle of a room looks wrong and blocks paths.
      const margin = 30;
      let px: number, py: number;
      if (room.w < margin * 2.5 || room.h < margin * 2.5) {
        px = room.x + room.w / 2;
        py = room.y + room.h / 2;
      } else if (rng.bool(0.78)) {
        const side = rng.int(0, 3);
        if (side === 0) { px = rng.float(room.x + margin, room.x + room.w - margin); py = room.y + margin; }
        else if (side === 1) { px = rng.float(room.x + margin, room.x + room.w - margin); py = room.y + room.h - margin; }
        else if (side === 2) { px = room.x + margin; py = rng.float(room.y + margin, room.y + room.h - margin); }
        else { px = room.x + room.w - margin; py = rng.float(room.y + margin, room.y + room.h - margin); }
      } else {
        px = rng.float(room.x + margin, room.x + room.w - margin);
        py = rng.float(room.y + margin, room.y + room.h - margin);
      }

      // Keep furniture clear of doorways and of each other.
      if (doorways.some((d) => px > d.x - 40 && px < d.x + d.w + 40 && py > d.y - 40 && py < d.y + d.h + 40)) continue;
      if (placed.some((p) => Math.hypot(p.x - px, p.y - py) < 58)) continue;

      placed.push({ x: px, y: py });
      propSpots.push({ x: px, y: py, kind: kindPick });
    }

    // Zombies lurking indoors.
    const zCount = rng.bool(0.45 + cfg.tier * 0.12) ? rng.int(1, 1 + cfg.tier) : 0;
    for (let i = 0; i < zCount; i++) {
      spawnSpots.push({
        x: rng.float(room.x + 26, room.x + room.w - 26),
        y: rng.float(room.y + 26, room.y + room.h - 26),
      });
    }
  }

  return {
    id, kind, name: cfg.label, x, y, w, h,
    walls, rooms, doorways,
    floor: cfg.floor,
    wallColor: cfg.wallColor,
    roofColor: cfg.roofColor,
    propSpots, spawnSpots,
    discovered: false,
    tier: cfg.tier,
  };
}

/** Which loot table a room role should use for generic containers. */
export const ROLE_TABLE: Record<RoomRole, string> = {
  kitchen: 'kitchen', bedroom: 'bedroom', bathroom: 'bathroom', livingroom: 'livingroom',
  storage: 'crate_wood', retail: 'shop', hardware: 'hardware', office: 'livingroom',
  ward: 'hospital', armory: 'military', hall: 'livingroom', barn: 'barn', garage: 'toolbox',
};
