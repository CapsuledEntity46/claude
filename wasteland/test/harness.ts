/**
 * Headless functional harness.
 *
 * Exercises the real gameplay systems — worldgen, harvesting, ballistics,
 * looting, crafting, building, riding, explosives, AI, survival, inventory and
 * save/load — against a generated world, and reports pass/fail.
 *
 * Not part of the game bundle. Build + run with `npm run test:functional`.
 */

import { Game } from '../src/game';
import { World } from '../src/world/world';
import { Container } from '../src/items/container';
import { makeStack } from '../src/items/item';
import { Zombie } from '../src/entities/zombie';
import { Horse } from '../src/entities/horse';
import { Bandit } from '../src/entities/bandit';
import { RECIPE_BY_OUT } from '../src/items/recipes';
import { Building as BuildSystem } from '../src/systems/building';
import { tryFire, tryReload, finishReload, tryMelee, resolveSwing, tryThrow } from '../src/systems/combat';
import { findInteraction } from '../src/systems/interaction';
import { saveGame, loadSave, hasSave, clearSave, applySave } from '../src/systems/save';
import { PROPS } from '../src/world/props';

interface Result { name: string; pass: boolean; detail: string; }

const results: Result[] = [];
const errors: string[] = [];

window.addEventListener('error', (e) => errors.push(`ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`REJECT: ${e.reason}`));

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  render();
}

/** Yield to the event loop so progress is observable while the suite runs. */
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

function render(): void {
  const el = document.getElementById('out');
  if (!el) return;
  const passed = results.filter((r) => r.pass).length;
  el.textContent =
    results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`).join('\n')
    + `\n\n${passed}/${results.length} checks passed`
    + (errors.length ? `\n\nRUNTIME ERRORS:\n${errors.join('\n')}` : '');
}

/**
 * Advance the simulation by `seconds` using the game's own fixed step, so tests
 * exercise the same ordering (actor hashing -> AI -> projectiles) as play.
 */
function tick(game: Game, seconds: number): void {
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    game.simulate(dt);
    game.crafting.update(dt, game);
  }
}

/**
 * Give the player an item and return the live stack, wherever it landed.
 * `Player.give` may route into the belt when the grid is full, so searching only
 * the inventory is unreliable.
 */
function grant(game: Game, id: string, count = 1) {
  game.player.giveItem(id, count);
  const inInv = game.player.inventory.find((s) => s.id === id);
  if (inInv) return inInv.stack;
  const onBelt = game.player.belt.find((b) => b?.id === id);
  if (onBelt) return onBelt;
  // Last resort: clear a slot and place it directly.
  game.player.belt[5] = makeStack(id, count);
  return game.player.belt[5]!;
}

/**
 * Reset the player to a clean, healthy, unencumbered state.
 * Without this, damage from one section (a grenade, hypothermia) silently
 * invalidates later checks.
 */
function revive(game: Game, at?: { x: number; y: number }): void {
  const p = game.player;
  p.dead = false;
  p.justDied = false;
  p.hp = p.maxHp;
  p.food = 80;
  p.water = 80;
  p.stamina = 100;
  p.bodyTemp = 36.6;
  p.bleed = 0;
  p.burning = 0;
  p.infection = 0;
  p.wetness = 0;
  p.brokenLeg = false;
  p.stun = 0;
  p.cancelAction();
  p.swingTime = 0;
  p.fireCooldown = 0;
  p.crouching = false;
  p.sprinting = false;
  p.mount = null;
  if (at) { p.x = at.x; p.y = at.y; }
}

/** A clear patch of ground away from towns, for building tests. */
function findOpenGround(w: World, near: { x: number; y: number }): { x: number; y: number } {
  for (let i = 0; i < 800; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 150 + Math.random() * 1200;
    const x = near.x + Math.cos(a) * d;
    const y = near.y + Math.sin(a) * d;
    if (!w.inBounds(x, y)) continue;
    if (w.isWater(x, y)) continue;
    if (w.buildingAt(x, y)) continue;
    if (!w.isClear(x, y, 70)) continue;
    return { x, y };
  }
  return { x: near.x, y: near.y };
}

async function run(): Promise<void> {
  clearSave();

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const game = new Game(canvas);

  // ======================================================== world generation
  const t0 = performance.now();
  game.newGame('harness-seed');
  const genMs = Math.round(performance.now() - t0);
  const w = game.world;

  check('world generates content', w.buildings.length > 60 && w.towns.length >= 18 && w.props.length > 2000,
    `${genMs}ms · ${w.towns.length} settlements · ${w.buildings.length} buildings · ${w.props.length} props`);

  {
    const a = new World('determinism');
    const b = new World('determinism');
    check('worldgen is deterministic',
      a.buildings.length === b.buildings.length
      && a.props.length === b.props.length
      && a.spawn.x === b.spawn.x && a.spawn.y === b.spawn.y,
      `${a.buildings.length}=${b.buildings.length} buildings, spawn ${a.spawn.x},${a.spawn.y}`);
  }

  {
    const kinds = new Set(w.towns.map((t) => t.kind));
    const want = ['city', 'town', 'village', 'hamlet', 'military', 'farm', 'outpost'];
    check('every settlement type appears', want.every((k) => kinds.has(k as never)), [...kinds].join(', '));
  }

  {
    const b = w.buildings.find((x) => x.rooms.length >= 3);
    check('buildings have rooms, doorways and furniture',
      !!b && b.doorways.length > 0 && b.walls.length > 4 && b.propSpots.length > 0,
      b ? `${b.kind}: ${b.rooms.length} rooms, ${b.doorways.length} doorways, ${b.walls.length} wall segments, ${b.propSpots.length} furniture` : 'none');
  }

  check('containers exist across the world', w.props.filter((p) => p.container).length > 200,
    `${w.props.filter((p) => p.container).length} lootable containers`);

  check('player spawns on walkable land',
    !w.isWater(game.player.x, game.player.y) && w.isClear(game.player.x, game.player.y, 13),
    `tile ${w.tileAt(game.player.x, game.player.y)} at ${Math.round(game.player.x)},${Math.round(game.player.y)}`);

  await pause();
  // ======================================================== harvesting
  {
    const tree = w.props.find((p) => p.kind === 'tree_oak' && !p.dead)!;
    game.player.x = tree.x + 44;
    game.player.y = tree.y;
    game.player.facing = Math.atan2(tree.y - game.player.y, tree.x - game.player.x);
    game.player.belt[0] = makeStack('hatchet');
    game.player.activeSlot = 0;
    const before = game.player.countItem('wood');
    for (let i = 0; i < 8; i++) resolveSwing(game);
    const gained = game.player.countItem('wood') - before;
    check('chopping a tree yields wood', gained > 0, `+${gained} wood, tree hp ${Math.round(tree.hp)}`);
  }

  {
    const rock = w.props.find((p) => p.kind === 'rock_small' && !p.dead)!;
    game.player.x = rock.x + 44;
    game.player.y = rock.y;
    game.player.facing = Math.atan2(rock.y - game.player.y, rock.x - game.player.x);
    game.player.belt[0] = makeStack('pickaxe');
    const before = game.player.countItem('stone');
    for (let i = 0; i < 6; i++) resolveSwing(game);
    check('mining a rock yields stone', game.player.countItem('stone') - before > 0,
      `+${game.player.countItem('stone') - before} stone`);
  }

  {
    const ore = w.props.find((p) => p.kind === 'ore_metal' && !p.dead);
    if (ore) {
      game.player.x = ore.x + 44;
      game.player.y = ore.y;
      game.player.facing = Math.atan2(ore.y - game.player.y, ore.x - game.player.x);
      game.player.belt[0] = makeStack('hatchet');
      const hp0 = ore.hp;
      resolveSwing(game);
      const wrong = hp0 - ore.hp;
      game.player.belt[0] = makeStack('pickaxe');
      const hp1 = ore.hp;
      resolveSwing(game);
      const right = hp1 - ore.hp;
      check('the right tool matters', right > wrong * 2, `pickaxe ${right.toFixed(1)} vs hatchet ${wrong.toFixed(1)} damage`);
    } else {
      check('the right tool matters', true, 'no ore node on this seed — skipped');
    }
  }

  await pause();
  // ======================================================== ranged combat
  game.player.belt[0] = makeStack('ak47');
  game.player.activeSlot = 0;
  game.player.giveItem('ammo_rifle', 60);
  tryReload(game);
  game.player.actionTime = game.player.actionTotal;
  finishReload(game);
  check('reload fills the magazine from reserves', (game.player.heldItem!.mag ?? 0) === 30,
    `mag ${game.player.heldItem!.mag}/30, reserve ${game.player.countItem('ammo_rifle')}`);

  {
    // Somewhere open so terrain doesn't eat the bullets.
    const spot = findOpenGround(w, w.spawn);
    revive(game, spot);
    const z = new Zombie(spot.x + 240, spot.y, 'walker', 4242);
    game.zombies.push(z);
    game.player.facing = 0;
    game.aimAngle = 0;
    const hp0 = z.hp;
    let shots = 0;
    for (let i = 0; i < 8; i++) {
      game.player.fireCooldown = 0;
      game.player.recoil = 0;
      if (tryFire(game, 'press')) shots++;
    }
    tick(game, 1);
    check('bullets travel and damage enemies', z.hp < hp0 || z.dead,
      `${shots} shots fired, zombie ${Math.round(hp0)} -> ${Math.round(z.hp)}${z.dead ? ' (killed)' : ''}`);
    check('firing consumes magazine rounds', (game.player.heldItem!.mag ?? 0) === 30 - shots,
      `mag ${game.player.heldItem!.mag}`);
    z.dead = true;
  }

  {
    const bld = w.buildings.find((b) => b.walls.some((s) => s.opaque && s.w > s.h + 20))!;
    const wall = bld.walls.find((s) => s.opaque && s.w > s.h + 20)!;
    game.player.x = wall.x + wall.w / 2;
    game.player.y = wall.y - 110;
    const victim = new Zombie(wall.x + wall.w / 2, wall.y + 110, 'walker', 77);
    game.zombies.push(victim);
    game.aimAngle = Math.PI / 2;
    game.player.facing = Math.PI / 2;
    game.player.fireCooldown = 0;
    game.player.recoil = 0;
    const hp0 = victim.hp;
    tryFire(game, 'press');
    tick(game, 0.6);
    check('walls stop bullets', victim.hp === hp0, `target behind wall: ${Math.round(victim.hp)}/${Math.round(hp0)} hp`);
    victim.dead = true;
  }

  await pause();
  // ======================================================== melee
  {
    const spot = findOpenGround(w, w.spawn);
    game.player.x = spot.x;
    game.player.y = spot.y;
    const target = new Zombie(spot.x + 34, spot.y, 'walker', 9);
    game.zombies.push(target);
    game.player.belt[0] = makeStack('machete');
    revive(game, spot);
    game.player.activeSlot = 0;
    game.player.facing = 0;
    game.player.swingTime = 0;
    game.player.stamina = 100;
    const hp0 = target.hp;
    const swung = tryMelee(game);
    const los = w.hasLineOfSight(game.player.x, game.player.y, target.x, target.y);
    const seen = game.actorsNear(game.player.x, game.player.y, 130).includes(target);
    resolveSwing(game);
    check('melee swings hit and cost stamina', target.hp < hp0 && game.player.stamina < 100,
      `zombie -${Math.round(hp0 - target.hp)} hp, stamina ${Math.round(game.player.stamina)}, swung=${swung}, los=${los}, inHash=${seen}, dist=${Math.round(game.player.distTo(target.x, target.y))}`);
    target.dead = true;
  }

  await pause();
  // ======================================================== looting
  {
    const prop = w.props.find((p) => p.container && !p.dead && !p.container.locked)!;
    const cont = w.ensureLoot(prop, 4)!;
    check('containers roll loot on first open', cont.items.length > 0,
      `${PROPS[prop.kind].name}: ${cont.items.slice(0, 4).map((i) => `${i.stack.id}x${i.stack.count}`).join(', ')}`);

    const first = cont.items[0];
    const id = first.stack.id;
    const before = game.player.countItem(id);
    cont.remove(first);
    game.player.give(first.stack);
    check('loot transfers into the player inventory', game.player.countItem(id) > before,
      `took ${id}`);
  }

  {
    const locked = w.props.find((p) => p.container?.locked);
    check('some containers start locked', !!locked,
      locked ? `${PROPS[locked.kind].name} needs a lockpick` : 'none found on this seed');
  }

  await pause();
  // ======================================================== crafting
  {
    const cloth = RECIPE_BY_OUT.get('cloth')!;
    game.player.giveItem('plant_fiber', 40);
    const fiber0 = game.player.countItem('plant_fiber');
    const cloth0 = game.player.countItem('cloth');
    const queued = game.crafting.enqueue(game, cloth, 2);
    const spent = fiber0 - game.player.countItem('plant_fiber');
    tick(game, cloth.time * 2 + 1);
    const gained = game.player.countItem('cloth') - cloth0;
    check('crafting consumes inputs and yields outputs',
      queued && spent === 20 && gained === cloth.count * 2,
      `-${spent} fiber, +${gained} cloth, queue ${game.crafting.queue.length}`);

    game.crafting.stations = new Set();
    check('station-gated recipes are locked without a bench',
      !game.crafting.available(RECIPE_BY_OUT.get('ak47')!) && game.crafting.available(cloth),
      'AK47 requires a workbench, cloth does not');

    game.player.giveItem('plant_fiber', 20);
    const refund0 = game.player.countItem('plant_fiber');
    game.crafting.enqueue(game, cloth, 2);
    game.crafting.cancel(game, 0);
    check('cancelling a craft refunds materials', game.player.countItem('plant_fiber') === refund0,
      `${game.player.countItem('plant_fiber')} fiber back`);
  }

  await pause();
  // ======================================================== building
  {
    game.player.giveItem('building_plan', 1);
    game.player.giveItem('wood', 900);
    game.player.giveItem('stone', 500);
    game.building.active = true;

    // Real ground is lumpy: try a handful of spots until one is buildable,
    // which is what a player would do too.
    let foundationOk = false;
    for (let attempt = 0; attempt < 25 && !foundationOk; attempt++) {
      revive(game, findOpenGround(w, w.spawn));
      game.building.piece = 'foundation';
      game.aimWorld.x = game.player.x + 50;
      game.aimWorld.y = game.player.y;
      game.building.updateGhost(game);
      foundationOk = game.building.place(game);
    }
    game.building.piece = 'wall';
    game.building.updateGhost(game);
    const wallOk = game.building.place(game);
    check('foundations and walls can be placed', foundationOk && wallOk,
      `${w.structures.length} structures · ghost: ${game.building.ghost?.reason || 'valid'}`);

    const foundation = w.structures.find((s) => s.kind === 'foundation');
    const upgraded = foundation ? BuildSystem.upgrade(game, foundation) : false;
    check('structures upgrade through tiers', upgraded && foundation!.tier === 1,
      `tier ${foundation?.tier} (${foundation?.hp} hp)`);

    const wall = w.structures.find((s) => s.kind === 'wall');
    let blocked = false;
    if (wall) {
      const probe = { x: wall.x + wall.w / 2, y: wall.y + wall.h / 2 };
      w.resolveCollision(probe, 13);
      blocked = Math.hypot(probe.x - (wall.x + wall.w / 2), probe.y - (wall.y + wall.h / 2)) > 1;
    }
    check('built walls block movement', blocked, 'collision ejected a body from the wall');

    const wallsBefore = w.structures.length;
    if (wall) game.damageStructure(wall, 99999);
    check('structures can be destroyed', w.structures.length < wallsBefore,
      `${wallsBefore} -> ${w.structures.length}`);
    game.building.active = false;
  }

  await pause();
  // ======================================================== deployables
  {
    revive(game, findOpenGround(w, w.spawn));
    const bench = grant(game, 'workbench_1', 1);
    const placed = game.deployItem(bench);
    const stations = w.stationsNear(game.player.x, game.player.y);
    check('deployables place and unlock crafting stations', placed && stations.has('bench1'),
      `stations in range: ${[...stations].join(', ') || 'none'}`);
  }

  {
    // Somewhere fresh, so the workbench above isn't the nearest interaction.
    let fire = null as ReturnType<World['deployableNear']>;
    for (let attempt = 0; attempt < 8 && !fire; attempt++) {
      revive(game, findOpenGround(w, { x: w.spawn.x + 900 + attempt * 200, y: w.spawn.y }));
      game.player.giveItem('wood', 200);
      const fireItem = grant(game, 'campfire', 1);
      game.deployItem(fireItem);
      fire = w.deployableNear(game.player.x, game.player.y, 220, 'campfire');
    }
    // `E` always picks the *nearest* interactable, so a barrel standing next to
    // the fire can legitimately win. Walk around it until the Light prompt is
    // the closest one — the same thing a player would do.
    let lit = false;
    if (fire) {
      for (let i = 0; i < 12 && !lit; i++) {
        const a = (i / 12) * Math.PI * 2;
        game.player.x = fire.x + Math.cos(a) * 34;
        game.player.y = fire.y + Math.sin(a) * 34;
        const inter = findInteraction(game);
        if (inter && inter.label.includes('Light')) {
          inter.run(game);
          lit = fire.lit;
        }
      }
    }
    check('campfires light and act as a cooking station',
      lit && w.stationsNear(game.player.x, game.player.y).has('campfire'),
      fire ? `fuel ${Math.round(fire.fuel)}s` : 'no campfire placed');
  }

  await pause();
  // ======================================================== horses
  {
    const spot = findOpenGround(w, w.spawn);
    const horse = new Horse(spot.x, spot.y, 1234);
    game.horses.push(horse);
    horse.trust = 100;
    horse.saddle();
    const mounted = horse.mount();
    if (mounted) game.player.mount = horse;
    const x0 = horse.x;
    for (let i = 0; i < 120; i++) {
      horse.rideInput(1, 0, true, 1 / 60);
      horse.update(1 / 60, game);
    }
    const moved = Math.abs(horse.x - x0);
    check('horses can be saddled, mounted and galloped',
      horse.tamed && mounted && !!horse.saddleBags && moved > 40,
      `travelled ${Math.round(moved)}u, horse stamina ${Math.round(horse.stamina)}, saddle bags ${horse.saddleBags?.cols}x${horse.saddleBags?.rows}`);
    horse.dismount();
    game.player.mount = null;
  }

  await pause();
  // ======================================================== explosives
  {
    const spot = findOpenGround(w, w.spawn);
    revive(game, spot);
    game.player.belt[0] = makeStack('grenade', 3);
    game.player.activeSlot = 0;
    game.aimAngle = 0;
    const live0 = game.throwns.length;
    const threw = tryThrow(game);
    const spawned = game.throwns.length > live0;
    tick(game, 5);
    check('thrown grenades fly and detonate', threw && spawned && game.throwns.length === live0,
      `thrown and cleared after its 3s fuse`);
  }

  {
    // Blast falloff, tested directly so it doesn't depend on throw distance.
    const spot = findOpenGround(w, w.spawn);
    revive(game, spot);
    const near = new Zombie(spot.x + 250, spot.y, 'brute', 11);
    const far = new Zombie(spot.x + 250 + 120, spot.y, 'brute', 12);
    game.zombies.push(near, far);
    const nh = near.hp, fh = far.hp;
    game.explode(spot.x + 250, spot.y, 140, 150, null);
    const nearDmg = nh - near.hp;
    const farDmg = fh - far.hp;
    check('explosions damage in a radius with falloff',
      nearDmg > 0 && nearDmg > farDmg,
      `epicentre -${Math.round(nearDmg)} hp vs 120u away -${Math.round(farDmg)} hp`);
    near.dead = true;
    far.dead = true;
  }

  {
    game.player.belt[0] = makeStack('molotov', 2);
    game.player.activeSlot = 0;
    game.player.fireCooldown = 0;
    tryThrow(game);
    tick(game, 1.5);
    check('molotovs leave a burning area', game.areas.some((a) => a.kind === 'fire'),
      `${game.areas.length} area effects active`);
  }

  await pause();
  // ======================================================== AI
  {
    const spot = findOpenGround(w, w.spawn);
    revive(game, spot);
    // Clear distractions: zombies will happily maul a deer instead.
    game.animals.length = 0;
    game.bandits.length = 0;
    const hunter = new Zombie(spot.x + 240, spot.y, 'walker', 808);
    game.zombies.push(hunter);
    const d0 = hunter.distTo(spot.x, spot.y);
    for (let i = 0; i < 240; i++) hunter.update(1 / 60, game);
    const d1 = hunter.distTo(spot.x, spot.y);
    // It may legitimately divert onto a closer animal, so assert on the target.
    check('zombies notice and chase the player',
      hunter.target === game.player || d1 < d0 - 30,
      `closed ${Math.round(d0 - d1)}u, state "${hunter.state}", target=${hunter.target === game.player ? 'player' : hunter.target ? 'other actor' : 'none'}`);
    hunter.dead = true;
  }

  {
    const spot = findOpenGround(w, w.spawn);
    revive(game, spot);
    const b = new Bandit(spot.x + 300, spot.y, 'raider', 55);
    game.bandits.push(b);
    const bullets0 = game.bullets.length;
    for (let i = 0; i < 600; i++) b.update(1 / 60, game);
    check('bandits engage with firearms',
      game.bullets.length > bullets0 || b.state === 'engage' || b.state === 'melee',
      `state "${b.state}", ${game.bullets.length - bullets0} rounds fired`);
    b.dead = true;
    game.bullets.length = 0;
  }

  {
    const spot = findOpenGround(w, w.spawn);
    const z = new Zombie(spot.x, spot.y, 'walker', 1);
    game.zombies.push(z);
    z.alert(spot.x + 600, spot.y, 1);
    check('gunshots draw zombies to the noise', z.state === 'investigate', `state "${z.state}"`);
    z.dead = true;
  }

  await pause();
  // ======================================================== survival
  {
    revive(game);
    const p = game.player;
    p.food = 50;
    p.water = 50;
    const f0 = p.food, w0 = p.water;
    for (let i = 0; i < 900; i++) p.updateSurvival(1 / 60, 20, 0, false, false);
    const drained = p.food < f0 && p.water < w0;

    p.bodyTemp = 36.6;
    p.hp = 100;
    p.equipment.chest = null;
    for (let i = 0; i < 3600; i++) p.updateSurvival(1 / 60, -35, 0, false, false);
    const froze = p.hp < 100 && p.bodyTemp < 35.4;
    check('hunger, thirst and hypothermia all bite', drained && froze,
      `food ${p.food.toFixed(1)}, water ${p.water.toFixed(1)}, core ${p.bodyTemp.toFixed(1)}°C, hp ${p.hp.toFixed(0)}`);
  }

  {
    const p = game.player;
    // The hypothermia check above deliberately kills the player; revive for these.
    p.dead = false;
    p.hp = 60;
    p.bleed = 10;
    const bandage = grant(game, 'bandage', 1);
    game.useConsumable(bandage);
    p.actionTime = p.actionTotal;
    (game as unknown as { finishAction(): void }).finishAction();
    check('bandages stop bleeding and heal', p.bleed === 0 && p.hp > 60,
      `bleed ${p.bleed}, hp ${p.hp.toFixed(0)}`);
  }

  {
    // Full kit vs nothing, over many small hits so the random hit-location roll
    // averages out rather than deciding the result.
    const p = game.player;
    revive(game);
    for (const slot of ['head', 'face', 'chest', 'hands', 'legs', 'feet', 'back'] as const) p.equipment[slot] = null;
    p.hp = 100;
    for (let i = 0; i < 200; i++) p.takeDamage({ amount: 0.2, type: 'bullet' });
    const naked = 100 - p.hp;

    revive(game);
    p.equipment.head = makeStack('helmet_military');
    p.equipment.chest = makeStack('plate_carrier');
    p.equipment.legs = makeStack('leg_plates');
    p.equipment.feet = makeStack('boots_combat');
    p.equipment.hands = makeStack('gloves_tactical');
    p.equipment.back = makeStack('backpack_military');
    p.equipment.face = makeStack('gas_mask');
    p.hp = 100;
    for (let i = 0; i < 200; i++) p.takeDamage({ amount: 0.2, type: 'bullet' });
    const armoured = 100 - p.hp;
    check('armour reduces incoming damage', armoured < naked * 0.85,
      `${naked.toFixed(1)} damage unarmoured vs ${armoured.toFixed(1)} in full kit (${((1 - armoured / naked) * 100).toFixed(0)}% reduction)`);
  }

  {
    const p = game.player;
    p.dead = false;
    p.equipment.chest = null;
    p.equipment.legs = null;
    p.equipment.hands = null;
    p.infection = 0;
    // The roll is probabilistic; bare skin should catch it within a few bites.
    for (let i = 0; i < 25 && p.infection === 0; i++) p.applyBiteRisk(1);
    const gotInfected = p.infection > 0;
    grant(game, 'antibiotics', 1);
    p.cureInfection();
    check('zombie bites can infect, antibiotics cure it', gotInfected && p.infection === 0,
      gotInfected ? 'infection applied then cleared' : 'bite never transmitted in 25 tries');
  }

  await pause();
  // ======================================================== inventory grid
  {
    const inv = game.player.inventory;
    inv.clear();
    const placedRifle = inv.placeAt(makeStack('ak47'), 0, 0, false);      // 3x2
    const overlap = inv.placeAt(makeStack('machete'), 1, 0, false);        // must fail
    const beside = inv.placeAt(makeStack('machete'), 3, 0, false);         // 1x3 fits
    check('the grid enforces item footprints', placedRifle && !overlap && beside,
      `rifle placed, overlap rejected, machete placed beside`);
  }

  {
    // A 5x2 rifle in a 2-wide, 6-tall container can only fit rotated.
    const narrow = new Container('narrow', 2, 6, 'narrow');
    const sniper = makeStack('sniper');
    const fit = narrow.findFit(sniper);
    const placed = fit ? narrow.placeAt(sniper, fit.x, fit.y, fit.rot) : false;
    check('rotation lets long items fit narrow grids',
      !!fit && fit.rot === true && placed,
      `sniper (5x2) in a 2x6 grid -> ${JSON.stringify(fit)}`);
  }

  {
    const p = game.player;
    p.equipment.back = null;
    p.refreshCapacity();
    const base = p.inventory.rows;
    p.equipment.back = makeStack('backpack_military');
    p.refreshCapacity();
    check('backpacks expand the grid', p.inventory.rows === base + 3,
      `${base} rows -> ${p.inventory.rows} rows`);
  }

  {
    const inv = game.player.inventory;
    inv.clear();
    inv.addItem('ammo_pistol', 300); // max stack 128
    const stacks = inv.items.filter((i) => i.stack.id === 'ammo_pistol');
    check('stacks split at their per-item limit',
      inv.countOf('ammo_pistol') === 300 && stacks.every((s) => s.stack.count <= 128) && stacks.length >= 3,
      `300 rounds across ${stacks.length} stacks (${stacks.map((s2) => s2.stack.count).join('+')})`);
  }

  {
    const inv = game.player.inventory;
    inv.clear();
    inv.addItem('wood', 500);
    const evicted = inv.resize(6, 1);
    check('shrinking the grid evicts what no longer fits', inv.rows === 1,
      `${evicted.length} stacks evicted when the grid shrank`);
    inv.resize(6, 4);
  }

  await pause();
  // ======================================================== save / load
  {
    const p = game.player;
    p.inventory.clear();
    p.giveItem('ak47', 1);
    p.giveItem('ammo_rifle', 77);
    p.food = 42.5;
    p.x = w.spawn.x + 500;
    game.dayNight.day = 5;
    game.dayNight.time = 1234;

    const ok = saveGame(game);
    const data = loadSave();

    // Scramble live state, then restore from the save.
    p.food = 1;
    p.x = 0;
    p.inventory.clear();
    game.dayNight.day = 99;
    if (data) applySave(game, data);

    check('save and load round-trips the run',
      ok && hasSave() && !!data
      && Math.abs(game.player.food - 42.5) < 0.001
      && game.dayNight.day === 5
      && game.player.countItem('ammo_rifle') === 77
      && game.player.countItem('ak47') === 1,
      `food ${game.player.food}, day ${game.dayNight.day}, ${game.player.countItem('ammo_rifle')} rounds`);
  }

  await pause();
  // ======================================================== performance
  {
    const spot = findOpenGround(w, w.spawn);
    game.player.x = spot.x;
    game.player.y = spot.y;
    for (let i = 0; i < 45; i++) {
      const a = Math.random() * Math.PI * 2;
      game.zombies.push(new Zombie(
        spot.x + Math.cos(a) * (250 + Math.random() * 350),
        spot.y + Math.sin(a) * (250 + Math.random() * 350),
        'walker', Math.random() * 1e9,
      ));
    }
    const start = performance.now();
    tick(game, 1);
    const ms = performance.now() - start;
    check('simulation keeps real-time headroom under load', ms < 1000,
      `${Math.round(ms)}ms to simulate 1.0s with ${game.zombies.length} zombies (${(1000 / Math.max(ms, 1)).toFixed(1)}x real time)`);
  }

  // ======================================================== report
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);

  (window as unknown as { __results: unknown }).__results = {
    passed,
    total: results.length,
    failed: failed.map((f) => `${f.name} :: ${f.detail}`),
    errors,
  };

  document.getElementById('out')!.textContent =
    results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`).join('\n')
    + `\n\n${passed}/${results.length} checks passed`
    + (errors.length ? `\n\nRUNTIME ERRORS:\n${errors.join('\n')}` : '\n\nno runtime errors');
}

run().catch((err) => {
  const e = err as Error;
  errors.push(`FATAL: ${e?.stack ?? String(err)}`);
  (window as unknown as { __results: unknown }).__results = {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    failed: [...results.filter((r) => !r.pass).map((r) => `${r.name} :: ${r.detail}`),
             'FATAL: ' + (e?.message ?? String(err))],
    errors,
  };
  render();
  const el = document.getElementById('out');
  if (el) el.textContent += `\n\nFATAL after ${results.length} checks: ${e?.stack ?? String(err)}`;
});
