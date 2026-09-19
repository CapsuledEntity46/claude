import { angleTowards } from '../core/math';
import { RNG } from '../core/rng';
import { audio } from '../core/audio';
import type { LootTableName } from '../items/lootTables';
import { Actor, type DamageInfo, type Faction } from './actor';
import type { Game } from '../game';

export type AnimalKind = 'deer' | 'boar' | 'wolf' | 'chicken';

interface AnimalStats {
  name: string;
  hp: number;
  speed: number;
  /** Multiplier on speed while fleeing/charging. */
  sprint: number;
  damage: number;
  reach: number;
  attackCd: number;
  /** Distance at which it notices threats. */
  sense: number;
  radius: number;
  size: number;
  loot: LootTableName;
  /** 'prey' flees, 'defensive' retaliates, 'predator' hunts. */
  temper: 'prey' | 'defensive' | 'predator';
  /** Spawn weight. */
  weight: number;
  color: string;
  packMin: number;
  packMax: number;
}

export const ANIMAL_STATS: Record<AnimalKind, AnimalStats> = {
  deer: {
    name: 'Deer', hp: 60, speed: 150, sprint: 1.9, damage: 0, reach: 0, attackCd: 1,
    sense: 420, radius: 15, size: 1.1, loot: 'deer', temper: 'prey', weight: 40,
    color: '#8a6a44', packMin: 1, packMax: 3,
  },
  boar: {
    name: 'Boar', hp: 110, speed: 132, sprint: 2.1, damage: 22, reach: 12, attackCd: 1.4,
    sense: 300, radius: 16, size: 1.05, loot: 'boar', temper: 'defensive', weight: 26,
    color: '#5f4a3a', packMin: 1, packMax: 2,
  },
  wolf: {
    name: 'Wolf', hp: 80, speed: 172, sprint: 1.7, damage: 17, reach: 10, attackCd: 0.95,
    sense: 560, radius: 13, size: 0.95, loot: 'wolf', temper: 'predator', weight: 22,
    color: '#6a6a6e', packMin: 2, packMax: 4,
  },
  chicken: {
    name: 'Chicken', hp: 18, speed: 110, sprint: 1.8, damage: 0, reach: 0, attackCd: 1,
    sense: 200, radius: 8, size: 0.6, loot: 'chicken', temper: 'prey', weight: 12,
    color: '#c9c2b0', packMin: 2, packMax: 5,
  },
};

type State = 'graze' | 'flee' | 'hunt' | 'attack' | 'charge';

export class Animal extends Actor {
  readonly faction: Faction = 'animal';
  readonly kind: AnimalKind;
  readonly stats: AnimalStats;

  state: State = 'graze';
  private rng: RNG;
  private stateTimer = 0;
  private attackCooldown = 0;
  private goalX: number;
  private goalY: number;
  private threat: Actor | null = null;
  /** Set true once damaged, so defensive animals turn aggressive. */
  private provoked = false;
  attackAnim = 0;

  constructor(x: number, y: number, kind: AnimalKind, seed = Math.random() * 1e9) {
    const stats = ANIMAL_STATS[kind];
    super(x, y, stats.hp);
    this.kind = kind;
    this.stats = stats;
    this.radius = stats.radius;
    this.speed = stats.speed;
    this.rng = new RNG(Math.floor(seed));
    this.facing = this.rng.angle();
    this.goalX = x;
    this.goalY = y;
  }

  override takeDamage(info: DamageInfo): number {
    this.provoked = true;
    if (info.source) {
      this.threat = info.source;
      if (this.stats.temper === 'prey') {
        this.state = 'flee';
        this.stateTimer = this.rng.float(4, 8);
      } else {
        this.state = this.stats.temper === 'defensive' ? 'charge' : 'hunt';
        this.stateTimer = this.rng.float(6, 12);
      }
    }
    return super.takeDamage(info);
  }

  private nearestThreat(game: Game): Actor | null {
    let best: Actor | null = null;
    let bestD2 = this.stats.sense * this.stats.sense;
    const consider = (a: Actor) => {
      if (!a.alive) return;
      const d2 = this.dist2To(a.x, a.y);
      if (d2 < bestD2) { bestD2 = d2; best = a; }
    };
    consider(game.player);
    for (const z of game.zombies) consider(z);
    return best;
  }

  private moveToward(game: Game, tx: number, ty: number, scale: number): void {
    const desired = Math.atan2(ty - this.y, tx - this.x);
    let bestAngle = desired;
    let bestClear = -1;
    for (const off of [0, 0.5, -0.5, 1.1, -1.1]) {
      const a = desired + off;
      const hit = game.world.castRay(this.x, this.y, Math.cos(a), Math.sin(a), 48);
      const clear = (hit ? hit.dist : 48) - Math.abs(off) * 10;
      if (clear > bestClear) { bestClear = clear; bestAngle = a; }
      if (off === 0 && !hit) break;
    }
    this.moveX = Math.cos(bestAngle) * scale;
    this.moveY = Math.sin(bestAngle) * scale;
    this.facing = angleTowards(this.facing, bestAngle, 0.14);
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;
    this.stateTimer -= dt;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.attackAnim = Math.max(0, this.attackAnim - dt * 3);

    if (this.stun > 0) {
      this.moveX = this.moveY = 0;
      this.integrate(dt, game.world);
      return;
    }

    const threat = this.nearestThreat(game);
    const temper = this.stats.temper;

    // Prey bolt as soon as anything gets close.
    if (temper === 'prey' && threat) {
      const d = this.distTo(threat.x, threat.y);
      if (d < this.stats.sense * 0.55) {
        this.threat = threat;
        this.state = 'flee';
        this.stateTimer = Math.max(this.stateTimer, 2.5);
      }
    }
    // Predators hunt anything smaller.
    if (temper === 'predator' && threat && this.state === 'graze') {
      this.threat = threat;
      this.state = 'hunt';
      this.stateTimer = 10;
    }

    switch (this.state) {
      case 'flee': {
        const t = this.threat;
        if (!t || this.stateTimer <= 0 || this.distTo(t.x, t.y) > this.stats.sense * 1.4) {
          this.state = 'graze';
          this.stateTimer = this.rng.float(2, 5);
          break;
        }
        const away = this.angleTo(t.x, t.y) + Math.PI + this.rng.float(-0.3, 0.3);
        this.moveToward(game, this.x + Math.cos(away) * 240, this.y + Math.sin(away) * 240, this.stats.sprint);
        break;
      }

      case 'hunt': {
        const t = this.threat;
        if (!t || !t.alive || this.stateTimer <= 0) { this.state = 'graze'; this.stateTimer = 3; break; }
        const d = this.distTo(t.x, t.y);
        if (d <= this.radius + t.radius + this.stats.reach) {
          this.state = 'attack';
        } else {
          this.moveToward(game, t.x, t.y, 1.25);
        }
        break;
      }

      case 'charge': {
        const t = this.threat;
        if (!t || !t.alive || this.stateTimer <= 0) { this.state = 'graze'; this.stateTimer = 3; break; }
        const d = this.distTo(t.x, t.y);
        if (d <= this.radius + t.radius + this.stats.reach) this.state = 'attack';
        else this.moveToward(game, t.x, t.y, this.stats.sprint);
        break;
      }

      case 'attack': {
        const t = this.threat;
        this.moveX = this.moveY = 0;
        if (!t || !t.alive) { this.state = 'graze'; break; }
        const d = this.distTo(t.x, t.y);
        if (d > this.radius + t.radius + this.stats.reach + 12) {
          this.state = temper === 'predator' ? 'hunt' : 'charge';
          break;
        }
        this.facing = angleTowards(this.facing, this.angleTo(t.x, t.y), dt * 8);
        if (this.attackCooldown <= 0 && this.stats.damage > 0) {
          this.attackCooldown = this.stats.attackCd;
          this.attackAnim = 1;
          const angle = this.angleTo(t.x, t.y);
          t.takeDamage({
            amount: this.stats.damage, type: 'claw', angle,
            knockback: 110, bleed: this.rng.bool(0.3) ? 3 : 0, source: this,
          });
          audio.play('hit_flesh', this.x, this.y, { volume: 0.7 });
          game.effects.blood(t.x, t.y, angle, this.stats.damage);
          if (t === game.player) game.onPlayerHurt(this.stats.damage, angle);
        }
        break;
      }

      case 'graze':
      default: {
        if (this.stateTimer <= 0) {
          if (this.rng.bool(0.4)) {
            this.moveX = this.moveY = 0;
            this.stateTimer = this.rng.float(1.5, 4);
          } else {
            const a = this.rng.angle();
            const d = this.rng.float(60, 220);
            this.goalX = this.x + Math.cos(a) * d;
            this.goalY = this.y + Math.sin(a) * d;
            this.stateTimer = this.rng.float(2, 5);
          }
        }
        if (this.distTo(this.goalX, this.goalY) > 24) this.moveToward(game, this.goalX, this.goalY, 0.42);
        else { this.moveX = 0; this.moveY = 0; }
        break;
      }
    }

    this.integrate(dt, game.world);
  }

  get isHostile(): boolean {
    return this.stats.temper === 'predator' || (this.stats.temper === 'defensive' && this.provoked);
  }
}

export function rollAnimalKind(rng: RNG, biomeHostile: boolean): AnimalKind {
  const kinds = Object.keys(ANIMAL_STATS) as AnimalKind[];
  return rng.weighted(kinds, (k) => {
    const s = ANIMAL_STATS[k];
    // Wolves prefer forest/mountain, chickens prefer farmland near towns.
    if (biomeHostile && k === 'wolf') return s.weight * 2;
    if (!biomeHostile && k === 'chicken') return s.weight * 1.8;
    return s.weight;
  });
}
