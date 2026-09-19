import { angleTowards, clamp } from '../core/math';
import { RNG } from '../core/rng';
import { audio } from '../core/audio';
import { itemDef } from '../items/itemdefs';
import type { LootTableName } from '../items/lootTables';
import { Actor, type DamageInfo, type Faction } from './actor';
import type { Game } from '../game';

export type BanditKind = 'scavenger' | 'raider' | 'heavy' | 'marksman';

interface BanditStats {
  name: string;
  hp: number;
  speed: number;
  /** Damage reduction, like worn armour. */
  armor: number;
  /** Weapon item id, or null for melee-only. */
  weapon: string | null;
  melee: string;
  /** Extra spread in degrees added to the weapon's own. */
  inaccuracy: number;
  /** Preferred engagement distance. */
  standoff: number;
  sight: number;
  /** Seconds between bursts. */
  burstGap: number;
  burst: [number, number];
  /** Reaction delay before the first shot. */
  reaction: number;
  loot: LootTableName;
  weight: number;
  minDay: number;
  color: string;
  size: number;
}

export const BANDIT_STATS: Record<BanditKind, BanditStats> = {
  scavenger: {
    name: 'Scavenger', hp: 70, speed: 148, armor: 0.03, weapon: 'revolver', melee: 'machete',
    inaccuracy: 3.4, standoff: 240, sight: 560, burstGap: 1.5, burst: [1, 2], reaction: 0.55,
    loot: 'bandit', weight: 46, minDay: 1, color: '#7a6a52', size: 1,
  },
  raider: {
    name: 'Raider', hp: 96, speed: 160, armor: 0.12, weapon: 'shotgun_pump', melee: 'nail_bat',
    inaccuracy: 4.5, standoff: 170, sight: 600, burstGap: 1.1, burst: [1, 2], reaction: 0.45,
    loot: 'bandit', weight: 30, minDay: 2, color: '#6a4a3a', size: 1.04,
  },
  heavy: {
    name: 'Heavy', hp: 165, speed: 132, armor: 0.3, weapon: 'ak47', melee: 'sledgehammer',
    inaccuracy: 3, standoff: 330, sight: 680, burstGap: 1.3, burst: [3, 6], reaction: 0.6,
    loot: 'bandit_heavy', weight: 16, minDay: 4, color: '#4a5240', size: 1.12,
  },
  marksman: {
    name: 'Marksman', hp: 84, speed: 142, armor: 0.08, weapon: 'hunting_rifle', melee: 'combat_knife',
    inaccuracy: 0.9, standoff: 620, sight: 900, burstGap: 2.4, burst: [1, 1], reaction: 0.9,
    loot: 'bandit', weight: 10, minDay: 5, color: '#4a4a38', size: 0.98,
  },
};

type State = 'patrol' | 'alert' | 'engage' | 'reposition' | 'melee' | 'flee';

export class Bandit extends Actor {
  readonly faction: Faction = 'bandit';
  readonly kind: BanditKind;
  readonly stats: BanditStats;

  state: State = 'patrol';
  target: Actor | null = null;
  private rng: RNG;
  private stateTimer = 0;
  private fireTimer = 0;
  private burstLeft = 0;
  private reactionTimer = 0;
  private goalX: number;
  private goalY: number;
  /** Home position; patrols orbit this. */
  private homeX: number;
  private homeY: number;
  private strafeDir = 1;
  /** Ammo remaining before they're forced to melee. */
  ammo: number;
  /** Render hint: muzzle flash countdown. */
  muzzleFlash = 0;
  /** Render hint: melee swing animation 0..1. */
  swingAnim = 0;

  constructor(x: number, y: number, kind: BanditKind, seed = Math.random() * 1e9) {
    const stats = BANDIT_STATS[kind];
    super(x, y, stats.hp);
    this.kind = kind;
    this.stats = stats;
    this.radius = 13;
    this.speed = stats.speed;
    this.rng = new RNG(Math.floor(seed));
    this.facing = this.rng.angle();
    this.homeX = x;
    this.homeY = y;
    this.goalX = x;
    this.goalY = y;
    this.ammo = this.rng.int(18, 60);
  }

  override takeDamage(info: DamageInfo): number {
    let amount = info.amount;
    if (info.type === 'bullet' || info.type === 'melee' || info.type === 'claw') {
      amount *= 1 - this.stats.armor;
    }
    // Getting shot at from out of nowhere makes them hunt the shooter.
    if (info.source && info.source.alive && this.state === 'patrol') {
      this.target = info.source;
      this.state = 'alert';
      this.goalX = info.source.x;
      this.goalY = info.source.y;
      this.reactionTimer = this.stats.reaction * 0.5;
    }
    return super.takeDamage({ ...info, amount });
  }

  private canSee(game: Game, other: Actor): boolean {
    const stealth = other === game.player ? game.player.stealth : 1;
    // Night blinds them somewhat, unlike zombies.
    const nightPenalty = 1 - game.dayNight.darkness * 0.45;
    const range = this.stats.sight * stealth * nightPenalty;
    if (this.dist2To(other.x, other.y) > range * range) return false;
    return game.world.hasLineOfSight(this.x, this.y, other.x, other.y);
  }

  private acquire(game: Game): Actor | null {
    let best: Actor | null = null;
    let bestD2 = Infinity;
    if (game.player.alive && this.canSee(game, game.player)) {
      best = game.player;
      bestD2 = this.dist2To(game.player.x, game.player.y);
    }
    // Bandits also shoot zombies — they want to survive too.
    for (const z of game.zombies) {
      if (!z.alive) continue;
      const d2 = this.dist2To(z.x, z.y);
      if (d2 >= bestD2 || d2 > 420 * 420) continue;
      if (this.canSee(game, z)) { best = z; bestD2 = d2; }
    }
    return best;
  }

  private moveToward(game: Game, tx: number, ty: number, scale = 1): void {
    const desired = Math.atan2(ty - this.y, tx - this.x);
    const probe = 52;
    let bestAngle = desired;
    let bestScore = -Infinity;
    for (const off of [0, 0.45, -0.45, 0.95, -0.95, 1.6, -1.6]) {
      const a = desired + off;
      const hit = game.world.castRay(this.x, this.y, Math.cos(a), Math.sin(a), probe);
      const clearance = hit ? hit.dist : probe;
      const score = clearance - Math.abs(off) * 12;
      if (score > bestScore) { bestScore = score; bestAngle = a; }
      if (off === 0 && clearance >= probe) break;
    }
    this.moveX = Math.cos(bestAngle) * scale;
    this.moveY = Math.sin(bestAngle) * scale;
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;

    this.stateTimer -= dt;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 6);
    this.swingAnim = Math.max(0, this.swingAnim - dt * 3);

    if (this.stun > 0) {
      this.moveX = this.moveY = 0;
      this.integrate(dt, game.world);
      return;
    }

    // --- retarget ---
    if (!this.target || !this.target.alive || this.stateTimer <= 0) {
      const t = this.acquire(game);
      if (t) {
        if (!this.target) this.reactionTimer = this.stats.reaction;
        this.target = t;
        if (this.state === 'patrol') this.state = 'alert';
        this.stateTimer = 2.5;
      } else if (this.target && !this.canSee(game, this.target)) {
        this.target = null;
        this.state = 'patrol';
      }
    }

    // --- flee when badly hurt ---
    if (this.healthFrac < 0.22 && this.state !== 'flee' && this.rng.bool(0.6)) {
      this.state = 'flee';
      this.stateTimer = this.rng.float(3, 6);
    }

    const t = this.target;
    const weapon = this.ammo > 0 && this.stats.weapon ? itemDef(this.stats.weapon) : null;

    switch (this.state) {
      case 'patrol': {
        if (this.stateTimer <= 0 || this.distTo(this.goalX, this.goalY) < 40) {
          const a = this.rng.angle();
          const d = this.rng.float(120, 420);
          this.goalX = this.homeX + Math.cos(a) * d;
          this.goalY = this.homeY + Math.sin(a) * d;
          this.stateTimer = this.rng.float(4, 9);
        }
        this.moveToward(game, this.goalX, this.goalY, 0.55);
        this.facing = angleTowards(this.facing, Math.atan2(this.moveY, this.moveX), dt * 5);
        break;
      }

      case 'alert': {
        if (!t) { this.state = 'patrol'; break; }
        this.facing = angleTowards(this.facing, this.angleTo(t.x, t.y), dt * 7);
        this.moveX = this.moveY = 0;
        if (this.reactionTimer <= 0) this.state = 'engage';
        break;
      }

      case 'engage': {
        if (!t) { this.state = 'patrol'; break; }
        const dist = this.distTo(t.x, t.y);
        this.facing = angleTowards(this.facing, this.angleTo(t.x, t.y), dt * 8);

        if (!weapon) { this.state = 'melee'; break; }

        // Hold the preferred range, strafing so they're not static targets.
        const band = this.stats.standoff;
        if (dist > band * 1.25) this.moveToward(game, t.x, t.y, 1);
        else if (dist < band * 0.7) this.moveToward(game, this.x * 2 - t.x, this.y * 2 - t.y, 0.9);
        else {
          const perp = this.angleTo(t.x, t.y) + Math.PI / 2 * this.strafeDir;
          this.moveToward(game, this.x + Math.cos(perp) * 100, this.y + Math.sin(perp) * 100, 0.62);
          if (this.rng.bool(dt * 0.6)) this.strafeDir *= -1;
        }

        if (this.fireTimer <= 0 && game.world.hasLineOfSight(this.x, this.y, t.x, t.y)) {
          if (this.burstLeft <= 0) this.burstLeft = this.rng.int(this.stats.burst[0], this.stats.burst[1]);
          this.shoot(game, t);
          this.burstLeft--;
          const r = weapon.ranged!;
          this.fireTimer = this.burstLeft > 0 ? 60 / r.rpm : this.stats.burstGap + this.rng.float(0, 0.5);
        }
        break;
      }

      case 'melee': {
        if (!t) { this.state = 'patrol'; break; }
        const dist = this.distTo(t.x, t.y);
        const m = itemDef(this.stats.melee).melee!;
        this.facing = angleTowards(this.facing, this.angleTo(t.x, t.y), dt * 9);
        if (dist > m.range + t.radius) {
          this.moveToward(game, t.x, t.y, 1);
        } else {
          this.moveX = this.moveY = 0;
          if (this.fireTimer <= 0) {
            this.swingAnim = 1;
            this.fireTimer = m.speed + 0.25;
            audio.play('swing', this.x, this.y, { volume: 0.7 });
            t.takeDamage({
              amount: m.damage * 0.8,
              type: 'melee',
              angle: this.angleTo(t.x, t.y),
              knockback: m.knockback,
              bleed: m.bleed ? 3 : 0,
              source: this,
            });
            game.effects.blood(t.x, t.y, this.angleTo(t.x, t.y), m.damage);
            audio.play('hit_flesh', t.x, t.y, { volume: 0.8 });
            if (t === game.player) game.onPlayerHurt(m.damage * 0.8, this.angleTo(t.x, t.y));
          }
        }
        if (weapon && dist > 260) this.state = 'engage';
        break;
      }

      case 'flee': {
        const away = t ? this.angleTo(t.x, t.y) + Math.PI : this.facing;
        this.moveToward(game, this.x + Math.cos(away) * 200, this.y + Math.sin(away) * 200, 1);
        this.facing = angleTowards(this.facing, away, dt * 5);
        if (this.stateTimer <= 0) this.state = this.healthFrac > 0.4 ? 'engage' : 'patrol';
        break;
      }

      default:
        this.moveX = this.moveY = 0;
    }

    this.integrate(dt, game.world);
  }

  private shoot(game: Game, target: Actor): void {
    const weaponId = this.stats.weapon;
    if (!weaponId) return;
    const def = itemDef(weaponId);
    const r = def.ranged;
    if (!r) return;

    this.ammo--;
    if (this.ammo <= 0) this.state = 'melee';

    // Lead the target a little so moving players still get hit sometimes.
    const dist = this.distTo(target.x, target.y);
    const travel = dist / r.velocity;
    const leadX = target.x + target.moveX * target.speed * travel * 0.6;
    const leadY = target.y + target.moveY * target.speed * travel * 0.6;
    const base = Math.atan2(leadY - this.y, leadX - this.x);

    const spreadDeg = r.spread + this.stats.inaccuracy;
    const pellets = r.pellets ?? 1;
    for (let i = 0; i < pellets; i++) {
      const a = base + this.rng.gauss() * (spreadDeg * Math.PI / 180) * 0.5;
      game.spawnBullet({
        x: this.x + Math.cos(this.facing) * 16,
        y: this.y + Math.sin(this.facing) * 16,
        angle: a,
        speed: r.velocity,
        damage: r.damage * 0.85,
        range: r.range,
        faction: 'bandit',
        owner: this,
        critMul: r.critMul,
        bleed: 0,
      });
    }

    this.muzzleFlash = 1;
    audio.play(r.sound, this.x, this.y, { volume: 0.9 });
    game.effects.muzzle(this.x + Math.cos(this.facing) * 18, this.y + Math.sin(this.facing) * 18, this.facing, r.flash);
    game.alertZombies(this.x, this.y, r.noise * 0.8, 0.8);
  }

  protected override onDeath(info: DamageInfo): void {
    audio.play('hurt', this.x, this.y, { pitch: 0.7, volume: 1 });
    void info;
  }
}

export function rollBanditKind(rng: RNG, day: number): BanditKind {
  const pool = (Object.keys(BANDIT_STATS) as BanditKind[]).filter((k) => BANDIT_STATS[k].minDay <= day);
  return rng.weighted(pool, (k) => {
    const s = BANDIT_STATS[k];
    const ramp = s.minDay > 1 ? 1 + (day - s.minDay) * 0.14 : 1;
    return s.weight * ramp;
  });
}

/** Clamped health bar fraction for the renderer. */
export const banditHealthBar = (b: Bandit): number => clamp(b.healthFrac, 0, 1);
