/**
 * Procedural item icons.
 *
 * Every icon is drawn with canvas primitives from a small library of shape
 * archetypes, tinted per item. That keeps ~150 recognisably distinct icons in a
 * few hundred lines with zero image assets to load.
 *
 * Shapes are authored in a *landscape* unit box (0..1 on both axes). If an
 * item's grid footprint is taller than it is wide, the canvas is rotated so long
 * objects such as machetes and spears read vertically.
 */

import type { IconShape, IconSpec, ItemDef } from './itemdefs';

/** Base resolution of one inventory cell, in device pixels. */
const CELL_PX = 60;

const cache = new Map<string, HTMLCanvasElement>();

/** Shapes authored lengthwise; rotated for tall grid footprints. */
const ELONGATED: ReadonlySet<IconShape> = new Set<IconShape>([
  'rifle', 'carbine', 'smg', 'pistol', 'revolver', 'shotgun', 'sniper', 'lmg',
  'bow', 'crossbow', 'launcher', 'nailgun', 'flaregun',
  'knife', 'sword', 'axe', 'pick', 'hammer', 'bat', 'spear', 'club', 'shovel',
  'crowbar', 'sledge', 'torch', 'flashlight', 'rod', 'throwknife', 'arrow',
  'rocket_ammo', 'splint', 'silencer', 'scope', 'bone', 'plank', 'fish', 'door',
]);

export function itemIcon(def: ItemDef): HTMLCanvasElement {
  const key = def.id;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(def.w * CELL_PX);
  canvas.height = Math.round(def.h * CELL_PX);
  const g = canvas.getContext('2d')!;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  const rotate = ELONGATED.has(def.icon.s) && def.h > def.w;
  let W = canvas.width, H = canvas.height;
  if (rotate) {
    // Rotate so the long axis of the shape runs down the tall icon.
    g.translate(canvas.width, 0);
    g.rotate(Math.PI / 2);
    W = canvas.height;
    H = canvas.width;
  }

  // Slight inset so strokes aren't clipped at the edges.
  const pad = Math.min(W, H) * 0.08;
  g.translate(pad, pad);
  drawShape(g, def.icon, W - pad * 2, H - pad * 2);

  cache.set(key, canvas);
  return canvas;
}

/** A standalone icon for UI that wants a specific pixel size. */
export function iconAt(def: ItemDef, px: number): HTMLCanvasElement {
  const src = itemIcon(def);
  const key = `${def.id}@${px}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  const ratio = src.width / src.height;
  c.width = ratio >= 1 ? px : Math.round(px * ratio);
  c.height = ratio >= 1 ? Math.round(px / ratio) : px;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  cache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// Drawing helpers. `x`/`y` arguments are 0..1 fractions of the icon box.
// ---------------------------------------------------------------------------

type G = CanvasRenderingContext2D;

const DEFAULTS = { a: '#9aa0a6', b: '#5f6469', c: '#c9a227' };

function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, ((v >> 16) & 255) + amt));
  const gg = Math.max(0, Math.min(255, ((v >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (v & 255) + amt));
  return `rgb(${r},${gg},${b})`;
}

function drawShape(g: G, spec: IconSpec, W: number, H: number): void {
  const a = spec.a ?? DEFAULTS.a;
  const b = spec.b ?? DEFAULTS.b;
  const c = spec.c ?? DEFAULTS.c;

  // Normalised box helpers.
  const X = (t: number) => t * W;
  const Y = (t: number) => t * H;
  const S = Math.min(W, H);

  /** Filled rounded rect in fractional coords. */
  const box = (x: number, y: number, w: number, h: number, fill: string, r = 0.1) => {
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(X(x), Y(y), X(w), Y(h), Math.max(0.5, r * S));
    g.fill();
  };
  /** Polygon from fractional point pairs. */
  const poly = (pts: number[], fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(X(pts[0]), Y(pts[1]));
    for (let i = 2; i < pts.length; i += 2) g.lineTo(X(pts[i]), Y(pts[i + 1]));
    g.closePath();
    g.fill();
  };
  const circle = (x: number, y: number, r: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(X(x), Y(y), r * S, 0, Math.PI * 2);
    g.fill();
  };
  /** Stroked line for barrels, straps, cords. */
  const line = (x1: number, y1: number, x2: number, y2: number, col: string, w: number) => {
    g.strokeStyle = col;
    g.lineWidth = Math.max(1, w * S);
    g.beginPath();
    g.moveTo(X(x1), Y(y1));
    g.lineTo(X(x2), Y(y2));
    g.stroke();
  };
  const arc = (x: number, y: number, r: number, a0: number, a1: number, col: string, w: number) => {
    g.strokeStyle = col;
    g.lineWidth = Math.max(1, w * S);
    g.beginPath();
    g.arc(X(x), Y(y), r * S, a0, a1);
    g.stroke();
  };

  switch (spec.s) {
    // ---------------- firearms ----------------
    case 'rifle':
      box(0.02, 0.5, 0.26, 0.3, b, 0.12);            // stock
      box(0.24, 0.4, 0.5, 0.22, a, 0.06);            // receiver
      box(0.68, 0.44, 0.3, 0.1, c, 0.04);            // barrel
      box(0.36, 0.6, 0.16, 0.36, shade(a, -25), 0.08); // magazine (curved AK style)
      box(0.3, 0.26, 0.12, 0.16, shade(a, -15), 0.06); // gas block
      line(0.74, 0.3, 0.8, 0.44, c, 0.035);          // front sight
      break;
    case 'carbine':
      box(0.02, 0.46, 0.22, 0.24, b, 0.1);
      box(0.2, 0.38, 0.5, 0.22, a, 0.05);
      box(0.66, 0.42, 0.32, 0.11, shade(a, -20), 0.04);
      box(0.4, 0.58, 0.13, 0.34, shade(a, -30), 0.06);
      box(0.24, 0.26, 0.3, 0.13, c, 0.05);           // carry handle / rail
      break;
    case 'smg':
      box(0.06, 0.44, 0.2, 0.26, b, 0.1);
      box(0.22, 0.38, 0.42, 0.24, a, 0.06);
      box(0.6, 0.43, 0.24, 0.1, shade(a, -20), 0.04);
      box(0.34, 0.58, 0.14, 0.34, shade(a, -30), 0.06);
      line(0.26, 0.3, 0.52, 0.3, c, 0.03);
      break;
    case 'pistol':
      box(0.14, 0.36, 0.62, 0.2, a, 0.05);           // slide
      poly([0.2, 0.54, 0.44, 0.54, 0.34, 0.94, 0.14, 0.94], shade(b, -10)); // grip
      box(0.68, 0.42, 0.22, 0.08, shade(a, -25), 0.03);
      circle(0.52, 0.6, 0.05, shade(a, -35));        // trigger guard
      break;
    case 'revolver':
      box(0.2, 0.38, 0.5, 0.16, a, 0.05);
      circle(0.36, 0.5, 0.13, shade(a, -15));        // cylinder
      circle(0.36, 0.5, 0.05, '#1b1e21');
      poly([0.22, 0.54, 0.44, 0.54, 0.36, 0.92, 0.16, 0.92], b);
      box(0.64, 0.42, 0.26, 0.08, shade(a, -25), 0.03);
      break;
    case 'shotgun':
      box(0.02, 0.48, 0.28, 0.26, b, 0.1);
      box(0.26, 0.42, 0.44, 0.18, a, 0.05);
      box(0.62, 0.42, 0.36, 0.12, shade(a, -15), 0.05); // twin barrel
      box(0.62, 0.55, 0.3, 0.09, shade(a, -35), 0.04);  // pump / lower barrel
      line(0.32, 0.62, 0.56, 0.62, shade(b, -20), 0.05);
      break;
    case 'sniper':
      box(0.0, 0.5, 0.26, 0.26, b, 0.1);
      box(0.22, 0.44, 0.44, 0.16, a, 0.05);
      box(0.62, 0.46, 0.38, 0.08, shade(a, -20), 0.03);
      box(0.3, 0.24, 0.3, 0.13, c ?? '#2f3337', 0.06); // scope body
      circle(0.34, 0.305, 0.055, '#3d7fb5');
      circle(0.57, 0.305, 0.05, '#2a3a44');
      box(0.38, 0.6, 0.1, 0.24, shade(a, -30), 0.05);
      break;
    case 'lmg':
      box(0.0, 0.46, 0.2, 0.26, b, 0.1);
      box(0.16, 0.36, 0.46, 0.24, a, 0.05);
      box(0.6, 0.4, 0.4, 0.1, shade(a, -20), 0.04);
      box(0.3, 0.58, 0.28, 0.34, c, 0.08);           // drum / belt box
      line(0.72, 0.5, 0.78, 0.86, shade(a, -30), 0.035); // bipod
      line(0.84, 0.5, 0.78, 0.86, shade(a, -30), 0.035);
      break;
    case 'bow':
      arc(0.82, 0.5, 0.44, Math.PI * 0.62, Math.PI * 1.38, a, 0.07);
      line(0.2, 0.09, 0.2, 0.91, b, 0.022);          // string
      line(0.2, 0.5, 0.62, 0.5, shade(b, 30), 0.03); // nocked arrow
      break;
    case 'crossbow':
      box(0.1, 0.44, 0.7, 0.13, b, 0.05);            // stock rail
      arc(0.72, 0.5, 0.36, Math.PI * 0.55, Math.PI * 1.45, a, 0.06);
      line(0.44, 0.18, 0.44, 0.82, shade(b, 40), 0.02);
      poly([0.1, 0.56, 0.3, 0.56, 0.24, 0.92, 0.08, 0.92], shade(b, -20));
      break;
    case 'launcher':
      box(0.04, 0.38, 0.9, 0.24, a, 0.1);
      circle(0.1, 0.5, 0.13, '#15181a');             // muzzle bore
      box(0.4, 0.6, 0.14, 0.3, shade(a, -30), 0.06); // grip
      box(0.56, 0.26, 0.24, 0.14, b, 0.05);          // sight
      break;
    case 'nailgun':
      box(0.22, 0.36, 0.44, 0.26, a, 0.08);
      box(0.6, 0.42, 0.3, 0.12, shade(b, -10), 0.04);
      poly([0.24, 0.6, 0.46, 0.6, 0.4, 0.94, 0.2, 0.94], b);
      box(0.3, 0.2, 0.26, 0.18, shade(a, 20), 0.06); // nail magazine
      break;
    case 'flaregun':
      box(0.3, 0.38, 0.5, 0.16, a, 0.06);
      circle(0.78, 0.46, 0.1, shade(a, -20));
      poly([0.26, 0.5, 0.5, 0.5, 0.4, 0.94, 0.16, 0.94], b);
      break;

    // ---------------- melee ----------------
    case 'knife':
      poly([0.18, 0.5, 0.62, 0.3, 0.9, 0.46, 0.9, 0.54, 0.62, 0.7], a); // blade
      box(0.06, 0.42, 0.16, 0.16, b, 0.08);          // guard
      box(0.0, 0.44, 0.1, 0.12, shade(b, -20), 0.06);
      line(0.24, 0.5, 0.86, 0.5, shade(a, 45), 0.015); // fuller
      break;
    case 'sword':
      poly([0.26, 0.44, 0.94, 0.48, 0.94, 0.53, 0.26, 0.57], a);
      poly([0.94, 0.48, 1.0, 0.505, 0.94, 0.53], shade(a, 40));
      box(0.18, 0.34, 0.06, 0.32, c, 0.04);          // crossguard
      box(0.02, 0.45, 0.17, 0.1, b, 0.05);           // handle
      break;
    case 'axe':
      line(0.06, 0.78, 0.74, 0.3, b, 0.075);         // shaft
      poly([0.62, 0.36, 0.96, 0.12, 1.0, 0.4, 0.78, 0.5], a); // head
      poly([0.62, 0.36, 0.7, 0.32, 0.78, 0.5], shade(a, -30));
      break;
    case 'pick':
      line(0.08, 0.82, 0.68, 0.34, b, 0.07);
      poly([0.46, 0.3, 0.98, 0.14, 0.94, 0.3, 0.56, 0.44], a);
      poly([0.56, 0.44, 0.9, 0.62, 0.72, 0.66], shade(a, -20));
      break;
    case 'hammer':
      line(0.1, 0.84, 0.68, 0.32, b, 0.07);
      box(0.6, 0.12, 0.34, 0.22, a, 0.08);
      poly([0.6, 0.2, 0.52, 0.34, 0.6, 0.34], shade(a, -25)); // claw
      break;
    case 'sledge':
      line(0.08, 0.86, 0.7, 0.28, b, 0.08);
      box(0.54, 0.06, 0.42, 0.28, a, 0.06);
      box(0.54, 0.06, 0.08, 0.28, shade(a, -35), 0.04);
      break;
    case 'bat':
      poly([0.04, 0.46, 0.2, 0.44, 0.9, 0.3, 1.0, 0.5, 0.9, 0.7, 0.2, 0.56, 0.04, 0.54], a);
      box(0.0, 0.44, 0.14, 0.12, b, 0.06);
      if (spec.b === '#a9afb5') {
        // Nailed variant: studs poking out of the barrel.
        for (let i = 0; i < 5; i++) line(0.5 + i * 0.1, 0.34 - (i % 2) * 0.04, 0.5 + i * 0.1, 0.2, b, 0.018);
      }
      break;
    case 'club':
      poly([0.04, 0.48, 0.66, 0.36, 0.98, 0.5, 0.66, 0.64, 0.04, 0.52], a);
      circle(0.86, 0.5, 0.12, shade(a, 15));
      box(0.0, 0.45, 0.12, 0.1, shade(b, -20), 0.05);
      break;
    case 'spear':
      line(0.02, 0.56, 0.78, 0.44, a, 0.045);        // shaft
      poly([0.72, 0.44, 1.0, 0.5, 0.72, 0.56, 0.76, 0.5], b); // head
      line(0.2, 0.55, 0.3, 0.53, shade(a, -30), 0.05); // binding
      break;
    case 'shovel':
      line(0.06, 0.8, 0.62, 0.36, b, 0.06);
      poly([0.56, 0.4, 0.82, 0.14, 1.0, 0.34, 0.76, 0.58], a);
      break;
    case 'crowbar':
      arc(0.78, 0.4, 0.2, Math.PI * 0.1, Math.PI * 1.1, a, 0.075);
      line(0.1, 0.72, 0.68, 0.46, a, 0.075);
      poly([0.06, 0.66, 0.16, 0.82, 0.04, 0.82], shade(a, 25)); // flat pry end
      break;
    case 'torch':
      line(0.06, 0.78, 0.6, 0.4, a, 0.065);
      circle(0.74, 0.28, 0.17, b);
      circle(0.7, 0.32, 0.1, '#f4e08a');
      break;

    // ---------------- throwables ----------------
    case 'grenade':
      box(0.3, 0.26, 0.42, 0.56, a, 0.22);
      g.strokeStyle = shade(a, -35);
      g.lineWidth = Math.max(1, 0.02 * S);
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(X(0.3), Y(0.26 + i * 0.14)); g.lineTo(X(0.72), Y(0.26 + i * 0.14)); g.stroke(); }
      box(0.42, 0.14, 0.18, 0.14, shade(b, -10), 0.05);
      arc(0.68, 0.18, 0.1, -Math.PI * 0.6, Math.PI * 0.5, b, 0.03); // pin ring
      break;
    case 'molotov':
      poly([0.36, 0.34, 0.64, 0.34, 0.7, 0.9, 0.3, 0.9], a);
      box(0.44, 0.16, 0.12, 0.2, shade(a, -20), 0.04);
      poly([0.44, 0.2, 0.56, 0.2, 0.6, 0.04, 0.4, 0.06], b); // burning rag
      break;
    case 'canister':
      box(0.34, 0.2, 0.34, 0.62, a, 0.14);
      box(0.4, 0.1, 0.2, 0.12, b, 0.05);
      line(0.36, 0.38, 0.66, 0.38, b, 0.03);
      line(0.36, 0.62, 0.66, 0.62, b, 0.03);
      break;
    case 'satchel':
      box(0.16, 0.34, 0.68, 0.5, a, 0.1);
      box(0.28, 0.2, 0.44, 0.16, shade(a, -25), 0.06);
      box(0.3, 0.42, 0.4, 0.2, b, 0.05);             // taped charges
      line(0.7, 0.34, 0.86, 0.14, '#c9452a', 0.025); // fuse
      break;
    case 'throwknife':
      poly([0.22, 0.5, 0.86, 0.42, 0.98, 0.5, 0.86, 0.58], a);
      box(0.06, 0.45, 0.18, 0.1, b, 0.05);
      break;

    // ---------------- ammunition ----------------
    case 'bullet':
      for (const dx of [0.0, 0.34]) {
        box(0.18 + dx, 0.36, 0.26, 0.28, a, 0.06);
        poly([0.44 + dx, 0.36, 0.52 + dx, 0.5, 0.44 + dx, 0.64], b);
      }
      break;
    case 'shell':
      for (const dx of [0.0, 0.34]) {
        box(0.16 + dx, 0.3, 0.3, 0.4, a, 0.06);
        box(0.16 + dx, 0.58, 0.3, 0.14, b, 0.04);    // brass base
      }
      break;
    case 'arrow':
      line(0.08, 0.5, 0.82, 0.5, a, 0.035);
      poly([0.78, 0.44, 0.98, 0.5, 0.78, 0.56], b);
      poly([0.08, 0.5, 0.2, 0.38, 0.22, 0.5], shade(b, -20)); // fletching
      poly([0.08, 0.5, 0.2, 0.62, 0.22, 0.5], shade(b, -20));
      break;
    case 'rocket_ammo':
      poly([0.72, 0.5, 0.96, 0.38, 0.96, 0.62], b);  // warhead
      box(0.2, 0.38, 0.54, 0.24, a, 0.06);
      poly([0.06, 0.28, 0.24, 0.42, 0.24, 0.58, 0.06, 0.72], shade(a, -30)); // fins
      break;
    case 'nails':
      for (let i = 0; i < 4; i++) {
        const y = 0.26 + i * 0.16;
        line(0.22, y, 0.82, y + 0.02, a, 0.022);
        circle(0.2, y, 0.035, b);
      }
      break;

    // ---------------- apparel ----------------
    case 'vest':
      poly([0.22, 0.16, 0.78, 0.16, 0.86, 0.34, 0.78, 0.92, 0.22, 0.92, 0.14, 0.34], a);
      box(0.44, 0.16, 0.12, 0.76, shade(a, -30), 0.02); // centre seam
      box(0.2, 0.38, 0.2, 0.18, b, 0.05);            // pouches
      box(0.6, 0.38, 0.2, 0.18, b, 0.05);
      break;
    case 'helmet':
      g.fillStyle = a;
      g.beginPath();
      g.arc(X(0.5), Y(0.56), 0.36 * S, Math.PI, 0, false);
      g.closePath();
      g.fill();
      box(0.12, 0.54, 0.76, 0.14, shade(a, -25), 0.05);
      box(0.2, 0.36, 0.6, 0.2, b, 0.08);             // visor
      break;
    case 'hat':
      g.fillStyle = a;
      g.beginPath();
      g.arc(X(0.5), Y(0.58), 0.28 * S, Math.PI, 0, false);
      g.closePath();
      g.fill();
      box(0.1, 0.56, 0.8, 0.1, b, 0.06);             // brim
      break;
    case 'mask':
      poly([0.2, 0.3, 0.8, 0.3, 0.74, 0.74, 0.5, 0.86, 0.26, 0.74], a);
      circle(0.5, 0.6, 0.11, b);                     // filter / mouth
      line(0.14, 0.36, 0.86, 0.36, shade(a, -30), 0.035); // strap
      break;
    case 'shirt':
      poly([0.3, 0.2, 0.7, 0.2, 0.96, 0.34, 0.84, 0.48, 0.78, 0.44, 0.78, 0.86, 0.22, 0.86, 0.22, 0.44, 0.16, 0.48, 0.04, 0.34], a);
      poly([0.4, 0.2, 0.6, 0.2, 0.5, 0.34], shade(b, -10)); // collar
      break;
    case 'pants':
      poly([0.24, 0.14, 0.76, 0.14, 0.74, 0.9, 0.56, 0.9, 0.5, 0.5, 0.44, 0.9, 0.26, 0.9], a);
      box(0.24, 0.14, 0.52, 0.1, shade(b, -10), 0.03); // waistband
      break;
    case 'boots':
      poly([0.1, 0.3, 0.42, 0.3, 0.42, 0.62, 0.9, 0.62, 0.9, 0.8, 0.1, 0.8], a);
      box(0.08, 0.76, 0.84, 0.1, b, 0.04);           // sole
      break;
    case 'gloves':
      poly([0.22, 0.3, 0.6, 0.26, 0.82, 0.4, 0.8, 0.6, 0.6, 0.78, 0.24, 0.74], a);
      line(0.22, 0.52, 0.8, 0.5, shade(a, -30), 0.03);
      poly([0.6, 0.26, 0.72, 0.16, 0.8, 0.3], shade(a, 15)); // thumb
      break;
    case 'backpack':
      box(0.2, 0.2, 0.6, 0.68, a, 0.12);
      box(0.3, 0.44, 0.4, 0.26, b, 0.08);            // front pocket
      arc(0.5, 0.2, 0.22, Math.PI, Math.PI * 2, shade(a, -30), 0.04); // straps
      line(0.3, 0.36, 0.7, 0.36, shade(a, -35), 0.025);
      break;

    // ---------------- medical ----------------
    case 'bandage':
      box(0.16, 0.34, 0.68, 0.32, a, 0.14);
      line(0.16, 0.5, 0.84, 0.5, shade(a, -25), 0.03);
      circle(0.5, 0.5, 0.11, b);
      break;
    case 'pills':
      box(0.24, 0.24, 0.52, 0.56, a, 0.1);
      box(0.3, 0.36, 0.4, 0.3, b, 0.05);             // label
      circle(0.5, 0.18, 0.1, shade(a, -25));         // cap
      break;
    case 'syringe':
      line(0.14, 0.62, 0.78, 0.34, a, 0.055);
      poly([0.74, 0.36, 0.98, 0.24, 0.8, 0.42], shade(a, 40)); // needle
      box(0.08, 0.56, 0.16, 0.18, b, 0.05);          // plunger
      break;
    case 'medkit':
      box(0.12, 0.28, 0.76, 0.54, a, 0.1);
      box(0.4, 0.42, 0.2, 0.26, b, 0.02);            // red cross
      box(0.3, 0.52, 0.4, 0.06, b, 0.02);
      box(0.4, 0.2, 0.2, 0.1, shade(a, -30), 0.05);  // handle
      break;
    case 'bloodbag':
      poly([0.28, 0.2, 0.72, 0.2, 0.76, 0.76, 0.5, 0.9, 0.24, 0.76], a);
      line(0.5, 0.86, 0.5, 0.98, b, 0.03);
      box(0.34, 0.3, 0.32, 0.14, shade(a, 40), 0.04); // highlight
      break;
    case 'splint':
      line(0.1, 0.4, 0.9, 0.36, a, 0.07);
      line(0.1, 0.62, 0.9, 0.58, a, 0.07);
      line(0.3, 0.3, 0.32, 0.7, b, 0.04);            // wrapping
      line(0.66, 0.28, 0.68, 0.68, b, 0.04);
      break;

    // ---------------- food & drink ----------------
    case 'can':
      box(0.28, 0.2, 0.44, 0.62, a, 0.1);
      box(0.28, 0.36, 0.44, 0.3, b, 0.02);           // label band
      arc(0.5, 0.22, 0.2, Math.PI, Math.PI * 2, shade(a, 35), 0.03);
      break;
    case 'soda':
      box(0.32, 0.14, 0.36, 0.72, a, 0.12);
      box(0.32, 0.34, 0.36, 0.22, b, 0.02);
      circle(0.5, 0.16, 0.06, shade(a, -35));
      break;
    case 'bottle':
      poly([0.38, 0.28, 0.62, 0.28, 0.7, 0.44, 0.7, 0.88, 0.3, 0.88, 0.3, 0.44], a);
      box(0.42, 0.1, 0.16, 0.2, shade(a, -15), 0.04);
      box(0.4, 0.06, 0.2, 0.08, b, 0.03);            // cap
      break;
    case 'canteen':
      box(0.28, 0.24, 0.44, 0.6, a, 0.16);
      box(0.42, 0.12, 0.16, 0.14, b, 0.05);
      arc(0.5, 0.54, 0.14, 0, Math.PI * 2, shade(a, -30), 0.025);
      break;
    case 'meat':
      poly([0.2, 0.42, 0.36, 0.24, 0.68, 0.24, 0.84, 0.46, 0.7, 0.76, 0.34, 0.76], a);
      circle(0.78, 0.6, 0.1, b);                     // bone end
      line(0.36, 0.44, 0.62, 0.4, shade(a, 35), 0.03);
      break;
    case 'fish':
      poly([0.16, 0.5, 0.42, 0.28, 0.72, 0.32, 0.84, 0.5, 0.72, 0.68, 0.42, 0.72], a);
      poly([0.16, 0.5, 0.02, 0.34, 0.02, 0.66], b);  // tail
      circle(0.68, 0.44, 0.045, '#1b1e21');
      break;
    case 'fruit':
      circle(0.5, 0.56, 0.3, a);
      line(0.5, 0.3, 0.54, 0.14, '#5f4a27', 0.03);
      poly([0.54, 0.2, 0.74, 0.12, 0.6, 0.28], b);   // leaf
      break;
    case 'grain':
      box(0.24, 0.18, 0.52, 0.66, a, 0.06);
      box(0.32, 0.34, 0.36, 0.3, b, 0.03);
      line(0.24, 0.26, 0.76, 0.26, shade(a, -30), 0.025);
      break;
    case 'mushroom':
      g.fillStyle = a;
      g.beginPath();
      g.arc(X(0.5), Y(0.52), 0.3 * S, Math.PI, 0);
      g.closePath();
      g.fill();
      box(0.42, 0.5, 0.16, 0.34, b, 0.05);
      break;
    case 'honey':
      poly([0.34, 0.26, 0.66, 0.26, 0.72, 0.86, 0.28, 0.86], a);
      box(0.38, 0.16, 0.24, 0.12, b, 0.04);
      for (let i = 0; i < 3; i++) circle(0.42 + i * 0.08, 0.5 + (i % 2) * 0.1, 0.05, shade(a, 35));
      break;

    // ---------------- resources ----------------
    case 'plank':
      box(0.06, 0.34, 0.88, 0.14, a, 0.03);
      box(0.06, 0.52, 0.88, 0.14, shade(a, -18), 0.03);
      line(0.2, 0.34, 0.24, 0.48, shade(b, -20), 0.015); // grain
      line(0.6, 0.52, 0.66, 0.66, shade(b, -20), 0.015);
      break;
    case 'stone':
      poly([0.2, 0.62, 0.3, 0.3, 0.6, 0.22, 0.82, 0.44, 0.76, 0.74, 0.4, 0.8], a);
      poly([0.3, 0.3, 0.6, 0.22, 0.52, 0.48, 0.34, 0.5], shade(a, 25));
      poly([0.52, 0.48, 0.82, 0.44, 0.76, 0.74, 0.56, 0.7], b);
      break;
    case 'ingot':
      poly([0.18, 0.62, 0.28, 0.4, 0.74, 0.4, 0.84, 0.62, 0.74, 0.74, 0.28, 0.74], a);
      poly([0.28, 0.4, 0.74, 0.4, 0.68, 0.5, 0.34, 0.5], shade(a, 40));
      box(0.3, 0.56, 0.12, 0.08, b, 0.02);           // stamp
      break;
    case 'cloth':
      poly([0.16, 0.34, 0.46, 0.22, 0.84, 0.36, 0.8, 0.74, 0.4, 0.82, 0.18, 0.66], a);
      line(0.28, 0.4, 0.7, 0.66, b, 0.025);
      line(0.34, 0.68, 0.72, 0.42, b, 0.02);
      break;
    case 'leather':
      poly([0.14, 0.4, 0.34, 0.2, 0.7, 0.22, 0.88, 0.46, 0.72, 0.78, 0.36, 0.8, 0.16, 0.62], a);
      poly([0.34, 0.2, 0.7, 0.22, 0.6, 0.44, 0.38, 0.42], shade(a, 22));
      for (let i = 0; i < 4; i++) circle(0.26 + i * 0.16, 0.7, 0.02, b); // stitches
      break;
    case 'bone':
      line(0.24, 0.5, 0.76, 0.5, a, 0.11);
      circle(0.2, 0.38, 0.1, a); circle(0.2, 0.62, 0.1, a);
      circle(0.8, 0.38, 0.1, a); circle(0.8, 0.62, 0.1, a);
      line(0.34, 0.46, 0.66, 0.46, shade(a, 22), 0.02);
      break;
    case 'powder':
      poly([0.18, 0.8, 0.5, 0.26, 0.82, 0.8], a);    // heap
      poly([0.34, 0.54, 0.5, 0.26, 0.62, 0.5], shade(a, 28));
      for (let i = 0; i < 6; i++) circle(0.3 + (i * 0.11) % 0.44, 0.68 + ((i * 7) % 3) * 0.04, 0.022, b);
      break;
    case 'scrap':
      poly([0.18, 0.5, 0.36, 0.24, 0.56, 0.4, 0.5, 0.62], a);
      poly([0.5, 0.36, 0.78, 0.28, 0.86, 0.56, 0.6, 0.68], shade(a, -22));
      poly([0.3, 0.6, 0.56, 0.58, 0.48, 0.82, 0.26, 0.76], b);
      break;
    case 'techtrash':
      box(0.18, 0.26, 0.64, 0.5, a, 0.05);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) box(0.26 + i * 0.18, 0.36 + j * 0.2, 0.1, 0.1, b, 0.02);
      line(0.18, 0.5, 0.82, 0.5, c, 0.02);
      break;
    case 'gear':
      circle(0.5, 0.5, 0.28, a);
      circle(0.5, 0.5, 0.11, '#15181a');
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const gx = 0.5 + Math.cos(ang) * 0.32, gy = 0.5 + Math.sin(ang) * 0.32;
        circle(gx, gy, 0.07, b);
      }
      break;
    case 'wire':
      arc(0.5, 0.5, 0.3, 0, Math.PI * 1.7, a, 0.045);
      arc(0.5, 0.5, 0.18, Math.PI * 0.4, Math.PI * 2, shade(a, -20), 0.04);
      break;
    case 'battery':
      box(0.3, 0.2, 0.4, 0.66, a, 0.06);
      box(0.3, 0.2, 0.4, 0.24, b, 0.04);
      box(0.42, 0.12, 0.16, 0.1, shade(a, 35), 0.03);
      break;
    case 'spring':
      for (let i = 0; i < 5; i++) arc(0.5, 0.26 + i * 0.13, 0.22, 0, Math.PI, a, 0.035);
      line(0.28, 0.26, 0.28, 0.82, shade(b, -10), 0.02);
      break;
    case 'sheet':
      poly([0.12, 0.34, 0.86, 0.24, 0.9, 0.68, 0.16, 0.78], a);
      poly([0.12, 0.34, 0.86, 0.24, 0.84, 0.32, 0.14, 0.42], shade(a, 32));
      for (let i = 0; i < 3; i++) circle(0.26 + i * 0.24, 0.6, 0.025, b);
      break;
    case 'rope':
      arc(0.5, 0.5, 0.28, 0, Math.PI * 2, a, 0.07);
      arc(0.5, 0.5, 0.28, Math.PI * 0.2, Math.PI * 0.8, b, 0.03);
      arc(0.5, 0.5, 0.28, Math.PI * 1.2, Math.PI * 1.8, b, 0.03);
      break;
    case 'tarp':
      poly([0.08, 0.3, 0.92, 0.24, 0.9, 0.74, 0.1, 0.8], a);
      line(0.3, 0.27, 0.26, 0.78, b, 0.025);
      line(0.6, 0.255, 0.58, 0.765, b, 0.025);
      for (const cx of [0.12, 0.88]) { circle(cx, 0.32, 0.03, b); circle(cx, 0.72, 0.03, b); }
      break;
    case 'tape':
      circle(0.5, 0.5, 0.32, a);
      circle(0.5, 0.5, 0.14, '#1b1e21');
      arc(0.5, 0.5, 0.24, Math.PI * 0.1, Math.PI * 1.2, b, 0.05);
      break;
    case 'seed':
      for (const [sx, sy] of [[0.36, 0.42], [0.58, 0.34], [0.5, 0.62], [0.68, 0.6]] as const) {
        g.fillStyle = a;
        g.beginPath();
        g.ellipse(X(sx), Y(sy), 0.1 * S, 0.06 * S, 0.6, 0, Math.PI * 2);
        g.fill();
      }
      break;

    // ---------------- light & deployables ----------------
    case 'flashlight':
      box(0.1, 0.4, 0.58, 0.2, a, 0.06);
      poly([0.66, 0.32, 0.9, 0.24, 0.9, 0.76, 0.66, 0.68], shade(a, -20));
      circle(0.88, 0.5, 0.13, b);
      break;
    case 'lantern':
      box(0.3, 0.3, 0.4, 0.5, a, 0.06);
      box(0.36, 0.38, 0.28, 0.34, b, 0.04);          // glass
      arc(0.5, 0.3, 0.16, Math.PI, Math.PI * 2, shade(a, -25), 0.03);
      box(0.34, 0.78, 0.32, 0.1, shade(a, -20), 0.04);
      break;
    case 'lighter':
      box(0.34, 0.36, 0.32, 0.5, a, 0.08);
      box(0.4, 0.26, 0.2, 0.12, shade(a, -30), 0.04);
      poly([0.46, 0.26, 0.54, 0.26, 0.52, 0.08, 0.44, 0.16], b);
      break;
    case 'campfire':
      for (let i = 0; i < 4; i++) line(0.24 + i * 0.05, 0.82, 0.62 - i * 0.08, 0.56, a, 0.045);
      line(0.72, 0.82, 0.38, 0.6, a, 0.045);
      poly([0.42, 0.62, 0.52, 0.28, 0.62, 0.62], b);
      poly([0.46, 0.6, 0.53, 0.42, 0.58, 0.6], '#f4e08a');
      break;
    case 'furnace':
      poly([0.22, 0.86, 0.3, 0.26, 0.7, 0.26, 0.78, 0.86], a);
      box(0.38, 0.5, 0.24, 0.3, '#1b1e21', 0.04);
      poly([0.42, 0.74, 0.5, 0.54, 0.58, 0.74], b);  // glow in the mouth
      box(0.34, 0.16, 0.14, 0.12, shade(a, -25), 0.03); // chimney
      break;
    case 'workbench':
      box(0.08, 0.36, 0.84, 0.14, a, 0.04);          // bench top
      line(0.18, 0.5, 0.18, 0.88, shade(a, -25), 0.05);
      line(0.82, 0.5, 0.82, 0.88, shade(a, -25), 0.05);
      box(0.3, 0.2, 0.16, 0.16, b, 0.04);            // tools on top
      line(0.56, 0.24, 0.72, 0.36, b, 0.035);
      break;
    case 'box':
      box(0.14, 0.3, 0.72, 0.54, a, 0.05);
      box(0.14, 0.3, 0.72, 0.12, shade(a, 28), 0.04); // lid
      box(0.44, 0.42, 0.12, 0.12, b, 0.03);          // latch
      line(0.14, 0.62, 0.86, 0.62, shade(a, -22), 0.02);
      break;
    case 'door':
      box(0.14, 0.1, 0.72, 0.8, a, 0.04);
      box(0.2, 0.18, 0.6, 0.3, shade(a, -18), 0.03);
      box(0.2, 0.54, 0.6, 0.28, shade(a, -18), 0.03);
      circle(0.76, 0.5, 0.05, b);
      break;
    case 'trap':
      arc(0.5, 0.56, 0.3, Math.PI, Math.PI * 2, a, 0.06); // jaws
      arc(0.5, 0.56, 0.3, 0, Math.PI, a, 0.06);
      circle(0.5, 0.56, 0.1, b);
      for (let i = 0; i < 5; i++) line(0.24 + i * 0.13, 0.4, 0.24 + i * 0.13, 0.28, shade(a, 25), 0.02);
      break;
    case 'saddle':
      poly([0.16, 0.6, 0.3, 0.34, 0.7, 0.34, 0.86, 0.6, 0.7, 0.72, 0.3, 0.72], a);
      poly([0.3, 0.34, 0.46, 0.2, 0.5, 0.36], shade(a, 25)); // pommel
      line(0.22, 0.68, 0.24, 0.9, b, 0.035);         // stirrup strap
      circle(0.25, 0.9, 0.06, b);
      break;
    case 'bed':
      box(0.1, 0.42, 0.8, 0.34, a, 0.1);
      box(0.14, 0.34, 0.3, 0.16, b, 0.08);           // pillow
      line(0.1, 0.6, 0.9, 0.6, shade(a, -22), 0.025);
      break;
    case 'catcher':
      poly([0.14, 0.34, 0.86, 0.34, 0.72, 0.5, 0.28, 0.5], a); // funnel
      box(0.34, 0.5, 0.32, 0.36, b, 0.06);           // tank
      line(0.3, 0.26, 0.36, 0.34, shade(a, 30), 0.02);
      break;
    case 'plan':
      box(0.16, 0.18, 0.68, 0.66, a, 0.04);
      g.strokeStyle = b;
      g.lineWidth = Math.max(1, 0.02 * S);
      g.strokeRect(X(0.26), Y(0.3), X(0.48), Y(0.42));
      line(0.26, 0.5, 0.74, 0.5, b, 0.018);
      line(0.5, 0.3, 0.5, 0.72, b, 0.018);
      break;
    case 'sign':
      box(0.16, 0.24, 0.68, 0.38, a, 0.04);
      line(0.5, 0.62, 0.5, 0.9, b, 0.05);
      break;

    // ---------------- utility ----------------
    case 'map':
      poly([0.1, 0.28, 0.36, 0.2, 0.64, 0.3, 0.9, 0.22, 0.9, 0.74, 0.64, 0.82, 0.36, 0.72, 0.1, 0.8], a);
      line(0.36, 0.2, 0.36, 0.72, shade(a, -25), 0.02);
      line(0.64, 0.3, 0.64, 0.82, shade(a, -25), 0.02);
      circle(0.52, 0.5, 0.05, '#a3251f');
      line(0.2, 0.58, 0.48, 0.44, b, 0.02);
      break;
    case 'compass':
      circle(0.5, 0.5, 0.32, a);
      circle(0.5, 0.5, 0.25, '#1b1e21');
      poly([0.5, 0.28, 0.56, 0.5, 0.5, 0.72, 0.44, 0.5], b);
      circle(0.5, 0.5, 0.04, '#d9dde1');
      break;
    case 'radio':
      box(0.3, 0.26, 0.4, 0.62, a, 0.08);
      box(0.36, 0.36, 0.28, 0.16, b, 0.04);          // display
      for (let i = 0; i < 3; i++) line(0.36, 0.6 + i * 0.08, 0.64, 0.6 + i * 0.08, shade(a, -28), 0.02);
      line(0.62, 0.26, 0.74, 0.08, shade(a, -20), 0.025); // antenna
      break;
    case 'binoculars':
      box(0.16, 0.3, 0.3, 0.44, a, 0.1);
      box(0.54, 0.3, 0.3, 0.44, a, 0.1);
      box(0.44, 0.42, 0.12, 0.16, shade(a, -28), 0.04);
      circle(0.31, 0.38, 0.09, b);
      circle(0.69, 0.38, 0.09, b);
      break;
    case 'rod':
      line(0.06, 0.74, 0.94, 0.26, a, 0.03);
      box(0.06, 0.68, 0.18, 0.14, shade(b, -20), 0.05); // handle
      circle(0.26, 0.72, 0.07, b);                   // reel
      line(0.9, 0.28, 0.72, 0.72, shade(b, 30), 0.012); // line
      break;
    case 'key':
      circle(0.26, 0.5, 0.16, a);
      circle(0.26, 0.5, 0.07, '#15181a');
      line(0.4, 0.5, 0.9, 0.5, a, 0.06);
      line(0.78, 0.5, 0.78, 0.68, a, 0.05);
      line(0.9, 0.5, 0.9, 0.66, a, 0.05);
      break;
    case 'scope':
      box(0.1, 0.4, 0.8, 0.2, a, 0.06);
      box(0.06, 0.32, 0.12, 0.36, shade(a, -20), 0.05);
      circle(0.12, 0.5, 0.1, b);
      box(0.4, 0.3, 0.14, 0.1, shade(a, -30), 0.03); // turret
      break;
    case 'silencer':
      box(0.1, 0.38, 0.72, 0.24, a, 0.1);
      box(0.78, 0.42, 0.14, 0.16, b, 0.05);
      for (let i = 0; i < 4; i++) line(0.2 + i * 0.15, 0.38, 0.2 + i * 0.15, 0.62, shade(a, -25), 0.018);
      break;
    case 'laser':
      box(0.22, 0.4, 0.46, 0.24, a, 0.07);
      circle(0.72, 0.52, 0.08, b);
      line(0.8, 0.52, 0.98, 0.52, b, 0.02);
      break;
  }

  // Unified soft outline so tiles read against the grid background.
  g.globalAlpha = 0.25;
  g.strokeStyle = '#000';
  g.lineWidth = Math.max(1, S * 0.015);
  g.strokeRect(0, 0, W, H);
  g.globalAlpha = 1;
}
