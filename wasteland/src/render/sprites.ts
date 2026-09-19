/**
 * Procedural sprites.
 *
 * Every creature and object is drawn from primitives, oriented by its facing
 * angle and animated from the actor's `animPhase`. Nothing is loaded from disk.
 */

import { TAU, clamp01, lerp } from '../core/math';
import { itemDef, type ItemDef } from '../items/itemdefs';
import { PROPS, type PropKind } from '../world/props';
import type { Prop, Structure, Deployable } from '../world/world';
import { TIER_COLORS, TIER_HP } from '../world/world';
import type { Player } from '../entities/player';
import type { Zombie } from '../entities/zombie';
import type { Bandit } from '../entities/bandit';
import type { Animal } from '../entities/animal';
import type { Horse } from '../entities/horse';
import type { Corpse } from '../entities/corpse';
import type { GroundItem } from '../entities/projectile';

type G = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function drawShadow(g: G, x: number, y: number, rx: number, ry = rx * 0.55, alpha = 0.3): void {
  g.globalAlpha = alpha;
  g.fillStyle = '#000';
  g.beginPath();
  g.ellipse(x, y + ry * 0.35, rx, ry, 0, 0, TAU);
  g.fill();
  g.globalAlpha = 1;
}

function ellipse(g: G, x: number, y: number, rx: number, ry: number, rot: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, TAU);
  g.fill();
}

function circle(g: G, x: number, y: number, r: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, ((v >> 16) & 255) + amt));
  const gg = Math.max(0, Math.min(255, ((v >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (v & 255) + amt));
  return `rgb(${r},${gg},${b})`;
}

/** Red overlay when something has just been hit. */
function flashOverlay(g: G, x: number, y: number, r: number, flash: number): void {
  if (flash <= 0) return;
  g.globalAlpha = Math.min(0.75, flash * 3.4);
  g.fillStyle = '#ff5a4a';
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
  g.globalAlpha = 1;
}

/**
 * Generic top-down biped.
 *
 * Legs swing along the movement axis, the torso is an ellipse aligned to facing,
 * and the head sits on top with a small facing indicator.
 */
interface BipedOpts {
  x: number;
  y: number;
  facing: number;
  phase: number;
  scale: number;
  torso: string;
  legs: string;
  head: string;
  /** Additional torso layer (armour, backpack). */
  overChest?: string;
  backpack?: string;
  helmet?: string;
  /** 0..1 attack lunge. */
  lunge?: number;
  crouch?: boolean;
  flash?: number;
}

export function drawBiped(g: G, o: BipedOpts): void {
  const s = o.scale;
  const cos = Math.cos(o.facing), sin = Math.sin(o.facing);
  const perpX = -sin, perpY = cos;
  const lunge = (o.lunge ?? 0) * 6 * s;
  const bodyX = o.x + cos * lunge;
  const bodyY = o.y + sin * lunge;

  drawShadow(g, o.x, o.y, 11 * s, 6.5 * s, o.crouch ? 0.22 : 0.3);

  // --- legs ---
  const swing = Math.sin(o.phase) * 5 * s;
  const legSpread = 4.4 * s;
  for (const side of [-1, 1]) {
    const off = side * legSpread;
    const fwd = side === 1 ? swing : -swing;
    ellipse(
      g,
      bodyX + perpX * off + cos * fwd,
      bodyY + perpY * off + sin * fwd,
      3.6 * s, 2.7 * s, o.facing, o.legs,
    );
  }

  // --- torso ---
  const torsoR = (o.crouch ? 7.4 : 8.6) * s;
  ellipse(g, bodyX, bodyY, torsoR, torsoR * 0.78, o.facing, o.torso);
  if (o.overChest) {
    ellipse(g, bodyX, bodyY, torsoR * 0.82, torsoR * 0.62, o.facing, o.overChest);
  }
  if (o.backpack) {
    ellipse(g, bodyX - cos * 5 * s, bodyY - sin * 5 * s, 5.4 * s, 4.2 * s, o.facing, o.backpack);
  }

  // --- arms ---
  const armSwing = Math.cos(o.phase) * 2.2 * s;
  for (const side of [-1, 1]) {
    ellipse(
      g,
      bodyX + perpX * side * 6.6 * s + cos * (2 + armSwing * side),
      bodyY + perpY * side * 6.6 * s + sin * (2 + armSwing * side),
      2.7 * s, 2.2 * s, o.facing, shade(o.torso, -18),
    );
  }

  // --- head ---
  const headX = bodyX + cos * 1.6 * s;
  const headY = bodyY + sin * 1.6 * s;
  circle(g, headX, headY, 5.2 * s, o.head);
  if (o.helmet) {
    circle(g, headX, headY, 5.6 * s, o.helmet);
    // Visor slit facing forward.
    g.fillStyle = 'rgba(15,18,20,0.75)';
    g.beginPath();
    g.ellipse(headX + cos * 3 * s, headY + sin * 3 * s, 3 * s, 1.5 * s, o.facing, 0, TAU);
    g.fill();
  }
  // Nose/brow marker so facing is readable at a glance.
  g.fillStyle = shade(o.head, -40);
  g.beginPath();
  g.ellipse(headX + cos * 3.6 * s, headY + sin * 3.6 * s, 1.7 * s, 1.2 * s, o.facing, 0, TAU);
  g.fill();

  flashOverlay(g, bodyX, bodyY, torsoR * 1.15, o.flash ?? 0);
}

// ---------------------------------------------------------------------------
// Held weapons
// ---------------------------------------------------------------------------

/**
 * Draw whatever is in the character's hands, in a simple side profile aligned
 * to the facing direction. Melee weapons sweep through their swing arc.
 */
export function drawHeldWeapon(
  g: G, x: number, y: number, facing: number, def: ItemDef | null,
  swingPhase: number, swinging: boolean, drawCharge: number, scale = 1,
): void {
  if (!def) return;

  g.save();
  g.translate(x, y);

  if (def.melee && swinging) {
    // Sweep from one side of the arc to the other, easing out.
    const arc = (def.melee.arc * Math.PI) / 180;
    const t = clamp01(swingPhase);
    const eased = 1 - Math.pow(1 - t, 2.4);
    g.rotate(facing - arc / 2 + arc * eased);
  } else {
    g.rotate(facing);
  }
  g.scale(scale, scale);

  const c = def.icon;
  const a = c.a ?? '#8d9298';
  const b = c.b ?? '#5f6469';

  if (def.ranged) {
    const r = def.ranged;
    const len = Math.min(34, 12 + r.range / 70 + (def.w + def.h) * 2.2);
    if (r.draw) {
      // Bow: an arc with a string, pulled back as it charges.
      g.strokeStyle = a;
      g.lineWidth = 2.2;
      g.beginPath();
      g.arc(10, 0, 10, -1.25, 1.25);
      g.stroke();
      g.strokeStyle = '#ded6c2';
      g.lineWidth = 0.9;
      const pull = -drawCharge * 6;
      g.beginPath();
      g.moveTo(10 + Math.cos(-1.25) * 10, Math.sin(-1.25) * 10);
      g.lineTo(10 + pull, 0);
      g.lineTo(10 + Math.cos(1.25) * 10, Math.sin(1.25) * 10);
      g.stroke();
      if (drawCharge > 0.02) {
        g.strokeStyle = '#d8d2c0';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(10 + pull, 0);
        g.lineTo(22, 0);
        g.stroke();
      }
    } else {
      // Firearm: receiver plus barrel, thickness from the weapon's footprint.
      const thick = 2 + def.h * 0.7;
      g.fillStyle = b;
      g.fillRect(2, -thick / 2 - 1, len * 0.45, thick + 2);
      g.fillStyle = a;
      g.fillRect(len * 0.4, -thick / 2 + 0.4, len * 0.6, thick - 0.8);
      // Magazine hanging below.
      g.fillStyle = shade(b, -20);
      g.fillRect(len * 0.32, thick / 2, 3.2, 4 + def.h);
      // Stock behind the grip.
      g.fillStyle = shade(b, 14);
      g.fillRect(-5, -thick / 2, 7, thick);
    }
  } else if (def.melee) {
    const m = def.melee;
    const len = Math.min(30, m.range * 0.36);
    g.strokeStyle = b;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(len, 0);
    g.stroke();

    // Head shape depends on the weapon archetype.
    g.fillStyle = a;
    switch (def.icon.s) {
      case 'axe':
        g.beginPath();
        g.moveTo(len - 3, -1);
        g.lineTo(len + 5, -6);
        g.lineTo(len + 7, 2);
        g.lineTo(len - 2, 3);
        g.closePath();
        g.fill();
        break;
      case 'pick':
        g.beginPath();
        g.moveTo(len - 2, -1.5);
        g.lineTo(len + 8, -5);
        g.lineTo(len + 7, -1);
        g.closePath();
        g.fill();
        break;
      case 'sledge':
      case 'hammer':
        g.fillRect(len - 2, -4.5, 7, 9);
        break;
      case 'bat':
      case 'club':
        g.fillStyle = a;
        g.beginPath();
        g.ellipse(len - 2, 0, 6, 3, 0, 0, TAU);
        g.fill();
        break;
      case 'spear':
        g.beginPath();
        g.moveTo(len, -2.4);
        g.lineTo(len + 9, 0);
        g.lineTo(len, 2.4);
        g.closePath();
        g.fill();
        break;
      case 'sword':
      case 'knife':
      case 'throwknife':
        g.fillRect(2, -1.4, len + 4, 2.8);
        g.beginPath();
        g.moveTo(len + 6, -1.4);
        g.lineTo(len + 10, 0);
        g.lineTo(len + 6, 1.4);
        g.closePath();
        g.fill();
        break;
      case 'torch': {
        circle(g, len + 1, 0, 3.4, '#6b4a27');
        circle(g, len + 2.5, 0, 2.6, '#f4c15a');
        break;
      }
      case 'shovel':
        g.beginPath();
        g.moveTo(len - 2, -4);
        g.lineTo(len + 6, -3);
        g.lineTo(len + 6, 3);
        g.lineTo(len - 2, 4);
        g.closePath();
        g.fill();
        break;
      default:
        g.fillRect(len - 2, -3, 6, 6);
    }
  } else if (def.throwable) {
    circle(g, 8, 0, 3.4, def.icon.a ?? '#4a5240');
    circle(g, 8, -1, 1.4, def.icon.b ?? '#2f3528');
  } else if (def.deploy || def.cat === 'tool') {
    g.fillStyle = a;
    g.fillRect(3, -2.6, 12, 5.2);
    g.fillStyle = b;
    g.fillRect(12, -2, 5, 4);
  } else {
    // Generic carried object.
    g.fillStyle = a;
    g.fillRect(4, -3, 8, 6);
  }

  g.restore();
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export function drawPlayerSprite(g: G, p: Player, aimAngle: number): void {
  const chest = p.equipment.chest;
  const legs = p.equipment.legs;
  const head = p.equipment.head;
  const back = p.equipment.back;

  const torsoColor = chest ? APPAREL_COLOR[chest.id] ?? '#4a5568' : '#c9a98a';
  const legColor = legs ? APPAREL_COLOR[legs.id] ?? '#3a4f6b' : '#c9a98a';
  const headColor = '#d8b494';

  drawBiped(g, {
    x: p.x, y: p.y, facing: aimAngle,
    phase: p.animPhase,
    // Nudged above 1 so the player reads clearly against town-scale buildings.
    scale: 1.15,
    torso: torsoColor,
    legs: legColor,
    head: headColor,
    overChest: chest && (chest.id === 'kevlar_vest' || chest.id === 'plate_carrier') ? shade(torsoColor, -25) : undefined,
    backpack: back ? APPAREL_COLOR[back.id] ?? '#3d321f' : undefined,
    helmet: head && (head.id === 'helmet_riot' || head.id === 'helmet_military') ? APPAREL_COLOR[head.id] : undefined,
    crouch: p.crouching,
    flash: p.flash,
    lunge: p.swingTime > 0 ? Math.sin(p.swingPhase * Math.PI) : 0,
  });

  drawHeldWeapon(
    g,
    p.x + Math.cos(aimAngle) * 8,
    p.y + Math.sin(aimAngle) * 8,
    aimAngle,
    p.heldDef,
    p.swingPhase,
    p.swingTime > 0,
    p.drawCharge,
  );

  // Muzzle flash bloom.
  if (p.muzzleFlash > 0.02) {
    const fx = p.x + Math.cos(aimAngle) * 26;
    const fy = p.y + Math.sin(aimAngle) * 26;
    g.globalAlpha = p.muzzleFlash;
    const grad = g.createRadialGradient(fx, fy, 0, fx, fy, 22);
    grad.addColorStop(0, 'rgba(255,226,150,0.95)');
    grad.addColorStop(1, 'rgba(255,170,60,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(fx, fy, 22, 0, TAU);
    g.fill();
    g.globalAlpha = 1;
  }
}

export function drawZombieSprite(g: G, z: Zombie): void {
  const s = z.stats.size;
  const body = z.stats.color;
  drawBiped(g, {
    x: z.x, y: z.y, facing: z.facing,
    phase: z.animPhase,
    scale: s,
    torso: body,
    legs: shade(body, -22),
    head: shade(body, 26),
    flash: z.flash,
    lunge: z.attackAnim,
  });

  // Reaching arms give zombies their silhouette.
  const cos = Math.cos(z.facing), sin = Math.sin(z.facing);
  const reach = 9 * s + z.attackAnim * 6 * s;
  for (const side of [-1, 1]) {
    const px = z.x + cos * reach + -sin * side * 4.4 * s;
    const py = z.y + sin * reach + cos * side * 4.4 * s;
    ellipse(g, px, py, 3 * s, 2.2 * s, z.facing, shade(body, -12));
  }

  // Brutes get visible bulk; screamers get a pale maw.
  if (z.type === 'brute') {
    ellipse(g, z.x - cos * 3 * s, z.y - sin * 3 * s, 10 * s, 7.5 * s, z.facing, shade(body, -30));
  }
  if (z.type === 'screamer') {
    circle(g, z.x + cos * 5.5 * s, z.y + sin * 5.5 * s, 2.4 * s, '#d8c0c8');
  }
  if (z.type === 'bloater') {
    circle(g, z.x, z.y, 9.5 * s, 'rgba(150,180,90,0.35)');
  }

  if (z.burning > 0) {
    g.globalAlpha = 0.5;
    circle(g, z.x, z.y, 12 * s, 'rgba(255,140,50,0.5)');
    g.globalAlpha = 1;
  }
}

export function drawBanditSprite(g: G, b: Bandit): void {
  const color = b.stats.color;
  drawBiped(g, {
    x: b.x, y: b.y, facing: b.facing,
    phase: b.animPhase,
    scale: b.stats.size,
    torso: color,
    legs: shade(color, -26),
    head: '#c49a78',
    overChest: b.stats.armor > 0.2 ? shade(color, -30) : undefined,
    helmet: b.kind === 'heavy' ? '#3a4036' : undefined,
    flash: b.flash,
    lunge: b.swingAnim * 0.6,
  });

  const weaponDef = b.stats.weapon && b.ammo > 0 ? itemDef(b.stats.weapon) : itemDef(b.stats.melee);
  drawHeldWeapon(
    g,
    b.x + Math.cos(b.facing) * 8,
    b.y + Math.sin(b.facing) * 8,
    b.facing,
    weaponDef,
    b.swingAnim > 0 ? 1 - b.swingAnim : 0,
    b.swingAnim > 0,
    0,
  );

  if (b.muzzleFlash > 0.02) {
    const fx = b.x + Math.cos(b.facing) * 26;
    const fy = b.y + Math.sin(b.facing) * 26;
    g.globalAlpha = b.muzzleFlash;
    circle(g, fx, fy, 9, 'rgba(255,214,120,0.8)');
    g.globalAlpha = 1;
  }
}

export function drawAnimalSprite(g: G, a: Animal): void {
  const s = a.stats.size;
  const cos = Math.cos(a.facing), sin = Math.sin(a.facing);
  const color = a.stats.color;

  drawShadow(g, a.x, a.y, 12 * s, 7 * s, 0.28);

  // Four legs.
  const swing = Math.sin(a.animPhase) * 4 * s;
  for (const [fwd, side] of [[6, -4], [6, 4], [-6, -4], [-6, 4]] as const) {
    const sw = (fwd > 0 ? swing : -swing) * (side > 0 ? 1 : -1);
    ellipse(g, a.x + cos * (fwd + sw) - sin * side * s, a.y + sin * (fwd + sw) + cos * side * s,
      2.2 * s, 1.7 * s, a.facing, shade(color, -28));
  }

  // Body and head.
  ellipse(g, a.x, a.y, 11 * s, 6.4 * s, a.facing, color);
  const headX = a.x + cos * 11 * s, headY = a.y + sin * 11 * s;
  ellipse(g, headX, headY, 4.6 * s, 3.6 * s, a.facing, shade(color, 16));
  // Tail.
  ellipse(g, a.x - cos * 11 * s, a.y - sin * 11 * s, 2.6 * s, 1.8 * s, a.facing, shade(color, -14));

  switch (a.kind) {
    case 'deer':
      // Antlers.
      g.strokeStyle = '#d8cdb4';
      g.lineWidth = 1.2 * s;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(headX, headY);
        g.lineTo(headX + cos * 5 * s - sin * side * 4 * s, headY + sin * 5 * s + cos * side * 4 * s);
        g.stroke();
      }
      break;
    case 'boar':
      // Tusks.
      g.fillStyle = '#e4dcc4';
      g.beginPath();
      g.ellipse(headX + cos * 3 * s, headY + sin * 3 * s, 2.4 * s, 0.9 * s, a.facing, 0, TAU);
      g.fill();
      break;
    case 'wolf':
      // Ears.
      for (const side of [-1, 1]) {
        circle(g, headX - sin * side * 2.6 * s, headY + cos * side * 2.6 * s, 1.5 * s, shade(color, -18));
      }
      break;
    case 'chicken':
      circle(g, headX + cos * 1.5 * s, headY + sin * 1.5 * s, 1.2 * s, '#c9452a');
      break;
  }

  flashOverlay(g, a.x, a.y, 12 * s, a.flash);
}

export function drawHorseSprite(g: G, h: Horse, rider: Player | null, aimAngle: number): void {
  const cos = Math.cos(h.facing), sin = Math.sin(h.facing);
  const { body, mane } = h.colors;

  drawShadow(g, h.x, h.y, 19, 11, 0.3);

  // Legs.
  const swing = Math.sin(h.animPhase) * 6;
  for (const [fwd, side] of [[10, -6], [10, 6], [-10, -6], [-10, 6]] as const) {
    const sw = fwd > 0 ? swing : -swing;
    ellipse(g, h.x + cos * (fwd + sw) - sin * side, h.y + sin * (fwd + sw) + cos * side,
      3, 2.2, h.facing, shade(body, -30));
  }

  // Barrel and neck.
  ellipse(g, h.x, h.y, 19, 9.5, h.facing, body);
  ellipse(g, h.x + cos * 14, h.y + sin * 14, 8, 5, h.facing, shade(body, 10));
  // Head.
  const headX = h.x + cos * 23, headY = h.y + sin * 23;
  ellipse(g, headX, headY, 6.4, 3.6, h.facing, shade(body, 18));
  // Mane along the neck.
  g.strokeStyle = mane;
  g.lineWidth = 3.4;
  g.beginPath();
  g.moveTo(h.x + cos * 8, h.y + sin * 8);
  g.lineTo(h.x + cos * 19, h.y + sin * 19);
  g.stroke();
  // Tail.
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(h.x - cos * 18, h.y - sin * 18);
  g.lineTo(h.x - cos * 26, h.y - sin * 26);
  g.stroke();

  // Saddle.
  if (h.tamed) {
    ellipse(g, h.x + cos * 2, h.y + sin * 2, 8, 6.4, h.facing, '#573a22');
    g.strokeStyle = '#3f2a18';
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(h.x + cos * 2, h.y + sin * 2, 7, 0, TAU);
    g.stroke();
  }

  // Rider sits on top.
  if (rider) {
    drawBiped(g, {
      x: h.x + cos * 1, y: h.y + sin * 1 - 4,
      facing: aimAngle,
      phase: h.animPhase * 0.4,
      scale: 0.92,
      torso: rider.equipment.chest ? APPAREL_COLOR[rider.equipment.chest.id] ?? '#4a5568' : '#c9a98a',
      legs: '#3a4f6b',
      head: '#d8b494',
      flash: rider.flash,
    });
    drawHeldWeapon(g, h.x + cos * 8, h.y + sin * 8 - 4, aimAngle, rider.heldDef, rider.swingPhase, rider.swingTime > 0, rider.drawCharge, 0.92);
  }

  flashOverlay(g, h.x, h.y, 20, h.flash);

  // Trust indicator over wild horses.
  if (!h.tamed && h.trust > 4) {
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(h.x - 16, h.y - 32, 32, 4);
    g.fillStyle = h.trust >= 60 ? '#63a84b' : '#c9a227';
    g.fillRect(h.x - 16, h.y - 32, 32 * (h.trust / 100), 4);
  }
}

export function drawCorpseSprite(g: G, c: Corpse): void {
  const s = c.size;
  g.save();
  g.translate(c.x, c.y);
  g.rotate(c.angle);
  g.globalAlpha = Math.min(1, c.life / 40);

  drawShadow(g, 0, 0, 12 * s, 7 * s, 0.22);
  // Sprawled body.
  ellipse(g, 0, 0, 11 * s, 7 * s, 0, shade(c.color, -14));
  ellipse(g, 8 * s, 2 * s, 4.6 * s, 4 * s, 0, shade(c.color, 8));
  // Limbs at odd angles.
  ellipse(g, -6 * s, -6 * s, 5 * s, 2.2 * s, 0.7, shade(c.color, -26));
  ellipse(g, -7 * s, 5 * s, 5 * s, 2.2 * s, -0.5, shade(c.color, -26));

  g.globalAlpha = Math.min(0.55, c.life / 60);
  g.fillStyle = 'rgba(96,17,13,0.55)';
  g.beginPath();
  g.ellipse(0, 0, 15 * s, 10 * s, 0, 0, TAU);
  g.fill();

  g.globalAlpha = 1;
  g.restore();

  // Loot glint so bodies are findable.
  if (!c.isEmpty) {
    g.fillStyle = 'rgba(201,162,39,0.75)';
    g.beginPath();
    g.arc(c.x, c.y - 16 * s, 2, 0, TAU);
    g.fill();
  }
}

export function drawGroundItemSprite(g: G, gi: GroundItem, time: number): void {
  const def = itemDef(gi.itemId);
  const bob = Math.sin(time * 2.4 + gi.bobSeed) * 1.8;
  drawShadow(g, gi.x, gi.y + 2, 7, 3.6, 0.28);

  g.save();
  g.translate(gi.x, gi.y - 6 + bob);
  g.fillStyle = def.icon.a ?? '#9aa0a6';
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 1;
  const w = 8, h = 8;
  g.beginPath();
  g.roundRect(-w / 2, -h / 2, w, h, 2);
  g.fill();
  g.stroke();
  g.fillStyle = def.icon.b ?? '#5f6469';
  g.fillRect(-w / 2 + 1.5, -h / 2 + 1.5, w - 3, (h - 3) * 0.5);
  g.restore();

  if (gi.count > 1) {
    g.font = 'bold 9px Rajdhani, sans-serif';
    g.textAlign = 'center';
    g.fillStyle = '#000';
    g.fillText(String(gi.count), gi.x + 1, gi.y + 8);
    g.fillStyle = '#e8e2d4';
    g.fillText(String(gi.count), gi.x, gi.y + 7);
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type PropShape =
  | 'tree_round' | 'tree_conifer' | 'tree_bare' | 'bush' | 'crop' | 'reeds'
  | 'rock' | 'ore' | 'box' | 'barrel' | 'appliance' | 'flat' | 'car'
  | 'pole' | 'fence' | 'bed' | 'sofa' | 'table' | 'shelf' | 'well'
  | 'tower' | 'sign' | 'tire' | 'hay' | 'grave' | 'sandbag' | 'wire' | 'log' | 'trash';

interface PropVisual {
  shape: PropShape;
  a: string;
  b: string;
}

const PROP_VISUALS: Record<PropKind, PropVisual> = {
  tree_oak: { shape: 'tree_round', a: '#3f5e34', b: '#5a4326' },
  tree_pine: { shape: 'tree_conifer', a: '#2f4a32', b: '#4a3520' },
  tree_dead: { shape: 'tree_bare', a: '#6b5a44', b: '#4f412f' },
  bush: { shape: 'bush', a: '#456b3a', b: '#2f4a28' },
  hemp: { shape: 'bush', a: '#6f8a4a', b: '#52683a' },
  log: { shape: 'log', a: '#6b4a27', b: '#4f3619' },
  stump: { shape: 'log', a: '#7a5836', b: '#563d22' },
  rock_small: { shape: 'rock', a: '#82828a', b: '#5f5f66' },
  rock_large: { shape: 'rock', a: '#8b8b93', b: '#61616a' },
  ore_metal: { shape: 'ore', a: '#8a7460', b: '#c9a227' },
  ore_sulfur: { shape: 'ore', a: '#8a8250', b: '#e0c83c' },
  ore_hqm: { shape: 'ore', a: '#98a0a8', b: '#d4d8dc' },
  corn_plant: { shape: 'crop', a: '#7a9b3a', b: '#e0c83c' },
  pumpkin_plant: { shape: 'crop', a: '#5f7a30', b: '#c9762a' },
  reeds: { shape: 'reeds', a: '#7a8a4a', b: '#5a6836' },

  car: { shape: 'car', a: '#5a6a74', b: '#39454d' },
  car_wreck: { shape: 'car', a: '#4a423c', b: '#2e2824' },
  streetlight: { shape: 'pole', a: '#6a6e72', b: '#e0d08a' },
  fence_wood: { shape: 'fence', a: '#7a5836', b: '#5a3f24' },
  fence_chain: { shape: 'wire', a: '#8d9298', b: '#6a6e72' },
  dumpster: { shape: 'box', a: '#3f5f4a', b: '#2b4232' },
  trashbag: { shape: 'trash', a: '#3a3a3e', b: '#2a2a2e' },
  gas_pump: { shape: 'appliance', a: '#a83e2e', b: '#d8d4c8' },
  haybale: { shape: 'hay', a: '#c9a94e', b: '#a88a34' },
  well: { shape: 'well', a: '#7d7d82', b: '#2a3a44' },
  tombstone: { shape: 'grave', a: '#8d8d92', b: '#6a6a70' },
  sandbag: { shape: 'sandbag', a: '#9a8c68', b: '#7a6e4e' },
  barbwire: { shape: 'wire', a: '#8d9298', b: '#5f6469' },
  water_tower: { shape: 'tower', a: '#6e7276', b: '#4a4e52' },
  sign: { shape: 'sign', a: '#8d9298', b: '#3d7fb5' },
  pallet: { shape: 'flat', a: '#8a6134', b: '#6b4a27' },
  tire: { shape: 'tire', a: '#2e2e30', b: '#1e1e20' },
  crate_wood: { shape: 'box', a: '#8a6134', b: '#6b4a27' },

  fridge: { shape: 'appliance', a: '#c4c8cc', b: '#9aa0a6' },
  stove: { shape: 'appliance', a: '#8d9298', b: '#3a3f44' },
  sink: { shape: 'appliance', a: '#b4bcc0', b: '#8a9296' },
  counter: { shape: 'table', a: '#8a7a5c', b: '#6b5d44' },
  shelf: { shape: 'shelf', a: '#8a6134', b: '#6b4a27' },
  wardrobe: { shape: 'appliance', a: '#6b4a27', b: '#4f3619' },
  bed: { shape: 'bed', a: '#8a8a94', b: '#4a5568' },
  sofa: { shape: 'sofa', a: '#5a5548', b: '#423e34' },
  table: { shape: 'table', a: '#8a6134', b: '#6b4a27' },
  chair: { shape: 'flat', a: '#7a5836', b: '#5a3f24' },
  desk: { shape: 'table', a: '#6b4a27', b: '#4f3619' },
  bookshelf: { shape: 'shelf', a: '#5f4128', b: '#8a7448' },
  toilet: { shape: 'appliance', a: '#d4d8dc', b: '#aab0b4' },
  bathtub: { shape: 'bed', a: '#d4d8dc', b: '#a8b0b4' },
  locker: { shape: 'appliance', a: '#4a5a64', b: '#33424a' },
  toolbox: { shape: 'box', a: '#b5651d', b: '#7d4512' },
  safe: { shape: 'box', a: '#4a4e52', b: '#c9a227' },
  crate_military: { shape: 'box', a: '#4a5240', b: '#2f3528' },
  ammo_box: { shape: 'box', a: '#5a6248', b: '#3a4030' },
  medbox: { shape: 'box', a: '#d8d4c8', b: '#a3251f' },
  barrel: { shape: 'barrel', a: '#5a6a4a', b: '#3f4a34' },
};

/**
 * Draw a world prop. Props are drawn with a fake vertical extrusion — a dark
 * "side" offset upward — which sells height in a top-down view.
 */
export function drawProp(g: G, prop: Prop, time: number, wind: number): void {
  const def = PROPS[prop.kind];
  const vis = PROP_VISUALS[prop.kind];
  const size = def.size;
  const x = prop.x;
  const y = prop.y;
  const v = prop.variant / 255;
  const damaged = def.harvest ? 1 - prop.hp / def.harvest.hp : 0;

  switch (vis.shape) {
    case 'tree_round': {
      drawShadow(g, x, y, size * 0.4, size * 0.24, 0.32);
      // Trunk.
      g.fillStyle = vis.b;
      g.fillRect(x - size * 0.06, y - size * 0.1, size * 0.12, size * 0.2);
      // Canopy sways with the wind.
      const sway = Math.sin(time * 0.8 + v * 6) * wind * 5;
      const cy = y - size * 0.34;
      circle(g, x + sway, cy, size * 0.42, shade(vis.a, -18));
      circle(g, x - size * 0.16 + sway, cy - size * 0.08, size * 0.3, vis.a);
      circle(g, x + size * 0.17 + sway, cy - size * 0.04, size * 0.27, shade(vis.a, 12));
      circle(g, x + sway * 1.2, cy - size * 0.2, size * 0.24, shade(vis.a, 22));
      break;
    }
    case 'tree_conifer': {
      drawShadow(g, x, y, size * 0.34, size * 0.2, 0.32);
      g.fillStyle = vis.b;
      g.fillRect(x - size * 0.05, y - size * 0.12, size * 0.1, size * 0.22);
      const sway = Math.sin(time * 0.9 + v * 6) * wind * 4;
      for (let i = 0; i < 3; i++) {
        const t = i / 3;
        const ty = y - size * (0.2 + t * 0.42);
        const tw = size * (0.42 - t * 0.12);
        g.fillStyle = i === 2 ? shade(vis.a, 20) : i === 1 ? vis.a : shade(vis.a, -14);
        g.beginPath();
        g.moveTo(x + sway * (0.5 + t), ty - size * 0.26);
        g.lineTo(x - tw / 2 + sway * t, ty + size * 0.06);
        g.lineTo(x + tw / 2 + sway * t, ty + size * 0.06);
        g.closePath();
        g.fill();
      }
      break;
    }
    case 'tree_bare': {
      drawShadow(g, x, y, size * 0.26, size * 0.16, 0.26);
      g.strokeStyle = vis.a;
      g.lineWidth = size * 0.1;
      g.beginPath();
      g.moveTo(x, y + size * 0.1);
      g.lineTo(x, y - size * 0.4);
      g.stroke();
      g.lineWidth = size * 0.05;
      const sway = Math.sin(time * 1.1 + v * 6) * wind * 4;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(x, y - size * 0.22);
        g.lineTo(x + side * size * 0.26 + sway, y - size * 0.46);
        g.stroke();
      }
      break;
    }
    case 'bush': {
      drawShadow(g, x, y, size * 0.34, size * 0.18, 0.22);
      const sway = Math.sin(time * 1.4 + v * 8) * wind * 3;
      circle(g, x + sway, y - size * 0.1, size * 0.34, shade(vis.a, -14));
      circle(g, x - size * 0.16 + sway, y - size * 0.04, size * 0.24, vis.a);
      circle(g, x + size * 0.15 + sway, y - size * 0.14, size * 0.22, shade(vis.a, 16));
      break;
    }
    case 'crop': {
      const sway = Math.sin(time * 1.6 + v * 9) * wind * 3;
      g.strokeStyle = vis.a;
      g.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const ox = (i - 1) * size * 0.16;
        g.beginPath();
        g.moveTo(x + ox, y);
        g.lineTo(x + ox + sway, y - size * 0.5);
        g.stroke();
      }
      circle(g, x + sway, y - size * 0.5, size * 0.13, vis.b);
      break;
    }
    case 'reeds': {
      const sway = Math.sin(time * 1.8 + v * 9) * wind * 4;
      g.strokeStyle = vis.a;
      g.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) {
        const ox = (i - 2) * size * 0.11;
        g.beginPath();
        g.moveTo(x + ox, y);
        g.quadraticCurveTo(x + ox + sway * 0.5, y - size * 0.3, x + ox + sway, y - size * 0.6);
        g.stroke();
      }
      break;
    }
    case 'rock': {
      drawShadow(g, x, y, size * 0.4, size * 0.24, 0.3);
      const r = size * 0.42;
      g.fillStyle = vis.b;
      g.beginPath();
      g.ellipse(x, y - size * 0.06, r, r * 0.66, v * 3, 0, TAU);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.ellipse(x - size * 0.04, y - size * 0.16, r * 0.82, r * 0.52, v * 3, 0, TAU);
      g.fill();
      g.fillStyle = shade(vis.a, 22);
      g.beginPath();
      g.ellipse(x - size * 0.1, y - size * 0.22, r * 0.4, r * 0.24, v * 3, 0, TAU);
      g.fill();
      break;
    }
    case 'ore': {
      drawShadow(g, x, y, size * 0.4, size * 0.24, 0.3);
      g.fillStyle = vis.a;
      g.beginPath();
      g.ellipse(x, y - size * 0.1, size * 0.4, size * 0.28, v * 3, 0, TAU);
      g.fill();
      // Mineral veins.
      g.fillStyle = vis.b;
      for (let i = 0; i < 5; i++) {
        const a = v * 6 + i * 1.3;
        circle(g, x + Math.cos(a) * size * 0.2, y - size * 0.12 + Math.sin(a) * size * 0.13, size * 0.05, vis.b);
      }
      break;
    }
    case 'box': {
      drawShadow(g, x, y, size * 0.4, size * 0.22, 0.3);
      const w = size * 0.8, h = size * 0.6;
      g.fillStyle = shade(vis.a, -26);
      g.fillRect(x - w / 2, y - h * 0.9, w, h * 0.9);
      g.fillStyle = vis.a;
      g.fillRect(x - w / 2, y - h, w, h * 0.55);
      g.fillStyle = vis.b;
      g.fillRect(x - w / 2 + 2, y - h + 2, w - 4, h * 0.22);
      break;
    }
    case 'barrel': {
      drawShadow(g, x, y, size * 0.34, size * 0.2, 0.3);
      const w = size * 0.6, h = size * 0.86;
      g.fillStyle = shade(vis.a, -22);
      g.fillRect(x - w / 2, y - h, w, h);
      g.fillStyle = vis.a;
      g.beginPath();
      g.ellipse(x, y - h, w / 2, w * 0.28, 0, 0, TAU);
      g.fill();
      g.strokeStyle = vis.b;
      g.lineWidth = 2;
      for (const t of [0.35, 0.65]) {
        g.beginPath();
        g.moveTo(x - w / 2, y - h * t);
        g.lineTo(x + w / 2, y - h * t);
        g.stroke();
      }
      break;
    }
    case 'appliance': {
      drawShadow(g, x, y, size * 0.34, size * 0.2, 0.28);
      const w = size * 0.66, h = size * 0.95;
      g.fillStyle = shade(vis.a, -28);
      g.fillRect(x - w / 2, y - h, w, h);
      g.fillStyle = vis.a;
      g.fillRect(x - w / 2, y - h, w, h * 0.5);
      g.fillStyle = vis.b;
      g.fillRect(x - w / 2 + 2, y - h * 0.45, w - 4, h * 0.36);
      break;
    }
    case 'flat': {
      drawShadow(g, x, y, size * 0.34, size * 0.2, 0.22);
      g.fillStyle = vis.a;
      g.fillRect(x - size * 0.36, y - size * 0.3, size * 0.72, size * 0.4);
      g.strokeStyle = vis.b;
      g.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(x - size * 0.36, y - size * 0.3 + i * size * 0.15);
        g.lineTo(x + size * 0.36, y - size * 0.3 + i * size * 0.15);
        g.stroke();
      }
      break;
    }
    case 'car': {
      drawShadow(g, x, y, size * 0.48, size * 0.26, 0.34);
      const rot = v * TAU;
      g.save();
      g.translate(x, y - size * 0.1);
      g.rotate(rot);
      // Body.
      g.fillStyle = vis.b;
      g.beginPath();
      g.roundRect(-size * 0.46, -size * 0.2, size * 0.92, size * 0.4, size * 0.08);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(-size * 0.42, -size * 0.17, size * 0.84, size * 0.34, size * 0.07);
      g.fill();
      // Cabin glass.
      g.fillStyle = 'rgba(30,40,46,0.8)';
      g.beginPath();
      g.roundRect(-size * 0.12, -size * 0.14, size * 0.3, size * 0.28, size * 0.04);
      g.fill();
      // Wheels.
      g.fillStyle = '#1e1e20';
      for (const [wx, wy] of [[-0.28, -0.22], [-0.28, 0.22], [0.3, -0.22], [0.3, 0.22]] as const) {
        g.beginPath();
        g.roundRect(size * wx - size * 0.06, size * wy - size * 0.05, size * 0.12, size * 0.1, 2);
        g.fill();
      }
      g.restore();
      break;
    }
    case 'pole': {
      drawShadow(g, x, y, 6, 3, 0.2);
      g.strokeStyle = vis.a;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - def.height * 0.34);
      g.lineTo(x + 10, y - def.height * 0.34);
      g.stroke();
      circle(g, x + 11, y - def.height * 0.34 + 2, 4, vis.b);
      break;
    }
    case 'fence': {
      const rot = v > 0.5 ? 0 : Math.PI / 2;
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.fillStyle = vis.a;
      g.fillRect(-size * 0.5, -3, size, 6);
      g.fillStyle = vis.b;
      for (let i = -2; i <= 2; i++) g.fillRect(i * size * 0.22 - 2, -8, 4, 16);
      g.restore();
      break;
    }
    case 'wire': {
      const rot = v > 0.5 ? 0 : Math.PI / 2;
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.strokeStyle = vis.a;
      g.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.moveTo(-size * 0.5 + i * size * 0.2, -7);
        g.lineTo(-size * 0.5 + (i + 1) * size * 0.2, 7);
        g.stroke();
        g.beginPath();
        g.moveTo(-size * 0.5 + i * size * 0.2, 7);
        g.lineTo(-size * 0.5 + (i + 1) * size * 0.2, -7);
        g.stroke();
      }
      g.restore();
      break;
    }
    case 'bed': {
      drawShadow(g, x, y, size * 0.44, size * 0.24, 0.22);
      g.save();
      g.translate(x, y);
      g.rotate(v > 0.5 ? 0 : Math.PI / 2);
      g.fillStyle = vis.b;
      g.beginPath();
      g.roundRect(-size * 0.44, -size * 0.24, size * 0.88, size * 0.48, 3);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(-size * 0.4, -size * 0.2, size * 0.5, size * 0.4, 3);
      g.fill();
      g.restore();
      break;
    }
    case 'sofa': {
      drawShadow(g, x, y, size * 0.44, size * 0.24, 0.22);
      g.save();
      g.translate(x, y);
      g.rotate(v > 0.5 ? 0 : Math.PI / 2);
      g.fillStyle = vis.b;
      g.beginPath();
      g.roundRect(-size * 0.44, -size * 0.22, size * 0.88, size * 0.44, 4);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(-size * 0.38, -size * 0.12, size * 0.76, size * 0.3, 3);
      g.fill();
      g.restore();
      break;
    }
    case 'table': {
      drawShadow(g, x, y, size * 0.38, size * 0.22, 0.22);
      g.fillStyle = vis.b;
      g.beginPath();
      g.roundRect(x - size * 0.4, y - size * 0.28, size * 0.8, size * 0.44, 3);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(x - size * 0.37, y - size * 0.31, size * 0.74, size * 0.4, 3);
      g.fill();
      break;
    }
    case 'shelf': {
      drawShadow(g, x, y, size * 0.36, size * 0.16, 0.22);
      g.fillStyle = shade(vis.a, -30);
      g.fillRect(x - size * 0.4, y - size * 0.7, size * 0.8, size * 0.7);
      g.fillStyle = vis.b;
      for (let i = 0; i < 3; i++) g.fillRect(x - size * 0.37, y - size * 0.62 + i * size * 0.22, size * 0.74, size * 0.06);
      break;
    }
    case 'well': {
      drawShadow(g, x, y, size * 0.4, size * 0.24, 0.3);
      circle(g, x, y - size * 0.06, size * 0.36, vis.a);
      circle(g, x, y - size * 0.08, size * 0.26, vis.b);
      g.strokeStyle = '#5f4128';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x - size * 0.3, y - size * 0.1);
      g.lineTo(x - size * 0.3, y - size * 0.6);
      g.lineTo(x + size * 0.3, y - size * 0.6);
      g.lineTo(x + size * 0.3, y - size * 0.1);
      g.stroke();
      break;
    }
    case 'tower': {
      drawShadow(g, x, y, size * 0.4, size * 0.22, 0.34);
      g.strokeStyle = vis.b;
      g.lineWidth = 4;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(x + side * size * 0.3, y);
        g.lineTo(x + side * size * 0.14, y - size * 0.8);
        g.stroke();
      }
      g.fillStyle = vis.a;
      g.beginPath();
      g.ellipse(x, y - size * 0.9, size * 0.34, size * 0.22, 0, 0, TAU);
      g.fill();
      g.fillStyle = shade(vis.a, -22);
      g.fillRect(x - size * 0.3, y - size * 0.9, size * 0.6, size * 0.16);
      break;
    }
    case 'sign': {
      g.strokeStyle = '#6a6e72';
      g.lineWidth = 2.4;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - size * 0.7);
      g.stroke();
      g.fillStyle = vis.b;
      g.fillRect(x - size * 0.3, y - size * 1.05, size * 0.6, size * 0.38);
      break;
    }
    case 'tire': {
      drawShadow(g, x, y, size * 0.34, size * 0.2, 0.24);
      for (let i = 0; i < 3; i++) {
        g.strokeStyle = i === 2 ? shade(vis.a, 16) : vis.a;
        g.lineWidth = size * 0.11;
        g.beginPath();
        g.arc(x, y - size * 0.06 - i * size * 0.1, size * 0.26, 0, TAU);
        g.stroke();
      }
      break;
    }
    case 'hay': {
      drawShadow(g, x, y, size * 0.4, size * 0.22, 0.28);
      g.fillStyle = vis.b;
      g.beginPath();
      g.ellipse(x, y - size * 0.24, size * 0.4, size * 0.3, 0, 0, TAU);
      g.fill();
      g.strokeStyle = vis.a;
      g.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.arc(x, y - size * 0.24, size * (0.1 + i * 0.08), 0.6, 2.6);
        g.stroke();
      }
      break;
    }
    case 'grave': {
      drawShadow(g, x, y, size * 0.3, size * 0.16, 0.24);
      g.fillStyle = vis.b;
      g.beginPath();
      g.roundRect(x - size * 0.26, y - size * 0.8, size * 0.52, size * 0.8, [size * 0.26, size * 0.26, 0, 0]);
      g.fill();
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(x - size * 0.22, y - size * 0.76, size * 0.44, size * 0.72, [size * 0.22, size * 0.22, 0, 0]);
      g.fill();
      break;
    }
    case 'sandbag': {
      drawShadow(g, x, y, size * 0.4, size * 0.2, 0.26);
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 3; i++) {
          const bx = x - size * 0.3 + i * size * 0.3 + (row % 2) * size * 0.14;
          ellipse(g, bx, y - size * 0.14 - row * size * 0.2, size * 0.17, size * 0.11, 0,
            row === 1 ? shade(vis.a, 14) : vis.a);
        }
      }
      break;
    }
    case 'log': {
      drawShadow(g, x, y, size * 0.44, size * 0.16, 0.24);
      g.save();
      g.translate(x, y);
      g.rotate(v * TAU);
      g.fillStyle = vis.a;
      g.beginPath();
      g.roundRect(-size * 0.46, -size * 0.13, size * 0.92, size * 0.26, size * 0.13);
      g.fill();
      g.fillStyle = vis.b;
      circle(g, size * 0.42, 0, size * 0.12, vis.b);
      g.restore();
      break;
    }
    case 'trash': {
      drawShadow(g, x, y, size * 0.3, size * 0.18, 0.22);
      circle(g, x, y - size * 0.16, size * 0.28, vis.a);
      circle(g, x + size * 0.14, y - size * 0.1, size * 0.19, vis.b);
      break;
    }
  }

  // Cracks appear as a resource node is worn down.
  if (damaged > 0.35) {
    g.globalAlpha = Math.min(0.5, (damaged - 0.35) * 1.2);
    g.strokeStyle = '#1a1614';
    g.lineWidth = 1.4;
    for (let i = 0; i < 3; i++) {
      const a = v * 6 + i * 2.1;
      g.beginPath();
      g.moveTo(x, y - size * 0.2);
      g.lineTo(x + Math.cos(a) * size * 0.3, y - size * 0.2 + Math.sin(a) * size * 0.2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Loot glint on unopened containers.
  if (def.container && prop.container && !prop.lootRolled) {
    g.globalAlpha = 0.55 + Math.sin(time * 3 + v * 6) * 0.2;
    circle(g, x, y - def.height * 0.35 - 6, 1.8, '#c9a227');
    g.globalAlpha = 1;
  }
  if (prop.container?.locked) {
    g.fillStyle = '#c9452a';
    g.fillRect(x - 2, y - def.height * 0.35 - 10, 4, 4);
  }
}

// ---------------------------------------------------------------------------
// Player-built structures & deployables
// ---------------------------------------------------------------------------

export function drawStructure(g: G, s: Structure): void {
  const base = TIER_COLORS[s.tier];
  const hpFrac = clamp01(s.hp / TIER_HP[s.tier]);

  if (s.kind === 'foundation' || s.kind === 'floor') {
    g.fillStyle = shade(base, -28);
    g.fillRect(s.x, s.y, s.w, s.h);
    g.fillStyle = base;
    g.fillRect(s.x + 3, s.y + 3, s.w - 6, s.h - 6);
    // Plank lines.
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(s.x + (s.w / 4) * i, s.y + 3);
      g.lineTo(s.x + (s.w / 4) * i, s.y + s.h - 3);
      g.stroke();
    }
  } else if (s.kind === 'doorway') {
    g.fillStyle = shade(base, -20);
    g.fillRect(s.x, s.y, s.w, s.h);
    // Frame only: a gap in the middle.
    g.fillStyle = 'rgba(0,0,0,0)';
    const vertical = s.h > s.w;
    g.fillStyle = shade(base, -40);
    if (vertical) g.fillRect(s.x, s.y + s.h * 0.3, s.w, s.h * 0.4);
    else g.fillRect(s.x + s.w * 0.3, s.y, s.w * 0.4, s.h);
    g.globalAlpha = 1;
  } else if (s.kind === 'door') {
    g.fillStyle = s.open ? shade(base, -45) : base;
    g.fillRect(s.x, s.y, s.w, s.h);
    if (!s.open) {
      g.fillStyle = shade(base, 18);
      const vertical = s.h > s.w;
      if (vertical) g.fillRect(s.x + 2, s.y + s.h * 0.2, s.w - 4, s.h * 0.6);
      else g.fillRect(s.x + s.w * 0.2, s.y + 2, s.w * 0.6, s.h - 4);
    }
  } else {
    // Wall: extruded slab with a highlight along the top edge.
    g.fillStyle = shade(base, -30);
    g.fillRect(s.x, s.y - 6, s.w, s.h + 6);
    g.fillStyle = base;
    g.fillRect(s.x, s.y - 6, s.w, Math.max(3, s.h * 0.5));
    g.fillStyle = shade(base, 20);
    g.fillRect(s.x, s.y - 6, s.w, 2);
  }

  // Damage overlay.
  if (hpFrac < 0.99) {
    g.globalAlpha = (1 - hpFrac) * 0.6;
    g.fillStyle = '#1a1512';
    g.fillRect(s.x, s.y - (s.kind === 'wall' ? 6 : 0), s.w, s.h + (s.kind === 'wall' ? 6 : 0));
    g.globalAlpha = 1;
  }
}

export function drawDeployable(g: G, d: Deployable, time: number): void {
  const def = itemDef(d.itemId);
  const a = def.icon.a ?? '#8a6134';
  const b = def.icon.b ?? '#6b4a27';

  switch (d.kind) {
    case 'campfire': {
      drawShadow(g, d.x, d.y, 20, 10, 0.3);
      // Stone ring.
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * TAU;
        circle(g, d.x + Math.cos(ang) * 16, d.y + Math.sin(ang) * 9, 4.5, '#77777c');
      }
      // Logs.
      g.strokeStyle = '#5f4128';
      g.lineWidth = 3.4;
      for (let i = 0; i < 3; i++) {
        const ang = i * 1.2;
        g.beginPath();
        g.moveTo(d.x - Math.cos(ang) * 9, d.y - Math.sin(ang) * 6);
        g.lineTo(d.x + Math.cos(ang) * 9, d.y + Math.sin(ang) * 6);
        g.stroke();
      }
      if (d.lit) {
        const flicker = 0.7 + Math.sin(time * 11) * 0.15 + Math.sin(time * 19) * 0.1;
        g.globalAlpha = flicker;
        circle(g, d.x, d.y - 3, 9, '#ff8c3a');
        circle(g, d.x, d.y - 5, 5, '#ffd37a');
        g.globalAlpha = 1;
      }
      break;
    }
    case 'furnace': {
      drawShadow(g, d.x, d.y, 22, 11, 0.32);
      g.fillStyle = '#6a6a70';
      g.beginPath();
      g.moveTo(d.x - 20, d.y + 8);
      g.lineTo(d.x - 14, d.y - 26);
      g.lineTo(d.x + 14, d.y - 26);
      g.lineTo(d.x + 20, d.y + 8);
      g.closePath();
      g.fill();
      g.fillStyle = '#4a4a50';
      g.fillRect(d.x - 8, d.y - 10, 16, 16);
      if (d.lit) {
        const flicker = 0.65 + Math.sin(time * 9) * 0.2;
        g.globalAlpha = flicker;
        g.fillStyle = '#ffa23c';
        g.fillRect(d.x - 6, d.y - 8, 12, 12);
        g.globalAlpha = 1;
      }
      break;
    }
    case 'workbench_1':
    case 'workbench_2':
    case 'workbench_3': {
      const tier = Number(d.kind.slice(-1));
      drawShadow(g, d.x, d.y, 30, 14, 0.3);
      g.fillStyle = shade(a, -30);
      g.fillRect(d.x - 30, d.y - 18, 60, 26);
      g.fillStyle = a;
      g.fillRect(d.x - 30, d.y - 22, 60, 10);
      // Tier badge.
      g.fillStyle = tier === 3 ? '#c9ccd1' : tier === 2 ? '#9aa0a6' : '#c9a227';
      g.fillRect(d.x - 5, d.y - 8, 10, 10);
      g.fillStyle = '#1a1d20';
      g.font = 'bold 9px Rajdhani, sans-serif';
      g.textAlign = 'center';
      g.fillText(String(tier), d.x, d.y + 0.5);
      // Tools scattered on the bench.
      g.strokeStyle = b;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(d.x + 10, d.y - 18);
      g.lineTo(d.x + 22, d.y - 14);
      g.stroke();
      break;
    }
    case 'storage_box':
    case 'large_box':
    case 'tool_cupboard': {
      const w = d.kind === 'large_box' ? 44 : 32;
      drawShadow(g, d.x, d.y, w * 0.55, 10, 0.3);
      g.fillStyle = shade(a, -28);
      g.fillRect(d.x - w / 2, d.y - 20, w, 26);
      g.fillStyle = a;
      g.fillRect(d.x - w / 2, d.y - 24, w, 12);
      g.fillStyle = b;
      g.fillRect(d.x - 4, d.y - 14, 8, 7);
      if (d.kind === 'tool_cupboard') {
        g.fillStyle = '#c9a227';
        g.fillRect(d.x - w / 2 + 3, d.y - 22, w - 6, 3);
      }
      break;
    }
    case 'sleeping_bag': {
      g.fillStyle = '#3a4456';
      g.beginPath();
      g.roundRect(d.x - 22, d.y - 13, 44, 26, 8);
      g.fill();
      g.fillStyle = '#4f5d74';
      g.beginPath();
      g.roundRect(d.x - 18, d.y - 9, 26, 18, 6);
      g.fill();
      break;
    }
    case 'water_catcher': {
      drawShadow(g, d.x, d.y, 22, 11, 0.3);
      g.fillStyle = '#5f6469';
      g.beginPath();
      g.moveTo(d.x - 22, d.y - 22);
      g.lineTo(d.x + 22, d.y - 22);
      g.lineTo(d.x + 10, d.y - 8);
      g.lineTo(d.x - 10, d.y - 8);
      g.closePath();
      g.fill();
      g.fillStyle = '#3d4449';
      g.fillRect(d.x - 10, d.y - 8, 20, 16);
      g.fillStyle = '#3d8bbf';
      g.fillRect(d.x - 9, d.y + 6 - 14 * d.charge, 18, 14 * d.charge);
      break;
    }
    case 'bear_trap': {
      g.strokeStyle = d.armed ? '#9aa0a6' : '#5f6469';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(d.x, d.y, 15, 0, TAU);
      g.stroke();
      if (d.armed) {
        g.strokeStyle = '#c9ccd1';
        g.lineWidth = 1.6;
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * TAU;
          g.beginPath();
          g.moveTo(d.x + Math.cos(ang) * 11, d.y + Math.sin(ang) * 11);
          g.lineTo(d.x + Math.cos(ang) * 17, d.y + Math.sin(ang) * 17);
          g.stroke();
        }
      }
      break;
    }
    case 'spikes': {
      g.fillStyle = '#7a5836';
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * TAU;
        const px = d.x + Math.cos(ang) * 12;
        const py = d.y + Math.sin(ang) * 8;
        g.beginPath();
        g.moveTo(px - 3, py + 4);
        g.lineTo(px, py - 9);
        g.lineTo(px + 3, py + 4);
        g.closePath();
        g.fill();
      }
      break;
    }
    default: {
      drawShadow(g, d.x, d.y, 18, 9, 0.28);
      g.fillStyle = a;
      g.fillRect(d.x - 14, d.y - 16, 28, 22);
      g.fillStyle = b;
      g.fillRect(d.x - 10, d.y - 12, 20, 8);
    }
  }
}

/** Colours used to tint worn apparel on the player sprite. */
const APPAREL_COLOR: Record<string, string> = {
  shirt: '#9aa0a6', hoodie: '#4a5568', jacket_leather: '#4a3226', hide_vest: '#7a5533',
  kevlar_vest: '#3a3f35', plate_carrier: '#6b7076', ghillie: '#4a5a32',
  pants_cloth: '#5a6068', jeans: '#3a4f6b', pants_tactical: '#3a3f35', leg_plates: '#6b7076',
  backpack_small: '#5a4a32', backpack_large: '#3a4a32', backpack_military: '#4a5240',
  helmet_riot: '#2f3337', helmet_military: '#4a5240',
};

export { PROP_VISUALS, lerp };
