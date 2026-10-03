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

/**
 * Three separate bags rather than one.
 *
 * Splitting storage by purpose is what stops a building session from burying your
 * potions. Materials are exempt from carry weight — hauling a thousand blocks
 * around is the whole point of a voxel game, and taxing it would make building
 * feel like a penalty.
 */
export type BagTab = 'main' | 'tools' | 'materials';

export const BAG_SIZE = 48;
export const TOOLS_SIZE = 44;
export const MATERIALS_SIZE = BAG_SIZE * 4;
export const HOTBAR_SIZE = 8;

export const BAG_CAPACITY: Record<BagTab, number> = {
  main: BAG_SIZE,
  tools: TOOLS_SIZE,
  materials: MATERIALS_SIZE,
};

/** Which bag an item belongs in. */
export function tabForItem(def: ItemDef): BagTab {
  if (def.kind === 'block') return 'materials';
  if (def.kind === 'weapon' || def.kind === 'shield' || def.kind === 'armor' || def.kind === 'torch') return 'tools';
  if (def.kind === 'tool') return 'tools';
  return 'main';
}

export interface InventorySnapshot {
  bag: (Stack | null)[];
  tools?: (Stack | null)[];
  materials?: (Stack | null)[];
  hotbar: (string | null)[];
  equipped: Record<EquipSlot, string | null>;
  selected: number;
  /**
   * Removed. Melee attacks are chosen by mouse gesture, so there is no stored
   * swing/thrust selection any more.
   *
   * Still declared, and optional, purely so an existing save deserialises without
   * complaint — `restore` ignores it.
   */
  attackModes?: [string, number][];
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
  tools: (Stack | null)[] = new Array(TOOLS_SIZE).fill(null);
  materials: (Stack | null)[] = new Array(MATERIALS_SIZE).fill(null);
  hotbar: (string | null)[] = new Array(HOTBAR_SIZE).fill(null);
  equipped: Record<EquipSlot, string | null> = { weapon: null, shield: null, armor: null, torch: null };
  selected = 0;

  /**
   * The shield a two-handed weapon forced you to put away.
   *
   * Without this, drawing a bow silently dropped your shield and switching back
   * to a one-handed weapon left you unprotected until you noticed and re-equipped
   * it by hand — which felt like the shield was refusing to stay on.
   */
  private stashedShield: string | null = null;

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

  /** The slot array backing a tab. */
  slots(tab: BagTab): (Stack | null)[] {
    if (tab === 'tools') return this.tools;
    if (tab === 'materials') return this.materials;
    return this.bag;
  }

  /** All three bags, for operations that do not care which tab an item is in. */
  private allSlots(): (Stack | null)[][] {
    return [this.bag, this.tools, this.materials];
  }

  count(itemId: string): number {
    let total = 0;
    for (const slots of this.allSlots()) {
      for (const s of slots) if (s && s.itemId === itemId) total += s.qty;
    }
    return total;
  }

  /**
   * Total carried weight. Building materials are excluded on purpose, so
   * stockpiling stone never slows you down.
   */
  get carriedWeight(): number {
    let total = 0;
    for (const slots of [this.bag, this.tools]) {
      for (const s of slots) {
        if (!s) continue;
        const def = ITEMS.get(s.itemId);
        if (!def) continue;
        total += (def.armor?.weight ?? 0) + (def.shield?.weight ?? 0) + s.qty * 0.02;
      }
    }
    return Math.round(total * 10) / 10;
  }

  has(itemId: string, qty = 1): boolean {
    return this.count(itemId) >= qty;
  }

  // ---------------------------------------------------------------- mutation

  /** Adds items to the appropriate tab, returning however many did not fit. */
  add(itemId: string, qty = 1): number {
    const def = ITEMS.get(itemId);
    if (!def) return qty;
    let left = qty;
    const slots = this.slots(tabForItem(def));

    if (def.stackable) {
      for (const s of slots) {
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
      const idx = slots.indexOf(null);
      if (idx === -1) break;
      const move = def.stackable ? Math.min(def.maxStack, left) : 1;
      slots[idx] = { itemId, qty: move };
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
      def.kind === 'torch' ||
      def.kind === 'tool'
    );
  }

  remove(itemId: string, qty = 1): boolean {
    if (this.count(itemId) < qty) return false;
    let left = qty;
    for (const slots of this.allSlots()) {
      for (let i = 0; i < slots.length && left > 0; i++) {
        const s = slots[i];
        if (!s || s.itemId !== itemId) continue;
        const take = Math.min(s.qty, left);
        s.qty -= take;
        left -= take;
        if (s.qty <= 0) slots[i] = null;
      }
      if (left <= 0) break;
    }
    return true;
  }

  removeAtBagIndex(index: number, qty = 1, tab: BagTab = 'main'): Stack | null {
    const slots = this.slots(tab);
    const s = slots[index];
    if (!s) return null;
    const take = Math.min(qty, s.qty);
    const out: Stack = { itemId: s.itemId, qty: take };
    s.qty -= take;
    if (s.qty <= 0) slots[index] = null;
    return out;
  }

  /** Equips an item into its natural slot. Returns false if it is not equippable. */
  equip(itemId: string): boolean {
    const def = ITEMS.get(itemId);
    if (!def) return false;
    if (def.kind === 'weapon') {
      this.equipped.weapon = itemId;
      if (def.weapon?.twoHanded) {
        // Put the shield away, but remember it.
        if (this.equipped.shield) this.stashedShield = this.equipped.shield;
        this.equipped.shield = null;
      } else if (!this.equipped.shield && this.stashedShield && this.has(this.stashedShield, 1)) {
        // Back to one hand: bring the shield out again.
        this.equipped.shield = this.stashedShield;
        this.stashedShield = null;
      }
      return true;
    }
    if (def.kind === 'shield') {
      const weapon = this.equippedDef('weapon');
      if (weapon?.weapon?.twoHanded) this.equipped.weapon = null;
      this.equipped.shield = itemId;
      this.stashedShield = null;
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

  // ---------------------------------------------------------------- persistence

  snapshot(): InventorySnapshot {
    return {
      bag: this.bag.map((s) => (s ? { ...s } : null)),
      tools: this.tools.map((s) => (s ? { ...s } : null)),
      materials: this.materials.map((s) => (s ? { ...s } : null)),
      hotbar: [...this.hotbar],
      equipped: { ...this.equipped },
      selected: this.selected,
    };
  }

  restore(s: InventorySnapshot): void {
    const load = (source: (Stack | null)[] | undefined, size: number): (Stack | null)[] => {
      const out: (Stack | null)[] = new Array(size).fill(null);
      (source ?? []).slice(0, size).forEach((stack, i) => {
        out[i] = stack && ITEMS.has(stack.itemId) ? { ...stack } : null;
      });
      return out;
    };
    this.bag = load(s.bag, BAG_SIZE);
    this.tools = load(s.tools, TOOLS_SIZE);
    this.materials = load(s.materials, MATERIALS_SIZE);
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
    this.stashedShield = null;
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, s.selected));
    // `s.attackModes` may be present in a save written before melee moved to mouse
    // gestures. There is nothing to restore it into; dropping it is deliberate.
  }

  /** The kit a new character wakes up with. */
  static startingKit(): Inventory {
    const inv = new Inventory();
    inv.add('shortsword');
    inv.add('wooden_buckler');
    inv.add('quilted_armor');
    inv.add('shortbow');
    inv.add('arrow', 24);
    // The three spells you always start with, mana-powered.
    inv.add('flames');
    inv.add('sparks');
    inv.add('mending_hand');
    inv.add('healing_draught', 2);
    inv.add('mana_potion', 2);
    inv.add('block_cobblestone', 48);
    inv.add('block_planks', 32);
    inv.add('torch', 8);
    inv.add('build_tool');

    inv.equip('shortsword');
    inv.equip('wooden_buckler');
    inv.equip('quilted_armor');
    inv.equip('torch');

    inv.hotbar = ['shortsword', 'shortbow', 'flames', 'sparks', 'mending_hand', 'torch', 'block_cobblestone', 'healing_draught'];
    inv.select(0);
    return inv;
  }
}
