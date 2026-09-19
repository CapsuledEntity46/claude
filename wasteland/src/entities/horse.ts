import { angleTowards, clamp, clamp01, damp } from '../core/math';
import { RNG } from '../core/rng';
import { audio } from '../core/audio';
import { Container } from '../items/container';
import { Actor, type DamageInfo, type Faction } from './actor';
import type { Game } from '../game';

export type HorseCoat = 'bay' | 'black' | 'chestnut' | 'grey' | 'palomino';

const COAT_COLORS: Record<HorseCoat, { body: string; mane: string }> = {
  bay: { body: '#6b4526', mane: '#2b1d12' },
  black: { body: '#2f2b28', mane: '#1a1715' },
  chestnut: { body: '#8a4f2a', mane: '#5f3419' },
  grey: { body: '#8d8d90', mane: '#5f5f62' },
  palomino: { body: '#c4a06a', mane: '#e6dcc4' },
};

type State = 'graze' | 'flee' | 'idle' | 'ridden' | 'follow';

/**
 * Rideable horse.
 *
 * Wild horses bolt when approached. Fitting a saddle tames one; a tamed horse
 * can be mounted (Space), carries saddle bags, and gallops at the cost of its
 * own stamina.
 */
export class Horse extends Actor {
  readonly faction: Faction = 'animal';
  readonly coat: HorseCoat;

  tamed = false;
  /** Set while the player is on its back. */
  ridden = false;
  state: State = 'graze';

  /** Saddle bags — only available once saddled. */
  saddleBags: Container | null = null;

  /** 0..100; gallop burns it, walking recovers it. */
  stamina = 100;
  /** Wild horses build trust as you approach slowly; at 100 they can be saddled. */
  trust = 0;

  private rng: RNG;
  private stateTimer = 0;
  private goalX: number;
  private goalY: number;
  /** Smoothed speed for animation and for feeling weighty. */
  private currentSpeed = 0;
  /** Rearing animation when startled. */
  rearAnim = 0;

  readonly walkSpeed = 150;
  readonly trotSpeed = 250;
  readonly gallopSpeed = 400;

  constructor(x: number, y: number, seed = Math.random() * 1e9) {
    super(x, y, 220);
    this.rng = new RNG(Math.floor(seed));
    this.coat = this.rng.pick(Object.keys(COAT_COLORS) as HorseCoat[]);
    this.radius = 19;
    this.speed = this.walkSpeed;
    this.facing = this.rng.angle();
    this.goalX = x;
    this.goalY = y;
  }

  get colors(): { body: string; mane: string } { return COAT_COLORS[this.coat]; }

  /** Fit a saddle: tames the horse and opens its storage. */
  saddle(): void {
    if (this.tamed) return;
    this.tamed = true;
    this.trust = 100;
    this.saddleBags = new Container(`saddle_${this.id}`, 6, 4, 'Saddle Bags');
    audio.play('horse', this.x, this.y, { volume: 0.9 });
  }

  mount(): boolean {
    if (!this.tamed || this.dead) return false;
    this.ridden = true;
    this.state = 'ridden';
    audio.play('horse', this.x, this.y, { volume: 0.7 });
    return true;
  }

  dismount(): void {
    this.ridden = false;
    this.state = 'idle';
    this.moveX = 0;
    this.moveY = 0;
  }

  override takeDamage(info: DamageInfo): number {
    const dealt = super.takeDamage(info);
    if (!this.dead && !this.ridden) {
      this.state = 'flee';
      this.stateTimer = this.rng.float(4, 8);
      this.rearAnim = 1;
      // Being shot at destroys trust.
      this.trust = Math.max(0, this.trust - 45);
      audio.play('horse', this.x, this.y, { volume: 1 });
    }
    return dealt;
  }

  /**
   * Drive the horse from player input while mounted.
   * `gallop` is the sprint key; it drains the horse's stamina, not the rider's.
   */
  rideInput(dx: number, dy: number, gallop: boolean, dt: number): void {
    const mag = Math.hypot(dx, dy);
    if (mag > 0.01) {
      this.moveX = dx / mag;
      this.moveY = dy / mag;
      this.facing = angleTowards(this.facing, Math.atan2(this.moveY, this.moveX), dt * 4.5);
    } else {
      this.moveX = 0;
      this.moveY = 0;
    }

    const wantGallop = gallop && this.stamina > 3 && mag > 0.01;
    const targetSpeed = mag < 0.01 ? 0 : wantGallop ? this.gallopSpeed : this.trotSpeed;
    // Acceleration is deliberately slow — horses have momentum.
    this.currentSpeed = damp(this.currentSpeed, targetSpeed, 1.8, dt);
    this.speed = this.currentSpeed;

    if (wantGallop) this.stamina = clamp(this.stamina - dt * 11, 0, 100);
    else this.stamina = clamp(this.stamina + dt * (mag < 0.01 ? 9 : 4), 0, 100);
  }

  update(dt: number, game: Game): void {
    if (this.dead) return;
    this.stateTimer -= dt;
    this.rearAnim = Math.max(0, this.rearAnim - dt * 2);

    if (this.ridden) {
      // Movement is supplied by rideInput; just integrate and keep the rider attached.
      this.integrate(dt, game.world);
      return;
    }

    const player = game.player;
    const distToPlayer = this.distTo(player.x, player.y);

    // Trust builds when the player is close but moving slowly, and collapses if they sprint at it.
    if (!this.tamed) {
      if (distToPlayer < 220) {
        const approaching = Math.hypot(player.moveX, player.moveY) > 0.05;
        if (player.sprinting && approaching) {
          this.trust = Math.max(0, this.trust - dt * 30);
          if (distToPlayer < 150) {
            this.state = 'flee';
            this.stateTimer = this.rng.float(3, 6);
          }
        } else if (player.crouching || !approaching) {
          this.trust = clamp(this.trust + dt * 16, 0, 100);
        }
      } else {
        this.trust = damp(this.trust, 0, 0.12, dt);
      }
    }

    // Threats always scatter a loose horse.
    let nearestThreat: Actor | null = null;
    let threatD = 300;
    for (const z of game.zombies) {
      if (!z.alive) continue;
      const d = this.distTo(z.x, z.y);
      if (d < threatD) { threatD = d; nearestThreat = z; }
    }
    if (nearestThreat && this.state !== 'flee') {
      this.state = 'flee';
      this.stateTimer = this.rng.float(3, 6);
      this.goalX = this.x + (this.x - nearestThreat.x) * 3;
      this.goalY = this.y + (this.y - nearestThreat.y) * 3;
    }

    switch (this.state) {
      case 'flee': {
        this.speed = this.gallopSpeed * 0.8;
        this.moveToward(game, this.goalX, this.goalY, 1);
        if (this.stateTimer <= 0) {
          this.state = this.tamed ? 'idle' : 'graze';
          this.stateTimer = this.rng.float(2, 5);
        }
        break;
      }

      case 'follow': {
        this.speed = this.trotSpeed * 0.9;
        if (distToPlayer > 120) this.moveToward(game, player.x, player.y, 1);
        else { this.moveX = 0; this.moveY = 0; }
        break;
      }

      case 'idle': {
        this.speed = this.walkSpeed;
        this.moveX = 0;
        this.moveY = 0;
        if (this.stateTimer <= 0) { this.state = 'graze'; this.stateTimer = this.rng.float(3, 7); }
        break;
      }

      case 'graze':
      default: {
        this.speed = this.walkSpeed * 0.6;
        if (this.stateTimer <= 0) {
          if (this.rng.bool(0.45)) {
            this.moveX = this.moveY = 0;
            this.stateTimer = this.rng.float(2, 6);
          } else {
            const a = this.rng.angle();
            const d = this.rng.float(70, 260);
            this.goalX = this.x + Math.cos(a) * d;
            this.goalY = this.y + Math.sin(a) * d;
            this.stateTimer = this.rng.float(3, 7);
          }
        }
        if (this.distTo(this.goalX, this.goalY) > 26) this.moveToward(game, this.goalX, this.goalY, 0.5);
        else { this.moveX = 0; this.moveY = 0; }
        break;
      }
    }

    this.stamina = clamp(this.stamina + dt * 6, 0, 100);
    this.integrate(dt, game.world);
  }

  private moveToward(game: Game, tx: number, ty: number, scale: number): void {
    const desired = Math.atan2(ty - this.y, tx - this.x);
    let bestAngle = desired;
    let bestClear = -1;
    for (const off of [0, 0.5, -0.5, 1.1, -1.1, 1.8, -1.8]) {
      const a = desired + off;
      const hit = game.world.castRay(this.x, this.y, Math.cos(a), Math.sin(a), 60);
      const clear = (hit ? hit.dist : 60) - Math.abs(off) * 12;
      if (clear > bestClear) { bestClear = clear; bestAngle = a; }
      if (off === 0 && !hit) break;
    }
    this.moveX = Math.cos(bestAngle) * scale;
    this.moveY = Math.sin(bestAngle) * scale;
    this.facing = angleTowards(this.facing, bestAngle, 0.08);
  }

  /** 0..1 gallop intensity, for dust and hoof audio. */
  get exertion(): number { return clamp01(this.currentSpeed / this.gallopSpeed); }
}
