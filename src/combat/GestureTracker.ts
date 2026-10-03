import type { AttackDirection } from './types';

/**
 * Mouse-gesture melee, as in Daggerfall and Ultima Underworld.
 *
 * Hold the attack button and move the mouse; the direction of the movement is the
 * attack. A flick left is a left slash, a shove up is an uppercut, a jab forward — or
 * no movement at all — is a thrust.
 *
 * Deliberately free of DOM and three.js imports. Everything here is arithmetic over
 * relative mouse deltas, which means the classifier can be unit-tested directly rather
 * than through a browser, and that is what makes the sector boundaries and the window
 * expiry worth asserting at all.
 *
 * ## Why relative deltas, and a rolling window
 *
 * Under pointer lock there is no cursor position to read — only per-frame movement. So
 * a gesture is the *sum* of recent deltas, and "recent" has to be bounded: without a
 * window, slowly dragging the mouse across a long fight would eventually accumulate
 * past the commit threshold and fire an attack the player never asked for. Samples
 * older than `sampleWindow` are discarded, so only a deliberate flick commits.
 */

export interface GestureConfig {
  /**
   * Movement below this (in accumulated, sensitivity-scaled units) is not a
   * direction at all. Releasing inside it is a thrust.
   */
  deadZone: number;
  /**
   * Movement at or beyond this fires the attack immediately, without waiting for the
   * button to come up. This is what makes the system feel responsive rather than
   * laggy — the blow lands while the player is still moving the mouse.
   */
  commitThreshold: number;
  /** Seconds of mouse movement that count towards the current gesture. */
  sampleWindow: number;
  /**
   * Extra degrees of stickiness around the stroke already chosen.
   *
   * Sectors are 45 degrees wide, so a swing aimed near a boundary wobbles across it
   * and the chosen attack flickers. Once a direction is latched it keeps it until the
   * gesture moves this much past the boundary.
   */
  sectorTolerance: number;
  /** Scales raw mouse deltas, so thresholds are independent of mouse DPI. */
  sensitivity: number;
}

/**
 * Defaults, tuned on a 1600 DPI mouse at the game's default look sensitivity.
 *
 * `commitThreshold` is the one to reach for first: lower it for hair-trigger attacks,
 * raise it if attacks fire while the player is only turning to look around.
 */
export const GESTURE_CONFIG: GestureConfig = {
  deadZone: 6,
  commitThreshold: 26,
  sampleWindow: 0.25,
  sectorTolerance: 8,
  sensitivity: 0.6,
};

/** Sector centres in degrees, y-up, matching `DIRECTION_VECTOR` in types.ts. */
const SECTORS: readonly { direction: AttackDirection; angle: number }[] = [
  { direction: 'right', angle: 0 },
  { direction: 'upRight', angle: 45 },
  { direction: 'up', angle: 90 },
  { direction: 'upLeft', angle: 135 },
  { direction: 'left', angle: 180 },
  { direction: 'downLeft', angle: -135 },
  { direction: 'down', angle: -90 },
  { direction: 'downRight', angle: -45 },
];

/** Half-width of a sector. Eight sectors over a full turn. */
const SECTOR_HALF_WIDTH = 22.5;

function angularDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Classifies an accumulated gesture vector into a stroke.
 *
 * @param x  accumulated horizontal movement, right positive
 * @param y  accumulated vertical movement, **up positive**
 * @param previous the stroke currently latched, if any, for hysteresis
 *
 * Returns `thrust` inside the dead zone: a jab forward and a bare click are the same
 * gesture, and both mean "straight at it".
 */
export function classifyGesture(
  x: number,
  y: number,
  config: GestureConfig = GESTURE_CONFIG,
  previous?: AttackDirection | null,
): AttackDirection {
  const magnitude = Math.hypot(x, y);
  if (magnitude < config.deadZone) return 'thrust';

  const angle = (Math.atan2(y, x) * 180) / Math.PI;

  let best = SECTORS[0];
  let bestDistance = Infinity;
  for (const sector of SECTORS) {
    const distance = angularDistance(angle, sector.angle);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sector;
    }
  }

  // Stickiness: keep the latched stroke unless the gesture has moved clearly past the
  // boundary. Without this a near-horizontal swing with a little vertical wobble
  // flickers between 'left' and 'upLeft' and the attack chosen is a coin toss.
  if (previous && previous !== 'thrust' && previous !== best.direction) {
    const previousSector = SECTORS.find((s) => s.direction === previous);
    if (previousSector && angularDistance(angle, previousSector.angle) <= SECTOR_HALF_WIDTH + config.sectorTolerance) {
      return previous;
    }
  }

  return best.direction;
}

interface Sample {
  x: number;
  y: number;
  /** Seconds since the gesture began. */
  at: number;
}

export interface GestureSnapshot {
  active: boolean;
  /** The stroke that would be chosen right now. */
  direction: AttackDirection;
  /** Accumulated magnitude in the current window. */
  magnitude: number;
  /** 0..1 towards `commitThreshold`, for the HUD indicator. */
  charge: number;
}

/**
 * Accumulates mouse movement while the attack button is held and reports the stroke.
 *
 * Lifecycle: `begin()` on button down, `sample()` every frame it stays down, and
 * either `sample()` returns a direction (the threshold was crossed) or `release()`
 * does (the button came up). Both commit exactly once; the caller resets afterwards.
 */
export class GestureTracker {
  private samples: Sample[] = [];
  private elapsed = 0;
  private capturing = false;
  private latched: AttackDirection | null = null;

  constructor(private readonly config: GestureConfig = GESTURE_CONFIG) {}

  get active(): boolean {
    return this.capturing;
  }

  begin(): void {
    this.samples = [];
    this.elapsed = 0;
    this.capturing = true;
    this.latched = null;
  }

  reset(): void {
    this.samples = [];
    this.elapsed = 0;
    this.capturing = false;
    this.latched = null;
  }

  /**
   * Feeds one frame of movement.
   *
   * @param dx raw horizontal mouse delta
   * @param dy raw vertical mouse delta, **y-down** as the browser reports it
   * @returns the stroke to perform if the gesture has committed, else null
   */
  sample(dx: number, dy: number, dt: number): AttackDirection | null {
    if (!this.capturing) return null;
    this.elapsed += dt;

    const scaled = this.config.sensitivity;
    // Flip y here, once, so everything downstream works y-up.
    this.samples.push({ x: dx * scaled, y: -dy * scaled, at: this.elapsed });
    this.expire();

    const { x, y } = this.sum();
    const magnitude = Math.hypot(x, y);
    this.latched = classifyGesture(x, y, this.config, this.latched);

    if (magnitude >= this.config.commitThreshold) {
      return this.latched === 'thrust' ? 'thrust' : this.latched;
    }
    return null;
  }

  /**
   * The button came up. Commits whatever the gesture amounts to.
   *
   * A release under the dead zone — a quick click, or a shove straight ahead — is a
   * thrust, which is what makes clicking still do something sensible.
   */
  release(): AttackDirection {
    if (!this.capturing) return 'thrust';
    const { x, y } = this.sum();
    return classifyGesture(x, y, this.config, this.latched);
  }

  /** What the HUD should draw right now. */
  snapshot(): GestureSnapshot {
    const { x, y } = this.sum();
    const magnitude = Math.hypot(x, y);
    return {
      active: this.capturing,
      direction: this.capturing ? classifyGesture(x, y, this.config, this.latched) : 'thrust',
      magnitude,
      charge: Math.min(1, magnitude / Math.max(0.0001, this.config.commitThreshold)),
    };
  }

  /** Drops samples that have fallen out of the rolling window. */
  private expire(): void {
    const cutoff = this.elapsed - this.config.sampleWindow;
    if (cutoff <= 0) return;
    let first = 0;
    while (first < this.samples.length && this.samples[first].at <= cutoff) first++;
    if (first > 0) this.samples.splice(0, first);
  }

  private sum(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const sample of this.samples) {
      x += sample.x;
      y += sample.y;
    }
    return { x, y };
  }
}
