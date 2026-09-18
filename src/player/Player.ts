import * as THREE from 'three';
import type { Input } from '../core/Input';
import { Block } from '../world/blocks';
import type { World } from '../world/World';
import { combineDefense, type DefenseProfile } from '../combat/types';
import { Inventory } from './Inventory';
import { PlayerStats } from './Stats';

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

const GRAVITY = 28;
const JUMP_SPEED = 8.7;
const TERMINAL_VELOCITY = -56;
const SPRINT_MULTIPLIER = 1.55;
const AIR_CONTROL = 0.35;
/** Blocks of automatic step-up. Makes blocky terrain pleasant to walk on. */
const STEP_HEIGHT = 1.02;
const SWIM_UP_SPEED = 3.4;
const SINK_SPEED = -1.6;
const COLLIDE_EPS = 1e-3;

export class Player {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  onGround = false;
  inWater = false;
  /** Camera roll/pitch kick applied by attacks and recoil. */
  viewKick = new THREE.Vector2();

  readonly stats = new PlayerStats();
  inventory: Inventory;

  /** True while the player holds guard with a shield equipped. */
  blocking = false;
  sprinting = false;

  dead = false;

  /** Accumulated fall distance, converted to damage on landing. */
  private fallStart: number | null = null;

  constructor(inventory = Inventory.startingKit()) {
    this.inventory = inventory;
    this.stats.hp = this.stats.maxHp;
    this.stats.stamina = this.stats.maxStamina;
    this.syncEquipmentDerived();
    this.stats.guard = this.stats.maxGuard;
  }

  // ---------------------------------------------------------------- geometry

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
  }

  /** Unit vector the camera is looking along. */
  get lookDirection(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Horizontal facing, ignoring pitch. Used for guard-cone checks. */
  get facing(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  applyToCamera(camera: THREE.PerspectiveCamera): void {
    const eye = this.eyePosition;
    camera.position.copy(eye);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw);
    camera.rotateX(this.pitch + this.viewKick.y);
    camera.rotateZ(this.viewKick.x);
  }

  // ---------------------------------------------------------------- defense

  /** Keeps weight and shield capacity in sync with what is equipped. */
  syncEquipmentDerived(): void {
    const armor = this.inventory.equippedDef('armor');
    const shield = this.inventory.equippedDef('shield');
    const weapon = this.inventory.equippedDef('weapon');
    this.stats.weight =
      (armor?.armor?.weight ?? 0) + (shield?.shield?.weight ?? 0) + (weapon?.weapon?.twoHanded ? 0.8 : 0.3);
    this.stats.shieldGuard = shield?.shield?.guard ?? 0;
    if (this.stats.guard > this.stats.maxGuard) this.stats.guard = this.stats.maxGuard;
  }

  get defense(): DefenseProfile {
    const armor = this.inventory.equippedDef('armor')?.armor ?? null;
    const ward = this.stats.wardArmor > 0 ? { armor: this.stats.wardArmor, resist: {} } : null;
    return combineDefense([armor, ward]);
  }

  get canBlock(): boolean {
    const shield = this.inventory.equippedDef('shield');
    return !!shield && this.stats.guard > 0 && this.stats.stamina > 0;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, input: Input, world: World): void {
    if (this.dead) return;

    this.applyLook(input);

    const eyeBlock = world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + EYE_HEIGHT),
      Math.floor(this.position.z),
    );
    const feetBlock = world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + 0.4),
      Math.floor(this.position.z),
    );
    this.inWater = feetBlock === Block.Water || eyeBlock === Block.Water;

    this.applyMovement(dt, input);
    this.integrate(dt, world);

    this.stats.update(dt, this.sprinting, this.blocking);

    // Decay the view kick back to neutral.
    this.viewKick.multiplyScalar(Math.max(0, 1 - dt * 9));
  }

  private applyLook(input: Input): void {
    this.yaw -= input.mouseDX * input.sensitivity;
    this.pitch -= input.mouseDY * input.sensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    // Keep yaw bounded so it never loses float precision over a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  private applyMovement(dt: number, input: Input): void {
    let ix = 0;
    let iz = 0;
    if (input.isDown('KeyW')) iz -= 1;
    if (input.isDown('KeyS')) iz += 1;
    if (input.isDown('KeyA')) ix -= 1;
    if (input.isDown('KeyD')) ix += 1;

    const moving = ix !== 0 || iz !== 0;
    this.sprinting =
      moving && input.isDown('ShiftLeft') && this.stats.stamina > 1 && !this.blocking && !this.inWater;

    let speed = this.stats.moveSpeed;
    if (this.sprinting) speed *= SPRINT_MULTIPLIER;
    if (this.blocking) speed *= 0.45;
    if (this.inWater) speed *= 0.7;

    // Rotate input into world space using yaw only.
    //
    // The basis must match the camera: forward is (-sin yaw, 0, -cos yaw) and
    // right is (cos yaw, 0, -sin yaw). With W giving iz = -1, the world velocity
    // is right*ix + forward*(-iz), which expands to the two lines below. Getting
    // the sign of the iz terms wrong inverts W and S while leaving A and D
    // correct — which is exactly how this shipped, and why it looked plausible.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = ix * cos + iz * sin;
    let wz = -ix * sin + iz * cos;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx = (wx / len) * speed;
      wz = (wz / len) * speed;
    }

    // Grounded movement is snappy; airborne movement only nudges.
    const control = this.onGround || this.inWater ? 1 : AIR_CONTROL;
    this.velocity.x += (wx - this.velocity.x) * Math.min(1, control * dt * 18);
    this.velocity.z += (wz - this.velocity.z) * Math.min(1, control * dt * 18);

    if (this.inWater) {
      // Buoyancy instead of gravity: drift down unless actively swimming up.
      const targetY = input.isDown('Space') ? SWIM_UP_SPEED : SINK_SPEED;
      this.velocity.y += (targetY - this.velocity.y) * Math.min(1, dt * 6);
      this.fallStart = null;
    } else {
      if (input.isDown('Space') && this.onGround) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
      }
      this.velocity.y = Math.max(TERMINAL_VELOCITY, this.velocity.y - GRAVITY * dt);
    }
  }

  private collides(world: World, x: number, y: number, z: number): boolean {
    return world.boxIntersectsSolid(
      x - PLAYER_HALF_WIDTH + COLLIDE_EPS,
      y + COLLIDE_EPS,
      z - PLAYER_HALF_WIDTH + COLLIDE_EPS,
      x + PLAYER_HALF_WIDTH - COLLIDE_EPS,
      y + PLAYER_HEIGHT - COLLIDE_EPS,
      z + PLAYER_HALF_WIDTH - COLLIDE_EPS,
    );
  }

  /**
   * Axis-separated collision response. Each axis is moved and resolved
   * independently, which is both stable and cheap on a voxel grid.
   */
  private integrate(dt: number, world: World): void {
    const startY = this.position.y;

    // --- vertical -----------------------------------------------------------
    const nextY = this.position.y + this.velocity.y * dt;
    if (!this.collides(world, this.position.x, nextY, this.position.z)) {
      this.position.y = nextY;
      this.onGround = false;
    } else {
      if (this.velocity.y < 0) {
        // Snap down onto the surface we just hit.
        this.position.y = Math.ceil(nextY);
        while (this.collides(world, this.position.x, this.position.y, this.position.z)) {
          this.position.y += 0.05;
          if (this.position.y - startY > 3) break;
        }
        this.onGround = true;
        this.handleLanding();
      }
      this.velocity.y = 0;
    }

    if (this.velocity.y < -0.1 && !this.onGround && !this.inWater) {
      if (this.fallStart === null) this.fallStart = this.position.y;
    }

    // --- horizontal, with step assist ---------------------------------------
    this.moveAxis(world, 'x', this.velocity.x * dt);
    this.moveAxis(world, 'z', this.velocity.z * dt);
  }

  private moveAxis(world: World, axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return;
    const original = this.position[axis];
    const target = original + delta;

    const test = (v: number, y: number): boolean => {
      const x = axis === 'x' ? v : this.position.x;
      const z = axis === 'z' ? v : this.position.z;
      return this.collides(world, x, y, z);
    };

    if (!test(target, this.position.y)) {
      this.position[axis] = target;
      return;
    }

    // Blocked: try stepping up over a one-block ledge before giving up.
    if (this.onGround || this.inWater) {
      const stepY = this.position.y + STEP_HEIGHT;
      if (!test(target, stepY) && !this.collides(world, this.position.x, stepY, this.position.z)) {
        this.position[axis] = target;
        this.position.y = stepY;
        return;
      }
    }

    this.velocity[axis] = 0;
  }

  private handleLanding(): void {
    if (this.fallStart === null) return;
    const distance = this.fallStart - this.position.y;
    this.fallStart = null;
    if (distance > 4) {
      const damage = Math.round((distance - 4) * 3.2);
      if (damage > 0) this.onFallDamage?.(damage);
    }
  }

  /** Set by the game so fall damage can route through the normal damage pipeline. */
  onFallDamage?: (amount: number) => void;

  // ---------------------------------------------------------------- placement

  /** Drops the player onto solid ground at the given column. */
  spawnAt(world: World, wx: number, wz: number): void {
    const y = world.highestSolidY(wx, wz);
    this.position.set(wx + 0.5, (y < 0 ? 40 : y + 1) + 0.05, wz + 0.5);
    this.velocity.set(0, 0, 0);
    this.fallStart = null;
    this.onGround = false;
  }

  /** True when the player box overlaps this world-space sphere. */
  overlapsSphere(center: THREE.Vector3, radius: number): boolean {
    const cx = THREE.MathUtils.clamp(center.x, this.position.x - PLAYER_HALF_WIDTH, this.position.x + PLAYER_HALF_WIDTH);
    const cy = THREE.MathUtils.clamp(center.y, this.position.y, this.position.y + PLAYER_HEIGHT);
    const cz = THREE.MathUtils.clamp(center.z, this.position.z - PLAYER_HALF_WIDTH, this.position.z + PLAYER_HALF_WIDTH);
    return center.distanceToSquared(new THREE.Vector3(cx, cy, cz)) <= radius * radius;
  }

  /** Centre of mass, used as the aim point for enemies and projectiles. */
  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + PLAYER_HEIGHT * 0.55, this.position.z);
  }
}
