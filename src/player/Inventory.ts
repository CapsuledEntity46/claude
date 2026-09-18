import { ITEMS, type ItemDef, tryItem } from '../combat/items';

export interface Stack {
  itemId: string;
  qty: number;
}

/**
 * A torch occupies its own slot rather than competing with the shield: the whole
 * point of carrying one is to light the way *while* still being able to block.
 */
export type EquipSlot = 'weapon' | 'shield' | 'armor' | 'torch';

export const BAG_SIZE = 24;
export const HOTBAR_SIZE = 8;

export interface InventorySnapshot {
  bag: (Stack | null)[];
  hotbar: (string | null)[];
  equipped: Record<EquipSlot, string | null>;
  selected: number;
  attackModes: [string, number][];
}

/**
 * Bag + hotbar + equipment.
 *
 * The hotbar stores item *ids* rather than slot indices, so quantities always
 * read straight from the bag and a stack running out simply shows as empty.
 * Selecting a hotbar entry that holds a weapon, shield, or armour equips it.
 */
export class Inventory {
  bag: (Stack | null)[] = new Array(BAG_SIZE).fill(null);
  hotbar: (string | null)[] = new Array(HOTBAR_SIZE).fill(null);
  equipped: Record<EquipSlot, string | null> = { weapon: null, shield: null, armor: null, torch: null };
  selected = 0;

  /** Remembered swing/thrust choice per weapon id. */
  attackModes = new Map<string, number>();

  // ---------------------------------------------------------------- queries

  get activeItemId(): string | null {
    return this.hotbar[this.selected];
  }

  get activeItem(): ItemDef | null {
    const id = this.activeItemId;
    return id ? tryItem(id) ?? null : null;
  }

  equippedDef(slot: EquipSlot): ItemDef | null {
    const id = this.equipped[slot];
    return id ? tryItem(id) ?? null : null;
  }

  count(itemId: string): number {
    let total = 0;
    for (const s of this.bag) if (s && s.itemId === itemId) total += s.qty;
    return total;
  }

  has(itemId: string, qty = 1): boolean {
    return this.count(itemId) >= qty;
  }

  // ---------------------------------------------------------------- mutation

  /** Adds items, returning however many did not fit. */
  add(itemId: string, qty = 1): number {
    const def = ITEMS.get(itemId);
    if (!def) return qty;
    let left = qty;

    if (def.stackable) {
      for (const s of this.bag) {
        if (left <= 0) break;
        if (s && s.itemId === itemId && s.qty < def.maxStack) {
          const room = def.maxStack - s.qty;
          const move = Math.min(room, left);
          s.qty += move;
          left -= move;
        }
      }
    }

    while (left > 0) {
      const idx = this.bag.indexOf(null);
      if (idx === -1) break;
      const move = def.stackable ? Math.min(def.maxStack, left) : 1;
      this.bag[idx] = { itemId, qty: move };
      left -= move;
    }

    // First pickup of a usable item auto-assigns to a free hotbar slot, so new
    // loot is immediately reachable without opening the sheet.
    if (left < qty && this.isHotbarWorthy(def) && !this.hotbar.includes(itemId)) {
      const free = this.hotbar.indexOf(null);
      if (free !== -1) this.hotbar[free] = itemId;
    }

    return left;
  }

  private isHotbarWorthy(def: ItemDef): boolean {
    return (
      def.kind === 'weapon' ||
      def.kind === 'spell' ||
      def.kind === 'block' ||
      def.kind === 'consumable' ||
      def.kind === 'torch'
    );
  }

  remove(itemId: string, qty = 1): boolean {
    if (this.count(itemId) < qty) return false;
    let left = qty;
    for (let i = 0; i < this.bag.length && left > 0; i++) {
      const s = this.bag[i];
      if (!s || s.itemId !== itemId) continue;
      const take = Math.min(s.qty, left);
      s.qty -= take;
      left -= take;
      if (s.qty <= 0) this.bag[i] = null;
    }
    return true;
  }

  removeAtBagIndex(index: number, qty = 1): Stack | null {
    const s = this.bag[index];
    if (!s) return null;
    const take = Math.min(qty, s.qty);
    const out: Stack = { itemId: s.itemId, qty: take };
    s.qty -= take;
    if (s.qty <= 0) this.bag[index] = null;
    return out;
  }

  /** Equips an item into its natural slot. Returns false if it is not equippable. */
  equip(itemId: string): boolean {
    const def = ITEMS.get(itemId);
    if (!def) return false;
    if (def.kind === 'weapon') {
      this.equipped.weapon = itemId;
      // A two-handed weapon cannot share hands with a shield.
      if (def.weapon?.twoHanded) this.equipped.shield = null;
      return true;
    }
    if (def.kind === 'shield') {
      const weapon = this.equippedDef('weapon');
      if (weapon?.weapon?.twoHanded) this.equipped.weapon = null;
      this.equipped.shield = itemId;
      return true;
    }
    if (def.kind === 'armor') {
      this.equipped.armor = itemId;
      return true;
    }
    if (def.kind === 'torch') {
      this.equipped.torch = itemId;
      return true;
    }
    return false;
  }

  select(index: number): void {
    if (index < 0 || index >= HOTBAR_SIZE) return;
    this.selected = index;
    const id = this.hotbar[index];
    const def = id ? ITEMS.get(id) : undefined;
    // Picking a weapon on the hotbar is the same gesture as drawing it.
    if (def && (def.kind === 'weapon' || def.kind === 'shield' || def.kind === 'armor' || def.kind === 'torch')) {
      this.equip(def.id);
    }
  }

  cycle(direction: number): void {
    let next = this.selected;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      next = (next + direction + HOTBAR_SIZE) % HOTBAR_SIZE;
      if (this.hotbar[next]) break;
    }
    this.select(next);
  }

  assignToHotbar(slot: number, itemId: string | null): void {
    if (slot < 0 || slot >= HOTBAR_SIZE) return;
    this.hotbar[slot] = itemId;
    if (slot === this.selected && itemId) this.select(slot);
  }

  /** Cycles the active weapon's attack mode. Returns the new index. */
  cycleAttackMode(weaponId: string, modeCount: number): number {
    if (modeCount <= 1) return 0;
    const next = ((this.attackModes.get(weaponId) ?? 0) + 1) % modeCount;
    this.attackModes.set(weaponId, next);
    return next;
  }

  attackModeIndex(weaponId: string, modeCount: number): number {
    if (modeCount === 0) return 0;
    return Math.min(this.attackModes.get(weaponId) ?? 0, modeCount - 1);
  }

  // ---------------------------------------------------------------- persistence

  snapshot(): InventorySnapshot {
    return {
      bag: this.bag.map((s) => (s ? { ...s } : null)),
      hotbar: [...this.hotbar],
      equipped: { ...this.equipped },
      selected: this.selected,
      attackModes: [...this.attackModes.entries()],
    };
  }

  restore(s: InventorySnapshot): void {
    this.bag = new Array(BAG_SIZE).fill(null);
    s.bag.slice(0, BAG_SIZE).forEach((stack, i) => {
      this.bag[i] = stack && ITEMS.has(stack.itemId) ? { ...stack } : null;
    });
    this.hotbar = new Array(HOTBAR_SIZE).fill(null);
    s.hotbar.slice(0, HOTBAR_SIZE).forEach((id, i) => {
      this.hotbar[i] = id && ITEMS.has(id) ? id : null;
    });
    this.equipped = {
      weapon: s.equipped.weapon && ITEMS.has(s.equipped.weapon) ? s.equipped.weapon : null,
      shield: s.equipped.shield && ITEMS.has(s.equipped.shield) ? s.equipped.shield : null,
      armor: s.equipped.armor && ITEMS.has(s.equipped.armor) ? s.equipped.armor : null,
      torch: s.equipped.torch && ITEMS.has(s.equipped.torch) ? s.equipped.torch : null,
    };
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, s.selected));
    this.attackModes = new Map(s.attackModes ?? []);
  }

  /** The kit a new character wakes up with. */
  static startingKit(): Inventory {
    const inv = new Inventory();
    inv.add('shortsword');
    inv.add('wooden_buckler');
    inv.add('quilted_armor');
    inv.add('shortbow');
    inv.add('arrow', 24);
    inv.add('firebolt');
    inv.add('mend');
    inv.add('healing_draught', 2);
    inv.add('block_cobblestone', 48);
    inv.add('block_planks', 32);
    inv.add('torch', 8);

    inv.equip('shortsword');
    inv.equip('wooden_buckler');
    inv.equip('quilted_armor');
    inv.equip('torch');

    inv.hotbar = ['shortsword', 'shortbow', 'firebolt', 'mend', 'healing_draught', 'torch', 'block_cobblestone', 'block_planks'];
    inv.select(0);
    return inv;
  }
}
