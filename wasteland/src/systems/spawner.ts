/**
 * Population management.
 *
 * Keeps a believable density of zombies, bandits, animals and horses in a ring
 * around the player: spawns happen out of sight, and anything left far behind is
 * culled so the simulation cost stays flat as you travel.
 */

import { RNG } from '../core/rng';
import { audio } from '../core/audio';
import { Biome } from '../world/tiles';
import { Zombie, rollZombieType } from '../entities/zombie';
import { Bandit, rollBanditKind } from '../entities/bandit';
import { Animal, rollAnimalKind, ANIMAL_STATS } from '../entities/animal';
import { Horse } from '../entities/horse';
import type { Game } from '../game';

/** Ring in which new spawns appear (world units). */
const SPAWN_MIN = 760;
const SPAWN_MAX = 1500;
/** Anything further than this from the player is removed. */
const CULL_DIST = 2400;

export class Spawner {
  private rng: RNG;
  private zombieTimer = 0;
  private banditTimer = 6;
  private animalTimer = 3;
  private horseTimer = 10;
  /** Buildings whose indoor zombies have already been seeded. */
  private seededBuildings = new Set<number>();
  /** Countdown to the next night horde. */
  private hordeTimer = 90;
  /** Set while a horde is actively streaming in. */
  private hordeRemaining = 0;
  private hordeAngle = 0;

  constructor(seed: number) {
    this.rng = new RNG(seed ^ 0x51ee7);
  }

  update(dt: number, game: Game): void {
    this.cull(game);
    this.seedBuildings(game);

    this.zombieTimer -= dt;
    this.banditTimer -= dt;
    this.animalTimer -= dt;
    this.horseTimer -= dt;
    this.hordeTimer -= dt;

    if (this.zombieTimer <= 0) {
      this.zombieTimer = 0.9;
      this.topUpZombies(game);
    }
    if (this.banditTimer <= 0) {
      this.banditTimer = 5;
      this.topUpBandits(game);
    }
    if (this.animalTimer <= 0) {
      this.animalTimer = 4;
      this.topUpAnimals(game);
    }
    if (this.horseTimer <= 0) {
      this.horseTimer = 12;
      this.topUpHorses(game);
    }

    this.updateHorde(dt, game);
  }

  // -----------------------------------------------------------------------

  private cull(game: Game): void {
    const px = game.player.x, py = game.player.y;
    const far = (x: number, y: number) => Math.hypot(x - px, y - py) > CULL_DIST;

    for (let i = game.zombies.length - 1; i >= 0; i--) {
      const z = game.zombies[i];
      if (z.dead || far(z.x, z.y)) game.zombies.splice(i, 1);
    }
    for (let i = game.bandits.length - 1; i >= 0; i--) {
      const b = game.bandits[i];
      if (b.dead || far(b.x, b.y)) game.bandits.splice(i, 1);
    }
    for (let i = game.animals.length - 1; i >= 0; i--) {
      const a = game.animals[i];
      if (a.dead || far(a.x, a.y)) game.animals.splice(i, 1);
    }
    for (let i = game.horses.length - 1; i >= 0; i--) {
      const h = game.horses[i];
      // Never cull the horse you're riding, or a tamed one nearby.
      if (h === game.player.mount) continue;
      if (h.dead || (far(h.x, h.y) && !h.tamed)) game.horses.splice(i, 1);
    }
  }

  /** Populate building interiors the first time the player gets close. */
  private seedBuildings(game: Game): void {
    const px = game.player.x, py = game.player.y;
    for (const b of game.world.buildings) {
      if (this.seededBuildings.has(b.id)) continue;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (Math.hypot(cx - px, cy - py) > 900) continue;
      this.seededBuildings.add(b.id);

      const pressure = game.dayNight.spawnPressure;
      for (const spot of b.spawnSpots) {
        if (!this.rng.bool(Math.min(0.95, 0.5 * pressure))) continue;
        if (game.zombies.length >= this.zombieCap(game)) break;
        const type = rollZombieType(this.rng, game.dayNight.day);
        const z = new Zombie(spot.x, spot.y, type, this.rng.next() * 1e9);
        game.zombies.push(z);
      }
    }
  }

  private zombieCap(game: Game): number {
    const town = game.world.townAt(game.player.x, game.player.y);
    const near = game.world.nearestTown(game.player.x, game.player.y);
    let base = 7;
    if (town) base = 12 + town.tier * 7;
    else if (near && near.dist < near.town.radius * 2) base = 10;
    return Math.min(52, Math.round(base * game.dayNight.spawnPressure));
  }

  private topUpZombies(game: Game): void {
    const cap = this.zombieCap(game);
    if (game.zombies.length >= cap) return;

    // Spawn a couple at a time so populations ramp in smoothly.
    for (let i = 0; i < 2 && game.zombies.length < cap; i++) {
      const spot = this.findSpot(game, 13);
      if (!spot) return;
      const type = rollZombieType(this.rng, game.dayNight.day);
      game.zombies.push(new Zombie(spot.x, spot.y, type, this.rng.next() * 1e9));
    }
  }

  private topUpBandits(game: Game): void {
    const town = game.world.townAt(game.player.x, game.player.y);
    const day = game.dayNight.day;
    let cap = Math.min(9, Math.floor(day / 2));
    if (town) cap += 1 + town.tier;
    // Bandits mostly come out in daylight; zombies own the night.
    cap = Math.round(cap * (1 - game.dayNight.darkness * 0.55));
    if (game.bandits.length >= cap) return;

    const spot = this.findSpot(game, 13);
    if (!spot) return;
    const kind = rollBanditKind(this.rng, day);
    // Bandits arrive in small groups.
    const groupSize = kind === 'heavy' ? 1 : this.rng.int(1, 2);
    for (let i = 0; i < groupSize && game.bandits.length < cap; i++) {
      game.bandits.push(new Bandit(
        spot.x + this.rng.float(-50, 50),
        spot.y + this.rng.float(-50, 50),
        kind, this.rng.next() * 1e9,
      ));
    }
  }

  private topUpAnimals(game: Game): void {
    const town = game.world.townAt(game.player.x, game.player.y);
    const cap = town ? 3 : 11;
    if (game.animals.length >= cap) return;

    const spot = this.findSpot(game, 15);
    if (!spot) return;
    const biome = game.world.biomeAt(spot.x, spot.y);
    const hostile = biome === Biome.Forest || biome === Biome.Mountain || biome === Biome.Tundra;
    const kind = rollAnimalKind(this.rng, hostile);
    const stats = ANIMAL_STATS[kind];
    const packSize = this.rng.int(stats.packMin, stats.packMax);

    for (let i = 0; i < packSize && game.animals.length < cap; i++) {
      game.animals.push(new Animal(
        spot.x + this.rng.float(-60, 60),
        spot.y + this.rng.float(-60, 60),
        kind, this.rng.next() * 1e9,
      ));
    }
  }

  private topUpHorses(game: Game): void {
    const wild = game.horses.filter((h) => !h.tamed).length;
    const biome = game.world.biomeAt(game.player.x, game.player.y);
    const cap = biome === Biome.Plains || biome === Biome.Badlands ? 4 : 2;
    if (wild >= cap) return;

    const spot = this.findSpot(game, 20);
    if (!spot) return;
    const herd = this.rng.int(1, 3);
    for (let i = 0; i < herd; i++) {
      game.horses.push(new Horse(
        spot.x + this.rng.float(-70, 70),
        spot.y + this.rng.float(-70, 70),
        this.rng.next() * 1e9,
      ));
    }
  }

  // -----------------------------------------------------------------------

  /** Night hordes: a wave of zombies converges from one direction. */
  private updateHorde(dt: number, game: Game): void {
    if (this.hordeRemaining > 0) {
      this.hordeTimer -= dt; // reuse as a drip timer
      if (this.hordeTimer <= 0) {
        this.hordeTimer = 0.35;
        const dist = this.rng.float(SPAWN_MIN, SPAWN_MAX);
        const a = this.hordeAngle + this.rng.float(-0.5, 0.5);
        const x = game.player.x + Math.cos(a) * dist;
        const y = game.player.y + Math.sin(a) * dist;
        if (game.world.inBounds(x, y) && !game.world.isWater(x, y)) {
          const type = rollZombieType(this.rng, game.dayNight.day + 2);
          const z = new Zombie(x, y, type, this.rng.next() * 1e9);
          // Horde members already know where you are.
          z.alert(game.player.x, game.player.y, 1);
          game.zombies.push(z);
          this.hordeRemaining--;
        }
      }
      return;
    }

    if (this.hordeTimer > 0) return;

    // Only at night, and more likely as the days pile up.
    const night = game.dayNight.isNight;
    const chance = night ? 0.5 + Math.min(0.4, game.dayNight.day * 0.03) : 0.05;
    this.hordeTimer = this.rng.float(140, 300);

    if (!this.rng.bool(chance)) return;

    this.hordeRemaining = this.rng.int(9, 16) + Math.min(18, game.dayNight.day);
    this.hordeAngle = this.rng.angle();
    this.hordeTimer = 0;
    game.toast('You hear them coming…', 'bad');
    audio.play('zombie_alert', game.player.x + Math.cos(this.hordeAngle) * 300, game.player.y + Math.sin(this.hordeAngle) * 300, { volume: 1.2 });
  }

  /** Find a valid off-screen spawn position. */
  private findSpot(game: Game, radius: number): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 26; attempt++) {
      const a = this.rng.angle();
      const d = this.rng.float(SPAWN_MIN, SPAWN_MAX);
      const x = game.player.x + Math.cos(a) * d;
      const y = game.player.y + Math.sin(a) * d;
      if (!game.world.inBounds(x, y)) continue;
      if (game.world.isWater(x, y)) continue;
      if (!game.world.isClear(x, y, radius)) continue;
      return { x, y };
    }
    return null;
  }

  /** Called on load so building interiors aren't re-seeded. */
  markSeeded(ids: number[]): void {
    for (const id of ids) this.seededBuildings.add(id);
  }

  get seeded(): number[] { return [...this.seededBuildings]; }
}
