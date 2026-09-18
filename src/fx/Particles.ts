import * as THREE from 'three';

const MAX_PARTICLES = 3000;

/**
 * Pixels-per-unit at one unit from the camera, as used by the vertex shader.
 *
 * Exported so callers that care about a particle's *on-screen* size can invert
 * the perspective divide — `size = pixels * distance / POINT_SIZE_SCALE` — instead
 * of guessing a world size and hoping. Near-camera effects like a held torch's
 * flame need this: at half a block away an eyeballed size is off by an order of
 * magnitude, which is how the torch embers ended up first as giant slabs and then
 * as specks.
 */
export const POINT_SIZE_SCALE = 420;

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float screenSize = aSize * (${POINT_SIZE_SCALE}.0 / max(0.001, -mv.z));
    // Snap to whole pixels and clamp to a small range. Sub-pixel point sizes are
    // what make a square sprite render as a soft blur, so quantising here is the
    // 3D equivalent of drawing on integer pixel coordinates with smoothing off.
    gl_PointSize = clamp(floor(screenSize + 0.5), 2.0, 14.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Deliberately no round mask and no edge softening: particles stay hard
    // square pixels for the whole of their life, matching the blocky world.
    //
    // Alpha is quantised into a handful of steps rather than faded continuously,
    // so particles blink out in discrete stages instead of dissolving smoothly.
    float steps = 4.0;
    float quantised = floor(vAlpha * steps + 0.999) / steps;
    if (quantised <= 0.0) discard;
    gl_FragColor = vec4(vColor, quantised);
  }
`;

export interface SpawnOptions {
  color: THREE.ColorRepresentation;
  size?: number;
  life?: number;
  gravity?: number;
  /** Fraction of velocity retained per second. */
  drag?: number;
}

/**
 * Pooled point-sprite particles.
 *
 * A custom shader is used only so each particle can carry its own size and
 * alpha — enough for blood, dirt, sparks, gunsmoke, and explosions without
 * needing any textures.
 */
export class Particles {
  readonly points: THREE.Points;

  private positions = new Float32Array(MAX_PARTICLES * 3);
  private colors = new Float32Array(MAX_PARTICLES * 3);
  private sizes = new Float32Array(MAX_PARTICLES);
  private alphas = new Float32Array(MAX_PARTICLES);

  private velocities = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private gravity = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);

  private liveCount = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly tmpColor = new THREE.Color();

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);
    // Particles move every frame, so a static bounding sphere would cull wrongly.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
  }

  get count(): number {
    return this.liveCount;
  }

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, opts: SpawnOptions): void {
    if (this.liveCount >= MAX_PARTICLES) return;
    const i = this.liveCount++;
    const i3 = i * 3;

    this.positions[i3] = position.x;
    this.positions[i3 + 1] = position.y;
    this.positions[i3 + 2] = position.z;
    this.velocities[i3] = velocity.x;
    this.velocities[i3 + 1] = velocity.y;
    this.velocities[i3 + 2] = velocity.z;

    this.tmpColor.set(opts.color);
    this.colors[i3] = this.tmpColor.r;
    this.colors[i3 + 1] = this.tmpColor.g;
    this.colors[i3 + 2] = this.tmpColor.b;

    this.sizes[i] = opts.size ?? 0.1;
    const life = opts.life ?? 0.7;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alphas[i] = 1;
    this.gravity[i] = opts.gravity ?? 18;
    this.drag[i] = opts.drag ?? 0.4;
  }

  /**
   * A Minecraft-style block-break burst: a shower of small square particles that
   * take their colours from the thing that just broke, so it reads as the object
   * shattering into its own pixels rather than as generic dust.
   *
   * @param colors sampled palette of the source object
   * @param count  particles to emit (20-40 is the Minecraft-ish range)
   */
  spawnBreakParticles(
    position: THREE.Vector3,
    colors: readonly THREE.ColorRepresentation[],
    count = 28,
    spread = 0.6,
    speed = 4.2,
  ): void {
    if (colors.length === 0) return;
    const velocity = new THREE.Vector3();
    const origin = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      // Scatter the origin through the object's volume, not all from one point.
      origin.set(
        position.x + (Math.random() - 0.5) * spread,
        position.y + (Math.random() - 0.5) * spread,
        position.z + (Math.random() - 0.5) * spread,
      );
      // Outward in a random direction, with a bias upward so the shower arcs.
      velocity
        .set(Math.random() * 2 - 1, Math.random() * 1.4 + 0.15, Math.random() * 2 - 1)
        .normalize()
        .multiplyScalar(speed * (0.35 + Math.random() * 0.65));

      this.spawn(origin, velocity, {
        color: colors[Math.floor(Math.random() * colors.length)],
        // A small spread of sizes, all still whole pixels on screen.
        size: 0.05 + Math.random() * 0.045,
        life: 0.55 + Math.random() * 0.45,
        gravity: 20,
        drag: 0.35,
      });
    }
  }

  /** Radial burst, the workhorse for hits and impacts. */
  burst(position: THREE.Vector3, amount: number, speed: number, opts: SpawnOptions): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < amount; i++) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
        .normalize()
        .multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.spawn(position, v, opts);
    }
  }

  /** Cone burst along a direction — muzzle smoke, sparks off a parry. */
  cone(position: THREE.Vector3, direction: THREE.Vector3, amount: number, speed: number, spread: number, opts: SpawnOptions): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < amount; i++) {
      v.copy(direction)
        .normalize()
        .add(
          new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(spread),
        )
        .normalize()
        .multiplyScalar(speed * (0.5 + Math.random() * 0.7));
      this.spawn(position, v, opts);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.liveCount; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.removeSwap(i);
        i--;
        continue;
      }

      const i3 = i * 3;
      const dragFactor = Math.max(0, 1 - this.drag[i] * dt);
      this.velocities[i3] *= dragFactor;
      this.velocities[i3 + 1] = this.velocities[i3 + 1] * dragFactor - this.gravity[i] * dt;
      this.velocities[i3 + 2] *= dragFactor;

      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;

      // Linear remaining-life fraction. The shader quantises this into discrete
      // steps, so no smoothing is applied here either.
      this.alphas[i] = this.life[i] / this.maxLife[i];
    }

    this.geometry.setDrawRange(0, this.liveCount);
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  /** O(1) removal by moving the last live particle into the freed index. */
  private removeSwap(i: number): void {
    const last = this.liveCount - 1;
    if (i !== last) {
      const a = i * 3;
      const b = last * 3;
      for (let k = 0; k < 3; k++) {
        this.positions[a + k] = this.positions[b + k];
        this.colors[a + k] = this.colors[b + k];
        this.velocities[a + k] = this.velocities[b + k];
      }
      this.sizes[i] = this.sizes[last];
      this.alphas[i] = this.alphas[last];
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.gravity[i] = this.gravity[last];
      this.drag[i] = this.drag[last];
    }
    this.liveCount--;
  }

  clear(): void {
    this.liveCount = 0;
    this.geometry.setDrawRange(0, 0);
  }
}
