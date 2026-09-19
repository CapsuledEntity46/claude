import { itemDef, type ItemDef } from './itemdefs';

let nextUid = 1;

/** A concrete instance of an item, possibly a stack of them. */
export interface ItemStack {
  /** Unique instance id — lets the DOM inventory diff without rebuilding. */
  uid: number;
  id: string;
  count: number;
  /** Remaining durability; undefined for items without a durability stat. */
  dur?: number;
  /** Rounds currently chambered in this weapon. */
  mag?: number;
  /** Which ammo id is loaded, so swapping ammo types is meaningful. */
  magAmmo?: string;
  /** Attachment item ids fitted to this weapon. */
  attachments?: string[];
}

export function makeStack(id: string, count = 1): ItemStack {
  const d = itemDef(id);
  const s: ItemStack = { uid: nextUid++, id, count: Math.max(1, Math.min(count, d.stack)) };
  if (d.durability !== undefined) s.dur = d.durability;
  if (d.ranged) { s.mag = 0; s.attachments = []; }
  return s;
}

/** Rehydrate a stack from save data, preserving uid uniqueness. */
export function reviveStack(raw: ItemStack): ItemStack {
  const s: ItemStack = { ...raw, uid: nextUid++ };
  return s;
}

export const defOf = (s: ItemStack): ItemDef => itemDef(s.id);

export const isStackable = (s: ItemStack): boolean => {
  const d = itemDef(s.id);
  // Anything tracking per-instance state must stay unique.
  return d.stack > 1 && d.durability === undefined && !d.ranged;
};

/** Can `b` be merged into `a`? */
export function canMerge(a: ItemStack, b: ItemStack): boolean {
  if (a.id !== b.id) return false;
  if (!isStackable(a) || !isStackable(b)) return false;
  return a.count < itemDef(a.id).stack;
}

/** Merge as much of `src` into `dst` as fits; returns how many moved. */
export function merge(dst: ItemStack, src: ItemStack): number {
  const max = itemDef(dst.id).stack;
  const room = max - dst.count;
  const moved = Math.min(room, src.count);
  dst.count += moved;
  src.count -= moved;
  return moved;
}

/** Split `n` units off a stack into a new instance. */
export function split(s: ItemStack, n: number): ItemStack | null {
  if (n <= 0 || n >= s.count) return null;
  s.count -= n;
  return { uid: nextUid++, id: s.id, count: n };
}

export const stackWeight = (s: ItemStack): number => itemDef(s.id).weight * s.count;

/** Fractional durability 0..1, or 1 when the item has none. */
export function durabilityFrac(s: ItemStack): number {
  const d = itemDef(s.id);
  if (d.durability === undefined || s.dur === undefined) return 1;
  return Math.max(0, Math.min(1, s.dur / d.durability));
}

/**
 * Apply wear. Returns true when the item breaks and should be destroyed.
 * Weapons degrade on use; armour degrades when it absorbs a hit.
 */
export function damageItem(s: ItemStack, amount: number): boolean {
  const d = itemDef(s.id);
  if (d.durability === undefined || s.dur === undefined) return false;
  s.dur -= amount;
  if (s.dur <= 0) { s.dur = 0; return true; }
  return false;
}

export function repairItem(s: ItemStack, amount: number): void {
  const d = itemDef(s.id);
  if (d.durability === undefined || s.dur === undefined) return;
  s.dur = Math.min(d.durability, s.dur + amount);
}

/** Display name including stack count and loaded ammo. */
export function displayName(s: ItemStack): string {
  const d = itemDef(s.id);
  if (d.ranged && s.mag !== undefined) return `${d.name} (${s.mag}/${d.ranged.magSize})`;
  return s.count > 1 ? `${d.name} x${s.count}` : d.name;
}

/** Aggregate attachment effects fitted to a weapon. */
export function attachmentMods(s: ItemStack): { spread: number; recoil: number; silence: boolean; zoom: number; light: number } {
  const out = { spread: 1, recoil: 1, silence: false, zoom: 1, light: 0 };
  for (const id of s.attachments ?? []) {
    const a = itemDef(id).attach;
    if (!a) continue;
    if (a.spread) out.spread *= a.spread;
    if (a.recoil) out.recoil *= a.recoil;
    if (a.silence) out.silence = true;
    if (a.zoom) out.zoom *= a.zoom;
    if (a.light) out.light = Math.max(out.light, a.light);
  }
  return out;
}
