import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { item } from '../combat/items';
import type { Stack } from '../player/Inventory';
import { isSolid } from '../world/blocks';

const ORB_MAGNET_RANGE = 6.5;
const ORB_COLLECT_RANGE = 1.1;
const LOOT_COLLECT_RANGE = 1.7;
const GRAVITY = 22;

const GEO = {
  orb: new THREE.OctahedronGeometry(0.13, 0),
  loot: new THREE.BoxGeometry(0.26, 0.26, 0.26),
};

const ORB_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xd0a0ff });

/**
 * A soft radial gradient, drawn on a canvas so the project needs no textures.
 * Used as an additive billboard halo around EXP orbs — without it the orbs are
 * nearly invisible at night, which is exactly when the player is fighting.
 */
function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.25, 'rgba(220, 170, 255, 0.75)');
  gradient.addColorStop(0.6, 'rgba(160, 90, 240, 0.22)');
  gradient.addColorStop(1, 'rgba(120, 60, 200, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const GLOW_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const GLOW_MATERIAL = new THREE.MeshBasicMaterial({
  map: makeGlowTexture(),
  transparent: true,
  // Additive so orbs brighten whatever is behind them and read against dark ground.
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

/** Loot cubes are tinted by category so you can tell at a glance what dropped. */
const LOOT_COLORS: Record<string, number> = {
  weapon: 0xc8ccd4,
  armor: 0xc89a5a,
  shield: 0x6b93c9,
  spell: 0xb06cf0,
  consumable: 0x6ad08a,
  ammo: 0x9a8a6a,
  block: 0x8a8a8a,
};

abstract class Pickup {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly mesh: THREE.Mesh;
  life = 150;
  dead = false;
  protected bob = Math.random() * Math.PI * 2;

  constructor(mesh: THREE.Mesh, position: THREE.Vector3) {
    this.mesh = mesh;
    this.position.copy(position);
    this.mesh.position.copy(position);
  }

  /** Simple gravity + ground rest, enough for something that sits on terrain. */
  protected physics(dt: number, ctx: GameContext, restHeight: number): boolean {
    this.velocity.y -= GRAVITY * dt;
    const next = this.position.clone().addScaledVector(this.velocity, dt);

    const below = ctx.world.getBlock(Math.floor(next.x), Math.floor(next.y - restHeight), Math.floor(next.z));
    if (this.velocity.y < 0 && isSolid(below)) {
      this.position.set(next.x, Math.floor(next.y - restHeight) + 1 + restHeight, next.z);
      this.velocity.set(0, 0, 0);
      return true;
    }
    this.position.copy(next);
    return false;
  }

  abstract update(dt: number, ctx: GameContext): void;
}

class ExpOrb extends Pickup {
  value: number;
  private grounded = false;
  /**
   * The glow is a sibling of the orb rather than a child. Parenting it to the
   * spinning orb would mean undoing the parent's rotation every frame just to
   * keep the billboard facing the camera.
   */
  readonly halo: THREE.Mesh;

  constructor(position: THREE.Vector3, value: number) {
    super(new THREE.Mesh(GEO.orb, ORB_MATERIAL), position);
    this.value = value;

    this.halo = new THREE.Mesh(GLOW_GEOMETRY, GLOW_MATERIAL);
    this.halo.scale.setScalar(0.95);
    this.halo.position.copy(position);

    // Pop upward and outward so a kill sprays orbs rather than dropping a pile.
    this.velocity.set((Math.random() - 0.5) * 3.4, 3.2 + Math.random() * 1.6, (Math.random() - 0.5) * 3.4);
  }

  override update(dt: number, ctx: GameContext): void {
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }

    const toPlayer = ctx.player.center.clone().sub(this.position);
    const distance = toPlayer.length();

    if (distance < ORB_COLLECT_RANGE) {
      this.dead = true;
      return;
    }

    if (distance < ORB_MAGNET_RANGE) {
      // Accelerate harder the closer it gets: orbs visibly chase the player.
      const pull = 26 * (1 - distance / ORB_MAGNET_RANGE) + 6;
      this.velocity.addScaledVector(toPlayer.normalize(), pull * dt);
      this.velocity.multiplyScalar(Math.max(0, 1 - 1.2 * dt));
      this.position.addScaledVector(this.velocity, dt);
      this.grounded = false;
    } else if (!this.grounded) {
      this.grounded = this.physics(dt, ctx, 0.13);
    }

    this.bob += dt * 4;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bob) * 0.06;
    this.mesh.rotation.y += dt * 3;
    this.mesh.rotation.x += dt * 2;

    this.halo.position.copy(this.mesh.position);
    const pulse = 0.85 + Math.sin(this.bob * 1.7) * 0.18;
    this.halo.scale.setScalar(0.95 * pulse);
  }

  faceCamera(cameraQuaternion: THREE.Quaternion): void {
    this.halo.quaternion.copy(cameraQuaternion);
  }
}

class LootDrop extends Pickup {
  readonly stack: Stack;
  private grounded = false;

  constructor(position: THREE.Vector3, stack: Stack, material: THREE.Material) {
    super(new THREE.Mesh(GEO.loot, material), position);
    this.stack = stack;
    this.velocity.set((Math.random() - 0.5) * 2.4, 2.6 + Math.random(), (Math.random() - 0.5) * 2.4);
  }

  override update(dt: number, ctx: GameContext): void {
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }
    if (!this.grounded) this.grounded = this.physics(dt, ctx, 0.13);

    this.bob += dt * 2.4;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bob) * 0.08;
    this.mesh.rotation.y += dt * 1.4;
  }
}

export interface PickupCallbacks {
  onXp(amount: number): void;
  /** Returns true if the item was taken; false leaves the drop on the ground. */
  onItem(stack: Stack): boolean;
}

/**
 * Manages EXP orbs and dropped loot. Orbs home in on the player once close,
 * which is the entire reward feedback loop for a kill.
 */
export class PickupManager {
  readonly group = new THREE.Group();
  private orbs: ExpOrb[] = [];
  private drops: LootDrop[] = [];
  private lootMaterials = new Map<string, THREE.MeshLambertMaterial>();
  private callbacks: PickupCallbacks;
  /** Batches XP collected in the same frame into one message. */
  private pendingXp = 0;

  constructor(callbacks: PickupCallbacks) {
    this.callbacks = callbacks;
    this.group.name = 'pickups';
  }

  get orbCount(): number {
    return this.orbs.length;
  }

  /** Splits an XP reward into a handful of orbs so pickup feels granular. */
  spawnOrbs(position: THREE.Vector3, totalXp: number): void {
    if (totalXp <= 0) return;
    const count = Math.max(1, Math.min(8, Math.round(totalXp / 8)));
    const per = totalXp / count;
    for (let i = 0; i < count; i++) {
      const orb = new ExpOrb(position, i === count - 1 ? totalXp - Math.floor(per) * (count - 1) : Math.floor(per));
      this.orbs.push(orb);
      this.group.add(orb.mesh, orb.halo);
    }
  }

  spawnLoot(position: THREE.Vector3, stacks: readonly Stack[]): void {
    for (const stack of stacks) {
      const def = item(stack.itemId);
      const color = LOOT_COLORS[def.kind] ?? 0xffffff;
      let material = this.lootMaterials.get(def.kind);
      if (!material) {
        material = new THREE.MeshLambertMaterial({ color });
        this.lootMaterials.set(def.kind, material);
      }
      const drop = new LootDrop(position, { ...stack }, material);
      this.drops.push(drop);
      this.group.add(drop.mesh);
    }
  }

  /** Billboards every orb halo towards the camera. */
  faceCamera(cameraQuaternion: THREE.Quaternion): void {
    for (const orb of this.orbs) orb.faceCamera(cameraQuaternion);
  }

  update(dt: number, ctx: GameContext): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.update(dt, ctx);
      if (orb.dead) {
        if (orb.life > 0) this.pendingXp += orb.value;
        this.group.remove(orb.mesh, orb.halo);
        this.orbs.splice(i, 1);
      }
    }

    if (this.pendingXp > 0) {
      this.callbacks.onXp(this.pendingXp);
      ctx.floater(ctx.player.center, `+${this.pendingXp} XP`, 'xp');
      this.pendingXp = 0;
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      drop.update(dt, ctx);

      if (!drop.dead && drop.position.distanceTo(ctx.player.center) < LOOT_COLLECT_RANGE) {
        // A full bag leaves the drop where it is rather than deleting it.
        if (this.callbacks.onItem(drop.stack)) drop.dead = true;
        else drop.life = Math.min(drop.life, 60);
      }

      if (drop.dead) {
        this.group.remove(drop.mesh);
        this.drops.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const o of this.orbs) this.group.remove(o.mesh, o.halo);
    for (const d of this.drops) this.group.remove(d.mesh);
    this.orbs.length = 0;
    this.drops.length = 0;
    this.pendingXp = 0;
  }
}
