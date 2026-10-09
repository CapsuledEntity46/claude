import { Block } from './blocks';

/**
 * Chunks are vertical columns: 16x16 footprint, full world height.
 * A column keeps streaming logic 2D (only cx/cz matter) at the cost of meshing
 * a taller volume — a fine trade at this world height.
 *
 * The ceiling was raised from 72 to 160 to make room for real terrain relief:
 * mountain ranges that tower, oceans deep enough to swim down into, and canyons
 * you can lose the horizon inside. None of that fits in 72 blocks with a
 * waterline at 27. The mesher pays for the extra height by skipping the empty
 * sky above each chunk's tallest voxel, which it previously scanned in full.
 *
 * 160 is also the practical ceiling for the height map, which is a Uint8Array.
 */
export const CHUNK_SX = 16;
export const CHUNK_SY = 160;
export const CHUNK_SZ = 16;
export const CHUNK_VOLUME = CHUNK_SX * CHUNK_SY * CHUNK_SZ;

/** Index into a chunk's flat voxel array. Layout is y-major for fast vertical scans. */
export function voxelIndex(x: number, y: number, z: number): number {
  return (y * CHUNK_SZ + z) * CHUNK_SX + x;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export const enum MeshState {
  /** Voxels not generated yet. */
  Empty,
  /** Voxels present, geometry missing or stale. */
  Dirty,
  /** Geometry matches voxels. */
  Clean,
}

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly voxels: Uint8Array;
  /**
   * Per-voxel orientation and state, parallel to `voxels`.
   * See shapes.ts for the bit layout. Zero for ordinary cubes.
   */
  readonly meta: Uint8Array;

  state: MeshState = MeshState.Empty;

  /** Highest non-air y per column, for cheap ground queries and spawn placement. */
  readonly heightMap: Uint8Array;

  /**
   * Player edits, as voxelIndex -> packed (blockId | meta << 8). Saves store only
   * this map plus the world seed, so terrain is regenerated rather than persisted.
   */
  edits = new Map<number, number>();

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.voxels = new Uint8Array(CHUNK_VOLUME);
    this.meta = new Uint8Array(CHUNK_VOLUME);
    this.heightMap = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  }

  /** Local-coordinate get. Returns Air for out-of-range y. */
  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_SY) return Block.Air;
    return this.voxels[voxelIndex(x, y, z)];
  }

  getMeta(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_SY) return 0;
    return this.meta[voxelIndex(x, y, z)];
  }

  /** Local-coordinate set. Does not mark the chunk dirty — callers do that. */
  set(x: number, y: number, z: number, id: number, meta = 0): void {
    if (y < 0 || y >= CHUNK_SY) return;
    const i = voxelIndex(x, y, z);
    this.voxels[i] = id;
    this.meta[i] = meta;
  }

  /** Records an edit so it survives save/load and terrain regeneration. */
  recordEdit(x: number, y: number, z: number, id: number, meta = 0): void {
    this.edits.set(voxelIndex(x, y, z), (id & 0xff) | ((meta & 0xff) << 8));
  }

  /** Re-applies stored edits after terrain generation. */
  applyEdits(): void {
    for (const [idx, packed] of this.edits) {
      this.voxels[idx] = packed & 0xff;
      this.meta[idx] = (packed >> 8) & 0xff;
    }
  }

  /** Full rebuild. Only needed after generating or bulk-loading a chunk. */
  recomputeHeightMap(): void {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) this.recomputeColumn(x, z);
    }
  }

  /**
   * Rebuilds one column's height entry.
   *
   * Single block edits must use this rather than recomputeHeightMap: the full
   * rebuild scans all 18k voxels in the chunk, so calling it per edit made
   * placing a block ~256x more expensive than it needed to be, and turned an
   * explosion clearing several hundred blocks into a visible frame stall.
   */
  recomputeColumn(x: number, z: number): void {
    let h = 0;
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      if (this.voxels[voxelIndex(x, y, z)] !== Block.Air) {
        h = y;
        break;
      }
    }
    this.heightMap[z * CHUNK_SX + x] = h;
  }

  heightAt(x: number, z: number): number {
    return this.heightMap[z * CHUNK_SX + x];
  }
}
