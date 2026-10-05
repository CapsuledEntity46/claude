/**
 * Prints the silhouette of every tree species.
 *
 * Trees are built from clumps and limbs whose vertical extent is implied by a
 * squash factor rather than stated, which makes "is this the right shape" a
 * question you cannot answer by reading the code. This grows one of each on flat
 * ground and draws its profile, so the answer is visible.
 */
import { Block } from '../src/world/blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from '../src/world/Chunk';
import { Biome, TerrainGen } from '../src/world/TerrainGen';

const SPECIES = ['Oak', 'Birch', 'Pine', 'Jungle', 'Willow'] as const;

/**
 * Finds a column of the given biome that actually grew a tree, then renders the
 * chunk's tallest tree as a front elevation.
 */
function findTrees(biome: Biome, wanted: number): void {
  const gen = new TerrainGen(20260917);
  const found: { chunk: Chunk; x: number; z: number; base: number; top: number }[] = [];

  for (let cx = -60; cx < 60 && found.length < wanted; cx++) {
    for (let cz = -60; cz < 60 && found.length < wanted; cz++) {
      // Only bother with chunks whose centre is the biome we want.
      if (gen.biomeAt(cx * CHUNK_SX + 8, cz * CHUNK_SZ + 8) !== biome) continue;
      const chunk = new Chunk(cx, cz);
      gen.generate(chunk);

      for (let z = 2; z < CHUNK_SZ - 2 && found.length < wanted; z++) {
        for (let x = 2; x < CHUNK_SX - 2 && found.length < wanted; x++) {
          // A trunk base: wood with non-wood below it.
          for (let y = 2; y < CHUNK_SY - 2; y++) {
            if (chunk.voxels[voxelIndex(x, y, z)] !== Block.Wood) continue;
            if (chunk.voxels[voxelIndex(x, y - 1, z)] === Block.Wood) break;
            let run = 0;
            while (y + run < CHUNK_SY && chunk.voxels[voxelIndex(x, y + run, z)] === Block.Wood) run++;
            if (run >= 6) found.push({ chunk, x, z, base: y, top: y + run - 1 });
            break;
          }
        }
      }
    }
  }

  for (const tree of found) {
    const { chunk, x, z, base, top } = tree;
    // Walk out from the trunk to find the full vertical extent of its foliage.
    let lowest = base;
    let highest = top;
    for (let dy = -8; dy <= 34; dy++) {
      for (let dz = -7; dz <= 7; dz++) {
        for (let dx = -7; dx <= 7; dx++) {
          const px = x + dx;
          const pz = z + dz;
          const py = base + dy;
          if (px < 0 || px >= CHUNK_SX || pz < 0 || pz >= CHUNK_SZ) continue;
          if (py < 0 || py >= CHUNK_SY) continue;
          const v = chunk.voxels[voxelIndex(px, py, pz)];
          if (v !== Block.Leaves && v !== Block.Wood) continue;
          lowest = Math.min(lowest, py);
          highest = Math.max(highest, py);
        }
      }
    }

    console.log(`\n  trunk at local (${x},${z}) base y=${base} top y=${top} (${top - base + 1} tall), foliage y=${lowest}..${highest}`);
    // Front elevation: for each height, the widest run of leaf/wood across x.
    for (let y = highest; y >= lowest; y--) {
      let row = '';
      for (let dx = -7; dx <= 7; dx++) {
        const px = x + dx;
        if (px < 0 || px >= CHUNK_SX) {
          row += ' ';
          continue;
        }
        // Collapse the z axis: show whatever is most structural in this column.
        let cell = ' ';
        for (let dz = -7; dz <= 7; dz++) {
          const pz = z + dz;
          if (pz < 0 || pz >= CHUNK_SZ) continue;
          const v = chunk.voxels[voxelIndex(px, y, pz)];
          if (v === Block.Wood) {
            cell = '#';
            break;
          }
          if (v === Block.Leaves) cell = '*';
        }
        row += cell;
      }
      console.log(`   y${String(y).padStart(3)} |${row}|${y === top ? '  <- trunk top' : ''}`);
    }
  }
  if (found.length === 0) console.log('  (none found)');
}

for (const [index, biome] of [Biome.Forest, Biome.Tundra, Biome.Jungle, Biome.Wetland, Biome.Plains].entries()) {
  console.log(`\n================ ${['Forest', 'Tundra', 'Jungle', 'Wetland', 'Plains'][index]} ================`);
  findTrees(biome, 2);
}
console.log(`\nspecies in play: ${SPECIES.join(', ')}`);
