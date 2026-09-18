import { Block } from './blocks';
import type { DungeonCorridor, DungeonRoom, DungeonSite } from './Dungeon';
import { mulberry32 } from './noise';
import type { PropKind } from '../fx/props';

/**
 * Where a dungeon's furniture goes.
 *
 * Derived from a site's rooms and corridors plus the world seed, and from nothing
 * else — the same rule the layout itself follows. Chunks stream in an unpredictable
 * order, so anything that consulted a neighbour would furnish a room differently
 * depending on which direction the player approached from.
 *
 * This module is the single source of truth for two consumers that must agree:
 *
 *  - `fx/PropManager` draws the props.
 *  - `world/Dungeon` writes the voxels that give some of them collision and light.
 *
 * Props carry no collision of their own (physics only knows the voxel grid), so a
 * brazier is a decoration over a real Glowstone block and a column is a decoration
 * over a real brick column. If placement lived in the renderer, the two would drift
 * apart and you would get columns you walk through and braziers that light nothing.
 */

export interface DungeonProp {
  kind: PropKind;
  /** World position of the prop's origin: centre of its footprint, base at y. */
  x: number;
  y: number;
  z: number;
  /** Rotation about Y, in radians. */
  rotationY: number;
}

/** A voxel a prop needs underneath it, for collision or light. */
export interface PropVoxel {
  x: number;
  y: number;
  z: number;
  block: Block;
}

/** Rooms smaller than this get clutter but no columns — they would fill the floor. */
const COLUMN_MIN_SPAN = 9;
/** Columns need a base, a capital, and at least one shaft between them. */
const COLUMN_MIN_HEIGHT = 3;

/**
 * Every prop in a site.
 *
 * Positions are block coordinates plus a half-block offset, so a prop stands in the
 * middle of its tile rather than on the corner where four tiles meet.
 */
export function propsForSite(site: DungeonSite, seed: number): DungeonProp[] {
  // Memoised because the generator asks for this once per chunk it carves, and a
  // site spans dozens of chunks. The result is a pure function of the site and the
  // seed, so caching it cannot change what gets built.
  const key = `${site.gx},${site.gz},${seed}`;
  const cached = propCache.get(key);
  if (cached) return cached;

  const props: DungeonProp[] = [];
  for (const room of site.rooms) furnishRoom(props, room, seed);
  for (const corridor of site.corridors) furnishCorridor(props, corridor, seed);

  if (propCache.size > 64) propCache.clear();
  propCache.set(key, props);
  return props;
}

const propCache = new Map<string, DungeonProp[]>();

/**
 * Empties the memo.
 *
 * Exists for the tests. Determinism is the property most worth checking here, and a
 * cache keyed by site and seed answers the second call from the first — so a test
 * comparing two runs would pass by tautology however non-deterministic the placement
 * actually was.
 */
export function clearPropCache(): void {
  propCache.clear();
}

/**
 * The voxels a site's props need written into the world.
 *
 * Called by the generator after rooms are carved, so these overwrite the air a room
 * just opened up rather than being erased by it.
 */
export function dungeonPropVoxels(site: DungeonSite, seed: number): PropVoxel[] {
  const voxels: PropVoxel[] = [];

  for (const prop of propsForSite(site, seed)) {
    const bx = Math.floor(prop.x);
    const bz = Math.floor(prop.z);
    if (prop.kind === 'brazier') {
      // Glowstone: solid, so you cannot walk through the brazier, and emissive, so
      // the world's existing light-source scan picks it up with no further wiring.
      voxels.push({ x: bx, y: prop.y, z: bz, block: Block.Torchstone });
    } else if (prop.kind === 'columnBase' || prop.kind === 'columnShaft' || prop.kind === 'columnCapital') {
      voxels.push({ x: bx, y: prop.y, z: bz, block: Block.DungeonBrick });
    }
  }

  return voxels;
}

// ---------------------------------------------------------------- rooms

function furnishRoom(props: DungeonProp[], room: DungeonRoom, seed: number): void {
  // One generator per room, seeded from where the room is. Order-independent, and
  // re-furnishing the same room always gives the same result.
  const rand = mulberry32((room.x * 374761393) ^ (room.z * 668265263) ^ (seed * 2246822519) ^ (room.index * 40503));

  const floor = room.floorY;
  const ceiling = room.floorY + room.height;
  // Interior bounds, one in from the walls.
  const x0 = room.x;
  const x1 = room.x + room.width - 1;
  const z0 = room.z;
  const z1 = room.z + room.depth - 1;

  // Tiles already claimed, so a barrel never grows out of a brazier.
  const taken = new Set<string>();
  const claim = (x: number, z: number): boolean => {
    const key = `${x},${z}`;
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  };
  // The middle of the room is left clear so corridors can enter through it, and a
  // vault's plinth has room around it.
  //
  // Only three tiles across for an ordinary room, matching the corridor width. A
  // five-tile exclusion — which is what this started as — is the *entire* interior
  // of a 7×7 room, and 7 is the minimum room size, so the most common rooms in the
  // game came out completely unfurnished.
  const centreX = room.x + (room.width >> 1);
  const centreZ = room.z + (room.depth >> 1);
  const clear = room.vault ? 2 : 1;
  for (let dz = -clear; dz <= clear; dz++) {
    for (let dx = -clear; dx <= clear; dx++) claim(centreX + dx, centreZ + dz);
  }

  // --- columns ---------------------------------------------------------------
  //
  // Modular: a base, a stack of shafts, and a capital. A single fixed-height column
  // scaled to fit would drag its capital out of proportion with the shaft.
  if (room.width >= COLUMN_MIN_SPAN && room.depth >= COLUMN_MIN_SPAN && room.height >= COLUMN_MIN_HEIGHT) {
    const inset = 2;
    for (const cx of [x0 + inset, x1 - inset]) {
      for (const cz of [z0 + inset, z1 - inset]) {
        if (!claim(cx, cz)) continue;
        props.push({ kind: 'columnBase', x: cx + 0.5, y: floor, z: cz + 0.5, rotationY: 0 });
        for (let y = floor + 1; y <= ceiling - 2; y++) {
          props.push({ kind: 'columnShaft', x: cx + 0.5, y, z: cz + 0.5, rotationY: 0 });
        }
        props.push({ kind: 'columnCapital', x: cx + 0.5, y: ceiling - 1, z: cz + 0.5, rotationY: 0 });
      }
    }
  }

  // --- braziers --------------------------------------------------------------
  // In the corners, where they light the room without standing in the way. Every
  // room big enough to fight in gets at least one: a dungeon room with no light
  // source of its own is a black box, and the threshold used to exclude the
  // smallest rooms entirely.
  if (room.width * room.depth >= 40) {
    const corners: Array<[number, number]> = [
      [x0 + 1, z0 + 1],
      [x1 - 1, z0 + 1],
      [x0 + 1, z1 - 1],
      [x1 - 1, z1 - 1],
    ];
    const wanted = room.vault ? 4 : 1 + Math.floor(rand() * 2);
    // Counted locally. Counting braziers in the whole `props` array would let the
    // first few rooms use up the budget and leave every later room unlit.
    let placed = 0;
    const offset = Math.floor(rand() * 4);
    for (let i = 0; i < corners.length && placed < wanted; i++) {
      const [bx, bz] = corners[(i + offset) % corners.length];
      if (!claim(bx, bz)) continue;
      props.push({ kind: 'brazier', x: bx + 0.5, y: floor, z: bz + 0.5, rotationY: rand() * Math.PI * 2 });
      placed++;
    }
  }

  // --- vault furniture -------------------------------------------------------
  if (room.vault) {
    // Sarcophagi along the low-X wall, running with the room's depth.
    const sx = x0 + 1;
    for (const sz of [centreZ - 3, centreZ + 3]) {
      if (sz - 1 <= z0 || sz + 1 >= z1) continue;
      if (!claim(sx, sz) || !claim(sx, sz - 1) || !claim(sx, sz + 1)) continue;
      props.push({ kind: 'sarcophagus', x: sx + 0.5, y: floor, z: sz + 0.5, rotationY: 0 });
    }
  }

  // --- banners on the walls --------------------------------------------------
  // Hung flat against the long walls, facing into the room. Only where the room is
  // tall enough that the cloth is not lying on the floor.
  if (room.height >= 4) {
    for (let bx = x0 + 2; bx <= x1 - 2; bx += 4) {
      if (rand() > 0.45) continue;
      // Hung on the inner *face* of the wall, not at the centre of the tile next to
      // it. Tile z0 spans world z from z0 to z0+1 and the wall block is at z0-1, so
      // the face is the plane z = z0 and the cloth needs to sit a hair inside the
      // room from there. Placing it at the tile centre minus half a block — which is
      // what this did first — buries the banner inside the masonry.
      const north = rand() < 0.5;
      props.push({
        kind: 'banner',
        x: bx + 0.5,
        y: floor,
        z: north ? z0 + 0.06 : z1 + 0.94,
        rotationY: north ? 0 : Math.PI,
      });
    }
  }

  // --- floor clutter ---------------------------------------------------------
  const clutter = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < clutter; i++) {
    const cx = x0 + 1 + Math.floor(rand() * Math.max(1, room.width - 2));
    const cz = z0 + 1 + Math.floor(rand() * Math.max(1, room.depth - 2));
    if (!claim(cx, cz)) continue;
    const roll = rand();
    const kind: PropKind = roll < 0.45 ? 'rubble' : roll < 0.72 ? 'bones' : 'barrel';
    props.push({ kind, x: cx + 0.5, y: floor, z: cz + 0.5, rotationY: rand() * Math.PI * 2 });
  }
}

// ---------------------------------------------------------------- corridors

function furnishCorridor(props: DungeonProp[], corridor: DungeonCorridor, seed: number): void {
  const alongX = corridor.x0 !== corridor.x1;
  const rand = mulberry32((corridor.x0 * 2654435761) ^ (corridor.z0 * 340573321) ^ (seed * 1103515245));

  const from = alongX ? Math.min(corridor.x0, corridor.x1) : Math.min(corridor.z0, corridor.z1);
  const to = alongX ? Math.max(corridor.x0, corridor.x1) : Math.max(corridor.z0, corridor.z1);
  const fixed = alongX ? corridor.z0 : corridor.x0;

  // An arch a couple of blocks in from each end, so passing between rooms reads as
  // going through a doorway. The arch faces along the corridor, so a corridor
  // running in X needs it turned a quarter turn.
  const rotationY = alongX ? Math.PI / 2 : 0;
  // Short runs get no arches: two of them two blocks from each end would collide.
  if (to - from >= 8) {
    for (const along of [from + 2, to - 2]) {
      const x = alongX ? along : fixed;
      const z = alongX ? fixed : along;
      props.push({ kind: 'archway', x: x + 0.5, y: corridor.floorY, z: z + 0.5, rotationY });
    }
  }

  // The occasional pile of rubble partway along.
  const middle = Math.floor((from + to) / 2);
  if (rand() < 0.5) {
    const x = alongX ? middle : fixed;
    const z = alongX ? fixed : middle;
    props.push({ kind: 'rubble', x: x + 0.5, y: corridor.floorY, z: z + 0.5, rotationY: rand() * Math.PI * 2 });
  }
}
