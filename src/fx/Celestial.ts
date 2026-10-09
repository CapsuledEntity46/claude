import * as THREE from 'three';

/**
 * The sun and the moon.
 *
 * Both ride a shell re-centred on the camera every frame, like the starfield, so
 * they read as infinitely distant rather than as objects you could walk up to.
 * The shell sits outside the render distance but inside the far plane, which means
 * terrain still occludes them — the sun genuinely sets behind a hill.
 *
 * Their materials opt out of fog. Everything else in the world is fogged by
 * distance, and at this radius that would wash both discs into the haze and leave
 * the sky empty, which defeats the point of drawing them.
 */

const SHELL_RADIUS = 360;
/** Angular size, as a radius on the shell. Generous: a pinprick sun reads as a bug. */
const SUN_RADIUS = 15;
const MOON_RADIUS = 11;

/** Below this altitude a body is under the horizon and hidden. */
const HORIZON = -0.09;

const SUN_HIGH = new THREE.Color(0xfff6d8);
const SUN_LOW = new THREE.Color(0xff7d3a);
const GLOW_HIGH = new THREE.Color(0xffe9a8);
const GLOW_LOW = new THREE.Color(0xff6a2a);

/**
 * A flat disc facing +Z.
 *
 * Always `transparent`, even at full opacity. Toggling `transparent` later forces a
 * shader recompile and needs `needsUpdate`, and the moon dims every frame as the
 * sky brightens — far simpler to start transparent and never switch.
 */
function disc(
  radius: number,
  segments: number,
  color: THREE.ColorRepresentation,
  opacity = 1,
): THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    // See the class comment: fogged, these vanish.
    fog: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(new THREE.CircleGeometry(radius, segments), material);
}

export class Celestial {
  readonly group = new THREE.Group();

  private readonly sun = new THREE.Group();
  private readonly moon = new THREE.Group();
  private readonly sunDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly sunGlow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly moonDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  /** Every moon material, with the opacity it should show at full night. */
  private readonly moonMaterials: Array<{ material: THREE.MeshBasicMaterial; base: number }> = [];

  private readonly scratch = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();

  constructor() {
    // --- sun: a hard disc inside a soft corona ---------------------------------
    this.sunGlow = disc(SUN_RADIUS * 2.6, 20, GLOW_HIGH, 0.22);
    this.sunGlow.material.blending = THREE.AdditiveBlending;
    this.sunDisc = disc(SUN_RADIUS, 18, SUN_HIGH);
    // Draw the corona first so the disc sits on top of it.
    this.sunGlow.renderOrder = -3;
    this.sunDisc.renderOrder = -2;
    this.sun.add(this.sunGlow, this.sunDisc);

    // --- moon: a pale disc with craters ---------------------------------------
    this.moonDisc = disc(MOON_RADIUS, 16, 0xdfe4ee);
    this.moonDisc.renderOrder = -2;
    this.moon.add(this.moonDisc);
    this.moonMaterials.push({ material: this.moonDisc.material, base: 1 });
    // Craters, as flat darker discs a hair in front so they always read.
    const craters: Array<[number, number, number]> = [
      [-0.3, 0.26, 0.3],
      [0.34, 0.1, 0.22],
      [-0.06, -0.38, 0.26],
      [0.16, 0.44, 0.14],
    ];
    for (const [cx, cy, size] of craters) {
      const crater = disc(MOON_RADIUS * size, 10, 0xb3bccd);
      crater.position.set(cx * MOON_RADIUS, cy * MOON_RADIUS, 0.4);
      crater.renderOrder = -1;
      this.moon.add(crater);
      this.moonMaterials.push({ material: crater.material, base: 1 });
    }
    const halo = disc(MOON_RADIUS * 2.1, 18, 0x9fb4d8, 0.12);
    halo.material.blending = THREE.AdditiveBlending;
    halo.renderOrder = -3;
    this.moon.add(halo);
    this.moonMaterials.push({ material: halo.material, base: 0.12 });

    this.group.add(this.sun, this.moon);
    this.group.name = 'celestial';
    // These are always far away; culling them per-frame costs more than it saves.
    this.group.frustumCulled = false;
  }

  /**
   * @param sunDirection unit vector from the world towards the sun
   * @param daylight 0 at night, 1 at noon
   */
  update(cameraPosition: THREE.Vector3, sunDirection: THREE.Vector3, daylight: number): void {
    this.group.position.copy(cameraPosition);

    // --- sun ------------------------------------------------------------------
    const sunAltitude = sunDirection.y;
    this.sun.visible = sunAltitude > HORIZON;
    if (this.sun.visible) {
      this.sun.position.copy(this.scratch.copy(sunDirection).multiplyScalar(SHELL_RADIUS));
      this.sun.lookAt(cameraPosition);

      // Redden towards the horizon. `altitude` is the sine of the elevation, so
      // this is a smooth ramp over roughly the last 20 degrees of the descent.
      const low = 1 - THREE.MathUtils.clamp(sunAltitude / 0.34, 0, 1);
      this.sunDisc.material.color.copy(this.scratchColor.copy(SUN_HIGH).lerp(SUN_LOW, low));
      const glowMaterial = this.sunGlow.material;
      glowMaterial.color.copy(this.scratchColor.copy(GLOW_HIGH).lerp(GLOW_LOW, low));
      // The corona swells and reddens at sunrise and sunset, which is most of what
      // sells a low sun.
      glowMaterial.opacity = 0.16 + low * 0.3;
      this.sunGlow.scale.setScalar(1 + low * 0.55);
    }

    // --- moon -----------------------------------------------------------------
    // Directly opposite the sun, so the two are never up together at full height
    // and the sky always has one of them in it.
    const moonDirection = this.scratch.copy(sunDirection).negate();
    this.moon.visible = moonDirection.y > HORIZON;
    if (this.moon.visible) {
      this.moon.position.copy(moonDirection.multiplyScalar(SHELL_RADIUS));
      this.moon.lookAt(cameraPosition);
      // Fade out as the sky brightens rather than vanishing at a threshold: a moon
      // still faintly visible after dawn looks right, a moon that blinks out does not.
      const fade = 1 - THREE.MathUtils.clamp((daylight - 0.35) / 0.5, 0, 1);
      for (const { material, base } of this.moonMaterials) material.opacity = base * fade;
      this.moon.visible = fade > 0.02;
    }
  }

  /** Sun and moon visibility and screen-space size, for tests. */
  debugState(): Record<string, unknown> {
    return {
      sunVisible: this.sun.visible,
      moonVisible: this.moon.visible,
      sunAltitude: Number(this.sun.position.y.toFixed(1)),
      moonAltitude: Number(this.moon.position.y.toFixed(1)),
      sunColor: `#${this.sunDisc.material.color.getHexString()}`,
      moonOpacity: Number(this.moonDisc.material.opacity.toFixed(2)),
    };
  }
}
