import * as THREE from 'three';
import type { EnemyWorld, GameContext } from '../core/Context';
import { computeDamage, type DamageInput } from '../combat/types';
import { mulberry32 } from '../world/noise';
import { FISH, pickArchetype } from './archetypes';
import { Enemy } from './Enemy';
import { rollLoot, xpForKill } from './loot';
import type { PickupManager } from './Pickups';

/** Base seconds between spawn attempts at full night-time pressure. */
const SPAWN_INTERVAL = 4.5;
const SPAWN_MIN_DISTANCE = 22;
const SPAWN_MAX_DISTANCE = 40;
const DESPAWN_DISTANCE = 88;

/** Fish are a resource, not a threat, so they get their own budget. */
const FISH_CAP = 10;
const FISH_INTERVAL = 6;
const FISH_MIN_DISTANCE = 10;
const FISH_MAX_DISTANCE = 34;
/** Enemies push each other apart within this radius so they never fully overlap. */
const SEPARATION_RADIUS = 1.1;

/**
 * Owns the live enemy population: spawning, separation, damage resolution, and
 * the death rewards (EXP orbs and loot).
 */
export class EntityManager implements EnemyWorld {
  readonly group = new THREE.Group();
  private list: Enemy[] = [];
  private ctx!: GameContext;
  private pickups: PickupManager;
  private rng = mulberry32(0xbeef);
  private spawnTimer = 6;
  private fishTimer = 3;
  /** Archetypes the player has already met, so hints only fire once. */
  private seen = new Set<string>();

  constructor(pickups: PickupManager) {
    this.pickups = pickups;
    this.group.name = 'enemies';
  }

  /** Called once the game context exists (it references this manager). */
  attach(ctx: GameContext): void {
    this.ctx = ctx;
  }

  get enemies(): readonly Enemy[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  /** Fish are never worth alerting, and never chase. */
  private static isThreat(enemy: Enemy): boolean {
    return !enemy.archetype.passive;
  }

  /** Test hook: the current hostile population ceiling. */
  debugHostileCap(ctx: GameContext): number {
    return this.hostileCap(ctx);
  }

  /** Test hook: force a fish school into nearby water. Returns how many spawned. */
  debugSpawnFishNear(ctx: GameContext): number {
    const before = this.fishCount;
    for (let i = 0; i < 6 && this.fishCount === before; i++) this.trySpawnFish(ctx);
    return this.fishCount - before;
  }

  // ---------------------------------------------------------------- queries

  enemiesInSphere(center: THREE.Vector3, radius: number): Enemy[] {
    const out: Enemy[] = [];
    const r2 = radius * radius;
    for (const e of this.list) {
      if (e.dead) continue;
      if (e.center.distanceToSquared(center) <= r2) out.push(e);
    }
    return out;
  }

  nearestEnemy(from: THREE.Vector3, maxDistance: number, exclude?: ReadonlySet<Enemy>): Enemy | null {
    let best: Enemy | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const e of this.list) {
      if (e.dead || exclude?.has(e)) continue;
      const d = e.center.distanceToSquared(from);
      if (d < bestDistance) {
        bestDistance = d;
        best = e;
      }
    }
    return best;
  }

  alert(position: THREE.Vector3, radius: number): void {
    const r2 = radius * radius;
    for (const e of this.list) {
      if (!e.dead && EntityManager.isThreat(e) && e.center.distanceToSquared(position) <= r2) e.alert();
    }
  }

  // ---------------------------------------------------------------- damage

  /**
   * Single entry point for hurting an enemy. Resolves the damage formula,
   * shows feedback, and pays out XP and loot on death.
   */
  damageEnemy(enemy: Enemy, input: DamageInput, from: THREE.Vector3, knockback: number): void {
    if (enemy.dead) return;
    const result = computeDamage(input, enemy.defense, this.rng);
    const direction = enemy.center.clone().sub(from);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);

    const killed = enemy.applyDamage(result, direction, knockback, this.ctx);

    this.ctx.floater(
      enemy.center.clone().add(new THREE.Vector3(0, 0.4, 0)),
      result.crit ? `${result.damage} CRIT` : `${result.damage}`,
      result.crit ? 'crit' : 'dmg',
    );

    // Tell the player when armour is eating most of the hit — that is the cue to
    // switch to a thrust or a blunt weapon.
    if (!killed && result.mitigated > result.damage * 1.2) {
      this.ctx.log(`${enemy.archetype.name}'s armor turns most of that aside.`, 'info');
    }

    if (killed) this.onKill(enemy);
  }

  private onKill(enemy: Enemy): void {
    const xp = xpForKill(enemy.archetype, enemy.level);
    this.pickups.spawnOrbs(enemy.center, xp);

    // Mana has no passive regeneration, so kills are the main way casters refuel.
    // Casters carry more of it, which gives a reason to hunt them specifically.
    const isCaster = enemy.archetype.ranged?.look === 'magic';
    if (!enemy.archetype.passive && this.rng() < (isCaster ? 0.85 : 0.45)) {
      const mana = Math.round((isCaster ? 16 : 8) + enemy.level * 1.6);
      this.pickups.spawnOrbs(enemy.center, mana, 'mana');
    }

    const loot = rollLoot(enemy.archetype, enemy.level, this.rng);
    if (loot.length > 0) this.pickups.spawnLoot(enemy.center, loot);

    this.ctx.log(`${enemy.name} falls.`, 'good');

    // A block-break shatter: the enemy bursts into a shower of square particles
    // coloured from its own materials, which arc under gravity and blink out.
    this.ctx.particles.spawnBreakParticles(
      enemy.center,
      enemy.breakPalette(),
      24 + Math.floor(this.rng() * 14),
      Math.max(0.5, enemy.radius * 2.2),
      4.2 + enemy.radius,
    );
  }

  // ---------------------------------------------------------------- lifecycle

  /** Test hook: halts enemy AI so combat geometry can be measured. */
  frozen = false;

  update(dt: number, ctx: GameContext): void {
    if (this.frozen) return;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.update(dt, ctx);
      if (e.removable || e.center.distanceTo(ctx.player.position) > DESPAWN_DISTANCE) {
        e.dispose();
        this.group.remove(e.group);
        this.list.splice(i, 1);
      }
    }

    this.separate();
    this.trySpawn(dt, ctx);
  }

  /** Keeps camera-facing health bars readable. */
  faceCamera(camera: THREE.Camera): void {
    for (const e of this.list) e.faceCamera(camera);
  }

  /** O(n^2) but n is small; keeps a pack from collapsing into one point. */
  private separate(): void {
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (b.dead) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        const minDistance = SEPARATION_RADIUS * (a.radius + b.radius) / 0.7;
        if (d2 > minDistance * minDistance || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = ((minDistance - d) / minDistance) * 2.4;
        const nx = dx / d;
        const nz = dz / d;
        a.push(-nx * push, -nz * push);
        b.push(nx * push, nz * push);
      }
    }
  }

  /** Hostiles only — fish do not count against the combat budget. */
  get hostileCount(): number {
    let n = 0;
    for (const e of this.list) if (!e.archetype.passive && !e.dead) n++;
    return n;
  }

  get fishCount(): number {
    let n = 0;
    for (const e of this.list) if (e.archetype.passive && !e.dead) n++;
    return n;
  }

  /**
   * How hard the world is pushing right now: low in daylight, full at night.
   *
   * Daytime needs to be genuinely quiet. Scaling the cap linearly with level
   * (as this first did) meant a level-30 character was permanently swarmed and
   * could never put down a wall without a fight.
   */
  private spawnPressure(ctx: GameContext): number {
    return 0.3 + (1 - ctx.daylight) * 0.7;
  }

  /** Maximum simultaneous hostiles. Plateaus rather than growing without bound. */
  private hostileCap(ctx: GameContext): number {
    const level = ctx.player.stats.level;
    // sqrt growth: 4 at level 1, 8 by level 9, 13 by level 34 — not 34.
    const base = 3 + Math.floor(Math.sqrt(level) * 1.7);
    return Math.max(2, Math.round(base * this.spawnPressure(ctx)));
  }

  private trySpawn(dt: number, ctx: GameContext): void {
    this.spawnTimer -= dt;
    this.fishTimer -= dt;

    if (this.fishTimer <= 0) {
      this.fishTimer = FISH_INTERVAL;
      this.trySpawnFish(ctx);
    }

    if (this.spawnTimer > 0) return;

    const pressure = this.spawnPressure(ctx);
    // Spawns get rarer as the area fills up, so pressure ramps instead of spiking.
    this.spawnTimer = (SPAWN_INTERVAL / pressure) * (1 + this.hostileCount * 0.22);

    if (this.hostileCount >= this.hostileCap(ctx)) return;

    // Group spawns only once the player can handle them, and only after dark.
    const level = ctx.player.stats.level;
    const night = 1 - ctx.daylight;
    const groupSize =
      1 +
      (level >= 4 && this.rng() < 0.22 * night ? 1 : 0) +
      (level >= 8 && this.rng() < 0.12 * night ? 1 : 0);

    // Underground: populate the dungeon around the player instead of dropping
    // enemies onto the surface far overhead.
    if (this.trySpawnInDungeon(ctx)) return;

    const anchor = this.findSpawnPoint(ctx);
    if (!anchor) return;

    for (let i = 0; i < groupSize; i++) {
      const offset = new THREE.Vector3((this.rng() - 0.5) * 5, 0, (this.rng() - 0.5) * 5);
      const point = anchor.clone().add(offset);
      const ground = ctx.world.highestSolidY(Math.floor(point.x), Math.floor(point.z));
      if (ground < 0) continue;
      point.y = ground + 1.05;
      this.spawnAt(point, ctx.player.stats.level);
    }
  }

  /**
   * Spawns dungeon inhabitants at the layout's own marked positions.
   *
   * Returns true when it handled the spawn, so the surface spawner stands down.
   * Vault guards come in several levels above the player, which is what makes a
   * vault worth the trip and worth being careful about.
   */
  private trySpawnInDungeon(ctx: GameContext): boolean {
    const player = ctx.player.position;
    const points = ctx.world.gen.dungeons.spawnPointsNear(player.x, player.z, 44);
    if (points.length === 0) return false;

    // Only spawn out of sight, and only where the room is actually loaded.
    const candidates = points.filter((point) => {
      const distance = Math.hypot(point.x - player.x, point.z - player.z);
      if (distance < 12 || distance > 44) return false;
      if (Math.abs(point.y - player.y) > 26) return false;
      if (!ctx.world.isLoadedAt(Math.floor(point.x), Math.floor(point.z))) return false;
      // The marker must still be open space — the player may have walled it up.
      return !ctx.world.isSolidAt(point.x, point.y + 1, point.z);
    });
    if (candidates.length === 0) return false;

    const chosen = candidates[Math.floor(this.rng() * candidates.length)];
    const level = Math.max(1, ctx.player.stats.level + (chosen.elite ? 3 + Math.floor(this.rng() * 3) : 0));
    const enemy = this.spawnAt(new THREE.Vector3(chosen.x, chosen.y, chosen.z), level);
    if (enemy && chosen.elite) {
      this.ctx.log('Something heavy stirs in the vault.', 'hurt');
    }
    return true;
  }

  /** Puts fish in nearby water so there is something to hunt. */
  private trySpawnFish(ctx: GameContext): void {
    if (this.fishCount >= FISH_CAP) return;

    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const distance = FISH_MIN_DISTANCE + this.rng() * (FISH_MAX_DISTANCE - FISH_MIN_DISTANCE);
      const wx = Math.floor(ctx.player.position.x + Math.cos(angle) * distance);
      const wz = Math.floor(ctx.player.position.z + Math.sin(angle) * distance);
      if (!ctx.world.isLoadedAt(wx, wz)) continue;

      const spot = ctx.world.findWaterSpot(wx, wz, 2);
      if (!spot) continue;

      // Small schools rather than lone fish.
      const school = 1 + Math.floor(this.rng() * 3);
      for (let i = 0; i < school; i++) {
        const jitter = new THREE.Vector3((this.rng() - 0.5) * 3, (this.rng() - 0.5) * 1.2, (this.rng() - 0.5) * 3);
        const point = spot.clone().add(jitter);
        if (!ctx.world.isWaterAt(point.x, point.y, point.z)) continue;
        const fish = new Enemy(FISH, Math.max(1, Math.round(ctx.player.stats.level * 0.4)), point, this.rng);
        this.list.push(fish);
        this.group.add(fish.group);
      }
      return;
    }
  }

  /** Finds ground behind the player, out of sight, on a loaded chunk. */
  private findSpawnPoint(ctx: GameContext): THREE.Vector3 | null {
    const facing = ctx.player.facing;
    for (let attempt = 0; attempt < 14; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const distance = SPAWN_MIN_DISTANCE + this.rng() * (SPAWN_MAX_DISTANCE - SPAWN_MIN_DISTANCE);
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);

      // Prefer spots that are not directly in front of the player.
      if (dx * facing.x + dz * facing.z > 0.35 && distance < 30) continue;

      const wx = Math.floor(ctx.player.position.x + dx * distance);
      const wz = Math.floor(ctx.player.position.z + dz * distance);
      if (!ctx.world.isLoadedAt(wx, wz)) continue;

      const ground = ctx.world.highestSolidY(wx, wz);
      if (ground < 4) continue;
      // Reject spots buried under terrain (no headroom).
      if (ctx.world.isSolidAt(wx, ground + 2, wz)) continue;

      return new THREE.Vector3(wx + 0.5, ground + 1.05, wz + 0.5);
    }
    return null;
  }

  spawnAt(position: THREE.Vector3, playerLevel: number): Enemy | null {
    // Mostly around the player's level, with an occasional dangerous outlier
    // that is worth a lot of XP and carries better loot.
    const roll = this.rng();
    const delta = roll < 0.1 ? 3 : roll < 0.35 ? 1 : roll < 0.75 ? 0 : -1;
    const level = Math.max(1, playerLevel + delta);

    const archetype = pickArchetype(level, this.rng);
    const enemy = new Enemy(archetype, level, position, this.rng);
    this.list.push(enemy);
    this.group.add(enemy.group);

    if (!this.seen.has(archetype.id)) this.seen.add(archetype.id);
    return enemy;
  }

  clear(): void {
    for (const e of this.list) {
      e.dispose();
      this.group.remove(e.group);
    }
    this.list.length = 0;
    this.spawnTimer = 6;
    this.fishTimer = 3;
  }
}
