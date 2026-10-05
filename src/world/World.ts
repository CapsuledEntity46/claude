import * as THREE from 'three';
import { Block, blockCollisionBoxes, blockDef, isLightSource, isSolid, isTargetable } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, MeshState, chunkKey, voxelIndex } from './Chunk';
import { meshChunk } from './ChunkMesher';
import { TerrainGen } from './TerrainGen';
import { atlasTileStats, loadAuthoredBlockTiles, tryCreateBlockAtlas } from './textures';
import { META_OPEN, metaIsOpen } from './shapes';

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

/**
 * Milliseconds of chunk work a single frame may spend.
 *
 * A count-based budget was the wrong shape. Generating a chunk costs ~3.4ms and
 * meshing one ~3.8ms, so "2 generate plus 3 mesh" authorised 18ms of work in a
 * frame that has 16.7ms in total — every frame that streamed a full batch
 * overran, which is exactly the occasional drop from 60 to the low 40s. The cost
 * per chunk also depends on the terrain in it, so no fixed count can be right
 * for both a flat plain and a mountainside.
 *
 * 8ms leaves roughly half the frame for rendering and simulation. Streaming is
 * no slower on average — the same work is done, spread over more frames instead
 * of bunched into one — and because the budget is time rather than a count, a
 * fast machine gets through more chunks per frame without any retuning.
 */
const CHUNK_BUDGET_MS = 8;

/**
 * The budget while the view is still mostly empty.
 *
 * Filling an empty world and keeping a full one up to date are different jobs
 * and want different answers. During the initial fill there is little to render
 * and nothing to stutter — the player is watching the world appear — so being
 * frugal there just makes them wait. Once the view is substantially built the
 * budget drops to `CHUNK_BUDGET_MS` and smoothness takes over.
 *
 * Holding the steady-state budget through the fill as well was measurably worse:
 * on a slow renderer one chunk already costs more than 8ms, so only the single
 * guaranteed chunk got through per frame and the world took about twelve seconds
 * to appear.
 */
const CHUNK_FILL_BUDGET_MS = 14;

/**
 * Fraction of the view still missing that counts as "still filling".
 *
 * Deliberately high. At 25% ordinary walking kept the queue over the line, so
 * the generous fill budget applied permanently and the worst frame spent 43ms on
 * chunks — the exact stutter this was meant to remove. Only a genuinely empty
 * view, meaning a fresh start, a load or a teleport, should qualify.
 */
const FILLING_THRESHOLD = 0.6;

/**
 * Hard caps, so a pathologically slow frame cannot queue unbounded work.
 * Reached only when chunks turn out to be much cheaper than expected.
 */
const MAX_GEN_PER_FRAME = 6;
const MAX_MESH_PER_FRAME = 8;

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
/**
   * Chunks waiting to be generated, nearest first.
   *
   * Entries carry their coordinates and their distance as numbers. They used to
   * be the map's string keys, which meant the sort comparator re-parsed two keys
   * on every comparison — `indexOf`, two slices and two `Number` calls, roughly
   * sixteen thousand string operations per frame for a queue this size. That
   * bookkeeping, not the chunk building, was the largest single cost in the
   * streaming frame.
   */
  private genQueue: { cx: number; cz: number; d: number }[] = [];
  /** The chunk the queue was built around, so it can be reused while stationary. */
  private queueCx = Number.NaN;
  private queueCz = Number.NaN;
  /** Set whenever the set of loaded chunks changes, forcing a queue rebuild. */
  private queueStale = true;

  /**
   * Positions of every loaded light-emitting block, keyed by coordinate.
   * Maintained incrementally on edits and on chunk load/unload so the dynamic
   * light pool never has to search the voxel grid.
   */
  private lights = new Map<string, { x: number; y: number; z: number }>();

  /** Resolves once the authored tile sheets have been fetched, applied or given up on. */
  private authoredTiles: Promise<number> = Promise.resolve(0);
  /** How many authored sheets made it into the atlas. 0 means the painted fallback. */
  private authoredTileCount = 0;

  constructor(seed: number, renderDistance = 6) {
    this.gen = new TerrainGen(seed);
    this.renderDistance = renderDistance;
    this.group.name = 'world';

    // The atlas multiplies the vertex colours the mesher already writes, so ambient
    // occlusion, per-face shading and the day/night tint all keep working. Blocks
    // with no texture of their own sample a white tile, which multiplies to exactly
    // what they drew before textures existed.
    //
    // Built lazily and tolerantly: the unit tests mesh real chunks in Node, where
    // there is no canvas to draw on. An untextured material there is fine, because
    // what those tests assert is geometry.
    const atlas = tryCreateBlockAtlas();

    this.opaqueMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: atlas });
    this.transMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: atlas,
      transparent: true,
      opacity: 0.72,
    });

    // Rock and sand have authored tiles baked from assets/blocks/*.glb, which get
    // composited over the painted ones when they arrive. Started and not awaited on
    // purpose: every tile they replace is already drawn, and UVs come from
    // `tileRect` rather than from the image, so chunks meshed in the meantime need
    // no remeshing — the next frame simply samples better pixels. A failed fetch
    // therefore costs the procedural look and nothing else.
    if (atlas) {
      this.authoredTiles = loadAuthoredBlockTiles(atlas).then((count) => {
        this.authoredTileCount = count;
        return count;
      });
    }
  }

  /** Per-tile brightness and contrast of the atlas. A flat tile has stdev near 0. */
  debugAtlasStats(): Record<string, unknown> {
    const map = this.opaqueMat.map;
    return map ? atlasTileStats(map) : {};
  }

  /**
   * Waits for the authored tile sheets to settle, and reports how many applied.
   *
   * Only the diagnostics need this. Nothing in the game waits on it — see the
   * constructor for why there is nothing to wait for.
   */
  debugAuthoredTiles(): Promise<number> {
    return this.authoredTiles;
  }

  /** Atlas and UV plumbing, for diagnosis. See Game.debugTerrainMaterial. */
  debugMaterialState(): Record<string, unknown> {
    const map = this.opaqueMat.map;
    let uvCount = 0;
    let uvMin = Infinity;
    let uvMax = -Infinity;
    let meshes = 0;
    for (const mesh of this.opaqueMeshes.values()) {
      const uv = mesh.geometry.getAttribute('uv');
      meshes++;
      if (!uv) continue;
      uvCount += uv.count;
      // Sampled rather than scanned in full: a chunk holds tens of thousands of
      // vertices and this only needs to show the range is not degenerate.
      for (let i = 0; i < uv.count; i += 97) {
        uvMin = Math.min(uvMin, uv.getX(i));
        uvMax = Math.max(uvMax, uv.getX(i));
      }
    }
    return {
      hasMap: !!map,
      atlasWidth: map?.image?.width ?? 0,
      authoredTiles: this.authoredTileCount,
      vertexColors: this.opaqueMat.vertexColors,
      meshes,
      uvCount,
      uMin: Number.isFinite(uvMin) ? Number(uvMin.toFixed(4)) : null,
      uMax: Number.isFinite(uvMax) ? Number(uvMax.toFixed(4)) : null,
    };
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

  /** Orientation and state byte for a voxel. */
  getMeta(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= CHUNK_SY) return 0;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || chunk.state === MeshState.Empty) return 0;
    return chunk.meta[voxelIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)];
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
  setBlock(wx: number, wy: number, wz: number, id: number, record = true, meta = 0): boolean {
    if (wy < 1 || wy >= CHUNK_SY) return false;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunkAt(cx, cz);
    if (!chunk || chunk.state === MeshState.Empty) return false;

    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    const idx = voxelIndex(lx, wy, lz);
    if (chunk.voxels[idx] === id && chunk.meta[idx] === meta) return false;

    const previous = chunk.voxels[idx];
    chunk.voxels[idx] = id;
    chunk.meta[idx] = meta;
    if (record) chunk.recordEdit(lx, wy, lz, id, meta);

    // Keep the light index in step with the world.
    if (isLightSource(previous) !== isLightSource(id)) {
      const lightKey = `${wx},${wy},${wz}`;
      if (isLightSource(id)) this.lights.set(lightKey, { x: wx, y: wy, z: wz });
      else this.lights.delete(lightKey);
    }
    chunk.state = MeshState.Dirty;
    // Only the edited column's height can have changed.
    chunk.recomputeColumn(lx, lz);

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

  /**
   * Toggles an interactive block's open bit, e.g. a door.
   * Returns false when the target is not something that opens.
   */
  toggleBlock(wx: number, wy: number, wz: number): boolean {
    const id = this.getBlock(wx, wy, wz);
    if (!blockDef(id).interactive) return false;
    const meta = this.getMeta(wx, wy, wz);
    const next = metaIsOpen(meta) ? meta & ~META_OPEN : meta | META_OPEN;
    // Force the write through: the id is unchanged, so pass the new meta.
    return this.setBlock(wx, wy, wz, id, true, next);
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
      this.indexLights(chunk);
      chunk.state = MeshState.Dirty;
      // This chunk has left the queue's "missing" set, so the queue must be
      // rebuilt before it is trusted again.
      this.queueStale = true;
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

  /**
   * Rolling cost of one generate and one mesh, in milliseconds.
   *
   * Measured rather than assumed, because it varies by an order of magnitude
   * between a flat plain and a mountainside, and between a phone and a desktop.
   * Seeded low so a cold start is willing to try.
   */
  private genCostMs = 1;
  private meshCostMs = 1;


  /**
   * Pessimistic cost estimates, used for the budget decision.
   *
   * An average is the wrong predictor here. Chunk cost varies several-fold with
   * the terrain in it, and a mesher cannot be interrupted once started — so
   * deciding with the mean means every unusually expensive chunk is begun late
   * in a frame and overruns it. These rise instantly to any cost actually seen
   * and decay slowly, so the budget plans for the bad case and relaxes only once
   * the bad case stops happening.
   *
   * Seeded at a realistic cost rather than optimistically. Starting them at 1ms
   * let the very first frames authorise six chunks each on the belief they were
   * nearly free, and the initial fill peaked at 63ms per frame before the
   * estimates caught up — a visible stutter exactly when the player is first
   * looking at the world. Starting pessimistically costs a little fill speed on
   * a fast machine for the first few frames and nothing afterwards.
   */
  private genCostHigh = 6;
  private meshCostHigh = 6;

  /** Chunks still waiting to be generated. */
  get pendingChunks(): number {
    return this.genQueue.length;
  }

  /** The pessimistic estimates the budget decides with. */
  get genCostPeak(): number {
    return this.genCostHigh;
  }

  get meshCostPeak(): number {
    return this.meshCostHigh;
  }

  /** The steady-state budget, so a test can assert against the real figure. */
  get budgetMs(): number {
    return CHUNK_BUDGET_MS;
  }

  get genCost(): number {
    return this.genCostMs;
  }

  get meshCost(): number {
    return this.meshCostMs;
  }

  /**
   * Worst frame's chunk time since the last reset, in milliseconds.
   *
   * Recorded so the budget can be asserted rather than trusted: the regression
   * this guards against — a frame quietly spending more than it has — is
   * invisible in an average and shows up to the player only as an occasional
   * stutter.
   */
  maxChunkFrameMs = 0;
  /**
   * The budget bound in force at the instant of the worst frame.
   *
   * Recorded alongside it because the cost estimates decay: comparing the
   * watermark against the estimates as they read at the *end* of a run compares
   * two numbers from different moments, and the bound can have shrunk well below
   * what was legitimately permitted when the frame happened.
   */
  maxChunkFrameBoundMs = 0;
  /**
   * The same, but only for frames spent on the larger initial-fill budget.
   *
   * Kept apart because the two phases are deliberately allowed different
   * amounts of time, and mixing them makes the figure meaningless: on a slow
   * machine the world is filling almost permanently, so a single watermark
   * reports the fill budget and says nothing about what exploring feels like.
   */
  maxFillFrameMs = 0;
  /** Chunk time spent in the most recent frame. */
  lastChunkFrameMs = 0;
  /** Whether the most recent frame ran on the fill budget. */
  lastFrameWasFilling = false;

  /** Streams chunks around the player and rebuilds dirty geometry within budget. */
  update(playerX: number, playerZ: number): void {
    const ccx = Math.floor(playerX) >> 4;
    const ccz = Math.floor(playerZ) >> 4;
    const r = this.renderDistance;

    // Rebuild the queue only when it could have changed: when the player crosses
    // into a new chunk, or when chunks were added or removed since the last
    // rebuild. Standing still used to re-probe all 361 cells and re-sort every
    // frame for an answer that could not have moved.
    if (this.queueStale || ccx !== this.queueCx || ccz !== this.queueCz) {
      this.genQueue.length = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = dx * dx + dz * dz;
          if (d > (r + 0.5) * (r + 0.5)) continue;
          const existing = this.chunks.get(chunkKey(ccx + dx, ccz + dz));
          if (!existing || existing.state === MeshState.Empty) {
            this.genQueue.push({ cx: ccx + dx, cz: ccz + dz, d });
          }
        }
      }
      // Sorting on a number computed once, rather than on a key parsed per
      // comparison.
      this.genQueue.sort((a, b) => a.d - b.d);
      this.queueCx = ccx;
      this.queueCz = ccz;
      this.queueStale = false;
    }

    const started = performance.now();
    const spent = (): number => performance.now() - started;

    // Chunks inside the view circle, which is what "filled" is measured against.
    const expected = Math.PI * r * r;
    const budget = this.genQueue.length > expected * FILLING_THRESHOLD ? CHUNK_FILL_BUDGET_MS : CHUNK_BUDGET_MS;
    // Each kind of work gets its own guaranteed first operation.
    //
    // Sharing one counter starved generation completely: meshing claimed the
    // frame's single guarantee, and because generating a chunk marks all eight
    // neighbours dirty there is almost always something to mesh — so the world
    // grew only on the rare frame with nothing dirty. Measured, that was about
    // 3 chunks a second where the budget should have allowed twenty.
    let meshed = 0;
    let generated = 0;

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
    // Meshing goes first, and generation gets what is left.
    //
    // A stale mesh is a hole in the world the player is already looking at; an
    // ungenerated chunk is only terrain they cannot see yet. Generating first
    // meant a frame could spend its whole allowance on chunks over the horizon
    // and leave the one underfoot unbuilt.
    for (let i = 0; i < Math.min(MAX_MESH_PER_FRAME, dirty.length); i++) {
      // Predictive, not reactive: stop before starting work that would overrun,
      // using what meshing actually cost recently. Checking the clock *after*
      // each chunk only discovers the overrun once the frame is already late.
      if (meshed > 0 && spent() + this.meshCostHigh > budget) break;
      const before = performance.now();
      this.buildMesh(dirty[i]);
      const meshTook = performance.now() - before;
      this.meshCostMs = this.meshCostMs * 0.8 + meshTook * 0.2;
      this.meshCostHigh = Math.max(meshTook, this.meshCostHigh * 0.93);
      meshed++;
    }

    for (let i = 0; i < Math.min(MAX_GEN_PER_FRAME, this.genQueue.length); i++) {
      if (generated > 0 && spent() + this.genCostHigh > budget) break;
      const entry = this.genQueue[i];
      const before = performance.now();
      this.ensureChunk(entry.cx, entry.cz);
      const genTook = performance.now() - before;
      this.genCostMs = this.genCostMs * 0.8 + genTook * 0.2;
      this.genCostHigh = Math.max(genTook, this.genCostHigh * 0.93);
      generated++;
    }
    if (generated > 0) {
      // Drop what was just built off the front instead of rebuilding.
      //
      // The queue is sorted nearest-first and consumed from the front, so the
      // remaining entries are still correct and still in order. `ensureChunk`
      // marks the queue stale because an outside caller can generate a chunk at
      // any time; here the loop knows exactly which chunks it changed, so it can
      // account for them and clear the flag. Without this every frame that
      // generated anything re-probed all 361 cells and re-sorted on the next
      // frame — a full rebuild for a change it already knew about.
      this.genQueue.splice(0, generated);
      this.queueStale = false;
    }

    this.lastChunkFrameMs = spent();
    this.lastFrameWasFilling = budget === CHUNK_FILL_BUDGET_MS;
    if (this.lastFrameWasFilling) {
      if (this.lastChunkFrameMs > this.maxFillFrameMs) this.maxFillFrameMs = this.lastChunkFrameMs;
    } else if (this.lastChunkFrameMs > this.maxChunkFrameMs) {
      this.maxChunkFrameMs = this.lastChunkFrameMs;
      // The scheduler's promise: the budget, plus the one mesh and one generate
      // that are always allowed through so the world cannot stall.
      this.maxChunkFrameBoundMs = CHUNK_BUDGET_MS + this.genCostHigh + this.meshCostHigh;
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
    this.queueStale = true;
    for (const store of [this.opaqueMeshes, this.transMeshes]) {
      const mesh = store.get(key);
      if (mesh) {
        mesh.geometry.dispose();
        this.group.remove(mesh);
        store.delete(key);
      }
    }
    const chunk = this.chunks.get(key);
    if (chunk) this.forgetLights(chunk);

    // Keep edited chunks in memory so player builds survive a walk-away.
    if (chunk && chunk.edits.size > 0) {
      chunk.state = MeshState.Dirty;
      return;
    }
    this.chunks.delete(key);
  }

  // ---------------------------------------------------------------- lighting

  /** Records every emissive block in a freshly generated chunk. */
  private indexLights(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SX;
    const baseZ = chunk.cz * CHUNK_SZ;
    for (let y = 0; y < CHUNK_SY; y++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) {
          const id = chunk.voxels[voxelIndex(x, y, z)];
          if (id === Block.Air || !isLightSource(id)) continue;
          const wx = baseX + x;
          const wz = baseZ + z;
          this.lights.set(`${wx},${y},${wz}`, { x: wx, y, z: wz });
        }
      }
    }
  }

  private forgetLights(chunk: Chunk): void {
    const minX = chunk.cx * CHUNK_SX;
    const minZ = chunk.cz * CHUNK_SZ;
    for (const [key, light] of this.lights) {
      if (light.x >= minX && light.x < minX + CHUNK_SX && light.z >= minZ && light.z < minZ + CHUNK_SZ) {
        this.lights.delete(key);
      }
    }
  }

  get lightSourceCount(): number {
    return this.lights.size;
  }

  /** The closest emissive blocks to a point, nearest first. */
  nearestLightSources(
    from: THREE.Vector3,
    maxDistance: number,
    limit: number,
  ): { x: number; y: number; z: number }[] {
    const maxSq = maxDistance * maxDistance;
    const found: { x: number; y: number; z: number; d: number }[] = [];
    for (const light of this.lights.values()) {
      const dx = light.x + 0.5 - from.x;
      const dy = light.y + 0.5 - from.y;
      const dz = light.z + 0.5 - from.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxSq) continue;
      found.push({ ...light, d });
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, limit).map(({ x, y, z }) => ({ x, y, z }));
  }

  // ---------------------------------------------------------------- water

  /**
   * Finds a point inside a body of water near a column, for spawning fish.
   * Returns null when the column has no water deep enough to swim in.
   */
  findWaterSpot(wx: number, wz: number, minDepth = 2): THREE.Vector3 | null {
    const cx = wx >> 4;
    const cz = wz >> 4;
    const chunk = this.chunkAt(cx, cz);
    if (!chunk || chunk.state === MeshState.Empty) return null;

    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;

    // Walk down from the column top to find the water surface.
    let top = -1;
    for (let y = CHUNK_SY - 1; y >= 1; y--) {
      if (chunk.voxels[voxelIndex(lx, y, lz)] === Block.Water) {
        top = y;
        break;
      }
    }
    if (top < 0) return null;

    let bottom = top;
    while (bottom > 1 && chunk.voxels[voxelIndex(lx, bottom - 1, lz)] === Block.Water) bottom--;
    if (top - bottom + 1 < minDepth) return null;

    // Sit a little below the surface so fish are submerged.
    const y = bottom + (top - bottom) * 0.5;
    return new THREE.Vector3(wx + 0.5, y + 0.5, wz + 0.5);
  }

  /** True when this point is inside water. */
  isWaterAt(x: number, y: number, z: number): boolean {
    return this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === Block.Water;
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
    hittable: (id: number) => boolean = isTargetable,
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

  /**
   * True when any solid block geometry overlaps the given world-space box.
   *
   * Tests the block's actual shape boxes rather than assuming a full cube, which
   * is what lets a slab be a half step, stairs be walkable, and an open door be a
   * hole you can pass through.
   */
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
          const id = this.getBlock(x, y, z);
          if (!isSolid(id)) continue;

          const def = blockDef(id);
          // Fast path: ordinary cubes fill their voxel, so the voxel overlap we
          // already established is the answer.
          if (def.shape === 'cube') return true;

          for (const shapeBox of blockCollisionBoxes(id, this.getMeta(x, y, z))) {
            if (
              maxX > x + shapeBox.min[0] &&
              minX < x + shapeBox.max[0] &&
              maxY > y + shapeBox.min[1] &&
              minY < y + shapeBox.max[1] &&
              maxZ > z + shapeBox.min[2] &&
              minZ < z + shapeBox.max[2]
            ) {
              return true;
            }
          }
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
      // Packed as (blockId | meta << 8) so the format stays two numbers per edit.
      for (const [idx, packed] of chunk.edits) flat.push(idx, packed);
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
    this.lights.clear();
  }
}
