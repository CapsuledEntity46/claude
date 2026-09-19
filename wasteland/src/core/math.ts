/** Small math / geometry toolbox used across the whole game. */

export const TAU = Math.PI * 2;

export interface Vec2 { x: number; y: number; }

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const sign = (v: number) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Exponential smoothing that is stable across variable frame times. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  target + (current - target) * Math.exp(-rate * dt);

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};
export const dist = (ax: number, ay: number, bx: number, by: number) => Math.sqrt(dist2(ax, ay, bx, by));

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from angle `a` to angle `b`. */
export const angleDelta = (a: number, b: number) => wrapAngle(b - a);

/** Rotate `a` toward `b` by at most `maxStep` radians. */
export function angleTowards(a: number, b: number, maxStep: number): number {
  const d = angleDelta(a, b);
  if (Math.abs(d) <= maxStep) return wrapAngle(b);
  return wrapAngle(a + sign(d) * maxStep);
}

export function normalize(v: Vec2): Vec2 {
  const m = Math.hypot(v.x, v.y);
  return m > 1e-9 ? { x: v.x / m, y: v.y / m } : { x: 0, y: 0 };
}

/** Closest point on segment AB to point P. */
export function closestPointOnSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): Vec2 {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return { x: ax, y: ay };
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / len2);
  return { x: ax + abx * t, y: ay + aby * t };
}

/**
 * Ray/segment intersection.
 * Returns the ray parameter t (>= 0) of the hit, or -1 when there is none.
 */
export function raySegment(
  ox: number, oy: number, dx: number, dy: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const sx = bx - ax, sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-9) return -1; // parallel
  const t = ((ax - ox) * sy - (ay - oy) * sx) / denom;
  const u = ((ax - ox) * dy - (ay - oy) * dx) / denom;
  if (t < 0 || u < 0 || u > 1) return -1;
  return t;
}

/**
 * Ray vs circle. Returns nearest non-negative hit distance along the (unit) ray
 * direction, or -1.
 */
export function rayCircle(
  ox: number, oy: number, dx: number, dy: number,
  cx: number, cy: number, r: number,
): number {
  const ex = cx - ox, ey = cy - oy;
  const proj = ex * dx + ey * dy;
  const d2 = ex * ex + ey * ey - proj * proj;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t0 = proj - thc;
  const t1 = proj + thc;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return -1;
}

export interface Rect { x: number; y: number; w: number; h: number; }

export const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const pointInRect = (px: number, py: number, r: Rect) =>
  px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

export const rectsOverlapPadded = (a: Rect, b: Rect, pad: number) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

/** Push a circle out of an axis-aligned box. Mutates and returns the position. */
export function resolveCircleRect(pos: Vec2, radius: number, r: Rect): boolean {
  const nx = clamp(pos.x, r.x, r.x + r.w);
  const ny = clamp(pos.y, r.y, r.y + r.h);
  const dx = pos.x - nx, dy = pos.y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > radius * radius) return false;

  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    pos.x = nx + (dx / d) * radius;
    pos.y = ny + (dy / d) * radius;
  } else {
    // Centre is inside the box: eject along the shallowest axis.
    const left = pos.x - r.x, right = r.x + r.w - pos.x;
    const top = pos.y - r.y, bottom = r.y + r.h - pos.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) pos.x = r.x - radius;
    else if (m === right) pos.x = r.x + r.w + radius;
    else if (m === top) pos.y = r.y - radius;
    else pos.y = r.y + r.h + radius;
  }
  return true;
}

/** Does a circle overlap a 2D cone (used by melee arcs and vision checks)? */
export function circleInCone(
  ox: number, oy: number, facing: number, range: number, halfArc: number,
  cx: number, cy: number, cr: number,
): boolean {
  const dx = cx - ox, dy = cy - oy;
  const d = Math.hypot(dx, dy);
  if (d > range + cr) return false;
  if (d < cr) return true; // overlapping the origin
  const a = Math.atan2(dy, dx);
  const diff = Math.abs(angleDelta(facing, a));
  // Allow for the target's angular radius.
  const angularRadius = Math.asin(clamp01(cr / Math.max(d, 1e-6)));
  return diff <= halfArc + angularRadius;
}


/**
 * Ray vs axis-aligned rect (slab method).
 * Returns entry distance along a unit direction, or -1 when there's no hit
 * within [0, maxDist]. A ray starting inside the rect returns 0.
 */
export function rayRect(
  ox: number, oy: number, dx: number, dy: number, r: Rect, maxDist: number,
): number {
  const invDx = dx !== 0 ? 1 / dx : Infinity;
  const invDy = dy !== 0 ? 1 / dy : Infinity;

  let t1 = (r.x - ox) * invDx;
  let t2 = (r.x + r.w - ox) * invDx;
  let tmin = Math.min(t1, t2);
  let tmax = Math.max(t1, t2);

  t1 = (r.y - oy) * invDy;
  t2 = (r.y + r.h - oy) * invDy;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));

  if (tmax < 0 || tmin > tmax || tmin > maxDist) return -1;
  return Math.max(0, tmin);
}
