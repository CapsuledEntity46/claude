import * as THREE from 'three';

const MAX_PARTICLES = 3000;

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
    gl_PointSize = aSize * (420.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    // Round points instead of squares; cheap and much less noticeable.
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha);
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

  private count = 0;
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

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, opts: SpawnOptions): void {
    if (this.count >= MAX_PARTICLES) return;
    const i = this.count++;
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
    for (let i = 0; i < this.count; i++) {
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

      // Fade over the last 60% of life so the pop-out is not abrupt.
      const t = this.life[i] / this.maxLife[i];
      this.alphas[i] = Math.min(1, t / 0.6);
    }

    this.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  /** O(1) removal by moving the last live particle into the freed index. */
  private removeSwap(i: number): void {
    const last = this.count - 1;
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
    this.count--;
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }
}
