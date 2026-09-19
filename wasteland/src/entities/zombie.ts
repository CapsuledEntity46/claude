import { angleTowards, clamp, TAU, wrapAngle } from '../core/math';
import { RNG } from '../core/rng';
import { audio } from '../core/audio';
import type { LootTableName } from '../items/lootTables';
import { Actor, type DamageInfo, type Faction } from './actor';
import type { Game } from '../game';

export type ZombieType = 'walker' | 'runner' | 'brute' | 'screamer' | 'bloater' | 'crawler';

interface ZombieStats {
  name: string;
  hp: number;
  speed: number;
  damage: number;
  /** Reach beyond the collision radii. */
  reach: number;
  /** Seconds between attacks. */
  attackCd: number;
  /** Telegraph before the hit lands. */
  windup: number;
  sight: number;
  hearing: number;
  radius: number;
  /** Visual scale. */
  size: number;
  /** Fraction of armour ignored. */
  pen: number;
  bleedChance: number;
  /** Multiplier on incoming knockback. */
  knockback: number;
  loot: LootTableName;
  /** Relative spawn weight, and the day it starts appearing. */
  weight: number;
  minDay: number;
  color: string;
}

export const ZOMBIE_STATS: Record<ZombieType, ZombieStats> = {
  walker: {
    name: 'Walker', hp: 62, speed: 74, damage: 11, reach: 12, attackCd: 1.15, windup: 0.42,
    sight: 420, hearing: 520, radius: 13, size: 1, pen: 0, bleedChance: 0.16, knockback: 1,
    loot: 'zombie', weight: 54, minDay: 1, color: '#6d7a58',
  },
  runner: {
    name: 'Runner', hp: 42, speed: 168, damage: 9, reach: 10, attackCd: 0.8, windup: 0.26,
    sight: 520, hearing: 620, radius: 12, size: 0.92, pen: 0.1, bleedChance: 0.24, knockback: 1.35,
    loot: 'zombie', weight: 22, minDay: 1, color: '#7d6a4a',
  },
  crawler: {
    name: 'Crawler', hp: 34, speed: 58, damage: 14, reach: 8, attackCd: 1, windup: 0.32,
    sight: 300, hearing: 420, radius: 11, size: 0.78, pen: 0.25, bleedChance: 0.4, knockback: 0.7,
    loot: 'zombie', weight: 14, minDay: 2, color: '#5f6b4e',
  },
  screamer: {
    name: 'Screamer', hp: 55, speed: 96, damage: 8, reach: 12, attackCd: 1.3, windup: 0.4,
    sight: 560, hearing: 720, radius: 13, size: 1.02, pen: 0, bleedChance: 0.12, knockback: 1.1,
    loot: 'zombie', weight: 9, minDay: 3, color: '#8a6a7a',
  },
  bloater: {
    name: 'Bloater', hp: 95, speed: 56, damage: 15, reach: 14, attackCd: 1.5, windup: 0.55,
    sight: 360, hearing: 460, radius: 17, size: 1.22, pen: 0.15, bleedChance: 0.2, knockback: 0.55,
    loot: 'zombie', weight: 8, minDay: 4, color: '#7a8452',
  },
  brute: {
    name: 'Brute', hp: 260, speed: 84, damage: 32, reach: 18, attackCd: 1.7, windup: 0.62,
    sight: 440, hearing: 520, radius: 21, size: 1.55, pen: 0.35, bleedChance: 0.1, knockback: 0.22,
    loot: 'zombie_brute', weight: 5, minDay: 5, color: '#6a5a44',
  },
};

type State = 'idle' | 'wander' | 'investigate' | 'chase' | 'attack' | 'stagger';

export class Zombie extends Actor {
  readonly faction: Faction = 'zombie';
  readonly type: ZombieType;
  readonly stats: ZombieStats;

  state: State = 'idle';
  target: Actor | null = null;
  /** Last known/suspected target position. */
  private goalX = 0;
  private goalY = 0;
  private stateTimer = 0;
  private attackCooldown = 0;
  /** Counts down during a telegraphed swing; the hit lands at zero. */
  private windup = 0;
  private windupTargetX = 0;
  private windupTargetY = 0;
  private groanTimer: number;
  private rng: RNG;
  /** Set for the render layer: 0..1 attack animation. */
  attackAnim = 0;
  /** Scales with night/day for difficulty. */
  aggression = 1;

  constructor(x: number, y: number, type: ZombieType, seed = Math.random() * 1e9) {
    const stats = ZOMBIE_STATS[type];
    super(x, y, stats.hp);
    this.type = type;
    this.stats = stats;
    this.radius = stats.radius;
    this.speed = stats.speed;
    this.rng = new RNG(Math.floor(seed));
    this.facing = this.rng.angle();
    this.groanTimer = this.rng.float(2, 12);
    this.goalX = x;
    this.goalY = y;
  }

  /** Something made a noise nearby — go look. */
  alert(x: number, y: number, intensity = 1): void {
    if (this.dead) return;
    this.goalX = x + this.rng.float(-40, 40) * (2 - intensity);
    this.goalY = y + this.rng.float(-40, 40) * (2 - intensity);
    if (this.state !== 'chase' && this.state !== 'attack') {
      this.state = 'investigate';
      this.stateTimer = this.rng.float(6, 12);
    }
  }

  private canSee(game: Game, other: Actor, stealth: number): boolean {
    const range = this.stats.sight * this.aggression * stealth;
    const d2 = this.dist2To(other.x, other.y);
    if (d2 > range * range) return false;
    // Crouching in cover matters: line of sight is checked against walls and props.
    return game.world.hasLineOfSight(this.x, this.y, other.x, other.y);
  }

  private pickTarget(game: Game): Actor | null {
    let best: Actor | null = null;
    let bestD2 = Infinity;

    const player = game.player;
    if (player.alive && this.canSee(game, player, player.stealth)) {
      best = player;
      bestD2 = this.dist2To(player.x, player.y);
    }
    // Zombies happily maul bandits too, which makes towns feel alive.
    for (const b of game.bandits) {
      if (!b.alive) continue;
      const d2 = this.dist2To(b.x, b.y);
      if (d2 >= bestD2) continue;
      if (this.canSee(game, b, 1)) { best = b; bestD2 = d2; }
    }
    for (const a of game.animals) {
      if (!a.alive) continue;
      const d2 = this.dist2To(a.x, a.y);
      if (d2 >= bestD2 || d2 > 240 * 240) continue;
      if (this.canSee(game, a, 1)) { best = a; bestD2 = d2; }
    }
    return best;
  }

  /**
   * Steer toward a goal, sliding along obstacles instead of grinding into them.
   * Three whiskers are probed and the least obstructed one wins.
   */
  private steerTo(game: Game, tx: number, ty: number): void {
    const desired = Math.atan2(ty - this.y, tx - this.x);
    const probe = 46 + this.radius;
    let bestAngle = desired;
    let bestScore = -Infinity;

    for (const offset of [0, 0.5, -0.5, 1.05, -1.05, 1.7, -1.7]) {
      const a = desired + offset;
      const hit = game.world.castRay(this.x, this.y, Math.cos(a), Math.sin(a), probe);
      const clearance = hit ? hit.dist : probe;
      // Prefer clear paths that point roughly where we want to go.
      const score = clearance - Math.abs(offset) * 14;
      if (score > bestScore) { bestScore = score; bestAngle = a; }
      if (offset === 0 && clearance >= probe) break; // straight line is clear
    }

    this.facing = angleTowards(this.facing, bestAngle, 7 * (1 / 60) * 60 * 0.12);
    this.moveX = Math.cos(bestAngle);
    this.moveY = Math.sin(bestAngle);
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;

    this.aggression = game.dayNight.zombieAggression;
    this.speed = this.stats.speed * (0.85 + this.aggression * 0.2);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.attackAnim = Math.max(0, this.attackAnim - dt * 3);
    this.stateTimer -= dt;

    // Ambient groaning, which in turn is a cue to the player.
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = this.rng.float(5, 16);
      audio.play('zombie_growl', this.x, this.y, { pitch: 0.8 + this.stats.size * 0.2, volume: 0.6 });
    }

    if (this.stun > 0) {
      this.moveX = 0;
      this.moveY = 0;
      this.integrate(dt, game.world);
      return;
    }

    // --- resolve the windup of a telegraphed swing ---
    if (this.windup > 0) {
      this.windup -= dt;
      this.moveX = 0;
      this.moveY = 0;
      if (this.windup <= 0) this.landAttack(game);
      this.integrate(dt, game.world);
      return;
    }

    // --- target acquisition ---
    const reacquire = this.state !== 'chase' || !this.target || !this.target.alive;
    if (reacquire) {
      const t = this.pickTarget(game);
      if (t) {
        if (!this.target && this.type === 'screamer') {
          // Screamers pull the whole neighbourhood in.
          audio.play('zombie_alert', this.x, this.y, { volume: 1.1 });
          game.alertZombies(this.x, this.y, 900, 1);
        }
        this.target = t;
        this.state = 'chase';
      } else if (this.target && !this.target.alive) {
        this.target = null;
        this.state = 'wander';
        this.stateTimer = this.rng.float(2, 6);
      }
    }

    if (this.target && this.target.alive) {
      const dist = this.distTo(this.target.x, this.target.y);
      const stillVisible = this.canSee(game, this.target, this.target === game.player ? game.player.stealth : 1);
      if (stillVisible) {
        this.goalX = this.target.x;
        this.goalY = this.target.y;
        this.stateTimer = 5;
      } else if (this.stateTimer <= 0) {
        // Lost them — search the last known spot for a while.
        this.target = null;
        this.state = 'investigate';
        this.stateTimer = this.rng.float(4, 9);
      }

      const reach = this.radius + (this.target?.radius ?? 12) + this.stats.reach;
      if (this.target && dist <= reach && this.attackCooldown <= 0) {
        this.beginAttack();
        this.integrate(dt, game.world);
        return;
      }
    }

    // --- state behaviours ---
    switch (this.state) {
      case 'chase':
        this.steerTo(game, this.goalX, this.goalY);
        break;

      case 'investigate':
        if (this.distTo(this.goalX, this.goalY) < 34 || this.stateTimer <= 0) {
          this.state = 'wander';
          this.stateTimer = this.rng.float(2, 5);
        } else {
          this.steerTo(game, this.goalX, this.goalY);
        }
        break;

      case 'wander':
        if (this.stateTimer <= 0) {
          const a = this.rng.angle();
          const d = this.rng.float(80, 260);
          this.goalX = this.x + Math.cos(a) * d;
          this.goalY = this.y + Math.sin(a) * d;
          this.stateTimer = this.rng.float(3, 8);
        }
        this.steerTo(game, this.goalX, this.goalY);
        // Shambling is slower than pursuit.
        this.moveX *= 0.45;
        this.moveY *= 0.45;
        break;

      case 'idle':
      default:
        this.moveX = 0;
        this.moveY = 0;
        if (this.stateTimer <= 0) {
          this.state = 'wander';
          this.stateTimer = this.rng.float(1, 4);
        }
        break;
    }

    const step = this.integrate(dt, game.world);
    if (step && this.rng.bool(0.25)) audio.play('footstep', this.x, this.y, { volume: 0.5 });
  }

  private beginAttack(): void {
    this.windup = this.stats.windup;
    this.attackCooldown = this.stats.attackCd;
    this.attackAnim = 1;
    if (this.target) {
      // Commit to the position at the start of the swing — sidestepping works.
      this.windupTargetX = this.target.x;
      this.windupTargetY = this.target.y;
      this.facing = Math.atan2(this.windupTargetY - this.y, this.windupTargetX - this.x);
    }
  }

  private landAttack(game: Game): void {
    const t = this.target;
    if (!t || !t.alive) return;
    // Must still be inside the committed swing area.
    const reach = this.radius + t.radius + this.stats.reach + 10;
    if (this.distTo(t.x, t.y) > reach) {
      audio.play('swing', this.x, this.y, { volume: 0.5 });
      return;
    }
    const angle = this.angleTo(t.x, t.y);
    const dmg = this.stats.damage * (0.85 + this.aggression * 0.22);

    t.takeDamage({
      amount: dmg,
      type: 'claw',
      angle,
      knockback: 90 + this.stats.size * 60,
      bleed: this.rng.bool(this.stats.bleedChance) ? 3.5 : 0,
      source: this,
    });

    if (t === game.player) {
      game.player.applyBiteRisk(0.14 + this.stats.pen * 0.2);
      game.onPlayerHurt(dmg, angle);
    }
    audio.play('hit_flesh', this.x, this.y, { volume: 0.8 });
    game.effects.blood(t.x, t.y, angle, dmg);
  }

  protected override onDeath(info: DamageInfo): void {
    audio.play('zombie_die', this.x, this.y, { pitch: 0.7 / this.stats.size, volume: 0.9 });
    void info;
  }

  /** Bloaters rupture, spraying everything nearby. */
  get explodesOnDeath(): boolean { return this.type === 'bloater'; }
}

/** Pick a zombie archetype appropriate for the current day. */
export function rollZombieType(rng: RNG, day: number): ZombieType {
  const pool = (Object.keys(ZOMBIE_STATS) as ZombieType[]).filter((t) => ZOMBIE_STATS[t].minDay <= day);
  return rng.weighted(pool, (t) => {
    const s = ZOMBIE_STATS[t];
    // Tougher variants get more common as the days pass.
    const ramp = s.minDay > 1 ? 1 + (day - s.minDay) * 0.12 : 1;
    return s.weight * ramp;
  });
}

/** Facing helper used by the renderer for the lunge animation. */
export const zombieLunge = (z: Zombie): number => clamp(wrapAngle(z.facing) / TAU, -1, 1);
