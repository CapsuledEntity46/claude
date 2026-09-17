import * as THREE from 'three';
import type { EnemyWorld, GameContext } from '../core/Context';
import { computeDamage, type DamageInput } from '../combat/types';
import { mulberry32 } from '../world/noise';
import { pickArchetype } from './archetypes';
import { Enemy } from './Enemy';
import { rollLoot, xpForKill } from './loot';
import type { PickupManager } from './Pickups';

const SPAWN_INTERVAL = 2.8;
const SPAWN_MIN_DISTANCE = 20;
const SPAWN_MAX_DISTANCE = 38;
const DESPAWN_DISTANCE = 88;
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
  private spawnTimer = 2;
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
      if (!e.dead && e.center.distanceToSquared(position) <= r2) e.alert();
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

    const loot = rollLoot(enemy.archetype, enemy.level, this.rng);
    if (loot.length > 0) this.pickups.spawnLoot(enemy.center, loot);

    this.ctx.log(`${enemy.name} falls.`, 'good');
    this.ctx.particles.burst(enemy.center, 20, 5, {
      color: enemy.archetype.id === 'skeleton_knight' ? 0xdad6c8 : 0x7a1018,
      size: 0.11,
      life: 0.8,
      gravity: 18,
    });
  }

  // ---------------------------------------------------------------- lifecycle

  update(dt: number, ctx: GameContext): void {
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

  private trySpawn(dt: number, ctx: GameContext): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = SPAWN_INTERVAL;

    // Population scales with the player. A level-1 character facing a dozen
    // goblins at once is not a difficulty curve, it is a wall.
    const cap = 4 + Math.floor(ctx.player.stats.level * 0.9);
    if (this.list.length >= cap) return;

    // Group spawns only once the player can handle them.
    const level = ctx.player.stats.level;
    const groupSize =
      1 + (level >= 3 && this.rng() < 0.3 ? 1 : 0) + (level >= 6 && this.rng() < 0.15 ? 1 : 0);
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
    this.spawnTimer = 2;
  }
}
