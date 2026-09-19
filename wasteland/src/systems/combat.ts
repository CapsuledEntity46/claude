/**
 * Combat: firing, reloading, melee swings, harvesting and throwing.
 *
 * All of it operates on the player's held belt item, reading the `ranged`,
 * `melee` and `throwable` blocks from the item database.
 */

import { circleInCone, clamp01 } from '../core/math';
import { audio } from '../core/audio';
import { attachmentMods, damageItem, durabilityFrac, type ItemStack } from '../items/item';
import { ammoFor, itemDef, type MeleeStats } from '../items/itemdefs';
import { PROPS } from '../world/props';
import { Thrown } from '../entities/projectile';
import type { Game } from '../game';

const DEG = Math.PI / 180;

/** Which ammo id is loaded, or the best available one. */
function preferredAmmo(game: Game, weapon: ItemStack): string | null {
  const r = itemDef(weapon.id).ranged!;
  const candidates = ammoFor(r.ammo);
  if (weapon.magAmmo && game.player.countItem(weapon.magAmmo) > 0) return weapon.magAmmo;
  // Pick whatever the player actually has, preferring the heavier variant.
  let best: string | null = null;
  let bestDamage = -1;
  for (const id of candidates) {
    if (game.player.countItem(id) <= 0) continue;
    const d = itemDef(id);
    const score = d.rarity === 'common' ? 1 : 2;
    if (score > bestDamage) { bestDamage = score; best = id; }
  }
  return best;
}

/** Total rounds of compatible ammo the player is carrying. */
export function reserveAmmo(game: Game, weapon: ItemStack): number {
  const r = itemDef(weapon.id).ranged;
  if (!r) return 0;
  let n = 0;
  for (const id of ammoFor(r.ammo)) n += game.player.countItem(id);
  return n;
}

// ===========================================================================
// Ranged
// ===========================================================================

/** Attempt to fire the held weapon. Returns true if a shot went off. */
export function tryFire(game: Game, trigger: 'press' | 'hold'): boolean {
  const player = game.player;
  const held = player.heldItem;
  if (!held) return false;
  const def = itemDef(held.id);
  const r = def.ranged;
  if (!r) return false;

  if (player.isBusy || player.fireCooldown > 0 || player.stun > 0) return false;
  if (!r.auto && trigger === 'hold') return false;

  // Bows must be drawn first.
  if (r.draw && player.drawCharge < 1) return false;

  if ((held.mag ?? 0) <= 0) {
    // Click. Then try to reload for the player's convenience.
    audio.play('dry_fire', player.x, player.y, { volume: 0.7 });
    player.fireCooldown = 0.3;
    tryReload(game);
    return false;
  }

  const mods = attachmentMods(held);
  const wear = durabilityFrac(held);

  // Spread: hip-fire cone, tightened by aiming and attachments, widened by recoil,
  // fatigue and a worn-out weapon.
  let spreadDeg = r.spread * mods.spread;
  if (player.aiming) spreadDeg *= r.adsSpread;
  spreadDeg += Math.abs(player.recoil) * 28;
  if (player.stamina < 25) spreadDeg *= 1.4;
  if (player.moveX !== 0 || player.moveY !== 0) spreadDeg *= player.sprinting ? 2.1 : 1.35;
  spreadDeg *= 1 + (1 - wear) * 0.6;

  const baseAngle = game.aimAngle;
  const pellets = r.pellets ?? 1;
  const muzzleX = player.x + Math.cos(player.facing) * 18;
  const muzzleY = player.y + Math.sin(player.facing) * 18;

  const charge = r.draw ? player.drawCharge : 1;
  const ammoId = held.magAmmo ?? null;
  const ammoDef = ammoId ? itemDef(ammoId) : null;
  // Slugs and bone arrows change the profile of the weapon firing them.
  const isSlug = ammoId === 'ammo_slug';
  const bleed = ammoId === 'arrow_bone' ? 4 : ammoId === 'ammo_slug' ? 2 : 0;

  for (let i = 0; i < (isSlug ? 1 : pellets); i++) {
    const jitter = game.rng.gauss() * spreadDeg * DEG * 0.5;
    const angle = baseAngle + jitter + player.recoil * 0.35;
    game.spawnBullet({
      x: muzzleX,
      y: muzzleY,
      angle,
      speed: r.velocity * (0.9 + charge * 0.1),
      damage: r.damage * charge * (isSlug ? pellets * 0.72 : 1) * (0.85 + wear * 0.15),
      range: r.range * (isSlug ? 1.6 : 1),
      faction: 'player',
      owner: player,
      critMul: r.critMul,
      bleed,
      explode: r.explode,
      recoverItem: ammoDef && (ammoDef.ammoKind === 'arrow' || ammoDef.ammoKind === 'bolt') ? ammoId! : undefined,
      tracer: r.ammo === 'arrow' || r.ammo === 'bolt' ? 0 : 1,
    });
  }

  held.mag = (held.mag ?? 0) - 1;
  player.fireCooldown = 60 / r.rpm + (r.cycle ?? 0);
  player.drawCharge = 0;

  // Recoil kicks the aim, alternating sides so it walks realistically.
  const recoilAmount = r.recoil * mods.recoil * DEG * (player.aiming ? 0.6 : 1) * (1 - player.protection * 0.1);
  player.recoil += recoilAmount * (game.rng.bool() ? 1 : -1) * (1 + game.rng.float(0, 0.4));
  player.muzzleFlash = 1;

  const silenced = mods.silence;
  audio.play(silenced ? 'shoot_silenced' : r.sound, player.x, player.y, { volume: 1 });
  game.effects.muzzle(muzzleX, muzzleY, player.facing, silenced ? r.flash * 0.35 : r.flash);
  if (r.ammo !== 'arrow' && r.ammo !== 'bolt' && r.ammo !== 'rocket') game.effects.casing(muzzleX, muzzleY, player.facing);
  game.effects.shake = Math.max(game.effects.shake, r.recoil * 0.35);

  // Gunfire is the loudest thing in the world.
  game.alertZombies(player.x, player.y, r.noise * (silenced ? 0.2 : 1), 1);

  if (damageItem(held, 1)) {
    game.toast(`${def.name} broke!`, 'bad');
    player.removeStack(held);
  }
  return true;
}

/** Charge a bow/crossbow while the trigger is held. */
export function updateDraw(game: Game, dt: number, holding: boolean): void {
  const player = game.player;
  const held = player.heldItem;
  const r = held ? itemDef(held.id).ranged : null;
  if (!r?.draw) { player.drawCharge = 0; return; }
  if ((held!.mag ?? 0) <= 0) { player.drawCharge = 0; return; }

  if (holding && !player.isBusy) {
    if (player.drawCharge < 1) {
      player.drawCharge = clamp01(player.drawCharge + dt / r.draw);
      // Holding a bow at full draw is tiring.
      if (player.drawCharge >= 1) player.stamina = Math.max(0, player.stamina - dt * 3);
    }
  } else if (!holding) {
    player.drawCharge = Math.max(0, player.drawCharge - dt * 2);
  }
  void game;
}

/** Start a reload if it makes sense. */
export function tryReload(game: Game): boolean {
  const player = game.player;
  const held = player.heldItem;
  if (!held) return false;
  const def = itemDef(held.id);
  const r = def.ranged;
  if (!r) return false;
  if (player.isBusy) return false;
  if ((held.mag ?? 0) >= r.magSize) return false;

  const ammoId = preferredAmmo(game, held);
  if (!ammoId) {
    game.toast(`No ${def.name} ammunition`, 'warn');
    return false;
  }

  player.startAction('reload', r.reload, held);
  audio.play('reload_out', player.x, player.y, { volume: 0.8 });
  return true;
}

/** Called when the reload action timer completes. */
export function finishReload(game: Game): void {
  const player = game.player;
  const held = player.actionItem;
  if (!held) return;
  const def = itemDef(held.id);
  const r = def.ranged;
  if (!r) return;

  const ammoId = preferredAmmo(game, held);
  if (!ammoId) return;

  // Switching ammo types ejects what's already loaded.
  if (held.magAmmo && held.magAmmo !== ammoId && (held.mag ?? 0) > 0) {
    player.giveItem(held.magAmmo, held.mag!);
    held.mag = 0;
  }

  const want = r.singleLoad ? 1 : r.magSize - (held.mag ?? 0);
  const got = player.takeItem(ammoId, want);
  if (got <= 0) return;

  held.mag = (held.mag ?? 0) + got;
  held.magAmmo = ammoId;
  audio.play('reload_in', player.x, player.y, { volume: 0.85 });

  // Pumps and revolvers keep loading until full or out of ammo.
  if (r.singleLoad && (held.mag ?? 0) < r.magSize && player.countItem(ammoId) > 0) {
    player.startAction('reload', r.reload, held);
  } else {
    player.cancelAction();
    if (r.cycle) audio.play('bolt', player.x, player.y, { volume: 0.7 });
  }
}

// ===========================================================================
// Melee
// ===========================================================================

/** Swing the held melee weapon (or fists). */
export function tryMelee(game: Game): boolean {
  const player = game.player;
  if (player.isBusy || player.swingTime > 0 || player.stun > 0) return false;

  const held = player.heldItem;
  const def = held ? itemDef(held.id) : null;
  const m = def?.melee ?? FISTS;

  if (player.stamina < m.stamina * 0.5) {
    return false;
  }

  if (!player.startSwing(m.speed)) return false;
  player.stamina = Math.max(0, player.stamina - m.stamina);
  audio.play('swing', player.x, player.y, { volume: 0.8, pitch: 1 / (0.6 + m.speed) });
  game.alertZombies(player.x, player.y, m.noise, 0.4);
  return true;
}

/** Resolve the damage window of an in-flight swing. Called once per swing. */
export function resolveSwing(game: Game): void {
  const player = game.player;
  const held = player.heldItem;
  const def = held ? itemDef(held.id) : null;
  const m = def?.melee ?? FISTS;

  const halfArc = (m.arc * DEG) / 2;
  const reach = m.range;
  let hitSomething = false;

  // --- actors ---
  const targets = game.actorsNear(player.x, player.y, reach + 40);
  // Sort so the closest target takes the hit first.
  targets.sort((a, b) => a.dist2To(player.x, player.y) - b.dist2To(player.x, player.y));

  let hits = 0;
  for (const a of targets) {
    if (!a.alive || a === player) continue;
    if (a.faction === 'player') continue;
    // Don't accidentally beat your own horse while riding it.
    if (player.mount && a === player.mount) continue;
    if (!circleInCone(player.x, player.y, player.facing, reach, halfArc, a.x, a.y, a.radius)) continue;
    if (!game.world.hasLineOfSight(player.x, player.y, a.x, a.y)) continue;

    const angle = player.angleTo(a.x, a.y);
    const crit = game.rng.bool(0.12);
    const dmg = m.damage * (crit ? 1.8 : 1) * (held ? 0.6 + durabilityFrac(held) * 0.4 : 1);

    a.takeDamage({
      amount: dmg,
      type: 'melee',
      angle,
      knockback: m.knockback,
      bleed: m.bleed && game.rng.bool(m.bleed) ? 4 : 0,
      source: player,
      crit,
    });
    game.effects.blood(a.x, a.y, angle, dmg);
    game.effects.damageNumber(a.x, a.y, Math.round(dmg), crit);
    audio.play('hit_flesh', a.x, a.y, { volume: 0.9 });
    game.onPlayerHit(crit);
    hitSomething = true;

    // Wide weapons cleave through a couple of targets; pointy ones don't.
    if (++hits >= (m.arc > 80 ? 3 : 1)) break;
  }

  // --- harvestable props & structures ---
  if (!hitSomething || m.power > 1) {
    harvestSwing(game, m.power, m.classes, reach, halfArc);
  }

  if (held && damageItem(held, hitSomething ? 1.5 : 1)) {
    game.toast(`${itemDef(held.id).name} broke!`, 'bad');
    player.removeStack(held);
  }
}

/** Chop/mine whatever is in the swing arc. */
function harvestSwing(
  game: Game, power: number, classes: readonly string[], reach: number, halfArc: number,
): void {
  const player = game.player;

  // Props (trees, ore, furniture).
  const props = game.world.propsNear(player.x - reach - 40, player.y - reach - 40, (reach + 40) * 2, (reach + 40) * 2);
  let best: (typeof props)[number] | null = null;
  let bestD = Infinity;
  for (const p of props) {
    const pd = PROPS[p.kind];
    const r = Math.max(pd.radius, pd.size * 0.35);
    if (!circleInCone(player.x, player.y, player.facing, reach + r * 0.5, halfArc, p.x, p.y, r)) continue;
    const d = player.distTo(p.x, p.y);
    if (d < bestD) { bestD = d; best = p; }
  }

  if (best) {
    const pd = PROPS[best.kind];
    if (pd.harvest) {
      const matched = classes.includes(pd.harvest.tool);
      const damage = Math.max(1, power * (matched ? 10 : 2.2));
      game.harvestProp(best, damage, matched);
      return;
    }
    if (pd.hp !== undefined) {
      game.damageProp(best, power * 8, 'melee');
      audio.play('hit_wood', best.x, best.y, { volume: 0.7 });
      return;
    }
  }

  // Player-built structures: hammer upgrades, tools damage.
  const s = game.world.structureAt(
    player.x + Math.cos(player.facing) * reach * 0.7,
    player.y + Math.sin(player.facing) * reach * 0.7,
    8,
  );
  if (s && classes.includes('building')) {
    game.damageStructure(s, power * 14);
    audio.play('hit_wood', s.x, s.y, { volume: 0.7 });
  }
}

/** Fallback stats when the player's hands are empty. */
const FISTS: MeleeStats = {
  damage: 7, range: 40, arc: 55, speed: 0.4, stamina: 3,
  knockback: 30, power: 0.3, classes: ['flesh'], noise: 70,
};

// ===========================================================================
// Throwables
// ===========================================================================

/** Throw the held throwable, or hurl a spear. */
export function tryThrow(game: Game): boolean {
  const player = game.player;
  if (player.isBusy || player.stun > 0 || player.fireCooldown > 0) return false;

  const held = player.heldItem;
  if (!held) return false;
  const def = itemDef(held.id);
  const t = def.throwable;
  if (!t) return false;

  const angle = game.aimAngle;
  const speed = t.velocity * (0.85 + clamp01(player.stamina / 100) * 0.15);

  game.addThrown(new Thrown(
    held.id,
    player.x + Math.cos(angle) * 18,
    player.y + Math.sin(angle) * 18,
    angle, speed,
    t.kind,
    t.damage, t.radius, t.fuse,
    player, 'player', t.burn ?? 0,
  ));

  audio.play('throw', player.x, player.y, { volume: 0.7 });
  player.fireCooldown = 0.6;
  player.stamina = Math.max(0, player.stamina - 5);

  // Consume one. Spears are single items, so this removes the weapon itself.
  held.count -= 1;
  if (held.count <= 0) player.removeStack(held);

  game.alertZombies(player.x, player.y, 180, 0.4);
  return true;
}
