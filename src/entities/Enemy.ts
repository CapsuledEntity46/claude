import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import type { DamageResult, DefenseProfile } from '../combat/types';
import { isSolid } from '../world/blocks';
import type { EnemyArchetype } from './archetypes';
import { buildCreature, type CreatureLeg } from '../fx/creatures';

const GRAVITY = 26;
const ENEMY_HALF_WIDTH = 0.35;
const STEP_HEIGHT = 1.02;
/** Just long enough for the manager to read the corpse before it is reaped. */
const DEATH_DURATION = 0.1;

type AIState = 'idle' | 'chase' | 'windup' | 'recover' | 'reposition' | 'backoff' | 'dying';

/**
 * How far out a melee enemy both strikes and holds station, as a multiple of its reach.
 *
 * Deliberately one number. Two different thresholds leave a band where the enemy is too
 * far to swing but close enough to stop advancing, and it circles there forever.
 */
const MELEE_ENGAGE = 1.05;

// Creature bodies come from fx/creatures. Only the health bar quad is shared.
const GEO = {
  bar: new THREE.PlaneGeometry(1, 1),
};

export class Enemy {
  readonly archetype: EnemyArchetype;
  readonly level: number;

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;

  hp: number;
  readonly maxHp: number;
  readonly defense: DefenseProfile;
  /**
   * Standing height, in world units.
   *
   * Set provisionally in the constructor and corrected in `build()` once the model
   * knows its own proportions. Used for the aim point, the health bar, and the
   * collision capsule, so it has to reflect the creature actually drawn.
   */
  height: number;

  readonly group = new THREE.Group();
  /**
   * The rotating body. Kept separate from `group` so that `group` stays
   * axis-aligned: the health bar is billboarded by copying the camera's
   * quaternion, which only works if its parent has no rotation of its own.
   */
  private body!: THREE.Group;
  private rightArm!: THREE.Group;
  private leftArm!: THREE.Group;
  /** Every leg, for gaits with more than two. Spiders have eight. */
  private legs: CreatureLeg[] = [];
  private materials: THREE.MeshLambertMaterial[] = [];
  private healthBar!: THREE.Group;
  private healthFill!: THREE.Mesh;

  private state: AIState = 'idle';
  private stateTimer = 0;
  private attackCooldown = 0;
  private hitFlash = 0;
  private walkPhase = 0;
  private onGround = false;
  /** Set once the enemy has noticed the player; it then stays hostile. */
  private aggro = false;
  private wanderTarget: THREE.Vector3 | null = null;
  private wanderTimer = 0;
  private dyingTimer = 0;
  /** Seconds of remaining movement slow, from Frost Shard and similar. */
  private slowTimer = 0;
  /** Seconds spent out of water, for aquatic creatures. */
  private suffocation = 0;
  /** How long the player has been too far away to bother chasing. */
  private lostInterestTimer = 0;
  /** Fire damage over time: seconds remaining and damage per second. */
  private burnTimer = 0;
  private burnRate = 0;
  private burnTick = 0;
  /** Seconds the enemy is held rigid and cannot act. */
  private stunTimer = 0;
  /** Drives the forward strike: counts down through the swing itself. */
  private strikeTimer = 0;
  private strikeDuration = 0.14;
  /** Chosen at spawn so a group of enemies does not act in lockstep. */
  private readonly jitter: number;

  dead = false;
  /** True once the death animation is finished and the entity can be reaped. */
  removable = false;

  constructor(archetype: EnemyArchetype, level: number, position: THREE.Vector3, rng: () => number) {
    this.archetype = archetype;
    this.level = level;
    this.position.copy(position);
    this.jitter = rng();

    this.maxHp = Math.round(archetype.baseHp + archetype.hpPerLevel * (level - 1));
    this.hp = this.maxHp;
    this.height = 1.8 * archetype.look.scale;

    const tierArmor = Math.floor(level / 3) * archetype.armorPerTier;
    this.defense = {
      armor: archetype.defense.armor + tierArmor,
      resist: { ...archetype.defense.resist },
      armorFactor: { ...archetype.defense.armorFactor },
    };

    this.build();
  }

  get name(): string {
    return `${this.archetype.name} (Lv ${this.level})`;
  }

  /**
   * The enemy's own colours, for break particles.
   *
   * Sampled from the materials it is actually built from, so the shatter is made
   * of the creature's own pixels rather than generic grey dust. Slight tonal
   * variation per entry stops the shower looking like three flat colours.
   */
  breakPalette(): THREE.Color[] {
    const look = this.archetype.look;
    const base = [look.body, look.head, look.accent];
    const palette: THREE.Color[] = [];
    for (const hex of base) {
      const colour = new THREE.Color(hex);
      palette.push(colour.clone());
      palette.push(colour.clone().multiplyScalar(0.72));
      palette.push(colour.clone().multiplyScalar(1.22));
    }
    return palette;
  }

  /** Aim point: mid-torso rather than the feet. */
  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.55, this.position.z);
  }

  get eye(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.85, this.position.z);
  }

  get radius(): number {
    return ENEMY_HALF_WIDTH * (this.archetype.look.scale / 0.85);
  }

  // ---------------------------------------------------------------- appearance

  /**
   * Builds the model for this archetype.
   *
   * The geometry lives in fx/creatures, one silhouette per archetype. It used to be
   * assembled here from five shared boxes for every enemy in the game, so a goblin
   * and an ogre differed only in colour and scale.
   */
  private build(): void {
    const look = this.archetype.look;
    const parts = buildCreature(this.archetype.id, look, this.materials);

    this.rightArm = parts.rightArm;
    this.leftArm = parts.leftArm;
    this.legs = parts.legs;

    // The model's own height is authoritative; the archetype only multiplies it.
    //
    // An earlier version normalised every creature to 1.8 units before scaling,
    // which stretched a spider — modelled deliberately low and wide — up to the
    // height of a man on legs three times too long. A creature's proportions are a
    // modelling decision, and squaring them away here silently discards them.
    const g = parts.group;
    g.scale.setScalar(look.scale);
    this.height = parts.height * look.scale;
    this.body = g;
    this.group.add(g);

    this.buildHealthBar();
    this.group.position.copy(this.position);
  }

  private buildHealthBar(): void {
    this.healthBar = new THREE.Group();

    const backing = new THREE.Mesh(
      GEO.bar,
      new THREE.MeshBasicMaterial({ color: 0x1a1014, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    backing.scale.set(1.1, 0.13, 1);

    this.healthFill = new THREE.Mesh(
      GEO.bar,
      new THREE.MeshBasicMaterial({ color: 0xc0392b, depthWrite: false }),
    );
    this.healthFill.scale.set(1.04, 0.09, 1);
    this.healthFill.position.z = 0.01;

    this.healthBar.add(backing, this.healthFill);
    this.healthBar.position.y = this.height + 0.34;
    this.healthBar.visible = false;
    this.group.add(this.healthBar);
  }

  /**
   * Health bar state in world space, for regression testing the billboard.
   * The bar is oriented by copying the camera's quaternion, which silently breaks
   * if its parent ever gains a rotation of its own.
   */
  get healthBarDebug(): { visible: boolean; worldQuaternion: THREE.Quaternion } {
    return {
      visible: this.healthBar.visible,
      worldQuaternion: this.healthBar.getWorldQuaternion(new THREE.Quaternion()),
    };
  }

  /** Billboards the health bar and keeps its width in sync with current HP. */
  faceCamera(camera: THREE.Camera): void {
    if (!this.healthBar.visible) return;
    this.healthBar.quaternion.copy(camera.quaternion);
    const frac = Math.max(0, this.hp / this.maxHp);
    this.healthFill.scale.x = 1.04 * frac;
    // Scale about the left edge so the bar drains rather than shrinking centred.
    this.healthFill.position.x = -1.04 * (1 - frac) * 0.5;
  }

  // ---------------------------------------------------------------- damage

  /** Applies a resolved damage result. Returns true if this killed the enemy. */
  applyDamage(result: DamageResult, fromDirection: THREE.Vector3, knockback: number, ctx: GameContext): boolean {
    if (this.dead) return false;

    this.hp -= result.damage;
    this.hitFlash = 0.12;
    this.healthBar.visible = true;
    // Being hit wakes it *and* sets it hunting.
    //
    // This used to set `aggro` alone, which left an enemy shot from outside its sight
    // range permanently awake and permanently idle: the acquire check at the top of
    // `update` is guarded on `!this.aggro`, so it never ran again and the state never
    // left 'idle'. Shooting something from a distance did nothing but chip its health
    // while it wandered about.
    this.alert();

    // Getting hit interrupts a wind-up, which rewards aggressive play.
    if (this.state === 'windup' && result.damage > this.maxHp * 0.08) {
      this.state = 'recover';
      this.stateTimer = 0.25;
    }

    const push = fromDirection.clone().setY(0).normalize().multiplyScalar(knockback);
    this.velocity.x += push.x;
    this.velocity.z += push.z;
    if (knockback > 5) this.velocity.y = Math.max(this.velocity.y, 2.6);

    const bloodColor =
      this.archetype.id === 'skeleton_knight' ? 0xdad6c8 : this.archetype.aquatic ? 0x9fd0e0 : 0x8a1420;
    ctx.particles.burst(this.center, result.crit ? 16 : 9, result.crit ? 6 : 4, {
      color: bloodColor,
      size: 0.09,
      life: 0.55,
      gravity: 16,
    });

    if (this.hp <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  private die(): void {
    this.dead = true;
    this.state = 'dying';
    this.dyingTimer = DEATH_DURATION;
    this.healthBar.visible = false;
    // The body disappears immediately; the shatter that replaces it is emitted by
    // EntityManager, which owns the particle system.
    this.body.visible = false;
  }

  // ---------------------------------------------------------------- AI

  /** Current AI state and whether it has noticed the player, for tests. */
  get aiState(): string {
    return this.state;
  }

  get isHunting(): boolean {
    return this.aggro;
  }

  /** Wakes the enemy — used by loud noises like gunfire and explosions. */
  alert(): void {
    this.aggro = true;
    if (this.state === 'idle') this.state = 'chase';
  }

  /** Drops pursuit and goes back to wandering. */
  private loseInterest(): void {
    this.aggro = false;
    this.lostInterestTimer = 0;
    this.state = 'idle';
    this.wanderTarget = null;
    this.wanderTimer = 0;
    this.healthBar.visible = false;
  }

  applySlow(seconds: number): void {
    this.slowTimer = Math.max(this.slowTimer, seconds);
  }

  /** Sets the target alight. Refreshing extends rather than stacking. */
  applyBurn(damagePerSecond: number, seconds: number): void {
    this.burnRate = Math.max(this.burnRate, damagePerSecond);
    this.burnTimer = Math.max(this.burnTimer, seconds);
  }

  applyStun(seconds: number): void {
    this.stunTimer = Math.max(this.stunTimer, seconds);
    // Interrupt whatever was being wound up.
    if (this.state === 'windup') {
      this.state = 'recover';
      this.stateTimer = seconds;
    }
  }

  get stunned(): boolean {
    return this.stunTimer > 0;
  }

  /** Effective movement speed, after chilling effects. */
  private get currentSpeed(): number {
    return this.archetype.speed * (this.slowTimer > 0 ? 0.45 : 1);
  }

  update(dt: number, ctx: GameContext): void {
    if (this.slowTimer > 0) this.slowTimer -= dt;
    this.updateStatusEffects(dt, ctx);

    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const flash = this.hitFlash > 0;
      for (const m of this.materials) m.emissive.setScalar(flash ? 0.55 : 0);
    }

    if (this.state === 'dying') {
      // Nothing to animate: the body is already gone and the break particles are
      // independent of the entity. The timer only delays reaping so the manager
      // has a frame to read the corpse's position and palette.
      this.dyingTimer -= dt;
      if (this.dyingTimer <= 0) this.removable = true;
      return;
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    // Stunned: held rigid, still falls, but takes no action.
    if (this.stunTimer > 0) {
      this.velocity.x *= 0.7;
      this.velocity.z *= 0.7;
      this.integrate(dt, ctx);
      return;
    }

    const toPlayer = ctx.player.center.clone().sub(this.center);
    const distance = toPlayer.length();

    // Prey does not fight. It swims, and it runs.
    if (this.archetype.passive) {
      this.updatePassive(dt, ctx, distance);
      return;
    }

    if (!this.aggro && distance < this.effectiveAggroRange(ctx) && this.hasLineOfSight(ctx, distance)) {
      this.aggro = true;
      this.state = 'chase';
      if (this.archetype.hint) ctx.log(`${this.archetype.name}: ${this.archetype.hint}`, 'info');
    }

    // Always face the player once hostile — a monster that attacks sideways
    // reads as broken.
    if (this.aggro) this.yaw = Math.atan2(-toPlayer.x, -toPlayer.z);

    // Give up eventually. Chasing forever means outrunning a fight is impossible
    // and every enemy you ever met is still following you.
    if (this.aggro) {
      const sight = this.effectiveAggroRange(ctx);
      if (distance > sight * 3.2) {
        // Well out of range: lose the trail immediately.
        this.loseInterest();
      } else if (distance > sight * 1.7) {
        this.lostInterestTimer += dt;
        if (this.lostInterestTimer > 7) this.loseInterest();
      } else {
        this.lostInterestTimer = 0;
      }
    }

    switch (this.state) {
      case 'idle':
        this.doIdle(dt);
        break;
      case 'chase':
        this.doChase(ctx, distance);
        break;
      case 'reposition':
        this.doReposition(dt, ctx, distance);
        break;
      case 'windup':
        this.doWindup(dt, ctx, distance);
        break;
      case 'recover':
        this.velocity.x *= 0.85;
        this.velocity.z *= 0.85;
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          if (!this.aggro) this.state = 'idle';
          else if (this.archetype.melee) {
            // Disengage briefly so the player gets a window to answer.
            this.state = 'backoff';
            this.stateTimer = 0.35 + this.jitter * 0.4;
          } else {
            this.state = 'chase';
          }
        }
        break;

      case 'backoff': {
        this.stateTimer -= dt;
        const away = this.position.clone().sub(ctx.player.position).setY(0);
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        this.steerTowards(this.position.clone().addScaledVector(away.normalize(), 4), this.currentSpeed * 0.8);
        if (this.stateTimer <= 0) this.state = 'chase';
        break;
      }
      default:
        break;
    }

    this.integrate(dt, ctx);
    this.animate(dt);
  }

  /**
   * How far this enemy can notice the player.
   *
   * Scaled by daylight: things see much less far in the dark, which turns night
   * into a stalking hazard rather than a wall of aggro, and keeps the daytime
   * sight range short enough to build in peace.
   */
  private effectiveAggroRange(ctx: GameContext): number {
    const daylight = ctx.daylight;
    return this.archetype.aggroRange * (0.55 + daylight * 0.45);
  }

  /** Wander, and flee anything that gets close. Used by fish. */
  private updatePassive(dt: number, ctx: GameContext, distance: number): void {
    const fleeRange = this.archetype.aggroRange;
    if (distance < fleeRange) {
      const away = this.position.clone().sub(ctx.player.position);
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      away.normalize();
      const target = this.position.clone().addScaledVector(away, 6);
      this.steerSwim(ctx, target, this.currentSpeed * 1.5);
      this.yaw = Math.atan2(-away.x, -away.z);
    } else {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0 || !this.wanderTarget) {
        this.wanderTimer = 3 + this.jitter * 4;
        this.wanderTarget = this.pickSwimTarget(ctx);
      }
      if (this.wanderTarget) {
        this.steerSwim(ctx, this.wanderTarget, this.currentSpeed * 0.5);
        const dir = this.wanderTarget.clone().sub(this.position);
        if (dir.lengthSq() > 0.01) this.yaw = Math.atan2(-dir.x, -dir.z);
      }
    }

    this.integrateAquatic(dt, ctx);
    this.animateFish(dt);
  }

  /** Picks a nearby point that is still underwater. */
  private pickSwimTarget(ctx: GameContext): THREE.Vector3 | null {
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = this.position
        .clone()
        .add(new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 12));
      if (ctx.world.isWaterAt(candidate.x, candidate.y, candidate.z)) return candidate;
    }
    return null;
  }

  private steerSwim(ctx: GameContext, target: THREE.Vector3, speed: number): void {
    const dir = target.clone().sub(this.position);
    if (dir.lengthSq() < 1e-4) return;
    dir.normalize().multiplyScalar(speed);

    // Refuse to steer out of the water; beaching itself looks broken.
    const ahead = this.position.clone().addScaledVector(dir, 0.35);
    if (!ctx.world.isWaterAt(ahead.x, ahead.y, ahead.z)) {
      dir.multiplyScalar(-0.5);
    }

    this.velocity.lerp(dir, 0.12);
  }

  /**
   * Buoyant swimming. Out of water a fish falls, flops, and suffocates — which is
   * what makes spearing one in the shallows viable.
   */
  private integrateAquatic(dt: number, ctx: GameContext): void {
    const submerged = ctx.world.isWaterAt(this.position.x, this.position.y, this.position.z);

    if (submerged) {
      this.velocity.multiplyScalar(Math.max(0, 1 - 1.6 * dt));
      this.suffocation = 0;
    } else {
      this.velocity.y -= GRAVITY * dt;
      this.velocity.x *= 0.9;
      this.velocity.z *= 0.9;
      this.suffocation += dt;
      if (this.suffocation > 6) {
        this.hp = 0;
        this.die();
        return;
      }
    }

    const next = this.position.clone().addScaledVector(this.velocity, dt);
    // Simple sphere-ish collision: refuse moves into solid blocks.
    if (!ctx.world.isSolidAt(next.x, next.y, next.z)) {
      this.position.copy(next);
    } else {
      this.velocity.multiplyScalar(-0.3);
    }

    this.group.position.copy(this.position);
    this.body.rotation.y = this.yaw;
  }

  private animateFish(dt: number): void {
    const speed = this.velocity.length();
    this.walkPhase += dt * (4 + speed * 3);
    // Tail beat scales with effort.
    this.rightArm.rotation.y = Math.sin(this.walkPhase) * (0.25 + Math.min(0.5, speed * 0.12));
    this.body.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.08;
  }

  /** Ticks burning and stun, including the damage burning deals. */
  private updateStatusEffects(dt: number, ctx: GameContext): void {
    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      // A ring of sparks so a stunned enemy is obviously out of the fight.
      if (Math.random() < dt * 14) {
        ctx.particles.burst(this.center, 2, 1.6, { color: 0xbfe4ff, size: 0.06, life: 0.25, gravity: -2 });
      }
    }

    if (this.burnTimer <= 0) return;
    this.burnTimer -= dt;
    this.burnTick -= dt;

    // Applied in half-second ticks so floating numbers stay readable.
    if (this.burnTick <= 0) {
      this.burnTick = 0.5;
      ctx.enemies.damageEnemy(
        this,
        { amount: this.burnRate * 0.5, type: 'fire', armorPierce: 0.6, canCrit: false },
        this.center.clone().add(new THREE.Vector3(0, 1, 0)),
        0,
      );
    }
    if (Math.random() < dt * 26) {
      ctx.particles.spawn(
        this.center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.6, (Math.random() - 0.5) * 0.6)),
        new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.4 + Math.random(), (Math.random() - 0.5) * 0.5),
        { color: Math.random() < 0.4 ? 0xffd070 : 0xff6a20, size: 0.08, life: 0.45, gravity: -3, drag: 1.6 },
      );
    }
  }

  private hasLineOfSight(ctx: GameContext, distance: number): boolean {
    const from = this.eye;
    const dir = ctx.player.center.clone().sub(from).normalize();
    const hit = ctx.world.raycast(from, dir, Math.min(distance, 48), isSolid);
    return !hit || hit.distance >= distance - 0.6;
  }

  private doIdle(dt: number): void {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 2.5 + this.jitter * 3;
      // Half the time, stand still. Constant motion looks twitchy.
      this.wanderTarget =
        Math.random() < 0.5
          ? null
          : this.position.clone().add(new THREE.Vector3(Math.random() * 12 - 6, 0, Math.random() * 12 - 6));
    }
    if (this.wanderTarget) {
      this.steerTowards(this.wanderTarget, this.archetype.speed * 0.35);
      this.yaw = Math.atan2(-(this.wanderTarget.x - this.position.x), -(this.wanderTarget.z - this.position.z));
    } else {
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    }
  }

  private doChase(ctx: GameContext, distance: number): void {
    const ranged = this.archetype.ranged;
    const melee = this.archetype.melee;

    // Ranged archetypes fight at a standoff and back away when crowded.
    if (ranged && distance > this.archetype.aggroRange * 1.6) {
      this.state = 'idle';
      this.aggro = false;
      return;
    }

    if (ranged && distance < ranged.standoff * 0.6) {
      this.state = 'reposition';
      this.stateTimer = 0.6 + this.jitter * 0.4;
      return;
    }

    if (ranged && distance <= ranged.standoff * 1.6 && this.attackCooldown <= 0 && this.hasLineOfSight(ctx, distance)) {
      this.beginAttack('ranged', ranged.windup);
      return;
    }

    // One threshold for both striking and holding position.
    //
    // These used to disagree: it would attack inside 0.92 of its reach but hold and
    // circle anywhere inside 1.05, leaving a band where it did neither. Circling holds
    // distance roughly constant, so an enemy that arrived in that band orbited the
    // player indefinitely without ever swinging — which is exactly what it looked like.
    if (melee && distance <= melee.reach * MELEE_ENGAGE && this.attackCooldown <= 0) {
      this.beginAttack('melee', melee.windup);
      return;
    }

    // In range but still on cooldown: hold the line and circle instead of walking into
    // the player. Shoving the player around while flailing made fights unwinnable
    // except by retreating in a straight line.
    if (melee && distance <= melee.reach * MELEE_ENGAGE) {
      const strafe = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const sign = this.jitter > 0.5 ? 1 : -1;
      const target = this.position.clone().addScaledVector(strafe, sign * 3);
      // Ease outwards only if genuinely inside its own guard, and only a little: a
      // bigger nudge walks it out of strike range, so the cooldown expires with the
      // player too far away and it never commits.
      if (distance < melee.reach * 0.55) {
        const away = this.position.clone().sub(ctx.player.position).setY(0);
        if (away.lengthSq() > 1e-4) target.addScaledVector(away.normalize(), 0.8);
      }
      this.steerTowards(target, this.currentSpeed * 0.5);
      return;
    }

    const desiredSpeed = this.currentSpeed;
    if (ranged && distance <= ranged.standoff) {
      // In position and waiting on the cooldown: sidestep instead of standing.
      const strafe = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const sign = this.jitter > 0.5 ? 1 : -1;
      this.steerTowards(this.position.clone().addScaledVector(strafe, sign * 4), desiredSpeed * 0.55);
    } else {
      this.steerTowards(ctx.player.position, desiredSpeed);
    }
  }

  /**
   * Give ground — while still shooting.
   *
   * This used to be a pure retreat, so closing on an archer switched it off entirely:
   * it would turn and walk away without ever loosing another arrow, and the way to beat
   * one was simply to jog at it. Backing off is the right instinct, but a bowman gives
   * ground *and* keeps shooting.
   */
  private doReposition(dt: number, ctx: GameContext, distance: number): void {
    this.stateTimer -= dt;
    const away = this.position.clone().sub(ctx.player.position).setY(0);
    if (away.lengthSq() < 0.001) away.set(1, 0, 0);
    this.steerTowards(this.position.clone().add(away.normalize().multiplyScalar(6)), this.currentSpeed * 0.9);

    const ranged = this.archetype.ranged;
    if (ranged && this.attackCooldown <= 0 && this.hasLineOfSight(ctx, distance)) {
      this.beginAttack('ranged', ranged.windup);
      return;
    }
    if (this.stateTimer <= 0 || (ranged && distance > ranged.standoff)) this.state = 'chase';
  }

  private beginAttack(kind: 'melee' | 'ranged', windup: number): void {
    this.state = 'windup';
    this.stateTimer = windup;
    this.pendingAttack = kind;
    this.velocity.x *= 0.3;
    this.velocity.z *= 0.3;
  }

  private pendingAttack: 'melee' | 'ranged' = 'melee';

  private doWindup(dt: number, ctx: GameContext, distance: number): void {
    this.stateTimer -= dt;

    // A crowded archer keeps backing away as it draws, rather than planting its feet.
    // Standing still to aim while something runs at you with a sword is what made
    // closing the distance a free win.
    const givingGround = this.archetype.ranged;
    if (this.pendingAttack === 'ranged' && givingGround && distance < givingGround.standoff) {
      const away = this.position.clone().sub(ctx.player.position).setY(0);
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      this.steerTowards(this.position.clone().addScaledVector(away.normalize(), 5), this.currentSpeed * 0.75);
    } else {
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    }
    if (this.stateTimer > 0) return;

    if (this.pendingAttack === 'melee') {
      const melee = this.archetype.melee!;
      this.attackCooldown = melee.cooldown;
      this.state = 'recover';
      this.stateTimer = melee.recovery;
      // Drive the visible forward strike, which is what the damage should look
      // like landing. Without it the arm was still wound back at impact.
      this.strikeTimer = this.strikeDuration;

      // The player can still escape during the telegraph — check reach again.
      if (distance <= melee.reach * 1.15) {
        ctx.damagePlayer(
          {
            amount: melee.damage + this.level * 0.8,
            type: melee.type,
            armorPierce: melee.armorPierce,
            critChance: 0.05,
          },
          this.center,
          this.name,
        );
        const dir = ctx.player.center.clone().sub(this.center).normalize();
        ctx.particles.cone(this.center.clone().addScaledVector(dir, 0.9), dir, 6, 5, 0.5, {
          color: 0xffe0a0,
          size: 0.07,
          life: 0.25,
          gravity: 4,
        });
      } else {
        ctx.particles.cone(this.center, this.forward(), 4, 4, 0.6, { color: 0x998877, size: 0.06, life: 0.2, gravity: 6 });
      }
      return;
    }

    const ranged = this.archetype.ranged!;
    this.attackCooldown = ranged.cooldown;
    this.state = 'recover';
    this.stateTimer = 0.3;

    const origin = this.eye.clone();
    const target = ctx.player.center;
    const dir = target.clone().sub(origin);
    const flatDistance = Math.hypot(dir.x, dir.z);
    dir.normalize();

    // Compensate for projectile drop so archers actually hit at range.
    //
    // Over a flight of t = distance / speed the arrow falls 0.5*g*t^2. Converting
    // that fall into an aim offset on a normalised direction means dividing by the
    // distance. The original expression multiplied by distance instead, which
    // scaled the correction quadratically and sent every arrow sailing overhead.
    if (ranged.gravity > 0 && flatDistance > 0.01) {
      const flightTime = flatDistance / ranged.speed;
      const fall = 0.5 * GRAVITY * ranged.gravity * flightTime * flightTime;
      dir.y += fall / flatDistance;
      dir.normalize();
    }

    ctx.spawnProjectile({
      origin,
      direction: dir,
      speed: ranged.speed,
      damage: ranged.damage + this.level * 0.7,
      type: ranged.type,
      armorPierce: ranged.armorPierce,
      gravity: ranged.gravity,
      knockback: 2,
      hostile: true,
      look: ranged.look,
      color: ranged.color,
      sourceName: this.name,
    });
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  private steerTowards(target: THREE.Vector3, speed: number): void {
    const dir = target.clone().sub(this.position).setY(0);
    if (dir.lengthSq() < 0.0001) return;
    dir.normalize().multiplyScalar(speed);
    const control = this.onGround ? 0.25 : 0.06;
    this.velocity.x += (dir.x - this.velocity.x) * control;
    this.velocity.z += (dir.z - this.velocity.z) * control;
  }

  /** Nudge applied by the entity manager to stop enemies stacking. */
  push(dx: number, dz: number): void {
    this.velocity.x += dx;
    this.velocity.z += dz;
  }

  // ---------------------------------------------------------------- physics

  private collides(ctx: GameContext, x: number, y: number, z: number): boolean {
    const r = this.radius - 0.02;
    return ctx.world.boxIntersectsSolid(x - r, y + 0.01, z - r, x + r, y + this.height - 0.02, z + r);
  }

  private integrate(dt: number, ctx: GameContext): void {
    this.velocity.y = Math.max(-50, this.velocity.y - GRAVITY * dt);

    const nextY = this.position.y + this.velocity.y * dt;
    if (!this.collides(ctx, this.position.x, nextY, this.position.z)) {
      this.position.y = nextY;
      this.onGround = false;
    } else {
      if (this.velocity.y < 0) {
        this.position.y = Math.ceil(nextY);
        let guard = 0;
        while (this.collides(ctx, this.position.x, this.position.y, this.position.z) && guard++ < 60) {
          this.position.y += 0.05;
        }
        this.onGround = true;
      }
      this.velocity.y = 0;
    }

    this.moveAxis(ctx, 'x', this.velocity.x * dt);
    this.moveAxis(ctx, 'z', this.velocity.z * dt);

    // Rescue anything that ends up buried, e.g. after a nearby explosion.
    if (this.collides(ctx, this.position.x, this.position.y, this.position.z)) {
      this.position.y += 0.6;
    }

    this.group.position.copy(this.position);
    this.body.rotation.y = this.yaw;
  }

  private moveAxis(ctx: GameContext, axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return;
    const target = this.position[axis] + delta;
    const test = (v: number, y: number) =>
      this.collides(ctx, axis === 'x' ? v : this.position.x, y, axis === 'z' ? v : this.position.z);

    if (!test(target, this.position.y)) {
      this.position[axis] = target;
      return;
    }
    if (this.onGround) {
      const stepY = this.position.y + STEP_HEIGHT;
      if (!test(target, stepY) && !this.collides(ctx, this.position.x, stepY, this.position.z)) {
        this.position[axis] = target;
        this.position.y = stepY;
        return;
      }
      // Hop at a wall it cannot step over; enough to clear most terrain.
      this.velocity.y = 6.5;
    }
    this.velocity[axis] = 0;
  }

  // ---------------------------------------------------------------- animation

  private animate(dt: number): void {
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (2 + horizontalSpeed * 2.2);

    const stride = Math.min(1, horizontalSpeed / 4) * 0.65;
    // Every leg, each on its own phase. Driving only the two named pivots left a
    // spider hauling itself along on two legs with six held rigid.
    for (const leg of this.legs) {
      leg.pivot.rotation.x = Math.sin(this.walkPhase + leg.phase) * stride;
    }
    this.leftArm.rotation.x = -Math.sin(this.walkPhase) * stride * 0.6;

    // The attacking arm rises through the wind-up and snaps forward on release.
    //
    // The arm mesh hangs below its shoulder pivot, so rotating about +X swings it
    // towards -Z, which is the direction the body faces. A negative angle raises
    // it behind the shoulder. Winding back is right; the bug was that the strike
    // itself was a slow lerp that had barely started by the time the damage
    // landed, so the blow was never seen going forward.
    if (this.strikeTimer > 0) {
      this.strikeTimer -= dt;
      const t = 1 - Math.max(0, this.strikeTimer) / this.strikeDuration;
      // Whip from wound-back through to a committed forward swing.
      this.rightArm.rotation.x = THREE.MathUtils.lerp(-1.35, 1.15, easeOutCubic(t));
    } else if (this.state === 'windup') {
      const windup = this.pendingAttack === 'melee' ? this.archetype.melee!.windup : this.archetype.ranged!.windup;
      const progress = 1 - Math.max(0, this.stateTimer) / windup;
      this.rightArm.rotation.x = -1.35 * easeOutCubic(progress);
    } else if (this.state === 'recover') {
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, 0.35, dt * 10);
    } else {
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, Math.sin(this.walkPhase) * stride * 0.6, dt * 8);
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.healthBar.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
  }
}

/** Fast out of the gate, settling at the end: reads as a committed blow. */
function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) ** 3;
}
