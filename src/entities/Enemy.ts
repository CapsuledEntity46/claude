import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import type { DamageResult, DefenseProfile } from '../combat/types';
import { isSolid } from '../world/blocks';
import type { EnemyArchetype } from './archetypes';

const GRAVITY = 26;
const ENEMY_HALF_WIDTH = 0.35;
const STEP_HEIGHT = 1.02;

type AIState = 'idle' | 'chase' | 'windup' | 'recover' | 'reposition' | 'dying';

// Shared geometry — every enemy is built from the same few boxes.
const GEO = {
  torso: new THREE.BoxGeometry(0.62, 0.72, 0.36),
  head: new THREE.BoxGeometry(0.44, 0.44, 0.44),
  limb: new THREE.BoxGeometry(0.18, 0.62, 0.18),
  leg: new THREE.BoxGeometry(0.22, 0.72, 0.22),
  weapon: new THREE.BoxGeometry(0.09, 0.95, 0.09),
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
  readonly height: number;

  readonly group = new THREE.Group();
  /**
   * The rotating body. Kept separate from `group` so that `group` stays
   * axis-aligned: the health bar is billboarded by copying the camera's
   * quaternion, which only works if its parent has no rotation of its own.
   */
  private body!: THREE.Group;
  private rightArm!: THREE.Group;
  private leftArm!: THREE.Group;
  private leftLeg!: THREE.Group;
  private rightLeg!: THREE.Group;
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

  private build(): void {
    const look = this.archetype.look;
    const mat = (color: number) => {
      // Cloned per enemy so a hit can flash just this one.
      const m = new THREE.MeshLambertMaterial({ color });
      this.materials.push(m);
      return m;
    };
    const bodyMat = mat(look.body);
    const headMat = mat(look.head);
    const accentMat = mat(look.accent);

    const s = look.scale;
    const g = new THREE.Group();

    const torso = new THREE.Mesh(GEO.torso, bodyMat);
    torso.position.y = 1.05;
    g.add(torso);

    const head = new THREE.Mesh(GEO.head, headMat);
    head.position.y = 1.62;
    g.add(head);

    // Arms and legs live in pivot groups so they can rotate at the joint.
    // The mesh hangs below the pivot so rotation happens at the joint, not the
    // centre of the limb.
    const makeLimb = (
      geo: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      halfLength: number,
    ) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.y = -halfLength;
      pivot.add(mesh);
      g.add(pivot);
      return pivot;
    };

    this.rightArm = makeLimb(GEO.limb, bodyMat, -0.42, 1.32, 0.31);
    this.leftArm = makeLimb(GEO.limb, bodyMat, 0.42, 1.32, 0.31);
    this.leftLeg = makeLimb(GEO.leg, accentMat, 0.16, 0.72, 0.36);
    this.rightLeg = makeLimb(GEO.leg, accentMat, -0.16, 0.72, 0.36);

    // Weapon in the right hand, angled so the telegraph is readable.
    const weapon = new THREE.Mesh(GEO.weapon, accentMat);
    weapon.position.set(0, -0.62, 0.05);
    weapon.rotation.x = -0.25;
    this.rightArm.add(weapon);

    g.scale.setScalar(s);
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
    this.aggro = true;

    // Getting hit interrupts a wind-up, which rewards aggressive play.
    if (this.state === 'windup' && result.damage > this.maxHp * 0.08) {
      this.state = 'recover';
      this.stateTimer = 0.25;
    }

    const push = fromDirection.clone().setY(0).normalize().multiplyScalar(knockback);
    this.velocity.x += push.x;
    this.velocity.z += push.z;
    if (knockback > 5) this.velocity.y = Math.max(this.velocity.y, 2.6);

    const bloodColor = this.archetype.id === 'skeleton_knight' ? 0xdad6c8 : 0x8a1420;
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
    this.dyingTimer = 0.35;
    this.healthBar.visible = false;
  }

  // ---------------------------------------------------------------- AI

  /** Wakes the enemy — used by loud noises like gunfire and explosions. */
  alert(): void {
    this.aggro = true;
    if (this.state === 'idle') this.state = 'chase';
  }

  applySlow(seconds: number): void {
    this.slowTimer = Math.max(this.slowTimer, seconds);
  }

  /** Effective movement speed, after chilling effects. */
  private get currentSpeed(): number {
    return this.archetype.speed * (this.slowTimer > 0 ? 0.45 : 1);
  }

  update(dt: number, ctx: GameContext): void {
    if (this.slowTimer > 0) this.slowTimer -= dt;

    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const flash = this.hitFlash > 0;
      for (const m of this.materials) m.emissive.setScalar(flash ? 0.55 : 0);
    }

    if (this.state === 'dying') {
      this.dyingTimer -= dt;
      const t = Math.max(0, this.dyingTimer / 0.35);
      // Collapse the body, not the whole group — the group is the billboard anchor.
      this.body.scale.setScalar(this.archetype.look.scale * t);
      this.body.rotation.z = (1 - t) * 1.4;
      if (this.dyingTimer <= 0) this.removable = true;
      return;
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    const toPlayer = ctx.player.center.clone().sub(this.center);
    const distance = toPlayer.length();

    if (!this.aggro && distance < this.archetype.aggroRange && this.hasLineOfSight(ctx, distance)) {
      this.aggro = true;
      this.state = 'chase';
      if (this.archetype.hint) ctx.log(`${this.archetype.name}: ${this.archetype.hint}`, 'info');
    }

    // Always face the player once hostile — a monster that attacks sideways
    // reads as broken.
    if (this.aggro) this.yaw = Math.atan2(-toPlayer.x, -toPlayer.z);

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
        if (this.stateTimer <= 0) this.state = this.aggro ? 'chase' : 'idle';
        break;
      default:
        break;
    }

    this.integrate(dt, ctx);
    this.animate(dt);
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

    if (melee && distance <= melee.reach * 0.92 && this.attackCooldown <= 0) {
      this.beginAttack('melee', melee.windup);
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

  private doReposition(dt: number, ctx: GameContext, distance: number): void {
    this.stateTimer -= dt;
    const away = this.position.clone().sub(ctx.player.position).setY(0);
    if (away.lengthSq() < 0.001) away.set(1, 0, 0);
    this.steerTowards(this.position.clone().add(away.normalize().multiplyScalar(6)), this.currentSpeed * 0.9);

    const ranged = this.archetype.ranged;
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
    this.velocity.x *= 0.8;
    this.velocity.z *= 0.8;
    if (this.stateTimer > 0) return;

    if (this.pendingAttack === 'melee') {
      const melee = this.archetype.melee!;
      this.attackCooldown = melee.cooldown;
      this.state = 'recover';
      this.stateTimer = melee.recovery;

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
    if (ranged.gravity > 0) {
      const drop = (GRAVITY * ranged.gravity * flatDistance) / (2 * ranged.speed * ranged.speed);
      dir.y += drop * flatDistance;
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
    this.leftLeg.rotation.x = Math.sin(this.walkPhase) * stride;
    this.rightLeg.rotation.x = -Math.sin(this.walkPhase) * stride;
    this.leftArm.rotation.x = -Math.sin(this.walkPhase) * stride * 0.6;

    // The attacking arm rises through the wind-up and snaps down on release.
    if (this.state === 'windup') {
      const windup = this.pendingAttack === 'melee' ? this.archetype.melee!.windup : this.archetype.ranged!.windup;
      const progress = 1 - Math.max(0, this.stateTimer) / windup;
      this.rightArm.rotation.x = -progress * 2.3;
    } else if (this.state === 'recover') {
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, 0.7, dt * 14);
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
