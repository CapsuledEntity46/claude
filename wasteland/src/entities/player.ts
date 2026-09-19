import { clamp, clamp01, damp, lerp } from '../core/math';
import { Container } from '../items/container';
import { damageItem, durabilityFrac, makeStack, type ItemStack } from '../items/item';
import { EQUIP_SLOTS, itemDef, type EquipSlot, type ItemDef } from '../items/itemdefs';
import type { World } from '../world/world';
import { Actor, type DamageInfo, type Faction } from './actor';
import type { Horse } from './horse';

export const BELT_SLOTS = 6;
export const INV_COLS = 6;
export const INV_BASE_ROWS = 4;

export type ActionKind = 'none' | 'reload' | 'consume' | 'harvest' | 'swing' | 'draw' | 'deploy' | 'revive';

export interface StatusFlags {
  bleeding: boolean;
  infected: boolean;
  cold: boolean;
  hot: boolean;
  starving: boolean;
  dehydrated: boolean;
  exhausted: boolean;
  overweight: boolean;
  brokenLeg: boolean;
  painkillers: boolean;
  wet: boolean;
}

/**
 * The player character.
 *
 * Holds inventory/equipment, the survival meters, and all the timing state that
 * combat reads (fire cadence, reload progress, swing windows, bow draw).
 */
export class Player extends Actor {
  readonly faction: Faction = 'player';

  inventory = new Container('player', INV_COLS, INV_BASE_ROWS, 'Inventory');
  /** Rust-style belt: six slots that ignore item footprints. */
  belt: (ItemStack | null)[] = new Array(BELT_SLOTS).fill(null);
  equipment: Record<EquipSlot, ItemStack | null> = {
    head: null, face: null, chest: null, hands: null, legs: null, feet: null, back: null,
  };

  activeSlot = 0;

  // --- survival meters ---
  food = 85;
  water = 85;
  stamina = 100;
  maxStamina = 100;
  /** Core body temperature in degrees C. */
  bodyTemp = 36.6;
  /** 0..100; rises from bites, drains health once high. */
  infection = 0;
  /** Seconds of painkiller effect remaining. */
  painkillers = 0;
  /** Seconds of regeneration remaining from bandages/medkits. */
  private regenAmount = 0;
  private regenTime = 0;
  /** Soaked by rain/water, accelerates heat loss. */
  wetness = 0;
  brokenLeg = false;

  // --- movement state ---
  sprinting = false;
  crouching = false;
  aiming = false;
  private staminaIdle = 0;

  // --- weapon state ---
  /** Seconds until the held weapon can fire again. */
  fireCooldown = 0;
  /** Accumulated recoil in radians, decays back to zero. */
  recoil = 0;
  /** Bow/crossbow draw progress 0..1. */
  drawCharge = 0;
  /** Current long action. */
  action: ActionKind = 'none';
  actionTime = 0;
  actionTotal = 0;
  /** Item the current action operates on. */
  actionItem: ItemStack | null = null;
  /** Melee swing progress; drives the arc animation and the damage window. */
  swingTime = 0;
  swingTotal = 0;
  private swingHit = false;
  /** Set while the muzzle flash should render. */
  muzzleFlash = 0;
  flashlightOn = false;

  /** Horse currently being ridden. */
  mount: Horse | null = null;

  // --- progression / stats ---
  respawnPoint: { x: number; y: number } | null = null;
  kills = 0;
  zombieKills = 0;
  distanceTravelled = 0;
  itemsCrafted = 0;
  timeAlive = 0;
  deathCause = '';

  constructor(x: number, y: number) {
    super(x, y, 100);
    this.radius = 13;
    this.speed = 158;
  }

  // -------------------------------------------------------------------------
  // Equipment-derived stats
  // -------------------------------------------------------------------------

  /** Total damage reduction from worn armour, 0..~0.75. */
  get protection(): number {
    let sum = 0;
    for (const slot of EQUIP_SLOTS) {
      const it = this.equipment[slot];
      if (!it) continue;
      const a = itemDef(it.id).armor;
      if (a) sum += a.protection * lerp(0.35, 1, durabilityFrac(it));
    }
    return clamp(sum, 0, 0.78);
  }

  /** Insulation in degrees C. */
  get warmth(): number {
    let sum = 0;
    for (const slot of EQUIP_SLOTS) {
      const it = this.equipment[slot];
      if (!it) continue;
      const a = itemDef(it.id).armor;
      if (a) sum += a.warmth;
    }
    return sum;
  }

  get bulk(): number {
    let sum = 0;
    for (const slot of EQUIP_SLOTS) {
      const it = this.equipment[slot];
      if (!it) continue;
      const a = itemDef(it.id).armor;
      if (a?.bulk) sum += a.bulk;
    }
    return sum;
  }

  get hasNightVision(): boolean {
    const face = this.equipment.face;
    return !!face && itemDef(face.id).armor?.vision === 'night';
  }

  get hasGasMask(): boolean {
    const face = this.equipment.face;
    return !!face && itemDef(face.id).armor?.vision === 'gas';
  }

  /** Reduces how far away enemies notice you. */
  get stealth(): number {
    let s = 1;
    const chest = this.equipment.chest;
    if (chest && chest.id === 'ghillie') s *= 0.45;
    if (this.crouching) s *= 0.55;
    if (this.sprinting) s *= 1.5;
    return s;
  }

  get carriedWeight(): number {
    let w = this.inventory.weight;
    for (const b of this.belt) if (b) w += itemDef(b.id).weight * b.count;
    for (const slot of EQUIP_SLOTS) {
      const it = this.equipment[slot];
      if (it) w += itemDef(it.id).weight;
    }
    return w;
  }

  get weightLimit(): number { return 32; }

  /** Recompute inventory grid size after a backpack change. Returns evicted items. */
  refreshCapacity(): ItemStack[] {
    const back = this.equipment.back;
    const extra = back ? (itemDef(back.id).armor?.rows ?? 0) : 0;
    const rows = INV_BASE_ROWS + extra;
    if (rows === this.inventory.rows) return [];
    return this.inventory.resize(INV_COLS, rows);
  }

  // -------------------------------------------------------------------------
  // Held item helpers
  // -------------------------------------------------------------------------

  get heldItem(): ItemStack | null { return this.belt[this.activeSlot] ?? null; }
  get heldDef(): ItemDef | null {
    const h = this.heldItem;
    return h ? itemDef(h.id) : null;
  }

  selectSlot(i: number): void {
    if (i < 0 || i >= BELT_SLOTS) return;
    if (i === this.activeSlot) return;
    this.activeSlot = i;
    this.cancelAction();
    this.drawCharge = 0;
    this.fireCooldown = Math.max(this.fireCooldown, 0.28); // weapon swap delay
  }

  cancelAction(): void {
    this.action = 'none';
    this.actionTime = 0;
    this.actionTotal = 0;
    this.actionItem = null;
  }

  startAction(kind: ActionKind, seconds: number, item: ItemStack | null = null): void {
    this.action = kind;
    this.actionTotal = seconds;
    this.actionTime = 0;
    this.actionItem = item;
  }

  get actionProgress(): number {
    return this.actionTotal > 0 ? clamp01(this.actionTime / this.actionTotal) : 0;
  }

  get isBusy(): boolean { return this.action !== 'none'; }

  /** Begin a melee swing; returns false when one is already in flight. */
  startSwing(duration: number): boolean {
    if (this.swingTime > 0) return false;
    this.swingTotal = duration;
    this.swingTime = duration;
    this.swingHit = false;
    return true;
  }

  /** True exactly once per swing, at the point the arc should connect. */
  consumeSwingHit(): boolean {
    if (this.swingHit || this.swingTime <= 0) return false;
    // Damage lands slightly after the start, around 45% through the animation.
    if (this.swingTime <= this.swingTotal * 0.55) {
      this.swingHit = true;
      return true;
    }
    return false;
  }

  /** Normalised swing animation phase, 0 at start, 1 at end. */
  get swingPhase(): number {
    return this.swingTotal > 0 ? 1 - this.swingTime / this.swingTotal : 0;
  }

  // -------------------------------------------------------------------------
  // Inventory operations
  // -------------------------------------------------------------------------

  /** Try to store a stack. Returns leftover count that didn't fit. */
  give(stack: ItemStack): number {
    // Prefer merging into the belt so ammo you're using tops up in place.
    for (const b of this.belt) {
      if (!b || stack.count <= 0) continue;
      if (b.id !== stack.id) continue;
      const max = itemDef(b.id).stack;
      if (max <= 1 || b.count >= max) continue;
      const moved = Math.min(max - b.count, stack.count);
      b.count += moved;
      stack.count -= moved;
    }
    if (stack.count <= 0) return 0;
    const left = this.inventory.add(stack);
    if (left > 0) {
      // Grid is full — fall back to an empty belt slot. `add` already reduced
      // the stack's count to the leftover, so the object can be reused as-is.
      const free = this.belt.indexOf(null);
      if (free >= 0) {
        this.belt[free] = stack;
        return 0;
      }
    }
    return left;
  }

  /** Give `count` units of an id, splitting into stacks as needed. */
  giveItem(id: string, count = 1): number {
    let remaining = count;
    const max = itemDef(id).stack;
    let guard = 0;
    while (remaining > 0 && guard++ < 512) {
      const chunk = Math.min(remaining, max);
      const stack = makeStack(id, chunk);
      const left = this.give(stack);
      remaining -= chunk - left;
      if (left > 0) break; // no room anywhere
    }
    return remaining;
  }

  /** Total units of an id across inventory and belt. */
  countItem(id: string): number {
    let n = this.inventory.countOf(id);
    for (const b of this.belt) if (b && b.id === id) n += b.count;
    return n;
  }

  /** Consume up to n units from belt then inventory. */
  takeItem(id: string, n: number): number {
    let need = n;
    for (let i = 0; i < this.belt.length && need > 0; i++) {
      const b = this.belt[i];
      if (!b || b.id !== id) continue;
      const take = Math.min(need, b.count);
      b.count -= take;
      need -= take;
      if (b.count <= 0) this.belt[i] = null;
    }
    if (need > 0) need -= this.inventory.take(id, need);
    return n - need;
  }

  /** Remove a specific stack wherever it lives. */
  removeStack(stack: ItemStack): boolean {
    const bi = this.belt.indexOf(stack);
    if (bi >= 0) { this.belt[bi] = null; return true; }
    for (const slot of EQUIP_SLOTS) {
      if (this.equipment[slot] === stack) { this.equipment[slot] = null; return true; }
    }
    return this.inventory.removeStack(stack);
  }

  /** Find the first medical item that stops bleeding, for the quick-heal key. */
  findBandage(): ItemStack | null {
    for (const b of this.belt) if (b && itemDef(b.id).consume?.stopBleed) return b;
    const found = this.inventory.find((s) => !!itemDef(s.id).consume?.stopBleed);
    return found ? found.stack : null;
  }

  /** Best healing item available. */
  findHeal(): ItemStack | null {
    const score = (s: ItemStack) => {
      const c = itemDef(s.id).consume;
      if (!c) return -1;
      return (c.health ?? 0) + (c.regen ?? 0);
    };
    let best: ItemStack | null = null;
    const consider = (s: ItemStack | null) => {
      if (!s) return;
      if (score(s) <= 0) return;
      if (!best || score(s) > score(best)) best = s;
    };
    for (const b of this.belt) consider(b);
    for (const it of this.inventory.items) consider(it.stack);
    return best;
  }

  // -------------------------------------------------------------------------
  // Damage & healing
  // -------------------------------------------------------------------------

  override takeDamage(info: DamageInfo): number {
    if (this.dead) return 0;
    let amount = info.amount;

    // Armour only mitigates physical damage.
    if (info.type === 'bullet' || info.type === 'melee' || info.type === 'claw' || info.type === 'explosion') {
      const slots = pickHitSlots(info.type);
      let absorbed = 0;
      for (const slot of slots) {
        const piece = this.equipment[slot];
        if (!piece) continue;
        const a = itemDef(piece.id).armor;
        if (!a) continue;
        const eff = a.protection * lerp(0.35, 1, durabilityFrac(piece));
        absorbed += eff;
        // Armour wears out as it works.
        if (damageItem(piece, amount * 0.55)) this.equipment[slot] = null;
      }
      amount *= 1 - clamp(absorbed, 0, 0.78);
    }

    if (this.painkillers > 0) amount *= 0.75;

    // A big hit to the legs can break them.
    if (info.type === 'fall' || (amount > 26 && info.type !== 'bleed' && Math.random() < 0.12)) {
      this.brokenLeg = true;
    }

    return super.takeDamage({ ...info, amount });
  }

  /** Zombie bites can transmit infection through unprotected skin. */
  applyBiteRisk(chance: number): void {
    const covered = (this.equipment.chest ? 0.4 : 0) + (this.equipment.legs ? 0.2 : 0) + (this.equipment.hands ? 0.15 : 0);
    if (Math.random() < chance * (1 - covered)) this.infection = Math.max(this.infection, 8);
  }

  startRegen(amount: number, seconds: number): void {
    this.regenAmount += amount;
    this.regenTime = Math.max(this.regenTime, seconds);
  }

  cureInfection(): void { this.infection = 0; }

  get status(): StatusFlags {
    return {
      bleeding: this.bleed > 0.1,
      infected: this.infection > 5,
      cold: this.bodyTemp < 35.4,
      hot: this.bodyTemp > 38.2,
      starving: this.food <= 0.5,
      dehydrated: this.water <= 0.5,
      exhausted: this.stamina < 12,
      overweight: this.carriedWeight > this.weightLimit,
      brokenLeg: this.brokenLeg,
      painkillers: this.painkillers > 0,
      wet: this.wetness > 0.4,
    };
  }

  // -------------------------------------------------------------------------
  // Per-tick update
  // -------------------------------------------------------------------------

  protected override speedMultiplier(world: World): number {
    let mul = super.speedMultiplier(world);
    if (this.crouching) mul *= 0.52;
    if (this.sprinting && this.stamina > 0) mul *= 1.72;
    if (this.aiming) mul *= 0.58;
    if (this.isBusy && this.action !== 'reload') mul *= 0.6;
    if (this.brokenLeg) mul *= 0.55;
    mul *= 1 - this.bulk;

    // Hauling too much slows you down sharply.
    const over = this.carriedWeight - this.weightLimit;
    if (over > 0) mul *= clamp(1 - over / 30, 0.4, 1);

    if (this.stamina <= 0) mul *= 0.78;
    if (this.food <= 0) mul *= 0.85;
    return mul;
  }

  /**
   * Survival metabolism: hunger, thirst, temperature, stamina and status effects.
   * `ambient` is the local air temperature; `nearFire` adds radiated heat.
   */
  updateSurvival(dt: number, ambient: number, nearFire: number, raining: boolean, indoors: boolean): void {
    this.timeAlive += dt;

    // --- exertion multiplies consumption ---
    const moving = Math.hypot(this.moveX, this.moveY) > 0.1;
    const exertion = this.sprinting && moving ? 2.3 : moving ? 1.25 : 1;

    this.food = clamp(this.food - dt * 0.075 * exertion, 0, 100);
    this.water = clamp(this.water - dt * 0.105 * exertion, 0, 100);

    // --- stamina ---
    if (this.sprinting && moving) {
      this.stamina = clamp(this.stamina - dt * 14, 0, this.maxStamina);
      this.staminaIdle = 0;
    } else {
      this.staminaIdle += dt;
      if (this.staminaIdle > 0.7) {
        // Regen is gated by nutrition — starving players can't sprint far.
        const quality = 0.35 + 0.65 * clamp01(Math.min(this.food, this.water) / 45);
        this.stamina = clamp(this.stamina + dt * 17 * quality, 0, this.maxStamina);
      }
    }
    if (this.stamina <= 0) this.sprinting = false;

    // --- wetness ---
    if (raining && !indoors) this.wetness = clamp01(this.wetness + dt * 0.08);
    else if (this.inWater) this.wetness = 1;
    else this.wetness = clamp01(this.wetness - dt * (nearFire > 0 ? 0.12 : 0.02));

    // --- temperature ---
    // Perceived temperature: ambient + insulation + fire, minus evaporative cooling.
    const feels = ambient + this.warmth * 0.42 + nearFire - this.wetness * 8 + (moving ? 1.5 : 0);
    const target = clamp(36.6 + (feels - 20) * 0.11, 30, 42);
    this.bodyTemp = damp(this.bodyTemp, target, 0.09, dt);

    if (this.bodyTemp < 35.4) {
      const severity = (35.4 - this.bodyTemp) / 3;
      this.takeDamage({ amount: dt * 3.2 * severity, type: 'cold' });
      this.stamina = clamp(this.stamina - dt * 4 * severity, 0, this.maxStamina);
    } else if (this.bodyTemp > 38.4) {
      const severity = (this.bodyTemp - 38.4) / 3;
      this.takeDamage({ amount: dt * 2.4 * severity, type: 'cold' });
      this.water = clamp(this.water - dt * 1.6 * severity, 0, 100);
    }

    // --- starvation & dehydration ---
    if (this.food <= 0) this.takeDamage({ amount: dt * 0.85, type: 'bleed' });
    if (this.water <= 0) this.takeDamage({ amount: dt * 1.3, type: 'bleed' });

    // --- infection ---
    if (this.infection > 0) {
      this.infection = clamp(this.infection + dt * 0.28, 0, 100);
      if (this.infection > 35) this.takeDamage({ amount: dt * (this.infection / 100) * 2.2, type: 'bleed' });
    }

    // --- drowning ---
    if (this.inWater && this.stamina <= 0) this.takeDamage({ amount: dt * 6, type: 'drown' });

    // --- regeneration from medical items ---
    if (this.regenTime > 0) {
      const rate = this.regenAmount / Math.max(0.1, this.regenTime);
      const tick = Math.min(this.regenAmount, rate * dt);
      this.heal(tick);
      this.regenAmount -= tick;
      this.regenTime -= dt;
      if (this.regenTime <= 0 || this.regenAmount <= 0) { this.regenTime = 0; this.regenAmount = 0; }
    } else if (this.food > 55 && this.water > 55 && this.bleed <= 0 && this.infection < 10) {
      // Passive regeneration while well fed.
      this.heal(dt * 0.55);
    }

    this.painkillers = Math.max(0, this.painkillers - dt);

    // --- timers ---
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 6);
    this.recoil = damp(this.recoil, 0, 6, dt);
    if (this.swingTime > 0) this.swingTime = Math.max(0, this.swingTime - dt);
    if (this.isBusy) {
      this.actionTime += dt;
      if (this.actionTime >= this.actionTotal) {
        // The owning system checks `actionProgress >= 1` and finalises.
        this.actionTime = this.actionTotal;
      }
    }

    // Broken legs heal slowly once you stop taking damage.
    if (this.brokenLeg && this.regenTime > 0) this.brokenLeg = false;
  }

  serialize() {
    return {
      x: this.x, y: this.y, hp: this.hp, food: this.food, water: this.water,
      stamina: this.stamina, bodyTemp: this.bodyTemp, infection: this.infection,
      wetness: this.wetness, brokenLeg: this.brokenLeg, bleed: this.bleed,
      activeSlot: this.activeSlot,
      inventory: this.inventory.serialize(),
      belt: this.belt.map((b) => (b ? { ...b } : null)),
      equipment: Object.fromEntries(EQUIP_SLOTS.map((s) => [s, this.equipment[s] ? { ...this.equipment[s]! } : null])),
      respawnPoint: this.respawnPoint,
      kills: this.kills, zombieKills: this.zombieKills, itemsCrafted: this.itemsCrafted,
      timeAlive: this.timeAlive, distanceTravelled: this.distanceTravelled,
    };
  }
}

/** Slots a hit can land on, weighted toward the torso. */
function pickHitSlots(type: string): EquipSlot[] {
  if (type === 'explosion') return [...EQUIP_SLOTS];
  const r = Math.random();
  if (r < 0.42) return ['chest'];
  if (r < 0.6) return ['legs'];
  if (r < 0.74) return ['head'];
  if (r < 0.84) return ['back'];
  if (r < 0.92) return ['hands'];
  if (r < 0.97) return ['feet'];
  return ['face'];
}
