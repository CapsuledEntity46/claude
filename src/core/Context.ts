import type * as THREE from 'three';
import type { DamageInput, DamageType } from '../combat/types';
import type { Enemy } from '../entities/Enemy';
import type { Particles } from '../fx/Particles';
import type { Player } from '../player/Player';
import type { World } from '../world/World';

export type LogClass = 'hit' | 'crit' | 'hurt' | 'good' | 'info' | 'magic';
export type FloaterClass = 'dmg' | 'crit' | 'hurt' | 'block' | 'xp' | 'heal' | 'mana';

export interface ProjectileRequest {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  damage: number;
  type: DamageType;
  armorPierce: number;
  gravity: number;
  knockback: number;
  /** True when fired by an enemy, so it hits the player instead of monsters. */
  hostile: boolean;
  aoeRadius?: number;
  blockDamage?: number;
  fuse?: number;
  /** Visual style. */
  look?: 'arrow' | 'bolt' | 'bullet' | 'grenade' | 'magic';
  color?: number;
  /** Applies the frost slow on hit. */
  slow?: number;
  /** Sets the target burning on hit: damage per second, and duration. */
  burn?: number;
  burnDuration?: number;
  sourceName: string;
}

/**
 * Read/write access to live enemies. Damage is funnelled through one method so
 * that XP, loot, and death effects can never be forgotten by a caller.
 */
export interface EnemyWorld {
  readonly enemies: readonly Enemy[];
  damageEnemy(enemy: Enemy, input: DamageInput, from: THREE.Vector3, knockback: number): void;
  enemiesInSphere(center: THREE.Vector3, radius: number): Enemy[];
  nearestEnemy(from: THREE.Vector3, maxDistance: number, exclude?: ReadonlySet<Enemy>): Enemy | null;
}

/**
 * The service surface that entities and systems use to talk to the rest of the
 * game. Keeping it an interface means enemies, projectiles, and spells never
 * need a direct reference to the Game object.
 */
export interface GameContext {
  world: World;
  player: Player;
  particles: Particles;
  enemies: EnemyWorld;
  /** Seconds since the world started; useful for cooldown bookkeeping. */
  time: number;
  /** 0 at night, 1 at midday. Drives spawn pressure and how far enemies see. */
  daylight: number;
  /** True while rain or a storm is falling. */
  raining: boolean;

  damagePlayer(input: DamageInput, from: THREE.Vector3, sourceName: string): void;
  spawnProjectile(req: ProjectileRequest): void;
  /** Wakes enemies within `radius` — gunshots and explosions are loud. */
  alert(position: THREE.Vector3, radius: number): void;
  explode(position: THREE.Vector3, radius: number, damage: number, type: DamageType, armorPierce: number, blockDamage: number, hostile: boolean, sourceName: string): void;

  log(message: string, cls?: LogClass): void;
  floater(worldPosition: THREE.Vector3, text: string, cls: FloaterClass): void;
}
