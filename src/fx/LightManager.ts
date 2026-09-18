import * as THREE from 'three';
import type { World } from '../world/World';

const PLACED_LIGHT_POOL = 6;
const PLACED_LIGHT_RANGE = 26;

/**
 * Dynamic lights: one for the torch in your hand, plus a small pool assigned to
 * the nearest light-emitting blocks.
 *
 * This is not a voxel lighting engine — there is no light propagation or
 * per-block light level. Emissive blocks already glow through their vertex
 * colours; these point lights add the falloff on nearby surfaces that makes a
 * placed torch actually feel like it lights a room. The pool is small and
 * reassigned to the closest sources each frame, which is why a cave full of
 * torches only lights up near the player.
 */
export class LightManager {
  readonly group = new THREE.Group();

  private handLight: THREE.PointLight;
  private placed: THREE.PointLight[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor() {
    this.group.name = 'dynamic-lights';

    this.handLight = new THREE.PointLight(0xffb055, 0, 15, 2);
    this.group.add(this.handLight);

    for (let i = 0; i < PLACED_LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xffb469, 0, 13, 2);
      light.visible = false;
      this.placed.push(light);
      this.group.add(light);
    }
  }

  /**
   * @param handPosition world position of the held torch flame, or null
   * @param darkness 0 in full daylight, 1 at night — lights fade out by day
   */
  update(world: World, eye: THREE.Vector3, handPosition: THREE.Vector3 | null, darkness: number): void {
    // Held torch.
    if (handPosition) {
      this.handLight.position.copy(handPosition);
      // Still contributes a little in daylight so the flame does not look painted on.
      this.handLight.intensity = 1.1 + darkness * 1.5;
      this.handLight.distance = 11 + darkness * 6;
      this.handLight.visible = true;
    } else {
      this.handLight.visible = false;
      this.handLight.intensity = 0;
    }

    // Nearest placed light blocks.
    const sources = world.nearestLightSources(eye, PLACED_LIGHT_RANGE, PLACED_LIGHT_POOL);
    for (let i = 0; i < this.placed.length; i++) {
      const light = this.placed[i];
      const source = sources[i];
      if (!source) {
        light.visible = false;
        continue;
      }
      this.scratch.set(source.x + 0.5, source.y + 0.5, source.z + 0.5);
      light.position.copy(this.scratch);
      // Fade with distance as well as daylight, so lights entering and leaving
      // the pool do not pop.
      const distanceFade = 1 - Math.min(1, this.scratch.distanceTo(eye) / PLACED_LIGHT_RANGE);
      light.intensity = (0.5 + darkness * 1.9) * (0.35 + distanceFade * 0.65);
      light.visible = light.intensity > 0.03;
    }
  }

  /** Light state, for verifying a held torch actually illuminates the world. */
  debugState(): Record<string, unknown> {
    return {
      handLightOn: this.handLight.visible,
      handIntensity: Number(this.handLight.intensity.toFixed(2)),
      placedActive: this.placed.filter((l) => l.visible).length,
    };
  }
}
