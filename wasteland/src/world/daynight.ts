import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math';
import { RNG } from '../core/rng';
import { Biome, BIOME_TEMP } from './tiles';

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog';

interface WeatherProfile {
  /** 0 = no cloud darkening, 1 = pitch black overcast. */
  darkness: number;
  rain: number;
  fog: number;
  windBase: number;
  tempOffset: number;
  /** Relative chance of transitioning into this weather. */
  weight: number;
}

const WEATHER: Record<WeatherKind, WeatherProfile> = {
  clear:    { darkness: 0.0,  rain: 0,    fog: 0.0,  windBase: 0.15, tempOffset: 1,   weight: 40 },
  overcast: { darkness: 0.22, rain: 0,    fog: 0.12, windBase: 0.35, tempOffset: -2,  weight: 25 },
  rain:     { darkness: 0.4,  rain: 0.75, fog: 0.25, windBase: 0.55, tempOffset: -6,  weight: 18 },
  storm:    { darkness: 0.58, rain: 1,    fog: 0.3,  windBase: 0.9,  tempOffset: -9,  weight: 7 },
  fog:      { darkness: 0.28, rain: 0,    fog: 0.85, windBase: 0.1,  tempOffset: -3,  weight: 10 },
};

/**
 * Drives the clock, lighting, weather and ambient temperature.
 *
 * Night is the core pressure valve of the game: zombies get faster and more
 * numerous, visibility collapses, and the cold starts eating your health if
 * you're not dressed or near a fire.
 */
export class DayNight {
  /** Seconds of real time for one full in-game day. */
  readonly dayLength: number;
  /** Elapsed world time in seconds. */
  time: number;
  day = 1;

  weather: WeatherKind = 'clear';
  private nextWeatherChange: number;
  /** Eased 0..1 blend between the previous and current weather profile. */
  private weatherBlend = 1;
  private prevWeather: WeatherKind = 'clear';

  windAngle: number;
  windStrength = 0.2;
  private windTarget = 0.2;

  /** Set briefly when lightning fires, for the render flash. */
  lightningFlash = 0;
  private nextLightning = 6;

  private rng: RNG;

  constructor(seed: number, dayLength = 1500, startHour = 7) {
    this.rng = new RNG(seed ^ 0x5eed);
    this.dayLength = dayLength;
    this.time = (startHour / 24) * dayLength;
    this.nextWeatherChange = this.rng.float(120, 300);
    this.windAngle = this.rng.angle();
  }

  /** Hour of day in [0,24). */
  get hour(): number {
    return ((this.time % this.dayLength) / this.dayLength) * 24;
  }

  get clockString(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * Darkness from 0 (high noon) to 1 (dead of night).
   * Dawn ~5-7, dusk ~19-21.
   */
  get darkness(): number {
    const h = this.hour;
    let d: number;
    if (h < 4.5) d = 1;
    else if (h < 7) d = 1 - smoothstep((h - 4.5) / 2.5);
    else if (h < 18.5) d = 0;
    else if (h < 21) d = smoothstep((h - 18.5) / 2.5);
    else d = 1;
    return clamp01(d);
  }

  get isNight(): boolean { return this.darkness > 0.55; }

  /** Sun/moon direction, used to cast entity shadows. */
  get lightAngle(): number {
    return (this.hour / 24) * TAU + Math.PI * 0.5;
  }

  /** Moon phase 0..1, modulates how bright the night is. */
  get moonPhase(): number {
    return (this.day % 12) / 12;
  }

  get moonBrightness(): number {
    // Full moon at phase 0.5, new moon at 0/1.
    return 0.25 + 0.75 * Math.sin(this.moonPhase * Math.PI);
  }

  private profile(kind: WeatherKind): WeatherProfile { return WEATHER[kind]; }

  /** Interpolated weather value accessor. */
  private w<K extends keyof WeatherProfile>(key: K): number {
    return lerp(this.profile(this.prevWeather)[key], this.profile(this.weather)[key], this.weatherBlend);
  }

  get cloudDarkness(): number { return this.w('darkness'); }
  get rainIntensity(): number { return this.w('rain'); }
  get fogIntensity(): number { return this.w('fog'); }

  /** Overall scene light level: 1 = bright daylight, ~0.06 = moonless night. */
  get lightLevel(): number {
    const dayLight = 1 - this.darkness * 0.94;
    const night = this.darkness * 0.075 * this.moonBrightness;
    return clamp(dayLight * (1 - this.cloudDarkness * 0.55) + night, 0.045, 1);
  }

  /**
   * Ambient temperature in degrees C for a position's biome.
   * Coldest just before dawn, warmest mid-afternoon.
   */
  ambientTemp(biome: Biome, indoor: boolean): number {
    const h = this.hour;
    // Peak at 15:00, trough at 04:00.
    const diurnal = Math.cos(((h - 15) / 24) * TAU);
    const base = 14 + diurnal * 11;
    let t = base + BIOME_TEMP[biome] + this.w('tempOffset');
    if (indoor) t = lerp(t, 17, 0.6); // shelter dampens extremes
    return t;
  }

  update(dt: number): void {
    const prevHour = this.hour;
    this.time += dt;
    if (this.hour < prevHour) this.day++;

    // --- weather state machine ---
    this.nextWeatherChange -= dt;
    if (this.weatherBlend < 1) this.weatherBlend = clamp01(this.weatherBlend + dt / 12);
    if (this.nextWeatherChange <= 0) {
      const kinds = Object.keys(WEATHER) as WeatherKind[];
      const options = kinds.filter((k) => k !== this.weather);
      const next = this.rng.weighted(options, (k) => WEATHER[k].weight);
      this.prevWeather = this.weather;
      this.weather = next;
      this.weatherBlend = 0;
      this.nextWeatherChange = this.rng.float(150, 420);
      this.windTarget = WEATHER[next].windBase + this.rng.float(-0.1, 0.2);
    }

    // --- wind drifts slowly, gusts occasionally ---
    this.windAngle += Math.sin(this.time * 0.07) * dt * 0.25;
    this.windStrength += (this.windTarget - this.windStrength) * dt * 0.4;

    // --- lightning during storms ---
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 4);
    if (this.weather === 'storm') {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.lightningFlash = 1;
        this.nextLightning = this.rng.float(4, 16);
      }
    }
  }

  /** Multiplier on how aggressive/fast zombies are. Peaks deep in the night. */
  get zombieAggression(): number {
    return 1 + this.darkness * 0.75 + Math.min(this.day - 1, 12) * 0.045;
  }

  /** Scales how many zombies the world tries to keep alive. */
  get spawnPressure(): number {
    return 1 + this.darkness * 1.1 + Math.min(this.day - 1, 15) * 0.07;
  }

  serialize() {
    return {
      time: this.time, day: this.day, weather: this.weather,
      nextWeatherChange: this.nextWeatherChange, windAngle: this.windAngle,
    };
  }

  load(d: ReturnType<DayNight['serialize']>): void {
    this.time = d.time;
    this.day = d.day;
    this.weather = d.weather;
    this.prevWeather = d.weather;
    this.weatherBlend = 1;
    this.nextWeatherChange = d.nextWeatherChange;
    this.windAngle = d.windAngle;
  }
}
