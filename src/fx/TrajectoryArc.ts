import * as THREE from 'three';
import { isSolid } from '../world/blocks';
import type { World } from '../world/World';

const MAX_STEPS = 90;
const STEP_SECONDS = 1 / 24;

/**
 * A translucent preview of where a thrown or lobbed projectile will land.
 *
 * The arc is produced by stepping the *same* ballistic integration the real
 * projectile uses, which is the only way for the preview to be trustworthy: any
 * separately-derived formula would drift from actual behaviour the moment either
 * side changed.
 */
export class TrajectoryArc {
  readonly group = new THREE.Group();

  private line: THREE.Line;
  private impact: THREE.Mesh;
  private positions = new Float32Array(MAX_STEPS * 3);
  private geometry: THREE.BufferGeometry;

  constructor() {
    this.group.name = 'trajectory-arc';
    this.group.visible = false;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.line = new THREE.Line(
      this.geometry,
      new THREE.LineDashedMaterial({
        color: 0xffe6a8,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        dashSize: 0.35,
        gapSize: 0.3,
      }),
    );
    this.line.frustumCulled = false;

    // A ring at the predicted landing point, which is what the player actually
    // aims with; the dotted path just explains how it gets there.
    this.impact = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.46, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffd070,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.impact.rotation.x = -Math.PI / 2;

    this.group.add(this.line, this.impact);
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * Traces a projectile from `origin` along `direction` and draws the result.
   *
   * @param gravityScale matches the projectile's own gravity multiplier; 0 draws a
   *   straight line, which is correct for flat-shooting weapons.
   */
  show(
    world: World,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    gravityScale: number,
    worldGravity = 26,
  ): void {
    const position = origin.clone();
    const velocity = direction.clone().normalize().multiplyScalar(speed);
    const step = new THREE.Vector3();

    let count = 0;
    let landed = false;

    for (let i = 0; i < MAX_STEPS; i++) {
      this.positions[count * 3] = position.x;
      this.positions[count * 3 + 1] = position.y;
      this.positions[count * 3 + 2] = position.z;
      count++;

      velocity.y -= worldGravity * gravityScale * STEP_SECONDS;
      step.copy(velocity).multiplyScalar(STEP_SECONDS);
      const distance = step.length();
      if (distance < 1e-5) break;

      // Stop at the first surface, exactly as the projectile would.
      const hit = world.raycast(position, step.clone().normalize(), distance, isSolid);
      if (hit) {
        this.positions[count * 3] = hit.point.x;
        this.positions[count * 3 + 1] = hit.point.y;
        this.positions[count * 3 + 2] = hit.point.z;
        count++;
        this.impact.position.set(hit.point.x, hit.point.y + 0.03, hit.point.z);
        landed = true;
        break;
      }

      position.add(step);
    }

    if (!landed) {
      // Ran out of trace before hitting anything: mark the end of the path.
      this.impact.position.set(position.x, position.y, position.z);
    }

    this.geometry.setDrawRange(0, count);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.line.computeLineDistances();
    this.impact.visible = landed;
    this.group.visible = count > 1;
  }
}
