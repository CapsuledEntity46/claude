import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import type { Input } from '../core/Input';
import type { Enemy } from '../entities/Enemy';
import { Block, blockDef, blockDrop, isSolid } from '../world/blocks';
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from '../player/Player';
import { ammoItemFor, item, itemForBlock, type ItemDef } from './items';
import { computeDamage, type AttackMode, type DamageInput, type MeleeAttack, type RangedProfile } from './types';
import type { ViewAction, ViewPhase } from '../fx/ViewModel';

const REACH = 5.2;
/** Multiplier applied when a melee weapon chips a block instead of an enemy. */
const WEAPON_MINING_FACTOR = 0.35;
const MAX_EXPLOSION_BLOCKS = 700;

type ActionState = 'idle' | 'windup' | 'recovery' | 'casting' | 'reloading';

export interface HudCombatState {
  actionLabel: string;
  /** 0..1 progress for whatever is currently occupying the player. */
  progress: number;
  /** 0..1 bow draw strength. */
  draw: number;
  ammoLoaded: number;
  ammoReserve: number;
  ammoLabel: string;
  targetName: string | null;
  targetHpFraction: number;
  modeLabel: string;
}

/**
 * Everything the player *does*: swinging, thrusting, shooting, throwing,
 * casting, guarding, mining, and building. Enemy behaviour lives in Enemy;
 * this class is the other half of the fight.
 */
export class CombatSystem {
  private state: ActionState = 'idle';
  private timer = 0;
  private stateDuration = 0;

  private pendingMelee: MeleeAttack | null = null;
  private pendingSpell: ItemDef | null = null;

  /** Bow draw strength, 0..1. */
  private draw = 0;
  private useCooldown = 0;
  /** Rounds currently loaded, per weapon id. */
  private loaded = new Map<string, number>();
  private reloadingWeapon: string | null = null;

  private miningKey: string | null = null;
  private miningProgress = 0;
  private miningTarget: { x: number; y: number; z: number } | null = null;

  private target: Enemy | null = null;
  private rng = Math.random;

  /** Which mode the current or just-finished melee attack used, for animation. */
  private lastMeleeMode: AttackMode = 'swing';
  /** Counts shots fired, so the view model can trigger a recoil kick. */
  private shotCounter = 0;
  /** Short timer driving the block-placement animation. */
  private placeTimer = 0;
  /** The block under the crosshair this frame, for the mining highlight. */
  private blockTarget: { x: number; y: number; z: number } | null = null;

  /** Counters for debugging why an attack did or did not land. */
  readonly diag = {
    attempts: 0,
    resolved: 0,
    candidates: 0,
    hits: 0,
    mineCalls: 0,
    breaks: 0,
    lastReason: '',
    /** Frames on which a left-click press was observed. */
    primaryPresses: 0,
    /** What the game saw on the most recent left-click press. */
    lastPress: '',
  };

  // ------------------------------------------------------------------ per-frame

  update(dt: number, input: Input, ctx: GameContext): void {
    const player = ctx.player;
    if (player.dead) {
      this.state = 'idle';
      player.blocking = false;
      return;
    }

    this.useCooldown = Math.max(0, this.useCooldown - dt);
    this.placeTimer = Math.max(0, this.placeTimer - dt);
    this.updateTarget(ctx);
    this.updateBlockTarget(ctx);

    const active = player.inventory.activeItem;

    this.handleModeSwitch(input, ctx, active);
    this.handleGuard(input, ctx, active);

    if (this.state !== 'idle') {
      if (input.mousePressed(0)) {
        this.diag.lastReason = `press ignored: busy in ${this.state}`;
      }
      this.tickBusyState(dt, ctx);
      return;
    }

    if (input.wasPressed('KeyR') && this.beginReload(ctx, active)) return;

    this.handlePrimary(dt, input, ctx, active);
    this.handleSecondary(input, ctx, active);
  }

  private tickBusyState(dt: number, ctx: GameContext): void {
    this.timer -= dt;
    if (this.timer > 0) return;

    switch (this.state) {
      case 'windup':
        this.resolveMelee(ctx);
        break;
      case 'casting':
        this.resolveSpell(ctx);
        break;
      case 'reloading':
        this.finishReload(ctx);
        break;
      default:
        this.state = 'idle';
        break;
    }
  }

  // ------------------------------------------------------------------ targeting

  /** Finds the enemy under the crosshair, for the HUD target readout. */
  private updateTarget(ctx: GameContext): void {
    const eye = ctx.player.eyePosition;
    const look = ctx.player.lookDirection;
    let best: Enemy | null = null;
    let bestScore = -1;

    for (const enemy of ctx.enemies.enemies) {
      if (enemy.dead) continue;
      const to = meleeAimPoint(enemy, eye.y).sub(eye);
      const distance = to.length();
      if (distance > 40) continue;
      const dot = to.divideScalar(distance).dot(look);
      if (dot < 0.97) continue;
      if (dot > bestScore) {
        bestScore = dot;
        best = enemy;
      }
    }
    this.target = best;
  }

  /** Tracks the block under the crosshair so it can be outlined every frame. */
  private updateBlockTarget(ctx: GameContext): void {
    const hit = ctx.world.raycast(ctx.player.eyePosition, ctx.player.lookDirection, REACH, isSolid);
    this.blockTarget = hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
  }

  /**
   * What the block highlight should draw: the targeted block, plus mining
   * progress when that block is actively being broken (negative when it is not).
   */
  highlightState(): { x: number; y: number; z: number; progress: number } | null {
    if (!this.blockTarget) return null;
    const { x, y, z } = this.blockTarget;
    const key = `${x},${y},${z}`;
    const progress = this.miningKey === key ? this.miningProgress : -1;
    return { x, y, z, progress };
  }

  /**
   * Animation state for the first-person view model. Wind-up and recovery are
   * reported separately so the weapon can anticipate before it strikes.
   */
  viewState(ctx?: GameContext): {
    action: ViewAction;
    phase: ViewPhase;
    progress: number;
    draw: number;
    attackMode: AttackMode;
    shotCounter: number;
  } {
    const phaseProgress = 1 - this.timer / Math.max(0.0001, this.stateDuration);
    const clamped = Math.max(0, Math.min(1, phaseProgress));

    // The *currently selected* mode, which is what the idle stance should show.
    // Reporting the last-used mode instead left the weapon carried in the old
    // stance until the player attacked once after switching.
    const selectedMode: AttackMode = ctx
      ? this.currentMelee(ctx, ctx.player.inventory.activeItem)?.mode ?? this.lastMeleeMode
      : this.lastMeleeMode;

    // Mid-attack the animation must follow the mode that attack started with,
    // even if the selection has since changed.
    if (this.state === 'windup' || this.state === 'recovery') {
      return {
        action: this.lastMeleeMode,
        phase: this.state === 'windup' ? 'windup' : 'recovery',
        progress: clamped,
        draw: this.draw,
        attackMode: this.lastMeleeMode,
        shotCounter: this.shotCounter,
      };
    }

    let action: ViewAction = 'idle';
    if (this.state === 'casting') action = 'cast';
    else if (this.state === 'reloading') action = 'reload';
    else if (this.draw > 0.02) action = 'draw';
    else if (this.placeTimer > 0) action = 'place';
    else if (this.miningKey !== null) action = 'mine';

    return {
      action,
      phase: 'none',
      progress: action === 'place' ? 1 - this.placeTimer / 0.18 : clamped,
      draw: this.draw,
      attackMode: selectedMode,
      shotCounter: this.shotCounter,
    };
  }

  // ------------------------------------------------------------------ modes

  private handleModeSwitch(input: Input, ctx: GameContext, active: ItemDef | null): void {
    if (!input.wasPressed('KeyX')) return;
    const weapon = active?.weapon;
    if (!weapon || weapon.melee.length <= 1) {
      ctx.log('This weapon has only one way to strike.', 'info');
      return;
    }
    const index = ctx.player.inventory.cycleAttackMode(active!.id, weapon.melee.length);
    const mode = weapon.melee[index];
    ctx.log(
      `${active!.name}: ${mode.mode === 'swing' ? 'swinging' : 'thrusting'} — ${mode.damage} ${mode.type}, ` +
        `${mode.reach.toFixed(1)}m reach, ${Math.round(mode.armorPierce * 100)}% armor pierce.`,
      'info',
    );
  }

  /** The melee attack the active weapon will perform right now. */
  private currentMelee(ctx: GameContext, active: ItemDef | null): MeleeAttack | null {
    const weapon = active?.weapon ?? item('fists').weapon!;
    if (weapon.melee.length === 0) return null;
    const id = active?.id ?? 'fists';
    return weapon.melee[ctx.player.inventory.attackModeIndex(id, weapon.melee.length)];
  }

  // ------------------------------------------------------------------ guarding

  private handleGuard(input: Input, ctx: GameContext, active: ItemDef | null): void {
    const player = ctx.player;
    // Holding something placeable means right-click builds, so no guard.
    const placeable = active?.kind === 'block' || active?.kind === 'torch';
    const wantsGuard = input.isMouseDown(2) && !placeable;
    player.blocking = wantsGuard && player.canBlock && this.state !== 'casting';
  }

  // ------------------------------------------------------------------ primary

  private handlePrimary(dt: number, input: Input, ctx: GameContext, active: ItemDef | null): void {
    if (input.mousePressed(0)) {
      this.diag.primaryPresses++;
      this.diag.lastPress = `item=${active?.id ?? 'none'} kind=${active?.kind ?? 'none'} state=${this.state} cd=${this.useCooldown.toFixed(2)}`;
    }

    // Dedicated mining while a placeable is selected (blocks and torches).
    if (active?.kind === 'block' || active?.kind === 'torch') {
      if (input.isMouseDown(0)) this.mine(dt, ctx, 1);
      else this.resetMining();
      return;
    }
    this.resetMining();

    if (active?.kind === 'consumable') {
      if (input.mousePressed(0)) this.useConsumable(ctx, active);
      return;
    }

    if (active?.kind === 'spell') {
      if (input.mousePressed(0)) this.beginCast(ctx, active);
      return;
    }

    const weapon = active?.weapon;
    if (weapon?.ranged && weapon.class === 'bow') {
      this.handleBow(dt, input, ctx, active!);
      return;
    }

    if (weapon?.ranged && (weapon.class === 'crossbow' || weapon.class === 'firearm')) {
      if (input.mousePressed(0)) this.fireLoadedWeapon(ctx, active!);
      return;
    }

    if (weapon?.ranged && weapon.class === 'thrown') {
      if (input.mousePressed(0)) this.throwItem(ctx, active!);
      return;
    }

    // Melee (including bare fists when nothing is equipped).
    if (input.mousePressed(0)) this.beginMelee(ctx, active);
  }

  private handleSecondary(input: Input, ctx: GameContext, active: ItemDef | null): void {
    const placeable = active?.kind === 'block' || active?.kind === 'torch';
    if (placeable && input.mousePressed(2)) this.placeBlock(ctx, active!);
  }

  // ------------------------------------------------------------------ melee

  private beginMelee(ctx: GameContext, active: ItemDef | null): void {
    this.diag.attempts++;
    if (this.useCooldown > 0) {
      this.diag.lastReason = `cooldown ${this.useCooldown.toFixed(2)}`;
      return;
    }
    const attack = this.currentMelee(ctx, active);
    if (!attack) {
      this.diag.lastReason = 'no melee mode on active item';
      return;
    }

    if (!ctx.player.stats.spendStamina(attack.stamina)) {
      this.diag.lastReason = `no stamina (${ctx.player.stats.stamina.toFixed(0)} < ${attack.stamina})`;
      ctx.log('Too winded to swing.', 'info');
      return;
    }
    this.diag.lastReason = `began ${attack.mode}`;

    this.pendingMelee = attack;
    this.lastMeleeMode = attack.mode;
    this.state = 'windup';
    this.stateDuration = attack.windup;
    this.timer = attack.windup;

    // Pull the view back slightly during the wind-up, then snap forward on hit.
    ctx.player.viewKick.y += attack.mode === 'swing' ? 0.035 : 0.012;
  }

  private resolveMelee(ctx: GameContext): void {
    const attack = this.pendingMelee;
    this.pendingMelee = null;
    if (!attack) {
      this.state = 'idle';
      return;
    }

    this.state = 'recovery';
    this.stateDuration = attack.recovery;
    this.timer = attack.recovery;
    this.useCooldown = attack.recovery * 0.5;

    const eye = ctx.player.eyePosition;
    const look = ctx.player.lookDirection;
    const cosArc = Math.cos(THREE.MathUtils.degToRad(attack.arcDeg));

    // Collect everything inside the attack cone, nearest first.
    const candidates: { enemy: Enemy; distance: number }[] = [];
    for (const enemy of ctx.enemies.enemies) {
      if (enemy.dead) continue;
      const to = meleeAimPoint(enemy, eye.y).sub(eye);
      const distance = to.length() - enemy.radius;
      if (distance > attack.reach) continue;
      to.normalize();
      if (to.dot(look) < cosArc) continue;
      // A wall between you and the target stops the blow.
      const blocked = ctx.world.raycast(eye, to, Math.max(0.1, distance), isSolid);
      if (blocked) continue;
      candidates.push({ enemy, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    const hits = candidates.slice(0, attack.maxTargets);
    this.diag.resolved++;
    this.diag.candidates = candidates.length;
    this.diag.hits += hits.length;
    if (hits.length === 0) {
      this.diag.lastReason = `resolved ${attack.mode}, no target in cone (reach ${attack.reach}, arc ${attack.arcDeg})`;
    }

    for (const { enemy } of hits) {
      const input: DamageInput = {
        amount: attack.damage,
        type: attack.type,
        armorPierce: attack.armorPierce,
        multiplier: ctx.player.stats.meleeMultiplier,
        // Thrusts are precise, so they crit more often.
        critChance: attack.mode === 'thrust' ? 0.14 : 0.07,
        critMultiplier: attack.mode === 'thrust' ? 2.0 : 1.7,
      };
      ctx.enemies.damageEnemy(enemy, input, eye, attack.knockback);
    }

    if (hits.length > 0) {
      ctx.player.viewKick.y -= 0.05;
      ctx.player.viewKick.x += (this.rng() - 0.5) * 0.04;
      ctx.particles.cone(
        eye.clone().addScaledVector(look, 1.2),
        look,
        attack.mode === 'swing' ? 8 : 4,
        4,
        attack.mode === 'swing' ? 0.7 : 0.25,
        { color: 0xffe4b0, size: 0.06, life: 0.2, gravity: 6 },
      );
    } else {
      // A miss still bites into whatever is in front of you.
      this.chipBlock(ctx, attack);
    }
  }

  /** A whiffed melee swing damages the block it lands on. */
  private chipBlock(ctx: GameContext, attack: MeleeAttack): void {
    const hit = ctx.world.raycast(ctx.player.eyePosition, ctx.player.lookDirection, attack.reach, isSolid);
    if (!hit) return;
    const key = `${hit.x},${hit.y},${hit.z}`;
    if (this.miningKey !== key) {
      this.miningKey = key;
      this.miningProgress = 0;
      this.miningTarget = { x: hit.x, y: hit.y, z: hit.z };
    }
    const hardness = blockDef(hit.block).hardness;
    if (!Number.isFinite(hardness)) return;
    this.miningProgress += (WEAPON_MINING_FACTOR * (attack.damage / 10 + 0.4)) / Math.max(0.15, hardness);
    this.spawnBlockParticles(ctx, hit.x, hit.y, hit.z, 3);
    if (this.miningProgress >= 1) this.breakBlock(ctx, hit.x, hit.y, hit.z);
  }

  // ------------------------------------------------------------------ mining

  private resetMining(): void {
    if (this.miningKey !== null) {
      this.miningKey = null;
      this.miningProgress = 0;
      this.miningTarget = null;
    }
  }

  private mine(dt: number, ctx: GameContext, speed: number): void {
    this.diag.mineCalls++;
    const hit = ctx.world.raycast(ctx.player.eyePosition, ctx.player.lookDirection, REACH, isSolid);
    if (!hit) {
      this.diag.lastReason = 'mine: nothing in reach';
      this.resetMining();
      return;
    }

    const key = `${hit.x},${hit.y},${hit.z}`;
    if (this.miningKey !== key) {
      this.miningKey = key;
      this.miningProgress = 0;
      this.miningTarget = { x: hit.x, y: hit.y, z: hit.z };
    }

    const hardness = blockDef(hit.block).hardness;
    if (!Number.isFinite(hardness)) {
      ctx.log('This block will not break.', 'info');
      return;
    }

    this.miningProgress += (dt * speed) / Math.max(0.1, hardness);
    if (this.rng() < dt * 22) this.spawnBlockParticles(ctx, hit.x, hit.y, hit.z, 1);

    if (this.miningProgress >= 1) this.breakBlock(ctx, hit.x, hit.y, hit.z);
  }

  private breakBlock(ctx: GameContext, x: number, y: number, z: number): void {
    const id = ctx.world.getBlock(x, y, z);
    this.resetMining();
    if (!ctx.world.setBlock(x, y, z, Block.Air)) {
      this.diag.lastReason = `break rejected at ${x},${y},${z} (block ${id})`;
      return;
    }
    this.diag.breaks++;

    this.spawnBlockParticles(ctx, x, y, z, 14, id);

    const drop = blockDrop(id);
    if (drop === null) return;
    const asItem = itemForBlock(drop);
    if (!asItem) return;
    const leftover = ctx.player.inventory.add(asItem.id, 1);
    if (leftover > 0) ctx.log('Your bag is full.', 'info');
  }

  private spawnBlockParticles(ctx: GameContext, x: number, y: number, z: number, amount: number, id?: number): void {
    const blockId = id ?? ctx.world.getBlock(x, y, z);
    const def = blockDef(blockId);
    const color = new THREE.Color(def.side[0], def.side[1], def.side[2]);
    ctx.particles.burst(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5), amount, 3, {
      color,
      size: 0.08,
      life: 0.6,
      gravity: 22,
    });
  }

  // ------------------------------------------------------------------ building

  private placeBlock(ctx: GameContext, active: ItemDef): void {
    if (active.block === undefined) return;
    if (!ctx.player.inventory.has(active.id, 1)) return;

    const hit = ctx.world.raycast(ctx.player.eyePosition, ctx.player.lookDirection, REACH, isSolid);
    if (!hit) return;

    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (isSolid(ctx.world.getBlock(x, y, z))) return;

    // Never entomb the player.
    const player = ctx.player.position;
    const overlapsPlayer =
      x + 1 > player.x - PLAYER_HALF_WIDTH &&
      x < player.x + PLAYER_HALF_WIDTH &&
      z + 1 > player.z - PLAYER_HALF_WIDTH &&
      z < player.z + PLAYER_HALF_WIDTH &&
      y + 1 > player.y &&
      y < player.y + PLAYER_HEIGHT;
    if (overlapsPlayer) return;

    if (!ctx.world.setBlock(x, y, z, active.block)) return;
    ctx.player.inventory.remove(active.id, 1);
    this.useCooldown = 0.16;
    this.placeTimer = 0.18;
  }

  // ------------------------------------------------------------------ bows

  private handleBow(dt: number, input: Input, ctx: GameContext, active: ItemDef): void {
    const profile = active.weapon!.ranged!;
    const ammo = ammoItemFor(profile.ammo);

    if (input.isMouseDown(0)) {
      if (ammo && !ctx.player.inventory.has(ammo.id, 1)) {
        if (this.draw === 0) ctx.log(`Out of ${ammo.name.toLowerCase()}s.`, 'info');
        return;
      }
      // Drawing costs stamina, so you cannot hold a full draw indefinitely.
      if (this.draw < 1 && !ctx.player.stats.spendStamina(9 * dt)) return;
      this.draw = Math.min(1, this.draw + dt / Math.max(0.05, profile.drawTime));
      return;
    }

    if (this.draw > 0) {
      const power = this.draw;
      this.draw = 0;
      if (power < 0.22) {
        ctx.log('The string slips — barely any power behind it.', 'info');
      }
      this.fireRanged(ctx, active, profile, Math.max(0.25, power));
    }
  }

  // ------------------------------------------------------------------ firearms

  private magazineFor(active: ItemDef): number {
    const size = active.weapon!.ranged!.magazine;
    if (!this.loaded.has(active.id)) this.loaded.set(active.id, size);
    return this.loaded.get(active.id)!;
  }

  private fireLoadedWeapon(ctx: GameContext, active: ItemDef): void {
    const profile = active.weapon!.ranged!;
    if (this.useCooldown > 0) return;

    if (this.magazineFor(active) <= 0) {
      this.beginReload(ctx, active);
      return;
    }

    this.loaded.set(active.id, this.magazineFor(active) - 1);
    this.fireRanged(ctx, active, profile, 1);
    this.useCooldown = profile.cooldown;

    // Auto-reload once empty so the player is not left clicking on nothing.
    if (this.magazineFor(active) <= 0) this.beginReload(ctx, active);
  }

  /** Returns true if a reload actually started. */
  private beginReload(ctx: GameContext, active: ItemDef | null): boolean {
    const profile = active?.weapon?.ranged;
    if (!active || !profile || profile.reloadTime <= 0) return false;
    if (this.magazineFor(active) >= profile.magazine) return false;

    const ammo = ammoItemFor(profile.ammo);
    if (ammo && !ctx.player.inventory.has(ammo.id, 1)) {
      ctx.log(`No ${ammo.name.toLowerCase()} left.`, 'info');
      return false;
    }

    this.state = 'reloading';
    this.reloadingWeapon = active.id;
    this.stateDuration = profile.reloadTime;
    this.timer = profile.reloadTime;
    return true;
  }

  private finishReload(ctx: GameContext): void {
    this.state = 'idle';
    const id = this.reloadingWeapon;
    this.reloadingWeapon = null;
    if (!id) return;

    const active = ctx.player.inventory.activeItem;
    // Switching weapons mid-reload cancels it.
    if (!active || active.id !== id) return;

    const profile = active.weapon!.ranged!;
    const ammo = ammoItemFor(profile.ammo);
    const want = profile.magazine - this.magazineFor(active);
    let gained = 0;
    for (let i = 0; i < want; i++) {
      if (ammo && !ctx.player.inventory.remove(ammo.id, 1)) break;
      gained++;
    }
    this.loaded.set(active.id, this.magazineFor(active) + gained);
    if (gained > 0) ctx.log(`${active.name} loaded.`, 'info');
  }

  /** Common firing path for bows, crossbows, and firearms. */
  private fireRanged(ctx: GameContext, active: ItemDef, profile: RangedProfile, power: number): void {
    const ammo = ammoItemFor(profile.ammo);

    // Bows consume ammo at the shot; loaded weapons consumed it at reload time.
    if (active.weapon!.class === 'bow' && ammo && !ctx.player.inventory.remove(ammo.id, 1)) return;

    const eye = ctx.player.eyePosition;
    const look = ctx.player.lookDirection;
    // Spawn slightly ahead so the projectile is not born inside the camera.
    const origin = eye.clone().addScaledVector(look, 0.5);

    for (let pellet = 0; pellet < profile.pellets; pellet++) {
      const direction = applySpread(look, profile.spreadDeg / (0.4 + power * 0.6), this.rng);
      ctx.spawnProjectile({
        origin,
        direction,
        speed: profile.speed * (0.5 + power * 0.5),
        damage: profile.damage * power * ctx.player.stats.rangedMultiplier,
        type: profile.type,
        armorPierce: profile.armorPierce,
        gravity: profile.gravity,
        knockback: profile.knockback * power,
        hostile: false,
        look: lookForClass(active.weapon!.class, profile.ammo),
        aoeRadius: profile.aoeRadius,
        blockDamage: profile.blockDamage,
        sourceName: active.name,
      });
    }

    this.shotCounter++;

    if (profile.muzzleFlash) {
      ctx.particles.cone(origin, look, 22, 7, 0.35, { color: 0xffd070, size: 0.13, life: 0.22, gravity: -3, drag: 3 });
      ctx.particles.cone(origin, look, 26, 3, 0.6, { color: 0x8a8a8a, size: 0.2, life: 1.1, gravity: -1.5, drag: 1.4 });
      // Black powder is loud: it pulls everything nearby onto you.
      ctx.alert(ctx.player.center, 46);
      ctx.player.viewKick.y += 0.09 + profile.knockback * 0.006;
      ctx.player.viewKick.x += (this.rng() - 0.5) * 0.05;
    } else {
      ctx.player.viewKick.y += 0.02 * power;
    }
  }

  // ------------------------------------------------------------------ thrown

  private throwItem(ctx: GameContext, active: ItemDef): void {
    if (this.useCooldown > 0) return;
    if (!ctx.player.inventory.remove(active.id, 1)) return;
    const profile = active.weapon!.ranged!;

    const eye = ctx.player.eyePosition;
    const look = ctx.player.lookDirection;
    ctx.spawnProjectile({
      origin: eye.clone().addScaledVector(look, 0.6),
      // Lob it slightly upward so it arcs like a thrown object.
      direction: look.clone().add(new THREE.Vector3(0, 0.18, 0)).normalize(),
      speed: profile.speed,
      damage: profile.damage * ctx.player.stats.rangedMultiplier,
      type: profile.type,
      armorPierce: profile.armorPierce,
      gravity: profile.gravity,
      knockback: profile.knockback,
      hostile: false,
      look: 'grenade',
      aoeRadius: profile.aoeRadius,
      blockDamage: profile.blockDamage,
      fuse: profile.fuse,
      sourceName: active.name,
    });
    this.useCooldown = profile.cooldown;
    this.shotCounter++;
    ctx.log('Fuse lit.', 'info');
  }

  // ------------------------------------------------------------------ spells

  private beginCast(ctx: GameContext, active: ItemDef): void {
    const spell = active.spell!;
    if (this.useCooldown > 0) return;

    if (!ctx.player.stats.consumeSlot(spell.tier)) {
      ctx.log(`No tier ${spell.tier} spell slots left.`, 'magic');
      return;
    }

    this.pendingSpell = active;
    this.state = 'casting';
    this.stateDuration = spell.castTime;
    this.timer = spell.castTime;

    ctx.particles.burst(ctx.player.eyePosition.clone().addScaledVector(ctx.player.lookDirection, 1), 10, 1.6, {
      color: 0xb070ff,
      size: 0.09,
      life: spell.castTime + 0.15,
      gravity: -4,
      drag: 2,
    });
  }

  private resolveSpell(ctx: GameContext): void {
    const active = this.pendingSpell;
    this.pendingSpell = null;
    this.state = 'idle';
    if (!active?.spell) return;

    const spell = active.spell;
    const stats = ctx.player.stats;
    const power = stats.spellMultiplier;
    const eye = ctx.player.eyePosition;
    const look = ctx.player.lookDirection;
    this.useCooldown = spell.cooldown;

    switch (spell.kind) {
      case 'projectile':
        ctx.spawnProjectile({
          origin: eye.clone().addScaledVector(look, 0.6),
          direction: look,
          speed: spell.speed,
          damage: spell.damage * power,
          type: spell.type,
          armorPierce: spell.armorPierce,
          gravity: 0,
          knockback: 3,
          hostile: false,
          look: 'magic',
          color: spell.type === 'fire' ? 0xff7830 : 0x70c8ff,
          slow: spell.duration > 0 ? spell.duration : undefined,
          sourceName: active.name,
        });
        break;

      case 'nova': {
        const center = ctx.player.center;
        const targets = ctx.enemies.enemiesInSphere(center, spell.radius);
        for (const enemy of targets) {
          ctx.enemies.damageEnemy(
            enemy,
            { amount: spell.damage * power, type: spell.type, armorPierce: spell.armorPierce, critChance: 0.05 },
            center,
            7,
          );
        }
        // Expanding ring of particles to sell the radius.
        for (let i = 0; i < 90; i++) {
          const angle = (i / 90) * Math.PI * 2;
          ctx.particles.spawn(
            center.clone(),
            new THREE.Vector3(Math.cos(angle) * spell.radius, 1.2, Math.sin(angle) * spell.radius),
            { color: 0xb070ff, size: 0.14, life: 0.5, gravity: 2, drag: 1.6 },
          );
        }
        ctx.log(`Arcane Nova strikes ${targets.length} ${targets.length === 1 ? 'foe' : 'foes'}.`, 'magic');
        break;
      }

      case 'chain': {
        const struck = new Set<Enemy>();
        let from = eye;
        let damage = spell.damage * power;
        for (let i = 0; i < spell.targets; i++) {
          const next = ctx.enemies.nearestEnemy(from, i === 0 ? spell.range : spell.radius, struck);
          if (!next) break;
          struck.add(next);
          ctx.enemies.damageEnemy(
            next,
            { amount: damage, type: spell.type, armorPierce: spell.armorPierce, critChance: 0.08 },
            from,
            3,
          );
          this.drawBeam(ctx, from, next.center, 0x9fd0ff);
          from = next.center;
          // Each jump is weaker, so positioning matters.
          damage *= 0.78;
        }
        if (struck.size === 0) ctx.log('The lightning finds nothing to leap to.', 'magic');
        break;
      }

      case 'heal': {
        const healed = stats.heal(spell.amount * power);
        ctx.floater(ctx.player.center, `+${Math.round(healed)}`, 'heal');
        ctx.particles.burst(ctx.player.center, 18, 2, { color: 0x8ce89c, size: 0.11, life: 0.7, gravity: -6, drag: 1.5 });
        ctx.log(`Mend restores ${Math.round(healed)} health.`, 'good');
        break;
      }

      case 'ward':
        stats.wardArmor = Math.round(spell.amount * power);
        stats.wardTimer = spell.duration;
        ctx.log(`Stoneskin: +${stats.wardArmor} armor for ${spell.duration}s.`, 'magic');
        ctx.particles.burst(ctx.player.center, 20, 1.6, { color: 0xa89880, size: 0.12, life: 0.8, gravity: -3 });
        break;

      case 'meteor': {
        const hit = ctx.world.raycast(eye, look, spell.range, isSolid);
        const impact = hit ? hit.point.clone() : eye.clone().addScaledVector(look, spell.range);
        // Drop it from above so the player sees the rock come down.
        ctx.spawnProjectile({
          origin: impact.clone().add(new THREE.Vector3(0, 26, 0)),
          direction: new THREE.Vector3(0, -1, 0),
          speed: 52,
          damage: spell.damage * power,
          type: spell.type,
          armorPierce: spell.armorPierce,
          gravity: 0.2,
          knockback: 14,
          hostile: false,
          look: 'grenade',
          color: 0xff6a30,
          aoeRadius: spell.radius,
          blockDamage: spell.blockDamage,
          sourceName: active.name,
        });
        ctx.log('The sky answers.', 'magic');
        break;
      }

      default:
        break;
    }
  }

  /** Cheap visual beam made of particles, used by Chain Lightning. */
  private drawBeam(ctx: GameContext, from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const steps = Math.max(4, Math.round(from.distanceTo(to) * 3));
    for (let i = 0; i <= steps; i++) {
      const point = from.clone().lerp(to, i / steps);
      point.x += (this.rng() - 0.5) * 0.35;
      point.y += (this.rng() - 0.5) * 0.35;
      point.z += (this.rng() - 0.5) * 0.35;
      ctx.particles.spawn(point, new THREE.Vector3(), { color, size: 0.13, life: 0.22, gravity: 0, drag: 0 });
    }
  }

  // ------------------------------------------------------------------ consumables

  private useConsumable(ctx: GameContext, active: ItemDef): void {
    if (this.useCooldown > 0) return;
    const inventory = ctx.player.inventory;

    // Cooking: hold a fish over the flame you are already carrying.
    if (active.id === 'raw_fish' && inventory.equipped.torch) {
      if (!inventory.remove('raw_fish', 1)) return;
      inventory.add('cooked_fish', 1);
      ctx.log('You cook the fish over your torch.', 'good');
      ctx.particles.burst(ctx.player.center.clone().add(new THREE.Vector3(0, 0.2, 0)), 12, 1.6, {
        color: 0xffa040,
        size: 0.08,
        life: 0.5,
        gravity: -4,
      });
      this.useCooldown = 0.8;
      return;
    }

    const c = active.consumable!;
    if (!inventory.remove(active.id, 1)) return;

    const stats = ctx.player.stats;
    if (c.heal > 0) {
      const healed = stats.heal(c.heal);
      ctx.floater(ctx.player.center, `+${Math.round(healed)}`, 'heal');
    }
    if (c.stamina > 0) stats.stamina = Math.min(stats.maxStamina, stats.stamina + c.stamina);
    if (c.restoreTier > 0) {
      if (stats.restoreSlot(c.restoreTier as 1 | 2 | 3)) ctx.log('A spell slot returns to you.', 'magic');
      else ctx.log('Nothing to restore.', 'info');
    }
    ctx.log(`Used ${active.name}.`, 'good');
    this.useCooldown = 0.6;
  }

  // ------------------------------------------------------------------ incoming damage

  /**
   * Routes all incoming damage through the shield check, so guarding works
   * identically against melee, arrows, and explosions.
   */
  damagePlayer(ctx: GameContext, input: DamageInput, from: THREE.Vector3, sourceName: string): void {
    const player = ctx.player;
    if (player.dead) return;
    const stats = player.stats;

    const result = computeDamage(input, player.defense, this.rng);
    let damage = result.damage;

    const shield = player.inventory.equippedDef('shield')?.shield;
    let blocked = false;

    if (player.blocking && shield && stats.guard > 0) {
      const toSource = from.clone().sub(player.center).setY(0);
      if (toSource.lengthSq() > 1e-6) {
        toSource.normalize();
        const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(toSource.dot(player.facing), -1, 1)));
        if (angle <= shield.coneDeg) blocked = true;
      } else {
        blocked = true;
      }
    }

    if (blocked && shield) {
      damage *= 1 - shield.absorb;
      stats.guard = Math.max(0, stats.guard - shield.guardPerHit);
      ctx.floater(player.center, 'BLOCK', 'block');
      ctx.particles.burst(player.center.clone().addScaledVector(player.facing, 0.8), 10, 4, {
        color: 0xffe090,
        size: 0.07,
        life: 0.3,
        gravity: 12,
      });
      if (stats.guard <= 0) {
        ctx.log('Your guard breaks!', 'hurt');
        stats.stamina = Math.max(0, stats.stamina - 25);
        player.blocking = false;
      }
    }

    damage = Math.max(1, Math.round(damage * 10) / 10);
    stats.hp -= damage;
    stats.noteDamageTaken();

    ctx.floater(player.center, `-${damage}`, 'hurt');
    // Kick the camera away from the hit so damage has physical weight.
    const toSource = from.clone().sub(player.center).normalize();
    player.viewKick.y -= 0.05 + damage * 0.002;
    player.viewKick.x += toSource.dot(new THREE.Vector3(-Math.cos(player.yaw), 0, Math.sin(player.yaw))) * 0.06;

    if (!blocked) {
      ctx.log(`${sourceName} hits you for ${damage} ${input.type}.`, result.crit ? 'crit' : 'hurt');
    } else {
      ctx.log(`You block ${sourceName} (${damage} through).`, 'info');
    }

    if (stats.hp <= 0) {
      stats.hp = 0;
      player.dead = true;
      this.onPlayerDeath?.(sourceName);
    }
  }

  onPlayerDeath?: (sourceName: string) => void;

  // ------------------------------------------------------------------ explosions

  explode(
    ctx: GameContext,
    position: THREE.Vector3,
    radius: number,
    damage: number,
    type: DamageInput['type'],
    armorPierce: number,
    blockDamage: number,
    _hostile: boolean,
    sourceName: string,
  ): void {
    ctx.particles.burst(position, 70, 13, { color: 0xffb040, size: 0.24, life: 0.55, gravity: -2, drag: 2.2 });
    ctx.particles.burst(position, 60, 6, { color: 0x50494a, size: 0.34, life: 1.6, gravity: -1.2, drag: 1.1 });

    // Explosions do not care who threw them: enemies and the player both suffer.
    for (const enemy of ctx.enemies.enemiesInSphere(position, radius)) {
      const distance = enemy.center.distanceTo(position);
      const falloff = 1 - Math.min(1, distance / radius);
      ctx.enemies.damageEnemy(
        enemy,
        { amount: damage * falloff, type, armorPierce, canCrit: false },
        position,
        14 * falloff,
      );
    }

    const playerDistance = ctx.player.center.distanceTo(position);
    if (playerDistance < radius && !ctx.player.dead) {
      const falloff = 1 - Math.min(1, playerDistance / radius);
      this.damagePlayer(
        ctx,
        { amount: damage * falloff * 0.7, type, armorPierce, canCrit: false },
        position,
        sourceName,
      );
      const away = ctx.player.center.clone().sub(position).normalize();
      ctx.player.velocity.addScaledVector(away, 12 * falloff);
      ctx.player.velocity.y = Math.max(ctx.player.velocity.y, 5 * falloff);
    }

    if (blockDamage > 0) this.destroyBlocks(ctx, position, blockDamage);
    ctx.alert(position, radius * 8);
  }

  /** Carves a rough sphere out of the terrain. */
  private destroyBlocks(ctx: GameContext, position: THREE.Vector3, radius: number): void {
    const r = Math.ceil(radius);
    const cx = Math.floor(position.x);
    const cy = Math.floor(position.y);
    const cz = Math.floor(position.z);
    let budget = MAX_EXPLOSION_BLOCKS;

    for (let dy = -r; dy <= r && budget > 0; dy++) {
      for (let dz = -r; dz <= r && budget > 0; dz++) {
        for (let dx = -r; dx <= r && budget > 0; dx++) {
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          // Ragged edge rather than a perfect sphere.
          if (distance > radius * (0.75 + this.rng() * 0.45)) continue;
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          const id = ctx.world.getBlock(x, y, z);
          if (id === Block.Air || id === Block.Bedrock) continue;
          if (ctx.world.setBlock(x, y, z, Block.Air)) budget--;
        }
      }
    }
  }

  // ------------------------------------------------------------------ HUD

  hudState(ctx: GameContext): HudCombatState {
    const active = ctx.player.inventory.activeItem;
    const profile = active?.weapon?.ranged;
    const ammo = profile ? ammoItemFor(profile.ammo) : undefined;

    let actionLabel = '';
    let progress = 0;
    if (this.state === 'reloading') {
      actionLabel = 'Reloading';
      progress = 1 - this.timer / Math.max(0.01, this.stateDuration);
    } else if (this.state === 'casting') {
      actionLabel = 'Casting';
      progress = 1 - this.timer / Math.max(0.01, this.stateDuration);
    } else if (this.state === 'windup') {
      actionLabel = this.pendingMelee?.mode === 'thrust' ? 'Thrusting' : 'Swinging';
      progress = 1 - this.timer / Math.max(0.01, this.stateDuration);
    } else if (this.miningTarget) {
      actionLabel = 'Mining';
      progress = this.miningProgress;
    }

    // Only real weapons describe an attack mode. Without this guard a torch or a
    // stack of blocks inherits the bare-fists profile and the HUD claims you are
    // holding something that swings for blunt damage.
    const isWeapon = active?.kind === 'weapon' || active === null;
    const melee = isWeapon ? this.currentMelee(ctx, active) : null;
    let modeLabel = '';
    if (active && !isWeapon && active.kind !== 'spell') {
      modeLabel =
        active.kind === 'block'
          ? 'Left-click mines · right-click places'
          : active.kind === 'torch'
            ? 'Off-hand light · right-click plants one'
            : active.kind === 'consumable'
              ? 'Left-click to use'
              : '';
    } else if (active?.kind === 'spell' && active.spell) {
      modeLabel = `Tier ${active.spell.tier} · ${ctx.player.stats.slotsAvailable(active.spell.tier)} slots left`;
    } else if (profile && active?.weapon?.class !== 'melee') {
      const modes = active?.weapon?.melee.length ?? 0;
      modeLabel = `${profile.type} · ${Math.round(profile.armorPierce * 100)}% pierce${modes > 1 ? ' · X to switch' : ''}`;
    } else if (melee) {
      const count = active?.weapon?.melee.length ?? 1;
      modeLabel =
        `${melee.mode === 'swing' ? 'Swing' : 'Thrust'} · ${melee.type} · ${Math.round(melee.armorPierce * 100)}% pierce` +
        (count > 1 ? ' · X to switch' : ' · only mode');
    }

    return {
      actionLabel,
      progress,
      draw: this.draw,
      ammoLoaded: active && profile && profile.reloadTime > 0 ? this.magazineFor(active) : -1,
      ammoReserve: ammo ? ctx.player.inventory.count(ammo.id) : -1,
      ammoLabel: ammo?.name ?? '',
      targetName: this.target?.name ?? null,
      targetHpFraction: this.target ? Math.max(0, this.target.hp / this.target.maxHp) : 0,
      modeLabel,
    };
  }

  /** The action state machine's current state, for diagnostics. */
  debugState(): string {
    return this.state;
  }

  reset(): void {
    this.state = 'idle';
    this.timer = 0;
    this.draw = 0;
    this.pendingMelee = null;
    this.pendingSpell = null;
    this.reloadingWeapon = null;
    this.loaded.clear();
    this.resetMining();
    this.target = null;
    this.blockTarget = null;
    this.placeTimer = 0;
    this.shotCounter = 0;
  }
}

/**
 * The point on an enemy that melee attacks aim at: its vertical body axis,
 * sampled at the player's eye height and clamped to the body's extent.
 *
 * Using the enemy's centre instead is subtly wrong and very noticeable in play —
 * a goblin's torso sits well below eye level, so at close range it falls outside
 * a narrow thrust cone and the attack whiffs even though the crosshair is
 * squarely on the target. Clamping to the body means "if it looks like a hit,
 * it is a hit", for tall and short enemies alike.
 */
function meleeAimPoint(enemy: Enemy, eyeY: number): THREE.Vector3 {
  const feet = enemy.position.y;
  const head = enemy.position.y + enemy.height;
  const y = THREE.MathUtils.clamp(eyeY, feet + 0.15, Math.max(feet + 0.15, head - 0.1));
  return new THREE.Vector3(enemy.position.x, y, enemy.position.z);
}

/** Rotates a direction by a random offset within a cone, in degrees. */
function applySpread(direction: THREE.Vector3, spreadDeg: number, rng: () => number): THREE.Vector3 {
  if (spreadDeg <= 0) return direction.clone();
  const spread = THREE.MathUtils.degToRad(spreadDeg);
  // Build an orthonormal basis around the aim direction.
  const forward = direction.clone().normalize();
  const helper = Math.abs(forward.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, helper).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const angle = rng() * Math.PI * 2;
  // sqrt keeps the distribution uniform across the cone's area.
  const magnitude = Math.tan(spread) * Math.sqrt(rng());
  return forward
    .addScaledVector(right, Math.cos(angle) * magnitude)
    .addScaledVector(up, Math.sin(angle) * magnitude)
    .normalize();
}

function lookForClass(cls: string, ammo: string): 'arrow' | 'bolt' | 'bullet' | 'grenade' | 'magic' {
  if (cls === 'firearm') return 'bullet';
  if (ammo === 'bolt') return 'bolt';
  return 'arrow';
}
