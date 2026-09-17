import { Block } from './blocks';

/**
 * Chunks are vertical columns: 16x16 footprint, full world height.
 * A column keeps streaming logic 2D (only cx/cz matter) at the cost of meshing
 * a taller volume — a fine trade at this world height.
 */
export const CHUNK_SX = 16;
export const CHUNK_SY = 72;
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

  state: MeshState = MeshState.Empty;

  /** Highest non-air y per column, for cheap ground queries and spawn placement. */
  readonly heightMap: Uint8Array;

  /**
   * Player edits, as voxelIndex -> block id. Saves store only this map plus the
   * world seed, so terrain is regenerated rather than persisted.
   */
  edits = new Map<number, number>();

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.voxels = new Uint8Array(CHUNK_VOLUME);
    this.heightMap = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  }

  /** Local-coordinate get. Returns Air for out-of-range y. */
  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_SY) return Block.Air;
    return this.voxels[voxelIndex(x, y, z)];
  }

  /** Local-coordinate set. Does not mark the chunk dirty — callers do that. */
  set(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_SY) return;
    this.voxels[voxelIndex(x, y, z)] = id;
  }

  /** Records an edit so it survives save/load and terrain regeneration. */
  recordEdit(x: number, y: number, z: number, id: number): void {
    this.edits.set(voxelIndex(x, y, z), id);
  }

  /** Re-applies stored edits after terrain generation. */
  applyEdits(): void {
    for (const [idx, id] of this.edits) this.voxels[idx] = id;
  }

  recomputeHeightMap(): void {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        let h = 0;
        for (let y = CHUNK_SY - 1; y >= 0; y--) {
          if (this.voxels[voxelIndex(x, y, z)] !== Block.Air) {
            h = y;
            break;
          }
        }
        this.heightMap[z * CHUNK_SX + x] = h;
      }
    }
  }

  heightAt(x: number, z: number): number {
    return this.heightMap[z * CHUNK_SX + x];
  }
}
