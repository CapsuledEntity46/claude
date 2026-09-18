import * as THREE from 'three';
import type { World } from '../world/World';

const MAX_DROPS = 3200;
const SPAWN_RADIUS = 24;
const SPAWN_HEIGHT = 20;
const FALL_SPEED = 26;
const STREAK_LENGTH = 1.15;

/**
 * Rain, drawn as falling line segments.
 *
 * Line segments rather than point sprites because rain reads as streaks, and
 * `gl_PointSize` cannot produce an elongated shape. Drops are recycled when they
 * reach the terrain surface beneath them, so rain visibly stops at the ground
 * and does not fall through the world or inside caves.
 */
export class Rain {
  readonly lines: THREE.LineSegments;

  private positions = new Float32Array(MAX_DROPS * 6);
  private velocities = new Float32Array(MAX_DROPS * 3);
  /** Terrain height each drop is falling towards. */
  private groundY = new Float32Array(MAX_DROPS);
  private active = 0;
  private spawnAccumulator = 0;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;

  /** Called when a drop lands, so the caller can splash. */
  onSplash?: (x: number, y: number, z: number) => void;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.LineBasicMaterial({
      color: 0xaac4dd,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.name = 'rain';
  }

  get dropCount(): number {
    return this.active;
  }

  /**
   * @param rate drops to spawn per second (0 stops the rain)
   * @param wind horizontal drift, in blocks per second
   */
  update(dt: number, world: World, centre: THREE.Vector3, rate: number, wind = 1.4): void {
    // Spawn.
    if (rate > 0) {
      this.spawnAccumulator += rate * dt;
      const toSpawn = Math.floor(this.spawnAccumulator);
      this.spawnAccumulator -= toSpawn;
      for (let i = 0; i < toSpawn; i++) this.spawn(world, centre, wind);
    }

    // Integrate and recycle.
    for (let i = this.active - 1; i >= 0; i--) {
      const v = i * 3;
      const p = i * 6;

      const nx = this.positions[p] + this.velocities[v] * dt;
      const ny = this.positions[p + 1] + this.velocities[v + 1] * dt;
      const nz = this.positions[p + 2] + this.velocities[v + 2] * dt;

      if (ny <= this.groundY[i]) {
        this.onSplash?.(nx, this.groundY[i], nz);
        this.removeSwap(i);
        continue;
      }

      // Head of the streak.
      this.positions[p] = nx;
      this.positions[p + 1] = ny;
      this.positions[p + 2] = nz;
      // Tail trails behind along the velocity direction.
      const speed = Math.hypot(this.velocities[v], this.velocities[v + 1], this.velocities[v + 2]) || 1;
      this.positions[p + 3] = nx - (this.velocities[v] / speed) * STREAK_LENGTH;
      this.positions[p + 4] = ny - (this.velocities[v + 1] / speed) * STREAK_LENGTH;
      this.positions[p + 5] = nz - (this.velocities[v + 2] / speed) * STREAK_LENGTH;
    }

    // Drops far outside the play area (after the player moved) are dropped too.
    for (let i = this.active - 1; i >= 0; i--) {
      const p = i * 6;
      const dx = this.positions[p] - centre.x;
      const dz = this.positions[p + 2] - centre.z;
      if (dx * dx + dz * dz > (SPAWN_RADIUS + 14) ** 2) this.removeSwap(i);
    }

    this.geometry.setDrawRange(0, this.active * 2);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.lines.visible = this.active > 0;
  }

  private spawn(world: World, centre: THREE.Vector3, wind: number): void {
    if (this.active >= MAX_DROPS) return;

    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * SPAWN_RADIUS;
    const x = centre.x + Math.cos(angle) * radius;
    const z = centre.z + Math.sin(angle) * radius;
    const y = centre.y + SPAWN_HEIGHT * (0.5 + Math.random() * 0.5);

    // Land on whatever surface is under this column. Unloaded columns report -1,
    // in which case fall past the player and get culled.
    const surface = world.highestSolidY(Math.floor(x), Math.floor(z));
    const ground = surface >= 0 ? surface + 1 : centre.y - 30;
    if (ground >= y) return;

    const i = this.active++;
    const v = i * 3;
    const p = i * 6;

    this.velocities[v] = wind;
    this.velocities[v + 1] = -FALL_SPEED * (0.9 + Math.random() * 0.2);
    this.velocities[v + 2] = wind * 0.4;
    this.groundY[i] = ground;

    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.positions[p + 3] = x;
    this.positions[p + 4] = y - STREAK_LENGTH;
    this.positions[p + 5] = z;
  }

  private removeSwap(i: number): void {
    const last = this.active - 1;
    if (i !== last) {
      for (let k = 0; k < 6; k++) this.positions[i * 6 + k] = this.positions[last * 6 + k];
      for (let k = 0; k < 3; k++) this.velocities[i * 3 + k] = this.velocities[last * 3 + k];
      this.groundY[i] = this.groundY[last];
    }
    this.active--;
  }

  /** Dims the rain at night so it does not glow against a dark sky. */
  setBrightness(value: number): void {
    this.material.opacity = 0.3 + value * 0.42;
  }

  clear(): void {
    this.active = 0;
    this.geometry.setDrawRange(0, 0);
  }
}
