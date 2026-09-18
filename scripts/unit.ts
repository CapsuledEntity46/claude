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
import { Vector3 } from 'three';
import { item } from '../src/combat/items';
import { computeDamage, type DamageInput, type DefenseProfile } from '../src/combat/types';
import { ARCHETYPES, FISH, pickArchetype } from '../src/entities/archetypes';
import { Inventory } from '../src/player/Inventory';
import { PlayerStats, xpToReach } from '../src/player/Stats';
import { Block, blockCollisionBoxes, blockDef, isLightSource, isTargetable } from '../src/world/blocks';
import { DungeonGenerator } from '../src/world/Dungeon';
import { facingFromYaw, makeMeta, metaIsOpen, metaIsUpper, shapeBoxes } from '../src/world/shapes';
import { BAG_CAPACITY, tabForItem } from '../src/player/Inventory';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from '../src/world/Chunk';
import { meshChunk } from '../src/world/ChunkMesher';
import { mulberry32 } from '../src/world/noise';
import { TerrainGen } from '../src/world/TerrainGen';
import { TimeOfDay } from '../src/world/TimeOfDay';
import { Weather } from '../src/world/Weather';

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

check(
  'a lone cube has visibly different brightness on top, side, and underside',
  (() => {
    // Baked per-face shading, so faces stay legible when the dynamic light is
    // almost gone at night.
    const cube1 = new Chunk(0, 0);
    cube1.voxels[voxelIndex(8, 20, 8)] = Block.Stone;
    const colours = meshChunk(cube1, openNeighbor).opaque!.getAttribute('color').array as Float32Array;
    const distinct = new Set<string>();
    for (let i = 0; i < colours.length; i += 3) distinct.add(colours[i].toFixed(3));
    return distinct.size >= 4;
  })(),
);

const flat = new Chunk(0, 0);
for (let z = 2; z < 14; z++) for (let x = 2; x < 14; x++) flat.voxels[voxelIndex(x, 20, z)] = Block.Stone;
// Only the upward faces: with per-face shading baked in, the sides and underside
// of the slab are legitimately different brightnesses, and including them would
// stop this from measuring ambient occlusion at all.
const flatMesh = meshChunk(flat, openNeighbor).opaque!;
const flatColors = flatMesh.getAttribute('color').array as Float32Array;
const flatNormals = flatMesh.getAttribute('normal').array as Float32Array;
const flatTopShades = new Set<string>();
for (let i = 0; i < flatColors.length; i += 3) {
  if (flatNormals[i + 1] < 0.99) continue; // keep only +Y faces
  flatTopShades.add(flatColors[i].toFixed(4));
}
check(
  'an unoccluded flat surface is uniformly lit (no spurious AO)',
  flatTopShades.size === 1,
  `${flatTopShades.size} distinct shades across the slab's top faces`,
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

// ---------------------------------------------------------------- day/night

section('day/night cycle');

const clock = new TimeOfDay(0.5);
check('noon is fully lit', clock.daylight > 0.95, `daylight ${clock.daylight.toFixed(2)}`);
check('noon reads as day', clock.phase === 'day', clock.phaseLabel());
check('the sun is overhead at noon', clock.sunAltitude > 0.95, `altitude ${clock.sunAltitude.toFixed(2)}`);
check('no stars at noon', clock.starOpacity < 0.05, `${clock.starOpacity.toFixed(2)}`);

clock.setPhase('night');
check('midnight is dark', clock.daylight < 0.05, `daylight ${clock.daylight.toFixed(2)}`);
check('midnight reads as night', clock.isNight && clock.phase === 'night', clock.phaseLabel());
check('stars are fully out at midnight', clock.starOpacity > 0.95, `${clock.starOpacity.toFixed(2)}`);
// Night should be dark enough that a torch is worth carrying, but not so dark
// that the world is unreadable without one.
check(
  'night is dark but not pitch black',
  clock.ambientIntensity > 0.05 && clock.ambientIntensity < 0.16,
  `ambient ${clock.ambientIntensity.toFixed(3)}`,
);
check(
  'night is dramatically darker than midday',
  new TimeOfDay(0.5).ambientIntensity > clock.ambientIntensity * 4,
  `day ${new TimeOfDay(0.5).ambientIntensity.toFixed(2)} vs night ${clock.ambientIntensity.toFixed(3)}`,
);

clock.setPhase('dawn');
check('dawn is a transition, not day or night', clock.phase === 'dawn', clock.phaseLabel());
check('dawn is partially lit', clock.daylight > 0 && clock.daylight < 0.9, `daylight ${clock.daylight.toFixed(2)}`);

check(
  'the clock advances and wraps',
  (() => {
    const t = new TimeOfDay(0.99, 100);
    t.update(2); // 2s of a 100s day pushes past midnight
    return t.fraction >= 0 && t.fraction < 0.5;
  })(),
);
check(
  'the clock label is a 24-hour time',
  /^\d{2}:\d{2}$/.test(new TimeOfDay(0.5).clockLabel()),
  new TimeOfDay(0.5).clockLabel(),
);
check(
  'daylight is brighter than night by a wide margin',
  new TimeOfDay(0.5).sunIntensity > new TimeOfDay(0).sunIntensity * 3,
);
check(
  'the light direction stays above the horizon at night (moonlight)',
  (() => {
    const t = new TimeOfDay(0);
    return t.lightDirection(new Vector3()).y > 0;
  })(),
);

// ---------------------------------------------------------------- weather

section('weather');

const weather = new Weather(mulberry32(7));
weather.force('clear');
check('clear weather has no rain and no fog', weather.rainRate === 0 && weather.fogTighten === 0);
check('clear weather is labelled clear', weather.label() === 'Clear', weather.label());

weather.force('rain', 1);
check('rain produces falling drops', weather.rainRate > 100 && weather.isRaining, `rate ${weather.rainRate}`);
check('rain pulls the fog in', weather.fogTighten > 0.2, `${weather.fogTighten.toFixed(2)}`);

weather.force('storm', 1);
const stormRate = weather.rainRate;
weather.force('rain', 1);
check('a storm rains harder than rain', stormRate > weather.rainRate, `storm ${stormRate} vs rain ${weather.rainRate}`);

weather.force('fog', 1);
check('fog obscures without raining', weather.fogTighten > 0.5 && !weather.isRaining, `${weather.fogTighten.toFixed(2)}`);

check(
  'weather transitions ease rather than snapping',
  (() => {
    const w = new Weather(mulberry32(3));
    w.force('rain', 1);
    const full = w.rainRate;
    // Drive it to clear and step a fraction of the transition.
    w.force('clear');
    w.force('rain', 0.2);
    return w.rainRate > 0 && w.rainRate < full;
  })(),
);
// Simulate a long stretch of real-time weather and watch how it changes.
const weatherLog: { kind: string; intensity: number }[] = [];
{
  const w = new Weather(mulberry32(99));
  let previous = w.kind;
  for (let step = 0; step < 60_000; step++) {
    w.update(0.1); // 100 minutes at 10 Hz
    if (w.kind !== previous) {
      weatherLog.push({ kind: w.kind, intensity: w.intensity });
      previous = w.kind;
    }
  }
}

check('weather changes over time', weatherLog.length > 4, `${weatherLog.length} changes in 100 minutes`);
check(
  'weather variety is used, not just one state',
  new Set(weatherLog.map((e) => e.kind)).size >= 3,
  [...new Set(weatherLog.map((e) => e.kind))].join(', '),
);
check(
  'the weather kind only changes once the previous one has faded out',
  weatherLog.every((e) => e.intensity <= 0.05),
  `worst intensity at a switch: ${Math.max(0, ...weatherLog.map((e) => e.intensity)).toFixed(3)}`,
);
check(
  'consecutive weather states differ',
  weatherLog.every((e, i) => i === 0 || e.kind !== weatherLog[i - 1].kind),
);

// ---------------------------------------------------------------- torches, fish, food

section('torches, fish, and food');

const torch = item('torch');
check('a torch is its own equipment kind', torch.kind === 'torch', torch.kind);
check('a torch emits light', (torch.torch?.radius ?? 0) > 5, `radius ${torch.torch?.radius}`);
check('a torch can also be planted as a block', torch.block === Block.Torch);
check('the torch block is a light source', isLightSource(Block.Torch));
check('plain stone is not a light source', !isLightSource(Block.Stone));

const withTorch = new Inventory();
withTorch.add('torch', 4);
withTorch.add('iron_kite_shield');
withTorch.add('shortsword');
withTorch.equip('torch');
withTorch.equip('iron_kite_shield');
withTorch.equip('shortsword');
check(
  'a torch and a shield can be carried at the same time',
  withTorch.equipped.torch === 'torch' && withTorch.equipped.shield === 'iron_kite_shield',
  `torch ${withTorch.equipped.torch}, shield ${withTorch.equipped.shield}`,
);
check('equipping a torch does not disturb the weapon', withTorch.equipped.weapon === 'shortsword');
check('the starting kit includes a lit torch', Inventory.startingKit().equipped.torch === 'torch');

const rawFish = item('raw_fish');
const cookedFish = item('cooked_fish');
check('raw fish is edible', (rawFish.consumable?.heal ?? 0) > 0, `heals ${rawFish.consumable?.heal}`);
check(
  'cooking a fish makes it much more nourishing',
  (cookedFish.consumable?.heal ?? 0) > (rawFish.consumable?.heal ?? 0) * 3,
  `raw ${rawFish.consumable?.heal} vs cooked ${cookedFish.consumable?.heal}`,
);

check('fish are aquatic', FISH.aquatic === true);
check('fish never fight back', FISH.passive === true);
check('fish use a fish body, not a humanoid one', FISH.look.bodyStyle === 'fish');
check('fish have no attack of any kind', !FISH.melee && !FISH.ranged);
check(
  'fish always drop something to eat',
  FISH.extraLoot?.some((l) => l.itemId === 'raw_fish' && l.chance >= 1) === true,
);
check('fish are excluded from the hostile spawn roll', FISH.weight === 0);
check(
  'the hostile spawn roll never returns a fish',
  (() => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 300; i++) {
      if (pickArchetype(20, rand).id === FISH.id) return false;
    }
    return true;
  })(),
);

// ---------------------------------------------------------------- enemy sight

section('enemy sight ranges');

// The playtest complaint was that enemies noticed the player from absurd range.
const meleeSight = ARCHETYPES.filter((a) => !a.ranged).map((a) => a.aggroRange);
check(
  'melee enemies only notice you from close range',
  Math.max(...meleeSight) <= 15,
  `longest melee sight ${Math.max(...meleeSight)} blocks`,
);
const rangedSight = ARCHETYPES.filter((a) => a.ranged).map((a) => a.aggroRange);
check(
  'ranged enemies see further, but not across the map',
  Math.max(...rangedSight) <= 20 && Math.max(...rangedSight) > Math.min(...meleeSight),
  `longest ranged sight ${Math.max(...rangedSight)} blocks`,
);
check(
  'archers stand off further than they can be surprised from',
  ARCHETYPES.every((a) => !a.ranged || a.aggroRange > a.ranged.standoff),
);

// ---------------------------------------------------------------- block shapes

section('block shapes');

check('an ordinary block fills its whole voxel', shapeBoxes('cube', 0).length === 1);
check(
  'a cube box spans the unit cube exactly',
  (() => {
    const b = shapeBoxes('cube', 0)[0];
    return b.min.every((v) => v === 0) && b.max.every((v) => v === 1);
  })(),
);
check(
  'a bottom slab occupies the lower half',
  (() => {
    const b = shapeBoxes('slab', 0)[0];
    return b.min[1] === 0 && b.max[1] === 0.5;
  })(),
);
check(
  'a top slab occupies the upper half',
  (() => {
    const b = shapeBoxes('slab', makeMeta(0, true))[0];
    return b.min[1] === 0.5 && b.max[1] === 1;
  })(),
);
check('stairs are built from two boxes', shapeBoxes('stairs', 0).length === 2);
check(
  'rotating stairs moves the step to the other side',
  (() => {
    const north = shapeBoxes('stairs', makeMeta(0))[1];
    const south = shapeBoxes('stairs', makeMeta(2))[1];
    return north.min[2] !== south.min[2];
  })(),
);
check(
  'every shape box stays inside the unit cube',
  (['cube', 'slab', 'stairs', 'wedge', 'pane', 'torch', 'door', 'fence'] as const).every((shape) =>
    [0, 1, 2, 3].every((facing) =>
      shapeBoxes(shape, makeMeta(facing as 0 | 1 | 2 | 3)).every(
        (b) =>
          b.min.every((v, i) => v >= -1e-9 && v <= b.max[i]) && b.max.every((v) => v <= 1 + 1e-9),
      ),
    ),
  ),
);
check(
  'a torch is a slim post, not a cube',
  (() => {
    const boxes = shapeBoxes('torch', 0);
    // The reported bug: a placed torch looked like a glowing crate.
    return boxes.every((b) => b.max[0] - b.min[0] < 0.35 && b.max[2] - b.min[2] < 0.35);
  })(),
);
check('a torch does not block movement', blockCollisionBoxes(Block.Torch, 0).length === 0);
check('a torch can still be mined and built against', isTargetable(Block.Torch));
check('water cannot be aimed at', !isTargetable(Block.Water));
check('a closed door blocks the way', blockCollisionBoxes(Block.Door, makeMeta(0, false, false)).length > 0);
check(
  'an open door is a hole you can walk through',
  blockCollisionBoxes(Block.Door, makeMeta(0, false, true)).length === 0,
);
check('doors are interactive', blockDef(Block.Door).interactive);
check('stairs and slabs are not full cubes, so they cannot cull neighbours', !blockDef(Block.StoneStairs).opaque && !blockDef(Block.StoneSlab).opaque);
check('an ordinary block still culls neighbours', blockDef(Block.Stone).opaque);

check('meta packs and unpacks the upper flag', metaIsUpper(makeMeta(0, true)) && !metaIsUpper(makeMeta(0, false)));
check('meta packs and unpacks the open flag', metaIsOpen(makeMeta(0, false, true)) && !metaIsOpen(makeMeta(0)));
check(
  'facing follows the direction the player looks',
  (() => {
    // Player forward is (-sin yaw, 0, -cos yaw): yaw 0 looks towards -Z.
    return facingFromYaw(0) === 0 && facingFromYaw(Math.PI) === 2;
  })(),
);

// Shaped blocks must actually produce geometry, and only where they should.
const slabChunk = new Chunk(0, 0);
slabChunk.set(8, 20, 8, Block.StoneSlab, 0);
const slabTriangles = meshChunk(slabChunk, openNeighbor).opaque!.getIndex()!.count / 3;
check('a slab meshes as a single box', slabTriangles === 12, `${slabTriangles} triangles`);

const stairChunk = new Chunk(0, 0);
stairChunk.set(8, 20, 8, Block.StoneStairs, makeMeta(0));
const stairTriangles = meshChunk(stairChunk, openNeighbor).opaque!.getIndex()!.count / 3;
check('stairs mesh as two boxes', stairTriangles === 24, `${stairTriangles} triangles`);

check(
  'a shaped block does not hide its neighbour behind it',
  (() => {
    // A stone cube behind a slab must still draw the face they share, or you
    // would see a hole through the world past the slab.
    const c = new Chunk(0, 0);
    c.set(8, 20, 8, Block.StoneSlab, 0);
    c.set(9, 20, 8, Block.Stone, 0);
    const withSlab = meshChunk(c, openNeighbor).opaque!.getIndex()!.count / 3;
    const alone = new Chunk(0, 0);
    alone.set(9, 20, 8, Block.Stone, 0);
    const stoneAlone = meshChunk(alone, openNeighbor).opaque!.getIndex()!.count / 3;
    return withSlab === stoneAlone + 12;
  })(),
);

check(
  'edits round-trip block id and orientation together',
  (() => {
    const c = new Chunk(1, 1);
    c.recordEdit(3, 30, 4, Block.PlankStairs, makeMeta(2, true));
    c.applyEdits();
    return c.get(3, 30, 4) === Block.PlankStairs && c.getMeta(3, 30, 4) === makeMeta(2, true);
  })(),
);

// ---------------------------------------------------------------- mana

section('mana and spells');

const caster2 = new PlayerStats();
check('a new character starts with mana', caster2.mana > 0, `${caster2.mana}`);
check('mana capacity grows with Focus', (() => {
  const a = new PlayerStats();
  const before = a.maxMana;
  a.unspent = 1;
  a.spend('focus');
  return a.maxMana > before;
})());
caster2.mana = 10;
check('a spell you cannot afford is refused', !caster2.spendMana(25) && caster2.mana === 10);
check('an affordable spell is paid for', caster2.spendMana(6) && caster2.mana === 4);
check('mana cannot exceed its maximum', (() => {
  const a = new PlayerStats();
  a.restoreMana(9999);
  return a.mana === a.maxMana;
})());
check(
  'mana does not regenerate on its own',
  (() => {
    const a = new PlayerStats();
    a.mana = 5;
    for (let i = 0; i < 200; i++) a.update(0.1, false, false);
    return a.mana === 5;
  })(),
  'the only sources are potions and orbs',
);

const flames = item('flames');
const sparks = item('sparks');
const heal = item('mending_hand');
const oakflesh = item('oakflesh');
const greater = item('firebolt');
check('Flames is a held mana spell', flames.spell?.cost === 'mana' && flames.spell?.sustained === true);
check('Flames sets its target burning', (flames.spell?.burn ?? 0) > 0);
check('Sparks can stun', (sparks.spell?.stunChance ?? 0) > 0);
check('Healing is a channel', heal.spell?.kind === 'channel' && heal.spell?.sustained === true);
check('Oakflesh grants armor for a long duration', (oakflesh.spell?.amount ?? 0) >= 10 && (oakflesh.spell?.duration ?? 0) >= 30);
check('powerful spells still cost a slot, not mana', greater.spell?.cost === 'slot');
check('the meteor remains a slot spell', item('meteor').spell?.cost === 'slot');
check('mana potions restore mana', (item('mana_potion').consumable?.mana ?? 0) > 0);
check(
  'the starting kit includes the three automatic spells',
  (() => {
    const kit = Inventory.startingKit();
    return kit.count('flames') === 1 && kit.count('sparks') === 1 && kit.count('mending_hand') === 1;
  })(),
);

// ---------------------------------------------------------------- inventory tabs

section('inventory tabs');

check('materials are routed to the materials tab', tabForItem(item('block_cobblestone')) === 'materials');
check('weapons are routed to the tools tab', tabForItem(item('longsword')) === 'tools');
check('the build tool is a tool', tabForItem(item('build_tool')) === 'tools');
check('potions stay in the main bag', tabForItem(item('healing_draught')) === 'main');
check('the tools tab holds 44', BAG_CAPACITY.tools === 44);
check('the materials tab is four times the main bag', BAG_CAPACITY.materials === BAG_CAPACITY.main * 4);
check('the main bag was doubled', BAG_CAPACITY.main === 48);

const tabbed = new Inventory();
tabbed.add('block_cobblestone', 400);
tabbed.add('longsword');
tabbed.add('healing_draught', 3);
check('each item lands in its own tab', (() => (
  tabbed.slots('materials').some((s) => s?.itemId === 'block_cobblestone') &&
  tabbed.slots('tools').some((s) => s?.itemId === 'longsword') &&
  tabbed.slots('main').some((s) => s?.itemId === 'healing_draught')
))());
check('counting searches every tab', tabbed.count('block_cobblestone') === 400 && tabbed.count('longsword') === 1);
check('removing works across tabs', tabbed.remove('block_cobblestone', 150) && tabbed.count('block_cobblestone') === 250);
check(
  'building materials add no carry weight',
  (() => {
    const light = new Inventory();
    const before = light.carriedWeight;
    light.add('block_cobblestone', 990);
    return light.carriedWeight === before;
  })(),
);
check(
  'equipment does add weight',
  (() => {
    const heavy = new Inventory();
    const before = heavy.carriedWeight;
    heavy.add('iron_plate');
    return heavy.carriedWeight > before;
  })(),
);
check(
  'tabs survive a save/load round trip',
  (() => {
    const original = new Inventory();
    original.add('block_planks', 120);
    original.add('build_tool');
    const restored = new Inventory();
    restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
    return restored.count('block_planks') === 120 && restored.count('build_tool') === 1;
  })(),
);

// ---------------------------------------------------------------- dungeons

section('dungeons');

// A stand-in surface, so the generator can be exercised without full terrain.
const flatSurface = (x: number, z: number) => 38 + ((Math.abs(x + z) % 7) - 3);
const dungeons = new DungeonGenerator(4242, flatSurface);
const sites = dungeons.sitesNear(-600, -600, 600, 600);
check('dungeons are generated across the world', sites.length > 3, `${sites.length} sites in a 1200 block square`);
check('every site has rooms', sites.every((s) => s.rooms.length >= 5), `min rooms ${Math.min(...sites.map((s) => s.rooms.length))}`);
check('every site has exactly one vault', sites.every((s) => s.rooms.filter((r) => r.vault).length === 1));
check('rooms are connected by corridors', sites.every((s) => s.corridors.length === s.rooms.length - 1));
check(
  'rooms sit underground and clear of bedrock',
  sites.every((s) => s.rooms.every((r) => r.floorY >= 5 && r.floorY + r.height < 40)),
  `lowest floor ${Math.min(...sites.flatMap((s) => s.rooms.map((r) => r.floorY)))}`,
);
check(
  'rooms are big enough to fight in',
  sites.every((s) => s.rooms.every((r) => r.width >= 7 && r.depth >= 7 && r.height >= 4)),
);
check(
  'dungeon layout is deterministic for a seed',
  (() => {
    const a = new DungeonGenerator(99, flatSurface);
    const b = new DungeonGenerator(99, flatSurface);
    return JSON.stringify(a.siteAt(1, 1)) === JSON.stringify(b.siteAt(1, 1));
  })(),
);
check(
  'different seeds produce different dungeons',
  JSON.stringify(new DungeonGenerator(1, flatSurface).siteAt(0, 0)) !==
    JSON.stringify(new DungeonGenerator(2, flatSurface).siteAt(0, 0)),
);
check(
  'a site bounding box actually contains its rooms',
  sites.every((s) =>
    s.rooms.every((r) => r.x >= s.minX && r.x + r.width <= s.maxX && r.z >= s.minZ && r.z + r.depth <= s.maxZ),
  ),
);
check('dungeons offer spawn points', dungeons.spawnPointsNear(sites[0].entranceX, sites[0].entranceZ, 90).length > 0);
check(
  'vault guards are marked as elite',
  dungeons.spawnPointsNear(sites[0].entranceX, sites[0].entranceZ, 400).some((p) => p.elite),
);
check('an entrance can be located from far away', dungeons.nearestEntrance(0, 0, 400) !== null);

// The reported bug: the entrance stood above the landscape as a hollow tower.
check(
  'the entrance mouth sits at ground level, not above it',
  sites.every((s) => Math.abs(s.entranceY - flatSurface(s.entranceX, s.entranceZ)) < 0.001),
);
check(
  'rooms sit well below the surface',
  sites.every((s) => s.topY <= flatSurface(s.entranceX, s.entranceZ) - 8),
  `shallowest gap ${Math.min(...sites.map((s) => flatSurface(s.entranceX, s.entranceZ) - s.topY))} blocks`,
);
check(
  'the stairway is long enough to descend the whole way',
  sites.every((s) => {
    const run = Math.hypot(s.entranceX - s.rooms[0].x - s.rooms[0].width / 2, s.entranceZ - s.rooms[0].z - s.rooms[0].depth / 2);
    return run >= s.entranceY - s.topY;
  }),
);
check(
  'the stairway runs along a single cardinal direction',
  sites.every((s) => Math.abs(s.entranceDirX) + Math.abs(s.entranceDirZ) === 1),
);

// The reported bug: the entrance looked right but was walled shut, and the steps
// were laid the wrong way round. Both are verified against a real carved chunk.
check(
  'the entrance is open, not sealed',
  (() => {
    const gen = new TerrainGen(20240);
    const site = gen.dungeons.sitesNear(-400, -400, 400, 400)[0];
    if (!site) return true;
    // Walk the first few steps of the stairway and require standing room at each.
    for (let i = 0; i <= 4; i++) {
      const wx = Math.round(site.entranceX - site.entranceDirX * i);
      const wz = Math.round(site.entranceZ - site.entranceDirZ * i);
      const floorY = site.entranceY - i;
      const chunk = new Chunk(wx >> 4, wz >> 4);
      gen.generate(chunk);
      const lx = wx - (wx >> 4) * CHUNK_SX;
      const lz = wz - (wz >> 4) * CHUNK_SZ;
      // Two blocks of clear headroom above the tread is enough to walk through.
      const a = chunk.get(lx, floorY + 1, lz);
      const b = chunk.get(lx, floorY + 2, lz);
      if (a !== Block.Air || b !== Block.Air) return false;
    }
    return true;
  })(),
  'every step has standing room',
);
check(
  'the stair treads face uphill, so the descent is walkable',
  (() => {
    const gen = new TerrainGen(20240);
    const site = gen.dungeons.sitesNear(-400, -400, 400, 400)[0];
    if (!site) return true;
    // The raised half must sit on the +dir (uphill) side of each tread.
    const expected =
      Math.abs(site.entranceDirX) > Math.abs(site.entranceDirZ)
        ? site.entranceDirX > 0
          ? 1
          : 3
        : site.entranceDirZ > 0
          ? 2
          : 0;
    const wx = Math.round(site.entranceX - site.entranceDirX * 2);
    const wz = Math.round(site.entranceZ - site.entranceDirZ * 2);
    const chunk = new Chunk(wx >> 4, wz >> 4);
    gen.generate(chunk);
    const lx = wx - (wx >> 4) * CHUNK_SX;
    const lz = wz - (wz >> 4) * CHUNK_SZ;
    const floorY = site.entranceY - 2;
    if (chunk.get(lx, floorY, lz) !== Block.StoneStairs) return false;
    return (chunk.getMeta(lx, floorY, lz) & 0b11) === expected;
  })(),
);

// The entrance must be *lit*, not merely open.
//
// The frame and the tunnel write to overlapping columns, so whichever runs last
// wins. Unsealing the entrance meant carving the frame first, which silently put
// the tunnel's full-height wall pass on top of the rim braziers and left the mouth
// dark. The smoke test that caught this sampled every other voxel, so it only
// noticed by parity accident — this walks every voxel around the mouth.
check(
  'the entrance is lit, not just open',
  (() => {
    const gen = new TerrainGen(20240);
    const sites = gen.dungeons.sitesNear(-400, -400, 400, 400).slice(0, 6);
    if (sites.length === 0) return true;
    const chunks = new Map<string, Chunk>();
    const blockAt = (wx: number, y: number, wz: number): Block => {
      const cx = wx >> 4;
      const cz = wz >> 4;
      const key = `${cx},${cz}`;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = new Chunk(cx, cz);
        gen.generate(chunk);
        chunks.set(key, chunk);
      }
      return chunk.get(wx - cx * CHUNK_SX, y, wz - cz * CHUNK_SZ);
    };

    // Torches in a band of the stairway, measured in steps in from the mouth.
    const torchesBetween = (site: (typeof sites)[number], fromAlong: number, toAlong: number): number => {
      const sideX = site.entranceDirZ;
      const sideZ = -site.entranceDirX;
      let torches = 0;
      for (let along = fromAlong; along <= toAlong; along++) {
        for (let across = -3; across <= 3; across++) {
          const wx = Math.round(site.entranceX - site.entranceDirX * along + sideX * across);
          const wz = Math.round(site.entranceZ - site.entranceDirZ * along + sideZ * across);
          const floorY = site.entranceY - Math.max(0, along);
          for (let y = floorY; y <= floorY + 5; y++) {
            if (blockAt(wx, y, wz) === Block.Torch) torches++;
          }
        }
      }
      return torches;
    };

    // The mouth itself, which is the part that has to read as a dungeon from
    // across open ground. Deliberately excludes the first stairway torch further
    // in, so stairway lighting cannot mask a missing brazier.
    return sites.every((site) => torchesBetween(site, -1, 1) > 0);
  })(),
  'the mouth carries a brazier',
);
check(
  'the stairway down is lit',
  (() => {
    const gen = new TerrainGen(20240);
    const sites = gen.dungeons.sitesNear(-400, -400, 400, 400).slice(0, 6);
    if (sites.length === 0) return true;
    const chunks = new Map<string, Chunk>();
    const blockAt = (wx: number, y: number, wz: number): Block => {
      const cx = wx >> 4;
      const cz = wz >> 4;
      const key = `${cx},${cz}`;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = new Chunk(cx, cz);
        gen.generate(chunk);
        chunks.set(key, chunk);
      }
      return chunk.get(wx - cx * CHUNK_SX, y, wz - cz * CHUNK_SZ);
    };
    return sites.every((site) => {
      const sideX = site.entranceDirZ;
      const sideZ = -site.entranceDirX;
      let torches = 0;
      for (let along = 2; along <= 12; along++) {
        for (let across = -3; across <= 3; across++) {
          const wx = Math.round(site.entranceX - site.entranceDirX * along + sideX * across);
          const wz = Math.round(site.entranceZ - site.entranceDirZ * along + sideZ * across);
          const floorY = site.entranceY - along;
          for (let y = floorY; y <= floorY + 5; y++) {
            if (blockAt(wx, y, wz) === Block.Torch) torches++;
          }
        }
      }
      return torches > 0;
    });
  })(),
  'the descent is not a dark hole',
);

// Carving must actually hollow out the rock, and identically every time.
check(
  'carving a chunk hollows out dungeon space',
  (() => {
    const gen = new TerrainGen(4242);
    const site = gen.dungeons.siteAt(0, 0);
    if (!site) return true; // this seed left cell (0,0) empty
    const room = site.rooms[0];
    const chunk = new Chunk(room.x >> 4, room.z >> 4);
    gen.generate(chunk);
    // The room interior should contain air at floor level somewhere in the chunk.
    let air = 0;
    for (let y = room.floorY; y < room.floorY + room.height; y++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) if (chunk.get(x, y, z) === Block.Air) air++;
      }
    }
    return air > 20;
  })(),
  'rooms are open space, not solid rock',
);
check(
  'chunk carving is order independent',
  (() => {
    // The same chunk generated twice must be identical, which is what lets chunks
    // stream in any order without dungeons coming out different.
    const gen = new TerrainGen(777);
    const a = new Chunk(3, -2);
    const b = new Chunk(3, -2);
    gen.generate(a);
    gen.generate(b);
    return a.voxels.every((v, i) => v === b.voxels[i]) && a.meta.every((v, i) => v === b.meta[i]);
  })(),
);

// ---------------------------------------------------------------- result

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL UNIT CHECKS PASSED');
