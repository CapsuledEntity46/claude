import * as THREE from 'three';
import { Block, isSolid } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, MeshState, chunkKey, voxelIndex } from './Chunk';
import { meshChunk } from './ChunkMesher';
import { TerrainGen } from './TerrainGen';

export interface RaycastHit {
  /** Integer coordinates of the block that was hit. */
  x: number;
  y: number;
  z: number;
  block: number;
  /** Face normal, pointing out of the hit block. */
  nx: number;
  ny: number;
  nz: number;
  distance: number;
  /** Exact world-space contact point. */
  point: THREE.Vector3;
}

export interface ChunkEditRecord {
  cx: number;
  cz: number;
  /** Flat [voxelIndex, blockId, ...] pairs, compact for JSON storage. */
  edits: number[];
}

const MAX_GEN_PER_FRAME = 2;
const MAX_MESH_PER_FRAME = 3;

/**
 * Owns voxel storage, chunk streaming, and geometry.
 *
 * Chunks are generated and meshed under a per-frame budget so that walking into
 * fresh terrain costs a little pop-in (hidden by fog) instead of a frame spike.
 */
export class World {
  readonly gen: TerrainGen;
  readonly group = new THREE.Group();

  private chunks = new Map<string, Chunk>();
  private opaqueMeshes = new Map<string, THREE.Mesh>();
  private transMeshes = new Map<string, THREE.Mesh>();

  private opaqueMat: THREE.MeshLambertMaterial;
  private transMat: THREE.MeshLambertMaterial;

  renderDistance: number;

  /** Chunks awaiting terrain generation, nearest-first. */
  private genQueue: string[] = [];

  constructor(seed: number, renderDistance = 6) {
    this.gen = new TerrainGen(seed);
    this.renderDistance = renderDistance;
    this.group.name = 'world';

    this.opaqueMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.transMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
    });
  }

  get seed(): number {
    return this.gen.seed;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  get pendingChunkCount(): number {
    return this.genQueue.length;
  }

  // ---------------------------------------------------------------- voxel access

  private chunkAt(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= CHUNK_SY) return Block.Air;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || chunk.state === MeshState.Empty) return Block.Air;
    return chunk.voxels[voxelIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)];
  }

  /**
   * Voxel lookup used by the mesher. Unloaded neighbours report as solid rock so
   * we do not emit a wall of faces at the loading frontier; those chunks are
   * re-meshed once the neighbour arrives.
   */
  private meshLookup = (wx: number, wy: number, wz: number): number => {
    if (wy < 0) return Block.Bedrock;
    if (wy >= CHUNK_SY) return Block.Air;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || chunk.state === MeshState.Empty) return Block.Bedrock;
    return chunk.voxels[voxelIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)];
  };

  isSolidAt(wx: number, wy: number, wz: number): boolean {
    return isSolid(this.getBlock(Math.floor(wx), Math.floor(wy), Math.floor(wz)));
  }

  /** True if the chunk containing this column has been generated. */
  isLoadedAt(wx: number, wz: number): boolean {
    const chunk = this.chunkAt(wx >> 4, wz >> 4);
    return !!chunk && chunk.state !== MeshState.Empty;
  }

  /**
   * Writes a block, records it as a player edit, and marks affected chunks dirty.
   * Returns false if the target chunk is not loaded.
   */
  setBlock(wx: number, wy: number, wz: number, id: number, record = true): boolean {
    if (wy < 1 || wy >= CHUNK_SY) return false;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunkAt(cx, cz);
    if (!chunk || chunk.state === MeshState.Empty) return false;

    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    const idx = voxelIndex(lx, wy, lz);
    if (chunk.voxels[idx] === id) return false;

    chunk.voxels[idx] = id;
    if (record) chunk.recordEdit(lx, wy, lz, id);
    chunk.state = MeshState.Dirty;
    chunk.recomputeHeightMap();

    // Border edits change the neighbour's culled faces too.
    // Border edits change a neighbour's culled faces and its corner AO, so the
    // diagonal neighbour needs refreshing too when the edit is on a corner.
    const onMinX = lx === 0;
    const onMaxX = lx === CHUNK_SX - 1;
    const onMinZ = lz === 0;
    const onMaxZ = lz === CHUNK_SZ - 1;
    if (onMinX) this.markDirty(cx - 1, cz);
    if (onMaxX) this.markDirty(cx + 1, cz);
    if (onMinZ) this.markDirty(cx, cz - 1);
    if (onMaxZ) this.markDirty(cx, cz + 1);
    if (onMinX && onMinZ) this.markDirty(cx - 1, cz - 1);
    if (onMinX && onMaxZ) this.markDirty(cx - 1, cz + 1);
    if (onMaxX && onMinZ) this.markDirty(cx + 1, cz - 1);
    if (onMaxX && onMaxZ) this.markDirty(cx + 1, cz + 1);
    return true;
  }

  private markDirty(cx: number, cz: number): void {
    const c = this.chunkAt(cx, cz);
    if (c && c.state === MeshState.Clean) c.state = MeshState.Dirty;
  }

  /** Topmost solid block y in a column, or -1 when the column is unloaded/empty. */
  highestSolidY(wx: number, wz: number): number {
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunkAt(cx, cz);
    if (!chunk || chunk.state === MeshState.Empty) return -1;
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    for (let y = chunk.heightAt(lx, lz); y >= 0; y--) {
      if (isSolid(chunk.voxels[voxelIndex(lx, y, lz)])) return y;
    }
    return -1;
  }

  // ---------------------------------------------------------------- streaming

  /** Immediately generates every chunk within `radius` of a point (used at spawn). */
  ensureLoadedAround(wx: number, wz: number, radius: number): void {
    const ccx = wx >> 4;
    const ccz = wz >> 4;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.ensureChunk(ccx + dx, ccz + dz);
      }
    }
  }

  private ensureChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      this.chunks.set(key, chunk);
    }
    if (chunk.state === MeshState.Empty) {
      this.gen.generate(chunk);
      chunk.state = MeshState.Dirty;
      // Neighbours were meshed while this chunk still read as solid rock, so they
      // need rebuilding. All eight matter, not just the four orthogonal ones:
      // the ambient occlusion term samples voxels diagonally around each vertex,
      // so a chunk's corner shading depends on its diagonal neighbour. Missing
      // those leaves permanent dark wedges at chunk corners.
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          this.markDirty(cx + dx, cz + dz);
        }
      }
    }
    return chunk;
  }

  /** Streams chunks around the player and rebuilds dirty geometry within budget. */
  update(playerX: number, playerZ: number): void {
    const ccx = Math.floor(playerX) >> 4;
    const ccz = Math.floor(playerZ) >> 4;
    const r = this.renderDistance;

    // Queue anything missing, nearest first.
    this.genQueue.length = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        const key = chunkKey(ccx + dx, ccz + dz);
        const existing = this.chunks.get(key);
        if (!existing || existing.state === MeshState.Empty) this.genQueue.push(key);
      }
    }
    this.genQueue.sort((a, b) => distSq(a, ccx, ccz) - distSq(b, ccx, ccz));

    for (let i = 0; i < Math.min(MAX_GEN_PER_FRAME, this.genQueue.length); i++) {
      const [cx, cz] = this.genQueue[i].split(',').map(Number);
      this.ensureChunk(cx, cz);
    }

    // Rebuild dirty meshes, nearest first. Chunks outside the render distance are
    // skipped: they are kept in memory only to preserve player edits, and meshing
    // them would fight the unload pass below for the frame's mesh budget forever.
    const dirty: Chunk[] = [];
    const meshLimit = (r + 1) * (r + 1);
    for (const chunk of this.chunks.values()) {
      if (chunk.state !== MeshState.Dirty) continue;
      if ((chunk.cx - ccx) ** 2 + (chunk.cz - ccz) ** 2 > meshLimit) continue;
      dirty.push(chunk);
    }
    dirty.sort(
      (a, b) =>
        (a.cx - ccx) ** 2 + (a.cz - ccz) ** 2 - ((b.cx - ccx) ** 2 + (b.cz - ccz) ** 2),
    );
    for (let i = 0; i < Math.min(MAX_MESH_PER_FRAME, dirty.length); i++) {
      this.buildMesh(dirty[i]);
    }

    // Unload beyond the render distance (with hysteresis so we don't thrash).
    const unloadR = r + 2;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - ccx;
      const dz = chunk.cz - ccz;
      if (dx * dx + dz * dz > unloadR * unloadR) this.unload(key);
    }
  }

  private buildMesh(chunk: Chunk): void {
    const key = chunkKey(chunk.cx, chunk.cz);
    const { opaque, translucent } = meshChunk(chunk, this.meshLookup);

    this.swapMesh(this.opaqueMeshes, key, opaque, this.opaqueMat, chunk, 0);
    this.swapMesh(this.transMeshes, key, translucent, this.transMat, chunk, 1);

    chunk.state = MeshState.Clean;
  }

  private swapMesh(
    store: Map<string, THREE.Mesh>,
    key: string,
    geometry: THREE.BufferGeometry | null,
    material: THREE.Material,
    chunk: Chunk,
    renderOrder: number,
  ): void {
    const existing = store.get(key);
    if (existing) {
      existing.geometry.dispose();
      this.group.remove(existing);
      store.delete(key);
    }
    if (!geometry) return;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.cx * CHUNK_SX, 0, chunk.cz * CHUNK_SZ);
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    store.set(key, mesh);
  }

  private unload(key: string): void {
    for (const store of [this.opaqueMeshes, this.transMeshes]) {
      const mesh = store.get(key);
      if (mesh) {
        mesh.geometry.dispose();
        this.group.remove(mesh);
        store.delete(key);
      }
    }
    // Keep edited chunks in memory so player builds survive a walk-away.
    const chunk = this.chunks.get(key);
    if (chunk && chunk.edits.size > 0) {
      chunk.state = MeshState.Dirty;
      return;
    }
    this.chunks.delete(key);
  }

  // ---------------------------------------------------------------- raycasting

  /**
   * Amanatides & Woo voxel traversal. Steps exactly through the grid, so it is
   * both exact and cheap — used for mining, block placement, and hitscan shots.
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    hittable: (id: number) => boolean = isSolid,
  ): RaycastHit | null {
    const dir = direction.clone().normalize();
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dir.x);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dir.y);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dir.z);

    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX;
    let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY;
    let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ;

    let nx = 0;
    let ny = 0;
    let nz = 0;
    let t = 0;

    // Check the starting voxel first.
    const startBlock = this.getBlock(x, y, z);
    if (hittable(startBlock)) {
      return { x, y, z, block: startBlock, nx: 0, ny: 1, nz: 0, distance: 0, point: origin.clone() };
    }

    while (t <= maxDistance) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
        nx = -stepX;
        ny = 0;
        nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
        nx = 0;
        ny = -stepY;
        nz = 0;
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        nx = 0;
        ny = 0;
        nz = -stepZ;
      }

      if (t > maxDistance) break;
      if (y < 0 || y >= CHUNK_SY) continue;

      const block = this.getBlock(x, y, z);
      if (hittable(block)) {
        return {
          x,
          y,
          z,
          block,
          nx,
          ny,
          nz,
          distance: t,
          point: origin.clone().addScaledVector(dir, t),
        };
      }
    }
    return null;
  }

  /** True when any solid voxel overlaps the given world-space box. */
  boxIntersectsSolid(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): boolean {
    const x0 = Math.floor(minX);
    const x1 = Math.floor(maxX);
    const y0 = Math.floor(minY);
    const y1 = Math.floor(maxY);
    const z0 = Math.floor(minZ);
    const z1 = Math.floor(maxZ);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (isSolid(this.getBlock(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- persistence

  /** Collects player edits for saving. Terrain itself is never stored. */
  collectEdits(): ChunkEditRecord[] {
    const out: ChunkEditRecord[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.edits.size === 0) continue;
      const flat: number[] = [];
      for (const [idx, id] of chunk.edits) flat.push(idx, id);
      out.push({ cx: chunk.cx, cz: chunk.cz, edits: flat });
    }
    return out;
  }

  /** Restores saved edits, discarding all current geometry so it rebuilds. */
  applyEdits(records: readonly ChunkEditRecord[]): void {
    this.clear();
    for (const rec of records) {
      const chunk = new Chunk(rec.cx, rec.cz);
      for (let i = 0; i < rec.edits.length; i += 2) {
        chunk.edits.set(rec.edits[i], rec.edits[i + 1]);
      }
      this.chunks.set(chunkKey(rec.cx, rec.cz), chunk);
    }
  }

  /** Marks every loaded chunk for rebuilding. Diagnostic aid. */
  remeshAll(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.state === MeshState.Clean) chunk.state = MeshState.Dirty;
    }
  }

  /** Rebuilds all dirty geometry immediately, ignoring the per-frame budget. */
  flushDirty(): number {
    let built = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.state === MeshState.Dirty) {
        this.buildMesh(chunk);
        built++;
      }
    }
    return built;
  }

  /** How many loaded chunks are still awaiting geometry. */
  get dirtyChunkCount(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) if (chunk.state === MeshState.Dirty) n++;
    return n;
  }

  clear(): void {
    for (const key of [...this.chunks.keys()]) {
      for (const store of [this.opaqueMeshes, this.transMeshes]) {
        const mesh = store.get(key);
        if (mesh) {
          mesh.geometry.dispose();
          this.group.remove(mesh);
          store.delete(key);
        }
      }
    }
    this.chunks.clear();
    this.genQueue.length = 0;
  }
}

function distSq(key: string, ccx: number, ccz: number): number {
  const comma = key.indexOf(',');
  const cx = Number(key.slice(0, comma));
  const cz = Number(key.slice(comma + 1));
  return (cx - ccx) ** 2 + (cz - ccz) ** 2;
}
