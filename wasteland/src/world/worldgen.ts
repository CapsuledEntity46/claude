/**
 * World generation.
 *
 * Produces a fixed-size island region from a seed: terrain, a road network
 * linking settlements, laid-out towns full of enterable buildings, high-tier
 * military POIs, farmland, and scattered resource props.
 *
 * Everything here is pure data — the runtime `World` turns the descriptors into
 * live objects with containers and hit points.
 */

import { RNG, fbm, ridged } from '../core/rng';
import { clamp01, pointInRect, rectsOverlapPadded, type Rect } from '../core/math';
import { Biome, Tile, TILE_SIZE } from './tiles';
import { buildingSize, generateBuilding, type Building, type BuildingKind } from './buildings';
import type { PropKind } from './props';

export interface PropSeed {
  kind: PropKind;
  x: number;
  y: number;
  variant: number;
  /** Index into `buildings`, or -1 when outdoors. */
  buildingId: number;
}

export type TownKind = 'hamlet' | 'village' | 'town' | 'city' | 'military' | 'farm' | 'outpost';

export interface TownInfo {
  name: string;
  kind: TownKind;
  /** Centre in world units. */
  x: number;
  y: number;
  radius: number;
  buildingIds: number[];
  discovered: boolean;
  /** Danger rating shown on the map. */
  tier: number;
}

export interface WorldData {
  seed: number;
  tilesX: number;
  tilesY: number;
  /** Row-major terrain tile ids. */
  tiles: Uint8Array;
  /** Row-major biome ids. */
  biome: Uint8Array;
  buildings: Building[];
  towns: TownInfo[];
  props: PropSeed[];
  spawn: { x: number; y: number };
  /** Polylines for the minimap. */
  roads: { x: number; y: number }[][];
}

const TOWN_NAMES = [
  'Ashford', 'Blackmoor', 'Cinderhollow', 'Dunwich', 'Emberfall', 'Fallowfield',
  'Grimsby', 'Hollowbrook', 'Ironvale', 'Kestrel', 'Larkhill', 'Mourn',
  'Northgate', 'Oakhurst', 'Pitchford', 'Quarryhead', 'Ravenstead', 'Saltmarsh',
  'Thornwood', 'Undercliff', 'Varney', 'Westmill', 'Yarrow', 'Zloty',
  'Novy Sobor', 'Chernaya', 'Vybor', 'Gorka', 'Pustoshka', 'Kamensk',
];

const MILITARY_NAMES = ['Checkpoint Alpha', 'Camp Bravo', 'Outpost Delta', 'Firebase Echo', 'Depot Kilo'];

/** Town composition: `[buildingKind, weight]`. */
const TOWN_PALETTES: Record<TownKind, { count: [number, number]; radius: number; tier: number; palette: readonly (readonly [BuildingKind, number])[] }> = {
  hamlet: {
    count: [3, 5], radius: 400, tier: 0,
    palette: [['house_small', 50], ['shed', 22], ['farmhouse', 18], ['barn', 10]],
  },
  village: {
    count: [6, 10], radius: 640, tier: 1,
    palette: [['house_small', 38], ['house_large', 20], ['shed', 12], ['shop', 10], ['farmhouse', 10], ['barn', 6], ['church', 4]],
  },
  town: {
    count: [11, 16], radius: 950, tier: 2,
    palette: [['house_small', 24], ['house_large', 20], ['apartment', 12], ['shop', 10], ['hardware_store', 7], ['diner', 6], ['gas_station', 5], ['warehouse', 5], ['church', 4], ['clinic', 4], ['police', 3]],
  },
  city: {
    count: [17, 24], radius: 1300, tier: 3,
    palette: [['apartment', 26], ['house_large', 14], ['shop', 12], ['warehouse', 10], ['hardware_store', 8], ['diner', 7], ['clinic', 6], ['police', 5], ['gas_station', 5], ['church', 4], ['house_small', 3]],
  },
  military: {
    count: [4, 7], radius: 650, tier: 3,
    palette: [['barracks', 46], ['warehouse', 26], ['shed', 16], ['clinic', 12]],
  },
  farm: {
    count: [3, 5], radius: 480, tier: 0,
    palette: [['farmhouse', 34], ['barn', 34], ['shed', 32]],
  },
  outpost: {
    count: [2, 3], radius: 300, tier: 1,
    palette: [['gas_station', 40], ['shed', 34], ['diner', 26]],
  },
};

/** World is a square of this many tiles per side. */
export const WORLD_TILES = 400;
export const WORLD_UNITS = WORLD_TILES * TILE_SIZE;

export function generateWorld(seedInput: number | string): WorldData {
  const rng = new RNG(seedInput);
  const seed = Math.floor(rng.float(0, 2 ** 31));

  const tilesX = WORLD_TILES;
  const tilesY = WORLD_TILES;
  const tiles = new Uint8Array(tilesX * tilesY);
  const biome = new Uint8Array(tilesX * tilesY);
  /** Tiles unavailable for prop scattering (roads, buildings, plazas). */
  const blocked = new Uint8Array(tilesX * tilesY);

  const idx = (tx: number, ty: number) => ty * tilesX + tx;
  const inBounds = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < tilesX && ty < tilesY;

  // -------------------------------------------------------------------------
  // 1. Terrain
  // -------------------------------------------------------------------------
  const cx = tilesX / 2, cy = tilesY / 2;
  const heights = new Float32Array(tilesX * tilesY);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const nx = tx / 42, ny = ty / 42;
      let hgt = fbm(nx, ny, seed, 5);

      // Radial falloff turns the map into an island with a natural coastline.
      const dx = (tx - cx) / cx, dy = (ty - cy) / cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      hgt -= clamp01((d - 0.62) / 0.38) * 0.85;

      // Ridged noise adds a mountain spine.
      const ridge = ridged(nx * 0.6, ny * 0.6, seed + 991, 4);
      hgt += Math.max(0, ridge - 0.55) * 0.75;

      heights[idx(tx, ty)] = hgt;
      const moist = fbm(nx * 0.7 + 31, ny * 0.7 - 17, seed + 4242, 4);

      let t: Tile;
      let b: Biome;
      if (hgt < 0.28) { t = Tile.DeepWater; b = Biome.Ocean; }
      else if (hgt < 0.355) { t = Tile.Water; b = Biome.Ocean; }
      else if (hgt < 0.385) { t = Tile.Sand; b = Biome.Beach; }
      else if (hgt > 0.80) { t = Tile.Snow; b = Biome.Tundra; }
      else if (hgt > 0.70) { t = Tile.Rock; b = Biome.Mountain; }
      else if (moist < 0.36) { t = Tile.DryGrass; b = Biome.Badlands; }
      else if (moist > 0.60) { t = Tile.ForestFloor; b = Biome.Forest; }
      else { t = Tile.Grass; b = Biome.Plains; }

      tiles[idx(tx, ty)] = t;
      biome[idx(tx, ty)] = b;
      if (t === Tile.DeepWater || t === Tile.Water) blocked[idx(tx, ty)] = 1;
    }
  }

  // Rivers: follow a few ridged-noise channels downhill from the mountains.
  carveRivers(tiles, biome, blocked, heights, tilesX, tilesY, seed, rng);

  const isLand = (tx: number, ty: number) =>
    inBounds(tx, ty) && tiles[idx(tx, ty)] !== Tile.Water && tiles[idx(tx, ty)] !== Tile.DeepWater;

  /** Is a tile-space rect entirely on buildable land? */
  const areaClear = (tx: number, ty: number, tw: number, th: number): boolean => {
    for (let y = ty; y < ty + th; y++) {
      for (let x = tx; x < tx + tw; x++) {
        if (!isLand(x, y)) return false;
        const h = heights[idx(x, y)];
        if (h > 0.74) return false; // too steep/rocky
      }
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // 2. Settlement sites
  // -------------------------------------------------------------------------
  const towns: TownInfo[] = [];
  const nameBag = rng.shuffle([...TOWN_NAMES]);
  const milBag = rng.shuffle([...MILITARY_NAMES]);
  let nameI = 0, milI = 0;

  // Order matters: the biggest and most important settlements claim space first,
  // so the high-tier military POIs are never squeezed out by filler hamlets.
  const plan: { kind: TownKind; count: number }[] = [
    { kind: 'city', count: 1 },
    { kind: 'military', count: 2 },
    { kind: 'town', count: 3 },
    { kind: 'village', count: 4 },
    { kind: 'farm', count: 3 },
    { kind: 'outpost', count: 3 },
    { kind: 'hamlet', count: 5 },
  ];

  for (const entry of plan) {
    for (let i = 0; i < entry.count; i++) {
      const cfg = TOWN_PALETTES[entry.kind];
      const radTiles = Math.ceil(cfg.radius / TILE_SIZE);
      let placed = false;

      // Two passes: the first is picky about flat, open land; the second relaxes
      // the land fraction and spacing so late settlements still find a home.
      for (let pass = 0; pass < 2 && !placed; pass++) {
        const minLand = pass === 0 ? 0.88 : 0.74;
        const spacing = pass === 0 ? 420 : 120;

        for (let attempt = 0; attempt < 700 && !placed; attempt++) {
          const tx = rng.int(radTiles + 4, tilesX - radTiles - 4);
          const ty = rng.int(radTiles + 4, tilesY - radTiles - 4);

          let land = 0, total = 0;
          for (let y = ty - radTiles; y <= ty + radTiles; y += 3) {
            for (let x = tx - radTiles; x <= tx + radTiles; x += 3) {
              total++;
              if (isLand(x, y) && heights[idx(x, y)] < 0.72) land++;
            }
          }
          if (land / total < minLand) continue;

          const wx = tx * TILE_SIZE, wy = ty * TILE_SIZE;
          if (towns.some((t) => Math.hypot(t.x - wx, t.y - wy) < t.radius + cfg.radius + spacing)) continue;

          towns.push({
            name: entry.kind === 'military' ? (milBag[milI++ % milBag.length]) : (nameBag[nameI++ % nameBag.length]),
            kind: entry.kind, x: wx, y: wy, radius: cfg.radius,
            buildingIds: [], discovered: false, tier: cfg.tier,
          });
          placed = true;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Roads (minimum spanning tree over settlements)
  // -------------------------------------------------------------------------
  const roads: { x: number; y: number }[][] = [];
  if (towns.length > 1) {
    const edges: { a: number; b: number; d: number }[] = [];
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        edges.push({ a: i, b: j, d: Math.hypot(towns[i].x - towns[j].x, towns[i].y - towns[j].y) });
      }
    }
    edges.sort((p, q) => p.d - q.d);
    const parent = towns.map((_, i) => i);
    const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n])));
    let joined = 0;
    for (const e of edges) {
      if (joined >= towns.length - 1 && !rng.bool(0.06)) break;
      const ra = find(e.a), rb = find(e.b);
      if (ra === rb) continue;
      parent[ra] = rb;
      joined++;
      roads.push(paintRoad(tiles, blocked, tilesX, tilesY, towns[e.a], towns[e.b], rng, heights));
    }
  }

  // -------------------------------------------------------------------------
  // 4. Town layouts
  // -------------------------------------------------------------------------
  const buildings: Building[] = [];
  const propSeeds: PropSeed[] = [];

  for (const town of towns) {
    layoutTown(town, rng, {
      tiles, blocked, tilesX, tilesY, buildings, propSeeds, areaClear, idx,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Building interiors: floors and furniture
  // -------------------------------------------------------------------------
  for (const b of buildings) {
    // Paint floor tiles under the footprint.
    const tx0 = Math.floor(b.x / TILE_SIZE), ty0 = Math.floor(b.y / TILE_SIZE);
    const tx1 = Math.ceil((b.x + b.w) / TILE_SIZE), ty1 = Math.ceil((b.y + b.h) / TILE_SIZE);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        if (!inBounds(tx, ty)) continue;
        tiles[idx(tx, ty)] = b.floor;
        blocked[idx(tx, ty)] = 1;
      }
    }
    for (const spot of b.propSpots) {
      propSeeds.push({ kind: spot.kind, x: spot.x, y: spot.y, variant: rng.int(0, 255), buildingId: b.id });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Wilderness props
  // -------------------------------------------------------------------------
  scatterNature(tiles, biome, blocked, heights, tilesX, tilesY, propSeeds, rng, seed);

  // -------------------------------------------------------------------------
  // 7. Spawn point — a beach as far from the city as we can manage
  // -------------------------------------------------------------------------
  const spawn = pickSpawn(tiles, tilesX, tilesY, towns, rng);

  return { seed, tilesX, tilesY, tiles, biome, buildings, towns, props: propSeeds, spawn, roads };
}

// ===========================================================================
// Rivers
// ===========================================================================

function carveRivers(
  tiles: Uint8Array, biome: Uint8Array, blocked: Uint8Array, heights: Float32Array,
  tilesX: number, tilesY: number, seed: number, rng: RNG,
): void {
  const idx = (x: number, y: number) => y * tilesX + x;
  const riverCount = rng.int(2, 4);

  for (let r = 0; r < riverCount; r++) {
    // Start high up and walk downhill toward the sea.
    let best = { x: 0, y: 0, h: -1 };
    for (let attempt = 0; attempt < 220; attempt++) {
      const x = rng.int(30, tilesX - 30), y = rng.int(30, tilesY - 30);
      const h = heights[idx(x, y)];
      if (h > best.h) best = { x, y, h };
    }
    let { x, y } = best;
    const width = rng.float(1.4, 2.8);

    for (let step = 0; step < 700; step++) {
      const t = tiles[idx(x, y)];
      if (t === Tile.Water || t === Tile.DeepWater) break;

      // Stamp a disc of water.
      const w = Math.ceil(width);
      for (let dy = -w; dy <= w; dy++) {
        for (let dx = -w; dx <= w; dx++) {
          const px = x + dx, py = y + dy;
          if (px < 0 || py < 0 || px >= tilesX || py >= tilesY) continue;
          const d = Math.hypot(dx, dy);
          if (d <= width) {
            tiles[idx(px, py)] = Tile.Water;
            biome[idx(px, py)] = Biome.Ocean;
            blocked[idx(px, py)] = 1;
          } else if (d <= width + 1.1 && tiles[idx(px, py)] !== Tile.Water) {
            tiles[idx(px, py)] = Tile.Sand;
            blocked[idx(px, py)] = 1;
          }
        }
      }

      // Steepest descent with a wander term so rivers meander.
      let bestDir = { dx: 0, dy: 0, h: Infinity };
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const px = x + dx, py = y + dy;
          if (px < 1 || py < 1 || px >= tilesX - 1 || py >= tilesY - 1) continue;
          const h = heights[idx(px, py)] + fbm(px / 9, py / 9, seed + 77 + r * 13, 2) * 0.05;
          if (h < bestDir.h) bestDir = { dx, dy, h };
        }
      }
      if (bestDir.h === Infinity) break;
      x += bestDir.dx;
      y += bestDir.dy;
      if (x < 2 || y < 2 || x > tilesX - 3 || y > tilesY - 3) break;
    }
  }
}

// ===========================================================================
// Roads
// ===========================================================================

function paintRoad(
  tiles: Uint8Array, blocked: Uint8Array, tilesX: number, tilesY: number,
  a: TownInfo, b: TownInfo, rng: RNG, heights: Float32Array,
): { x: number; y: number }[] {
  const idx = (x: number, y: number) => y * tilesX + x;
  const polyline: { x: number; y: number }[] = [];

  // Quadratic bezier with a jittered control point keeps roads from being ruler-straight.
  const mx = (a.x + b.x) / 2 + rng.float(-1, 1) * 400;
  const my = (a.y + b.y) / 2 + rng.float(-1, 1) * 400;
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 24);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const it = 1 - t;
    const wx = it * it * a.x + 2 * it * t * mx + t * t * b.x;
    const wy = it * it * a.y + 2 * it * t * my + t * t * b.y;
    if (i % 6 === 0) polyline.push({ x: wx, y: wy });

    const tx = Math.round(wx / TILE_SIZE);
    const ty = Math.round(wy / TILE_SIZE);
    const halfWidth = 1;
    for (let dy = -halfWidth - 1; dy <= halfWidth + 1; dy++) {
      for (let dx = -halfWidth - 1; dx <= halfWidth + 1; dx++) {
        const px = tx + dx, py = ty + dy;
        if (px < 0 || py < 0 || px >= tilesX || py >= tilesY) continue;
        const cur = tiles[idx(px, py)];
        const dist = Math.hypot(dx, dy);
        // Bridge straight over water rather than trying to route around it.
        if (dist <= halfWidth) {
          tiles[idx(px, py)] = (dx === 0 && dy === 0 && py % 5 < 2) ? Tile.RoadLine : Tile.Road;
          blocked[idx(px, py)] = 1;
        } else if (dist <= halfWidth + 1 && cur !== Tile.Road && cur !== Tile.RoadLine) {
          if (cur !== Tile.Water && cur !== Tile.DeepWater) {
            tiles[idx(px, py)] = heights[idx(px, py)] > 0.7 ? Tile.Gravel : Tile.Dirt;
            blocked[idx(px, py)] = 1;
          }
        }
      }
    }
  }
  polyline.push({ x: b.x, y: b.y });
  return polyline;
}

// ===========================================================================
// Town layout
// ===========================================================================

interface LayoutCtx {
  tiles: Uint8Array;
  blocked: Uint8Array;
  tilesX: number;
  tilesY: number;
  buildings: Building[];
  propSeeds: PropSeed[];
  areaClear: (tx: number, ty: number, tw: number, th: number) => boolean;
  idx: (tx: number, ty: number) => number;
}

function layoutTown(town: TownInfo, rng: RNG, ctx: LayoutCtx): void {
  const cfg = TOWN_PALETTES[town.kind];
  const target = rng.int(cfg.count[0], cfg.count[1]);
  const { tiles, blocked, tilesX, tilesY, idx } = ctx;

  const R = town.radius;
  const streetTile = town.kind === 'military' ? Tile.Gravel : Tile.Road;

  // -------------------------------------------------------------------------
  // Buildings first. Placing them before the roads means a warehouse is never
  // rejected for straddling a street — the streets get routed around it instead.
  // -------------------------------------------------------------------------
  const placedRects: Rect[] = [];
  const GAP = 24;
  let placedCount = 0;

  for (let attempt = 0; attempt < target * 160 && placedCount < target; attempt++) {
    const kind = rng.weighted(cfg.palette, (p) => p[1])[0];
    const size = buildingSize(kind, rng);

    // Uniform point in the town disc, inset so the footprint stays inside it.
    const inset = R - Math.hypot(size.w, size.h) * 0.5;
    if (inset <= 0) continue;
    const a = rng.angle();
    const d = Math.sqrt(rng.float(0.01, 1)) * inset;

    // Snap to the tile grid so interiors line up with the terrain.
    const bx = Math.round((town.x + Math.cos(a) * d - size.w / 2) / TILE_SIZE) * TILE_SIZE;
    const by = Math.round((town.y + Math.sin(a) * d - size.h / 2) / TILE_SIZE) * TILE_SIZE;
    const rect: Rect = { x: bx, y: by, w: size.w, h: size.h };

    const tx = Math.floor(bx / TILE_SIZE), ty = Math.floor(by / TILE_SIZE);
    const tw = Math.ceil(size.w / TILE_SIZE), th = Math.ceil(size.h / TILE_SIZE);

    if (!ctx.areaClear(tx, ty, tw, th)) continue;
    if (placedRects.some((r) => rectsOverlapPadded(rect, r, GAP))) continue;

    const b = generateBuilding(ctx.buildings.length, kind, bx, by, size.w, size.h, rng);
    ctx.buildings.push(b);
    town.buildingIds.push(b.id);
    placedRects.push(rect);
    placedCount++;
  }

  // -------------------------------------------------------------------------
  // Streets: a jittered grid clipped to the town circle, skipping any tile that
  // a building already claims. Roads end up hugging the buildings' frontages.
  // -------------------------------------------------------------------------
  const roadW = town.kind === 'city' || town.kind === 'town' ? 3 : 2;
  const spacing = Math.max(280, Math.min(480, R * 0.42));

  const paintStreetBand = (horizontal: boolean, at: number) => {
    const thickness = roadW * TILE_SIZE;
    const x0 = horizontal ? town.x - R : at;
    const y0 = horizontal ? at : town.y - R;
    const w = horizontal ? R * 2 : thickness;
    const h = horizontal ? thickness : R * 2;

    const tx0 = Math.floor(x0 / TILE_SIZE), ty0 = Math.floor(y0 / TILE_SIZE);
    const tx1 = Math.ceil((x0 + w) / TILE_SIZE), ty1 = Math.ceil((y0 + h) / TILE_SIZE);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
        const wx = tx * TILE_SIZE, wy = ty * TILE_SIZE;
        // Clip to the circle so streets don't shoot off into the wilderness.
        if (Math.hypot(wx + TILE_SIZE / 2 - town.x, wy + TILE_SIZE / 2 - town.y) > R) continue;
        const cur = tiles[idx(tx, ty)];
        if (cur === Tile.Water || cur === Tile.DeepWater) continue;
        // Never pave over a building.
        const tileRect: Rect = { x: wx, y: wy, w: TILE_SIZE, h: TILE_SIZE };
        if (placedRects.some((r) => rectsOverlapPadded(tileRect, r, 2))) continue;
        tiles[idx(tx, ty)] = streetTile;
        blocked[idx(tx, ty)] = 1;
      }
    }
  };

  // Offset the grid per town so they don't all look identical.
  const jitterX = rng.float(-spacing / 3, spacing / 3);
  const jitterY = rng.float(-spacing / 3, spacing / 3);
  for (let gx = town.x - R + jitterX; gx <= town.x + R; gx += spacing) paintStreetBand(false, gx);
  for (let gy = town.y - R + jitterY; gy <= town.y + R; gy += spacing) paintStreetBand(true, gy);

  // --- exterior dressing ---
  decorateTown(town, rng, ctx, placedRects);

  // --- farmland for rural settlements ---
  if (town.kind === 'farm' || town.kind === 'village' || town.kind === 'hamlet') {
    addFarmland(town, rng, ctx, placedRects);
  }

  // --- military fortifications ---
  if (town.kind === 'military') {
    const n = rng.int(10, 18);
    for (let i = 0; i < n; i++) {
      const a = rng.angle();
      const d = rng.float(R * 0.6, R * 0.95);
      const px = town.x + Math.cos(a) * d, py = town.y + Math.sin(a) * d;
      const tx = Math.floor(px / TILE_SIZE), ty = Math.floor(py / TILE_SIZE);
      if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
      if (tiles[idx(tx, ty)] === Tile.Water || tiles[idx(tx, ty)] === Tile.DeepWater) continue;
      if (placedRects.some((r) => pointInRect(px, py, r))) continue;
      ctx.propSeeds.push({
        kind: rng.weighted(
          [['sandbag', 40], ['barbwire', 26], ['crate_military', 16], ['ammo_box', 10], ['car_wreck', 8]] as const,
          (p) => p[1],
        )[0] as PropKind,
        x: px, y: py, variant: rng.int(0, 255), buildingId: -1,
      });
    }
  }
}

function decorateTown(town: TownInfo, rng: RNG, ctx: LayoutCtx, buildingRects: Rect[]): void {
  const { tiles, tilesX, tilesY, idx } = ctx;
  const R = town.radius;
  const density = town.kind === 'city' ? 46 : town.kind === 'town' ? 34 : 18;

  for (let i = 0; i < density; i++) {
    const a = rng.angle();
    const d = Math.sqrt(rng.float(0, 1)) * R * 0.95;
    const px = town.x + Math.cos(a) * d;
    const py = town.y + Math.sin(a) * d;
    const tx = Math.floor(px / TILE_SIZE), ty = Math.floor(py / TILE_SIZE);
    if (tx < 1 || ty < 1 || tx >= tilesX - 1 || ty >= tilesY - 1) continue;

    const tile = tiles[idx(tx, ty)];
    if (tile === Tile.Water || tile === Tile.DeepWater) continue;
    // Building interiors are furnished by the building generator.
    if (buildingRects.some((r) => pointInRect(px, py, r))) continue;

    const onRoad = tile === Tile.Road || tile === Tile.RoadLine || tile === Tile.Gravel;
    const palette: readonly (readonly [PropKind, number])[] = onRoad
      ? [['car', 34], ['car_wreck', 24], ['streetlight', 18], ['dumpster', 10], ['trashbag', 8], ['sign', 6]]
      : [['trashbag', 20], ['dumpster', 12], ['fence_wood', 16], ['fence_chain', 12], ['bush', 14],
         ['tree_oak', 10], ['barrel', 10], ['crate_wood', 8], ['pallet', 6], ['tire', 6], ['well', 2]];

    ctx.propSeeds.push({
      kind: rng.weighted(palette, (p) => p[1])[0] as PropKind,
      x: px, y: py, variant: rng.int(0, 255), buildingId: -1,
    });
  }

  // A water tower marks the bigger settlements from a distance.
  if (town.kind === 'town' || town.kind === 'city') {
    const a = rng.angle();
    ctx.propSeeds.push({
      kind: 'water_tower',
      x: town.x + Math.cos(a) * R * 0.8,
      y: town.y + Math.sin(a) * R * 0.8,
      variant: 0, buildingId: -1,
    });
  }
}

function addFarmland(town: TownInfo, rng: RNG, ctx: LayoutCtx, buildingRects: Rect[]): void {
  const { tiles, blocked, tilesX, tilesY, idx } = ctx;
  const fields = rng.int(1, 3);

  for (let f = 0; f < fields; f++) {
    const a = rng.angle();
    const d = town.radius * rng.float(1.05, 1.5);
    const fx = Math.floor((town.x + Math.cos(a) * d) / TILE_SIZE);
    const fy = Math.floor((town.y + Math.sin(a) * d) / TILE_SIZE);
    const fw = rng.int(9, 16), fh = rng.int(8, 14);
    const crop: PropKind = rng.bool(0.6) ? 'corn_plant' : 'pumpkin_plant';

    for (let ty = fy; ty < fy + fh; ty++) {
      for (let tx = fx; tx < fx + fw; tx++) {
        if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
        const cur = tiles[idx(tx, ty)];
        if (cur === Tile.Water || cur === Tile.DeepWater || cur === Tile.Road || cur === Tile.RoadLine) continue;
        if (cur === Tile.Gravel) continue;
        const wx = tx * TILE_SIZE, wy = ty * TILE_SIZE;
        if (buildingRects.some((r) => rectsOverlapPadded({ x: wx, y: wy, w: TILE_SIZE, h: TILE_SIZE }, r, 12))) continue;
        tiles[idx(tx, ty)] = Tile.Farmland;
        blocked[idx(tx, ty)] = 1;
        if (rng.bool(0.45)) {
          ctx.propSeeds.push({
            kind: crop,
            x: tx * TILE_SIZE + rng.float(6, 26),
            y: ty * TILE_SIZE + rng.float(6, 26),
            variant: rng.int(0, 255), buildingId: -1,
          });
        }
      }
    }
  }
}

// ===========================================================================
// Wilderness scatter
// ===========================================================================

function scatterNature(
  tiles: Uint8Array, biome: Uint8Array, blocked: Uint8Array, heights: Float32Array,
  tilesX: number, tilesY: number, out: PropSeed[], rng: RNG, seed: number,
): void {
  const idx = (x: number, y: number) => y * tilesX + x;

  for (let ty = 1; ty < tilesY - 1; ty++) {
    for (let tx = 1; tx < tilesX - 1; tx++) {
      const i = idx(tx, ty);
      if (blocked[i]) continue;
      const tile = tiles[i] as Tile;
      if (tile === Tile.Water || tile === Tile.DeepWater) continue;

      const b = biome[i] as Biome;
      // Clumping noise so forests feel like forests, not confetti.
      const clump = fbm(tx / 11, ty / 11, seed + 555, 3);
      const h = heights[i];

      let chance = 0;
      let palette: readonly (readonly [PropKind, number])[] = [];

      switch (b) {
        case Biome.Forest:
          chance = 0.1 + clump * 0.4;
          palette = [['tree_pine', 40], ['tree_oak', 32], ['bush', 20], ['log', 7], ['stump', 5], ['rock_small', 6], ['hemp', 6], ['tree_dead', 4]];
          break;
        case Biome.Plains:
          chance = 0.03 + clump * 0.1;
          palette = [['tree_oak', 24], ['bush', 34], ['hemp', 14], ['rock_small', 14], ['stump', 6], ['haybale', 4], ['log', 4]];
          break;
        case Biome.Badlands:
          chance = 0.025 + clump * 0.07;
          palette = [['tree_dead', 26], ['rock_small', 30], ['rock_large', 12], ['bush', 14], ['ore_sulfur', 10], ['ore_metal', 8]];
          break;
        case Biome.Mountain:
          chance = 0.05 + clump * 0.12;
          palette = [['rock_small', 30], ['rock_large', 22], ['ore_metal', 18], ['ore_sulfur', 12], ['ore_hqm', 6], ['tree_pine', 12], ['tree_dead', 6]];
          break;
        case Biome.Tundra:
          chance = 0.03 + clump * 0.08;
          palette = [['tree_pine', 30], ['rock_small', 26], ['rock_large', 14], ['tree_dead', 16], ['ore_metal', 8], ['ore_hqm', 4]];
          break;
        case Biome.Beach:
          chance = 0.02;
          palette = [['reeds', 40], ['rock_small', 24], ['log', 18], ['bush', 12], ['tree_dead', 6]];
          break;
        default:
          continue;
      }

      // Ore is much more common on steep ground.
      if (h > 0.66) chance *= 1.25;

      if (!rng.bool(chance)) continue;
      out.push({
        kind: rng.weighted(palette, (p) => p[1])[0] as PropKind,
        x: tx * TILE_SIZE + rng.float(4, 28),
        y: ty * TILE_SIZE + rng.float(4, 28),
        variant: rng.int(0, 255),
        buildingId: -1,
      });
    }
  }

  // A handful of standalone loot POIs out in the wild.
  const poiCount = 34;
  for (let i = 0; i < poiCount; i++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const tx = rng.int(4, tilesX - 5), ty = rng.int(4, tilesY - 5);
      const j = idx(tx, ty);
      if (blocked[j]) continue;
      const tile = tiles[j] as Tile;
      if (tile === Tile.Water || tile === Tile.DeepWater) continue;
      const kinds: PropKind[] = ['crate_wood', 'barrel', 'car_wreck', 'crate_military', 'tombstone'];
      out.push({
        kind: rng.weighted(kinds, (k) => (k === 'crate_military' ? 1 : k === 'tombstone' ? 2 : 4))!,
        x: tx * TILE_SIZE + 16, y: ty * TILE_SIZE + 16,
        variant: rng.int(0, 255), buildingId: -1,
      });
      break;
    }
  }
}

// ===========================================================================
// Spawn selection
// ===========================================================================

function pickSpawn(
  tiles: Uint8Array, tilesX: number, tilesY: number, towns: TownInfo[], rng: RNG,
): { x: number; y: number } {
  const idx = (x: number, y: number) => y * tilesX + x;
  let best = { x: tilesX / 2 * TILE_SIZE, y: tilesY / 2 * TILE_SIZE, score: -Infinity };

  for (let attempt = 0; attempt < 3000; attempt++) {
    const tx = rng.int(6, tilesX - 7), ty = rng.int(6, tilesY - 7);
    if (tiles[idx(tx, ty)] !== Tile.Sand) continue;

    // Needs walkable land around it so you don't spawn on a one-tile spit.
    let land = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const t = tiles[idx(tx + dx, ty + dy)];
        if (t !== Tile.Water && t !== Tile.DeepWater) land++;
      }
    }
    if (land < 16) continue;

    const wx = tx * TILE_SIZE + 16, wy = ty * TILE_SIZE + 16;
    // Prefer being a decent hike from anything dangerous, but not hopelessly remote.
    let nearest = Infinity;
    for (const t of towns) nearest = Math.min(nearest, Math.hypot(t.x - wx, t.y - wy));
    const score = -Math.abs(nearest - 1500) + rng.float(0, 120);
    if (score > best.score) best = { x: wx, y: wy, score };
  }
  return { x: best.x, y: best.y };
}
