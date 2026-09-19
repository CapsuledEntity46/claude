/**
 * Game orchestration: owns all mutable state, runs the simulation, and exposes
 * the services that entities and systems call back into.
 */

import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { RNG } from './core/rng';
import { audio } from './core/audio';
import { clamp, clamp01, damp, TAU } from './core/math';
import { SpatialHash } from './core/spatial';

import { World, type Deployable, type Prop, type Structure } from './world/world';
import { DayNight } from './world/daynight';
import { PROPS } from './world/props';
import { TILES, Biome } from './world/tiles';

import { itemDef } from './items/itemdefs';
import { Container } from './items/container';
import { makeStack, type ItemStack } from './items/item';

import { Actor } from './entities/actor';
import { Player } from './entities/player';
import { Zombie, ZOMBIE_STATS } from './entities/zombie';
import { Bandit, BANDIT_STATS } from './entities/bandit';
import { Animal, ANIMAL_STATS } from './entities/animal';
import { Horse } from './entities/horse';
import { Bullet, Thrown, AreaEffect, GroundItem, type BulletSpec } from './entities/projectile';
import { Corpse } from './entities/corpse';

import { Effects } from './render/effects';
import { Renderer } from './render/renderer';

import { Crafting } from './systems/crafting';
import { Building } from './systems/building';
import { Spawner } from './systems/spawner';
import { findInteraction, type Interaction } from './systems/interaction';
import {
  tryFire, tryMelee, tryReload, tryThrow, updateDraw, finishReload, resolveSwing,
} from './systems/combat';

import { Hud } from './ui/hud';
import { InventoryUI } from './ui/inventoryUI';
import { saveGame, loadSave, hasSave, clearSave, applySave } from './systems/save';

export type GameState = 'menu' | 'playing' | 'paused' | 'dead';

export interface LootTarget {
  container: Container;
  label: string;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly input: Input;
  readonly effects = new Effects();
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly inv: InventoryUI;

  world!: World;
  dayNight!: DayNight;
  player!: Player;
  rng = new RNG(1);
  crafting = new Crafting();
  building = new Building();
  spawner!: Spawner;

  zombies: Zombie[] = [];
  bandits: Bandit[] = [];
  animals: Animal[] = [];
  horses: Horse[] = [];
  bullets: Bullet[] = [];
  throwns: Thrown[] = [];
  areas: AreaEffect[] = [];
  corpses: Corpse[] = [];
  groundItems: GroundItem[] = [];

  private actorHash = new SpatialHash<Actor>(128);
  private actorScratch: Actor[] = [];

  state: GameState = 'menu';
  /** Camera position in world units. */
  camera = { x: 0, y: 0, zoom: 1 };
  /** Mouse position projected into the world. */
  aimWorld = { x: 0, y: 0 };
  aimAngle = 0;

  /** Container currently shown in the loot panel. */
  loot: LootTarget | null = null;
  /** Current contextual interaction. */
  interaction: Interaction | null = null;
  /** Seed string used for this run, for display and reseeding. */
  seedLabel = '';

  private loop: GameLoop;
  private mapOpen = false;
  /** Guards against the same keypress toggling two screens. */
  private autosaveTimer = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.input = new Input(canvas);
    this.renderer = new Renderer(this);
    this.hud = new Hud(this);
    this.inv = new InventoryUI(this);

    this.loop = new GameLoop((dt) => this.update(dt), (a) => this.render(a), 60);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bindMenus();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.renderer.onResize(dpr);
  }

  private bindMenus(): void {
    const el = (id: string) => document.getElementById(id)!;

    el('btn-new').addEventListener('click', () => {
      const seedInput = (document.getElementById('seed-input') as HTMLInputElement).value.trim();
      this.newGame(seedInput || String(Math.floor(Math.random() * 1e9)));
    });

    const continueBtn = el('btn-continue') as HTMLButtonElement;
    continueBtn.disabled = !hasSave();
    continueBtn.addEventListener('click', () => this.continueGame());

    el('btn-resume').addEventListener('click', () => this.setPaused(false));
    el('btn-save').addEventListener('click', () => {
      saveGame(this);
      this.toast('Game saved', 'pickup');
    });
    el('btn-quit').addEventListener('click', () => {
      clearSave();
      location.reload();
    });
    el('btn-respawn').addEventListener('click', () => this.respawn());

    // Keep the seed field from eating keyboard input.
    const seedField = document.getElementById('seed-input') as HTMLInputElement;
    seedField.addEventListener('focus', () => { this.input.textCaptured = true; });
    seedField.addEventListener('blur', () => { this.input.textCaptured = false; });
  }

  newGame(seed: string): void {
    audio.resume();
    this.seedLabel = seed;
    this.rng = new RNG(seed + '_runtime');
    this.world = new World(seed);
    this.dayNight = new DayNight(this.world.data.seed, 1500, 7.5);
    this.spawner = new Spawner(this.world.data.seed);

    this.player = new Player(this.world.spawn.x, this.world.spawn.y);
    this.giveStarterKit();

    this.resetTransients();
    this.renderer.invalidateTerrain();

    document.getElementById('main-menu')!.classList.add('hidden');
    document.getElementById('death-screen')!.classList.add('hidden');
    this.state = 'playing';
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
    this.toast(`Washed ashore. Seed ${seed}`, 'warn');
    this.loop.start();
  }

  private continueGame(): void {
    audio.resume();
    const save = loadSave();
    if (!save) { this.toast('No save found', 'bad'); return; }

    this.seedLabel = save.seedLabel;
    this.rng = new RNG(save.seedLabel + '_runtime');
    this.world = new World(save.seedLabel);
    this.dayNight = new DayNight(this.world.data.seed, 1500, 7.5);
    this.spawner = new Spawner(this.world.data.seed);
    this.player = new Player(this.world.spawn.x, this.world.spawn.y);
    this.resetTransients();

    applySave(this, save);
    this.renderer.invalidateTerrain();

    document.getElementById('main-menu')!.classList.add('hidden');
    this.state = 'playing';
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
    this.toast('Save loaded', 'pickup');
    this.loop.start();
  }

  private resetTransients(): void {
    this.zombies.length = 0;
    this.bandits.length = 0;
    this.animals.length = 0;
    this.horses.length = 0;
    this.bullets.length = 0;
    this.throwns.length = 0;
    this.areas.length = 0;
    this.corpses.length = 0;
    this.groundItems.length = 0;
    this.effects.clear();
    this.crafting = new Crafting();
    this.building = new Building();
    this.loot = null;
    this.inv.close();
  }

  private giveStarterKit(): void {
    const p = this.player;
    p.belt[0] = makeStack('rock');
    p.belt[1] = makeStack('torch');
    p.belt[2] = makeStack('bandage', 2);
    p.giveItem('cloth', 12);
    p.giveItem('canned_beans', 1);
    p.giveItem('water_bottle', 1);
    p.equipment.chest = makeStack('shirt');
    p.equipment.legs = makeStack('pants_cloth');
    p.equipment.feet = makeStack('shoes');
    p.refreshCapacity();
  }

  private respawn(): void {
    const spot = this.player.respawnPoint ?? this.world.spawn;
    const keptStats = {
      kills: this.player.kills, zombieKills: this.player.zombieKills,
      crafted: this.player.itemsCrafted, respawn: this.player.respawnPoint,
    };
    this.player = new Player(spot.x, spot.y);
    this.player.kills = keptStats.kills;
    this.player.zombieKills = keptStats.zombieKills;
    this.player.itemsCrafted = keptStats.crafted;
    this.player.respawnPoint = keptStats.respawn;
    this.giveStarterKit();

    this.bullets.length = 0;
    this.throwns.length = 0;
    this.loot = null;
    this.inv.close();
    this.effects.clear();

    document.getElementById('death-screen')!.classList.add('hidden');
    this.state = 'playing';
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
    this.toast('You wake up somewhere else', 'warn');
  }

  private setPaused(paused: boolean): void {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    this.state = paused ? 'paused' : 'playing';
    document.getElementById('pause-menu')!.classList.toggle('hidden', !paused);
  }

  // =========================================================================
  // Simulation
  // =========================================================================

  private update(dt: number): void {
    if (this.state === 'menu') { this.input.endFrame(); return; }

    this.readGlobalKeys();

    if (this.state !== 'playing') {
      this.effects.update(dt);
      this.input.endFrame();
      return;
    }

    // Inventory open pauses the world but keeps crafting ticking, like Rust's.
    const worldPaused = this.inv.isOpen || this.mapOpen;

    this.updateAim();

    if (!worldPaused) {
      this.handleInput(dt);
      this.simulate(dt);
    } else {
      this.player.moveX = 0;
      this.player.moveY = 0;
    }

    this.crafting.update(dt, this);
    this.effects.update(dt);
    this.updateCamera(dt, worldPaused);
    this.hud.update(dt);

    audio.setListener(this.player.x, this.player.y);

    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = 90;
      saveGame(this);
    }

    if (this.player.dead && this.state === 'playing') this.onPlayerDeath();

    this.input.endFrame();
  }

  /**
   * Advance the world one fixed step.
   *
   * Separated from `update` so it contains no input or UI concerns: the order
   * here matters (actors are hashed before projectiles query them), and keeping
   * it in one place means headless tests drive exactly the same code the game
   * does.
   */
  simulate(dt: number): void {
    this.dayNight.update(dt);
    this.updateActors(dt);
    this.updateProjectiles(dt);
    this.world.update(dt);
    this.updateSurvival(dt);
    this.spawner.update(dt, this);
    this.interaction = findInteraction(this);
    this.world.discoverAround(this.player.x, this.player.y);
  }

  private readGlobalKeys(): void {
    const inp = this.input;

    if (inp.justPressed('Escape')) {
      if (this.inv.isOpen) this.inv.close();
      else if (this.mapOpen) this.toggleMap();
      else this.setPaused(this.state === 'playing');
    }

    if (this.state !== 'playing' && this.state !== 'paused') return;

    if (inp.justPressed('Tab')) {
      if (this.inv.isOpen) this.inv.close();
      else this.inv.open();
    }
    if (inp.justPressed('KeyM')) this.toggleMap();
    if (inp.justPressed('KeyP')) {
      const muted = audio.toggleMute();
      this.toast(muted ? 'Audio muted' : 'Audio on', 'warn');
    }
  }

  private toggleMap(): void {
    this.mapOpen = !this.mapOpen;
    document.getElementById('map-screen')!.classList.toggle('hidden', !this.mapOpen);
    if (this.mapOpen) {
      this.renderer.drawBigMap();
      audio.play('ui_open');
    }
  }

  /** Project the mouse position (CSS pixels) into world space. */
  private updateAim(): void {
    const dpr = this.renderer.dpr;
    const mx = this.input.mouseX * dpr;
    const my = this.input.mouseY * dpr;
    this.aimWorld.x = this.camera.x + (mx - this.canvas.width / 2) / (this.camera.zoom * dpr);
    this.aimWorld.y = this.camera.y + (my - this.canvas.height / 2) / (this.camera.zoom * dpr);
    this.aimAngle = Math.atan2(this.aimWorld.y - this.player.y, this.aimWorld.x - this.player.x);
  }

  private handleInput(dt: number): void {
    const p = this.player;
    const inp = this.input;

    // --- movement intent ---
    let mx = 0, my = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) my -= 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) my += 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    const mag = Math.hypot(mx, my);
    if (mag > 0) { mx /= mag; my /= mag; }

    p.sprinting = inp.anyDown('ShiftLeft', 'ShiftRight') && mag > 0;
    p.crouching = inp.anyDown('ControlLeft', 'ControlRight');
    p.aiming = inp.mouseDown(2) && !p.mount;
    p.facing = this.aimAngle;

    // --- mounted riding ---
    if (p.mount) {
      const horse = p.mount;
      if (!horse.alive) {
        p.mount = null;
      } else {
        horse.rideInput(mx, my, p.sprinting, dt);
        // The rider is carried along.
        p.x = horse.x - Math.cos(horse.facing) * 2;
        p.y = horse.y - Math.sin(horse.facing) * 6;
        p.moveX = 0;
        p.moveY = 0;
        if (horse.exertion > 0.5 && this.rng.bool(dt * 14)) {
          this.effects.dust(horse.x - Math.cos(horse.facing) * 18, horse.y - Math.sin(horse.facing) * 18, 1);
        }
        if (inp.justPressed('Space')) {
          horse.dismount();
          p.mount = null;
          p.x = horse.x + Math.cos(horse.facing + Math.PI / 2) * 34;
          p.y = horse.y + Math.sin(horse.facing + Math.PI / 2) * 34;
          this.toast('Dismounted', 'warn');
        }
      }
    } else {
      p.moveX = mx;
      p.moveY = my;
      // Mount the nearest tamed horse.
      if (inp.justPressed('Space')) {
        const h = this.horses.find((hh) => hh.tamed && hh.alive && !hh.ridden && p.distTo(hh.x, hh.y) < 90);
        if (h && h.mount()) {
          p.mount = h;
          this.toast('Mounted', 'pickup');
        }
      }
    }

    // --- belt selection ---
    const digit = inp.digitPressed();
    if (digit >= 0 && digit < p.belt.length) p.selectSlot(digit);
    if (inp.wheel !== 0 && !this.building.active) {
      const n = p.belt.length;
      p.selectSlot((p.activeSlot + (inp.wheel > 0 ? 1 : -1) + n) % n);
    }
    if (inp.justPressed('KeyQ')) {
      // Holster: swap to an empty slot if there is one.
      const empty = p.belt.indexOf(null);
      if (empty >= 0) p.selectSlot(empty);
    }

    // --- build mode ---
    if (inp.justPressed('KeyB')) this.building.toggle(this);
    if (this.building.active) {
      if (inp.wheel !== 0) this.building.cyclePiece(inp.wheel > 0 ? 1 : -1);
      this.building.updateGhost(this);
      if (inp.mouseJustPressed(0)) this.building.place(this);
      if (inp.justPressed('KeyR')) this.building.cyclePiece(1);
    }

    // --- combat ---
    if (!this.building.active) {
      const held = p.heldItem;
      const def = held ? itemDef(held.id) : null;

      updateDraw(this, dt, inp.mouseDown(0));

      if (def?.ranged) {
        if (def.ranged.draw) {
          // Bows fire on release once charged.
          if (inp.mouseJustReleased(0) && p.drawCharge >= 1) tryFire(this, 'press');
        } else if (inp.mouseJustPressed(0)) tryFire(this, 'press');
        else if (inp.mouseDown(0)) tryFire(this, 'hold');
      } else if (def?.throwable && def.cat === 'throwable') {
        if (inp.mouseJustPressed(0)) tryThrow(this);
      } else if (inp.mouseJustPressed(0) || (inp.mouseDown(0) && p.swingTime <= 0)) {
        tryMelee(this);
      }

      if (inp.justPressed('KeyR')) tryReload(this);
      if (inp.justPressed('KeyG')) tryThrow(this);
    }

    // --- interaction ---
    if (inp.justPressed('KeyE')) {
      if (this.interaction) this.interaction.run(this);
      else this.toast('Nothing here', 'warn');
    }

    // --- quick heal / light ---
    if (inp.justPressed('KeyH')) this.quickHeal();
    if (inp.justPressed('KeyF')) {
      p.flashlightOn = !p.flashlightOn;
      audio.play('ui_click');
    }

    // --- melee damage window ---
    if (p.consumeSwingHit()) resolveSwing(this);

    // --- long action completion ---
    if (p.isBusy && p.actionProgress >= 1) this.finishAction();
  }

  private finishAction(): void {
    const p = this.player;
    switch (p.action) {
      case 'reload':
        finishReload(this);
        return;
      case 'consume': {
        const item = p.actionItem;
        p.cancelAction();
        if (item) this.applyConsumable(item);
        return;
      }
      case 'deploy':
        p.cancelAction();
        return;
      default:
        p.cancelAction();
    }
  }

  private updateActors(dt: number): void {
    const p = this.player;
    const before = { x: p.x, y: p.y };

    if (!p.mount) {
      const step = p.integrate(dt, this.world);
      if (step) {
        const mat = TILES[this.world.tileAt(p.x, p.y)];
        audio.play('footstep', p.x, p.y, { volume: p.crouching ? 0.25 : 0.6 });
        // Louder surfaces carry further; sprinting doubles it.
        const noise = 150 * mat.noise * (p.sprinting ? 2 : p.crouching ? 0.35 : 1);
        this.alertZombies(p.x, p.y, noise, 0.4);
        if (mat.water) this.effects.splash(p.x, p.y);
      }
    }
    p.distanceTravelled += Math.hypot(p.x - before.x, p.y - before.y);

    for (const z of this.zombies) z.update(dt, this);
    for (const b of this.bandits) b.update(dt, this);
    for (const a of this.animals) a.update(dt, this);
    for (const h of this.horses) h.update(dt, this);

    this.reapDead();

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.update(dt);
      if (c.dead) {
        if (this.loot?.container === c.container) this.closeLoot();
        this.corpses.splice(i, 1);
      }
    }

    for (let i = this.groundItems.length - 1; i >= 0; i--) {
      this.groundItems[i].update(dt);
      if (this.groundItems[i].dead) this.groundItems.splice(i, 1);
    }

    // Spike traps and barbed wire hurt anything standing on them.
    this.applyTouchDamage(dt);
  }

  private applyTouchDamage(dt: number): void {
    const check = (a: Actor) => {
      if (!a.alive) return;
      for (const prop of this.world.propsNear(a.x - 40, a.y - 40, 80, 80)) {
        const def = PROPS[prop.kind];
        if (!def.damageOnTouch) continue;
        if (a.distTo(prop.x, prop.y) > def.size * 0.45 + a.radius) continue;
        a.takeDamage({ amount: def.damageOnTouch * dt, type: 'trap', bleed: 0.4 * dt });
      }
      for (const dep of this.world.deployables) {
        if (dep.kind !== 'spikes' && dep.kind !== 'bear_trap') continue;
        if (!dep.armed) continue;
        if (a.distTo(dep.x, dep.y) > 34 + a.radius) continue;
        if (dep.kind === 'spikes') {
          a.takeDamage({ amount: 14 * dt, type: 'trap', bleed: 0.5 * dt });
        } else {
          dep.armed = false;
          a.takeDamage({ amount: 55, type: 'trap', bleed: 6 });
          a.stun = Math.max(a.stun, 2.2);
          audio.play('hit_metal', dep.x, dep.y, { volume: 1 });
          this.effects.blood(a.x, a.y, Math.random() * TAU, 40);
        }
      }
    };
    check(this.player);
    for (const z of this.zombies) check(z);
    for (const b of this.bandits) check(b);
    for (const a of this.animals) check(a);
  }

  private reapDead(): void {
    const day = this.dayNight.day;

    for (const z of this.zombies) {
      if (!z.justDied) continue;
      z.justDied = false;
      this.player.zombieKills++;
      this.player.kills++;
      if (z.explodesOnDeath) {
        this.effects.gibs(z.x, z.y, 16);
        this.explode(z.x, z.y, 105, 52, z);
      }
      this.corpses.push(new Corpse(z.x, z.y, 'zombie', `${z.stats.name} Corpse`, z.stats.loot,
        z.stats.size, ZOMBIE_STATS[z.type].color, 'zombie', this.rng.next() * 1e9, day));
    }

    for (const b of this.bandits) {
      if (!b.justDied) continue;
      b.justDied = false;
      this.player.kills++;
      this.corpses.push(new Corpse(b.x, b.y, 'bandit', `${b.stats.name} Corpse`, b.stats.loot,
        b.stats.size, BANDIT_STATS[b.kind].color, 'bandit', this.rng.next() * 1e9, day));
      // Drop their weapon so killing a heavy is genuinely rewarding.
      if (b.stats.weapon && this.rng.bool(0.45)) this.dropItemAt(b.x, b.y, b.stats.weapon, 1);
    }

    for (const a of this.animals) {
      if (!a.justDied) continue;
      a.justDied = false;
      this.corpses.push(new Corpse(a.x, a.y, 'animal', `Dead ${a.stats.name}`, a.stats.loot,
        a.stats.size, ANIMAL_STATS[a.kind].color, 'animal', this.rng.next() * 1e9, day));
    }

    for (const h of this.horses) {
      if (!h.justDied) continue;
      h.justDied = false;
      if (this.player.mount === h) this.player.mount = null;
      const corpse = new Corpse(h.x, h.y, 'horse', 'Dead Horse', 'deer', 1.4, h.colors.body, 'animal', this.rng.next() * 1e9, day);
      // Saddle bags spill onto the body.
      if (h.saddleBags) for (const it of h.saddleBags.items) corpse.container.add(it.stack);
      if (h.tamed) corpse.container.add(makeStack('saddle'));
      this.corpses.push(corpse);
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.update(dt, this);
      if (b.tracer > 0) this.effects.tracer(b.prevX, b.prevY, b.x, b.y, 1.1);
      if (b.dead) this.bullets.splice(i, 1);
    }
    for (let i = this.throwns.length - 1; i >= 0; i--) {
      const t = this.throwns[i];
      t.update(dt, this);
      if (t.dead) this.throwns.splice(i, 1);
    }
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i];
      a.update(dt, this);
      if (a.kind === 'fire') this.effects.flames(a.x, a.y, a.radius * 0.8, a.intensity, dt);
      else this.effects.smokeCloud(a.x, a.y, a.radius * 0.7, a.intensity, dt);
      if (a.dead) this.areas.splice(i, 1);
    }

    // Lit campfires and furnaces sputter away visually.
    for (const d of this.world.deployables) {
      if (!d.lit) continue;
      this.effects.flames(d.x, d.y, d.kind === 'furnace' ? 10 : 14, 0.55, dt);
    }
  }

  private updateSurvival(dt: number): void {
    const p = this.player;
    const biome = this.world.biomeAt(p.x, p.y);
    const indoors = this.world.isIndoors(p.x, p.y);
    const ambient = this.dayNight.ambientTemp(biome, indoors);

    // Radiated heat from nearby fires.
    let fireWarmth = 0;
    for (const d of this.world.deployables) {
      if (!d.lit) continue;
      const dist = p.distTo(d.x, d.y);
      if (dist < 160) fireWarmth = Math.max(fireWarmth, 16 * (1 - dist / 160));
    }
    for (const a of this.areas) {
      if (a.kind !== 'fire') continue;
      const dist = p.distTo(a.x, a.y);
      if (dist < a.radius * 1.5) fireWarmth = Math.max(fireWarmth, 10);
    }
    const torch = p.heldItem && itemDef(p.heldItem.id).id === 'torch';
    if (torch) fireWarmth = Math.max(fireWarmth, 5);

    const raining = this.dayNight.rainIntensity > 0.2;
    p.updateSurvival(dt, ambient, fireWarmth, raining, indoors);
  }

  private updateCamera(dt: number, paused: boolean): void {
    const p = this.player;
    // Lead the camera slightly toward the cursor so you can see where you're aiming.
    const leadX = clamp((this.aimWorld.x - p.x) * 0.16, -130, 130);
    const leadY = clamp((this.aimWorld.y - p.y) * 0.16, -130, 130);
    const targetX = p.x + leadX;
    const targetY = p.y + leadY;

    const rate = paused ? 12 : 5.5;
    this.camera.x = damp(this.camera.x, targetX, rate, dt);
    this.camera.y = damp(this.camera.y, targetY, rate, dt);

    // Base zoom keeps the character readable while still showing a useful
    // tactical radius. Riding pulls back; a scope pushes in hard.
    const held = p.heldItem;
    const scoped = held?.attachments?.includes('scope') && p.aiming;
    let zoom = 1.45;
    if (p.mount) zoom = 1.2;
    if (p.aiming) zoom = 1.35;
    if (scoped) zoom = 2.1;
    this.camera.zoom = damp(this.camera.zoom, zoom, 4, dt);
  }

  private rebuildActorHash(): void {
    this.actorHash.clear();
    this.actorHash.insert(this.player);
    for (const z of this.zombies) if (z.alive) this.actorHash.insert(z);
    for (const b of this.bandits) if (b.alive) this.actorHash.insert(b);
    for (const a of this.animals) if (a.alive) this.actorHash.insert(a);
    for (const h of this.horses) if (h.alive) this.actorHash.insert(h);
  }

  // =========================================================================
  // Services used by entities and systems
  // =========================================================================

  /**
   * Broad-phase actor query.
   *
   * The hash is rebuilt on every call rather than cached per tick. Caching was a
   * bug factory: entities appear and disappear mid-tick (hordes spawning,
   * bloaters rupturing, the spawner culling), and a stale bucket silently made
   * them immune to bullets and blasts. With at most a couple of hundred actors a
   * rebuild is a few microseconds, which is well worth the correctness.
   */
  actorsNear(x: number, y: number, radius: number): Actor[] {
    this.rebuildActorHash();
    return this.actorHash.query(x, y, radius, this.actorScratch);
  }

  spawnBullet(spec: BulletSpec): void {
    this.bullets.push(new Bullet(spec));
  }

  addThrown(t: Thrown): void { this.throwns.push(t); }

  addAreaEffect(a: AreaEffect): void { this.areas.push(a); }

  /** Wake every zombie within `radius` and point them at the noise. */
  alertZombies(x: number, y: number, radius: number, intensity = 1): void {
    if (radius <= 0) return;
    const r2 = radius * radius;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const dx = z.x - x, dy = z.y - y;
      if (dx * dx + dy * dy > r2) continue;
      z.alert(x, y, intensity);
    }
  }

  explode(x: number, y: number, radius: number, damage: number, owner: Actor | null): void {
    audio.play('explosion', x, y, { volume: 1.1 });
    this.effects.explosion(x, y, radius);

    for (const a of this.actorsNear(x, y, radius)) {
      if (!a.alive) continue;
      const d = a.distTo(x, y);
      if (d > radius) continue;
      // Walls absorb blasts.
      if (!this.world.hasLineOfSight(x, y, a.x, a.y)) continue;
      const falloff = Math.pow(1 - d / radius, 1.6);
      const angle = Math.atan2(a.y - y, a.x - x);
      a.takeDamage({
        amount: damage * falloff,
        type: 'explosion',
        angle,
        knockback: 260 * falloff,
        source: owner ?? undefined,
      });
      a.stun = Math.max(a.stun, falloff * 1.4);
    }

    // Structures and props in the blast.
    for (const s of [...this.world.structures]) {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d > radius * 1.2) continue;
      this.damageStructure(s, damage * Math.pow(1 - clamp01(d / (radius * 1.2)), 1.4) * 2.2);
    }
    for (const prop of this.world.propsNear(x - radius, y - radius, radius * 2, radius * 2)) {
      const d = Math.hypot(prop.x - x, prop.y - y);
      if (d > radius) continue;
      this.damageProp(prop, damage * (1 - d / radius) * 1.5, 'explosion');
    }

    this.alertZombies(x, y, radius * 6, 1);
    if (this.player.distTo(x, y) < radius * 1.3) this.effects.hurtFlash(0.4);
  }

  /** Generic prop damage (bullets, explosions, vehicles). */
  damageProp(prop: Prop, amount: number, _type: string): void {
    const def = PROPS[prop.kind];
    if (def.hp === undefined && !def.harvest) return;
    prop.hp -= amount;
    if (prop.hp > 0) return;

    // Spill any remaining loot before it disappears.
    if (prop.container && prop.lootRolled) {
      for (const it of prop.container.items) {
        this.dropItemAt(prop.x, prop.y, it.stack.id, it.stack.count);
      }
      prop.container.clear();
    }
    if (def.harvest) {
      this.player.giveItem(def.harvest.item, Math.ceil((def.harvest.min + def.harvest.max) / 4));
    }
    this.effects.gather(prop.x, prop.y, def.harvest?.tool === 'wood' ? '#8a6134' : '#8b8b8f');
    this.world.killProp(prop);
  }

  /** Swing a tool at a resource node. */
  harvestProp(prop: Prop, damage: number, matchedTool: boolean): void {
    const def = PROPS[prop.kind];
    const h = def.harvest;
    if (!h) return;

    prop.hp -= damage;
    const woodish = h.tool === 'wood';
    audio.play(woodish ? 'hit_wood' : h.tool === 'flesh' ? 'gather' : 'hit_stone', prop.x, prop.y, { volume: 0.8 });
    this.effects.gather(prop.x, prop.y, woodish ? '#8a6134' : h.tool === 'flesh' ? '#6f8a4a' : '#8b8b8f');
    this.alertZombies(prop.x, prop.y, 160, 0.3);

    // Yield comes per hit, not just on the final blow.
    const yieldAmount = Math.max(1, Math.round(this.rng.int(h.min, h.max) * (matchedTool ? 1 : 0.35)));
    const left = this.player.giveItem(h.item, yieldAmount);
    if (left > 0) this.dropItemAt(prop.x, prop.y, h.item, left);
    this.hud.flashGather(h.item, yieldAmount - left);

    if (h.bonus && this.rng.bool(h.bonus.chance * (matchedTool ? 1 : 0.4))) {
      const n = this.rng.int(h.bonus.min, h.bonus.max);
      if (this.player.giveItem(h.bonus.item, n) > 0) this.dropItemAt(prop.x, prop.y, h.bonus.item, n);
      this.hud.flashGather(h.bonus.item, n);
    }

    if (prop.hp <= 0) {
      // Felling a tree gives a final bonus.
      if (woodish) {
        const bonus = this.rng.int(h.min, h.max);
        if (this.player.giveItem(h.item, bonus) > 0) this.dropItemAt(prop.x, prop.y, h.item, bonus);
        this.hud.flashGather(h.item, bonus);
      }
      this.world.killProp(prop);
      audio.play('hit_wood', prop.x, prop.y, { volume: 1, pitch: 0.7 });
    }
  }

  /** Forage by hand (bushes, crops). */
  forageProp(prop: Prop): void {
    const def = PROPS[prop.kind];
    const h = def.harvest;
    if (!h) return;
    const n = this.rng.int(h.min, h.max);
    if (this.player.giveItem(h.item, n) > 0) this.dropItemAt(prop.x, prop.y, h.item, n);
    this.hud.flashGather(h.item, n);
    if (h.bonus && this.rng.bool(h.bonus.chance)) {
      const b = this.rng.int(h.bonus.min, h.bonus.max);
      this.player.giveItem(h.bonus.item, b);
      this.hud.flashGather(h.bonus.item, b);
    }
    audio.play('gather', prop.x, prop.y, { volume: 0.7 });
    this.effects.gather(prop.x, prop.y, '#6f8a4a');
    this.world.killProp(prop);
  }

  damageStructure(s: Structure, amount: number): void {
    s.hp -= amount;
    if (s.hp > 0) return;
    // Refund a fraction of the materials as debris.
    this.effects.dust(s.x + s.w / 2, s.y + s.h / 2, 8);
    audio.play('hit_wood', s.x, s.y, { volume: 1, pitch: 0.7 });
    this.world.removeStructure(s);
  }

  dropItemAt(x: number, y: number, id: string, count: number): void {
    if (count <= 0) return;
    this.groundItems.push(new GroundItem(x + this.rng.float(-8, 8), y + this.rng.float(-8, 8), id, count));
  }

  dropStack(stack: ItemStack): void {
    const p = this.player;
    const x = p.x + Math.cos(p.facing) * 30;
    const y = p.y + Math.sin(p.facing) * 30;
    this.groundItems.push(new GroundItem(x, y, stack.id, stack.count));
    this.toast(`Dropped ${itemDef(stack.id).name}`, 'warn');
  }

  pickUpGroundItem(gi: GroundItem): void {
    const left = this.player.giveItem(gi.itemId, gi.count);
    const taken = gi.count - left;
    if (taken > 0) {
      audio.play('pickup', gi.x, gi.y);
      this.toast(`+${taken} ${itemDef(gi.itemId).name}`, 'pickup');
    }
    if (left > 0) {
      gi.count = left;
      this.toast('Inventory full', 'warn');
    } else {
      gi.dead = true;
    }
  }

  pickUpDeployable(dep: Deployable): void {
    if (dep.container && !dep.container.isEmpty) {
      this.toast('Empty it first', 'warn');
      return;
    }
    if (this.player.giveItem(dep.itemId, 1) > 0) {
      this.toast('No room', 'warn');
      return;
    }
    this.world.removeDeployable(dep);
    audio.play('pickup', dep.x, dep.y);
    this.toast(`Picked up ${itemDef(dep.itemId).name}`, 'pickup');
  }

  /** Place a deployable item in front of the player. */
  deployItem(stack: ItemStack): boolean {
    const def = itemDef(stack.id);
    if (!def.deploy) return false;
    const p = this.player;

    // Saddles are used on horses, not placed.
    if (def.deploy === 'saddle') {
      const h = this.horses.find((hh) => hh.alive && !hh.tamed && p.distTo(hh.x, hh.y) < 90);
      if (!h) { this.toast('No wild horse nearby', 'warn'); return false; }
      if (h.trust < 60) { this.toast('The horse is too skittish', 'warn'); return false; }
      h.saddle();
      this.consumeOne(stack);
      this.toast('Horse tamed', 'pickup');
      return true;
    }

    // Look for somewhere it actually fits, fanning out from straight ahead
    // rather than refusing outright when a tree is in the way.
    const spot = this.findDeploySpot(p.x, p.y, p.facing);
    if (!spot) {
      this.toast('No room to place that here', 'warn');
      return false;
    }
    const { x, y } = spot;

    this.world.addDeployable(stack.id, def.deploy, x, y);
    this.consumeOne(stack);
    audio.play('build', x, y, { volume: 0.9 });
    this.effects.dust(x, y, 6);
    this.toast(`Placed ${def.name}`, 'pickup');
    return true;
  }

  /**
   * Nearest workable spot to drop a deployable, searched outward from the
   * direction the player is facing.
   */
  private findDeploySpot(px: number, py: number, facing: number): { x: number; y: number } | null {
    for (const dist of [62, 48, 78, 36]) {
      for (const spread of [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const a = facing + spread;
        const x = px + Math.cos(a) * dist;
        const y = py + Math.sin(a) * dist;
        if (this.world.isWater(x, y)) continue;
        if (!this.world.isClear(x, y, 26)) continue;
        return { x, y };
      }
    }
    return null;
  }

  /** Start using a consumable. */
  useConsumable(stack: ItemStack): boolean {
    const def = itemDef(stack.id);
    const c = def.consume;
    if (!c) return false;
    if (this.player.isBusy) return false;
    this.player.startAction('consume', c.useTime, stack);
    audio.play(c.sound, this.player.x, this.player.y, { volume: 0.7 });
    return true;
  }

  private applyConsumable(stack: ItemStack): void {
    const def = itemDef(stack.id);
    const c = def.consume;
    if (!c) return;
    const p = this.player;

    if (c.food) p.food = clamp(p.food + c.food, 0, 100);
    if (c.water) p.water = clamp(p.water + c.water, 0, 100);
    if (c.health) {
      if (c.health > 0) p.heal(c.health);
      else p.takeDamage({ amount: -c.health, type: 'bleed' });
    }
    if (c.regen && c.overTime) p.startRegen(c.regen, c.overTime);
    if (c.stamina) p.stamina = clamp(p.stamina + c.stamina, 0, p.maxStamina);
    if (c.temp) p.bodyTemp = clamp(p.bodyTemp + c.temp * 0.06, 30, 42);
    if (c.stopBleed) p.bleed = 0;
    if (c.cureInfection) p.cureInfection();
    if (c.painkiller) p.painkillers = Math.max(p.painkillers, c.painkiller);

    audio.play(c.sound === 'heal' ? 'heal' : c.sound, p.x, p.y);
    this.toast(`Used ${def.name}`, 'pickup');

    this.consumeOne(stack);
    if (c.leftover) p.giveItem(c.leftover, 1);
  }

  /** Remove one unit of a stack, deleting it when empty. */
  consumeOne(stack: ItemStack): void {
    stack.count -= 1;
    if (stack.count <= 0) this.player.removeStack(stack);
    this.inv.refresh();
  }

  private quickHeal(): void {
    const p = this.player;
    const item = p.bleed > 0 ? (p.findBandage() ?? p.findHeal()) : p.findHeal();
    if (!item) { this.toast('Nothing to heal with', 'warn'); return; }
    this.useConsumable(item);
  }

  // --- loot windows -------------------------------------------------------

  openProp(prop: Prop): void {
    const container = this.world.ensureLoot(prop, this.dayNight.day);
    if (!container) return;
    const def = PROPS[prop.kind];
    this.openContainer(container, def.container?.label ?? def.name);
  }

  openContainer(container: Container, label: string): void {
    this.loot = { container, label };
    this.inv.open(true);
    audio.play('ui_open');
  }

  closeLoot(): void {
    this.loot = null;
    this.inv.refresh();
  }

  // --- feedback -----------------------------------------------------------

  toast(text: string, kind: 'pickup' | 'warn' | 'bad' | 'info' = 'info'): void {
    this.hud.toast(text, kind);
  }

  onPlayerHurt(amount: number, _angle: number): void {
    this.effects.hurtFlash(clamp01(amount / 45));
    audio.play('hurt', this.player.x, this.player.y, { volume: 0.7 });
  }

  onPlayerHit(crit: boolean): void {
    this.hud.hitmarker(crit);
  }

  blindPlayer(x: number, y: number, radius: number): void {
    const d = this.player.distTo(x, y);
    if (d > radius) return;
    if (this.player.hasGasMask) return;
    this.effects.blind = Math.min(1.6, this.effects.blind + (1 - d / radius) * 1.5);
  }

  private onPlayerDeath(): void {
    this.state = 'dead';
    audio.play('death', this.player.x, this.player.y, { volume: 1 });

    const p = this.player;
    const corpse = new Corpse(p.x, p.y, 'player', 'Your Corpse', 'zombie', 1, '#9aa0a6', 'player', this.rng.next() * 1e9, 1);
    corpse.container.clear();
    // Everything you carried spills into your body.
    for (const it of [...p.inventory.items]) corpse.container.add(it.stack);
    for (let i = 0; i < p.belt.length; i++) {
      const b = p.belt[i];
      if (b) { corpse.container.add(b); p.belt[i] = null; }
    }
    corpse.life = 900;
    this.corpses.push(corpse);

    document.getElementById('death-cause')!.textContent = 'Your run ends here.';
    document.getElementById('death-stats')!.innerHTML = `
      <div>Survived <b>${this.dayNight.day} day${this.dayNight.day === 1 ? '' : 's'}</b></div>
      <div>Zombies killed <b>${p.zombieKills}</b></div>
      <div>Total kills <b>${p.kills}</b></div>
      <div>Items crafted <b>${p.itemsCrafted}</b></div>
      <div>Distance travelled <b>${(p.distanceTravelled / 1000).toFixed(2)} km</b></div>`;
    document.getElementById('death-screen')!.classList.remove('hidden');
    this.inv.close();
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  private render(alpha: number): void {
    if (this.state === 'menu') return;
    this.renderer.draw(alpha);
  }

  /** Nearby biome name for the HUD. */
  get locationName(): string {
    const town = this.world.townAt(this.player.x, this.player.y);
    if (town) return town.name;
    const biome = this.world.biomeAt(this.player.x, this.player.y);
    return BIOME_LABEL[biome];
  }
}

const BIOME_LABEL: Record<Biome, string> = {
  [Biome.Ocean]: 'Open Water',
  [Biome.Beach]: 'Shoreline',
  [Biome.Plains]: 'Plains',
  [Biome.Forest]: 'Forest',
  [Biome.Badlands]: 'Badlands',
  [Biome.Mountain]: 'Mountains',
  [Biome.Tundra]: 'Tundra',
};
