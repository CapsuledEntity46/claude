import * as THREE from 'three';
import { CombatSystem } from '../combat/CombatSystem';
import { blockCollisionBoxes, blockDef } from '../world/blocks';
import { makeMeta, shapeBoxes } from '../world/shapes';
import { item, tryItem } from '../combat/items';
import { EntityManager } from '../entities/EntityManager';
import { PickupManager } from '../entities/Pickups';
import { ProjectileManager } from '../entities/Projectile';
import { BlockHighlight } from '../fx/BlockHighlight';
import { LightManager } from '../fx/LightManager';
import { Particles } from '../fx/Particles';
import { Rain } from '../fx/Rain';
import { Celestial } from '../fx/Celestial';
import { propsForSite } from '../world/DungeonProps';
import { PropManager } from '../fx/PropManager';
import { Starfield } from '../fx/Starfield';
import { Trail } from '../fx/Trail';
import { TrajectoryArc } from '../fx/TrajectoryArc';
import { ViewModel } from '../fx/ViewModel';
import { Inventory, type Stack } from '../player/Inventory';
import { Player } from '../player/Player';
import { readSave, writeSave, type SaveData, SAVE_VERSION } from '../save/Save';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { Block } from '../world/blocks';
import { SEA_LEVEL } from '../world/TerrainGen';
import { TimeOfDay } from '../world/TimeOfDay';
import { Weather } from '../world/Weather';
import { World } from '../world/World';
import type { GameContext, LogClass, FloaterClass, ProjectileRequest } from './Context';
import { Input } from './Input';

const SKY_COLOR = 0x8fb6d8;
/** Stepped ember palette for torch flames. */
const EMBER_COLORS = [0xfff0c0, 0xffc050, 0xff8a28, 0xd8541a] as const;

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

  private time = new TimeOfDay();
  private weather = new Weather();
  private rain = new Rain();
  private stars = new Starfield();
  private celestial = new Celestial();
  private props = new PropManager();
  private lights = new LightManager();
  private highlight = new BlockHighlight();
  private trails = new Trail();
  private arc = new TrajectoryArc();
  private viewModel: ViewModel;
  /** Base camera field of view, restored when not aiming. */
  private readonly baseFov = 78;

  /** Reused colour scratch, so the render loop allocates nothing. */
  private readonly skyColor = new THREE.Color();
  private readonly fogColorScratch = new THREE.Color();
  private readonly lightColorScratch = new THREE.Color();
  private readonly sunDirection = new THREE.Vector3();
  private underwater = false;

  private ctx: GameContext;
  private mode: Mode = 'menu';
  private elapsed = 0;

  private frameCount = 0;
  private fpsTimer = 0;
  private fps = 0;

  /**
   * Render stats for the world pass only.
   *
   * three.js resets `renderer.info` at the start of every render call, so after
   * the view model draws, `info.render` describes just the held weapon. Anything
   * reporting world geometry has to snapshot the counters in between.
   */
  private worldRenderStats = { triangles: 0, calls: 0 };

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

    this.viewModel = new ViewModel(78, window.innerWidth / window.innerHeight);
    this.setupLights();
    this.scene.add(
      this.stars.points,
      this.celestial.group,
      this.props.group,
      this.rain.lines,
      this.lights.group,
      this.highlight.group,
      this.trails.mesh,
      this.arc.group,
    );

    // Rain kicks up a little spray where it lands.
    this.rain.onSplash = (x, y, z) => {
      if (Math.random() > 0.06) return;
      this.particles.spawn(
        new THREE.Vector3(x, y + 0.05, z),
        new THREE.Vector3((Math.random() - 0.5) * 1.2, 1 + Math.random(), (Math.random() - 0.5) * 1.2),
        { color: 0xa8c0d4, size: 0.05, life: 0.28, gravity: 16 },
      );
    };

    this.world = new World(randomSeed(), RENDER_DISTANCE);
    this.scene.add(this.world.group);

    this.player = new Player(Inventory.startingKit());

    this.pickups = new PickupManager({
      onXp: (amount) => this.grantXp(amount),
      onMana: (amount) => {
        const restored = this.player.stats.restoreMana(amount);
        if (restored > 0) this.hud.log(`Absorbed ${Math.round(restored)} mana.`, 'magic');
      },
      onItem: (stack) => this.collectItem(stack),
    });
    this.entities = new EntityManager(this.pickups);

    this.scene.add(this.particles.points, this.projectiles.group, this.pickups.group, this.entities.group);

    this.ctx = this.buildContext();
    this.entities.attach(this.ctx);
    this.combat.onPlayerDeath = (source) => this.onPlayerDeath(source);
    // Routed through the context rather than straight into the combat system, so
    // it passes the same guards as every other damage source. Calling the combat
    // system directly meant falling ignored invulnerability entirely.
    this.player.onFallDamage = (amount) =>
      this.ctx.damagePlayer({ amount, type: 'blunt', canCrit: false }, this.player.position, 'The fall');

    this.bindUi();
    this.spawnPlayer();

    window.addEventListener('resize', () => this.onResize());
    this.hud.log('You wake at the edge of somewhere unmapped.', 'info');
    this.hud.log('Left-click to attack, X to change how you strike, Tab for your sheet.', 'info');
  }

  // ---------------------------------------------------------------- setup

  private ambient!: THREE.AmbientLight;
  private hemisphere!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;

  private setupLights(): void {
    // Baked AO handles contact shadows, so simple global lighting is enough.
    // Intensities and colours are driven by the day/night cycle each frame.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.hemisphere = new THREE.HemisphereLight(0xbcd8f0, 0x4a4034, 0.7);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    this.sun.position.set(0.45, 1, 0.28);
    this.scene.add(this.ambient, this.hemisphere, this.sun);
  }

  /**
   * Applies the time of day and current weather to sky, fog, and lighting.
   * Also handles the underwater case, which overrides everything else.
   */
  private updateEnvironment(dt: number): void {
    this.time.update(dt);
    this.weather.update(dt);

    const daylight = this.time.daylight;
    // Published here rather than in step() so that anything reading the context
    // — spawn caps, enemy sight — sees the current time even when the
    // environment is updated outside the normal simulation tick.
    this.ctx.daylight = daylight;
    this.ctx.raining = this.weather.isRaining;
    const dim = this.weather.dim;

    this.time.skyColor(this.skyColor).multiplyScalar(1 - dim * 0.72);
    this.time.fogColor(this.fogColorScratch).multiplyScalar(1 - dim * 0.45);
    this.time.lightColor(this.lightColorScratch);

    this.sun.position.copy(this.time.lightDirection(this.sunDirection)).multiplyScalar(100);
    this.sun.color.copy(this.lightColorScratch);
    this.sun.intensity = this.time.sunIntensity * (1 - dim * 0.7);
    this.ambient.intensity = this.time.ambientIntensity * (1 - dim * 0.3);
    this.hemisphere.intensity = this.time.hemisphereIntensity * (1 - dim * 0.4);

    const eye = this.player.eyePosition;
    this.underwater = this.world.getBlock(
      Math.floor(eye.x),
      Math.floor(eye.y),
      Math.floor(eye.z),
    ) === Block.Water;

    const fog = this.scene.fog as THREE.Fog;
    const viewDistance = RENDER_DISTANCE * 16;

    if (this.underwater) {
      // Murky and close: being submerged should feel like a different place.
      this.skyColor.setRGB(0.06, 0.18, 0.3);
      fog.color.setRGB(0.05, 0.16, 0.28);
      fog.near = 0.4;
      fog.far = 16;
      this.ambient.intensity = 0.32 + daylight * 0.28;
    } else {
      fog.color.copy(this.fogColorScratch);
      // Weather pulls the fog plane in; fog weather does it hardest.
      const tighten = this.weather.fogTighten;
      fog.near = viewDistance * (0.45 - tighten * 0.42);
      fog.far = viewDistance * (0.95 - tighten * 0.72);
    }

    (this.scene.background as THREE.Color).copy(this.skyColor);
    this.renderer.setClearColor(this.skyColor);

    // Dungeon furniture. Rebuilds only when the set of nearby sites changes, so
    // this is a cheap comparison on almost every frame.
    this.props.update(this.player.position, this.world.gen.dungeons);

    this.stars.update(eye, this.underwater ? 0 : this.time.starOpacity * (1 - dim));
    // Sun and moon ride the same shell as the stars. Hidden underwater, where the
    // surface should be all you can see looking up.
    this.celestial.group.visible = !this.underwater;
    if (!this.underwater) {
      this.celestial.update(eye, this.time.sunDirection(), this.time.daylight * (1 - dim));
    }

    // Rain, and the lights that matter once it gets dark.
    this.rain.setBrightness(0.35 + daylight * 0.65);
    this.rain.update(dt, this.world, this.player.position, this.underwater ? 0 : this.weather.rainRate);
    const torchPosition = this.worldTorchPosition();
    this.lights.update(this.world, eye, torchPosition, 1 - daylight);
    this.updateTorchEmbers(dt, torchPosition);
  }

  private emberTimer = 0;

  /**
   * Embers rising from live flames: the one in your hand, and any planted torches
   * close enough to notice. Emission is throttled rather than per-frame, so a
   * corridor lined with torches does not flood the particle pool.
   */
  private updateTorchEmbers(dt: number, handPosition: THREE.Vector3 | null): void {
    this.emberTimer -= dt;
    if (this.emberTimer > 0) return;
    this.emberTimer = 0.07;

    const spawnEmber = (x: number, y: number, z: number, scale: number, life: number) => {
      this.particles.spawn(
        new THREE.Vector3(x + (Math.random() - 0.5) * 0.12 * scale, y, z + (Math.random() - 0.5) * 0.12 * scale),
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.35 * scale,
          (0.7 + Math.random() * 0.9) * scale,
          (Math.random() - 0.5) * 0.35 * scale,
        ),
        {
          // A stepped flame palette rather than a blend, to match the blocky look.
          color: EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)],
          size: (0.055 + Math.random() * 0.035) * scale,
          life,
          gravity: -1.8 * scale,
          drag: 1.6,
        },
      );
    };

    // The held torch's own embers are *not* emitted here. They live in the view
    // model's scene, which is rendered through a narrower camera — a point shared
    // between the two spaces lands on two different pixels, so world-space sparks
    // visibly drifted away from the flame throwing them. Scaling them by distance
    // (an earlier attempt at the same problem) only fixed their size, not the
    // offset, and overshot into specks.
    void handPosition;

    // Planted torches: only the nearest few, and only some of the time.
    const nearby = this.world.nearestLightSources(this.player.eyePosition, 18, 5);
    for (const light of nearby) {
      if (this.world.getBlock(light.x, light.y, light.z) !== Block.Torch) continue;
      if (Math.random() > 0.45) continue;
      spawnEmber(light.x + 0.5, light.y + 0.72, light.z + 0.5, 1, 0.5 + Math.random() * 0.35);
    }
  }

  /**
   * Where the held torch's flame sits in world space.
   *
   * The view model lives in camera space, so its flame position has to be
   * transformed out to the world before a light can be placed there.
   */
  private worldTorchPosition(): THREE.Vector3 | null {
    if (!this.viewModel.hasTorch) return null;
    const local = this.viewModel.torchFlameLocalPosition;
    if (!local) return null;
    return local.clone().applyMatrix4(this.camera.matrixWorld);
  }

  private buildContext(): GameContext {
    return {
      world: this.world,
      player: this.player,
      particles: this.particles,
      enemies: this.entities,
      time: 0,
      daylight: 1,
      raining: false,
      damagePlayer: (input, from, sourceName) => {
        if (this.invulnerable) return;
        this.combat.damagePlayer(this.ctx, input, from, sourceName);
      },
      spawnProjectile: (req: ProjectileRequest) => this.projectiles.spawn(req, this.trails),
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
      this.updateEnvironment(dt);
    }

    this.player.applyToCamera(this.camera);
    this.camera.updateMatrixWorld();
    this.entities.faceCamera(this.camera);
    this.pickups.faceCamera(this.camera.quaternion);

    this.updateMinimap(dt);
    this.hud.update(this.player, this.combat.hudState(this.ctx), {
      fps: this.fps,
      chunks: this.world.loadedChunkCount,
      entities: this.entities.hostileCount,
      clock: this.time.clockLabel(),
      phase: this.time.phaseLabel(),
      weather: this.weather.label(),
      underwater: this.underwater,
    });

    this.renderer.render(this.scene, this.camera);
    this.worldRenderStats.triangles = this.renderer.info.render.triangles;
    this.worldRenderStats.calls = this.renderer.info.render.calls;

    // The held item is drawn last, over a cleared depth buffer, so it is never
    // sliced open by a wall the player is standing against.
    if (!this.viewModelHidden) this.viewModel.render(this.renderer);
    this.input.endFrame();
  }

  private step(dt: number): void {
    this.elapsed += dt;
    this.ctx.time = this.elapsed;

    this.handlePlayKeys();

    // Environment first: spawn pressure and enemy sight both read daylight.
    this.updateEnvironment(dt);

    this.world.update(this.player.position.x, this.player.position.z);
    this.combat.update(dt, this.input, this.ctx);
    this.player.update(dt, this.input, this.world);
    this.entities.update(dt, this.ctx);
    this.projectiles.update(dt, this.ctx);
    this.pickups.update(dt, this.ctx);
    this.particles.update(dt);

    this.updateBlockHighlight();
    this.updateViewModel(dt);
    this.updateAiming(dt);
    this.updateSwingTrail();
    this.trails.update(dt, this.player.eyePosition);
  }

  /** Outlines the block under the crosshair and cracks it as it breaks. */
  private updateBlockHighlight(): void {
    const state = this.combat.highlightState();
    if (!state) {
      this.highlight.hide();
      return;
    }
    this.highlight.show(state.x, state.y, state.z, state.progress);
  }

  /**
   * Aim-down-sights: narrows the field of view and previews the flight path.
   * The preview is traced with the projectile's own integration, so it cannot
   * disagree with where the shot actually goes.
   */
  private updateAiming(dt: number): void {
    const aim = this.combat.aimState(this.ctx);
    const targetFov = aim ? this.baseFov / aim.zoom : this.baseFov;

    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 11);
      this.camera.updateProjectionMatrix();
    }

    if (!aim) {
      this.arc.hide();
      return;
    }
    this.arc.show(this.world, aim.origin, aim.direction, aim.speed, aim.gravityScale);
  }

  /** Handle of the ribbon currently tracing a melee swing, or -1. */
  private swingTrailHandle = -1;

  /**
   * Traces the weapon tip while an attack is in motion.
   *
   * Only during the strike itself, not the wind-up: a trail on the wind-up would
   * imply the blade is already travelling, which misreads the timing the player
   * is supposed to learn.
   */
  private updateSwingTrail(): void {
    const view = this.combat.viewState(this.ctx);
    const striking = (view.action === 'swing' || view.action === 'thrust') && view.phase === 'recovery';

    if (!striking) {
      if (this.swingTrailHandle >= 0) {
        this.trails.release(this.swingTrailHandle);
        this.swingTrailHandle = -1;
      }
      return;
    }

    this.viewModel.refreshMatrices();
    const tip = this.viewModel.weaponTipWorldPosition(this.camera.matrixWorld);
    if (!tip) return;

    if (this.swingTrailHandle < 0) {
      const wide = view.action === 'swing';
      this.swingTrailHandle = this.trails.spawn(wide ? 0xdfe8ff : 0xfff0d0, wide ? 0.3 : 0.16, 0.42);
    }
    if (this.swingTrailHandle >= 0) this.trails.push(this.swingTrailHandle, tip);
  }

  private updateViewModel(dt: number): void {
    const view = this.combat.viewState(this.ctx);
    const inventory = this.player.inventory;
    this.viewModel.update(dt, {
      action: view.action,
      phase: view.phase,
      progress: view.progress,
      draw: view.draw,
      blocking: this.player.blocking,
      mainItemId: inventory.activeItemId ?? inventory.equipped.weapon,
      shieldItemId: inventory.equipped.shield,
      torchItemId: inventory.equipped.torch,
      attackMode: view.attackMode,
      speed: Math.hypot(this.player.velocity.x, this.player.velocity.z),
      shotCounter: view.shotCounter,
      daylight: this.time.daylight,
      lookDx: this.input.mouseDX,
      lookDy: this.input.mouseDY,
    });
  }

  /** Feeds the minimap the terrain, enemies, and the nearest dungeon entrance. */
  private updateMinimap(dt: number): void {
    const markers: { x: number; z: number; kind: 'enemy' | 'dungeon' }[] = [];
    for (const enemy of this.entities.enemies) {
      if (enemy.dead || enemy.archetype.passive) continue;
      markers.push({ x: enemy.position.x, z: enemy.position.z, kind: 'enemy' });
    }
    const entrance = this.world.gen.dungeons.nearestEntrance(this.player.position.x, this.player.position.z);
    if (entrance) markers.push({ x: entrance.x, z: entrance.z, kind: 'dungeon' });

    this.hud.minimap.update(dt, this.world, this.player.position, this.player.yaw, markers, this.time.daylight);
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
    const aspect = window.innerWidth / window.innerHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewModel.setAspect(aspect);
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
      triangles: this.worldRenderStats.triangles,
      drawCalls: this.worldRenderStats.calls,
      enemies: this.entities.count,
      projectiles: this.projectiles.count,
      projectilesFired: this.projectiles.spawnedTotal,
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
  /** Spawns one named archetype ahead of the player, for model screenshots. */
  debugSpawnArchetype(archetypeId: string, distance = 5): boolean {
    const point = this.player.position.clone().addScaledVector(this.player.facing, distance);
    point.y = this.player.position.y;
    return !!this.entities.spawnArchetypeAt(point, archetypeId, this.player.stats.level);
  }

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

  /**
   * Test hook: clears the death state and puts the player back in control.
   *
   * Debug teleports can drop the player and kill them, and nothing else clears the
   * overlay — which left every subsequent screenshot with a stale "You Died"
   * banner across it.
   */
  debugRevive(): void {
    this.player.dead = false;
    this.player.stats.resetForRespawn();
    this.hud.hideDeath();
    if (this.mode === 'dead') this.mode = 'playing';
  }

  /** Test hook: removes the ground under the player, to exercise falling. */
  debugDropPlayer(): void {
    const x = Math.floor(this.player.position.x);
    const y = Math.floor(this.player.position.y);
    const z = Math.floor(this.player.position.z);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) this.world.setBlock(x + dx, y - 1, z + dz, Block.Air, false);
    }
  }

  /** True while the death overlay is showing. */
  debugIsDead(): boolean {
    return this.player.dead || this.mode === 'dead';
  }

  /** Test hook: freezes enemy AI so attack geometry is deterministic. */
  debugFreezeEnemies(frozen: boolean): void {
    this.entities.frozen = frozen;
  }

  /** Test hook: clears any in-progress block mining. */
  debugResetMining(): void {
    this.combat.debugResetMining();
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

  /** Jumps to a point in the day/night cycle. */
  debugSetTime(phase: 'dawn' | 'day' | 'dusk' | 'night'): void {
    this.time.setPhase(phase);
    this.updateEnvironment(0);
  }

  /** Forces a weather state immediately. */
  debugSetWeather(kind: 'clear' | 'fog' | 'rain' | 'storm', intensity = 1): void {
    this.weather.force(kind, intensity);
    this.updateEnvironment(0);
  }

  /** Stops the clock, so screenshots are reproducible. */
  debugFreezeTime(frozen: boolean): void {
    this.time.running = !frozen;
  }

  /** Environment readouts for tests. */
  debugEnvironment(): Record<string, unknown> {
    return {
      clock: this.time.clockLabel(),
      phase: this.time.phaseLabel(),
      daylight: Number(this.time.daylight.toFixed(3)),
      starOpacity: Number(this.time.starOpacity.toFixed(3)),
      weather: this.weather.label(),
      rainRate: Math.round(this.weather.rainRate),
      raining: this.weather.isRaining,
      underwater: this.underwater,
      lightSources: this.world.lightSourceCount,
      hostiles: this.entities.hostileCount,
      fish: this.entities.fishCount,
      hostileCap: this.entities.debugHostileCap(this.ctx),
    };
  }

  /** View model animation state, for verifying swing/thrust are distinct. */
  debugViewState(): Record<string, unknown> {
    const view = this.combat.viewState(this.ctx);
    return {
      action: view.action,
      phase: view.phase,
      progress: Number(view.progress.toFixed(3)),
      draw: Number(view.draw.toFixed(3)),
      attackMode: view.attackMode,
      shots: view.shotCounter,
      mainItem: this.player.inventory.activeItemId,
      torch: this.player.inventory.equipped.torch,
      shield: this.player.inventory.equipped.shield,
      // Which diagonal each recent slash cut along. Consecutive swings alternate,
      // so that together they trace an X.
      swingDirections: [...this.viewModel.recentSwingDirections],
      torchEmbers: this.viewModel.emberCount,
    };
  }

  /**
   * How far the held weapon's tip is from the crosshair, in normalised device
   * coordinates — (0,0) is dead centre, 1 is half the viewport.
   *
   * Lets "the thrust points where you are aiming" be measured rather than
   * approximated. The old proxy (the hand moves towards centre) passed while the
   * point still sat visibly low and to the right of the crosshair.
   */
  debugTipOffset(): { x: number; y: number } | null {
    return this.viewModel.tipScreenOffset();
  }

  /** Sun and moon state, for verifying the sky. */
  debugCelestial(): Record<string, unknown> {
    return this.celestial.debugState();
  }

  /**
   * Whether terrain is actually sampling the block atlas.
   *
   * Textures are easy to get wrong in ways that look like "no change": a missing UV
   * attribute, a null map, or UVs that all land on the blank tile each produce
   * exactly the flat-coloured world that existed before. This reports the plumbing
   * instead of leaving it to be judged by eye.
   */
  debugTerrainMaterial(): Record<string, unknown> {
    return this.world.debugMaterialState();
  }

  /** Per-tile contrast of the block atlas, for telling a flat tile from a missing one. */
  debugAtlasStats(): Record<string, unknown> {
    return this.world.debugAtlasStats();
  }

  /** Dungeon prop counts by kind, for verifying the kit is being placed. */
  debugProps(): Record<string, unknown> {
    return this.props.debugState();
  }

  /** What the placement code produces for the nearest site, for diagnosis. */
  debugPropSample(): Record<string, unknown> {
    const dungeons = this.world.gen.dungeons;
    const site = dungeons.sitesNear(
      this.player.position.x - 200,
      this.player.position.z - 200,
      this.player.position.x + 200,
      this.player.position.z + 200,
    )[0];
    if (!site) return { site: null };
    const props = propsForSite(site, dungeons.seed);
    const counts: Record<string, number> = {};
    for (const p of props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    const room = site.rooms[0];
    return {
      site: `${site.gx},${site.gz}`,
      rooms: site.rooms.length,
      firstRoom: { w: room.width, d: room.depth, h: room.height, floorY: room.floorY },
      total: props.length,
      counts,
      first: props.slice(0, 4),
    };
  }

  /** Block highlight state, for verifying the mining animation advances. */
  debugHighlight(): Record<string, unknown> | null {
    const state = this.combat.highlightState();
    if (!state) return null;
    return { ...state, progress: Number(state.progress.toFixed(3)), visible: true };
  }

  /** Spawns fish in the nearest water, for testing the hunting loop. */
  debugSpawnFish(): number {
    return this.entities.debugSpawnFishNear(this.ctx);
  }

  /**
   * Teleports to the nearest dungeon entrance, for testing.
   *
   * Lands a few blocks back from the mouth on solid ground. Dropping the player
   * into the opening itself meant arriving mid-air over a stairwell.
   */
  debugGoToDungeon(): { x: number; y: number; z: number } | null {
    const dungeons = this.world.gen.dungeons;
    const entrance = dungeons.nearestEntrance(this.player.position.x, this.player.position.z, 600);
    if (!entrance) return null;

    const site = dungeons
      .sitesNear(entrance.x - 2, entrance.z - 2, entrance.x + 2, entrance.z + 2)
      .find((candidate) => candidate.entranceX === entrance.x && candidate.entranceZ === entrance.z);

    // Stand back along the uphill side, facing the mouth.
    const backX = Math.floor(entrance.x + (site?.entranceDirX ?? 0) * 4);
    const backZ = Math.floor(entrance.z + (site?.entranceDirZ ?? 1) * 4);

    this.world.ensureLoadedAround(backX, backZ, 2);
    this.player.spawnAt(this.world, backX, backZ);
    this.player.yaw = Math.atan2(-(entrance.x - backX), -(entrance.z - backZ));
    this.player.pitch = -0.18;
    return { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z };
  }

  /** Dungeon layout summary near the player, for tests. */
  debugDungeonInfo(): Record<string, unknown> {
    const dungeons = this.world.gen.dungeons;
    const nearest = dungeons.nearestEntrance(this.player.position.x, this.player.position.z, 600);
    const sites = dungeons.sitesNear(
      this.player.position.x - 300,
      this.player.position.z - 300,
      this.player.position.x + 300,
      this.player.position.z + 300,
    );
    return {
      sitesNearby: sites.length,
      rooms: sites.reduce((sum, site) => sum + site.rooms.length, 0),
      corridors: sites.reduce((sum, site) => sum + site.corridors.length, 0),
      vaults: sites.reduce((sum, site) => sum + site.rooms.filter((r) => r.vault).length, 0),
      nearestEntranceDistance: nearest ? Math.round(nearest.distance) : -1,
      spawnPoints: dungeons.spawnPointsNear(this.player.position.x, this.player.position.z, 64).length,
      insideDungeon: dungeons.isInsideDungeon(
        this.player.position.x,
        this.player.position.y,
        this.player.position.z,
      ),
    };
  }

  /** Mana readouts for tests. */
  debugMana(): Record<string, number> {
    return {
      mana: Math.round(this.player.stats.mana),
      maxMana: this.player.stats.maxMana,
      trails: this.trails.activeCount,
    };
  }

  debugSetMana(value: number): void {
    this.player.stats.mana = Math.max(0, Math.min(this.player.stats.maxMana, value));
  }

  /** Aim state, for verifying zoom and the arc preview. */
  debugAim(): Record<string, unknown> {
    const aim = this.combat.aimState(this.ctx);
    return {
      aiming: !!aim,
      zoom: aim?.zoom ?? 1,
      fov: Number(this.camera.fov.toFixed(2)),
      arcVisible: this.arc.group.visible,
    };
  }

  /** Shape details of the most recently placed instance of an item's block. */
  debugPlacedShape(itemId: string): Record<string, unknown> | null {
    const def = tryItem(itemId);
    if (!def || def.block === undefined) return null;
    const centre = this.player.position;
    // Search the immediate area for the block we just placed.
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = Math.floor(centre.x) + dx;
          const y = Math.floor(centre.y) + dy;
          const z = Math.floor(centre.z) + dz;
          if (this.world.getBlock(x, y, z) !== def.block) continue;
          const meta = this.world.getMeta(x, y, z);
          const blockDefinition = blockDef(def.block);
          const boxes = shapeBoxes(blockDefinition.shape, meta);
          const fillsVoxel =
            boxes.length === 1 &&
            boxes[0].min.every((v) => v === 0) &&
            boxes[0].max.every((v) => v === 1);
          this.lastProbedBlock = { x, y, z };
          return {
            shape: blockDefinition.shape,
            meta,
            boxes: boxes.length,
            fillsVoxel,
            blocks: blockCollisionBoxes(def.block, meta).length > 0,
            at: [x, y, z],
          };
        }
      }
    }
    return null;
  }

  private lastProbedBlock: { x: number; y: number; z: number } | null = null;

  /** Opens the door found by the last debugPlacedShape probe. */
  debugToggleNearestDoor(): boolean {
    const at = this.lastProbedBlock;
    if (!at) return false;
    return this.world.toggleBlock(at.x, at.y, at.z);
  }

  /** Sets the build tool's shape mode. */
  debugSetToolMode(mode: 'single' | 'line' | 'wall' | 'box' | 'floor'): void {
    this.combat.debugSetToolMode(mode);
  }

  /** Builds a small structure showing off every shaped material, for screenshots. */
  debugBuildShowcase(): void {
    this.debugFlattenArena(16);
    const ox = Math.floor(this.player.position.x) - 3;
    const oy = Math.floor(this.player.position.y);
    const oz = Math.floor(this.player.position.z) - 10;
    const put = (x: number, y: number, z: number, id: Block, meta = 0) =>
      this.world.setBlock(x, y, z, id, false, meta);

    const width = 7;
    const depth = 6;

    // Floor and walls.
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        put(ox + x, oy - 1, oz + z, Block.Planks);
        const wall = x === 0 || x === width - 1 || z === 0 || z === depth - 1;
        for (let y = 0; y < 3; y++) {
          put(ox + x, oy + y, oz + z, wall ? Block.Brick : Block.Air);
        }
      }
    }

    // Doorway in the front wall, with windows either side.
    const doorX = ox + 3;
    const frontZ = oz + depth - 1;
    put(doorX, oy, frontZ, Block.Door, makeMeta(2));
    put(doorX, oy + 1, frontZ, Block.Door, makeMeta(2));
    put(ox + 1, oy + 1, frontZ, Block.Window, makeMeta(2));
    put(ox + 5, oy + 1, frontZ, Block.Window, makeMeta(2));
    put(ox + 1, oy + 1, oz, Block.Window, makeMeta(0));
    put(ox + 5, oy + 1, oz, Block.Window, makeMeta(0));

    // A gable roof: each course is a full row of wedges, stepping inward and up,
    // so the slope is continuous instead of a row of floating flaps.
    const ridge = Math.floor(width / 2);
    for (let step = 0; step <= ridge; step++) {
      for (let z = -1; z <= depth; z++) {
        const y = oy + 3 + step;
        if (step < ridge) {
          // Both slopes, facing outward from the ridge.
          put(ox + step, y, oz + z, Block.Shingles, makeMeta(3));
          put(ox + width - 1 - step, y, oz + z, Block.Shingles, makeMeta(1));
          // Fill the interior of the course so there is no gap to see through.
          for (let x = step + 1; x < width - 1 - step; x++) {
            put(ox + x, y, oz + z, step === 0 ? Block.Air : Block.Planks);
          }
        } else {
          put(ox + ridge, y, oz + z, Block.PlankSlab, makeMeta(0));
        }
      }
    }

    // Steps up to the door, each one block higher than the last.
    for (let i = 0; i < 3; i++) {
      put(doorX, oy - 1 + i, frontZ + 3 - i, Block.StoneStairs, makeMeta(2));
    }

    // A fenced porch either side of the steps.
    for (let x = 0; x < width; x++) {
      if (ox + x === doorX) continue;
      put(ox + x, oy, frontZ + 2, Block.Fence, makeMeta(0));
    }

    // A slab path leading away, laid *on* the ground rather than flush with it.
    for (let z = 4; z < 10; z++) put(doorX, oy, frontZ + z, Block.PlankSlab, makeMeta(0));

    // Stand back on the path, looking at the front of the house. Forward is
    // (-sin yaw, 0, -cos yaw), so yaw 0 looks towards smaller Z — which is where
    // the house is from here.
    this.player.position.set(doorX + 0.5, oy + 1.05, frontZ + 12.5);
    this.player.velocity.set(0, 0, 0);
    this.player.yaw = 0;
    this.player.pitch = -0.02;
  }

  /**
   * Stands at one end of a furnished dungeon room, looking across it.
   *
   * `debugDescendDungeon` drops you in the middle of the room, which puts your face
   * against whatever furniture is nearest. This backs off to the wall so the whole
   * room — columns, braziers, banners — is in frame.
   */
  debugSurveyDungeonRoom(): boolean {
    const dungeons = this.world.gen.dungeons;
    const entrance = dungeons.nearestEntrance(this.player.position.x, this.player.position.z, 600);
    if (!entrance) return false;
    const sites = dungeons.sitesNear(entrance.x - 4, entrance.z - 4, entrance.x + 4, entrance.z + 4);
    // The biggest room, which is the one most likely to have columns in it.
    let room = sites[0]?.rooms[0];
    for (const site of sites) {
      for (const candidate of site.rooms) {
        if (!room || candidate.width * candidate.depth > room.width * room.depth) room = candidate;
      }
    }
    if (!room) return false;

    const x = room.x + 0.5;
    const z = room.z + room.depth / 2;
    this.world.ensureLoadedAround(Math.floor(x), Math.floor(z), 2);
    this.player.position.set(x, room.floorY + 0.05, z);
    this.player.velocity.set(0, 0, 0);
    // Forward is (-sin yaw, 0, -cos yaw), so yaw -pi/2 looks towards +X, across the
    // room from the low-X wall.
    this.player.yaw = -Math.PI / 2;
    this.player.pitch = 0.04;
    return true;
  }

  /** Drops the player into the nearest dungeon room, for screenshots. */
  debugDescendDungeon(): boolean {
    const dungeons = this.world.gen.dungeons;
    const entrance = dungeons.nearestEntrance(this.player.position.x, this.player.position.z, 600);
    if (!entrance) return false;
    const sites = dungeons.sitesNear(entrance.x - 4, entrance.z - 4, entrance.x + 4, entrance.z + 4);
    const room = sites[0]?.rooms[0];
    if (!room) return false;

    const x = room.x + Math.floor(room.width / 2);
    const z = room.z + Math.floor(room.depth / 2);
    this.world.ensureLoadedAround(x, z, 2);
    this.player.position.set(x + 0.5, room.floorY + 0.05, z + 0.5);
    this.player.velocity.set(0, 0, 0);
    this.player.pitch = 0;
    return true;
  }

  /** Counts dungeon features around the player, to confirm carving happened. */
  debugDungeonCarved(): Record<string, number> {
    let airBelow = 0;
    let masonry = 0;
    let torches = 0;
    const centre = this.player.position;
    // Every voxel, not every other one. Torches are isolated single blocks, so a
    // strided sample only finds one when its coordinates happen to share the
    // stride's parity — the count was a coin toss that moved whenever entrance
    // geometry shifted by a block.
    for (let y = Math.max(1, Math.floor(centre.y) - 40); y < Math.floor(centre.y) + 6; y++) {
      for (let dz = -20; dz <= 20; dz += 1) {
        for (let dx = -20; dx <= 20; dx += 1) {
          const id = this.world.getBlock(Math.floor(centre.x) + dx, y, Math.floor(centre.z) + dz);
          if (id === Block.Air && y < Math.floor(centre.y)) airBelow++;
          else if (id === Block.DungeonBrick || id === Block.MossyBrick || id === Block.CrackedBrick) masonry++;
          else if (id === Block.Torch) torches++;
        }
      }
    }
    return { airBelow, masonry, torches };
  }

  /** Which optional visual layers are currently drawing, for diagnosis. */
  debugLayers(): Record<string, unknown> {
    return {
      trails: this.trails.activeCount,
      trailMeshVisible: this.trails.mesh.visible,
      arcVisible: this.arc.group.visible,
      rainDrops: this.rain.dropCount,
      highlightVisible: this.highlight.group.visible,
      starsVisible: this.stars.points.visible,
      particlesVisible: this.particles.points.visible,
      pickupsInScene: this.pickups.group.children.length,
    };
  }

  /** Test hook: hides a visual layer so it can be ruled in or out. */
  debugHideLayer(layer: 'trails' | 'arc' | 'rain' | 'highlight' | 'stars' | 'viewmodel' | 'particles', hidden: boolean): void {
    if (layer === 'particles') this.particles.points.visible = !hidden;
    else if (layer === 'trails') this.trails.mesh.visible = !hidden;
    else if (layer === 'arc') this.arc.group.visible = !hidden;
    else if (layer === 'rain') this.rain.lines.visible = !hidden;
    else if (layer === 'highlight') this.highlight.group.visible = !hidden;
    else if (layer === 'stars') this.stars.points.visible = !hidden;
    else this.viewModelHidden = hidden;
  }

  private viewModelHidden = false;

  /** Live particle count, for verifying bursts. */
  debugParticleCount(): number {
    return this.particles.count;
  }

  /** Number of rain drops currently falling. */
  debugRainDrops(): number {
    return this.rain.dropCount;
  }

  /** Dynamic light state, for verifying the torch actually lights the world. */
  debugTorchLight(): Record<string, unknown> {
    return this.lights.debugState();
  }

  /** World-space transform of the held item, for comparing attack animations. */
  debugViewPose(): Record<string, number> {
    return this.viewModel.debugPose();
  }

  /**
   * Makes an item active, assigning it to the current hotbar slot if it is not
   * already on the bar.
   */
  debugSelectHotbarByItem(itemId: string): boolean {
    const inventory = this.player.inventory;
    let slot = inventory.hotbar.indexOf(itemId);
    if (slot < 0) {
      slot = inventory.selected;
      inventory.assignToHotbar(slot, itemId);
    }
    inventory.select(slot);
    this.player.syncEquipmentDerived();
    return inventory.activeItemId === itemId;
  }

  /** Forces the active weapon's attack mode, for deterministic animation tests. */
  debugSetAttackMode(mode: 'swing' | 'thrust'): boolean {
    const active = this.player.inventory.activeItem;
    const modes = active?.weapon?.melee;
    if (!active || !modes || modes.length === 0) return false;
    const index = modes.findIndex((m) => m.mode === mode);
    if (index < 0) return false;
    this.player.inventory.attackModes.set(active.id, index);
    return true;
  }

  /** Equips an item directly, bypassing the hotbar. */
  debugEquip(itemId: string): boolean {
    const ok = this.player.inventory.equip(itemId);
    this.player.syncEquipmentDerived();
    return ok;
  }

  debugGiveItem(itemId: string, qty = 1): void {
    this.player.inventory.add(itemId, qty);
  }

  /** Remaining spell slots per tier. */
  debugSpellSlots(): number[] {
    return [1, 2, 3].map((tier) => this.player.stats.slotsAvailable(tier as 1 | 2 | 3));
  }

  /** Points the camera at the ground a few blocks ahead. */
  debugLookDown(): void {
    this.player.pitch = -0.6;
  }

  /** Sets pitch alone, leaving whatever the camera is facing intact. */
  debugPitch(pitch: number): void {
    this.player.pitch = pitch;
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
      combatState: this.combat.debugState(),
      input: { ...this.input.counters },
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
        timeOfDay: this.time.fraction,
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
      if (typeof data.timeOfDay === 'number') this.time.fraction = data.timeOfDay;

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
      this.rain.clear();
      this.highlight.hide();
      this.trails.clear();
      this.arc.hide();
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
