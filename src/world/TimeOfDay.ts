import * as THREE from 'three';

/**
 * Day/night cycle.
 *
 * Drives sun direction, sky and fog colour, light intensity, star visibility,
 * and — importantly for pacing — how many enemies spawn and how far they can
 * see. Daylight is the safe window for building; night is when the world turns
 * on you.
 */

/** Seconds for a complete day. Long enough to build in, short enough to see both. */
export const DEFAULT_DAY_LENGTH = 1080;

const NIGHT_SKY = new THREE.Color(0x03050c);
const DAWN_SKY = new THREE.Color(0xd98a5a);
const DAY_SKY = new THREE.Color(0x8fb6d8);

const NIGHT_FOG = new THREE.Color(0x04060e);
const DAWN_FOG = new THREE.Color(0xc98a6a);
const DAY_FOG = new THREE.Color(0x9dc0dc);

const NIGHT_LIGHT = new THREE.Color(0x4a5c96);
const DAWN_LIGHT = new THREE.Color(0xffb070);
const DAY_LIGHT = new THREE.Color(0xfff2d8);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export type DayPhase = 'night' | 'dawn' | 'day' | 'dusk';

export class TimeOfDay {
  /** Position in the cycle: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  fraction: number;
  dayLength: number;
  /** Set false to hold time still. */
  running = true;

  private readonly sunDir = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();

  constructor(startFraction = 0.3, dayLength = DEFAULT_DAY_LENGTH) {
    this.fraction = startFraction;
    this.dayLength = dayLength;
  }

  update(dt: number): void {
    if (!this.running) return;
    this.fraction = (this.fraction + dt / this.dayLength) % 1;
  }

  /** Hours since midnight, 0..24. */
  get hours(): number {
    return this.fraction * 24;
  }

  /** Sine of the sun's elevation: 1 at noon, 0 at the horizon, -1 at midnight. */
  get sunAltitude(): number {
    return Math.sin((this.fraction - 0.25) * Math.PI * 2);
  }

  /**
   * How lit the world is, 0..1. Ramps across the horizon rather than snapping, so
   * dawn and dusk are real windows rather than instants.
   */
  get daylight(): number {
    return smoothstep(-0.12, 0.22, this.sunAltitude);
  }

  get isNight(): boolean {
    return this.daylight < 0.25;
  }

  get phase(): DayPhase {
    const alt = this.sunAltitude;
    if (alt < -0.12) return 'night';
    if (alt > 0.22) return 'day';
    // Rising or setting.
    return this.fraction < 0.5 ? 'dawn' : 'dusk';
  }

  /** Unit vector pointing from the world towards the sun. */
  sunDirection(): THREE.Vector3 {
    const angle = (this.fraction - 0.25) * Math.PI * 2;
    // A tilted arc, so the sun does not travel straight overhead.
    return this.sunDir.set(Math.cos(angle) * 0.55, Math.sin(angle), Math.cos(angle) * 0.8).normalize();
  }

  /**
   * The direction of the dominant light. At night this flips to the moon, so
   * surfaces are still shaped by light instead of going flat.
   */
  lightDirection(target: THREE.Vector3): THREE.Vector3 {
    target.copy(this.sunDirection());
    if (target.y < 0.02) target.negate().multiplyScalar(1).setY(Math.max(0.25, -target.y));
    return target.normalize();
  }

  /** Blends night -> dawn/dusk -> day for any of the three colour ramps. */
  private ramp(night: THREE.Color, twilight: THREE.Color, day: THREE.Color): THREE.Color {
    const alt = this.sunAltitude;
    // Twilight peaks as the sun crosses the horizon.
    const twilightWeight = 1 - Math.min(1, Math.abs(alt) / 0.3);
    const dayWeight = this.daylight;

    this.scratchColor.copy(night).lerp(day, dayWeight);
    if (twilightWeight > 0) this.scratchColor.lerp(twilight, twilightWeight * 0.75);
    return this.scratchColor;
  }

  skyColor(target: THREE.Color): THREE.Color {
    return target.copy(this.ramp(NIGHT_SKY, DAWN_SKY, DAY_SKY));
  }

  fogColor(target: THREE.Color): THREE.Color {
    return target.copy(this.ramp(NIGHT_FOG, DAWN_FOG, DAY_FOG));
  }

  lightColor(target: THREE.Color): THREE.Color {
    return target.copy(this.ramp(NIGHT_LIGHT, DAWN_LIGHT, DAY_LIGHT));
  }

  /** Directional light strength. Moonlight is dim but not zero. */
  get sunIntensity(): number {
    return 0.1 + this.daylight * 1.12;
  }

  get ambientIntensity(): number {
    // A low floor keeps night genuinely dark — dark enough that a torch matters —
    // while still leaving shapes readable enough to navigate.
    return 0.07 + this.daylight * 0.53;
  }

  get hemisphereIntensity(): number {
    return 0.06 + this.daylight * 0.64;
  }

  /** Star opacity: fully visible at night, gone by mid-morning. */
  get starOpacity(): number {
    return 1 - smoothstep(-0.1, 0.14, this.sunAltitude);
  }

  /** 24-hour clock label, e.g. "07:42". */
  clockLabel(): string {
    const total = this.hours;
    const h = Math.floor(total);
    const m = Math.floor((total - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  phaseLabel(): string {
    switch (this.phase) {
      case 'dawn':
        return 'Dawn';
      case 'day':
        return 'Day';
      case 'dusk':
        return 'Dusk';
      default:
        return 'Night';
    }
  }

  /** Jumps to a named time. Used by the debug hooks and the tests. */
  setPhase(phase: DayPhase): void {
    this.fraction = phase === 'day' ? 0.5 : phase === 'night' ? 0.0 : phase === 'dawn' ? 0.25 : 0.75;
  }
}
