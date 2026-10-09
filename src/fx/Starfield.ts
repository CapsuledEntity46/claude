import * as THREE from 'three';
import { mulberry32 } from '../world/noise';

const STAR_COUNT = 1400;
const SHELL_RADIUS = 380;

/**
 * A dome of stars that fades in at night.
 *
 * The group is re-centred on the camera every frame so the stars never get
 * nearer — they should read as infinitely distant, not as a ball of dots the
 * player can walk towards.
 */
export class Starfield {
  readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;

  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);

    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on a hemisphere, biased above the horizon.
      const theta = rand() * Math.PI * 2;
      const y = 0.05 + rand() * 0.95;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      positions[i * 3] = Math.cos(theta) * r * SHELL_RADIUS;
      positions[i * 3 + 1] = y * SHELL_RADIUS;
      positions[i * 3 + 2] = Math.sin(theta) * r * SHELL_RADIUS;

      // A few faintly coloured stars stop it looking like static.
      const warm = rand();
      const brightness = 0.55 + rand() * 0.45;
      colors[i * 3] = brightness * (warm > 0.85 ? 1 : 0.85);
      colors[i * 3 + 1] = brightness * 0.9;
      colors[i * 3 + 2] = brightness * (warm < 0.2 ? 1 : 0.88);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.PointsMaterial({
      size: 2.2,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Additive so stars brighten the sky rather than punching holes in it.
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'stars';
  }

  /** @param opacity 0 in daylight, 1 at night */
  update(cameraPosition: THREE.Vector3, opacity: number): void {
    this.points.position.copy(cameraPosition);
    this.material.opacity = opacity;
    this.points.visible = opacity > 0.01;
  }
}
