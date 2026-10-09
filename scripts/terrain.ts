/**
 * Terrain survey.
 *
 * Prints what the generator actually produces over a large area, so terrain
 * claims can be checked against numbers instead of a screenshot of one spot.
 * Run with: npm run survey
 */
import { Biome, SEA_LEVEL, TerrainGen } from '../src/world/TerrainGen';
import { Block } from '../src/world/blocks';
import { CHUNK_SY, Chunk } from '../src/world/Chunk';

const BIOME_NAMES: Record<number, string> = {
  [Biome.Plains]: 'Plains',
  [Biome.Forest]: 'Forest',
  [Biome.Desert]: 'Desert',
  [Biome.Tundra]: 'Tundra',
  [Biome.Mountains]: 'Mountains',
  [Biome.Ocean]: 'Ocean',
  [Biome.Beach]: 'Beach',
  [Biome.Badlands]: 'Badlands',
  [Biome.Jungle]: 'Jungle',
  [Biome.Wetland]: 'Wetland',
};

const gen = new TerrainGen(20260917);
const SPAN = 3000;
const STEP = 6;

const heights: number[] = [];
const biomeCounts = new Map<number, number>();
let minH = Infinity;
let maxH = -Infinity;
let belowSea = 0;
let deepOcean = 0;
let samples = 0;

for (let z = -SPAN; z <= SPAN; z += STEP) {
  for (let x = -SPAN; x <= SPAN; x += STEP) {
    const h = gen.surfaceHeight(x, z);
    const biome = gen.biomeAt(x, z);
    heights.push(h);
    samples++;
    biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (h <= SEA_LEVEL) belowSea++;
    if (h < SEA_LEVEL - 28) deepOcean++;
  }
}

heights.sort((a, b) => a - b);
const pct = (n: number): string => `${((n / samples) * 100).toFixed(1)}%`;
const at = (q: number): number => heights[Math.floor(heights.length * q)];

console.log(`\nsurveyed ${samples} columns over ${SPAN * 2} x ${SPAN * 2} blocks (seed ${gen.seed})`);
console.log(`world height ${CHUNK_SY}, sea level ${SEA_LEVEL}`);
console.log(`\nheight  min ${minH}  p10 ${at(0.1)}  median ${at(0.5)}  p90 ${at(0.9)}  p99 ${at(0.99)}  max ${maxH}`);
console.log(`ocean   ${pct(belowSea)} of columns below sea level, ${pct(deepOcean)} deep (28+ below)`);

console.log('\nbiomes');
for (const [biome, count] of [...biomeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(BIOME_NAMES[biome] ?? biome).padEnd(10)} ${pct(count).padStart(6)}`);
}

// Relief: how much the ground moves over a short walk, which is what "dramatic"
// actually means in practice.
let maxLocalRelief = 0;
let reliefAt = '';
for (let z = -SPAN; z <= SPAN; z += 40) {
  for (let x = -SPAN; x <= SPAN; x += 40) {
    const a = gen.surfaceHeight(x, z);
    const b = gen.surfaceHeight(x + 40, z);
    const c = gen.surfaceHeight(x, z + 40);
    const relief = Math.max(Math.abs(a - b), Math.abs(a - c));
    if (relief > maxLocalRelief) {
      maxLocalRelief = relief;
      reliefAt = `${x},${z}`;
    }
  }
}
// Islands: land standing above the waterline out in ocean territory.
let islandCols = 0;
let oceanCols = 0;
for (let z = -SPAN; z <= SPAN; z += STEP) {
  for (let x = -SPAN; x <= SPAN; x += STEP) {
    const deepish = gen.biomeAt(x, z);
    if (deepish === Biome.Ocean) oceanCols++;
  }
}
for (let z = -SPAN; z <= SPAN; z += STEP) {
  for (let x = -SPAN; x <= SPAN; x += STEP) {
    if (gen.surfaceHeight(x, z) > SEA_LEVEL + 1 && gen.isOceanRegion(x, z)) islandCols++;
  }
}
console.log(`island land: ${islandCols} columns sampled above water in ocean regions (ocean ${oceanCols})`);

console.log(`\nsteepest 40-block relief: ${maxLocalRelief} blocks, near ${reliefAt}`);

// Terraces: a plateau shows up as runs of columns at exactly the same height.
let longestFlat = 0;
for (let z = -SPAN; z <= SPAN; z += 97) {
  let run = 1;
  let prev = gen.surfaceHeight(-SPAN, z);
  for (let x = -SPAN + 1; x <= SPAN; x++) {
    const h = gen.surfaceHeight(x, z);
    if (h === prev) run++;
    else {
      if (run > longestFlat) longestFlat = run;
      run = 1;
    }
    prev = h;
  }
}
console.log(`longest dead-flat run: ${longestFlat} blocks`);

// What actually lands in the voxels: lava, underground water, strata.
const counts = new Map<number, number>();
for (let cx = 0; cx < 8; cx++) {
  for (let cz = 0; cz < 8; cz++) {
    const chunk = new Chunk(cx * 7, cz * 7);
    gen.generate(chunk);
    for (let i = 0; i < chunk.voxels.length; i++) {
      const id = chunk.voxels[i];
      if (id !== Block.Air) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
}
console.log('\nvoxels across 64 scattered chunks');
const names: Record<number, string> = {
  [Block.Lava]: 'Lava',
  [Block.Water]: 'Water',
  [Block.Terracotta]: 'Terracotta',
  [Block.PaleTerracotta]: 'PaleTerracotta',
  [Block.Snow]: 'Snow',
  [Block.Sand]: 'Sand',
  [Block.Grass]: 'Grass',
  [Block.Stone]: 'Stone',
  [Block.Wood]: 'Wood',
  [Block.Leaves]: 'Leaves',
};
for (const [id, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  const label = names[id];
  if (label) console.log(`  ${label.padEnd(15)} ${count}`);
}
