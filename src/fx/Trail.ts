import * as THREE from 'three';

const MAX_TRAILS = 48;
const SEGMENTS = 14;

interface TrailState {
  /** Ring buffer of recent world positions, newest last. */
  points: THREE.Vector3[];
  used: number;
  life: number;
  maxLife: number;
  color: THREE.Color;
  width: number;
  active: boolean;
}

/**
 * Ribbon trails for arrows in flight and melee swings.
 *
 * Each trail is a strip of quads built from the last few positions of whatever is
 * moving, widest at the head and tapering to nothing at the tail. One geometry
 * holds every trail so the whole effect costs a single draw call.
 *
 * Vertex alpha is written into a colour attribute and multiplied in the shader;
 * additive blending then makes the tail fade out without needing sorting.
 */
export class Trail {
  readonly mesh: THREE.Mesh;

  private trails: TrailState[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private alphas: Float32Array;
  private indices: Uint16Array;
  private geometry: THREE.BufferGeometry;
  private vertexCount = 0;
  private indexCount = 0;

  constructor() {
    const maxVertices = MAX_TRAILS * SEGMENTS * 2;
    const maxIndices = MAX_TRAILS * (SEGMENTS - 1) * 6;

    this.positions = new Float32Array(maxVertices * 3);
    this.colors = new Float32Array(maxVertices * 3);
    this.alphas = new Float32Array(maxVertices);
    this.indices = new Uint16Array(maxIndices);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(vColor * vAlpha, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'trails';

    for (let i = 0; i < MAX_TRAILS; i++) {
      this.trails.push({
        points: Array.from({ length: SEGMENTS }, () => new THREE.Vector3()),
        used: 0,
        life: 0,
        maxLife: 1,
        color: new THREE.Color(),
        width: 0.1,
        active: false,
      });
    }
  }

  /** Starts a trail and returns its handle, or -1 if none are free. */
  spawn(color: THREE.ColorRepresentation, width: number, life: number): number {
    for (let i = 0; i < this.trails.length; i++) {
      const t = this.trails[i];
      if (t.active) continue;
      t.active = true;
      t.used = 0;
      t.life = life;
      t.maxLife = life;
      t.color.set(color);
      t.width = width;
      return i;
    }
    return -1;
  }

  /** Appends a position to a live trail. */
  push(handle: number, position: THREE.Vector3): void {
    if (handle < 0 || handle >= this.trails.length) return;
    const t = this.trails[handle];
    if (!t.active) return;

    if (t.used < SEGMENTS) {
      t.points[t.used].copy(position);
      t.used++;
      return;
    }
    // Full: shuffle down and append. SEGMENTS is small enough that this is cheap.
    for (let i = 0; i < SEGMENTS - 1; i++) t.points[i].copy(t.points[i + 1]);
    t.points[SEGMENTS - 1].copy(position);
  }

  /** Stops adding to a trail but lets what is drawn fade out. */
  release(handle: number): void {
    if (handle < 0 || handle >= this.trails.length) return;
    this.trails[handle].life = Math.min(this.trails[handle].life, 0.22);
  }

  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.vertexCount = 0;
    this.indexCount = 0;

    for (const t of this.trails) {
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        continue;
      }
      if (t.used < 2) continue;
      this.buildRibbon(t, cameraPosition);
    }

    this.geometry.setDrawRange(0, this.indexCount);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aColor').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
    this.geometry.getIndex()!.needsUpdate = true;
    this.mesh.visible = this.indexCount > 0;
  }

  private readonly forward = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly sideways = new THREE.Vector3();

  private buildRibbon(t: TrailState, cameraPosition: THREE.Vector3): void {
    const count = t.used;
    const baseVertex = this.vertexCount;
    const fade = Math.min(1, t.life / t.maxLife);

    for (let i = 0; i < count; i++) {
      const point = t.points[i];
      // Direction along the ribbon, from this point towards the next.
      if (i < count - 1) this.forward.copy(t.points[i + 1]).sub(point);
      else this.forward.copy(point).sub(t.points[i - 1]);
      if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 1, 0);
      this.forward.normalize();

      // Widen perpendicular to both the path and the view, so the ribbon always
      // presents its face to the camera instead of vanishing edge-on.
      this.toCamera.copy(cameraPosition).sub(point).normalize();
      this.sideways.crossVectors(this.forward, this.toCamera);
      if (this.sideways.lengthSq() < 1e-8) this.sideways.set(1, 0, 0);
      this.sideways.normalize();

      // Taper: newest end is full width, oldest tapers to a point.
      const along = count > 1 ? i / (count - 1) : 1;
      const halfWidth = t.width * 0.5 * along;
      const alpha = fade * along * along;

      for (const sign of [-1, 1]) {
        const v = this.vertexCount++;
        this.positions[v * 3] = point.x + this.sideways.x * halfWidth * sign;
        this.positions[v * 3 + 1] = point.y + this.sideways.y * halfWidth * sign;
        this.positions[v * 3 + 2] = point.z + this.sideways.z * halfWidth * sign;
        this.colors[v * 3] = t.color.r;
        this.colors[v * 3 + 1] = t.color.g;
        this.colors[v * 3 + 2] = t.color.b;
        this.alphas[v] = alpha;
      }
    }

    for (let i = 0; i < count - 1; i++) {
      const a = baseVertex + i * 2;
      this.indices[this.indexCount++] = a;
      this.indices[this.indexCount++] = a + 1;
      this.indices[this.indexCount++] = a + 3;
      this.indices[this.indexCount++] = a;
      this.indices[this.indexCount++] = a + 3;
      this.indices[this.indexCount++] = a + 2;
    }
  }

  clear(): void {
    for (const t of this.trails) t.active = false;
    this.vertexCount = 0;
    this.indexCount = 0;
    this.geometry.setDrawRange(0, 0);
  }

  get activeCount(): number {
    return this.trails.filter((t) => t.active).length;
  }
}
