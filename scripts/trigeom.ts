/**
 * Triangle budget of a full render-distance view, and which blocks emit it.
 *
 * `npm run perf` measures how long a chunk takes to build; this measures how much
 * geometry the result *is*, which is the other half of a frame's cost and the half
 * a generate/mesh timing cannot see. Written to answer a specific question — "did
 * the bigger trees cost the frame rate?" — and it said no: they moved the total by
 * 5%, while half of it turns out to be cave wall nobody can see.
 *
 * The attribution replicates the mesher's cube rule exactly: draw a face when the
 * neighbour lets light through, but never between two blocks of the same kind, and
 * treat below the world as solid. That last clause matters — getting it wrong
 * credits every bedrock block with an invisible downward face and invents a
 * nonexistent 12% of the frame, which is exactly what the first version of this
 * script did.
 */
import { Block, blockDef, OPAQUE_BY_ID } from '../src/world/blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from '../src/world/Chunk';
import { meshChunk } from '../src/world/ChunkMesher';
import { Biome, TerrainGen } from '../src/world/TerrainGen';

const SEED = 20260917;
/** Matches RENDER_DISTANCE in src/core/Game.ts — the governor's ceiling. */
const RENDER_DISTANCE = 9;
/** Matches MIN_RENDER_DISTANCE, for the comparison the governor trades between. */
const MIN_RENDER_DISTANCE = 6;

const gen = new TerrainGen(SEED);

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Finds a chunk whose centre sits in the given biome. */
function findBiome(biome: Biome): [number, number] {
  for (let r = 0; r < 400; r++) {
    const steps = Math.max(8, r * 4);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const cx = Math.round(Math.cos(a) * r);
      const cz = Math.round(Math.sin(a) * r);
      if (gen.biomeAt(cx * CHUNK_SX + 8, cz * CHUNK_SZ + 8) === biome) return [cx, cz];
    }
  }
  return [0, 0];
}

function survey(label: string, centreX: number, centreZ: number): void {
  const cache = new Map<string, Chunk>();
  const chunkAt = (cx: number, cz: number): Chunk => {
    const key = `${cx},${cz}`;
    let chunk = cache.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      gen.generate(chunk);
      cache.set(key, chunk);
    }
    return chunk;
  };
  const voxelAt = (wx: number, wy: number, wz: number): number => {
    // Same two clauses the mesher uses: the world is sealed below and open above.
    if (wy < 0) return Block.Bedrock;
    if (wy >= CHUNK_SY) return Block.Air;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    return chunkAt(cx, cz).voxels[voxelIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)];
  };

  let triangles = 0;
  let nearTriangles = 0;
  let chunks = 0;
  const faces = new Map<number, number>();
  const census = new Map<number, number>();

  for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
    for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
      const cx = centreX + dx;
      const cz = centreZ + dz;
      const chunk = chunkAt(cx, cz);

      const { opaque, translucent } = meshChunk(chunk, voxelAt);
      let chunkTriangles = 0;
      for (const g of [opaque, translucent]) {
        const index = g?.getIndex();
        if (index) chunkTriangles += index.count / 3;
      }
      triangles += chunkTriangles;
      // What a smaller view distance would still have to draw.
      if (Math.abs(dx) <= MIN_RENDER_DISTANCE && Math.abs(dz) <= MIN_RENDER_DISTANCE) {
        nearTriangles += chunkTriangles;
      }

      for (let y = 0; y < CHUNK_SY; y++) {
        for (let z = 0; z < CHUNK_SZ; z++) {
          for (let x = 0; x < CHUNK_SX; x++) {
            const id = chunk.voxels[voxelIndex(x, y, z)];
            if (id === Block.Air) continue;
            census.set(id, (census.get(id) ?? 0) + 1);
            if (blockDef(id).shape !== 'cube') continue;
            const wx = cx * CHUNK_SX + x;
            const wz = cz * CHUNK_SZ + z;
            for (const [nx, ny, nz] of NEIGHBOURS) {
              const n = voxelAt(wx + nx, y + ny, wz + nz);
              if (OPAQUE_BY_ID[n] === 1 || n === id) continue;
              faces.set(id, (faces.get(id) ?? 0) + 1);
            }
          }
        }
      }
      chunks++;
    }
  }

  const span = RENDER_DISTANCE * 2 + 1;
  console.log(`\n${label}  centre chunk ${centreX},${centreZ}  ${span}x${span} = ${chunks} chunks`);
  console.log(
    `  triangles        ${triangles.toLocaleString()}  (${Math.round(triangles / chunks).toLocaleString()} per chunk)`,
  );
  console.log(
    `  at radius ${MIN_RENDER_DISTANCE}      ${nearTriangles.toLocaleString()}  ` +
      `(${((nearTriangles / triangles) * 100).toFixed(0)}% — what the governor's floor still draws)`,
  );

  const attributed = [...faces.values()].reduce((a, b) => a + b, 0);
  for (const [id, count] of [...faces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(
      `    ${blockDef(id).name.padEnd(14)} ${((count / attributed) * 100).toFixed(1).padStart(5)}% of faces`,
    );
  }
  console.log(
    `  leaf voxels ${(census.get(Block.Leaves) ?? 0).toLocaleString()}, ` +
      `wood ${(census.get(Block.Wood) ?? 0).toLocaleString()}`,
  );
}

survey('FOREST', ...findBiome(Biome.Forest));
survey('TUNDRA', ...findBiome(Biome.Tundra));
survey('DESERT', ...findBiome(Biome.Desert));
