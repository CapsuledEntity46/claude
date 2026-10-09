/**
 * Weather state machine.
 *
 * Cycles between clear skies, ground fog, rain, and storms. Intensity is eased
 * rather than switched, so weather rolls in over several seconds instead of
 * appearing between two frames.
 */

export type WeatherKind = 'clear' | 'fog' | 'rain' | 'storm';

interface WeatherProfile {
  /** Relative chance of being chosen next. */
  weight: number;
  /** Seconds this weather lasts, before easing out. */
  minDuration: number;
  maxDuration: number;
  /** Falling drops per second at full intensity. */
  rainRate: number;
  /** How far the fog is pulled in at full intensity, 0..1. */
  fogTighten: number;
  /** How much the sky and sunlight are dimmed at full intensity, 0..1. */
  dim: number;
  label: string;
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear: { weight: 50, minDuration: 420, maxDuration: 900, rainRate: 0, fogTighten: 0, dim: 0, label: 'Clear' },
  fog: { weight: 18, minDuration: 240, maxDuration: 480, rainRate: 0, fogTighten: 0.68, dim: 0.18, label: 'Fog' },
  rain: { weight: 22, minDuration: 280, maxDuration: 560, rainRate: 1500, fogTighten: 0.42, dim: 0.4, label: 'Rain' },
  storm: { weight: 10, minDuration: 160, maxDuration: 320, rainRate: 2800, fogTighten: 0.62, dim: 0.68, label: 'Storm' },
};

/** Long, so weather rolls in and out rather than flickering between states. */
const TRANSITION_SECONDS = 14;

export class Weather {
  kind: WeatherKind = 'clear';
  /** Eased 0..1 strength of the current weather. */
  intensity = 0;

  private targetIntensity = 0;
  private remaining = 60;
  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  private get profile(): WeatherProfile {
    return PROFILES[this.kind];
  }

  update(dt: number): void {
    this.remaining -= dt;

    if (this.remaining <= 0) {
      if (this.targetIntensity > 0) {
        // Begin easing out; the kind itself does not change yet.
        this.targetIntensity = 0;
        this.remaining = TRANSITION_SECONDS;
      } else if (this.intensity > 0.02) {
        // Still fading. Switching kind now would snap rain straight into fog at
        // full strength, so wait for the fade to actually finish.
        this.remaining = 0.5;
      } else {
        this.pickNext();
      }
    }

    const rate = dt / TRANSITION_SECONDS;
    if (this.intensity < this.targetIntensity) {
      this.intensity = Math.min(this.targetIntensity, this.intensity + rate);
    } else if (this.intensity > this.targetIntensity) {
      this.intensity = Math.max(this.targetIntensity, this.intensity - rate);
    }
  }

  private pickNext(): void {
    const kinds = Object.keys(PROFILES) as WeatherKind[];
    // Never repeat the same weather twice in a row; it reads as nothing changing.
    const pool = kinds.filter((k) => k !== this.kind);
    const total = pool.reduce((sum, k) => sum + PROFILES[k].weight, 0);
    let roll = this.rng() * total;
    let chosen = pool[pool.length - 1];
    for (const k of pool) {
      roll -= PROFILES[k].weight;
      if (roll <= 0) {
        chosen = k;
        break;
      }
    }

    this.kind = chosen;
    const p = PROFILES[chosen];
    this.remaining = p.minDuration + this.rng() * (p.maxDuration - p.minDuration);
    this.targetIntensity = chosen === 'clear' ? 0 : 0.55 + this.rng() * 0.45;
  }

  /** Drops to spawn per second right now. */
  get rainRate(): number {
    return this.profile.rainRate * this.intensity;
  }

  get isRaining(): boolean {
    return this.rainRate > 1;
  }

  /** 0..1: how much closer to pull the fog plane. */
  get fogTighten(): number {
    return this.profile.fogTighten * this.intensity;
  }

  /** 0..1: how much to dim the sky and sunlight. */
  get dim(): number {
    return this.profile.dim * this.intensity;
  }

  label(): string {
    if (this.intensity < 0.08) return 'Clear';
    const strength = this.intensity > 0.8 ? 'Heavy ' : this.intensity < 0.4 ? 'Light ' : '';
    return `${strength}${this.profile.label}`;
  }

  /** Forces a specific weather immediately. Used by debug hooks and tests. */
  force(kind: WeatherKind, intensity = 1): void {
    this.kind = kind;
    this.intensity = kind === 'clear' ? 0 : intensity;
    this.targetIntensity = this.intensity;
    const p = PROFILES[kind];
    this.remaining = p.maxDuration;
  }
}
