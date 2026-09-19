/**
 * Fully procedural audio via WebAudio — no sample files to ship.
 *
 * Gunshots are noise bursts through a resonant filter, impacts are short
 * enveloped thumps, UI blips are simple oscillators. Everything is synthesised
 * on demand and positioned in stereo relative to the listener.
 */

type SfxName =
  | 'shoot_light' | 'shoot_heavy' | 'shoot_shotgun' | 'shoot_bow' | 'shoot_silenced'
  | 'dry_fire' | 'reload_in' | 'reload_out' | 'bolt'
  | 'swing' | 'hit_flesh' | 'hit_metal' | 'hit_wood' | 'hit_stone'
  | 'zombie_growl' | 'zombie_alert' | 'zombie_die'
  | 'explosion' | 'glass' | 'pickup' | 'craft_done' | 'ui_click' | 'ui_open'
  | 'hurt' | 'heal' | 'eat' | 'drink' | 'build' | 'gather' | 'horse'
  | 'level' | 'death' | 'throw' | 'footstep';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private listener = { x: 0, y: 0 };
  private lastPlayed = new Map<string, number>();
  volume = 0.55;
  muted = false;

  /** Must be called from a user gesture (browser autoplay policy). */
  resume(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise(2);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setListener(x: number, y: number): void {
    this.listener.x = x;
    this.listener.y = y;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Convert a world position into gain + stereo pan relative to the listener.
   * Returns null when the sound is too far away to bother synthesising.
   */
  private spatial(x?: number, y?: number): { gain: number; pan: number } | null {
    if (x === undefined || y === undefined) return { gain: 1, pan: 0 };
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const d = Math.hypot(dx, dy);
    const maxDist = 1400;
    if (d > maxDist) return null;
    const gain = Math.pow(1 - d / maxDist, 1.8);
    const pan = Math.max(-0.85, Math.min(0.85, dx / 520));
    return { gain, pan };
  }

  /** Rate-limit identical sounds so overlapping events don't clip. */
  private throttled(name: string, ms: number): boolean {
    const now = performance.now();
    const last = this.lastPlayed.get(name) ?? -1e9;
    if (now - last < ms) return true;
    this.lastPlayed.set(name, now);
    return false;
  }

  play(name: SfxName, x?: number, y?: number, opts: { volume?: number; pitch?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const sp = this.spatial(x, y);
    if (!sp) return;

    const vol = sp.gain * (opts.volume ?? 1);
    if (vol < 0.004) return;
    const pitch = opts.pitch ?? 1;
    const t = ctx.currentTime;

    const panner = ctx.createStereoPanner();
    panner.pan.value = sp.pan;
    panner.connect(this.master);

    switch (name) {
      case 'shoot_light':   this.gunshot(panner, t, vol * 0.5, 1700 * pitch, 0.1, 0.6); break;
      case 'shoot_heavy':   this.gunshot(panner, t, vol * 0.75, 950 * pitch, 0.24, 0.85); break;
      case 'shoot_shotgun': this.gunshot(panner, t, vol * 0.8, 620 * pitch, 0.3, 1); break;
      case 'shoot_silenced':this.gunshot(panner, t, vol * 0.22, 2600 * pitch, 0.06, 0.2); break;
      case 'shoot_bow':     this.blip(panner, t, vol * 0.3, 240, 90, 0.14, 'triangle'); break;
      case 'throw':         this.blip(panner, t, vol * 0.25, 340, 150, 0.1, 'triangle'); break;
      case 'dry_fire':      this.click(panner, t, vol * 0.4, 2600, 0.035); break;
      case 'reload_out':    this.click(panner, t, vol * 0.45, 900, 0.06); break;
      case 'reload_in':     this.click(panner, t, vol * 0.5, 1400, 0.07); break;
      case 'bolt':          this.click(panner, t, vol * 0.5, 1900, 0.05);
                            this.click(panner, t + 0.09, vol * 0.42, 1300, 0.05); break;

      case 'swing':         this.swish(panner, t, vol * 0.4, pitch); break;
      case 'hit_flesh':     this.thump(panner, t, vol * 0.55, 160, 0.13, 900); break;
      case 'hit_metal':     this.metal(panner, t, vol * 0.45, 2400 * pitch); break;
      case 'hit_wood':      this.thump(panner, t, vol * 0.5, 320, 0.09, 2200); break;
      case 'hit_stone':     this.thump(panner, t, vol * 0.5, 240, 0.08, 3000); break;
      case 'gather':        this.thump(panner, t, vol * 0.4, 280, 0.1, 1800); break;
      case 'build':         this.thump(panner, t, vol * 0.5, 200, 0.16, 1400); break;

      case 'zombie_growl':  if (!this.throttled('growl', 260)) this.growl(panner, t, vol * 0.4, pitch, 0.5); break;
      case 'zombie_alert':  this.growl(panner, t, vol * 0.7, pitch * 1.25, 0.75); break;
      case 'zombie_die':    this.growl(panner, t, vol * 0.6, pitch * 0.65, 0.95); break;
      case 'horse':         this.growl(panner, t, vol * 0.5, 0.55, 0.7); break;

      case 'explosion':     this.explosion(panner, t, vol); break;
      case 'glass':         this.glass(panner, t, vol * 0.45); break;

      case 'pickup':        this.blip(panner, t, vol * 0.2, 620, 900, 0.06, 'square'); break;
      case 'ui_click':      this.blip(panner, t, vol * 0.13, 480, 560, 0.04, 'square'); break;
      case 'ui_open':       this.blip(panner, t, vol * 0.14, 300, 420, 0.07, 'sine'); break;
      case 'craft_done':    this.arp(panner, t, vol * 0.24, [520, 700, 880]); break;
      case 'level':         this.arp(panner, t, vol * 0.3, [440, 660, 880, 1100]); break;
      case 'heal':          this.arp(panner, t, vol * 0.18, [400, 600]); break;
      case 'eat':           this.thump(panner, t, vol * 0.3, 180, 0.12, 700); break;
      case 'drink':         this.blip(panner, t, vol * 0.2, 200, 340, 0.16, 'sine'); break;
      case 'hurt':          this.growl(panner, t, vol * 0.45, 1.5, 0.3); break;
      case 'death':         this.growl(panner, t, vol * 0.8, 0.5, 1.3); break;
      case 'footstep':      if (!this.throttled('step', 120)) this.thump(panner, t, vol * 0.1, 110, 0.05, 500); break;
    }

    // Free the node graph shortly after the tail ends.
    setTimeout(() => panner.disconnect(), 3000);
  }

  // ---- synthesis primitives -------------------------------------------------

  private noiseSource(dest: AudioNode, t: number, dur: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
    return src;
  }

  private gunshot(dest: AudioNode, t: number, vol: number, freq: number, dur: number, body: number): void {
    const ctx = this.ctx!;

    // Crack: band-passed noise with a fast decay.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(freq, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 0.25), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    bp.connect(g).connect(dest);
    this.noiseSource(bp, t, dur);

    // Low-end punch.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140 * body, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + dur * 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.8 * body, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + dur * 0.9);
    osc.connect(og).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    // Distant tail so shots feel like they exist in a landscape.
    const tail = ctx.createBiquadFilter();
    tail.type = 'lowpass';
    tail.frequency.value = 700;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(vol * 0.18 * body, t + 0.05);
    tg.gain.exponentialRampToValueAtTime(0.0008, t + 0.45 + body * 0.4);
    tail.connect(tg).connect(dest);
    this.noiseSource(tail, t, 0.5 + body * 0.4);
  }

  private explosion(dest: AudioNode, t: number, vol: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 1.1, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.3);
    lp.connect(g).connect(dest);
    this.noiseSource(lp, t, 1.3);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(22, t + 0.7);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + 0.8);
    osc.connect(og).connect(dest);
    osc.start(t);
    osc.stop(t + 0.9);
  }

  private thump(dest: AudioNode, t: number, vol: number, freq: number, dur: number, cutoff: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    lp.connect(g).connect(dest);
    this.noiseSource(lp, t, dur);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.4, t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.7, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(og).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  private metal(dest: AudioNode, t: number, vol: number, freq: number): void {
    const ctx = this.ctx!;
    for (const [mult, amp] of [[1, 1], [1.74, 0.5], [2.61, 0.3]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * amp, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(t + 0.25);
    }
  }

  private glass(dest: AudioNode, t: number, vol: number): void {
    const ctx = this.ctx!;
    for (let i = 0; i < 7; i++) {
      const at = t + Math.random() * 0.18;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 2200 + Math.random() * 3200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * (0.3 + Math.random() * 0.5), at);
      g.gain.exponentialRampToValueAtTime(0.0008, at + 0.12);
      osc.connect(g).connect(dest);
      osc.start(at);
      osc.stop(at + 0.14);
    }
  }

  private swish(dest: AudioNode, t: number, vol: number, pitch: number): void {
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(420 * pitch, t);
    bp.frequency.linearRampToValueAtTime(1500 * pitch, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0008, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.2);
    bp.connect(g).connect(dest);
    this.noiseSource(bp, t, 0.22);
  }

  private growl(dest: AudioNode, t: number, vol: number, pitch: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = 88 * pitch;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * 0.72, t + dur);

    // Slow LFO wobble makes it sound organic rather than like a synth tone.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7 + Math.random() * 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.14;
    lfo.connect(lfoGain).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0008, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private click(dest: AudioNode, t: number, vol: number, freq: number, dur: number): void {
    const ctx = this.ctx!;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = freq * 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    hp.connect(g).connect(dest);
    this.noiseSource(hp, t, dur);
  }

  private blip(dest: AudioNode, t: number, vol: number, f0: number, f1: number, dur: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private arp(dest: AudioNode, t: number, vol: number, freqs: number[]): void {
    freqs.forEach((f, i) => this.blip(dest, t + i * 0.055, vol, f, f, 0.09, 'triangle'));
  }
}

export const audio = new AudioEngine();
