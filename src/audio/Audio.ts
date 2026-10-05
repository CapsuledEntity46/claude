import * as THREE from 'three';

/**
 * Procedural sound.
 *
 * Every sound in the game is **synthesised in code** from oscillators and filtered
 * noise. No audio files, for the same reason there are no model files: a sample you
 * can only change in an editor cannot be tuned against the game, and a voxel world
 * that streams its terrain should not also be waiting on a megabyte of wav.
 *
 * The palette is deliberately small — noise through a sweeping filter, a few
 * detuned partials, a pitch envelope — because that is what the material is. A
 * sword stroke is air (filtered noise, band moving up then down); a hit on mail is
 * inharmonic metal (partials at non-integer ratios); a hit on a body is a thud (low
 * sine, fast decay) with a slap of noise on the front.
 *
 * Three decisions worth knowing:
 *
 * - **Nothing is created until the player clicks Play.** A browser refuses to start
 *   an `AudioContext` without a user gesture, and one created too early lands in
 *   `suspended` and stays there silently. `resume()` is called from the same click
 *   handler that locks the pointer.
 *
 * - **Play counts are recorded whether or not anything is audible.** Headless
 *   Chromium may have no audio device at all, so the counters are maintained
 *   independently of the graph. That is what lets the smoke suite assert that
 *   swinging a sword makes a noise, which is otherwise the least testable kind of
 *   feature there is.
 *
 * - **Positional, but cheaply.** Distance attenuation and a stereo pan computed
 *   from the camera's right vector, rather than a `PannerNode` per voice with HRTF
 *   convolution. In a first-person game the useful information is "how far" and
 *   "which side", and that is two multiplies.
 */

/** Everything that can make a noise. */
export type SoundId =
  // melee
  | 'swing'
  | 'thrust'
  | 'hitFlesh'
  | 'hitArmour'
  | 'block'
  | 'guardBreak'
  // world
  | 'dig'
  | 'breakBlock'
  | 'place'
  | 'jump'
  | 'doorOpen'
  // player
  | 'hurt'
  | 'death'
  | 'levelUp'
  | 'drink'
  | 'eat'
  // enemies
  | 'enemyAggro'
  | 'enemyAttack'
  | 'enemyHurt'
  | 'enemyDeath'
  // ranged
  | 'bowDraw'
  | 'bowLoose'
  | 'gunshot'
  | 'reload'
  | 'crossbow'
  | 'arrowHit'
  // explosives and magic
  | 'grenadeThrow'
  | 'bounce'
  | 'explosion'
  | 'castFire'
  | 'castSpark'
  | 'castHeal'
  | 'castBolt'
  // pickups and ui
  | 'orbXp'
  | 'orbMana'
  | 'orbGold'
  | 'pickup'
  | 'uiSelect'
  | 'uiOpen'
  | 'uiClose'
  | 'uiEquip'
  | 'uiDrop'
  | 'uiSpend'
  | 'uiRespec'
  | 'uiDeny'
  // weather
  | 'thunder';

export interface PlayOptions {
  /** World position. Omit for a sound that happens to the player themselves. */
  position?: THREE.Vector3;
  /** Linear gain multiplier, before distance. */
  volume?: number;
  /** Playback-rate style multiplier on every frequency in the sound. */
  pitch?: number;
}

/**
 * Minimum seconds between two plays of the same sound.
 *
 * Several events fire per frame in bursts — a blunderbuss spawns a projectile per
 * pellet, a mining tick repeats at the frame rate, three orbs land together. Without
 * a floor these phase-align into a buzz that is both unpleasant and much louder than
 * any single one, because correlated signals sum linearly while uncorrelated ones
 * sum as the square root.
 */
const RETRIGGER: Partial<Record<SoundId, number>> = {
  dig: 0.11,
  orbXp: 0.05,
  orbMana: 0.05,
  orbGold: 0.05,
  bounce: 0.08,
  hitFlesh: 0.04,
  hitArmour: 0.04,
  enemyHurt: 0.05,
};

/** Beyond this many blocks a sound is not scheduled at all. */
const MAX_DISTANCE = 54;
/** Distance at which a sound is at half power. */
const REFERENCE_DISTANCE = 7;

/** Concurrent voice ceiling. Past this, new sounds are dropped rather than queued. */
const MAX_VOICES = 24;

const STORAGE_KEY = 'voxelquest.audio';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  /** Shared white-noise buffer. Generating one per voice is most of the cost. */
  private noiseBuffer: AudioBuffer | null = null;

  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);

  private voices = 0;
  private lastPlayed = new Map<SoundId, number>();
  private elapsed = 0;

  /** Per-sound play counts. Maintained even with no audio device — see the header. */
  readonly counts = new Map<SoundId, number>();
  private totalPlays = 0;

  private volume = 0.7;
  private muted = false;
  private started = false;

  /** Ambient beds, keyed by name, each a looping noise voice with its own gain. */
  private beds = new Map<string, { gain: GainNode; filter: BiquadFilterNode; source: AudioBufferSourceNode }>();

  constructor() {
    this.loadPreferences();
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Starts or resumes audio. Safe to call repeatedly; must be called from a user
   * gesture the first time.
   */
  resume(): void {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined =
          typeof AudioContext !== 'undefined'
            ? AudioContext
            : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();

        // A limiter on the master bus, because this is a game with explosions in
        // it: a gunshot landing on the same frame as three orb pickups and a
        // thunderclap will clip a bare gain node, and clipping on a square-ish
        // synth sounds like a fault rather than like loudness.
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -8;
        this.limiter.knee.value = 6;
        this.limiter.ratio.value = 12;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.2;

        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;

        this.master.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);

        this.noiseBuffer = this.makeNoise(2);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this.started = true;
    } catch {
      // An unavailable audio device must never stop the game starting. Counters
      // keep working, so tests and diagnostics still see the calls.
      this.ctx = null;
    }
  }

  /** True once a context exists and is running. */
  get active(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get masterVolume(): number {
    return this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    this.savePreferences();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    this.savePreferences();
    return this.muted;
  }

  private loadPreferences(): void {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { volume?: number; muted?: boolean };
      if (typeof parsed.volume === 'number') this.volume = Math.max(0, Math.min(1, parsed.volume));
      if (typeof parsed.muted === 'boolean') this.muted = parsed.muted;
    } catch {
      // Corrupt or unavailable storage just means defaults.
    }
  }

  private savePreferences(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {
      // Private browsing and quota failures are not worth surfacing.
    }
  }

  // --------------------------------------------------------------- listener

  /** Where the ears are. Called once a frame from the game loop. */
  setListener(position: THREE.Vector3, right: THREE.Vector3): void {
    this.listenerPos.copy(position);
    this.listenerRight.copy(right);
  }

  /** Advances retrigger timers. Independent of the audio clock so it works muted. */
  update(dt: number): void {
    this.elapsed += dt;
  }

  // ------------------------------------------------------------------ play

  play(id: SoundId, options: PlayOptions = {}): void {
    const gap = RETRIGGER[id];
    if (gap !== undefined) {
      const last = this.lastPlayed.get(id);
      if (last !== undefined && this.elapsed - last < gap) return;
    }

    let gain = options.volume ?? 1;
    let pan = 0;

    if (options.position) {
      const dx = options.position.x - this.listenerPos.x;
      const dy = options.position.y - this.listenerPos.y;
      const dz = options.position.z - this.listenerPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > MAX_DISTANCE) return;
      // Inverse-square-ish, which is both physical and self-limiting: there is no
      // distance at which a sound is suddenly cut off, so nothing pops.
      const fall = REFERENCE_DISTANCE / (REFERENCE_DISTANCE + distance);
      gain *= fall * fall * 2;
      if (distance > 0.3) {
        pan = Math.max(-1, Math.min(1, (dx * this.listenerRight.x + dz * this.listenerRight.z) / distance));
      }
    }

    // Counted before any of the audio graph is touched, so a machine with no audio
    // device still reports what the game asked for.
    this.lastPlayed.set(id, this.elapsed);
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    this.totalPlays++;

    if (!this.ctx || !this.master || this.muted || gain < 0.002) return;
    if (this.voices >= MAX_VOICES) return;

    try {
      this.render(id, gain, pan, options.pitch ?? 1);
    } catch {
      // A failed voice should cost that one sound, not the frame.
    }
  }

  // --------------------------------------------------------------- ambience

  /**
   * Sets the level of a looping ambient bed, creating it on first use.
   *
   * Rain and lava are continuous and nearly stationary, so they are a filtered
   * noise loop whose gain is driven by the weather rather than a stream of
   * one-shots — a thousand raindrop voices a second would exhaust the voice budget
   * and still sound worse than the noise they would be approximating.
   */
  setAmbient(name: 'rain' | 'lava' | 'wind', level: number, frequency = 900, q = 0.7): void {
    const target = Math.max(0, Math.min(1, level));
    if (!this.ctx || !this.master || !this.noiseBuffer) return;

    let bed = this.beds.get(name);
    if (!bed) {
      if (target <= 0.001) return;
      const source = this.ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start();
      bed = { gain, filter, source };
      this.beds.set(name, bed);
    }
    // Ramped rather than set: weather changes over seconds, and a step change in a
    // noise bed's gain is audible as a click.
    bed.filter.frequency.setTargetAtTime(frequency, this.ctx.currentTime, 0.4);
    bed.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.5);
  }

  /** Silences every ambient bed, for the pause menu and death. */
  clearAmbience(): void {
    if (!this.ctx) return;
    for (const bed of this.beds.values()) bed.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  // ------------------------------------------------------------ diagnostics

  debugState(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const [id, n] of this.counts) counts[id] = n;
    return {
      started: this.started,
      active: this.active,
      state: this.ctx?.state ?? 'none',
      muted: this.muted,
      volume: Number(this.volume.toFixed(2)),
      voices: this.voices,
      totalPlays: this.totalPlays,
      distinct: this.counts.size,
      counts,
    };
  }

  // ------------------------------------------------------------- synthesis

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic, so a given sound is identical run to run and a recording of
    // the game can be compared against another.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0x80000000 - 1) * 0.9;
    }
    return buffer;
  }

  /** Allocates the per-voice output chain: gain → pan → master. */
  private voiceOut(gain: number, pan: number, duration: number): GainNode {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner);
    panner.connect(this.master!);

    this.voices++;
    // Voices are counted down by a timer rather than by an `onended` handler on one
    // node: a sound is several nodes, they do not all finish together, and the
    // budget is about how many are *in flight*.
    globalThis.setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
      try {
        panner.disconnect();
        out.disconnect();
      } catch {
        // Already torn down.
      }
    }, (duration + 0.15) * 1000);
    return out;
  }

  /** A filtered burst of the shared noise buffer. The workhorse. */
  private burst(
    out: GainNode,
    opts: {
      duration: number;
      type?: BiquadFilterType;
      from: number;
      to?: number;
      q?: number;
      attack?: number;
      curve?: number;
    },
  ): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const { duration, from, to = from, q = 1, attack = 0.004, curve = 1 } = opts;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    // Random offset into the shared buffer, so repeated bursts are not identical.
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.setValueAtTime(from, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), now + duration);
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + attack);
    // A power curve on the decay: 1 is exponential-ish, higher is snappier.
    env.gain.setTargetAtTime(0, now + attack, (duration / 3) * curve);

    source.connect(filter);
    filter.connect(env);
    env.connect(out);
    source.start(now, Math.random() * 1.5);
    source.stop(now + duration + 0.05);
  }

  /** A pitched partial with an exponential pitch and amplitude envelope. */
  private tone(
    out: GainNode,
    opts: {
      duration: number;
      from: number;
      to?: number;
      type?: OscillatorType;
      gain?: number;
      attack?: number;
      delay?: number;
    },
  ): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime + (opts.delay ?? 0);
    const { duration, from, to = from, type = 'sine', gain = 1, attack = 0.005 } = opts;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, now);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.setTargetAtTime(0, now + attack, duration / 3);

    osc.connect(env);
    env.connect(out);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /**
   * Builds one sound.
   *
   * Grouped by material rather than by game event, because that is what decides how
   * a thing sounds: several events share a body and differ only in pitch and level.
   */
  private render(id: SoundId, gain: number, pan: number, pitch: number): void {
    const p = pitch;
    const o = (duration: number, g = gain) => this.voiceOut(g, pan, duration);

    switch (id) {
      // --- melee: air, then material -------------------------------------
      case 'swing': {
        // Air over an edge: a band sweeping up and away. The sweep is the whole
        // effect — a static band reads as a hiss, not a movement.
        const out = o(0.26, gain * 0.5);
        this.burst(out, { duration: 0.24, from: 520 * p, to: 1500 * p, q: 0.9 });
        this.burst(out, { duration: 0.2, from: 180 * p, to: 520 * p, q: 1.6 });
        break;
      }
      case 'thrust': {
        const out = o(0.2, gain * 0.45);
        this.burst(out, { duration: 0.18, from: 900 * p, to: 2300 * p, q: 1.8, attack: 0.002 });
        break;
      }
      case 'hitFlesh': {
        const out = o(0.26, gain * 0.9);
        this.tone(out, { duration: 0.16, from: 170 * p, to: 62 * p, type: 'sine', gain: 0.9 });
        this.burst(out, { duration: 0.1, from: 420 * p, to: 160 * p, q: 0.8, curve: 0.6 });
        break;
      }
      case 'hitArmour': {
        // Inharmonic partials: steel rings at ratios that are not whole numbers,
        // which is exactly what separates a bell from a plate being struck.
        const out = o(0.5, gain * 0.8);
        this.tone(out, { duration: 0.42, from: 1870 * p, type: 'triangle', gain: 0.35 });
        this.tone(out, { duration: 0.34, from: 2630 * p, type: 'triangle', gain: 0.24 });
        this.tone(out, { duration: 0.28, from: 3510 * p, type: 'sine', gain: 0.16 });
        this.tone(out, { duration: 0.12, from: 240 * p, to: 110 * p, type: 'sine', gain: 0.7 });
        this.burst(out, { duration: 0.07, from: 3200 * p, to: 1400 * p, q: 0.6, curve: 0.5 });
        break;
      }
      case 'block': {
        const out = o(0.3, gain * 0.85);
        this.tone(out, { duration: 0.1, from: 300 * p, to: 130 * p, type: 'square', gain: 0.4 });
        this.burst(out, { duration: 0.16, from: 700 * p, to: 260 * p, q: 0.7 });
        break;
      }
      case 'guardBreak': {
        const out = o(0.6, gain);
        this.tone(out, { duration: 0.5, from: 420 * p, to: 90 * p, type: 'sawtooth', gain: 0.5 });
        this.burst(out, { duration: 0.4, from: 1800 * p, to: 300 * p, q: 0.5 });
        break;
      }

      // --- world ----------------------------------------------------------
      case 'dig': {
        const out = o(0.14, gain * 0.5);
        this.burst(out, { duration: 0.1, from: 760 * p, to: 300 * p, q: 1.2, curve: 0.6 });
        break;
      }
      case 'breakBlock': {
        const out = o(0.34, gain * 0.8);
        this.burst(out, { duration: 0.28, from: 1300 * p, to: 240 * p, q: 0.8 });
        this.tone(out, { duration: 0.14, from: 150 * p, to: 70 * p, type: 'sine', gain: 0.5 });
        break;
      }
      case 'place': {
        const out = o(0.18, gain * 0.6);
        this.tone(out, { duration: 0.1, from: 220 * p, to: 120 * p, type: 'sine', gain: 0.7 });
        this.burst(out, { duration: 0.1, from: 900 * p, to: 420 * p, q: 1, curve: 0.5 });
        break;
      }
      case 'jump': {
        const out = o(0.16, gain * 0.35);
        this.burst(out, { duration: 0.13, from: 320 * p, to: 680 * p, q: 1.1 });
        break;
      }
      case 'doorOpen': {
        const out = o(0.5, gain * 0.6);
        this.burst(out, { duration: 0.45, from: 300 * p, to: 820 * p, q: 5 });
        break;
      }

      // --- player ---------------------------------------------------------
      case 'hurt': {
        const out = o(0.34, gain * 0.9);
        this.tone(out, { duration: 0.28, from: 290 * p, to: 150 * p, type: 'sawtooth', gain: 0.45 });
        this.burst(out, { duration: 0.16, from: 900 * p, to: 380 * p, q: 1.1 });
        break;
      }
      case 'death': {
        const out = o(1.3, gain);
        this.tone(out, { duration: 1.2, from: 260 * p, to: 48 * p, type: 'sawtooth', gain: 0.5 });
        this.tone(out, { duration: 0.9, from: 130 * p, to: 36 * p, type: 'sine', gain: 0.4 });
        break;
      }
      case 'levelUp': {
        // A rising major triad. The only melodic sound in the game, which is what
        // makes it read as a reward rather than as another event.
        const out = o(0.9, gain * 0.55);
        this.tone(out, { duration: 0.3, from: 523 * p, type: 'triangle', gain: 0.5, delay: 0 });
        this.tone(out, { duration: 0.3, from: 659 * p, type: 'triangle', gain: 0.5, delay: 0.1 });
        this.tone(out, { duration: 0.5, from: 784 * p, type: 'triangle', gain: 0.55, delay: 0.2 });
        this.tone(out, { duration: 0.6, from: 1046 * p, type: 'sine', gain: 0.4, delay: 0.3 });
        break;
      }
      case 'drink': {
        const out = o(0.5, gain * 0.6);
        for (let i = 0; i < 3; i++) {
          this.tone(out, { duration: 0.1, from: (380 + i * 90) * p, to: (260 + i * 70) * p, type: 'sine', gain: 0.5, delay: i * 0.13 });
        }
        break;
      }
      case 'eat': {
        const out = o(0.4, gain * 0.5);
        for (let i = 0; i < 3; i++) {
          this.burst(out, { duration: 0.1, from: 1100 * p, to: 420 * p, q: 1.4, curve: 0.5 });
        }
        break;
      }

      // --- enemies --------------------------------------------------------
      case 'enemyAggro': {
        // Growl: a low sawtooth with its pitch wandering, through a lowpass.
        const out = o(0.65, gain * 0.7);
        this.tone(out, { duration: 0.6, from: 140 * p, to: 96 * p, type: 'sawtooth', gain: 0.5 });
        this.tone(out, { duration: 0.5, from: 73 * p, to: 58 * p, type: 'square', gain: 0.3 });
        this.burst(out, { duration: 0.5, type: 'lowpass', from: 700 * p, to: 300 * p, q: 0.6 });
        break;
      }
      case 'enemyAttack': {
        const out = o(0.3, gain * 0.55);
        this.tone(out, { duration: 0.26, from: 230 * p, to: 330 * p, type: 'sawtooth', gain: 0.35 });
        this.burst(out, { duration: 0.22, from: 420 * p, to: 1100 * p, q: 1.2 });
        break;
      }
      case 'enemyHurt': {
        const out = o(0.3, gain * 0.7);
        this.tone(out, { duration: 0.24, from: 330 * p, to: 180 * p, type: 'sawtooth', gain: 0.45 });
        this.burst(out, { duration: 0.12, from: 800 * p, to: 300 * p, q: 1 });
        break;
      }
      case 'enemyDeath': {
        const out = o(0.7, gain * 0.8);
        this.tone(out, { duration: 0.6, from: 300 * p, to: 70 * p, type: 'sawtooth', gain: 0.45 });
        // The shatter: a bright noise tail, to match the pixel burst on screen.
        this.burst(out, { duration: 0.5, from: 2400 * p, to: 400 * p, q: 0.5 });
        break;
      }

      // --- ranged ---------------------------------------------------------
      case 'bowDraw': {
        const out = o(0.6, gain * 0.5);
        this.burst(out, { duration: 0.55, from: 260 * p, to: 700 * p, q: 6 });
        break;
      }
      case 'bowLoose': {
        const out = o(0.34, gain * 0.8);
        this.tone(out, { duration: 0.1, from: 420 * p, to: 180 * p, type: 'triangle', gain: 0.5 });
        this.burst(out, { duration: 0.3, from: 1800 * p, to: 600 * p, q: 0.8 });
        break;
      }
      case 'gunshot': {
        // Black powder: a crack, a body, and a tail. Loud on purpose — the README
        // promises it pulls every enemy within 46 blocks onto you.
        const out = o(1.1, gain);
        this.burst(out, { duration: 0.1, from: 5200 * p, to: 1800 * p, q: 0.4, attack: 0.001, curve: 0.4 });
        this.burst(out, { duration: 0.9, type: 'lowpass', from: 1400 * p, to: 120 * p, q: 0.7 });
        this.tone(out, { duration: 0.3, from: 160 * p, to: 42 * p, type: 'square', gain: 0.6 });
        break;
      }
      case 'reload': {
        const out = o(0.5, gain * 0.5);
        this.tone(out, { duration: 0.05, from: 1400 * p, to: 900 * p, type: 'square', gain: 0.3, delay: 0 });
        this.tone(out, { duration: 0.05, from: 1100 * p, to: 700 * p, type: 'square', gain: 0.3, delay: 0.14 });
        this.tone(out, { duration: 0.07, from: 820 * p, to: 420 * p, type: 'square', gain: 0.35, delay: 0.3 });
        break;
      }
      case 'crossbow': {
        const out = o(0.7, gain * 0.55);
        for (let i = 0; i < 5; i++) {
          this.tone(out, { duration: 0.05, from: (900 + i * 60) * p, type: 'square', gain: 0.22, delay: i * 0.1 });
        }
        break;
      }
      case 'arrowHit': {
        const out = o(0.2, gain * 0.6);
        this.tone(out, { duration: 0.12, from: 520 * p, to: 200 * p, type: 'triangle', gain: 0.5 });
        this.burst(out, { duration: 0.1, from: 1600 * p, to: 600 * p, q: 1.2, curve: 0.5 });
        break;
      }

      // --- explosives and magic -------------------------------------------
      case 'grenadeThrow': {
        const out = o(0.24, gain * 0.4);
        this.burst(out, { duration: 0.2, from: 300 * p, to: 900 * p, q: 1.3 });
        break;
      }
      case 'bounce': {
        const out = o(0.14, gain * 0.4);
        this.tone(out, { duration: 0.1, from: 620 * p, to: 300 * p, type: 'triangle', gain: 0.4 });
        break;
      }
      case 'explosion': {
        const out = o(1.6, gain);
        this.burst(out, { duration: 1.4, type: 'lowpass', from: 1800 * p, to: 70 * p, q: 0.8 });
        this.tone(out, { duration: 0.7, from: 110 * p, to: 28 * p, type: 'square', gain: 0.7 });
        this.burst(out, { duration: 0.14, from: 4200 * p, to: 1200 * p, q: 0.4, attack: 0.001, curve: 0.4 });
        break;
      }
      case 'castFire': {
        const out = o(0.4, gain * 0.5);
        this.burst(out, { duration: 0.36, from: 420 * p, to: 1300 * p, q: 0.8 });
        this.tone(out, { duration: 0.2, from: 180 * p, to: 300 * p, type: 'sawtooth', gain: 0.25 });
        break;
      }
      case 'castSpark': {
        const out = o(0.36, gain * 0.5);
        this.burst(out, { duration: 0.3, from: 3600 * p, to: 1200 * p, q: 0.5, attack: 0.001 });
        this.tone(out, { duration: 0.16, from: 2200 * p, to: 900 * p, type: 'square', gain: 0.18 });
        break;
      }
      case 'castHeal': {
        const out = o(0.7, gain * 0.45);
        this.tone(out, { duration: 0.6, from: 660 * p, to: 990 * p, type: 'sine', gain: 0.4 });
        this.tone(out, { duration: 0.5, from: 990 * p, to: 1320 * p, type: 'sine', gain: 0.25, delay: 0.1 });
        break;
      }
      case 'castBolt': {
        const out = o(0.45, gain * 0.6);
        this.tone(out, { duration: 0.4, from: 760 * p, to: 240 * p, type: 'triangle', gain: 0.45 });
        this.burst(out, { duration: 0.35, from: 2000 * p, to: 600 * p, q: 0.7 });
        break;
      }

      // --- pickups and ui --------------------------------------------------
      case 'orbXp': {
        const out = o(0.26, gain * 0.4);
        this.tone(out, { duration: 0.22, from: 880 * p, to: 1320 * p, type: 'sine', gain: 0.5 });
        break;
      }
      case 'orbMana': {
        const out = o(0.26, gain * 0.4);
        this.tone(out, { duration: 0.22, from: 660 * p, to: 990 * p, type: 'sine', gain: 0.5 });
        break;
      }
      case 'orbGold': {
        const out = o(0.34, gain * 0.45);
        this.tone(out, { duration: 0.28, from: 1760 * p, type: 'triangle', gain: 0.3 });
        this.tone(out, { duration: 0.24, from: 2640 * p, type: 'sine', gain: 0.2, delay: 0.03 });
        break;
      }
      case 'pickup': {
        const out = o(0.2, gain * 0.4);
        this.tone(out, { duration: 0.16, from: 520 * p, to: 780 * p, type: 'triangle', gain: 0.45 });
        break;
      }
      case 'uiSelect': {
        const out = o(0.09, gain * 0.3);
        this.tone(out, { duration: 0.06, from: 1200 * p, to: 900 * p, type: 'square', gain: 0.3 });
        break;
      }
      case 'uiOpen': {
        const out = o(0.2, gain * 0.35);
        this.tone(out, { duration: 0.16, from: 420 * p, to: 760 * p, type: 'triangle', gain: 0.35 });
        break;
      }
      case 'uiClose': {
        const out = o(0.2, gain * 0.35);
        this.tone(out, { duration: 0.16, from: 760 * p, to: 420 * p, type: 'triangle', gain: 0.35 });
        break;
      }
      case 'uiEquip': {
        // Leather and buckle: a soft noise shift with a small metal tick on the end.
        const out = o(0.3, gain * 0.5);
        this.burst(out, { duration: 0.18, from: 900 * p, to: 380 * p, q: 0.8 });
        this.tone(out, { duration: 0.1, from: 1500 * p, type: 'triangle', gain: 0.18, delay: 0.09 });
        break;
      }
      case 'uiDrop': {
        const out = o(0.24, gain * 0.45);
        this.tone(out, { duration: 0.14, from: 300 * p, to: 120 * p, type: 'sine', gain: 0.6 });
        this.burst(out, { duration: 0.12, from: 700 * p, to: 260 * p, q: 0.9, curve: 0.6 });
        break;
      }
      case 'uiSpend': {
        // Spending a point is a small reward, so it is the only UI sound with any
        // pitch movement upwards.
        const out = o(0.3, gain * 0.45);
        this.tone(out, { duration: 0.22, from: 740 * p, to: 1110 * p, type: 'triangle', gain: 0.4 });
        break;
      }
      case 'uiRespec': {
        // Undoing a whole build: a descending pair, deliberately heavier than any
        // other sheet sound, because it is the one action that cannot be undone.
        const out = o(0.8, gain * 0.55);
        this.tone(out, { duration: 0.5, from: 880 * p, to: 330 * p, type: 'triangle', gain: 0.4 });
        this.tone(out, { duration: 0.55, from: 440 * p, to: 165 * p, type: 'sine', gain: 0.35, delay: 0.1 });
        this.burst(out, { duration: 0.5, from: 1800 * p, to: 500 * p, q: 0.6 });
        break;
      }
      case 'uiDeny': {
        // A refusal. Flat and short: no pitch movement, because a rising or falling
        // tone reads as something having happened.
        const out = o(0.16, gain * 0.35);
        this.tone(out, { duration: 0.12, from: 180 * p, type: 'square', gain: 0.3 });
        break;
      }

      // --- weather ---------------------------------------------------------
      case 'thunder': {
        const out = o(2.4, gain);
        this.burst(out, { duration: 2.2, type: 'lowpass', from: 900 * p, to: 48 * p, q: 0.9, attack: 0.05 });
        this.tone(out, { duration: 1.1, from: 64 * p, to: 24 * p, type: 'sine', gain: 0.6 });
        break;
      }
      default:
        break;
    }
  }
}
