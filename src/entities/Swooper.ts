import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import type { EnemyArchetype } from './archetypes';
import { StatusEffectManager, StatusEffectType } from '../combat/StatusEffectSystem';
import { AttackTokenSystem } from '../combat/AttackTokenSystem';
import { DamageResult } from '../combat/types';
import { isSolid } from '../world/blocks';
import type { CreatureLeg } from '../fx/creatures';
import { buildCreature } from '../fx/creatures';

/**
 * Melee Flyer (Swooper): Hovers high. When attacking, it triggers a 1.5-second Telegraphed Wind-up
 * (hovers in place, plays a visual tell, emits a sound cue). It then locks the player's 3D position
 * and fast-dives. Hit or miss, it enters a 2-second Recovery State resting low to the ground with
 * lowered defense, giving the player a fair window to strike back.
 */
export class Swooper {
  readonly archetype: EnemyArchetype;
  readonly level: number;
  readonly statusEffectType: StatusEffectType; // Dynamic status loadout

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;

  hp: number;
  readonly maxHp: number;
  private defense: { armor: number; resist: Record<string, number> };

  // For visual model (reuse creature system)
  private group = new THREE.Group();
  private body!: THREE.Group;
  private rightArm!: THREE.Group;
  private leftArm!: THREE.Group;
  private materials: THREE.MeshLambertMaterial[] = [];
  private legs: CreatureLeg[] = [];
  private healthBar!: THREE.Group;
  private healthFill!: THREE.Mesh;

  // AI State Machine
  private state: 'idle' | 'windup' | 'attack' | 'recovery' | 'reposition' = 'idle';
  private stateTimer = 0;
  private attackCooldown = 0;
  private hitFlash = 0;
  private wanderTarget: THREE.Vector3 | null = null;
  private wanderTimer = 0;
  private aggro = false;
  private jitter: number;
  private onGround = false;
  private suffocation = 0;
  private lostInterestTimer = 0;
  private dyingTimer = 0;
  private removable = false;

  // --- Fields from Enemy that we need for applyDamage to compile ---
  private stunTimer = 0;
  private burnTimer = 0;
  private burnTick = 0;
  private burnRate = 0;
  private strikeTimer = 0;
  private strikeDuration = 0.14;
  private pendingAttack: 'melee' | 'ranged' = 'melee';
  private height = 1.8; // default height

  // Swooper-specific
  private readonly hoverHeight = 8.0; // Hovers high
  private readonly diveSpeed = 25.0; // Fast-dive speed
  private readonly recoveryHeight = 1.0; // Recovery state low to ground
  private readonly windupDuration = 1.5; // 1.5-second telegraphed wind-up
  private readonly recoveryDuration = 2.0; // 2-second recovery
  private readonly attackTokenSystem = AttackTokenSystem.getInstance();
  private readonly statusEffectManager = StatusEffectManager.getInstance();
  private hasAttackToken = false;

  dead = false;

  constructor(archetype: EnemyArchetype, level: number, position: THREE.Vector3, statusEffectType: StatusEffectType, rng: () => number) {
    this.archetype = archetype;
    this.level = level;
    this.statusEffectType = statusEffectType;
    this.position.copy(position);
    this.jitter = rng();

    // Initialize stats based on archetype
    this.maxHp = Math.round(archetype.baseHp + archetype.hpPerLevel * (level - 1));
    this.hp = this.maxHp;
    this.defense = {
      armor: archetype.defense.armor,
      resist: { ...archetype.defense.resist }
    };

    // Initialize visual model using the creature system
    this.initializeModel();

    // Start hovering at hoverHeight
    this.position.y = this.hoverHeight;
  }

  private initializeModel(): void {
    const look = this.archetype.look;
    const parts = buildCreature(this.archetype.id, look, this.materials);

    this.rightArm = parts.rightArm;
    this.leftArm = parts.leftArm;
    this.legs = parts.legs;

    // The model's own height is authoritative; the archetype only multiplies it.
    const g = parts.group;
    g.scale.setScalar(look.scale);
    this.height = parts.height * look.scale;
    this.body = g;
    this.group.add(g);

    this.buildHealthBar();
    this.group.position.copy(this.position);
  }

  private buildHealthBar(): void {
    // Simplified health bar - we'll reuse the same logic as Enemy but adjusted
    const GEO = {
      bar: new THREE.PlaneGeometry(1, 1),
    };

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

  get name(): string {
    return `${this.archetype.name} (Lv ${this.level}) [${this.statusEffectType}]`;
  }

  /** Get the center point (for targeting) */
  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.55, this.position.z);
  }

  /** Get radius for collision */
  get radius(): number {
    const ENEMY_HALF_WIDTH = 0.35;
    return ENEMY_HALF_WIDTH * (this.archetype.look.scale / 0.85);
  }

  update(dt: number, ctx: GameContext): void {
    if (this.dead) return;

    // Update timers
    this.stateTimer = Math.max(0, this.stateTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.wanderTimer = Math.max(0, this.wanderTimer - dt);

    // Update status effects (burn, stun, etc.) - simplified for flying enemies
    this.updateStatusEffects(dt, ctx);

    // Handle hit flash
    if (this.hitFlash > 0) {
      const flash = this.hitFlash > 0;
      for (const m of this.materials) m.emissive.setScalar(flash ? 0.55 : 0);
    }

    // State machine
    switch (this.state) {
      case 'idle':
        this.updateIdle(dt, ctx);
        break;
      case 'windup':
        this.updateWindup(dt, ctx);
        break;
      case 'attack':
        this.updateAttack(dt, ctx);
        break;
      case 'recovery':
        this.updateRecovery(dt, ctx);
        break;
      case 'reposition':
        this.updateReposition(dt, ctx);
        break;
    }

    // Update visual model position and rotation
    this.group.position.copy(this.position);
    this.body.rotation.y = this.yaw;
    // Simple arm animation
    if (this.state === 'windup') {
      const windupProgress = 1 - this.stateTimer / this.windupDuration;
      this.rightArm.rotation.x = -1.35 * Math.pow(windupProgress, 3); // easeOutCubic approximation
    } else if (this.state === 'attack') {
      // During attack, arms are forward
      this.rightArm.rotation.x = 1.15;
    } else if (this.state === 'recovery') {
      // Recover arms
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, 0.35, dt * 10);
    } else {
      // Idle arm swing
      this.rightArm.rotation.x = Math.sin(this.stateTimer * 2) * 0.3;
    }
  }

  private updateStatusEffects(dt: number, ctx: GameContext): void {
    // Simplified: only burn and stun for now (as in original Enemy)
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

  // --- State machine implementations ---

  private updateIdle(dt: number, ctx: GameContext): void {
    // Hover at hoverHeight with gentle drift
    if (Math.abs(this.position.y - this.hoverHeight) > 0.1) {
      // Drift towards hover height
      this.position.y += (this.hoverHeight - this.position.y) * 0.1;
    }

    // Wander slowly
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 2.0 + this.jitter * 3.0;
      this.wanderTarget = Math.random() < 0.5
        ? null
        : this.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 0, (Math.random() - 0.5) * 12));
    }

    if (this.wanderTarget) {
      this.steerTowards(this.wanderTarget, this.archetype.speed * 0.35);
      this.yaw = Math.atan2(-(this.wanderTarget.x - this.position.x), -(this.wanderTarget.z - this.position.z));
    } else {
      // Gentle hover drift
      this.velocity.x *= 0.95;
      this.velocity.z *= 0.95;
    }

    // Check for player aggro
    const toPlayer = ctx.player.center.clone().sub(this.center);
    const distance = toPlayer.length();
    if (distance < this.archetype.aggroRange && !this.aggro) {
      this.aggro = true;
      this.state = 'windup';
      this.stateTimer = this.windupDuration;
      this.requestAttackToken();
    }
  }

  private updateWindup(dt: number, ctx: GameContext): void {
    // Hover in place during windup
    this.velocity.x *= 0.8;
    this.velocity.z *= 0.8;
    // Maintain hover height
    if (this.position.y < this.hoverHeight - 0.5) {
      this.position.y += (this.hoverHeight - this.position.y) * 0.5;
    } else if (this.position.y > this.hoverHeight + 0.5) {
      this.position.y -= (this.position.y - this.hoverHeight) * 0.5;
    }

    // Face player
    const toPlayer = ctx.player.center.clone().sub(this.center);
    if (toPlayer.length() > 0.1) {
      this.yaw = Math.atan2(-toPlayer.x, -toPlayer.z);
    }

    // Windup timer
    if (this.stateTimer <= 0) {
      // Windup complete, launch attack
      this.state = 'attack';
      this.stateTimer = 0.1; // Attack phase is instant (we'll handle dive in updateAttack)
      this.launchAttack(ctx);
    }
  }

  private updateAttack(dt: number, ctx: GameContext): void {
    // Perform the fast dive towards the locked player position
    // We locked the player position at the start of windup
    // For simplicity, we'll just dive towards current player position
    const toPlayer = ctx.player.center.clone().sub(this.position);
    const distance = toPlayer.length();

    if (distance > 0.1) {
      const direction = toPlayer.normalize();
      this.velocity.copy(direction.multiplyScalar(this.diveSpeed));
      // Apply some gravity during dive? Let's add a bit
      this.velocity.y -= 5 * dt; // slight gravity pull
      this.yaw = Math.atan2(-direction.x, -direction.z);
    } else {
      // Reached player (or close enough)
      this.velocity.set(0, 0, 0);
    }

    // Attack duration: we'll consider the attack phase as lasting until we pass the player or hit ground
    // For simplicity, we'll use a fixed attack duration of 0.3 seconds
    if (this.stateTimer <= 0) {
      // Attack complete, enter recovery
      this.state = 'recovery';
      this.stateTimer = this.recoveryDuration;
      this.enterRecoveryState();
      this.releaseAttackToken();
    }
  }

  private updateRecovery(dt: number, ctx: GameContext): void {
    // Resting low to the ground with lowered defense
    // Drift towards recovery height
    if (this.position.y < this.recoveryHeight - 0.1) {
      this.position.y += (this.recoveryHeight - this.position.y) * 0.2;
    } else if (this.position.y > this.recoveryHeight + 0.1) {
      this.position.y -= (this.position.y - this.recoveryHeight) * 0.2;
    }

    // Reduce velocity (come to rest)
    this.velocity.multiplyScalar(0.9);

    // Face player (optional)
    const toPlayer = ctx.player.center.clone().sub(this.position);
    if (toPlayer.length() > 0.1) {
      this.yaw = Math.atan2(-toPlayer.x, -toPlayer.z);
    }

    if (this.stateTimer <= 0) {
      // Recovery complete, return to idle
      this.state = 'idle';
      this.stateTimer = 0;
      this.exitRecoveryState();
    }
  }

  private updateReposition(dt: number, ctx: GameContext): void {
    // Swooper doesn't really use reposition much, but we'll implement a simple hover reposition
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.state = 'idle';
    }
    // Simple hover maintenance
    if (this.position.y < this.hoverHeight - 0.1) {
      this.position.y += (this.hoverHeight - this.position.y) * 0.2;
    } else if (this.position.y > this.hoverHeight + 0.1) {
      this.position.y -= (this.position.y - this.hoverHeight) * 0.2;
    }
  }

  private requestAttackToken(): void {
    this.hasAttackToken = this.attackTokenSystem.requestToken();
    if (!this.hasAttackToken) {
      // If we can't get a token, go back to idle or chase?
      this.state = 'idle';
      this.aggro = false;
    }
  }

  private releaseAttackToken(): void {
    if (this.hasAttackToken) {
      this.attackTokenSystem.releaseToken();
      this.hasAttackToken = false;
    }
  }

  private launchAttack(ctx: GameContext): void {
    // Play windup complete sound
    ctx.sound('enemyAttack', { position: this.center, pitch: Math.max(0.55, 1.45 - 0.5 * 0.12) }); // arbitrary radius

    // Visual tell: maybe particles or glow
    // We'll add a simple particle burst
    ctx.particles.burst(this.center.clone().add(new THREE.Vector3(0, 1, 0)), 4, 2, {
      color: 0xffe0a0,
      size: 0.07,
      life: 0.25,
      gravity: 4
    });
  }

  private enterRecoveryState(): void {
    // Lowered defense: reduce armor by 50% (example)
    this.defense.armor *= 0.5;
    // Visual indicator: maybe change color
    // For now, we'll just note
  }

  private exitRecoveryState(): void {
    // Restore defense
    this.defense.armor /= 0.5; // revert the halving
  }

  private steerTowards(target: THREE.Vector3, speed: number): void {
    const dir = target.clone().sub(this.position).setY(0); // Only steer horizontally
    if (dir.lengthSq() < 0.0001) return;
    dir.normalize().multiplyScalar(speed);
    const control = 0.25; // Smooth steering
    this.velocity.x += (dir.x - this.velocity.x) * control;
    this.velocity.z += (dir.z - this.velocity.z) * control;
  }

  /**
   * Applies a resolved damage result. Returns true if this killed the enemy.
   * Matches the Enemy interface.
   */
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
    this.alert(ctx);
    ctx.sound('enemyHurt', { position: this.center, pitch: Math.max(0.6, 1.4 - this.radius * 1.1) });

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

  private alert(ctx?: GameContext): void {
    const waking = !this.aggro;
    this.aggro = true;
    if (this.state === 'idle') this.state = 'chase';
    // Guarded on the edge: `alert` is also called by every hit and by any nearby
    // gunshot, and a growl on each of those is a stuck record.
    if (waking && ctx) {
      ctx.sound('enemyAggro', { position: this.center, pitch: Math.max(0.55, 1.5 - this.radius * 1.3) });
    }
  }

  private die(): void {
    this.dead = true;
    this.state = 'dying';
    this.dyingTimer = 0.1; // DEATH_DURATION
    this.healthBar.visible = false;
    // The body disappears immediately; the shatter that replaces it is emitted by
    // EntityManager, which owns the particle system.
    this.body.visible = false;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.healthBar.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
  }

  /**
   * Called when this enemy collides with the player or attacks the player.
   * Override this to apply status effect based on statusEffectType.
   */
  public applyStatusEffectOnHit(ctx: GameContext): void {
    // Apply the status effect to the player based on this enemy's assigned type
    const effectType = this.statusEffectType;
    const statusEffectMgr = StatusEffectManager.getInstance();

    // Define effect parameters based on type
    let extra: any = {};
    switch (effectType) {
      case StatusEffectType.BURN:
        extra.dotDamage = 8.0; // High damage per second
        break;
      case StatusEffectType.POISON:
        extra.dotDamage = 1.0; // Low damage per second
        break;
      case StatusEffectType.BLEED:
        extra.dotDamage = 3.0; // Moderate damage per second
        break;
      case StatusEffectType.SLOW:
        extra.speedMultiplier = 0.65; // 35% reduction
        break;
      case StatusEffectType.SHOCK:
        extra.staggerChance = 0.3; // Chance to stagger per second
        break;
      case StatusEffectType.KNOCKBACK:
        // Calculate knockback vector away from enemy
        const knockbackDir = ctx.player.center.clone().sub(this.center).normalize().setY(0.3).normalize();
        extra.knockbackVector = knockbackDir.multiplyScalar(5.0); // 5 units knockback
        break;
      case StatusEffectType.BLINDNESS:
        extra.intensity = 1.0; // Full blindness
        break;
      case StatusEffectType.SUNDER:
        extra.armorMultiplier = 0.6; // 40% reduction
        break;
    }

    // Apply the effect
    statusEffectMgr.applyEffect(effectType, ctx, extra);
  }
}

export default Swooper;