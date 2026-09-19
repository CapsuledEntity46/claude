import { closestPointOnSegment, clamp01 } from '../core/math';
import { audio } from '../core/audio';
import { itemDef } from '../items/itemdefs';
import type { Actor, Faction } from './actor';
import type { Game } from '../game';

export interface BulletSpec {
  x: number;
  y: number;
  angle: number;
  speed: number;
  damage: number;
  range: number;
  faction: Faction;
  owner: Actor | null;
  critMul: number;
  bleed: number;
  /** Rockets and flares detonate on impact. */
  explode?: { radius: number; damage: number };
  /** Arrows and bolts can be picked back up. */
  recoverItem?: string;
  /** Visual tracer weight. */
  tracer?: number;
}

/**
 * A simulated projectile.
 *
 * Bullets travel over time rather than hitting instantly, so leading a running
 * target matters and you can watch tracers cross a field.
 */
export class Bullet {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  travelled = 0;
  readonly maxDist: number;
  readonly damage: number;
  readonly faction: Faction;
  readonly owner: Actor | null;
  readonly critMul: number;
  readonly bleed: number;
  readonly explode?: { radius: number; damage: number };
  readonly recoverItem?: string;
  readonly tracer: number;
  readonly angle: number;
  dead = false;

  constructor(spec: BulletSpec) {
    this.x = spec.x;
    this.y = spec.y;
    this.prevX = spec.x;
    this.prevY = spec.y;
    this.angle = spec.angle;
    this.vx = Math.cos(spec.angle) * spec.speed;
    this.vy = Math.sin(spec.angle) * spec.speed;
    this.maxDist = spec.range;
    this.damage = spec.damage;
    this.faction = spec.faction;
    this.owner = spec.owner;
    this.critMul = spec.critMul;
    this.bleed = spec.bleed;
    this.explode = spec.explode;
    this.recoverItem = spec.recoverItem;
    this.tracer = spec.tracer ?? 1;
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;
    this.prevX = this.x;
    this.prevY = this.y;

    const stepX = this.vx * dt;
    const stepY = this.vy * dt;
    const stepLen = Math.hypot(stepX, stepY);
    if (stepLen < 1e-6) { this.dead = true; return; }

    const dirX = stepX / stepLen;
    const dirY = stepY / stepLen;

    // --- static geometry ---
    const hit = game.world.castRay(this.x, this.y, dirX, dirY, stepLen);

    // --- actors along this step ---
    let closestActor: Actor | null = null;
    let closestT = Infinity;
    const endX = this.x + stepX;
    const endY = this.y + stepY;

    for (const a of game.actorsNear((this.x + endX) / 2, (this.y + endY) / 2, stepLen / 2 + 48)) {
      if (!a.alive) continue;
      if (a === this.owner) continue;
      if (a.faction === this.faction) continue;
      // Friendly fire between hostile factions is allowed, player bullets never hit the player.
      const p = closestPointOnSegment(a.x, a.y, this.x, this.y, endX, endY);
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d > a.radius) continue;
      const t = Math.hypot(p.x - this.x, p.y - this.y);
      if (t < closestT) { closestT = t; closestActor = a; }
    }

    const wallDist = hit ? hit.dist : Infinity;

    if (closestActor && closestT <= wallDist) {
      this.x += dirX * closestT;
      this.y += dirY * closestT;
      this.hitActor(closestActor, game);
      return;
    }

    if (hit) {
      this.x += dirX * hit.dist;
      this.y += dirY * hit.dist;
      this.hitWorld(game, hit);
      return;
    }

    this.x = endX;
    this.y = endY;
    this.travelled += stepLen;

    if (this.travelled >= this.maxDist || !game.world.inBounds(this.x, this.y)) {
      if (this.explode) this.detonate(game);
      else if (this.recoverItem) game.dropItemAt(this.x, this.y, this.recoverItem, 1);
      this.dead = true;
    }
  }

  private hitActor(a: Actor, game: Game): void {
    this.dead = true;

    // Falloff past the weapon's effective range.
    const falloff = 1 - clamp01((this.travelled / this.maxDist - 0.6) / 0.4) * 0.35;
    // Occasional crits stand in for headshots in a top-down view.
    const crit = Math.random() < 0.15;
    const dmg = this.damage * falloff * (crit ? this.critMul : 1);

    a.takeDamage({
      amount: dmg,
      type: 'bullet',
      angle: this.angle,
      knockback: 55,
      bleed: this.bleed,
      source: this.owner ?? undefined,
      crit,
    });

    game.effects.blood(this.x, this.y, this.angle, dmg);
    game.effects.damageNumber(this.x, this.y, Math.round(dmg), crit);
    audio.play('hit_flesh', this.x, this.y, { volume: 0.7 });

    if (this.owner === game.player) game.onPlayerHit(crit);
    if (this.explode) this.detonate(game);
  }

  private hitWorld(game: Game, hit: NonNullable<ReturnType<Game['world']['castRay']>>): void {
    this.dead = true;

    if (this.explode) { this.detonate(game); return; }

    if (hit.prop) {
      game.damageProp(hit.prop, this.damage * 0.5, 'bullet');
      audio.play(hit.prop.kind.startsWith('tree') ? 'hit_wood' : 'hit_stone', this.x, this.y, { volume: 0.6 });
    } else if (hit.structure) {
      game.damageStructure(hit.structure, this.damage * 0.35);
      audio.play('hit_wood', this.x, this.y, { volume: 0.6 });
    } else if (hit.wall) {
      audio.play(hit.wall.window ? 'glass' : 'hit_stone', this.x, this.y, { volume: 0.6 });
    }

    game.effects.impact(this.x, this.y, this.angle);
    // Arrows stick in whatever they hit and can be recovered.
    if (this.recoverItem && Math.random() < 0.55) game.dropItemAt(this.x, this.y, this.recoverItem, 1);
  }

  private detonate(game: Game): void {
    if (!this.explode) return;
    game.explode(this.x, this.y, this.explode.radius, this.explode.damage, this.owner);
  }
}

// ===========================================================================
// Thrown items
// ===========================================================================

export type ThrownKind = 'frag' | 'fire' | 'smoke' | 'flash' | 'spear' | 'charge';

/**
 * A thrown object arcing through the air.
 *
 * `z` is a purely visual height so grenades sail over low cover; collisions only
 * apply once it lands (spears are the exception — they hit on contact).
 */
export class Thrown {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual height above the ground. */
  z = 14;
  vz: number;
  spin = 0;
  fuse: number;
  landed = false;
  dead = false;
  bounces = 0;

  constructor(
    public itemId: string,
    x: number, y: number, angle: number, speed: number,
    public kind: ThrownKind,
    public damage: number,
    public radius: number,
    fuse: number,
    public owner: Actor | null,
    public faction: Faction,
    public burn = 0,
  ) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.vz = kind === 'spear' ? 0 : 150;
    this.fuse = fuse;
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;
    this.spin += dt * 12;

    // Spears fly flat and hit the first thing they touch.
    if (this.kind === 'spear') {
      this.updateSpear(dt, game);
      return;
    }

    if (!this.landed) {
      const stepX = this.vx * dt, stepY = this.vy * dt;
      const len = Math.hypot(stepX, stepY);
      if (len > 0.001 && this.z < 26) {
        // Low enough to clip walls.
        const hit = game.world.castRay(this.x, this.y, stepX / len, stepY / len, len);
        if (hit) {
          this.vx *= -0.35;
          this.vy *= -0.35;
          audio.play('hit_wood', this.x, this.y, { volume: 0.4 });
        }
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.z += this.vz * dt;
      this.vz -= 420 * dt;
      this.vx *= 1 - dt * 1.1;
      this.vy *= 1 - dt * 1.1;

      if (this.z <= 0) {
        this.z = 0;
        if (Math.abs(this.vz) > 60 && this.bounces < 2) {
          this.vz = -this.vz * 0.35;
          this.bounces++;
          this.vx *= 0.5;
          this.vy *= 0.5;
        } else {
          this.landed = true;
          this.vx = this.vy = this.vz = 0;
          if (this.kind === 'fire') { this.trigger(game); return; }
        }
      }
    }

    this.fuse -= dt;
    if (this.fuse <= 0) this.trigger(game);
  }

  private updateSpear(dt: number, game: Game): void {
    const stepX = this.vx * dt, stepY = this.vy * dt;
    const len = Math.hypot(stepX, stepY);
    if (len < 0.001) { this.land(game); return; }
    const dirX = stepX / len, dirY = stepY / len;

    // Actors first.
    for (const a of game.actorsNear(this.x, this.y, len + 40)) {
      if (!a.alive || a === this.owner || a.faction === this.faction) continue;
      const p = closestPointOnSegment(a.x, a.y, this.x, this.y, this.x + stepX, this.y + stepY);
      if (Math.hypot(a.x - p.x, a.y - p.y) > a.radius) continue;
      const angle = Math.atan2(this.vy, this.vx);
      a.takeDamage({ amount: this.damage, type: 'melee', angle, knockback: 140, bleed: 4, source: this.owner ?? undefined });
      game.effects.blood(a.x, a.y, angle, this.damage);
      game.effects.damageNumber(a.x, a.y, Math.round(this.damage), false);
      audio.play('hit_flesh', a.x, a.y, { volume: 0.9 });
      this.dead = true;
      // The spear falls at their feet.
      game.dropItemAt(a.x, a.y, this.itemId, 1);
      return;
    }

    const hit = game.world.castRay(this.x, this.y, dirX, dirY, len);
    if (hit) {
      this.x += dirX * hit.dist;
      this.y += dirY * hit.dist;
      if (hit.prop) game.damageProp(hit.prop, this.damage * 0.4, 'melee');
      this.land(game);
      return;
    }

    this.x += stepX;
    this.y += stepY;
    this.vx *= 1 - dt * 0.7;
    this.vy *= 1 - dt * 0.7;
    if (Math.hypot(this.vx, this.vy) < 80 || !game.world.inBounds(this.x, this.y)) this.land(game);
  }

  private land(game: Game): void {
    this.dead = true;
    audio.play('hit_wood', this.x, this.y, { volume: 0.5 });
    game.dropItemAt(this.x, this.y, this.itemId, 1);
  }

  private trigger(game: Game): void {
    this.dead = true;
    switch (this.kind) {
      case 'frag':
      case 'charge':
        game.explode(this.x, this.y, this.radius, this.damage, this.owner);
        break;
      case 'fire':
        audio.play('explosion', this.x, this.y, { volume: 0.5, pitch: 1.4 });
        game.addAreaEffect(new AreaEffect(this.x, this.y, this.radius, this.burn, 'fire', this.damage, this.owner));
        game.effects.fireBurst(this.x, this.y, this.radius);
        break;
      case 'smoke':
        game.addAreaEffect(new AreaEffect(this.x, this.y, this.radius, this.burn, 'smoke', 0, this.owner));
        break;
      case 'flash': {
        game.effects.flashbang(this.x, this.y, this.radius);
        audio.play('explosion', this.x, this.y, { volume: 0.7, pitch: 2 });
        for (const a of game.actorsNear(this.x, this.y, this.radius)) {
          if (!a.alive) continue;
          const d = Math.hypot(a.x - this.x, a.y - this.y);
          const strength = 1 - clamp01(d / this.radius);
          if (!game.world.hasLineOfSight(this.x, this.y, a.x, a.y)) continue;
          a.stun = Math.max(a.stun, 1.2 + strength * 3.2);
          a.takeDamage({ amount: this.damage * strength, type: 'explosion' });
        }
        game.blindPlayer(this.x, this.y, this.radius);
        break;
      }
      default:
        break;
    }
  }
}

// ===========================================================================
// Lingering area effects
// ===========================================================================

export type AreaKind = 'fire' | 'smoke';

/** Fire pools and smoke screens created by molotovs and smoke grenades. */
export class AreaEffect {
  life: number;
  readonly maxLife: number;
  dead = false;
  private tickTimer = 0;

  constructor(
    public x: number,
    public y: number,
    public radius: number,
    life: number,
    public kind: AreaKind,
    public damage: number,
    public owner: Actor | null,
  ) {
    this.life = life;
    this.maxLife = life;
  }

  get intensity(): number {
    // Fades in quickly, out slowly.
    const t = this.life / this.maxLife;
    return clamp01(Math.min(1, (1 - t) * 8)) * clamp01(t * 3);
  }

  update(dt: number, game: Game): void {
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    if (this.kind !== 'fire') return;

    // Fire ticks damage twice a second.
    this.tickTimer -= dt;
    if (this.tickTimer > 0) return;
    this.tickTimer = 0.5;

    for (const a of game.actorsNear(this.x, this.y, this.radius)) {
      if (!a.alive) continue;
      const d = Math.hypot(a.x - this.x, a.y - this.y);
      if (d > this.radius) continue;
      a.takeDamage({ amount: this.damage * 0.5, type: 'fire', source: this.owner ?? undefined });
      a.burning = Math.max(a.burning, 1.6);
    }
  }
}

// ===========================================================================
// Ground loot
// ===========================================================================

/** An item lying on the ground, waiting to be picked up. */
export class GroundItem {
  /** Seconds before it despawns; -1 means never. */
  life: number;
  readonly bobSeed = Math.random() * 100;
  dead = false;

  constructor(
    public x: number,
    public y: number,
    public itemId: string,
    public count: number,
    life = 420,
  ) {
    this.life = life;
  }

  get name(): string { return itemDef(this.itemId).name; }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
}
