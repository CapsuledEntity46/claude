import { Block } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, type Chunk, voxelIndex } from './Chunk';
import { hash2i, mulberry32 } from './noise';
import { facingFromYaw, makeMeta } from './shapes';

/**
 * Procedural dungeons, carved underground.
 *
 * Generated per "site" on a coarse grid rather than per chunk: a site's layout is
 * derived entirely from its grid coordinates and the world seed, so any chunk can
 * ask which rooms and corridors overlap it and carve exactly its own slice. That
 * keeps generation deterministic and chunk-order independent, which matters
 * because chunks stream in unpredictably — a dungeon that depended on its
 * neighbours already existing would come out different every time.
 */

/** Sites sit on a grid this many blocks apart. */
const SITE_SPACING = 176;
/** Fraction of grid cells that actually hold a dungeon. */
const SITE_CHANCE = 0.62;

const ROOM_MIN = 7;
const ROOM_MAX = 14;
const ROOM_HEIGHT_MIN = 4;
const ROOM_HEIGHT_MAX = 7;
const CORRIDOR_WIDTH = 3;
const CORRIDOR_HEIGHT = 4;
/**
 * Lowest floor a room may sit on.
 *
 * A room carves the layer *below* its floor as well, so a floor at y=0 would try
 * to write at y=-1 — outside the world. That write is silently dropped, leaving
 * the room open to the void underneath.
 */
const MIN_FLOOR_Y = 5;

export interface DungeonRoom {
  x: number;
  z: number;
  width: number;
  depth: number;
  floorY: number;
  height: number;
  /** Rooms flagged as vaults get better loot and a tougher guard. */
  vault: boolean;
  /** Index of the room in its site, used to vary decoration. */
  index: number;
}

export interface DungeonCorridor {
  /** Axis-aligned run from (x0,z0) to (x1,z1); exactly one axis varies. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  floorY: number;
}

export interface DungeonSite {
  /** Grid coordinates of the site. */
  gx: number;
  gz: number;
  /** Centre of the entrance shaft, in world blocks. */
  entranceX: number;
  entranceZ: number;
  /** Floor level of the top layer of rooms. */
  topY: number;
  rooms: DungeonRoom[];
  corridors: DungeonCorridor[];
  /** Bounding box in world blocks, for quick chunk rejection. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Spawn markers a dungeon asks the entity manager to populate. */
export interface DungeonSpawn {
  x: number;
  y: number;
  z: number;
  /** Vault guards are levelled up relative to the player. */
  elite: boolean;
}

export class DungeonGenerator {
  private readonly seed: number;
  private cache = new Map<string, DungeonSite | null>();

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  /** The site occupying a grid cell, or null if that cell is empty. */
  siteAt(gx: number, gz: number): DungeonSite | null {
    const key = `${gx},${gz}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const site = this.buildSite(gx, gz);
    if (this.cache.size > 512) this.cache.clear();
    this.cache.set(key, site);
    return site;
  }

  /** Every site whose bounding box could touch a chunk. */
  sitesNear(minX: number, minZ: number, maxX: number, maxZ: number): DungeonSite[] {
    const g0x = Math.floor(minX / SITE_SPACING) - 1;
    const g1x = Math.floor(maxX / SITE_SPACING) + 1;
    const g0z = Math.floor(minZ / SITE_SPACING) - 1;
    const g1z = Math.floor(maxZ / SITE_SPACING) + 1;

    const out: DungeonSite[] = [];
    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const site = this.siteAt(gx, gz);
        if (!site) continue;
        if (site.maxX < minX || site.minX > maxX || site.maxZ < minZ || site.minZ > maxZ) continue;
        out.push(site);
      }
    }
    return out;
  }

  /** The nearest dungeon entrance to a point, for the compass and logs. */
  nearestEntrance(x: number, z: number, searchRadius = SITE_SPACING * 2): { x: number; z: number; distance: number } | null {
    const sites = this.sitesNear(x - searchRadius, z - searchRadius, x + searchRadius, z + searchRadius);
    let best: { x: number; z: number; distance: number } | null = null;
    for (const site of sites) {
      const d = Math.hypot(site.entranceX - x, site.entranceZ - z);
      if (!best || d < best.distance) best = { x: site.entranceX, z: site.entranceZ, distance: d };
    }
    return best;
  }

  // ---------------------------------------------------------------- layout

  private buildSite(gx: number, gz: number): DungeonSite | null {
    if (hash2i(gx, gz, this.seed ^ 0xd0e0) > SITE_CHANCE) return null;

    // One RNG per site, seeded from its coordinates: the layout is a pure
    // function of where it is, so it never depends on generation order.
    const rand = mulberry32((gx * 73856093) ^ (gz * 19349663) ^ (this.seed * 83492791));

    const originX = gx * SITE_SPACING + Math.floor(rand() * 40) - 20;
    const originZ = gz * SITE_SPACING + Math.floor(rand() * 40) - 20;
    const topY = 16 + Math.floor(rand() * 8);

    const rooms: DungeonRoom[] = [];
    const corridors: DungeonCorridor[] = [];

    const roomCount = 5 + Math.floor(rand() * 5);
    // Rooms are laid out by walking a corridor from room to room, which produces
    // a connected plan without needing a graph search afterwards.
    let cursorX = originX;
    let cursorZ = originZ;
    let floorY = topY;

    for (let i = 0; i < roomCount; i++) {
      const width = ROOM_MIN + Math.floor(rand() * (ROOM_MAX - ROOM_MIN));
      const depth = ROOM_MIN + Math.floor(rand() * (ROOM_MAX - ROOM_MIN));
      const height = ROOM_HEIGHT_MIN + Math.floor(rand() * (ROOM_HEIGHT_MAX - ROOM_HEIGHT_MIN));
      // The last room is always the vault, so every dungeon has a payoff.
      const vault = i === roomCount - 1;

      rooms.push({
        x: cursorX - (width >> 1),
        z: cursorZ - (depth >> 1),
        width,
        depth,
        floorY,
        height,
        vault,
        index: i,
      });

      if (i === roomCount - 1) break;

      // Walk to the next room, occasionally dropping a level.
      const horizontal = rand() < 0.5;
      const distance = 12 + Math.floor(rand() * 16);
      const sign = rand() < 0.5 ? -1 : 1;
      const nextX = horizontal ? cursorX + distance * sign : cursorX;
      const nextZ = horizontal ? cursorZ : cursorZ + distance * sign;

      corridors.push({ x0: cursorX, z0: cursorZ, x1: nextX, z1: nextZ, floorY });

      cursorX = nextX;
      cursorZ = nextZ;
      // Descend a level sometimes, but never so far that the floor leaves the world.
      if (rand() < 0.35 && floorY - ROOM_HEIGHT_MAX >= MIN_FLOOR_Y) floorY -= ROOM_HEIGHT_MAX;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const room of rooms) {
      minX = Math.min(minX, room.x - 2);
      maxX = Math.max(maxX, room.x + room.width + 2);
      minZ = Math.min(minZ, room.z - 2);
      maxZ = Math.max(maxZ, room.z + room.depth + 2);
    }
    for (const c of corridors) {
      minX = Math.min(minX, Math.min(c.x0, c.x1) - CORRIDOR_WIDTH);
      maxX = Math.max(maxX, Math.max(c.x0, c.x1) + CORRIDOR_WIDTH);
      minZ = Math.min(minZ, Math.min(c.z0, c.z1) - CORRIDOR_WIDTH);
      maxZ = Math.max(maxZ, Math.max(c.z0, c.z1) + CORRIDOR_WIDTH);
    }

    return {
      gx,
      gz,
      entranceX: originX,
      entranceZ: originZ,
      topY,
      rooms,
      corridors,
      minX,
      maxX,
      minZ,
      maxZ,
    };
  }

  // ---------------------------------------------------------------- carving

  /**
   * Carves whatever parts of nearby dungeons fall inside this chunk.
   * Called after terrain generation and before player edits are re-applied.
   */
  carve(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SX;
    const baseZ = chunk.cz * CHUNK_SZ;
    const sites = this.sitesNear(baseX - 1, baseZ - 1, baseX + CHUNK_SX + 1, baseZ + CHUNK_SZ + 1);
    if (sites.length === 0) return;

    for (const site of sites) {
      for (const corridor of site.corridors) this.carveCorridor(chunk, baseX, baseZ, corridor);
      for (const room of site.rooms) this.carveRoom(chunk, baseX, baseZ, room, site);
      this.carveEntrance(chunk, baseX, baseZ, site);
    }
  }

  private setLocal(chunk: Chunk, lx: number, y: number, lz: number, id: Block, meta = 0): void {
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
    if (y < 1 || y >= CHUNK_SY) return;
    const i = voxelIndex(lx, y, lz);
    chunk.voxels[i] = id;
    chunk.meta[i] = meta;
  }

  /** Picks a wall material, so masonry looks aged rather than uniform. */
  private wallBlock(wx: number, y: number, wz: number): Block {
    const roll = hash2i(wx * 3 + y, wz * 7 - y, this.seed ^ 0xbb11);
    if (roll < 0.12) return Block.MossyBrick;
    if (roll < 0.24) return Block.CrackedBrick;
    return Block.DungeonBrick;
  }

  private carveRoom(chunk: Chunk, baseX: number, baseZ: number, room: DungeonRoom, site: DungeonSite): void {
    const x0 = room.x - 1;
    const x1 = room.x + room.width;
    const z0 = room.z - 1;
    const z1 = room.z + room.depth;
    const floor = room.floorY;
    const ceiling = room.floorY + room.height;

    for (let wz = z0; wz <= z1; wz++) {
      const lz = wz - baseZ;
      if (lz < -1 || lz > CHUNK_SZ) continue;
      for (let wx = x0; wx <= x1; wx++) {
        const lx = wx - baseX;
        if (lx < -1 || lx > CHUNK_SX) continue;

        const onBorder = wx === x0 || wx === x1 || wz === z0 || wz === z1;

        // Shell: floor, ceiling, walls.
        this.setLocal(chunk, lx, floor - 1, lz, this.wallBlock(wx, floor - 1, wz));
        this.setLocal(chunk, lx, ceiling, lz, this.wallBlock(wx, ceiling, wz));

        for (let y = floor; y < ceiling; y++) {
          if (onBorder) this.setLocal(chunk, lx, y, lz, this.wallBlock(wx, y, wz));
          else this.setLocal(chunk, lx, y, lz, Block.Air);
        }
      }
    }

    this.decorateRoom(chunk, baseX, baseZ, room, site);
  }

  /** Torches, rubble, and vault furnishing. */
  private decorateRoom(chunk: Chunk, baseX: number, baseZ: number, room: DungeonRoom, site: DungeonSite): void {
    const floor = room.floorY;

    // Wall torches at intervals, which is what makes a dungeon readable at all
    // given how dark the nights now are.
    for (let wx = room.x + 1; wx < room.x + room.width - 1; wx += 4) {
      for (const wz of [room.z, room.z + room.depth - 1]) {
        if (hash2i(wx, wz, this.seed ^ 0x7c) > 0.72) continue;
        this.setLocal(chunk, wx - baseX, floor + 2, wz - baseZ, Block.Torch);
      }
    }
    for (let wz = room.z + 1; wz < room.z + room.depth - 1; wz += 4) {
      for (const wx of [room.x, room.x + room.width - 1]) {
        if (hash2i(wx, wz, this.seed ^ 0x9e) > 0.72) continue;
        this.setLocal(chunk, wx - baseX, floor + 2, wz - baseZ, Block.Torch);
      }
    }

    // Scattered rubble.
    for (let wz = room.z; wz < room.z + room.depth; wz++) {
      for (let wx = room.x; wx < room.x + room.width; wx++) {
        if (hash2i(wx * 5, wz * 11, this.seed ^ 0x3311) < 0.05) {
          this.setLocal(chunk, wx - baseX, floor, wz - baseZ, Block.Rubble);
        }
      }
    }

    if (!room.vault) return;

    // The vault: a raised plinth of glowstone under a canopy, unmistakable.
    const cx = room.x + (room.width >> 1);
    const cz = room.z + (room.depth >> 1);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.setLocal(chunk, cx + dx - baseX, floor, cz + dz - baseZ, Block.DungeonBrick);
      }
    }
    this.setLocal(chunk, cx - baseX, floor + 1, cz - baseZ, Block.Torchstone);
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) {
      for (let y = floor; y < floor + room.height; y++) {
        this.setLocal(chunk, cx + dx - baseX, y, cz + dz - baseZ, Block.DungeonBrick);
      }
    }
    void site;
  }

  private carveCorridor(chunk: Chunk, baseX: number, baseZ: number, corridor: DungeonCorridor): void {
    const half = CORRIDOR_WIDTH >> 1;
    const alongX = corridor.x0 !== corridor.x1;
    const from = alongX ? Math.min(corridor.x0, corridor.x1) : Math.min(corridor.z0, corridor.z1);
    const to = alongX ? Math.max(corridor.x0, corridor.x1) : Math.max(corridor.z0, corridor.z1);
    const fixed = alongX ? corridor.z0 : corridor.x0;
    const floor = corridor.floorY;
    const ceiling = floor + CORRIDOR_HEIGHT;

    for (let along = from - 1; along <= to + 1; along++) {
      for (let across = -half - 1; across <= half + 1; across++) {
        const wx = alongX ? along : fixed + across;
        const wz = alongX ? fixed + across : along;
        const lx = wx - baseX;
        const lz = wz - baseZ;
        if (lx < -1 || lx > CHUNK_SX || lz < -1 || lz > CHUNK_SZ) continue;

        const isWall = Math.abs(across) > half;
        this.setLocal(chunk, lx, floor - 1, lz, this.wallBlock(wx, floor - 1, wz));
        this.setLocal(chunk, lx, ceiling, lz, this.wallBlock(wx, ceiling, wz));
        for (let y = floor; y < ceiling; y++) {
          if (isWall) this.setLocal(chunk, lx, y, lz, this.wallBlock(wx, y, wz));
          else this.setLocal(chunk, lx, y, lz, Block.Air);
        }

        // An occasional corridor torch so the way back is findable.
        if (!isWall && Math.abs(across) === half - 1 && along % 7 === 0) {
          this.setLocal(chunk, lx, floor + 2, lz, Block.Torch);
        }
      }
    }
  }

  /**
   * A stair shaft from the surface down to the top room.
   *
   * Without a visible way in, a dungeon is something you only ever find by
   * accident while mining, which wastes the whole feature.
   */
  private carveEntrance(chunk: Chunk, baseX: number, baseZ: number, site: DungeonSite): void {
    const cx = site.entranceX;
    const cz = site.entranceZ;
    const lx = cx - baseX;
    const lz = cz - baseZ;
    // The shaft is 4x4 including walls, so reject early if it cannot touch us.
    if (lx < -3 || lx > CHUNK_SX + 3 || lz < -3 || lz > CHUNK_SZ + 3) return;

    const topOfShaft = Math.min(CHUNK_SY - 4, site.topY + 34);

    for (let y = site.topY; y <= topOfShaft; y++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const wallRing = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          const target = wallRing ? this.wallBlock(cx + dx, y, cz + dz) : Block.Air;
          this.setLocal(chunk, lx + dx, y, lz + dz, target);
        }
      }

      // A spiral of steps hugging the shaft wall.
      const step = (y - site.topY) % 4;
      const [sx, sz] = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ][step] as [number, number];
      this.setLocal(chunk, lx + sx, y, lz + sz, Block.StoneStairs, makeMeta(facingFromYaw(step * (Math.PI / 2))));

      if (y % 6 === 0) this.setLocal(chunk, lx, y + 2, lz, Block.Torch);
    }
  }

  // ---------------------------------------------------------------- spawns

  /**
   * Where enemies should stand in a site's rooms.
   * The entity manager decides whether to actually use these.
   */
  spawnPointsNear(x: number, z: number, radius: number): DungeonSpawn[] {
    const out: DungeonSpawn[] = [];
    for (const site of this.sitesNear(x - radius, z - radius, x + radius, z + radius)) {
      for (const room of site.rooms) {
        const rand = mulberry32((room.x * 6151) ^ (room.z * 3571) ^ this.seed);
        const count = room.vault ? 3 : 1 + Math.floor(rand() * 3);
        for (let i = 0; i < count; i++) {
          const px = room.x + 1 + Math.floor(rand() * Math.max(1, room.width - 2));
          const pz = room.z + 1 + Math.floor(rand() * Math.max(1, room.depth - 2));
          if (Math.hypot(px - x, pz - z) > radius) continue;
          out.push({ x: px + 0.5, y: room.floorY + 0.05, z: pz + 0.5, elite: room.vault });
        }
      }
    }
    return out;
  }

  /** True when a point is inside a dungeon room or corridor. */
  isInsideDungeon(x: number, y: number, z: number): boolean {
    for (const site of this.sitesNear(x - 2, z - 2, x + 2, z + 2)) {
      for (const room of site.rooms) {
        if (
          x >= room.x &&
          x < room.x + room.width &&
          z >= room.z &&
          z < room.z + room.depth &&
          y >= room.floorY &&
          y < room.floorY + room.height
        ) {
          return true;
        }
      }
    }
    return false;
  }
}

export { SITE_SPACING };
