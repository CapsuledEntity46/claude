import { clamp01, TAU } from '../core/math';

type ParticleKind = 'blood' | 'spark' | 'smoke' | 'dust' | 'fire' | 'casing' | 'gib' | 'leaf' | 'splash' | 'chip' | 'ember';

interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual height above ground; gives casings and gibs a little arc. */
  z: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  vrot: number;
  color: string;
  drag: number;
  /** Leaves a permanent-ish stain when it lands. */
  stains: boolean;
}

interface DamageNumber {
  x: number;
  y: number;
  value: number;
  life: number;
  crit: boolean;
  vy: number;
  drift: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  maxLife: number;
  color: string;
  width: number;
}

interface Decal {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
  maxLife: number;
  rot: number;
}

interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  width: number;
  color: string;
}

const MAX_PARTICLES = 1400;
const MAX_DECALS = 420;

/**
 * Particle, decal and screen-effect manager.
 *
 * Everything is pre-allocated and recycled; emitters just claim slots. Decals
 * (blood pools, scorch marks) are kept in a separate ring buffer so they can be
 * drawn under entities and persist far longer than particles.
 */
export class Effects {
  private pool: Particle[] = [];
  private cursor = 0;
  private numbers: DamageNumber[] = [];
  private rings: Ring[] = [];
  private decals: Decal[] = [];
  private decalCursor = 0;
  private tracers: Tracer[] = [];

  /** Camera shake magnitude in world units, decays each frame. */
  shake = 0;
  /** White-out from flashbangs, 0..1. */
  blind = 0;
  /** Red vignette intensity from taking damage, 0..1. */
  hurt = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        active: false, kind: 'dust', x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0,
        life: 0, maxLife: 1, size: 2, rot: 0, vrot: 0, color: '#fff', drag: 2, stains: false,
      });
    }
  }

  private claim(): Particle {
    // Round-robin: oldest slots get recycled first under heavy load.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      if (!p.active) return p;
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return p;
  }

  private emit(
    kind: ParticleKind, x: number, y: number, vx: number, vy: number,
    life: number, size: number, color: string,
    opts: { z?: number; vz?: number; drag?: number; vrot?: number; stains?: boolean } = {},
  ): void {
    const p = this.claim();
    p.active = true;
    p.kind = kind;
    p.x = x; p.y = y;
    p.vx = vx; p.vy = vy;
    p.z = opts.z ?? 0;
    p.vz = opts.vz ?? 0;
    p.life = life;
    p.maxLife = life;
    p.size = size;
    p.color = color;
    p.rot = Math.random() * TAU;
    p.vrot = opts.vrot ?? 0;
    p.drag = opts.drag ?? 2.4;
    p.stains = opts.stains ?? false;
  }

  private addDecal(x: number, y: number, r: number, color: string, life: number): void {
    if (this.decals.length < MAX_DECALS) {
      this.decals.push({ x, y, r, color, life, maxLife: life, rot: Math.random() * TAU });
    } else {
      // Overwrite the oldest slot.
      const d = this.decals[this.decalCursor];
      d.x = x; d.y = y; d.r = r; d.color = color; d.life = life; d.maxLife = life; d.rot = Math.random() * TAU;
      this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    }
  }

  // ------------------------------------------------------------------ emitters

  /** Blood spray in the direction of the hit, scaled by damage. */
  blood(x: number, y: number, angle: number, amount: number): void {
    const n = Math.min(18, 4 + Math.floor(amount / 5));
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * 1.5;
      const speed = 60 + Math.random() * 190 * clamp01(amount / 40);
      this.emit('blood', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.45 + Math.random() * 0.4, 1.4 + Math.random() * 2.4,
        Math.random() < 0.25 ? '#6e1410' : '#a3251f',
        { z: 8 + Math.random() * 10, vz: 40 + Math.random() * 90, drag: 3.2, stains: true });
    }
    if (amount > 8) this.addDecal(x, y, 5 + Math.min(16, amount * 0.28), 'rgba(96,17,13,0.5)', 60);
  }

  /** Bullet/melee impact on hard surfaces. */
  impact(x: number, y: number, angle: number): void {
    for (let i = 0; i < 7; i++) {
      const a = angle + Math.PI + (Math.random() - 0.5) * 1.9;
      const speed = 90 + Math.random() * 220;
      this.emit('spark', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.14 + Math.random() * 0.16, 1 + Math.random() * 1.6, '#ffd98a', { drag: 5 });
    }
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      this.emit('smoke', x, y, Math.cos(a) * 24, Math.sin(a) * 24,
        0.5 + Math.random() * 0.4, 3 + Math.random() * 4, '#9a968e', { drag: 1.4 });
    }
    this.addDecal(x, y, 3 + Math.random() * 3, 'rgba(24,22,20,0.45)', 90);
  }

  /** Chips flying off a tree or rock being harvested. */
  gather(x: number, y: number, color: string): void {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU;
      const speed = 50 + Math.random() * 150;
      this.emit('chip', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.4 + Math.random() * 0.4, 1.6 + Math.random() * 2.4, color,
        { z: 10, vz: 60 + Math.random() * 80, drag: 3.4, vrot: (Math.random() - 0.5) * 18 });
    }
  }

  /** Muzzle flash: a short cone of light plus smoke. */
  muzzle(x: number, y: number, angle: number, size: number): void {
    if (size <= 0) return;
    for (let i = 0; i < 5; i++) {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const speed = 160 + Math.random() * 280;
      this.emit('fire', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.07 + Math.random() * 0.07, size * (0.3 + Math.random() * 0.5), '#ffd066', { drag: 8 });
    }
    for (let i = 0; i < 3; i++) {
      const a = angle + (Math.random() - 0.5) * 1.1;
      this.emit('smoke', x, y, Math.cos(a) * 70, Math.sin(a) * 70,
        0.55, size * 0.35, 'rgba(180,176,168,0.75)', { drag: 2 });
    }
    this.shake = Math.max(this.shake, size * 0.09);
  }

  /** Ejected brass. */
  casing(x: number, y: number, angle: number): void {
    const a = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.7;
    this.emit('casing', x, y, Math.cos(a) * 110, Math.sin(a) * 110,
      1.1, 2, '#c8a44a', { z: 14, vz: 70, drag: 2.2, vrot: (Math.random() - 0.5) * 24 });
  }

  explosion(x: number, y: number, radius: number): void {
    this.rings.push({ x, y, r: radius * 0.18, maxR: radius * 1.12, life: 0.42, maxLife: 0.42, color: '#ffd27a', width: 7 });
    this.rings.push({ x, y, r: radius * 0.05, maxR: radius * 1.5, life: 0.75, maxLife: 0.75, color: 'rgba(120,110,100,0.5)', width: 20 });

    const count = Math.min(70, 26 + Math.floor(radius / 3));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const speed = 120 + Math.random() * radius * 4.2;
      this.emit('fire', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.2 + Math.random() * 0.4, 4 + Math.random() * 9,
        Math.random() < 0.5 ? '#ffb347' : '#ff7326', { drag: 4 });
    }
    for (let i = 0; i < count * 0.8; i++) {
      const a = Math.random() * TAU;
      const speed = 60 + Math.random() * radius * 2.2;
      this.emit('smoke', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        1.1 + Math.random() * 1.4, 7 + Math.random() * 14, 'rgba(70,66,62,0.8)', { drag: 1.2 });
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * TAU;
      this.emit('ember', x, y, Math.cos(a) * (80 + Math.random() * 300), Math.sin(a) * (80 + Math.random() * 300),
        0.8 + Math.random() * 0.8, 1.6, '#ffd27a', { z: 6, vz: 120 * Math.random(), drag: 2.6 });
    }
    this.addDecal(x, y, radius * 0.5, 'rgba(20,16,14,0.55)', 240);
    this.shake = Math.max(this.shake, Math.min(22, radius * 0.11));
  }

  fireBurst(x: number, y: number, radius: number): void {
    this.rings.push({ x, y, r: radius * 0.2, maxR: radius, life: 0.4, maxLife: 0.4, color: '#ff8c3a', width: 6 });
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * TAU;
      const d = Math.random() * radius * 0.8;
      this.emit('fire', x + Math.cos(a) * d, y + Math.sin(a) * d,
        Math.cos(a) * 40, Math.sin(a) * 40, 0.5 + Math.random() * 0.6,
        5 + Math.random() * 7, '#ff9a3c', { vz: 40, drag: 2 });
    }
    this.addDecal(x, y, radius * 0.6, 'rgba(26,18,14,0.4)', 200);
  }

  /** Continuous emission for burning ground / campfires. */
  flames(x: number, y: number, radius: number, intensity: number, dt: number): void {
    const want = intensity * radius * dt * 0.9;
    const n = Math.random() < want % 1 ? Math.floor(want) + 1 : Math.floor(want);
    for (let i = 0; i < Math.min(n, 12); i++) {
      const a = Math.random() * TAU;
      const d = Math.random() * radius;
      this.emit('fire', x + Math.cos(a) * d, y + Math.sin(a) * d,
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
        0.35 + Math.random() * 0.45, 3 + Math.random() * 5,
        Math.random() < 0.5 ? '#ffb347' : '#ff7326', { z: 2, vz: 40 + Math.random() * 50, drag: 1.6 });
    }
    if (Math.random() < dt * 4 * intensity) {
      const a = Math.random() * TAU;
      const d = Math.random() * radius;
      this.emit('smoke', x + Math.cos(a) * d, y + Math.sin(a) * d, 0, -18,
        1.6, 6 + Math.random() * 8, 'rgba(60,56,52,0.45)', { drag: 0.8, vz: 26 });
    }
  }

  /** Smoke grenade cloud emission. */
  smokeCloud(x: number, y: number, radius: number, intensity: number, dt: number): void {
    const n = Math.random() < intensity * dt * 22 % 1 ? 1 : 0;
    for (let i = 0; i < n + Math.floor(intensity * dt * 22); i++) {
      const a = Math.random() * TAU;
      const d = Math.random() * radius;
      this.emit('smoke', x + Math.cos(a) * d, y + Math.sin(a) * d,
        (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16,
        2.2 + Math.random() * 1.6, 14 + Math.random() * 16,
        'rgba(198,198,196,0.5)', { drag: 0.5 });
    }
  }

  flashbang(x: number, y: number, radius: number): void {
    this.rings.push({ x, y, r: 4, maxR: radius, life: 0.28, maxLife: 0.28, color: '#ffffff', width: 12 });
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * TAU;
      this.emit('spark', x, y, Math.cos(a) * (200 + Math.random() * 400), Math.sin(a) * (200 + Math.random() * 400),
        0.18, 2, '#ffffff', { drag: 6 });
    }
    this.shake = Math.max(this.shake, 8);
  }

  /** Water splash when entering water or a bullet hits it. */
  splash(x: number, y: number): void {
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * TAU;
      this.emit('splash', x, y, Math.cos(a) * (40 + Math.random() * 90), Math.sin(a) * (40 + Math.random() * 90),
        0.4, 1.6 + Math.random() * 2, '#a8d4ea', { z: 4, vz: 60 + Math.random() * 60, drag: 3 });
    }
  }

  /** Dust kicked up by hooves and sprinting. */
  dust(x: number, y: number, amount = 1): void {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * TAU;
      this.emit('dust', x, y, Math.cos(a) * 22, Math.sin(a) * 22,
        0.5 + Math.random() * 0.4, 3 + Math.random() * 4, 'rgba(150,140,124,0.5)', { drag: 2 });
    }
  }

  /** Gibs for a bloater rupturing or a heavy kill. */
  gibs(x: number, y: number, count = 10): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const speed = 90 + Math.random() * 240;
      this.emit('gib', x, y, Math.cos(a) * speed, Math.sin(a) * speed,
        0.9 + Math.random() * 0.6, 2.4 + Math.random() * 3.4, '#8a2420',
        { z: 10, vz: 80 + Math.random() * 120, drag: 2.8, vrot: (Math.random() - 0.5) * 20, stains: true });
    }
  }

  damageNumber(x: number, y: number, value: number, crit: boolean): void {
    if (this.numbers.length > 40) this.numbers.shift();
    this.numbers.push({
      x: x + (Math.random() - 0.5) * 12, y: y - 12, value, life: 0.95, crit,
      vy: -34, drift: (Math.random() - 0.5) * 22,
    });
  }

  tracer(x1: number, y1: number, x2: number, y2: number, width = 1, color = 'rgba(255,226,150,0.85)'): void {
    if (this.tracers.length > 120) this.tracers.shift();
    this.tracers.push({ x1, y1, x2, y2, life: 0.06, width, color });
  }

  hurtFlash(intensity: number): void {
    this.hurt = Math.min(1, this.hurt + intensity);
    this.shake = Math.max(this.shake, intensity * 6);
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        if (p.stains && p.kind === 'blood') this.addDecal(p.x, p.y, p.size * 1.1, 'rgba(92,16,12,0.4)', 50);
        p.active = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;

      if (p.vz !== 0 || p.z > 0) {
        p.z += p.vz * dt;
        p.vz -= 340 * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz = p.kind === 'casing' || p.kind === 'gib' ? -p.vz * 0.3 : 0;
          if (Math.abs(p.vz) < 20) p.vz = 0;
          p.vx *= 0.5;
          p.vy *= 0.5;
        }
      }

      // Fire and smoke rise and slow; solids just decelerate.
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      if (p.kind === 'fire' || p.kind === 'smoke' || p.kind === 'ember') {
        p.vy -= 12 * dt;
        p.size += dt * (p.kind === 'smoke' ? 9 : -2);
        if (p.size < 0.4) { p.active = false; continue; }
      }
    }

    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.life -= dt;
      n.y += n.vy * dt;
      n.x += n.drift * dt;
      n.vy += 42 * dt;
      if (n.life <= 0) this.numbers.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const t = 1 - r.life / r.maxLife;
      r.r = r.maxR * (1 - Math.pow(1 - t, 2.2));
      if (r.life <= 0) this.rings.splice(i, 1);
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      this.decals[i].life -= dt;
      if (this.decals[i].life <= 0) this.decals.splice(i, 1);
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      this.tracers[i].life -= dt;
      if (this.tracers[i].life <= 0) this.tracers.splice(i, 1);
    }

    this.shake = Math.max(0, this.shake - dt * 34);
    this.blind = Math.max(0, this.blind - dt * 0.6);
    this.hurt = Math.max(0, this.hurt - dt * 1.3);
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
    this.numbers.length = 0;
    this.rings.length = 0;
    this.decals.length = 0;
    this.tracers.length = 0;
    this.shake = 0;
    this.blind = 0;
    this.hurt = 0;
  }

  // ------------------------------------------------------------------ drawing

  /** Ground-level stains, drawn before entities. */
  drawDecals(g: CanvasRenderingContext2D): void {
    for (const d of this.decals) {
      const alpha = clamp01(d.life / d.maxLife);
      g.globalAlpha = alpha * 0.9;
      g.fillStyle = d.color;
      g.beginPath();
      g.ellipse(d.x, d.y, d.r, d.r * 0.62, d.rot, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** Particles, rings and tracers, drawn above entities. */
  draw(g: CanvasRenderingContext2D): void {
    for (const t of this.tracers) {
      g.globalAlpha = clamp01(t.life / 0.06);
      g.strokeStyle = t.color;
      g.lineWidth = t.width;
      g.beginPath();
      g.moveTo(t.x1, t.y1);
      g.lineTo(t.x2, t.y2);
      g.stroke();
    }
    g.globalAlpha = 1;

    for (const p of this.pool) {
      if (!p.active) continue;
      const t = clamp01(p.life / p.maxLife);
      const drawY = p.y - p.z;

      switch (p.kind) {
        case 'fire':
        case 'ember':
          g.globalAlpha = t * 0.95;
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(p.x, drawY, p.size, 0, TAU);
          g.fill();
          break;
        case 'smoke':
        case 'dust':
          g.globalAlpha = t * 0.55;
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(p.x, drawY, p.size, 0, TAU);
          g.fill();
          break;
        case 'spark':
          g.globalAlpha = t;
          g.strokeStyle = p.color;
          g.lineWidth = Math.max(0.7, p.size * 0.5);
          g.beginPath();
          g.moveTo(p.x, drawY);
          g.lineTo(p.x - p.vx * 0.012, drawY - p.vy * 0.012);
          g.stroke();
          break;
        case 'casing':
          g.globalAlpha = t;
          g.save();
          g.translate(p.x, drawY);
          g.rotate(p.rot);
          g.fillStyle = p.color;
          g.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8);
          g.restore();
          break;
        case 'gib':
        case 'chip':
          g.globalAlpha = t;
          g.save();
          g.translate(p.x, drawY);
          g.rotate(p.rot);
          g.fillStyle = p.color;
          g.fillRect(-p.size * 0.6, -p.size * 0.45, p.size * 1.2, p.size * 0.9);
          g.restore();
          break;
        case 'splash':
          g.globalAlpha = t * 0.85;
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(p.x, drawY, p.size, 0, TAU);
          g.fill();
          break;
        case 'blood':
        default:
          g.globalAlpha = Math.min(1, t * 1.6);
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(p.x, drawY, p.size, 0, TAU);
          g.fill();
          break;
      }
    }
    g.globalAlpha = 1;

    for (const r of this.rings) {
      g.globalAlpha = clamp01(r.life / r.maxLife) * 0.9;
      g.strokeStyle = r.color;
      g.lineWidth = r.width * clamp01(r.life / r.maxLife);
      g.beginPath();
      g.arc(r.x, r.y, r.r, 0, TAU);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** Floating damage numbers, drawn last in world space. */
  drawNumbers(g: CanvasRenderingContext2D): void {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const n of this.numbers) {
      const a = clamp01(n.life / 0.95);
      g.globalAlpha = a;
      g.font = n.crit ? 'bold 17px Rajdhani, sans-serif' : 'bold 13px Rajdhani, sans-serif';
      g.fillStyle = '#000';
      g.fillText(String(n.value), n.x + 1, n.y + 1);
      g.fillStyle = n.crit ? '#ffd257' : '#f2f2f0';
      g.fillText(String(n.value), n.x, n.y);
    }
    g.globalAlpha = 1;
  }
}
