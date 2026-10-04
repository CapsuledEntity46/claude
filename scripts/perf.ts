/**
 * Where chunk time actually goes.
 *
 * Measures generation and meshing separately, because they are paid at different
 * moments and only one of them is worth optimising for frame spikes. Guessing at
 * this is how you end up turning the fog down to fix a CPU stall.
 *
 * Run with: npm run perf
 */
import { TerrainGen } from '../src/world/TerrainGen';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk } from '../src/world/Chunk';
import { meshChunk } from '../src/world/ChunkMesher';
import { Block } from '../src/world/blocks';

const SAMPLES = 120;

function time(label: string, runs: number, fn: (i: number) => void): number {
  // One warm-up pass, so JIT compilation is not counted as chunk cost.
  fn(-1);
  const start = performance.now();
  for (let i = 0; i < runs; i++) fn(i);
  const total = performance.now() - start;
  const per = total / runs;
  console.log(`  ${label.padEnd(34)} ${per.toFixed(2)} ms/chunk   (${total.toFixed(0)} ms for ${runs})`);
  return per;
}

console.log(`\nchunk cost — ${CHUNK_SX}x${CHUNK_SY}x${CHUNK_SZ} = ${CHUNK_SX * CHUNK_SY * CHUNK_SZ} voxels\n`);

const gen = new TerrainGen(20260917);

// Fresh generator per run would re-pay the noise constructor, but a shared one
// means the column cache makes later chunks artificially cheap. Spread the
// chunks far apart so each one is genuinely cold.
const genPer = time('generate (cold columns)', SAMPLES, (i) => {
  const chunk = new Chunk(i * 37, i * 53);
  gen.generate(chunk);
});

// Each sample is the centre of a real 3x3 neighbourhood, so border faces are
// culled against actual terrain.
//
// The first version of this harness returned Air for every out-of-chunk lookup,
// which made all four side walls of the chunk — about 9,600 voxels — emit faces
// that the running game culls. It inflated the measurement by roughly 3x and
// would have sent me optimising a cost that does not exist in play.
const neighbourhoods: { centre: Chunk; lookup: (wx: number, wy: number, wz: number) => number }[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const cx = i * 37 + 5000;
  const cz = i * 53 - 5000;
  const grid = new Map<string, Chunk>();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = new Chunk(cx + dx, cz + dz);
      gen.generate(c);
      grid.set(`${cx + dx},${cz + dz}`, c);
    }
  }
  const lookup = (wx: number, wy: number, wz: number): number => {
    if (wy < 0 || wy >= CHUNK_SY) return Block.Air;
    const gx = wx >> 4;
    const gz = wz >> 4;
    const c = grid.get(`${gx},${gz}`);
    if (!c) return Block.Air;
    return c.get(wx - gx * CHUNK_SX, wy, wz - gz * CHUNK_SZ);
  };
  neighbourhoods.push({ centre: grid.get(`${cx},${cz}`)!, lookup });
}
const meshPer = time('mesh (real neighbours)', SAMPLES, (i) => {
  const n = neighbourhoods[Math.max(0, i) % neighbourhoods.length];
  meshChunk(n.centre, n.lookup);
});

// The height-only path, which the tree pass and spawn queries hit hard.
const surfacePer = time('surfaceHeight x256 (one chunk)', SAMPLES, (i) => {
  const bx = i * 97 + 20000;
  const bz = i * 89 - 20000;
  for (let z = 0; z < CHUNK_SZ; z++) {
    for (let x = 0; x < CHUNK_SX; x++) gen.surfaceHeight(bx + x, bz + z);
  }
});

console.log(`\ntotal per chunk: ${(genPer + meshPer).toFixed(2)} ms`);
console.log(`of which columns: ${surfacePer.toFixed(2)} ms (${((surfacePer / genPer) * 100).toFixed(0)}% of generation)`);

// What a frame costs, which is what the player feels.
//
// Streaming is time-sliced (CHUNK_BUDGET_MS in World.ts), so a frame stops after
// its allowance rather than after a fixed number of chunks. The figure that
// matters is therefore how much of a frame one chunk eats, not how many chunks
// fit in a frame.
const BUDGET_MS = 6;
const frameShare = ((genPer + meshPer) / 16.7) * 100;
console.log(`\none chunk is ${frameShare.toFixed(0)}% of a 60fps frame (16.7 ms)`);
console.log(`the ${BUDGET_MS} ms budget admits about ${(BUDGET_MS / (genPer + meshPer)).toFixed(1)} chunks per frame`);
console.log(`worst case a frame spends ${BUDGET_MS} ms + one chunk overrun, leaving ~${(16.7 - BUDGET_MS - (genPer + meshPer)).toFixed(1)} ms`);
console.log('(a count-based budget of 2 gen + 3 mesh authorised 18 ms, which is why frames dropped.)\n');
