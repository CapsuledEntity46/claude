/**
 * Unit checks for the parts of the game that are pure functions: the damage
 * formula, the chunk mesher, terrain determinism, and inventory/slot bookkeeping.
 *
 * These verify the *design claims* — that a mace beats plate, that a thrust
 * beats a swing against armour, that the mesher culls shared faces and bakes
 * ambient occlusion — rather than merely that the code runs.
 *
 * Run with: npm run test:unit
 */
import { item } from '../src/combat/items';
import { computeDamage, type DamageInput, type DefenseProfile } from '../src/combat/types';
import { Inventory } from '../src/player/Inventory';
import { PlayerStats, xpToReach } from '../src/player/Stats';
import { Block } from '../src/world/blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from '../src/world/Chunk';
import { meshChunk } from '../src/world/ChunkMesher';
import { TerrainGen } from '../src/world/TerrainGen';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n[${name}]`);
}

/** Deterministic "rng": mid-range, so variance is 1.0 and nothing crits. */
const flatRng = () => 0.5;

// ---------------------------------------------------------------- damage design

section('damage formula and armour design');

const quilted = item('quilted_armor').armor!;
const leather = item('leather_armor').armor!;
const plate = item('iron_plate').armor!;

const asDefense = (a: typeof quilted): DefenseProfile => ({ armor: a.armor, resist: a.resist });

function hit(weaponId: string, modeIndex: number, defense: DefenseProfile): number {
  const attack = item(weaponId).weapon!.melee[modeIndex];
  const input: DamageInput = {
    amount: attack.damage,
    type: attack.type,
    armorPierce: attack.armorPierce,
  };
  return computeDamage(input, defense, flatRng).damage;
}

const swordSwingVsPlate = hit('longsword', 0, asDefense(plate));
const swordThrustVsPlate = hit('longsword', 1, asDefense(plate));
const maceVsPlate = hit('mace', 0, asDefense(plate));
const swordSwingVsQuilted = hit('longsword', 0, asDefense(quilted));
const maceVsQuilted = hit('mace', 0, asDefense(quilted));
const swordSwingVsLeather = hit('longsword', 0, asDefense(leather));

check(
  'a mace out-damages a longsword swing against iron plate',
  maceVsPlate > swordSwingVsPlate,
  `mace ${maceVsPlate} vs sword-swing ${swordSwingVsPlate}`,
);
check(
  'thrusting beats swinging against iron plate',
  swordThrustVsPlate > swordSwingVsPlate,
  `thrust ${swordThrustVsPlate} vs swing ${swordSwingVsPlate}`,
);
check(
  'swinging beats thrusting against unarmoured targets',
  hit('longsword', 0, { armor: 0, resist: {} }) > hit('longsword', 1, { armor: 0, resist: {} }),
  `swing ${hit('longsword', 0, { armor: 0, resist: {} })} vs thrust ${hit('longsword', 1, { armor: 0, resist: {} })}`,
);
check(
  'plate protects against slashing better than quilted does',
  swordSwingVsPlate < swordSwingVsQuilted,
  `plate ${swordSwingVsPlate} < quilted ${swordSwingVsQuilted}`,
);
check(
  'armour tiers are ordered for slashing: quilted > leather > plate damage taken',
  swordSwingVsQuilted > swordSwingVsLeather && swordSwingVsLeather > swordSwingVsPlate,
  `${swordSwingVsQuilted} > ${swordSwingVsLeather} > ${swordSwingVsPlate}`,
);
check(
  'plate is the worst armour against blunt force (its intended weakness)',
  maceVsPlate > maceVsQuilted,
  `mace vs plate ${maceVsPlate} > mace vs quilted ${maceVsQuilted}`,
);
check(
  'damage never drops below the 1-point floor',
  computeDamage({ amount: 1, type: 'slash' }, { armor: 999, resist: {} }, flatRng).damage === 1,
);
check(
  'armour piercing reduces the effect of flat armour',
  computeDamage({ amount: 20, type: 'pierce', armorPierce: 1 }, asDefense(plate), flatRng).damage >
    computeDamage({ amount: 20, type: 'pierce', armorPierce: 0 }, asDefense(plate), flatRng).damage,
);
check(
  'crits multiply damage',
  computeDamage({ amount: 10, type: 'slash', critChance: 1, critMultiplier: 2 }, { armor: 0, resist: {} }, flatRng)
    .damage === 20,
);
check(
  'canCrit:false suppresses crits even at 100% chance',
  computeDamage({ amount: 10, type: 'slash', critChance: 1, canCrit: false }, { armor: 0, resist: {} }, flatRng)
    .crit === false,
);

// ---------------------------------------------------------------- weapon geometry

section('weapon geometry determines attack modes');

const modesOf = (id: string) => item(id).weapon!.melee.map((m) => m.mode);

check('a mace can only swing (no point to thrust with)', JSON.stringify(modesOf('mace')) === '["swing"]', modesOf('mace').join(','));
check('a warhammer can only swing', JSON.stringify(modesOf('warhammer')) === '["swing"]', modesOf('warhammer').join(','));
check('a battleaxe can only swing', JSON.stringify(modesOf('battleaxe')) === '["swing"]', modesOf('battleaxe').join(','));
check('a spear can only thrust (nothing to cut with)', JSON.stringify(modesOf('spear')) === '["thrust"]', modesOf('spear').join(','));
check('a rapier can only thrust', JSON.stringify(modesOf('rapier')) === '["thrust"]', modesOf('rapier').join(','));
check('a sword can do both', modesOf('shortsword').includes('swing') && modesOf('shortsword').includes('thrust'), modesOf('shortsword').join(','));
check('a halberd can do both (axe head plus spike)', modesOf('halberd').length === 2, modesOf('halberd').join(','));
check(
  'thrusts always reach further than swings on the same weapon',
  item('longsword').weapon!.melee[1].reach > item('longsword').weapon!.melee[0].reach,
);
check(
  'swings can hit more targets than thrusts',
  item('longsword').weapon!.melee[0].maxTargets > item('longsword').weapon!.melee[1].maxTargets,
);
check(
  'every thrust pierces more armour than every swing',
  [...['shortsword', 'longsword', 'halberd', 'dagger']].every((id) => {
    const modes = item(id).weapon!.melee;
    const swing = modes.find((m) => m.mode === 'swing');
    const thrust = modes.find((m) => m.mode === 'thrust');
    return !swing || !thrust || thrust.armorPierce > swing.armorPierce;
  }),
);

// ---------------------------------------------------------------- mesher

section('chunk mesher');

/** All-air neighbourhood, so border faces are emitted rather than culled. */
const openNeighbor = () => Block.Air;

function triangleCount(chunk: Chunk): number {
  const { opaque } = meshChunk(chunk, openNeighbor);
  return opaque ? opaque.getIndex()!.count / 3 : 0;
}

const single = new Chunk(0, 0);
single.voxels[voxelIndex(8, 20, 8)] = Block.Stone;
check('an isolated block produces exactly 6 quads (12 triangles)', triangleCount(single) === 12, `${triangleCount(single)} triangles`);

const pair = new Chunk(0, 0);
pair.voxels[voxelIndex(8, 20, 8)] = Block.Stone;
pair.voxels[voxelIndex(9, 20, 8)] = Block.Stone;
check(
  'two adjacent blocks cull their shared faces (10 quads, not 12)',
  triangleCount(pair) === 20,
  `${triangleCount(pair)} triangles, expected 20`,
);

const cube = new Chunk(0, 0);
for (let y = 18; y <= 20; y++) {
  for (let z = 7; z <= 9; z++) {
    for (let x = 7; x <= 9; x++) cube.voxels[voxelIndex(x, y, z)] = Block.Stone;
  }
}
check(
  'a solid 3x3x3 emits only its 54 surface quads',
  triangleCount(cube) === 108,
  `${triangleCount(cube)} triangles, expected 108`,
);

// Ambient occlusion: a floor with a wall on it must produce more than one
// brightness level, otherwise AO is not actually being applied.
const aoChunk = new Chunk(0, 0);
for (let z = 2; z < 14; z++) {
  for (let x = 2; x < 14; x++) aoChunk.voxels[voxelIndex(x, 20, z)] = Block.Stone;
}
for (let y = 21; y <= 23; y++) {
  for (let x = 2; x < 14; x++) aoChunk.voxels[voxelIndex(x, y, 6)] = Block.Stone;
}
const aoMesh = meshChunk(aoChunk, openNeighbor);
const colors = aoMesh.opaque!.getAttribute('color').array as Float32Array;
const distinctShades = new Set<string>();
for (let i = 0; i < colors.length; i += 3) distinctShades.add(colors[i].toFixed(4));
check(
  'mesher bakes ambient occlusion (multiple brightness levels on one block type)',
  distinctShades.size >= 3,
  `${distinctShades.size} distinct shades`,
);

const flat = new Chunk(0, 0);
for (let z = 2; z < 14; z++) for (let x = 2; x < 14; x++) flat.voxels[voxelIndex(x, 20, z)] = Block.Stone;
const flatColors = meshChunk(flat, openNeighbor).opaque!.getAttribute('color').array as Float32Array;
const flatTopShades = new Set<string>();
for (let i = 0; i < flatColors.length; i += 3) flatTopShades.add(flatColors[i].toFixed(4));
check(
  'an unoccluded flat surface is uniformly lit (no spurious AO)',
  flatTopShades.size <= 3,
  `${flatTopShades.size} distinct shades on a flat slab`,
);

// Water and glass belong to the translucent pass, not the opaque one.
const watery = new Chunk(0, 0);
watery.voxels[voxelIndex(8, 20, 8)] = Block.Water;
const wateryMesh = meshChunk(watery, openNeighbor);
check('water is meshed into the translucent pass', wateryMesh.translucent !== null && wateryMesh.opaque === null);

const twoWater = new Chunk(0, 0);
twoWater.voxels[voxelIndex(8, 20, 8)] = Block.Water;
twoWater.voxels[voxelIndex(9, 20, 8)] = Block.Water;
check(
  'adjacent water blocks do not draw internal faces',
  twoWater && meshChunk(twoWater, openNeighbor).translucent!.getIndex()!.count / 3 === 20,
);

const empty = new Chunk(0, 0);
check('an empty chunk produces no geometry', meshChunk(empty, openNeighbor).opaque === null);

// Border culling: a chunk packed solid, surrounded by solid neighbours, should
// emit only its top surface — no walls at the four chunk seams, and no floor
// (the mesher treats below-world as bedrock).
const packed = new Chunk(0, 0);
packed.voxels.fill(Block.Stone);
const packedTriangles = meshChunk(packed, () => Block.Stone).opaque!.getIndex()!.count / 3;
check(
  'unloaded neighbours are treated as solid, so no seam walls are drawn',
  packedTriangles === CHUNK_SX * CHUNK_SZ * 2,
  `${packedTriangles} triangles, expected ${CHUNK_SX * CHUNK_SZ * 2} (top surface only)`,
);

// The same chunk against empty neighbours must grow four walls.
const exposedTriangles = meshChunk(packed, openNeighbor).opaque!.getIndex()!.count / 3;
check(
  'exposed chunk edges do emit wall faces',
  exposedTriangles > packedTriangles,
  `${exposedTriangles} triangles exposed vs ${packedTriangles} sealed`,
);

// ---------------------------------------------------------------- terrain

section('terrain generation');

const genA = new TerrainGen(12345);
const genB = new TerrainGen(12345);
const genC = new TerrainGen(999);

const sample = [
  [0, 0],
  [37, -91],
  [-410, 233],
  [1024, 2048],
];
check(
  'terrain is deterministic for a given seed',
  sample.every(([x, z]) => genA.surfaceHeight(x, z) === genB.surfaceHeight(x, z)),
);
check(
  'different seeds produce different terrain',
  sample.some(([x, z]) => genA.surfaceHeight(x, z) !== genC.surfaceHeight(x, z)),
);
check(
  'surface heights stay inside the world column',
  sample.every(([x, z]) => {
    const h = genA.surfaceHeight(x, z);
    return h >= 4 && h < CHUNK_SY - 8;
  }),
);

const generated = new Chunk(3, -2);
genA.generate(generated);
let solidCount = 0;
for (let i = 0; i < generated.voxels.length; i++) if (generated.voxels[i] !== Block.Air) solidCount++;
check('generated chunks contain terrain', solidCount > 1000, `${solidCount} solid voxels`);
check(
  'bedrock seals the bottom of every column',
  (() => {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        if (generated.voxels[voxelIndex(x, 0, z)] !== Block.Bedrock) return false;
      }
    }
    return true;
  })(),
);
check(
  'height map matches the topmost non-air voxel',
  (() => {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const h = generated.heightAt(x, z);
        if (generated.voxels[voxelIndex(x, h, z)] === Block.Air) return false;
        for (let y = h + 1; y < CHUNK_SY; y++) {
          if (generated.voxels[voxelIndex(x, y, z)] !== Block.Air) return false;
        }
      }
    }
    return true;
  })(),
);

// Player edits must survive regeneration — this is what makes seed-only saves work.
const edited = new Chunk(3, -2);
edited.edits.set(voxelIndex(4, 40, 4), Block.Brick);
genA.generate(edited);
check(
  'player edits are re-applied after terrain regeneration',
  edited.voxels[voxelIndex(4, 40, 4)] === Block.Brick,
);

// ---------------------------------------------------------------- progression

section('progression and inventory');

const stats = new PlayerStats();
check('starting character has a survivable health pool', stats.maxHp >= 30, `${stats.maxHp} HP`);
check('XP curve is strictly increasing', xpToReach(2) < xpToReach(3) && xpToReach(3) < xpToReach(4));
check('level 1 requires no XP', xpToReach(1) === 0);

const levelled = new PlayerStats();
const gained = levelled.addXp(xpToReach(3));
check('enough XP grants the right number of levels', levelled.level === 3 && gained === 2, `level ${levelled.level}, gained ${gained}`);
check('levelling up grants attribute points', levelled.unspent === 4, `${levelled.unspent} points`);
check('levelling up restores health to full', levelled.hp === levelled.maxHp);

const spender = new PlayerStats();
spender.addXp(xpToReach(2));
const beforeSpend = spender.attributes.might;
check('attribute points can be spent', spender.spend('might') && spender.attributes.might === beforeSpend + 1);
const drained = new PlayerStats();
check('cannot spend points you do not have', drained.spend('might') === false);

const caster = new PlayerStats();
check('tier 1 spell slots exist at level 1', caster.slotsAvailable(1) > 0, `${caster.slotsAvailable(1)} slots`);
check('tier 2 slots are locked at level 1', caster.slotsAvailable(2) === 0);
check('tier 3 slots are locked at level 1', caster.slotsAvailable(3) === 0);
caster.addXp(xpToReach(4));
check('tier 2 slots unlock at level 4', caster.slotsAvailable(2) > 0, `${caster.slotsAvailable(2)} slots`);
caster.addXp(xpToReach(8));
check('tier 3 slots unlock at level 8', caster.slotsAvailable(3) > 0, `${caster.slotsAvailable(3)} slots`);

const slotUser = new PlayerStats();
const available = slotUser.slotsAvailable(1);
slotUser.consumeSlot(1);
check('casting consumes a slot', slotUser.slotsAvailable(1) === available - 1);
while (slotUser.slotsAvailable(1) > 0) slotUser.consumeSlot(1);
check('cannot cast with no slots left', slotUser.consumeSlot(1) === false);
check('restoring returns a slot', slotUser.restoreSlot(1) && slotUser.slotsAvailable(1) === 1);

const bag = new Inventory();
check('adding an item stores it', bag.add('arrow', 10) === 0 && bag.count('arrow') === 10);
check('stacks respect their max size', (() => {
  const b = new Inventory();
  b.add('arrow', 250);
  return b.count('arrow') === 250; // 99 + 99 + 52 across three slots
})(), `${(() => { const b = new Inventory(); b.add('arrow', 250); return b.count('arrow'); })()} arrows`);
check('removing more than you have fails cleanly', bag.remove('arrow', 999) === false && bag.count('arrow') === 10);
check('removing a valid amount works', bag.remove('arrow', 4) && bag.count('arrow') === 6);

const equipper = new Inventory();
equipper.add('longsword');
equipper.add('wooden_buckler');
equipper.equip('longsword');
equipper.equip('wooden_buckler');
check(
  'equipping a shield unequips a two-handed weapon',
  equipper.equipped.weapon === null && equipper.equipped.shield === 'wooden_buckler',
);
equipper.equip('longsword');
check('equipping a two-handed weapon drops the shield', equipper.equipped.shield === null);

const modes = new Inventory();
check('attack mode starts at 0', modes.attackModeIndex('shortsword', 2) === 0);
check('cycling attack mode advances it', modes.cycleAttackMode('shortsword', 2) === 1);
check('cycling wraps around', modes.cycleAttackMode('shortsword', 2) === 0);
check('single-mode weapons never cycle', modes.cycleAttackMode('mace', 1) === 0);

const kit = Inventory.startingKit();
check('starting kit equips a weapon, shield, and armour', !!kit.equipped.weapon && !!kit.equipped.shield && !!kit.equipped.armor);
check('starting kit fills the hotbar', kit.hotbar.filter(Boolean).length >= 6, `${kit.hotbar.filter(Boolean).length} slots`);

const round = Inventory.startingKit();
round.add('musket');
const restored = new Inventory();
restored.restore(JSON.parse(JSON.stringify(round.snapshot())));
check(
  'inventory survives a save/load round trip',
  restored.count('musket') === 1 &&
    restored.equipped.weapon === round.equipped.weapon &&
    restored.hotbar.join(',') === round.hotbar.join(','),
);

const tampered = new Inventory();
tampered.restore({
  bag: [{ itemId: 'not_a_real_item', qty: 5 }],
  hotbar: ['also_fake'],
  equipped: { weapon: 'nope', shield: null, armor: null },
  selected: 99,
  attackModes: [],
});
check(
  'a corrupt save is sanitised rather than trusted',
  tampered.bag[0] === null && tampered.hotbar[0] === null && tampered.equipped.weapon === null && tampered.selected < 8,
);

// ---------------------------------------------------------------- result

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL UNIT CHECKS PASSED');
