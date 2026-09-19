import { clamp, damp, TAU, type Vec2 } from '../core/math';
import type { World } from '../world/world';
import { TILES } from '../world/tiles';

export type DamageType = 'bullet' | 'melee' | 'explosion' | 'fire' | 'bleed' | 'cold' | 'fall' | 'claw' | 'trap' | 'drown';

export type Faction = 'player' | 'zombie' | 'bandit' | 'animal' | 'neutral';

let nextActorId = 1;

export interface DamageInfo {
  amount: number;
  type: DamageType;
  /** Direction the hit came from, for knockback and blood spray. */
  angle?: number;
  knockback?: number;
  bleed?: number;
  source?: Actor;
  /** True when this was a critical/weak-point hit. */
  crit?: boolean;
}

/**
 * Shared base for everything that walks around and can be hurt.
 *
 * Movement is intent-based: subclasses write `moveX`/`moveY` (a normalised
 * desired direction) and `speed`, and `integrate()` handles terrain modifiers,
 * knockback impulses, water and collision.
 */
export abstract class Actor {
  readonly id = nextActorId++;
  abstract readonly faction: Faction;

  x: number;
  y: number;
  /** Desired movement direction this tick, roughly unit length. */
  moveX = 0;
  moveY = 0;
  /** Base movement speed in world units/second. */
  speed = 160;
  radius = 14;
  facing = 0;

  hp: number;
  maxHp: number;
  dead = false;
  /** Set on the tick of death so the render layer can play an effect once. */
  justDied = false;

  /** Knockback / explosion impulse, decays exponentially. */
  impulseX = 0;
  impulseY = 0;

  /** Bleed stacks: each drains health then decays. */
  bleed = 0;
  /** Seconds of stun remaining (flashbangs, heavy hits). */
  stun = 0;
  /** Seconds of burning remaining. */
  burning = 0;

  /** Counts up while damaged, for the hit-flash overlay. */
  flash = 0;
  /** Distance walked, used to time footsteps. */
  private stepAccum = 0;
  /** True when the actor is standing in water deep enough to slow them. */
  inWater = false;
  /** Animation phase for the walk cycle. */
  animPhase = 0;

  constructor(x: number, y: number, hp: number) {
    this.x = x;
    this.y = y;
    this.hp = hp;
    this.maxHp = hp;
  }

  get alive(): boolean { return !this.dead; }
  get healthFrac(): number { return clamp(this.hp / this.maxHp, 0, 1); }

  /** Apply a knockback impulse in world units/second. */
  push(angle: number, force: number): void {
    this.impulseX += Math.cos(angle) * force;
    this.impulseY += Math.sin(angle) * force;
  }

  /**
   * Apply damage. Subclasses override to add armour, then call super.
   * Returns the damage actually dealt.
   */
  takeDamage(info: DamageInfo): number {
    if (this.dead || info.amount <= 0) return 0;
    const dealt = Math.min(this.hp, info.amount);
    this.hp -= dealt;
    this.flash = 0.22;

    if (info.bleed) this.bleed += info.bleed;
    if (info.knockback && info.angle !== undefined) this.push(info.angle, info.knockback);
    if (info.type === 'fire') this.burning = Math.max(this.burning, 2.5);

    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.justDied = true;
      this.onDeath(info);
    }
    return dealt;
  }

  heal(amount: number): void {
    if (this.dead) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  protected onDeath(_info: DamageInfo): void { /* subclasses hook in */ }

  /** Terrain and status multipliers on movement speed. */
  protected speedMultiplier(world: World): number {
    let mul = TILES[world.tileAt(this.x, this.y)].speed;
    if (this.stun > 0) mul *= 0.25;
    if (this.burning > 0) mul *= 1.08; // panic sprint
    return mul;
  }

  /**
   * Advance position: intent + impulse, terrain speed, then collision.
   * Returns true when a footstep should be emitted this tick.
   */
  integrate(dt: number, world: World): boolean {
    // Status timers.
    this.flash = Math.max(0, this.flash - dt);
    this.stun = Math.max(0, this.stun - dt);

    if (this.bleed > 0) {
      const tick = Math.min(this.bleed, dt * 2.2);
      this.bleed = Math.max(0, this.bleed - dt * 0.55);
      this.takeDamage({ amount: tick, type: 'bleed' });
    }
    if (this.burning > 0) {
      this.burning = Math.max(0, this.burning - dt);
      this.takeDamage({ amount: dt * 7, type: 'fire' });
    }
    if (this.dead) return false;

    const tile = TILES[world.tileAt(this.x, this.y)];
    this.inWater = tile.water;

    const mul = this.speedMultiplier(world);
    let vx = this.moveX * this.speed * mul;
    let vy = this.moveY * this.speed * mul;

    // Impulses decay fast so knockback feels punchy rather than floaty.
    vx += this.impulseX;
    vy += this.impulseY;
    this.impulseX = damp(this.impulseX, 0, 9, dt);
    this.impulseY = damp(this.impulseY, 0, 9, dt);
    if (Math.abs(this.impulseX) < 1) this.impulseX = 0;
    if (Math.abs(this.impulseY) < 1) this.impulseY = 0;

    const pos: Vec2 = { x: this.x + vx * dt, y: this.y + vy * dt };
    world.resolveCollision(pos, this.radius);
    const travelled = Math.hypot(pos.x - this.x, pos.y - this.y);
    this.x = pos.x;
    this.y = pos.y;

    // Walk-cycle animation and footstep cadence.
    const moving = travelled > dt * 12;
    this.animPhase = moving ? (this.animPhase + travelled * 0.055) % TAU : damp(this.animPhase % TAU, 0, 8, dt);

    if (moving) {
      this.stepAccum += travelled;
      const stride = 46 + this.radius;
      if (this.stepAccum >= stride) {
        this.stepAccum -= stride;
        return true;
      }
    } else {
      this.stepAccum = 0;
    }
    return false;
  }

  /** Squared distance to another actor or point. */
  dist2To(x: number, y: number): number {
    const dx = x - this.x, dy = y - this.y;
    return dx * dx + dy * dy;
  }

  distTo(x: number, y: number): number { return Math.sqrt(this.dist2To(x, y)); }

  angleTo(x: number, y: number): number { return Math.atan2(y - this.y, x - this.x); }
}
