import * as THREE from 'three';
import { CombatSystem } from '../combat/CombatSystem';
import { item } from '../combat/items';
import { EntityManager } from '../entities/EntityManager';
import { PickupManager } from '../entities/Pickups';
import { ProjectileManager } from '../entities/Projectile';
import { Particles } from '../fx/Particles';
import { Inventory, type Stack } from '../player/Inventory';
import { Player } from '../player/Player';
import { readSave, writeSave, type SaveData, SAVE_VERSION } from '../save/Save';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { Block } from '../world/blocks';
import { SEA_LEVEL } from '../world/TerrainGen';
import { World } from '../world/World';
import type { GameContext, LogClass, FloaterClass, ProjectileRequest } from './Context';
import { Input } from './Input';

const SKY_COLOR = 0x8fb6d8;
const RENDER_DISTANCE = 6;
const MAX_FRAME_DT = 1 / 20;

type Mode = 'menu' | 'playing' | 'sheet' | 'dead';

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private input: Input;

  private world: World;
  private player: Player;
  private particles = new Particles();
  private pickups: PickupManager;
  private entities: EntityManager;
  private projectiles = new ProjectileManager();
  private combat = new CombatSystem();
  private hud = new Hud();
  private screens: Screens;

  private ctx: GameContext;
  private mode: Mode = 'menu';
  private elapsed = 0;

  private frameCount = 0;
  private fpsTimer = 0;
  private fps = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(SKY_COLOR);

    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.rotation.order = 'YXZ';

    this.input = new Input(canvas);
    this.hud.setCamera(this.camera);
    this.screens = new Screens(() => this.closeSheet());

    this.scene.background = new THREE.Color(SKY_COLOR);
    // Fog hides chunk pop-in at the streaming frontier.
    const viewDistance = RENDER_DISTANCE * 16;
    this.scene.fog = new THREE.Fog(SKY_COLOR, viewDistance * 0.45, viewDistance * 0.95);

    this.setupLights();

    this.world = new World(randomSeed(), RENDER_DISTANCE);
    this.scene.add(this.world.group);

    this.player = new Player(Inventory.startingKit());

    this.pickups = new PickupManager({
      onXp: (amount) => this.grantXp(amount),
      onItem: (stack) => this.collectItem(stack),
    });
    this.entities = new EntityManager(this.pickups);

    this.scene.add(this.particles.points, this.projectiles.group, this.pickups.group, this.entities.group);

    this.ctx = this.buildContext();
    this.entities.attach(this.ctx);
    this.combat.onPlayerDeath = (source) => this.onPlayerDeath(source);
    this.player.onFallDamage = (amount) =>
      this.combat.damagePlayer(this.ctx, { amount, type: 'blunt', canCrit: false }, this.player.position, 'The fall');

    this.bindUi();
    this.spawnPlayer();

    window.addEventListener('resize', () => this.onResize());
    this.hud.log('You wake at the edge of somewhere unmapped.', 'info');
    this.hud.log('Left-click to attack, X to change how you strike, Tab for your sheet.', 'info');
  }

  // ---------------------------------------------------------------- setup

  private setupLights(): void {
    // Baked AO handles contact shadows, so simple global lighting is enough.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const hemi = new THREE.HemisphereLight(0xbcd8f0, 0x4a4034, 0.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    sun.position.set(0.45, 1, 0.28).normalize();
    this.scene.add(sun);
  }

  private buildContext(): GameContext {
    return {
      world: this.world,
      player: this.player,
      particles: this.particles,
      enemies: this.entities,
      time: 0,
      damagePlayer: (input, from, sourceName) => {
        if (this.invulnerable) return;
        this.combat.damagePlayer(this.ctx, input, from, sourceName);
      },
      spawnProjectile: (req: ProjectileRequest) => this.projectiles.spawn(req),
      alert: (position, radius) => this.entities.alert(position, radius),
      explode: (position, radius, damage, type, pierce, blockDamage, hostile, sourceName) =>
        this.combat.explode(this.ctx, position, radius, damage, type, pierce, blockDamage, hostile, sourceName),
      log: (message, cls: LogClass = 'info') => this.hud.log(message, cls),
      floater: (worldPosition, text, cls: FloaterClass) => this.hud.floater(worldPosition, text, cls),
    };
  }

  private bindUi(): void {
    document.getElementById('play')?.addEventListener('click', () => this.startPlaying());
    document.getElementById('respawn')?.addEventListener('click', () => this.respawn());

    document.addEventListener('pointerlockchange', () => {
      // Losing the pointer (usually Esc) pauses, unless an overlay owns the mouse.
      if (!this.input.locked && this.mode === 'playing') {
        this.mode = 'menu';
        this.hud.setMenuVisible(true);
      }
    });
  }

  /** Finds a habitable spawn column: dry land, above sea level. */
  private spawnPlayer(): void {
    let spawnX = 0;
    let spawnZ = 0;
    search: for (let radius = 0; radius < 40; radius += 4) {
      for (let angle = 0; angle < 8; angle++) {
        const x = Math.round(Math.cos((angle / 8) * Math.PI * 2) * radius);
        const z = Math.round(Math.sin((angle / 8) * Math.PI * 2) * radius);
        const height = this.world.gen.surfaceHeight(x, z);
        if (height > SEA_LEVEL + 2 && height < 50) {
          spawnX = x;
          spawnZ = z;
          break search;
        }
      }
    }

    // Generate the immediate area up front so the player does not fall through.
    this.world.ensureLoadedAround(spawnX, spawnZ, 2);
    this.player.spawnAt(this.world, spawnX, spawnZ);
    this.player.applyToCamera(this.camera);
  }

  // ---------------------------------------------------------------- modes

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private startPlaying(): void {
    this.mode = 'playing';
    this.hud.setMenuVisible(false);
    this.input.requestLock();
  }

  private openSheet(): void {
    this.mode = 'sheet';
    this.input.releaseLock();
    this.screens.open(this.player);
  }

  private closeSheet(): void {
    if (this.mode !== 'sheet') return;
    this.mode = 'playing';
    this.input.requestLock();
  }

  private onPlayerDeath(sourceName: string): void {
    this.mode = 'dead';
    this.input.releaseLock();
    this.hud.showDeath(sourceName, this.player.stats.level);
    this.hud.log(`You were slain by ${sourceName}.`, 'hurt');
  }

  private respawn(): void {
    this.hud.hideDeath();
    this.player.dead = false;
    this.player.stats.resetForRespawn();
    // Death costs progress toward the next level, but never a whole level.
    const penalty = Math.floor((this.player.stats.xp - 0) * 0.05);
    this.player.stats.xp = Math.max(0, this.player.stats.xp - penalty);

    this.entities.clear();
    this.projectiles.clear();
    this.combat.reset();
    this.spawnPlayer();

    this.mode = 'playing';
    this.input.requestLock();
    this.hud.log('You come to, bruised but breathing.', 'good');
  }

  // ---------------------------------------------------------------- rewards

  private grantXp(amount: number): void {
    const levels = this.player.stats.addXp(amount);
    if (levels > 0) {
      this.hud.log(
        `Level ${this.player.stats.level}! ${this.player.stats.unspent} attribute points to spend (Tab).`,
        'good',
      );
      this.particles.burst(this.player.center, 40, 4, {
        color: 0xd5a0ff,
        size: 0.14,
        life: 1.1,
        gravity: -6,
        drag: 1.2,
      });
      this.player.syncEquipmentDerived();
    }
  }

  private collectItem(stack: Stack): boolean {
    const leftover = this.player.inventory.add(stack.itemId, stack.qty);
    const taken = stack.qty - leftover;
    if (taken <= 0) {
      this.hud.log('Your bag is full.', 'info');
      return false;
    }
    const def = item(stack.itemId);
    this.hud.log(`Picked up ${def.name}${taken > 1 ? ` x${taken}` : ''}.`, 'good');

    // Loot is only exciting if it is obviously an upgrade, so say so.
    if (def.kind === 'armor' && def.armor) {
      const current = this.player.inventory.equippedDef('armor');
      if (!current || (current.armor?.armor ?? 0) < def.armor.armor) {
        this.hud.log(`${def.name} is better than what you are wearing — equipping it.`, 'good');
        this.player.inventory.equip(def.id);
        this.player.syncEquipmentDerived();
      }
    }
    return leftover === 0;
  }

  // ---------------------------------------------------------------- frame

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DT);

    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frameCount / this.fpsTimer);
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    this.handleGlobalKeys();

    if (this.mode === 'playing') {
      this.step(dt);
    } else if (this.mode === 'dead') {
      // Keep the world alive behind the death screen.
      this.particles.update(dt);
      this.entities.update(dt, this.ctx);
      this.projectiles.update(dt, this.ctx);
    }

    this.player.applyToCamera(this.camera);
    this.entities.faceCamera(this.camera);

    this.hud.update(this.player, this.combat.hudState(this.ctx), {
      fps: this.fps,
      chunks: this.world.loadedChunkCount,
      entities: this.entities.count,
    });

    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private step(dt: number): void {
    this.elapsed += dt;
    this.ctx.time = this.elapsed;

    this.handlePlayKeys();

    this.world.update(this.player.position.x, this.player.position.z);
    this.combat.update(dt, this.input, this.ctx);
    this.player.update(dt, this.input, this.world);
    this.entities.update(dt, this.ctx);
    this.projectiles.update(dt, this.ctx);
    this.pickups.update(dt, this.ctx);
    this.particles.update(dt);
  }

  private handleGlobalKeys(): void {
    if (this.input.wasPressed('Tab')) {
      if (this.mode === 'playing') this.openSheet();
      else if (this.mode === 'sheet') this.screens.close();
    }
    if (this.input.wasPressed('F5')) void this.save();
    if (this.input.wasPressed('F9')) void this.load();
  }

  private handlePlayKeys(): void {
    const slot = this.input.hotbarPressed();
    if (slot >= 0) {
      this.player.inventory.select(slot);
      this.player.syncEquipmentDerived();
    }
    if (this.input.wheelDelta !== 0) {
      this.player.inventory.cycle(this.input.wheelDelta > 0 ? 1 : -1);
      this.player.syncEquipmentDerived();
    }
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * A snapshot of engine state, for the browser console and the smoke test.
   * Handy when something looks wrong and you need to know whether the problem is
   * the mesher, the streamer, or the spawner.
   */
  debugSnapshot(): Record<string, number | string> {
    return {
      mode: this.mode,
      chunks: this.world.loadedChunkCount,
      pendingChunks: this.world.pendingChunkCount,
      triangles: this.renderer.info.render.triangles,
      drawCalls: this.renderer.info.render.calls,
      enemies: this.entities.count,
      projectiles: this.projectiles.count,
      orbs: this.pickups.orbCount,
      playerX: Number(this.player.position.x.toFixed(2)),
      playerY: Number(this.player.position.y.toFixed(2)),
      playerZ: Number(this.player.position.z.toFixed(2)),
      hp: Number(this.player.stats.hp.toFixed(1)),
      level: this.player.stats.level,
      xp: this.player.stats.xp,
      fps: this.fps,
      seed: this.world.seed,
    };
  }

  /**
   * Test/debug helper: drops an enemy in front of the player, on the ground.
   * Returns the resulting centre-to-centre distance, which is what melee reach
   * is measured against.
   */
  debugSpawnEnemy(distance = 6): number {
    const point = this.player.position.clone().addScaledVector(this.player.facing, distance);
    const ground = this.world.highestSolidY(Math.floor(point.x), Math.floor(point.z));
    if (ground < 0) return -1;
    point.y = ground + 1.05;
    const enemy = this.entities.spawnAt(point, this.player.stats.level);
    return enemy ? enemy.center.distanceTo(this.player.center) : -1;
  }

  /**
   * Test/debug helper: places an enemy at the player's own elevation so melee
   * reach is predictable regardless of terrain slope.
   */
  debugSpawnEnemyInReach(distance = 2.2): number {
    const point = this.player.position.clone().addScaledVector(this.player.facing, distance);
    point.y = this.player.position.y;
    const enemy = this.entities.spawnAt(point, this.player.stats.level);
    return enemy ? enemy.center.distanceTo(this.player.center) : -1;
  }

  /**
   * Test/debug helper: lays a flat cobblestone platform around the player and
   * clears the headroom above it, so tests are not at the mercy of terrain.
   * Uses `record: false` so the platform is not counted as a player edit.
   */
  debugFlattenArena(radius = 7): void {
    const cx = Math.floor(this.player.position.x);
    const cy = Math.floor(this.player.position.y);
    const cz = Math.floor(this.player.position.z);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        this.world.setBlock(cx + dx, cy - 1, cz + dz, Block.Cobble, false);
        for (let dy = 0; dy < 5; dy++) this.world.setBlock(cx + dx, cy + dy, cz + dz, Block.Air, false);
      }
    }
    this.player.position.set(cx + 0.5, cy, cz + 0.5);
    this.player.velocity.set(0, 0, 0);
  }

  /** Test/debug helper: tops up health, stamina, and spell slots. */
  debugRefill(): void {
    this.player.stats.hp = this.player.stats.maxHp;
    this.player.stats.stamina = this.player.stats.maxStamina;
    this.player.stats.guard = this.player.stats.maxGuard;
    this.player.stats.slotsUsed = [0, 0, 0];
  }

  /** Test/debug helper: aims the camera by absolute angles, in radians. */
  debugLook(yaw: number, pitch: number): void {
    this.player.yaw = yaw;
    this.player.pitch = pitch;
  }

  /**
   * Test/debug helper: suspends mouse-look while leaving clicks working. Needed
   * for automation, where synthetic mouse events carry meaningless movement
   * deltas under pointer lock.
   */
  debugSetLookEnabled(on: boolean): void {
    this.input.setLookEnabled(on);
  }

  /** Test/debug helper: per-enemy health and distance, for verifying hit logic. */
  debugEnemyReport(): { name: string; hp: number; maxHp: number; distance: number }[] {
    return this.entities.enemies.map((e) => ({
      name: e.name,
      hp: Number(e.hp.toFixed(1)),
      maxHp: e.maxHp,
      distance: Number(e.center.distanceTo(this.player.center).toFixed(2)),
    }));
  }

  debugClearEnemies(): void {
    this.entities.clear();
  }

  /** Remaining spell slots per tier. */
  debugSpellSlots(): number[] {
    return [1, 2, 3].map((tier) => this.player.stats.slotsAvailable(tier as 1 | 2 | 3));
  }

  /** Points the camera at the ground a few blocks ahead. */
  debugLookDown(): void {
    this.player.pitch = -0.6;
  }

  /** Current stamina, for tests that need to know whether an action can fire. */
  debugStamina(): number {
    return Math.round(this.player.stats.stamina);
  }

  /**
   * Rebuilds every loaded chunk from scratch. Diagnostic: if a shading artifact
   * disappears after this, it was stale geometry meshed against not-yet-loaded
   * neighbours rather than a fault in the mesher itself.
   */
  debugRemeshAll(): number {
    this.world.remeshAll();
    return this.world.flushDirty();
  }

  /** Lifts the player straight up onto a small platform, for overview shots. */
  debugTeleportUp(height: number): void {
    const x = Math.floor(this.player.position.x);
    const z = Math.floor(this.player.position.z);
    const y = Math.floor(this.player.position.y) + height;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.world.setBlock(x + dx, y - 1, z + dz, Block.Planks, false);
    }
    this.player.position.set(x + 0.5, y, z + 0.5);
    this.player.velocity.set(0, 0, 0);
  }

  /**
   * Builds an inside corner of stone next to the player and aims at it. Ambient
   * occlusion is only visible where surfaces meet, so a flat field of grass
   * cannot tell you whether the mesher's AO is working.
   */
  debugBuildAoProbe(): void {
    this.debugFlattenArena(9);
    const x = Math.floor(this.player.position.x);
    const y = Math.floor(this.player.position.y);
    const z = Math.floor(this.player.position.z);

    // Two walls meeting at a right angle, plus a floor, four blocks ahead.
    const ox = x + 1;
    const oz = z - 5;
    for (let h = 0; h < 4; h++) {
      for (let i = -4; i <= 4; i++) {
        this.world.setBlock(ox + i, y + h, oz, Block.Stone, false);
        this.world.setBlock(ox - 4, y + h, oz + i + 4, Block.Stone, false);
      }
    }
    // A few isolated blocks and a step, so AO shows on convex edges too.
    this.world.setBlock(ox, y, oz + 3, Block.Planks, false);
    this.world.setBlock(ox + 1, y, oz + 3, Block.Planks, false);
    this.world.setBlock(ox, y + 1, oz + 3, Block.Planks, false);
    this.world.setBlock(ox + 2, y, oz + 2, Block.Brick, false);
    this.world.setBlock(ox - 2, y, oz + 2, Block.Torchstone, false);

    this.player.pitch = -0.12;
    this.player.yaw = 0;
  }

  /**
   * Per-enemy health bar state. `facing` is 1.0 when the bar squarely faces the
   * camera; anything materially lower means the billboard is being skewed by a
   * parent transform and the bar will look wrong or vanish edge-on.
   */
  debugHealthBars(): { visible: boolean; facing: number }[] {
    const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.camera.getWorldQuaternion(new THREE.Quaternion()),
    );
    return this.entities.enemies.map((enemy) => {
      const { visible, worldQuaternion } = enemy.healthBarDebug;
      const barNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuaternion);
      return { visible, facing: Number(barNormal.dot(cameraForward.clone().negate()).toFixed(3)) };
    });
  }

  /** Combat counters plus the last reason an action was refused. */
  debugCombatDiag(): Record<string, unknown> {
    const active = this.player.inventory.activeItem;
    const modeCount = active?.weapon?.melee.length ?? 0;
    return {
      ...this.combat.diag,
      activeItem: this.player.inventory.activeItemId,
      modeIndex: active ? this.player.inventory.attackModeIndex(active.id, modeCount) : -1,
      modeCount,
      stamina: Math.round(this.player.stats.stamina),
      pitch: Number(this.player.pitch.toFixed(2)),
      yaw: Number(this.player.yaw.toFixed(2)),
      mode: this.mode,
    };
  }

  /** The block currently under the crosshair, if any. */
  debugTargetBlock(): { x: number; y: number; z: number; block: number } | null {
    const hit = this.world.raycast(this.player.eyePosition, this.player.lookDirection, 6);
    return hit ? { x: hit.x, y: hit.y, z: hit.z, block: hit.block } : null;
  }

  /** Total number of player-edited voxels, across all chunks. */
  debugEditedBlockCount(): number {
    return this.world.collectEdits().reduce((sum, record) => sum + record.edits.length / 2, 0);
  }

  debugItemCount(itemId: string): number {
    return this.player.inventory.count(itemId);
  }

  /** Test/debug helper: keeps the player alive while exercising other systems. */
  debugSetInvulnerable(on: boolean): void {
    this.invulnerable = on;
  }

  private invulnerable = false;

  get godMode(): boolean {
    return this.invulnerable;
  }

  // ---------------------------------------------------------------- persistence

  private async save(): Promise<void> {
    if (this.player.dead) {
      this.hud.log('Cannot save while dead — respawn first.', 'info');
      return;
    }
    try {
      const data: SaveData = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        seed: this.world.seed,
        player: {
          x: this.player.position.x,
          y: this.player.position.y,
          z: this.player.position.z,
          yaw: this.player.yaw,
          pitch: this.player.pitch,
        },
        stats: this.player.stats.snapshot(),
        inventory: this.player.inventory.snapshot(),
        edits: this.world.collectEdits(),
      };
      await writeSave(data);
      this.hud.log(`Saved. (${data.edits.length} edited chunks)`, 'good');
    } catch (error) {
      this.hud.log(`Save failed: ${(error as Error).message}`, 'hurt');
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await readSave();
      if (!data) {
        this.hud.log('No save found. Press F5 to make one.', 'info');
        return;
      }

      // A different seed means a different world, so rebuild it from scratch.
      if (data.seed !== this.world.seed) {
        this.scene.remove(this.world.group);
        this.world.clear();
        this.world = new World(data.seed, RENDER_DISTANCE);
        this.scene.add(this.world.group);
        this.ctx.world = this.world;
      }

      this.world.applyEdits(data.edits);

      this.player.stats.restore(data.stats);
      this.player.inventory.restore(data.inventory);
      this.player.syncEquipmentDerived();
      this.player.dead = false;
      this.player.position.set(data.player.x, data.player.y, data.player.z);
      this.player.velocity.set(0, 0, 0);
      this.player.yaw = data.player.yaw;
      this.player.pitch = data.player.pitch;

      this.world.ensureLoadedAround(Math.floor(data.player.x), Math.floor(data.player.z), 2);

      this.entities.clear();
      this.projectiles.clear();
      this.pickups.clear();
      this.particles.clear();
      this.combat.reset();
      this.hud.hideDeath();
      if (this.mode === 'dead') {
        this.mode = 'playing';
        this.input.requestLock();
      }

      this.hud.log('Loaded your last save.', 'good');
    } catch (error) {
      this.hud.log(`Load failed: ${(error as Error).message}`, 'hurt');
    }
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
