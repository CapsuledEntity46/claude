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
import { Box3, Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three';
import { item } from '../src/combat/items';
import {
  bladeGeometry,
  bowModel,
  haftedModel,
  shieldModel,
  swordModel,
  torchModel,
} from '../src/fx/models';
import { buildCreature } from '../src/fx/creatures';
import {
  ALL_TILE_IDS,
  ATLAS_PIXELS,
  TILE_PADDING,
  TILE_PIXELS,
  Tile,
  tileForFace,
  tileRect,
  tryCreateBlockAtlas,
} from '../src/world/textures';
import {
  DIRECTION_VECTOR,
  THRUST_FALLBACK_DIRECTION,
  applyDirectionModifiers,
  availableModes,
  computeDamage,
  resolveDirectionalAttack,
  type AttackDirection,
  type DamageInput,
  type DefenseProfile,
} from '../src/combat/types';
import { GESTURE_CONFIG, GestureTracker, classifyGesture } from '../src/combat/GestureTracker';
import { ARCHETYPES, FISH, pickArchetype } from '../src/entities/archetypes';
import { Inventory } from '../src/player/Inventory';
import { PlayerStats, xpToReach } from '../src/player/Stats';
import {
  ABILITY_KEYS,
  POINT_BUY,
  abilityModifier,
  canDecrease,
  canIncrease,
  costOfScore,
  costToRaise,
  createPointBuyState,
  decrease,
  increase,
  isComplete,
  reset,
  sanitizeScores,
  suggestedAllocation,
  validationIssues,
} from '../src/player/PointBuy';
import { Block, blockCollisionBoxes, blockDef, isLightSource, isTargetable } from '../src/world/blocks';
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

function hit(weaponId: string, mode: 'swing' | 'thrust', defense: DefenseProfile): number {
  const attack = item(weaponId).weapon!.melee[mode]!;
  const input: DamageInput = {
    amount: attack.damage,
    type: attack.type,
    armorPierce: attack.armorPierce,
  };
  return computeDamage(input, defense, flatRng).damage;
}

const swordSwingVsPlate = hit('longsword', 'swing', asDefense(plate));
const swordThrustVsPlate = hit('longsword', 'thrust', asDefense(plate));
const maceVsPlate = hit('mace', 'swing', asDefense(plate));
const swordSwingVsQuilted = hit('longsword', 'swing', asDefense(quilted));
const maceVsQuilted = hit('mace', 'swing', asDefense(quilted));
const swordSwingVsLeather = hit('longsword', 'swing', asDefense(leather));

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
  hit('longsword', 'swing', { armor: 0, resist: {} }) > hit('longsword', 'thrust', { armor: 0, resist: {} }),
  `swing ${hit('longsword', 'swing', { armor: 0, resist: {} })} vs thrust ${hit('longsword', 'thrust', { armor: 0, resist: {} })}`,
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

const modesOf = (id: string) => availableModes(item(id).weapon!.melee).map((m) => m.mode);

check('a mace can only swing (no point to thrust with)', JSON.stringify(modesOf('mace')) === '["swing"]', modesOf('mace').join(','));
check('a warhammer can only swing', JSON.stringify(modesOf('warhammer')) === '["swing"]', modesOf('warhammer').join(','));
check('a battleaxe can only swing', JSON.stringify(modesOf('battleaxe')) === '["swing"]', modesOf('battleaxe').join(','));
check('a spear can only thrust (nothing to cut with)', JSON.stringify(modesOf('spear')) === '["thrust"]', modesOf('spear').join(','));
check('a rapier can only thrust', JSON.stringify(modesOf('rapier')) === '["thrust"]', modesOf('rapier').join(','));
check('a sword can do both', modesOf('shortsword').includes('swing') && modesOf('shortsword').includes('thrust'), modesOf('shortsword').join(','));
check('a halberd can do both (axe head plus spike)', modesOf('halberd').length === 2, modesOf('halberd').join(','));
check(
  'thrusts always reach further than swings on the same weapon',
  item('longsword').weapon!.melee.thrust!.reach > item('longsword').weapon!.melee.swing!.reach,
);
check(
  'swings can hit more targets than thrusts',
  item('longsword').weapon!.melee.swing!.maxTargets > item('longsword').weapon!.melee.thrust!.maxTargets,
);
check(
  'every thrust pierces more armour than every swing',
  [...['shortsword', 'longsword', 'halberd', 'dagger']].every((id) => {
    const { swing, thrust } = item(id).weapon!.melee;
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
    original.add('longsword');
    const restored = new Inventory();
    restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
    return restored.count('block_planks') === 120 && restored.count('longsword') === 1;
  })(),
);


section('low-poly item models');

// The art-direction rule: items are free low-poly geometry, not voxels. The
// previous models were assembled from axis-aligned boxes, which is why every
// weapon read as a stack of bricks.
//
// A box has exactly six distinct face normals. Counting the distinct normals of an
// assembled weapon is therefore a direct test of the claim: anything built out of
// cubes cannot get far past six, whatever its shape.
function distinctNormals(object: Object3D): number {
  const seen = new Set<string>();
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry?.getAttribute) return;
    const normal = geometry.getAttribute('normal');
    if (!normal) return;
    for (let i = 0; i < normal.count; i++) {
      // Quantised, so floating-point noise does not inflate the count.
      const key = [normal.getX(i), normal.getY(i), normal.getZ(i)]
        .map((v) => Math.round(v * 12) / 12)
        .join(',');
      seen.add(key);
    }
  });
  return seen.size;
}

function modelTriangleCount(object: Object3D): number {
  let total = 0;
  object.traverse((child) => {
    const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
    const position = geometry?.getAttribute?.('position');
    if (position) total += position.count / 3;
  });
  return total;
}

const swordNormals = distinctNormals(swordModel({ bladeLength: 0.76, bladeWidth: 0.085, guardSpan: 0.17 }));
check(
  'a sword is not built out of boxes',
  swordNormals > 30,
  `${swordNormals} distinct face normals (a cube has 6)`,
);

const maceNormals = distinctNormals(haftedModel(0.56, 'mace'));
check('a mace is not built out of boxes', maceNormals > 30, `${maceNormals} distinct face normals`);

const bowNormals = distinctNormals(bowModel().group);
check(
  'a bow is a curve, not a stepped staircase',
  bowNormals > 40,
  `${bowNormals} distinct face normals`,
);

// A blade has to come to a real point: the side faces converge on a single apex
// rather than stopping at a smaller rectangle stuck on the end.
{
  const length = 0.7;
  const geometry = bladeGeometry({ length, width: 0.08 });
  const position = geometry.getAttribute('position');
  let apexCount = 0;
  let maxZ = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    maxZ = Math.max(maxZ, z);
    if (Math.abs(z - length) < 1e-6 && Math.hypot(position.getX(i), position.getY(i)) < 1e-6) apexCount++;
  }
  check(
    'a blade converges on a real point',
    apexCount > 0 && Math.abs(maxZ - length) < 1e-6,
    `${apexCount} vertices at the apex, tip at z=${maxZ.toFixed(3)}`,
  );
}

// The blade must actually taper, or it is a ruler with a point on it.
{
  const geometry = bladeGeometry({ length: 0.7, width: 0.08 });
  const position = geometry.getAttribute('position');
  let nearWidth = 0;
  let farWidth = 0;
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    const x = Math.abs(position.getX(i));
    if (z < 0.1) nearWidth = Math.max(nearWidth, x);
    else if (z > 0.55 && z < 0.62) farWidth = Math.max(farWidth, x);
  }
  check(
    'a blade tapers towards the tip',
    farWidth < nearWidth * 0.8 && farWidth > 0,
    `half-width ${nearWidth.toFixed(3)} at the hilt, ${farWidth.toFixed(3)} near the tip`,
  );
}

// The torch is the item the player looks at most, and its flame has to be big
// enough to plausibly be the light source. The reported fault was a model too
// small and a flame too small to see.
{
  const torch = torchModel(1);
  const triangles = modelTriangleCount(torch.group);
  check('the torch is a real model, not a stick', triangles > 200, `${triangles} triangles`);

  // The ember anchor has to sit inside the flame. Emitting from a point outside it
  // is what made the sparks look detached from the fire.
  torch.group.updateMatrixWorld(true);
  const anchor = torch.flameAnchor.getWorldPosition(new Vector3());
  let inside = false;
  for (const layer of torch.flameLayers) {
    layer.geometry.computeBoundingBox();
    const box = layer.geometry.boundingBox!.clone().applyMatrix4(layer.matrixWorld);
    // A little slack: the anchor sits in the body of the flame, not at its centroid.
    box.expandByScalar(0.02);
    if (box.containsPoint(anchor)) inside = true;
  }
  check('torch embers are anchored inside the flame', inside, `anchor at ${anchor.toArray().map((v) => v.toFixed(3)).join(', ')}`);

  check('the torch flame has layers to animate', torch.flameLayers.length >= 3, `${torch.flameLayers.length} layers`);
}

// Shields are cover. A buckler is small, a tower shield is a wall, and the
// difference has to survive into the geometry.
{
  // The same scales the view model actually ships, so this measures what the
  // player sees rather than the model function in the abstract.
  const buckler = shieldModel('buckler', 1.1);
  const tower = shieldModel('tower', 1.25);
  buckler.updateMatrixWorld(true);
  tower.updateMatrixWorld(true);
  const span = (group: Object3D): number => {
    const box = new Box3().setFromObject(group);
    return box.max.y - box.min.y;
  };
  const bucklerSpan = span(buckler);
  const towerSpan = span(tower);
  check(
    'a tower shield is substantially bigger than a buckler',
    towerSpan > bucklerSpan * 1.5,
    `${bucklerSpan.toFixed(2)} vs ${towerSpan.toFixed(2)} units tall`,
  );
  // The old shield was 0.3 units tall before scaling and read as a dinner plate.
  check('a shield is big enough to be cover', towerSpan > 0.6, `${towerSpan.toFixed(2)} units tall`);
}

// ---------------------------------------------------------------- result



section('enemy creature models');

// Every enemy used to be the same five boxes recoloured, so the one thing a player
// most needs to read at a glance — what is running at me — carried no information
// beyond size and hue. These assert the silhouettes are genuinely different.
{
  const ids = [
    'goblin_grunt',
    'goblin_skirmisher',
    'bandit_archer',
    'giant_spider',
    'orc_brute',
    'skeleton_knight',
    'cultist',
    'ogre',
    'river_fish',
  ];
  const built = ids.map((id) => {
    const materials: never[] = [];
    const parts = buildCreature(id, { body: 0x445566, head: 0x667788, accent: 0x223344 }, materials as never);
    return { id, parts, triangles: modelTriangleCount(parts.group) };
  });

  check(
    'every archetype builds a model',
    built.every((b) => b.triangles > 0),
    built.map((b) => `${b.id}:${b.triangles}`).join(' '),
  );

  // Distinct triangle counts are a cheap proxy for distinct geometry: identical
  // models built from one shared template cannot differ here.
  const counts = new Set(built.map((b) => b.triangles));
  check(
    'archetypes do not share one body',
    counts.size >= built.length - 1,
    `${counts.size} distinct triangle counts across ${built.length} archetypes`,
  );

  const creatureNormals = distinctNormals(built.find((b) => b.id === 'orc_brute')!.parts.group);
  check(
    'a creature is not built out of boxes',
    creatureNormals > 30,
    `${creatureNormals} distinct face normals (a cube has 6)`,
  );

  // The animation contract: Enemy rotates these four pivots, so they must exist
  // whatever the creature's anatomy.
  check(
    'every creature supplies the four animated pivots',
    built.every((b) => b.parts.rightArm && b.parts.leftArm && b.parts.leftLeg && b.parts.rightLeg),
    'arms and legs present',
  );

  const spider = built.find((b) => b.id === 'giant_spider')!.parts;
  check('a spider walks on eight legs', spider.legs.length === 8, `${spider.legs.length} legs`);
  // Alternating phases, or the gait is eight legs moving as one.
  const phases = new Set(spider.legs.map((l) => Math.round(l.phase * 100)));
  check('spider legs are not all in step', phases.size > 1, `${phases.size} distinct gait phases`);

  // Proportions are a modelling decision. Normalising every creature to one height
  // stretched the spider — deliberately low and wide — onto man-length legs.
  const spiderHeight = built.find((b) => b.id === 'giant_spider')!.parts.height;
  const ogreHeight = built.find((b) => b.id === 'ogre')!.parts.height;
  check(
    'creatures keep their own proportions',
    spiderHeight < 1.2 && ogreHeight > 2,
    `spider ${spiderHeight} units, ogre ${ogreHeight} units`,
  );

  // Creatures face -Z, and their heads belong above the middle of the body.
  for (const id of ['goblin_grunt', 'orc_brute', 'skeleton_knight', 'ogre']) {
    const parts = built.find((b) => b.id === id)!.parts;
    parts.group.updateMatrixWorld(true);
    const box = new Box3().setFromObject(parts.group);
    check(
      `${id} stands above its own origin`,
      box.max.y > 1 && box.min.y > -0.35,
      `y from ${box.min.y.toFixed(2)} to ${box.max.y.toFixed(2)}`,
    );
  }
}



section('block textures');

// Every tile's UV rectangle must land inside its own padded cell. Getting this
// arithmetic wrong samples a neighbouring tile, which looks like the wrong texture
// rather than like a bug.
{
  // Iterating the exported list, not a hand-written one. A local list silently went
  // stale when tiles were renamed: the missing names became `undefined`, every UV
  // came out NaN, and the only symptom was untextured ground.
  let allInside = true;
  for (const tile of ALL_TILE_IDS) {
    const rect = tileRect(tile);
    if (rect.u0 < 0 || rect.v0 < 0 || rect.u1 > 1 || rect.v1 > 1) allInside = false;
    // The drawn area is exactly one tile wide, gutters excluded.
    const width = (rect.u1 - rect.u0) * ATLAS_PIXELS;
    const height = (rect.v1 - rect.v0) * ATLAS_PIXELS;
    if (Math.abs(width - TILE_PIXELS) > 0.001 || Math.abs(height - TILE_PIXELS) > 0.001) allInside = false;
  }
  check('every tile rectangle is inside the atlas and one tile wide', allInside);

  // Tiles must not touch: the gap between them is the gutter that stops mipmapping
  // averaging grass into dirt as the camera pulls back.
  const a = tileRect(ALL_TILE_IDS[0]);
  const b = tileRect(ALL_TILE_IDS[1]);
  const gap = (b.u0 - a.u1) * ATLAS_PIXELS;
  check(
    'tiles are separated by a mipmap gutter',
    gap >= TILE_PADDING * 2 - 0.001,
    `${gap.toFixed(1)}px between tiles, padding ${TILE_PADDING}px each side`,
  );
}

check(
  'a grass block uses three different tiles',
  new Set([
    tileForFace(Block.Grass, 'top', 0, 0),
    tileForFace(Block.Grass, 'side', 0, 0),
    tileForFace(Block.Grass, 'bottom', 0, 0),
  ]).size === 3,
  'turf on top, fringe on the sides, soil underneath',
);
check(
  'a log shows end grain on its cut faces and bark on its sides',
  tileForFace(Block.Wood, 'top', 0, 0) === tileForFace(Block.Wood, 'bottom', 0, 0) &&
    tileForFace(Block.Wood, 'top', 0, 0) !== tileForFace(Block.Wood, 'side', 0, 0),
  'rings above and below, bark around',
);
// Ground cover and foliage vary per block, or a dug pit and a canopy visibly
// checkerboard because every block carries the identical image.
{
  const sample = (block: number, face: 'top' | 'side') => {
    const seen = new Set<number>();
    for (let wx = 0; wx < 16; wx++) for (let wz = 0; wz < 16; wz++) seen.add(tileForFace(block, face, wx, wz));
    return seen;
  };
  const grass = sample(Block.Grass, 'top');
  const leaves = sample(Block.Leaves, 'side');
  check('grass varies between blocks', grass.size > 1, `${grass.size} variants across 256 positions`);
  check('leaves vary between blocks', leaves.size > 1, `${leaves.size} variants across 256 positions`);
  // And the choice must be stable, or a block would flicker as chunks reload.
  check(
    'a block always picks the same variant',
    tileForFace(Block.Grass, 'top', 7, -3) === tileForFace(Block.Grass, 'top', 7, -3),
    'variant is a pure function of world position',
  );
}
check(
  'untextured blocks sample the blank tile',
  tileForFace(Block.Stone, 'top', 0, 0) === Tile.Blank && tileForFace(Block.DungeonBrick, 'side', 0, 0) === Tile.Blank,
  'so adding a texture to one block cannot disturb the rest of the world',
);

// The mesher has to emit UVs, and has to write greyscale shading for textured blocks
// so the texture supplies the hue. Both are invisible when wrong — a missing UV
// attribute or a doubled-up tint both just look like the flat world that came before.
{
  const chunk = new Chunk(0, 0);
  chunk.voxels[voxelIndex(4, 4, 4)] = Block.Grass;
  chunk.voxels[voxelIndex(6, 4, 4)] = Block.Stone;
  const { opaque } = meshChunk(chunk, () => Block.Air);

  const position = opaque?.getAttribute('position');
  const uv = opaque?.getAttribute('uv');
  check(
    'the mesher emits a UV for every vertex',
    !!uv && !!position && uv.count === position.count,
    `${uv?.count ?? 0} uvs for ${position?.count ?? 0} vertices`,
  );

  // Grass vertices are greyscale; stone keeps its tint. Identified by which tile the
  // UV points at rather than by vertex index, which would depend on emit order.
  const color = opaque!.getAttribute('color');
  // Ask the same question the mesher does, rather than assuming which variant a
  // block at this position lands on.
  const grassTop = tileRect(tileForFace(Block.Grass, 'top', 4, 4));
  let greyscaleGrass = true;
  let grassVertices = 0;
  let tintedStone = false;
  for (let i = 0; i < uv!.count; i++) {
    const u = uv!.getX(i);
    const v = uv!.getY(i);
    const inGrassTop = u >= grassTop.u0 - 1e-6 && u <= grassTop.u1 + 1e-6 && v >= grassTop.v0 - 1e-6 && v <= grassTop.v1 + 1e-6;
    const r = color.getX(i);
    const g = color.getY(i);
    const b = color.getZ(i);
    if (inGrassTop) {
      grassVertices++;
      if (Math.abs(r - g) > 1e-6 || Math.abs(g - b) > 1e-6) greyscaleGrass = false;
    }
    if (Math.abs(r - g) > 0.02 || Math.abs(g - b) > 0.02) tintedStone = true;
  }
  check(
    'a textured block writes greyscale shading, letting the texture carry the colour',
    grassVertices > 0 && greyscaleGrass,
    `${grassVertices} grass-top vertices, all greyscale`,
  );
  check(
    'an untextured block still writes its own tint',
    tintedStone,
    'stone keeps the colour it had before textures existed',
  );
}

check(
  'the atlas is only built where there is a canvas to draw on',
  tryCreateBlockAtlas() === null,
  'null under Node, so the geometry tests do not need a DOM',
);



section('texture orientation');

// The invariant: on a side face, the texture's vertical axis must map to world Y, the
// same way up. Grass is drawn at the top of its tile's canvas, so if this is inverted
// the turf appears underneath the soil — and bark furrows, drawn down the canvas, come
// out running around the trunk instead of along it.
//
// `flipY` is true by default on a THREE texture, so canvas row 0 becomes v = 1.
// `tileRect` encodes that: v1 is the canvas *top* edge.
{
  const chunk = new Chunk(0, 0);
  chunk.voxels[voxelIndex(8, 8, 8)] = Block.Grass;
  const { opaque } = meshChunk(chunk, () => Block.Air);
  const position = opaque!.getAttribute('position');
  const normal = opaque!.getAttribute('normal');
  const uv = opaque!.getAttribute('uv');
  const rect = tileRect(tileForFace(Block.Grass, 'side', 8, 8));

  let sideFaces = 0;
  let correctlyOriented = 0;
  // Faces are emitted as runs of four vertices.
  for (let i = 0; i + 3 < position.count; i += 4) {
    if (Math.abs(normal.getY(i)) > 0.5) continue; // top or bottom face
    sideFaces++;

    let topV = -Infinity;
    let bottomV = Infinity;
    let topY = -Infinity;
    let bottomY = Infinity;
    for (let k = 0; k < 4; k++) {
      const y = position.getY(i + k);
      const v = uv.getY(i + k);
      if (y > topY) { topY = y; topV = v; }
      if (y < bottomY) { bottomY = y; bottomV = v; }
    }
    // The upper edge of the quad must sample the upper edge of the tile.
    if (Math.abs(topV - rect.v1) < 1e-6 && Math.abs(bottomV - rect.v0) < 1e-6) correctlyOriented++;
  }

  check(
    'side faces map the texture the same way up as the world',
    sideFaces === 4 && correctlyOriented === sideFaces,
    `${correctlyOriented} of ${sideFaces} side faces upright`,
  );
}

// Top faces must not be mirrored relative to each other either, or adjacent blocks
// disagree about which way the grain runs.
{
  const chunk = new Chunk(0, 0);
  chunk.voxels[voxelIndex(4, 8, 4)] = Block.Wood;
  chunk.voxels[voxelIndex(6, 8, 4)] = Block.Wood;
  const { opaque } = meshChunk(chunk, () => Block.Air);
  const normal = opaque!.getAttribute('normal');
  const uv = opaque!.getAttribute('uv');

  // Collect the UV winding of every +Y face and require they all agree.
  const windings = new Set<string>();
  for (let i = 0; i + 3 < normal.count; i += 4) {
    if (normal.getY(i) < 0.5) continue;
    const du = uv.getX(i + 1) - uv.getX(i);
    const dv = uv.getY(i + 3) - uv.getY(i);
    windings.add(`${Math.sign(du)},${Math.sign(dv)}`);
  }
  check(
    'every top face lays its texture the same way round',
    windings.size === 1,
    `${windings.size} distinct windings across ${[...windings].join(' ')}`,
  );
}


// ---------------------------------------------------------------- gesture melee

section('melee gesture classifier');

{
  // The classifier works in y-up screen space. Every direction is checked at several
  // magnitudes, because the sector it lands in must not depend on how hard the player
  // flicked — only on where.
  const cases: [number, number, AttackDirection][] = [
    [1, 0, 'right'],
    [1, 1, 'upRight'],
    [0, 1, 'up'],
    [-1, 1, 'upLeft'],
    [-1, 0, 'left'],
    [-1, -1, 'downLeft'],
    [0, -1, 'down'],
    [1, -1, 'downRight'],
  ];
  const magnitudes = [8, 26, 120, 1000];

  let allCorrect = true;
  const failures: string[] = [];
  for (const [ux, uy, expected] of cases) {
    const length = Math.hypot(ux, uy);
    for (const magnitude of magnitudes) {
      const got = classifyGesture((ux / length) * magnitude, (uy / length) * magnitude);
      if (got !== expected) {
        allCorrect = false;
        failures.push(`${expected}@${magnitude}->${got}`);
      }
    }
  }
  check(
    'all eight directions classify correctly at every magnitude',
    allCorrect,
    allCorrect ? `${cases.length * magnitudes.length} combinations` : failures.join(' '),
  );
}

// The dead zone is what makes a plain click still mean something. Anything shorter
// than a deliberate flick is a thrust, whichever way it happened to drift.
check(
  'movement inside the dead zone is a thrust',
  [
    [0, 0],
    [1, 0],
    [0, -3],
    [GESTURE_CONFIG.deadZone - 0.01, 0],
    [3, 3],
  ].every(([x, y]) => classifyGesture(x, y) === 'thrust'),
);
check(
  'movement just past the dead zone is a direction',
  classifyGesture(GESTURE_CONFIG.deadZone + 0.5, 0) === 'right',
);

// Sector boundaries. Sectors are 45 degrees wide, so the edge between 'right' and
// 'upRight' sits at 22.5; either side of it must resolve the obvious way.
{
  const atAngle = (deg: number, magnitude = 40): AttackDirection => {
    const rad = (deg * Math.PI) / 180;
    return classifyGesture(Math.cos(rad) * magnitude, Math.sin(rad) * magnitude);
  };
  check('just below a sector boundary stays in the lower sector', atAngle(21) === 'right', atAngle(21));
  check('just above a sector boundary moves to the upper sector', atAngle(24) === 'upRight', atAngle(24));
  check('the sector centres are exact', atAngle(45) === 'upRight' && atAngle(90) === 'up', `${atAngle(45)}/${atAngle(90)}`);
  check(
    'the wrap at 180 degrees is handled',
    atAngle(179) === 'left' && atAngle(-179) === 'left',
    `${atAngle(179)}/${atAngle(-179)}`,
  );
}

// Hysteresis. A near-horizontal swing wobbles across the boundary into 'upLeft', and
// without stickiness the attack chosen would be a coin toss frame to frame.
{
  const rad = (150 * Math.PI) / 180;
  const x = Math.cos(rad) * 40;
  const y = Math.sin(rad) * 40;
  check(
    'a wobble past the boundary keeps the latched direction',
    classifyGesture(x, y, GESTURE_CONFIG, 'left') === 'left',
    `150 degrees with 'left' latched -> ${classifyGesture(x, y, GESTURE_CONFIG, 'left')}`,
  );
  check(
    'the same wobble with nothing latched follows the angle',
    classifyGesture(x, y) === 'upLeft',
    classifyGesture(x, y),
  );
  // Stickiness must not be unbreakable, or a genuine change of stroke is ignored.
  check(
    'a decisive change of direction overrides the latch',
    classifyGesture(0, 40, GESTURE_CONFIG, 'left') === 'up',
    classifyGesture(0, 40, GESTURE_CONFIG, 'left'),
  );
}

section('melee gesture tracker');

{
  // Commits on the threshold, without waiting for the button to come up. This is the
  // difference between a weapon and a menu.
  const tracker = new GestureTracker();
  tracker.begin();
  const perFrame = GESTURE_CONFIG.commitThreshold / GESTURE_CONFIG.sensitivity / 4;
  let committed: AttackDirection | null = null;
  let frames = 0;
  for (let i = 0; i < 10 && !committed; i++) {
    committed = tracker.sample(-perFrame, 0, 1 / 60);
    frames++;
  }
  check('a sustained flick commits before release', committed === 'left', `${committed} after ${frames} frames`);
}

{
  // A quick click: button down, nothing moved, button up.
  const tracker = new GestureTracker();
  tracker.begin();
  tracker.sample(0, 0, 1 / 60);
  check('a click with no movement releases as a thrust', tracker.release() === 'thrust');
}

{
  // Window expiry. Drifting the mouse slowly must never accumulate into an attack,
  // or simply turning to look around during a fight would start swinging.
  const tracker = new GestureTracker();
  tracker.begin();
  // Each step is deliberately smaller than the dead zone, so no single frame is a
  // gesture — but forty of them summed would be four times the commit threshold. Each
  // frame is longer than the whole sample window, so no two are ever counted together.
  const drift = (GESTURE_CONFIG.deadZone / 2) / GESTURE_CONFIG.sensitivity;
  let everCommitted = false;
  for (let i = 0; i < 40; i++) {
    if (tracker.sample(drift, 0, GESTURE_CONFIG.sampleWindow * 1.5)) everCommitted = true;
  }
  check('movement spread beyond the sample window never commits', !everCommitted);
  check(
    'and its accumulated magnitude stays inside the dead zone',
    tracker.snapshot().magnitude < GESTURE_CONFIG.deadZone,
    `magnitude ${tracker.snapshot().magnitude.toFixed(2)}`,
  );
  check('so releasing it is a thrust', tracker.release() === 'thrust');
}

{
  // Raw deltas arrive y-down from the browser; the tracker flips them once on the way
  // in. Getting this wrong silently inverts every vertical stroke.
  const tracker = new GestureTracker();
  tracker.begin();
  const push = GESTURE_CONFIG.commitThreshold / GESTURE_CONFIG.sensitivity;
  const committed = tracker.sample(0, -push, 1 / 60);
  check('a negative mouse dy is an uppercut', committed === 'up', String(committed));
}

{
  const tracker = new GestureTracker();
  check('an idle tracker reports nothing', !tracker.active && tracker.snapshot().charge === 0);
  tracker.begin();
  tracker.sample(-GESTURE_CONFIG.deadZone / GESTURE_CONFIG.sensitivity - 1, 0, 1 / 60);
  const snapshot = tracker.snapshot();
  check(
    'an in-progress gesture reports its direction and charge',
    snapshot.active && snapshot.direction === 'left' && snapshot.charge > 0 && snapshot.charge < 1,
    `${snapshot.direction} at ${snapshot.charge.toFixed(2)}`,
  );
  tracker.reset();
  check('reset stops the capture', !tracker.active);
}

section('weapon geometry governs gestures');

{
  const sword = item('shortsword').weapon!.melee;
  const mace = item('mace').weapon!.melee;
  const rapier = item('rapier').weapon!.melee;
  const fists = item('fists').weapon!.melee;
  const grenade = item('grenade').weapon!.melee;

  const left = resolveDirectionalAttack(sword, 'left')!;
  check(
    'a sword slashes when asked to slash',
    left.mode === 'swing' && left.direction === 'left' && !left.fellBack,
  );
  const poke = resolveDirectionalAttack(sword, 'thrust')!;
  check('a sword thrusts when asked to thrust', poke.mode === 'thrust' && !poke.fellBack);

  // A mace has no point. Asking it to thrust gets a chop, and the player is told.
  const maceThrust = resolveDirectionalAttack(mace, 'thrust')!;
  check(
    'a thrust with a mace falls back to a swing',
    maceThrust.mode === 'swing' && maceThrust.fellBack && maceThrust.requested === 'thrust',
    `${maceThrust.requested} -> ${maceThrust.direction}`,
  );
  check(
    'and the fallback keeps the gesture pointing at the target',
    maceThrust.direction === THRUST_FALLBACK_DIRECTION,
    maceThrust.direction,
  );

  // A rapier has no edge, so every directional gesture becomes a thrust.
  const rapierSlash = resolveDirectionalAttack(rapier, 'upLeft')!;
  check(
    'a slash with a rapier falls back to a thrust',
    rapierSlash.mode === 'thrust' && rapierSlash.direction === 'thrust' && rapierSlash.fellBack,
    `${rapierSlash.requested} -> ${rapierSlash.direction}`,
  );
  check(
    'every direction still produces an attack on a thrust-only weapon',
    (['left', 'right', 'up', 'down', 'upLeft', 'upRight', 'downLeft', 'downRight'] as AttackDirection[]).every(
      (d) => resolveDirectionalAttack(rapier, d)?.mode === 'thrust',
    ),
  );

  check(
    'bare fists swing in every direction',
    (['left', 'up', 'downRight', 'thrust'] as AttackDirection[]).every((d) => !!resolveDirectionalAttack(fists, d)),
  );
  check('a weapon with no melee modes at all resolves to nothing', resolveDirectionalAttack(grenade, 'left') === null);
}

section('direction modifiers');

{
  const base = item('longsword').weapon!.melee.swing!;
  const left = applyDirectionModifiers(base, 'left');
  const up = applyDirectionModifiers(base, 'up');
  const down = applyDirectionModifiers(base, 'down');
  const diagonal = applyDirectionModifiers(base, 'upRight');

  check(
    'horizontal cuts are faster than the base swing',
    left.windup < base.windup && left.recovery < base.recovery,
    `windup ${base.windup.toFixed(2)} -> ${left.windup.toFixed(2)}`,
  );
  check('horizontal cuts sweep wider', left.arcDeg > base.arcDeg, `${base.arcDeg} -> ${left.arcDeg}`);
  check(
    'vertical cuts hit harder but slower',
    up.damage > left.damage && up.windup > left.windup && down.damage > left.damage && down.windup > left.windup,
    `left ${left.damage.toFixed(1)}/${left.windup.toFixed(2)} vs up ${up.damage.toFixed(1)}/${up.windup.toFixed(2)}`,
  );
  check('vertical cuts are narrow', up.arcDeg < base.arcDeg && down.arcDeg < base.arcDeg);
  check(
    'diagonals sit between horizontal and vertical',
    diagonal.damage > left.damage && diagonal.damage < up.damage,
    `${left.damage.toFixed(1)} < ${diagonal.damage.toFixed(1)} < ${up.damage.toFixed(1)}`,
  );
  check(
    'a thrust is left exactly as the weapon defines it',
    (() => {
      const thrustBase = item('longsword').weapon!.melee.thrust!;
      const applied = applyDirectionModifiers(thrustBase, 'thrust');
      return (
        applied.damage === thrustBase.damage &&
        applied.windup === thrustBase.windup &&
        applied.armorPierce === thrustBase.armorPierce &&
        applied.arcDeg === thrustBase.arcDeg
      );
    })(),
  );
  check('stamina stays a whole number', Number.isInteger(up.stamina) && up.stamina >= 1, String(up.stamina));
  check(
    'armour pierce never exceeds total',
    (['down', 'downLeft', 'thrust'] as AttackDirection[]).every(
      (d) => applyDirectionModifiers(item('rapier').weapon!.melee.thrust!, d).armorPierce <= 1,
    ),
  );
}

// Every stroke must have a screen vector, and only the thrust may be the zero vector —
// the hit-cone bias and the view model both read this table.
check(
  'every direction has a screen vector, and only the thrust is centred',
  (Object.keys(DIRECTION_VECTOR) as AttackDirection[]).every((d) => {
    const [x, y] = DIRECTION_VECTOR[d];
    const zero = x === 0 && y === 0;
    return d === 'thrust' ? zero : !zero && Math.abs(Math.hypot(x, y) - 1) < 1e-9;
  }),
);



// ------------------------------------------------------- point-buy creation

section('point-buy character creation');

{
  const fresh = createPointBuyState();

  check(
    'every ability starts at the baseline of 8',
    ABILITY_KEYS.every((key) => fresh.scores[key] === POINT_BUY.baseline) && POINT_BUY.baseline === 8,
    JSON.stringify(fresh.scores),
  );
  check('a fresh build has the whole bank unspent', fresh.remaining === 27 && fresh.spent === 0, `${fresh.remaining} left`);
  check('there are six abilities', ABILITY_KEYS.length === 6, ABILITY_KEYS.join(', '));

  // The 5e cost table, asserted as totals from the baseline. These are the numbers
  // the whole system turns on, so they are checked explicitly rather than inferred.
  check(
    'the scaled cost table matches 5e',
    costOfScore(8) === 0 &&
      costOfScore(9) === 1 &&
      costOfScore(10) === 2 &&
      costOfScore(11) === 3 &&
      costOfScore(12) === 4 &&
      costOfScore(13) === 5 &&
      costOfScore(14) === 7 &&
      costOfScore(15) === 9,
    [8, 9, 10, 11, 12, 13, 14, 15].map((s) => `${s}:${costOfScore(s)}`).join(' '),
  );
  check(
    'the steps up to 13 cost one point each',
    [8, 9, 10, 11, 12].every((from) => costToRaise(from) === 1),
    [8, 9, 10, 11, 12].map((f) => `${f}->${f + 1}:${costToRaise(f)}`).join(' '),
  );
  check('13 -> 14 costs two points', costToRaise(13) === 2);
  check('14 -> 15 costs two points', costToRaise(14) === 2);
  check('there is no step above 15', costToRaise(15) === null);

  // Raising to 14 must take 2 out of the bank, not 1. An off-by-one here would let
  // a player afford a spread the rules forbid.
  check(
    'raising a score to 14 draws two points from the bank',
    (() => {
      let s = createPointBuyState();
      for (let i = 0; i < 5; i++) s = increase(s, 'str');
      const at13 = s.remaining;
      s = increase(s, 'str');
      return s.scores.str === 14 && at13 - s.remaining === 2;
    })(),
  );

  check(
    'a score cannot be raised past 15 during creation',
    (() => {
      let s = createPointBuyState();
      for (let i = 0; i < 12; i++) s = increase(s, 'dex');
      return s.scores.dex === 15 && !canIncrease(s, 'dex') && POINT_BUY.manualMax === 15;
    })(),
  );

  check(
    'a score cannot be pushed below the baseline',
    (() => {
      const s = decrease(createPointBuyState(), 'con');
      return s.scores.con === 8 && !canDecrease(createPointBuyState(), 'con');
    })(),
  );

  check(
    'spending is refused once the bank cannot cover the next step',
    (() => {
      // 15/15/14 is 25 points, leaving 2 — enough for a 9 and a 10, but not for a
      // step that costs 2 on an ability already at 13.
      let s = createPointBuyState();
      for (let i = 0; i < 7; i++) s = increase(s, 'str');
      for (let i = 0; i < 7; i++) s = increase(s, 'dex');
      for (let i = 0; i < 5; i++) s = increase(s, 'con');
      // str 15, dex 15, con 13 => 9 + 9 + 5 = 23, 4 left.
      for (let i = 0; i < 4; i++) s = increase(s, 'int');
      // int 12 costs 4 => bank empty.
      return s.remaining === 0 && !canIncrease(s, 'wis') && increase(s, 'wis').scores.wis === 8;
    })(),
  );

  check(
    'an illegal move returns the state untouched',
    (() => {
      const s = createPointBuyState();
      return decrease(s, 'cha') === s;
    })(),
  );

  check(
    'lowering refunds exactly what the step cost',
    (() => {
      let s = createPointBuyState();
      for (let i = 0; i < 6; i++) s = increase(s, 'wis');
      const at14 = s.remaining;
      s = decrease(s, 'wis');
      return s.scores.wis === 13 && s.remaining - at14 === 2;
    })(),
  );

  check(
    'increase and decrease are exact inverses',
    (() => {
      let s = createPointBuyState();
      for (const key of ABILITY_KEYS) for (let i = 0; i < 4; i++) s = increase(s, key);
      const spentMidway = s.spent;
      for (const key of ABILITY_KEYS) for (let i = 0; i < 4; i++) s = decrease(s, key);
      return spentMidway === 24 && s.spent === 0 && s.remaining === 27;
    })(),
  );

  check('the state is immutable — a move returns a new object', (() => {
    const before = createPointBuyState();
    const after = increase(before, 'str');
    return before.scores.str === 8 && after.scores.str === 9 && before !== after;
  })());

  // "Complete" means the bank is empty, since leftover points have nothing to buy.
  check('a fresh build is not complete', !isComplete(fresh));
  check(
    'a build with points left over is incomplete',
    (() => {
      let s = createPointBuyState();
      for (let i = 0; i < 5; i++) s = increase(s, 'str');
      return !isComplete(s) && validationIssues(s).some((i) => i.kind === 'points-remaining');
    })(),
  );
  check(
    'spending all 27 points completes the build',
    (() => {
      // Three abilities at the cap: 9 + 9 + 9 = 27 exactly.
      let s = createPointBuyState();
      for (const key of ['str', 'dex', 'con'] as const) for (let i = 0; i < 7; i++) s = increase(s, key);
      return s.scores.str === 15 && s.remaining === 0 && isComplete(s);
    })(),
  );

  check(
    'resetting returns to the baseline with a full bank',
    (() => {
      let s = createPointBuyState();
      for (let i = 0; i < 7; i++) s = increase(s, 'int');
      const back = reset();
      return s.scores.int === 15 && back.scores.int === 8 && back.remaining === 27;
    })(),
  );

  // The suggested spread is easy to get wrong by hand because of the doubled steps.
  check(
    'the suggested allocation spends the bank exactly',
    (() => {
      const s = suggestedAllocation('str', 'con', 'dex');
      return s.remaining === 0 && isComplete(s) && s.scores.str === 15 && s.scores.con === 15 && s.scores.dex === 14;
    })(),
    `${JSON.stringify(suggestedAllocation('str', 'con', 'dex').scores)}`,
  );
  check(
    'the suggested allocation refuses duplicate picks',
    suggestedAllocation('str', 'str', 'dex').remaining === 27,
  );

  // 5e modifiers, which are what actually reach the rest of the game.
  check(
    'ability modifiers follow the 5e curve',
    abilityModifier(8) === -1 &&
      abilityModifier(9) === -1 &&
      abilityModifier(10) === 0 &&
      abilityModifier(11) === 0 &&
      abilityModifier(12) === 1 &&
      abilityModifier(13) === 1 &&
      abilityModifier(14) === 2 &&
      abilityModifier(15) === 2 &&
      abilityModifier(20) === 5,
    [8, 10, 12, 14, 15, 20].map((s) => `${s}:${abilityModifier(s)}`).join(' '),
  );
  check(
    'an odd score buys no modifier over the even one below it',
    abilityModifier(13) === abilityModifier(12) && abilityModifier(15) === abilityModifier(14),
  );

  // Loading untrusted scores must not produce NaN budgets.
  check(
    'corrupt scores are clamped rather than trusted',
    (() => {
      const s = sanitizeScores({ str: 900, dex: -40, con: 12.6, int: Number.NaN, wis: undefined });
      return (
        s.scores.str === 15 &&
        s.scores.dex === 8 &&
        s.scores.con === 13 &&
        s.scores.int === 8 &&
        s.scores.wis === 8 &&
        s.scores.cha === 8 &&
        Number.isFinite(s.remaining)
      );
    })(),
  );
  check(
    'a missing allocation sanitises to the baseline',
    (() => {
      const s = sanitizeScores(null);
      return s.remaining === 27 && ABILITY_KEYS.every((k) => s.scores[k] === 8);
    })(),
  );
  check(
    'an over-budget allocation is reported, not silently accepted',
    (() => {
      const s = sanitizeScores({ str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 });
      return s.spent === 54 && !isComplete(s) && validationIssues(s).some((i) => i.kind === 'over-budget');
    })(),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL UNIT CHECKS PASSED');
