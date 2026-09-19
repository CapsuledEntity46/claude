/**
 * The item database.
 *
 * Every piece of content in the game funnels through here: loot tables pick
 * ids, crafting recipes consume and produce ids, the inventory grid reads
 * `w`/`h`/`stack`, and combat reads the `ranged`/`melee`/`throwable` blocks.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type Category =
  | 'ranged' | 'melee' | 'throwable' | 'ammo' | 'attachment'
  | 'armor' | 'medical' | 'food' | 'drink'
  | 'resource' | 'component' | 'tool' | 'placeable' | 'misc';

export const CATEGORY_LABEL: Record<Category, string> = {
  ranged: 'Firearm', melee: 'Melee Weapon', throwable: 'Throwable', ammo: 'Ammunition',
  attachment: 'Attachment', armor: 'Apparel', medical: 'Medical', food: 'Food',
  drink: 'Drink', resource: 'Resource', component: 'Component', tool: 'Tool',
  placeable: 'Deployable', misc: 'Miscellaneous',
};

export type EquipSlot = 'head' | 'face' | 'chest' | 'hands' | 'legs' | 'feet' | 'back';

export const EQUIP_SLOTS: EquipSlot[] = ['head', 'face', 'chest', 'hands', 'legs', 'feet', 'back'];

export type AmmoKind = 'pistol' | 'rifle' | 'heavy' | 'shotgun' | 'arrow' | 'bolt' | 'rocket' | 'nail' | 'flare';

export const AMMO_LABEL: Record<AmmoKind, string> = {
  pistol: '9mm', rifle: '5.56mm', heavy: '7.62mm', shotgun: '12 gauge',
  arrow: 'Arrow', bolt: 'Bolt', rocket: 'Rocket', nail: 'Nail', flare: 'Flare',
};

/** What a tool is good at breaking. Drives harvest yields. */
export type ToolClass = 'wood' | 'stone' | 'metal' | 'flesh' | 'building';

export type GunSound = 'shoot_light' | 'shoot_heavy' | 'shoot_shotgun' | 'shoot_bow' | 'shoot_silenced';

export interface RangedStats {
  ammo: AmmoKind;
  magSize: number;
  damage: number;
  /** Projectile speed in world units/second. Bullets are simulated, not instant. */
  velocity: number;
  /** Rounds per minute. */
  rpm: number;
  /** Cone half-angle in degrees when hip-firing. */
  spread: number;
  /** Multiplier applied to spread while aiming down sights. */
  adsSpread: number;
  /** Upward/lateral kick per shot, in degrees. */
  recoil: number;
  reload: number;
  /** Shotguns fire several pellets per trigger pull. */
  pellets?: number;
  /** Effective range before damage falls off. */
  range: number;
  auto: boolean;
  /** Reload one round at a time (pumps, bolts, revolvers loaded loose). */
  singleLoad?: boolean;
  /** Extra delay after each shot for bolt/pump actions. */
  cycle?: number;
  sound: GunSound;
  /** Multiplier for a headshot-equivalent (centre-mass crit). */
  critMul: number;
  /** Zombies/NPCs hear a shot from this far away. */
  noise: number;
  /** Muzzle flash radius; 0 for bows. */
  flash: number;
  /** Draw-and-hold weapons (bows) charge up instead of firing instantly. */
  draw?: number;
  /** Rockets and flares explode on impact. */
  explode?: { radius: number; damage: number };
}

export interface MeleeStats {
  damage: number;
  range: number;
  /** Full swing arc in degrees. */
  arc: number;
  /** Seconds per swing. */
  speed: number;
  stamina: number;
  knockback: number;
  /** Gathering power against resource nodes. */
  power: number;
  classes: ToolClass[];
  bleed?: number;
  /** Thrown spears reuse this as their melee profile. */
  noise: number;
}

export interface ThrowableStats {
  kind: 'frag' | 'fire' | 'smoke' | 'flash' | 'spear' | 'charge';
  fuse: number;
  damage: number;
  radius: number;
  velocity: number;
  /** For molotovs: burning pool duration. */
  burn?: number;
}

export interface ConsumeStats {
  food?: number;
  water?: number;
  health?: number;
  /** Health restored gradually over `overTime` seconds. */
  regen?: number;
  overTime?: number;
  stamina?: number;
  /** Warms (positive) or cools (negative) the player. */
  temp?: number;
  stopBleed?: boolean;
  cureInfection?: boolean;
  painkiller?: number;
  useTime: number;
  sound: 'eat' | 'drink' | 'heal';
  /** Leftover item id, e.g. an empty can. */
  leftover?: string;
}

export interface ArmorStats {
  slot: EquipSlot;
  /** Fraction of incoming damage absorbed, 0..0.8. */
  protection: number;
  /** Insulation in degrees C. */
  warmth: number;
  /** Extra inventory rows granted (backpacks). */
  rows?: number;
  /** Reduces movement speed slightly. */
  bulk?: number;
  /** Night vision / zoom style effects. */
  vision?: 'night' | 'gas';
}

export type IconShape =
  | 'rifle' | 'carbine' | 'smg' | 'pistol' | 'revolver' | 'shotgun' | 'sniper' | 'lmg'
  | 'bow' | 'crossbow' | 'launcher' | 'nailgun' | 'flaregun'
  | 'knife' | 'sword' | 'axe' | 'pick' | 'hammer' | 'bat' | 'spear' | 'club' | 'shovel' | 'crowbar' | 'sledge'
  | 'grenade' | 'molotov' | 'canister' | 'satchel' | 'throwknife'
  | 'bullet' | 'shell' | 'arrow' | 'rocket_ammo' | 'nails'
  | 'vest' | 'helmet' | 'hat' | 'mask' | 'shirt' | 'pants' | 'boots' | 'gloves' | 'backpack'
  | 'bandage' | 'pills' | 'syringe' | 'medkit' | 'bloodbag' | 'splint'
  | 'can' | 'meat' | 'fish' | 'fruit' | 'grain' | 'mushroom' | 'bottle' | 'canteen' | 'soda'
  | 'plank' | 'stone' | 'ingot' | 'cloth' | 'leather' | 'bone' | 'powder' | 'scrap'
  | 'gear' | 'wire' | 'battery' | 'spring' | 'sheet' | 'rope' | 'tarp' | 'tape' | 'techtrash'
  | 'torch' | 'flashlight' | 'lantern' | 'lighter' | 'campfire' | 'furnace' | 'workbench'
  | 'box' | 'door' | 'trap' | 'saddle' | 'bed' | 'catcher' | 'plan' | 'sign'
  | 'map' | 'compass' | 'radio' | 'binoculars' | 'rod' | 'key' | 'scope' | 'silencer' | 'laser' | 'seed' | 'honey';

export interface IconSpec {
  s: IconShape;
  /** Primary, secondary and accent colours. */
  a?: string;
  b?: string;
  c?: string;
}

export interface ItemDef {
  id: string;
  name: string;
  cat: Category;
  /** Grid footprint. */
  w: number;
  h: number;
  stack: number;
  weight: number;
  rarity: Rarity;
  desc: string;
  icon: IconSpec;

  ranged?: RangedStats;
  melee?: MeleeStats;
  throwable?: ThrowableStats;
  consume?: ConsumeStats;
  armor?: ArmorStats;
  ammoKind?: AmmoKind;
  /** Max durability; undefined means indestructible. */
  durability?: number;
  /** Burn time in seconds when used as fuel. */
  fuel?: number;
  /** Deployable structure key. */
  deploy?: string;
  /** Light radius when held/active. */
  light?: number;
  /** Attachment effects. */
  attach?: { spread?: number; recoil?: number; silence?: boolean; zoom?: number; light?: number };
  /** Cooking: what this turns into over a fire. */
  cooksInto?: string;
  /** Smelting: what this turns into in a furnace. */
  smeltsInto?: string;
  /** Marks weapons usable to gather; derived from melee.power but handy for UI. */
  toolTier?: number;
}

type DefInput = Pick<ItemDef, 'id' | 'name' | 'cat' | 'icon'> & Partial<ItemDef>;

const DB = new Map<string, ItemDef>();

function def(d: DefInput): ItemDef {
  const full: ItemDef = {
    w: 1, h: 1, stack: 1, weight: 0.5, rarity: 'common', desc: '',
    ...d,
  } as ItemDef;
  if (DB.has(full.id)) throw new Error(`duplicate item id: ${full.id}`);
  DB.set(full.id, full);
  return full;
}

// =============================================================================
// RESOURCES
// =============================================================================

def({ id: 'wood', name: 'Wood', cat: 'resource', w: 1, h: 1, stack: 1000, weight: 0.02, icon: { s: 'plank', a: '#8a6134', b: '#6b4a27' }, desc: 'Rough timber. The foundation of everything.', fuel: 12 });
def({ id: 'stone', name: 'Stone', cat: 'resource', stack: 1000, weight: 0.03, icon: { s: 'stone', a: '#8b8b8f', b: '#6a6a6e' }, desc: 'Chunks of rock hacked from an outcrop.' });
def({ id: 'metal_frag', name: 'Metal Fragments', cat: 'resource', stack: 1000, weight: 0.02, icon: { s: 'scrap', a: '#9aa0a6', b: '#6d7276' }, desc: 'Shredded metal, smelted from ore.' });
def({ id: 'metal_ore', name: 'Metal Ore', cat: 'resource', stack: 1000, weight: 0.04, icon: { s: 'stone', a: '#8a7460', b: '#5f4f40' }, desc: 'Raw ore. Useless until smelted.', smeltsInto: 'metal_frag' });
def({ id: 'hqm', name: 'High Quality Metal', cat: 'resource', stack: 100, weight: 0.1, rarity: 'rare', icon: { s: 'ingot', a: '#c9ccd1', b: '#8d9298' }, desc: 'Dense alloy. Required for the best gear.' });
def({ id: 'hqm_ore', name: 'HQM Ore', cat: 'resource', stack: 200, weight: 0.12, rarity: 'uncommon', icon: { s: 'stone', a: '#a9b0b8', b: '#70767c' }, desc: 'Rare ore with a metallic sheen.', smeltsInto: 'hqm' });
def({ id: 'sulfur_ore', name: 'Sulfur Ore', cat: 'resource', stack: 1000, weight: 0.03, icon: { s: 'stone', a: '#c9b23a', b: '#8e7d23' }, desc: 'Acrid yellow rock.', smeltsInto: 'sulfur' });
def({ id: 'sulfur', name: 'Sulfur', cat: 'resource', stack: 1000, weight: 0.02, icon: { s: 'powder', a: '#e0c83c', b: '#a8951f' }, desc: 'Refined sulfur. Half of every explosive.' });
def({ id: 'charcoal', name: 'Charcoal', cat: 'resource', stack: 1000, weight: 0.01, icon: { s: 'powder', a: '#3c3a38', b: '#222020' }, desc: 'Burnt wood. The other half of gunpowder.', fuel: 20 });
def({ id: 'gunpowder', name: 'Gunpowder', cat: 'component', stack: 1000, weight: 0.02, rarity: 'uncommon', icon: { s: 'powder', a: '#5a5550', b: '#332f2c' }, desc: 'Volatile grey powder.' });
def({ id: 'cloth', name: 'Cloth', cat: 'resource', stack: 1000, weight: 0.01, icon: { s: 'cloth', a: '#b7a88c', b: '#8d8069' }, desc: 'Torn fabric and plant fibre.', fuel: 4 });
def({ id: 'leather', name: 'Leather', cat: 'resource', stack: 500, weight: 0.02, icon: { s: 'leather', a: '#7a5533', b: '#573a22' }, desc: 'Cured animal hide.' });
def({ id: 'bone_frag', name: 'Bone Fragments', cat: 'resource', stack: 1000, weight: 0.01, icon: { s: 'bone', a: '#ded6c2', b: '#b0a893' }, desc: 'Splintered bone. Sharp enough to matter.' });
def({ id: 'animal_fat', name: 'Animal Fat', cat: 'resource', stack: 500, weight: 0.02, icon: { s: 'powder', a: '#e7dfc4', b: '#c0b699' }, desc: 'Greasy tallow. Burns well.', fuel: 8 });
def({ id: 'plant_fiber', name: 'Plant Fiber', cat: 'resource', stack: 1000, weight: 0.005, icon: { s: 'rope', a: '#9aa06a', b: '#74794f' }, desc: 'Stringy stalks, good for rope and rags.' });
def({ id: 'scrap', name: 'Scrap', cat: 'resource', stack: 1000, weight: 0.02, rarity: 'uncommon', icon: { s: 'scrap', a: '#b08d55', b: '#7d6339' }, desc: 'Salvaged components. Trades for blueprints.' });
def({ id: 'low_fuel', name: 'Low Grade Fuel', cat: 'resource', stack: 500, weight: 0.05, icon: { s: 'canister', a: '#b5651d', b: '#7d4512' }, desc: 'Cloudy, foul-smelling fuel.', fuel: 30 });
def({ id: 'tech_trash', name: 'Tech Trash', cat: 'component', stack: 100, weight: 0.2, rarity: 'rare', icon: { s: 'techtrash', a: '#2f6b4f', b: '#1d4432', c: '#c9a227' }, desc: 'Circuit boards and dead electronics.' });
def({ id: 'gears', name: 'Gears', cat: 'component', stack: 100, weight: 0.15, rarity: 'uncommon', icon: { s: 'gear', a: '#98a0a8', b: '#6c7278' }, desc: 'Machined cogs from something that used to work.' });
def({ id: 'spring', name: 'Metal Spring', cat: 'component', stack: 100, weight: 0.12, rarity: 'uncommon', icon: { s: 'spring', a: '#a8aeb4', b: '#787e84' }, desc: 'Coiled steel. Every firearm needs one.' });
def({ id: 'sheet_metal', name: 'Sheet Metal', cat: 'component', stack: 100, weight: 0.4, rarity: 'uncommon', icon: { s: 'sheet', a: '#9ba3aa', b: '#6e767d' }, desc: 'Flat steel panel.' });
def({ id: 'rope', name: 'Rope', cat: 'component', stack: 100, weight: 0.1, icon: { s: 'rope', a: '#b09a6a', b: '#87744d' }, desc: 'Braided cord.' });
def({ id: 'tarp', name: 'Tarp', cat: 'component', w: 2, h: 1, stack: 20, weight: 0.5, rarity: 'uncommon', icon: { s: 'tarp', a: '#3f6b5c', b: '#2a4a3f' }, desc: 'Waterproof sheet.' });
def({ id: 'tape', name: 'Duct Tape', cat: 'component', stack: 50, weight: 0.1, icon: { s: 'tape', a: '#7f8489', b: '#55595d' }, desc: 'Fixes almost anything, badly.' });
def({ id: 'nails_res', name: 'Nails', cat: 'resource', stack: 1000, weight: 0.005, icon: { s: 'nails', a: '#a9afb5', b: '#787d82' }, desc: 'A fistful of nails.' });
def({ id: 'empty_can', name: 'Empty Can', cat: 'resource', stack: 50, weight: 0.05, icon: { s: 'can', a: '#8e949a', b: '#666b70' }, desc: 'Melt it down or make a grenade.' });
def({ id: 'wire', name: 'Wire', cat: 'component', stack: 200, weight: 0.03, icon: { s: 'wire', a: '#b5893c', b: '#8a6729' }, desc: 'Copper wire.' });
def({ id: 'battery', name: 'Battery', cat: 'component', stack: 20, weight: 0.3, rarity: 'uncommon', icon: { s: 'battery', a: '#3a3f44', b: '#c9a227' }, desc: 'Still holds a charge.' });
def({ id: 'seeds', name: 'Seeds', cat: 'resource', stack: 200, weight: 0.005, icon: { s: 'seed', a: '#8b7a4a', b: '#6a5b33' }, desc: 'Plantable. If you live long enough.' });

// =============================================================================
// AMMUNITION
// =============================================================================

def({ id: 'ammo_pistol', name: '9mm Rounds', cat: 'ammo', stack: 128, weight: 0.012, ammoKind: 'pistol', icon: { s: 'bullet', a: '#c8a44a', b: '#8d7230' }, desc: 'Common pistol and SMG ammunition.' });
def({ id: 'ammo_rifle', name: '5.56mm Rounds', cat: 'ammo', stack: 128, weight: 0.015, rarity: 'uncommon', ammoKind: 'rifle', icon: { s: 'bullet', a: '#c0b040', b: '#7f7429' }, desc: 'Military rifle ammunition.' });
def({ id: 'ammo_heavy', name: '7.62mm Rounds', cat: 'ammo', stack: 64, weight: 0.025, rarity: 'rare', ammoKind: 'heavy', icon: { s: 'bullet', a: '#b8933a', b: '#786025' }, desc: 'Heavy rounds for rifles that matter.' });
def({ id: 'ammo_shotgun', name: '12 Gauge Buckshot', cat: 'ammo', stack: 64, weight: 0.03, ammoKind: 'shotgun', icon: { s: 'shell', a: '#a3251f', b: '#c8a44a' }, desc: 'Nine pellets of bad news.' });
def({ id: 'ammo_slug', name: '12 Gauge Slug', cat: 'ammo', stack: 64, weight: 0.035, rarity: 'uncommon', ammoKind: 'shotgun', icon: { s: 'shell', a: '#2f5f8a', b: '#c8a44a' }, desc: 'One heavy projectile. Hits like a truck.' });
def({ id: 'arrow_wood', name: 'Wooden Arrow', cat: 'ammo', stack: 64, weight: 0.05, ammoKind: 'arrow', icon: { s: 'arrow', a: '#8a6134', b: '#d8d2c0' }, desc: 'Silent, cheap, recoverable.' });
def({ id: 'arrow_bone', name: 'Bone Arrow', cat: 'ammo', stack: 64, weight: 0.05, rarity: 'uncommon', ammoKind: 'arrow', icon: { s: 'arrow', a: '#8a6134', b: '#ded6c2' }, desc: 'Barbed head. Causes bleeding.' });
def({ id: 'bolt', name: 'Crossbow Bolt', cat: 'ammo', stack: 32, weight: 0.08, rarity: 'uncommon', ammoKind: 'bolt', icon: { s: 'arrow', a: '#5a5f64', b: '#b8bcc0' }, desc: 'Short, heavy, brutal.' });
def({ id: 'rocket', name: 'Rocket', cat: 'ammo', w: 1, h: 3, stack: 8, weight: 2, rarity: 'epic', ammoKind: 'rocket', icon: { s: 'rocket_ammo', a: '#5d6a52', b: '#a3251f' }, desc: 'Removes walls and the people behind them.' });
def({ id: 'nails_ammo', name: 'Nailgun Nails', cat: 'ammo', stack: 128, weight: 0.008, ammoKind: 'nail', icon: { s: 'nails', a: '#a9afb5', b: '#787d82' }, desc: 'Improvised ammunition.' });
def({ id: 'flare', name: 'Flare', cat: 'ammo', stack: 12, weight: 0.1, ammoKind: 'flare', icon: { s: 'shell', a: '#c9452a', b: '#e0c83c' }, desc: 'Burns bright. Draws attention.' });

// =============================================================================
// RANGED WEAPONS
// =============================================================================

def({
  id: 'bow', name: 'Hunting Bow', cat: 'ranged', w: 1, h: 3, weight: 1.2, durability: 200,
  icon: { s: 'bow', a: '#8a6134', b: '#ded6c2' }, desc: 'Quiet and cheap. Your first real weapon.',
  ranged: { ammo: 'arrow', magSize: 1, damage: 34, velocity: 780, rpm: 60, spread: 1.4, adsSpread: 0.3, recoil: 1.2, reload: 0.55, range: 900, auto: false, sound: 'shoot_bow', critMul: 2.2, noise: 140, flash: 0, draw: 0.62 },
});
def({
  id: 'crossbow', name: 'Crossbow', cat: 'ranged', w: 2, h: 2, weight: 2.4, rarity: 'uncommon', durability: 250,
  icon: { s: 'crossbow', a: '#5f4a32', b: '#8d9298' }, desc: 'Slow to reload, devastating up close.',
  ranged: { ammo: 'bolt', magSize: 1, damage: 62, velocity: 640, rpm: 40, spread: 0.9, adsSpread: 0.25, recoil: 1.6, reload: 1.9, range: 800, auto: false, sound: 'shoot_bow', critMul: 2.4, noise: 150, flash: 0, draw: 0.2 },
});
def({
  id: 'revolver', name: 'Revolver', cat: 'ranged', w: 2, h: 1, weight: 1.1, durability: 300,
  icon: { s: 'revolver', a: '#4a4f54', b: '#6b4a27' }, desc: 'Six shots of improvised justice.',
  ranged: { ammo: 'pistol', magSize: 6, damage: 27, velocity: 1100, rpm: 200, spread: 2.6, adsSpread: 0.45, recoil: 2.4, reload: 3.1, range: 700, auto: false, singleLoad: true, sound: 'shoot_light', critMul: 2, noise: 620, flash: 14 },
});
def({
  id: 'pistol', name: 'Semi-Auto Pistol', cat: 'ranged', w: 2, h: 1, weight: 1, rarity: 'uncommon', durability: 350,
  icon: { s: 'pistol', a: '#3f4449', b: '#2a2e32' }, desc: 'Reliable sidearm. Twelve in the mag.',
  ranged: { ammo: 'pistol', magSize: 12, damage: 24, velocity: 1150, rpm: 380, spread: 2.2, adsSpread: 0.4, recoil: 1.6, reload: 1.75, range: 750, auto: false, sound: 'shoot_light', critMul: 1.9, noise: 600, flash: 13 },
});
def({
  id: 'silenced_pistol', name: 'Silenced Pistol', cat: 'ranged', w: 2, h: 1, weight: 1.2, rarity: 'rare', durability: 320,
  icon: { s: 'pistol', a: '#2e3236', b: '#1b1e21', c: '#55595d' }, desc: 'Barely a whisper. Zombies stay asleep.',
  ranged: { ammo: 'pistol', magSize: 12, damage: 22, velocity: 1000, rpm: 340, spread: 1.9, adsSpread: 0.35, recoil: 1.2, reload: 1.8, range: 700, auto: false, sound: 'shoot_silenced', critMul: 2.1, noise: 120, flash: 6 },
});
def({
  id: 'smg', name: 'Custom SMG', cat: 'ranged', w: 2, h: 2, weight: 2.6, rarity: 'rare', durability: 400,
  icon: { s: 'smg', a: '#41464b', b: '#292d31' }, desc: 'Sprays 9mm faster than you can find it.',
  ranged: { ammo: 'pistol', magSize: 24, damage: 20, velocity: 1050, rpm: 700, spread: 3.4, adsSpread: 0.55, recoil: 1.5, reload: 2.4, range: 620, auto: true, sound: 'shoot_light', critMul: 1.6, noise: 650, flash: 15 },
});
def({
  id: 'thompson', name: 'Thompson', cat: 'ranged', w: 3, h: 2, weight: 4.5, rarity: 'rare', durability: 420,
  icon: { s: 'smg', a: '#4a3a28', b: '#6b4a27', c: '#55595d' }, desc: 'Old, heavy and utterly dependable.',
  ranged: { ammo: 'pistol', magSize: 20, damage: 26, velocity: 1000, rpm: 520, spread: 3, adsSpread: 0.5, recoil: 2, reload: 2.6, range: 680, auto: true, sound: 'shoot_light', critMul: 1.7, noise: 700, flash: 17 },
});
def({
  id: 'shotgun_pump', name: 'Pump Shotgun', cat: 'ranged', w: 3, h: 2, weight: 3.4, rarity: 'uncommon', durability: 380,
  icon: { s: 'shotgun', a: '#3b3f44', b: '#6b4a27' }, desc: 'Close-range hallway cleaner.',
  ranged: { ammo: 'shotgun', magSize: 6, damage: 14, pellets: 9, velocity: 850, rpm: 75, spread: 6.5, adsSpread: 0.7, recoil: 5.5, reload: 0.62, range: 340, auto: false, singleLoad: true, cycle: 0.55, sound: 'shoot_shotgun', critMul: 1.4, noise: 900, flash: 24 },
});
def({
  id: 'double_barrel', name: 'Double Barrel', cat: 'ranged', w: 3, h: 1, weight: 2.9, durability: 260,
  icon: { s: 'shotgun', a: '#2f3337', b: '#8a6134' }, desc: 'Two barrels. Make them count.',
  ranged: { ammo: 'shotgun', magSize: 2, damage: 15, pellets: 9, velocity: 860, rpm: 260, spread: 7.5, adsSpread: 0.75, recoil: 7, reload: 2.3, range: 320, auto: false, sound: 'shoot_shotgun', critMul: 1.4, noise: 950, flash: 27 },
});
def({
  id: 'ak47', name: 'Assault Rifle', cat: 'ranged', w: 3, h: 2, weight: 4.2, rarity: 'epic', durability: 500,
  icon: { s: 'rifle', a: '#4a3a28', b: '#6b4a27', c: '#3b3f44' }, desc: 'The apex of scavenged firepower.',
  ranged: { ammo: 'rifle', magSize: 30, damage: 34, velocity: 1300, rpm: 460, spread: 2.8, adsSpread: 0.4, recoil: 3, reload: 3.1, range: 1100, auto: true, sound: 'shoot_heavy', critMul: 1.9, noise: 1100, flash: 22 },
});
def({
  id: 'carbine', name: 'Military Carbine', cat: 'ranged', w: 3, h: 2, weight: 3.6, rarity: 'epic', durability: 520,
  icon: { s: 'carbine', a: '#3a3f35', b: '#282c24', c: '#55595d' }, desc: 'Controllable, accurate, rare.',
  ranged: { ammo: 'rifle', magSize: 30, damage: 30, velocity: 1400, rpm: 600, spread: 2.1, adsSpread: 0.3, recoil: 2.1, reload: 2.8, range: 1200, auto: true, sound: 'shoot_heavy', critMul: 2, noise: 1050, flash: 19 },
});
def({
  id: 'lmg', name: 'Light Machine Gun', cat: 'ranged', w: 4, h: 2, weight: 8.5, rarity: 'legendary', durability: 600,
  icon: { s: 'lmg', a: '#33383d', b: '#22262a', c: '#6b4a27' }, desc: 'A hundred rounds of suppression.',
  ranged: { ammo: 'rifle', magSize: 100, damage: 28, velocity: 1350, rpm: 660, spread: 4.2, adsSpread: 0.55, recoil: 2.6, reload: 7.5, range: 1150, auto: true, sound: 'shoot_heavy', critMul: 1.6, noise: 1250, flash: 26 },
});
def({
  id: 'hunting_rifle', name: 'Hunting Rifle', cat: 'ranged', w: 4, h: 1, weight: 3.8, rarity: 'rare', durability: 420,
  icon: { s: 'sniper', a: '#5f4a32', b: '#3b3f44' }, desc: 'Bolt action. One clean shot per animal.',
  ranged: { ammo: 'heavy', magSize: 4, damage: 72, velocity: 1700, rpm: 55, spread: 0.9, adsSpread: 0.14, recoil: 6, reload: 3.4, range: 1600, auto: false, cycle: 0.85, sound: 'shoot_heavy', critMul: 2.6, noise: 1400, flash: 24 },
});
def({
  id: 'sniper', name: 'Bolt Action Sniper', cat: 'ranged', w: 5, h: 2, weight: 5.4, rarity: 'legendary', durability: 450,
  icon: { s: 'sniper', a: '#3a3f35', b: '#282c24', c: '#55595d' }, desc: 'Reaches across the whole valley.',
  ranged: { ammo: 'heavy', magSize: 5, damage: 105, velocity: 2100, rpm: 45, spread: 0.5, adsSpread: 0.07, recoil: 8, reload: 4.2, range: 2400, auto: false, cycle: 1.05, sound: 'shoot_heavy', critMul: 3, noise: 1700, flash: 28 },
});
def({
  id: 'nailgun', name: 'Nailgun', cat: 'ranged', w: 2, h: 2, weight: 2, icon: { s: 'nailgun', a: '#b5651d', b: '#7d4512' }, durability: 240,
  desc: 'A construction tool with bad intentions.',
  ranged: { ammo: 'nail', magSize: 16, damage: 14, velocity: 700, rpm: 300, spread: 5, adsSpread: 0.8, recoil: 1.2, reload: 1.9, range: 300, auto: true, sound: 'shoot_light', critMul: 1.4, noise: 380, flash: 9 },
});
def({
  id: 'launcher', name: 'Rocket Launcher', cat: 'ranged', w: 5, h: 2, weight: 9, rarity: 'legendary', durability: 200,
  icon: { s: 'launcher', a: '#4a5240', b: '#2f3528' }, desc: 'For doors that refuse to open.',
  ranged: { ammo: 'rocket', magSize: 1, damage: 40, velocity: 420, rpm: 30, spread: 1.2, adsSpread: 0.6, recoil: 9, reload: 3.6, range: 1400, auto: false, sound: 'shoot_shotgun', critMul: 1, noise: 1800, flash: 34, explode: { radius: 165, damage: 210 } },
});
def({
  id: 'flaregun', name: 'Flare Gun', cat: 'ranged', w: 2, h: 1, weight: 0.8, icon: { s: 'flaregun', a: '#c9452a', b: '#3f4449' }, durability: 150,
  desc: 'Light up the night. And everything in it.',
  ranged: { ammo: 'flare', magSize: 1, damage: 12, velocity: 500, rpm: 50, spread: 3, adsSpread: 0.7, recoil: 3, reload: 1.6, range: 900, auto: false, sound: 'shoot_light', critMul: 1, noise: 500, flash: 20, explode: { radius: 60, damage: 25 } },
});

// =============================================================================
// MELEE WEAPONS
// =============================================================================

def({
  id: 'rock', name: 'Rock', cat: 'melee', weight: 0.6, durability: 300,
  icon: { s: 'stone', a: '#8b8b8f', b: '#6a6a6e' }, desc: 'Better than your fists. Barely.',
  melee: { damage: 11, range: 46, arc: 60, speed: 0.62, stamina: 4, knockback: 40, power: 1, classes: ['wood', 'stone'], noise: 110 },
});
def({
  id: 'bone_club', name: 'Bone Club', cat: 'melee', w: 1, h: 2, weight: 0.9, durability: 250,
  icon: { s: 'club', a: '#ded6c2', b: '#b0a893' }, desc: 'Femur of something large.',
  melee: { damage: 19, range: 60, arc: 75, speed: 0.6, stamina: 6, knockback: 80, power: 0.5, classes: ['flesh'], noise: 130 },
});
def({
  id: 'bone_knife', name: 'Bone Knife', cat: 'melee', weight: 0.4, durability: 200,
  icon: { s: 'knife', a: '#ded6c2', b: '#8a6134' }, desc: 'Crude but it cuts. Skins animals fast.',
  melee: { damage: 16, range: 48, arc: 45, speed: 0.36, stamina: 3, knockback: 20, power: 1, classes: ['flesh'], bleed: 0.4, noise: 90 },
});
def({
  id: 'combat_knife', name: 'Combat Knife', cat: 'melee', w: 1, h: 2, weight: 0.5, rarity: 'uncommon', durability: 400,
  icon: { s: 'knife', a: '#b8bcc0', b: '#2a2e32' }, desc: 'Fast, silent, bleeds them out.',
  melee: { damage: 26, range: 54, arc: 45, speed: 0.3, stamina: 3, knockback: 25, power: 1.5, classes: ['flesh'], bleed: 0.65, noise: 90 },
});
def({
  id: 'machete', name: 'Machete', cat: 'melee', w: 1, h: 3, weight: 1.1, rarity: 'uncommon', durability: 450,
  icon: { s: 'sword', a: '#a8aeb4', b: '#2f3337' }, desc: 'Long reach, wide arc, deep cuts.',
  melee: { damage: 36, range: 76, arc: 95, speed: 0.52, stamina: 7, knockback: 70, power: 1.5, classes: ['flesh', 'wood'], bleed: 0.5, noise: 120 },
});
def({
  id: 'katana', name: 'Salvaged Katana', cat: 'melee', w: 1, h: 4, weight: 1.3, rarity: 'epic', durability: 500,
  icon: { s: 'sword', a: '#d4d8dc', b: '#1f2225', c: '#c9a227' }, desc: 'Somebody kept this sharp for a reason.',
  melee: { damage: 48, range: 86, arc: 110, speed: 0.48, stamina: 8, knockback: 85, power: 1.5, classes: ['flesh'], bleed: 0.8, noise: 120 },
});
def({
  id: 'wooden_spear', name: 'Wooden Spear', cat: 'melee', w: 1, h: 4, weight: 1.4, durability: 220,
  icon: { s: 'spear', a: '#8a6134', b: '#6b4a27' }, desc: 'Keeps the teeth at arm\'s length. Throwable.',
  melee: { damage: 28, range: 105, arc: 30, speed: 0.72, stamina: 8, knockback: 100, power: 0.5, classes: ['flesh'], noise: 110 },
  throwable: { kind: 'spear', fuse: 0, damage: 52, radius: 0, velocity: 620 },
});
def({
  id: 'stone_spear', name: 'Stone Spear', cat: 'melee', w: 1, h: 4, weight: 1.8, rarity: 'uncommon', durability: 320,
  icon: { s: 'spear', a: '#8a6134', b: '#8b8b8f' }, desc: 'Flint tipped. Punches through hide.',
  melee: { damage: 40, range: 110, arc: 32, speed: 0.74, stamina: 9, knockback: 120, power: 1, classes: ['flesh'], bleed: 0.35, noise: 115 },
  throwable: { kind: 'spear', fuse: 0, damage: 74, radius: 0, velocity: 640 },
});
def({
  id: 'stone_hatchet', name: 'Stone Hatchet', cat: 'melee', w: 1, h: 2, weight: 1.2, durability: 260,
  icon: { s: 'axe', a: '#8b8b8f', b: '#8a6134' }, desc: 'Chops trees. Chops other things too.',
  melee: { damage: 24, range: 58, arc: 70, speed: 0.6, stamina: 7, knockback: 60, power: 2.2, classes: ['wood', 'flesh'], noise: 140 },
});
def({
  id: 'hatchet', name: 'Hatchet', cat: 'melee', w: 1, h: 2, weight: 1.4, rarity: 'uncommon', durability: 500,
  icon: { s: 'axe', a: '#9aa0a6', b: '#5f4a32' }, desc: 'Proper steel head. Fells trees in seconds.',
  melee: { damage: 33, range: 60, arc: 70, speed: 0.55, stamina: 7, knockback: 75, power: 4.5, classes: ['wood', 'flesh'], noise: 150 },
});
def({
  id: 'fire_axe', name: 'Fire Axe', cat: 'melee', w: 2, h: 3, weight: 3.2, rarity: 'rare', durability: 550,
  icon: { s: 'axe', a: '#c9452a', b: '#3f4449' }, desc: 'Heavy, slow, and it opens doors.',
  melee: { damage: 55, range: 74, arc: 80, speed: 0.85, stamina: 13, knockback: 150, power: 5, classes: ['wood', 'building', 'flesh'], noise: 170 },
});
def({
  id: 'stone_pickaxe', name: 'Stone Pickaxe', cat: 'melee', w: 1, h: 3, weight: 1.6, durability: 260,
  icon: { s: 'pick', a: '#8b8b8f', b: '#8a6134' }, desc: 'For rock and ore.',
  melee: { damage: 22, range: 58, arc: 60, speed: 0.68, stamina: 8, knockback: 55, power: 2.2, classes: ['stone', 'metal'], noise: 150 },
});
def({
  id: 'pickaxe', name: 'Pickaxe', cat: 'melee', w: 1, h: 3, weight: 2.2, rarity: 'uncommon', durability: 520,
  icon: { s: 'pick', a: '#9aa0a6', b: '#5f4a32' }, desc: 'Steel head. Ore comes out in chunks.',
  melee: { damage: 31, range: 60, arc: 60, speed: 0.62, stamina: 8, knockback: 70, power: 4.5, classes: ['stone', 'metal'], noise: 160 },
});
def({
  id: 'baseball_bat', name: 'Baseball Bat', cat: 'melee', w: 1, h: 4, weight: 1.1, durability: 300,
  icon: { s: 'bat', a: '#a8814d', b: '#7d5f36' }, desc: 'Sends them flying.',
  melee: { damage: 27, range: 72, arc: 100, speed: 0.58, stamina: 7, knockback: 180, power: 0.5, classes: ['flesh'], noise: 140 },
});
def({
  id: 'nail_bat', name: 'Nailed Bat', cat: 'melee', w: 1, h: 4, weight: 1.4, rarity: 'uncommon', durability: 280,
  icon: { s: 'bat', a: '#8d6a3e', b: '#a9afb5' }, desc: 'Improved with hardware.',
  melee: { damage: 37, range: 72, arc: 100, speed: 0.6, stamina: 8, knockback: 165, power: 0.5, classes: ['flesh'], bleed: 0.55, noise: 150 },
});
def({
  id: 'crowbar', name: 'Crowbar', cat: 'melee', w: 1, h: 3, weight: 1.8, rarity: 'uncommon', durability: 600,
  icon: { s: 'crowbar', a: '#8a3a2e', b: '#5f2a20' }, desc: 'Pries open crates and skulls alike.',
  melee: { damage: 29, range: 62, arc: 70, speed: 0.55, stamina: 6, knockback: 95, power: 2, classes: ['building', 'metal', 'flesh'], noise: 150 },
});
def({
  id: 'sledgehammer', name: 'Sledgehammer', cat: 'melee', w: 2, h: 4, weight: 5.5, rarity: 'rare', durability: 600,
  icon: { s: 'sledge', a: '#7f8489', b: '#6b4a27' }, desc: 'Demolishes walls. Ruins people.',
  melee: { damage: 68, range: 76, arc: 85, speed: 1.05, stamina: 18, knockback: 260, power: 6, classes: ['building', 'stone'], noise: 200 },
});
def({
  id: 'shovel', name: 'Shovel', cat: 'melee', w: 1, h: 4, weight: 2, durability: 350,
  icon: { s: 'shovel', a: '#8d9298', b: '#8a6134' }, desc: 'Digs. Also swings.',
  melee: { damage: 24, range: 68, arc: 90, speed: 0.72, stamina: 8, knockback: 110, power: 1.5, classes: ['stone'], noise: 140 },
});
def({
  id: 'torch', name: 'Torch', cat: 'melee', w: 1, h: 2, weight: 0.5, durability: 400, light: 220,
  icon: { s: 'torch', a: '#6b4a27', b: '#e0a02c' }, desc: 'Light and a little fire damage.',
  melee: { damage: 12, range: 52, arc: 60, speed: 0.55, stamina: 4, knockback: 30, power: 0.5, classes: ['flesh'], noise: 100 },
});

// =============================================================================
// THROWABLES
// =============================================================================

def({
  id: 'grenade', name: 'F1 Grenade', cat: 'throwable', stack: 8, weight: 0.45, rarity: 'rare',
  icon: { s: 'grenade', a: '#4a5240', b: '#2f3528' }, desc: 'Three second fuse. Count carefully.',
  throwable: { kind: 'frag', fuse: 3, damage: 145, radius: 135, velocity: 480 },
});
def({
  id: 'beancan', name: 'Beancan Grenade', cat: 'throwable', stack: 8, weight: 0.35, rarity: 'uncommon',
  icon: { s: 'grenade', a: '#8e949a', b: '#a3251f' }, desc: 'Sometimes it duds. Usually it doesn\'t.',
  throwable: { kind: 'frag', fuse: 4.2, damage: 95, radius: 110, velocity: 440 },
});
def({
  id: 'molotov', name: 'Molotov', cat: 'throwable', stack: 6, weight: 0.6, rarity: 'uncommon',
  icon: { s: 'molotov', a: '#7a9b3a', b: '#e0a02c' }, desc: 'Denies a doorway for twenty seconds.',
  throwable: { kind: 'fire', fuse: 0, damage: 22, radius: 105, velocity: 420, burn: 18 },
});
def({
  id: 'smoke_grenade', name: 'Smoke Grenade', cat: 'throwable', stack: 8, weight: 0.4,
  icon: { s: 'canister', a: '#6b7076', b: '#c9cdd1' }, desc: 'Break line of sight and walk away.',
  throwable: { kind: 'smoke', fuse: 1.5, damage: 0, radius: 190, velocity: 440, burn: 22 },
});
def({
  id: 'flashbang', name: 'Flashbang', cat: 'throwable', stack: 8, weight: 0.4, rarity: 'uncommon',
  icon: { s: 'canister', a: '#3f4449', b: '#e8e2c0' }, desc: 'Stuns everything with eyes.',
  throwable: { kind: 'flash', fuse: 2, damage: 6, radius: 240, velocity: 460 },
});
def({
  id: 'satchel', name: 'Satchel Charge', cat: 'throwable', w: 2, h: 2, stack: 4, weight: 2.4, rarity: 'epic',
  icon: { s: 'satchel', a: '#7a5533', b: '#c9452a' }, desc: 'Four beancans and a prayer.',
  throwable: { kind: 'charge', fuse: 6, damage: 340, radius: 175, velocity: 300 },
});
def({
  id: 'throwing_knife', name: 'Throwing Knife', cat: 'throwable', stack: 12, weight: 0.3,
  icon: { s: 'throwknife', a: '#b8bcc0', b: '#2a2e32' }, desc: 'Silent at range. Retrievable.',
  throwable: { kind: 'spear', fuse: 0, damage: 33, radius: 0, velocity: 700 },
});

// =============================================================================
// ATTACHMENTS
// =============================================================================

def({ id: 'scope', name: 'Telescopic Scope', cat: 'attachment', w: 2, h: 1, weight: 0.4, rarity: 'rare', icon: { s: 'scope', a: '#2f3337', b: '#3d7fb5' }, desc: 'Magnifies. Narrows your view.', attach: { zoom: 1.9, spread: 0.8 } });
def({ id: 'silencer', name: 'Silencer', cat: 'attachment', w: 2, h: 1, weight: 0.3, rarity: 'rare', icon: { s: 'silencer', a: '#33383d', b: '#22262a' }, desc: 'Cuts the noise that draws hordes.', attach: { silence: true, spread: 0.9 } });
def({ id: 'laser', name: 'Laser Sight', cat: 'attachment', weight: 0.2, rarity: 'uncommon', icon: { s: 'laser', a: '#3f4449', b: '#c9452a' }, desc: 'Tightens hip-fire considerably.', attach: { spread: 0.65 } });
def({ id: 'muzzle_brake', name: 'Muzzle Brake', cat: 'attachment', weight: 0.25, rarity: 'uncommon', icon: { s: 'silencer', a: '#5a5f64', b: '#3a3f44' }, desc: 'Tames recoil, amplifies the bang.', attach: { recoil: 0.6 } });
def({ id: 'weapon_light', name: 'Weapon Light', cat: 'attachment', weight: 0.2, icon: { s: 'flashlight', a: '#3a3f44', b: '#e8e2c0' }, desc: 'Bolted-on flashlight.', attach: { light: 260 } });

// =============================================================================
// APPAREL
// =============================================================================

def({ id: 'hat_cloth', name: 'Cloth Hat', cat: 'armor', weight: 0.2, icon: { s: 'hat', a: '#8d8069', b: '#6d6251' }, desc: 'Keeps the sun off.', armor: { slot: 'head', protection: 0.04, warmth: 2 }, durability: 100 });
def({ id: 'beanie', name: 'Beanie', cat: 'armor', weight: 0.2, icon: { s: 'hat', a: '#5a4a6a', b: '#3f3349' }, desc: 'Surprisingly warm.', armor: { slot: 'head', protection: 0.03, warmth: 5 }, durability: 100 });
def({ id: 'helmet_riot', name: 'Riot Helmet', cat: 'armor', w: 2, h: 2, weight: 1.4, rarity: 'uncommon', icon: { s: 'helmet', a: '#2f3337', b: '#5b7ba0' }, desc: 'Visored. Stops a bat cold.', armor: { slot: 'head', protection: 0.18, warmth: 3, bulk: 0.02 }, durability: 250 });
def({ id: 'helmet_military', name: 'Military Helmet', cat: 'armor', w: 2, h: 2, weight: 1.6, rarity: 'rare', icon: { s: 'helmet', a: '#4a5240', b: '#2f3528' }, desc: 'Kevlar shell. Worth killing for.', armor: { slot: 'head', protection: 0.24, warmth: 4, bulk: 0.03 }, durability: 320 });
def({ id: 'bandana', name: 'Bandana', cat: 'armor', weight: 0.1, icon: { s: 'mask', a: '#8a3a2e', b: '#5f2a20' }, desc: 'Hides your face. Filters dust.', armor: { slot: 'face', protection: 0.02, warmth: 2 }, durability: 80 });
def({ id: 'balaclava', name: 'Balaclava', cat: 'armor', weight: 0.15, rarity: 'uncommon', icon: { s: 'mask', a: '#2a2e32', b: '#1a1d20' }, desc: 'Warm and anonymous.', armor: { slot: 'face', protection: 0.05, warmth: 6 }, durability: 120 });
def({ id: 'gas_mask', name: 'Gas Mask', cat: 'armor', w: 2, h: 2, weight: 0.9, rarity: 'rare', icon: { s: 'mask', a: '#4a5240', b: '#8d9298' }, desc: 'Breathes through smoke and gas.', armor: { slot: 'face', protection: 0.09, warmth: 4, vision: 'gas' }, durability: 200 });
def({ id: 'nvg', name: 'Night Vision Goggles', cat: 'armor', w: 2, h: 1, weight: 0.7, rarity: 'legendary', icon: { s: 'binoculars', a: '#2f3528', b: '#63a84b' }, desc: 'Turns the night into your advantage.', armor: { slot: 'face', protection: 0.02, warmth: 1, vision: 'night' }, durability: 200 });

def({ id: 'shirt', name: 'T-Shirt', cat: 'armor', w: 2, h: 2, weight: 0.3, icon: { s: 'shirt', a: '#9aa0a6', b: '#74797e' }, desc: 'Barely clothing.', armor: { slot: 'chest', protection: 0.03, warmth: 3 }, durability: 100 });
def({ id: 'hoodie', name: 'Hoodie', cat: 'armor', w: 2, h: 2, weight: 0.6, icon: { s: 'shirt', a: '#4a5568', b: '#333d4a' }, desc: 'Warm, soft, useless against bullets.', armor: { slot: 'chest', protection: 0.06, warmth: 9 }, durability: 140 });
def({ id: 'jacket_leather', name: 'Leather Jacket', cat: 'armor', w: 2, h: 2, weight: 1.4, rarity: 'uncommon', icon: { s: 'shirt', a: '#4a3226', b: '#31211a' }, desc: 'Turns claws and teeth.', armor: { slot: 'chest', protection: 0.14, warmth: 11 }, durability: 260 });
def({ id: 'hide_vest', name: 'Hide Vest', cat: 'armor', w: 2, h: 2, weight: 1.1, icon: { s: 'vest', a: '#7a5533', b: '#573a22' }, desc: 'Craftable armour for day one.', armor: { slot: 'chest', protection: 0.1, warmth: 8 }, durability: 180 });
def({ id: 'kevlar_vest', name: 'Kevlar Vest', cat: 'armor', w: 2, h: 3, weight: 3.2, rarity: 'rare', icon: { s: 'vest', a: '#3a3f35', b: '#282c24' }, desc: 'Serious protection, serious weight.', armor: { slot: 'chest', protection: 0.3, warmth: 6, bulk: 0.05 }, durability: 400 });
def({ id: 'plate_carrier', name: 'Metal Plate Carrier', cat: 'armor', w: 2, h: 3, weight: 5.5, rarity: 'epic', icon: { s: 'vest', a: '#6b7076', b: '#3f4449', c: '#c9a227' }, desc: 'The best chest armour in the wasteland.', armor: { slot: 'chest', protection: 0.4, warmth: 5, bulk: 0.1 }, durability: 550 });
def({ id: 'ghillie', name: 'Ghillie Suit', cat: 'armor', w: 2, h: 3, weight: 2, rarity: 'epic', icon: { s: 'vest', a: '#4a5a32', b: '#33401f' }, desc: 'Enemies spot you far later.', armor: { slot: 'chest', protection: 0.08, warmth: 10 }, durability: 220 });

def({ id: 'gloves_leather', name: 'Leather Gloves', cat: 'armor', weight: 0.2, icon: { s: 'gloves', a: '#6b4a27', b: '#4a3219' }, desc: 'Grip and a little warmth.', armor: { slot: 'hands', protection: 0.04, warmth: 4 }, durability: 120 });
def({ id: 'gloves_tactical', name: 'Tactical Gloves', cat: 'armor', weight: 0.25, rarity: 'uncommon', icon: { s: 'gloves', a: '#2f3337', b: '#4a5240' }, desc: 'Steadier aim, faster reloads.', armor: { slot: 'hands', protection: 0.07, warmth: 5 }, durability: 200 });

def({ id: 'pants_cloth', name: 'Cloth Pants', cat: 'armor', w: 2, h: 2, weight: 0.4, icon: { s: 'pants', a: '#5a6068', b: '#41464c' }, desc: 'Legs covered.', armor: { slot: 'legs', protection: 0.04, warmth: 5 }, durability: 110 });
def({ id: 'jeans', name: 'Jeans', cat: 'armor', w: 2, h: 2, weight: 0.6, icon: { s: 'pants', a: '#3a4f6b', b: '#28384d' }, desc: 'Denim. Sturdy enough.', armor: { slot: 'legs', protection: 0.06, warmth: 7 }, durability: 160 });
def({ id: 'pants_tactical', name: 'Tactical Pants', cat: 'armor', w: 2, h: 2, weight: 1.1, rarity: 'uncommon', icon: { s: 'pants', a: '#3a3f35', b: '#282c24' }, desc: 'Reinforced, many pockets.', armor: { slot: 'legs', protection: 0.14, warmth: 8 }, durability: 280 });
def({ id: 'leg_plates', name: 'Metal Leg Plates', cat: 'armor', w: 2, h: 2, weight: 3, rarity: 'rare', icon: { s: 'pants', a: '#6b7076', b: '#3f4449' }, desc: 'Heavy plating below the belt.', armor: { slot: 'legs', protection: 0.24, warmth: 4, bulk: 0.06 }, durability: 420 });

def({ id: 'shoes', name: 'Sneakers', cat: 'armor', w: 2, h: 1, weight: 0.4, icon: { s: 'boots', a: '#9aa0a6', b: '#6b7076' }, desc: 'Quiet on hard floors.', armor: { slot: 'feet', protection: 0.02, warmth: 3 }, durability: 100 });
def({ id: 'boots_leather', name: 'Leather Boots', cat: 'armor', w: 2, h: 1, weight: 0.8, icon: { s: 'boots', a: '#5f4128', b: '#422d1b' }, desc: 'Warm and tough.', armor: { slot: 'feet', protection: 0.05, warmth: 7 }, durability: 180 });
def({ id: 'boots_combat', name: 'Combat Boots', cat: 'armor', w: 2, h: 1, weight: 1.2, rarity: 'uncommon', icon: { s: 'boots', a: '#2f3337', b: '#1f2225' }, desc: 'Ankle support and steel toes.', armor: { slot: 'feet', protection: 0.1, warmth: 8 }, durability: 300 });

def({ id: 'backpack_small', name: 'Small Backpack', cat: 'armor', w: 2, h: 2, weight: 0.8, icon: { s: 'backpack', a: '#5a4a32', b: '#3d321f' }, desc: 'One extra row of storage.', armor: { slot: 'back', protection: 0.03, warmth: 2, rows: 1 }, durability: 200 });
def({ id: 'backpack_large', name: 'Large Backpack', cat: 'armor', w: 3, h: 3, weight: 1.8, rarity: 'uncommon', icon: { s: 'backpack', a: '#3a4a32', b: '#26311f' }, desc: 'Two extra rows. Hoarders rejoice.', armor: { slot: 'back', protection: 0.05, warmth: 3, rows: 2, bulk: 0.03 }, durability: 300 });
def({ id: 'backpack_military', name: 'Military Rucksack', cat: 'armor', w: 3, h: 3, weight: 2.6, rarity: 'rare', icon: { s: 'backpack', a: '#4a5240', b: '#2f3528', c: '#c9a227' }, desc: 'Three extra rows and some armour.', armor: { slot: 'back', protection: 0.1, warmth: 4, rows: 3, bulk: 0.05 }, durability: 380 });

// =============================================================================
// MEDICAL
// =============================================================================

def({ id: 'rag', name: 'Rag', cat: 'medical', stack: 20, weight: 0.05, icon: { s: 'bandage', a: '#a89a80', b: '#87795f' }, desc: 'Slows bleeding. Barely sanitary.', consume: { health: 3, stopBleed: true, useTime: 1.4, sound: 'heal' } });
def({ id: 'bandage', name: 'Bandage', cat: 'medical', stack: 12, weight: 0.08, icon: { s: 'bandage', a: '#e8e2d4', b: '#c4bdab' }, desc: 'Stops bleeding, heals a little.', consume: { health: 6, regen: 8, overTime: 8, stopBleed: true, useTime: 1.8, sound: 'heal' } });
def({ id: 'medkit', name: 'Medical Kit', cat: 'medical', w: 2, h: 2, stack: 4, weight: 0.7, rarity: 'uncommon', icon: { s: 'medkit', a: '#d8d4c8', b: '#a3251f' }, desc: 'Full field treatment.', consume: { health: 30, regen: 40, overTime: 12, stopBleed: true, cureInfection: true, useTime: 4.5, sound: 'heal' } });
def({ id: 'blood_bag', name: 'Blood Bag', cat: 'medical', stack: 6, weight: 0.5, rarity: 'uncommon', icon: { s: 'bloodbag', a: '#a3251f', b: '#6b1712' }, desc: 'Restores a lot of health slowly.', consume: { regen: 65, overTime: 16, useTime: 5, sound: 'heal' } });
def({ id: 'syringe', name: 'Medical Syringe', cat: 'medical', stack: 6, weight: 0.2, rarity: 'rare', icon: { s: 'syringe', a: '#c9cdd1', b: '#63a84b' }, desc: 'Instant. Keep one for emergencies.', consume: { health: 35, stamina: 40, useTime: 1.2, sound: 'heal' } });
def({ id: 'painkillers', name: 'Painkillers', cat: 'medical', stack: 10, weight: 0.1, icon: { s: 'pills', a: '#e8e2d4', b: '#3d7fb5' }, desc: 'Dulls damage taken for a while.', consume: { health: 5, painkiller: 30, useTime: 1.5, sound: 'heal' } });
def({ id: 'antibiotics', name: 'Antibiotics', cat: 'medical', stack: 10, weight: 0.1, rarity: 'uncommon', icon: { s: 'pills', a: '#e8e2d4', b: '#c9452a' }, desc: 'Clears infection from bites.', consume: { health: 4, cureInfection: true, useTime: 2, sound: 'heal' } });
def({ id: 'splint', name: 'Splint', cat: 'medical', w: 1, h: 2, stack: 5, weight: 0.3, icon: { s: 'splint', a: '#8a6134', b: '#e8e2d4' }, desc: 'Fixes a broken leg.', consume: { health: 8, useTime: 4, sound: 'heal' } });

// =============================================================================
// FOOD & DRINK
// =============================================================================

def({ id: 'canned_beans', name: 'Canned Beans', cat: 'food', stack: 8, weight: 0.4, icon: { s: 'can', a: '#8e949a', b: '#b5651d' }, desc: 'Reliable calories.', consume: { food: 30, water: 6, health: 2, useTime: 2.4, sound: 'eat', leftover: 'empty_can' } });
def({ id: 'canned_tuna', name: 'Canned Tuna', cat: 'food', stack: 8, weight: 0.35, icon: { s: 'can', a: '#8e949a', b: '#3d7fb5' }, desc: 'Salty and filling.', consume: { food: 26, health: 3, useTime: 2.2, sound: 'eat', leftover: 'empty_can' } });
def({ id: 'canned_peaches', name: 'Canned Peaches', cat: 'food', stack: 8, weight: 0.4, icon: { s: 'can', a: '#8e949a', b: '#e0a02c' }, desc: 'Syrupy. Hydrating.', consume: { food: 20, water: 18, useTime: 2.2, sound: 'eat', leftover: 'empty_can' } });
def({ id: 'cereal', name: 'Box of Cereal', cat: 'food', w: 2, h: 2, stack: 4, weight: 0.5, icon: { s: 'grain', a: '#c9a227', b: '#8a6134' }, desc: 'Dry but plentiful.', consume: { food: 34, water: -6, useTime: 3, sound: 'eat' } });
def({ id: 'granola', name: 'Granola Bar', cat: 'food', stack: 16, weight: 0.1, icon: { s: 'grain', a: '#a8814d', b: '#7d5f36' }, desc: 'Quick snack, quick stamina.', consume: { food: 14, stamina: 25, useTime: 1.2, sound: 'eat' } });
def({ id: 'chocolate', name: 'Chocolate Bar', cat: 'food', stack: 12, weight: 0.1, icon: { s: 'grain', a: '#4a3226', b: '#31211a' }, desc: 'Sugar rush.', consume: { food: 16, stamina: 35, temp: 1, useTime: 1, sound: 'eat' } });
def({ id: 'apple', name: 'Apple', cat: 'food', stack: 12, weight: 0.15, icon: { s: 'fruit', a: '#a3251f', b: '#63a84b' }, desc: 'Found in orchards and kitchens.', consume: { food: 12, water: 10, useTime: 1.6, sound: 'eat' } });
def({ id: 'berries', name: 'Berries', cat: 'food', stack: 30, weight: 0.05, icon: { s: 'fruit', a: '#6b2f6b', b: '#3f1f3f' }, desc: 'Forage from bushes.', consume: { food: 6, water: 5, useTime: 1, sound: 'eat' } });
def({ id: 'mushroom', name: 'Mushroom', cat: 'food', stack: 20, weight: 0.05, icon: { s: 'mushroom', a: '#c4a882', b: '#8a6134' }, desc: 'Probably fine.', consume: { food: 8, health: -2, useTime: 1.2, sound: 'eat' } });
def({ id: 'corn', name: 'Corn', cat: 'food', stack: 20, weight: 0.2, icon: { s: 'grain', a: '#e0c83c', b: '#7a9b3a' }, desc: 'Grown in fields outside town.', consume: { food: 14, water: 8, useTime: 1.8, sound: 'eat' } });
def({ id: 'pumpkin', name: 'Pumpkin', cat: 'food', w: 2, h: 2, stack: 6, weight: 1.2, icon: { s: 'fruit', a: '#c9762a', b: '#8a4f1a' }, desc: 'Heavy but very filling.', consume: { food: 42, water: 20, useTime: 3.4, sound: 'eat' } });
def({ id: 'honey', name: 'Honeycomb', cat: 'food', stack: 10, weight: 0.2, rarity: 'uncommon', icon: { s: 'honey', a: '#e0a02c', b: '#a8741a' }, desc: 'Sweet, medicinal, sticky.', consume: { food: 18, health: 10, stamina: 30, useTime: 2, sound: 'eat' } });
def({ id: 'raw_meat', name: 'Raw Meat', cat: 'food', stack: 12, weight: 0.4, icon: { s: 'meat', a: '#b5514f', b: '#8a3a38' }, desc: 'Cook it unless you enjoy vomiting.', consume: { food: 10, health: -12, useTime: 2.6, sound: 'eat' }, cooksInto: 'cooked_meat' });
def({ id: 'cooked_meat', name: 'Cooked Meat', cat: 'food', stack: 12, weight: 0.35, icon: { s: 'meat', a: '#8a5a38', b: '#5f3d24' }, desc: 'Proper food.', consume: { food: 36, health: 6, temp: 3, useTime: 2.4, sound: 'eat' } });
def({ id: 'raw_fish', name: 'Raw Fish', cat: 'food', w: 1, h: 2, stack: 10, weight: 0.4, icon: { s: 'fish', a: '#7d8a94', b: '#566169' }, desc: 'Caught from the shallows.', consume: { food: 9, health: -8, useTime: 2.4, sound: 'eat' }, cooksInto: 'cooked_fish' });
def({ id: 'cooked_fish', name: 'Cooked Fish', cat: 'food', w: 1, h: 2, stack: 10, weight: 0.35, icon: { s: 'fish', a: '#a8814d', b: '#7d5f36' }, desc: 'Light, clean protein.', consume: { food: 28, water: 6, health: 4, temp: 2, useTime: 2.2, sound: 'eat' } });
def({ id: 'bread', name: 'Stale Bread', cat: 'food', w: 2, h: 1, stack: 8, weight: 0.3, icon: { s: 'grain', a: '#b59a6a', b: '#8a7448' }, desc: 'Hard as a brick, still food.', consume: { food: 22, water: -4, useTime: 2.2, sound: 'eat' } });

def({ id: 'water_bottle', name: 'Water Bottle', cat: 'drink', stack: 6, weight: 0.5, icon: { s: 'bottle', a: '#7fb8d8', b: '#3d7fb5' }, desc: 'Clean water.', consume: { water: 40, useTime: 2.4, sound: 'drink' } });
def({ id: 'dirty_water', name: 'Dirty Water', cat: 'drink', stack: 6, weight: 0.5, icon: { s: 'bottle', a: '#8a7d52', b: '#5f5433' }, desc: 'Boil it first. Or don\'t.', consume: { water: 32, health: -10, useTime: 2.4, sound: 'drink' } });
def({ id: 'canteen', name: 'Canteen', cat: 'drink', w: 1, h: 2, stack: 3, weight: 1, rarity: 'uncommon', icon: { s: 'canteen', a: '#4a5240', b: '#8d9298' }, desc: 'Holds a lot of water.', consume: { water: 80, useTime: 3.2, sound: 'drink' } });
def({ id: 'soda', name: 'Can of Soda', cat: 'drink', stack: 8, weight: 0.35, icon: { s: 'soda', a: '#a3251f', b: '#e8e2d4' }, desc: 'Sugar and bubbles.', consume: { water: 26, food: 6, stamina: 30, useTime: 1.8, sound: 'drink', leftover: 'empty_can' } });
def({ id: 'energy_drink', name: 'Energy Drink', cat: 'drink', stack: 8, weight: 0.35, rarity: 'uncommon', icon: { s: 'soda', a: '#63a84b', b: '#c9a227' }, desc: 'Sprint forever. Crash later.', consume: { water: 18, stamina: 100, useTime: 1.6, sound: 'drink', leftover: 'empty_can' } });
def({ id: 'coffee', name: 'Instant Coffee', cat: 'drink', stack: 8, weight: 0.3, icon: { s: 'soda', a: '#4a3226', b: '#8a6134' }, desc: 'Warm and bracing.', consume: { water: 14, stamina: 45, temp: 6, useTime: 2.4, sound: 'drink' } });
def({ id: 'vodka', name: 'Bottle of Vodka', cat: 'drink', w: 1, h: 2, stack: 4, weight: 0.7, icon: { s: 'bottle', a: '#d4d8dc', b: '#8d9298' }, desc: 'Warms you. Blurs everything.', consume: { water: -6, health: 12, temp: 10, painkiller: 20, useTime: 3, sound: 'drink' } });

// =============================================================================
// TOOLS & UTILITY
// =============================================================================

def({ id: 'hammer', name: 'Building Hammer', cat: 'tool', w: 1, h: 2, weight: 1, icon: { s: 'hammer', a: '#8d9298', b: '#8a6134' }, desc: 'Upgrades and repairs structures.', durability: 800, melee: { damage: 15, range: 54, arc: 60, speed: 0.5, stamina: 4, knockback: 40, power: 1, classes: ['building'], noise: 130 } });
def({ id: 'building_plan', name: 'Building Plan', cat: 'tool', w: 1, h: 2, weight: 0.3, icon: { s: 'plan', a: '#c9cdd1', b: '#3d7fb5' }, desc: 'Place foundations, walls and doors.' });
def({ id: 'lighter', name: 'Lighter', cat: 'tool', weight: 0.1, icon: { s: 'lighter', a: '#c9452a', b: '#c9a227' }, desc: 'Lights fires and molotovs.', durability: 200, light: 90 });
def({ id: 'matches', name: 'Matches', cat: 'tool', stack: 20, weight: 0.05, icon: { s: 'lighter', a: '#8a6134', b: '#c9452a' }, desc: 'Single-use flame.' });
def({ id: 'flashlight', name: 'Flashlight', cat: 'tool', w: 1, h: 2, weight: 0.4, rarity: 'uncommon', icon: { s: 'flashlight', a: '#3a3f44', b: '#e8e2c0' }, desc: 'A cone of light. And a beacon.', durability: 300, light: 340 });
def({ id: 'lantern', name: 'Oil Lantern', cat: 'tool', w: 1, h: 2, weight: 0.8, icon: { s: 'lantern', a: '#8d9298', b: '#e0a02c' }, desc: 'Steady warm glow all around.', durability: 300, light: 250 });
def({ id: 'binoculars', name: 'Binoculars', cat: 'tool', w: 2, h: 2, weight: 0.6, rarity: 'uncommon', icon: { s: 'binoculars', a: '#2f3337', b: '#3d7fb5' }, desc: 'See trouble before it sees you.' });
def({ id: 'compass_item', name: 'Compass', cat: 'tool', weight: 0.2, icon: { s: 'compass', a: '#8d9298', b: '#a3251f' }, desc: 'Points north. Reassuring.' });
def({ id: 'map_item', name: 'Region Map', cat: 'tool', w: 2, h: 2, weight: 0.2, icon: { s: 'map', a: '#c4b896', b: '#8a7448' }, desc: 'Reveals the surrounding towns.' });
def({ id: 'radio', name: 'Hand Radio', cat: 'tool', w: 1, h: 2, weight: 0.5, rarity: 'uncommon', icon: { s: 'radio', a: '#3a3f44', b: '#c9a227' }, desc: 'Static, mostly. Sometimes voices.' });
def({ id: 'lockpick', name: 'Lockpick', cat: 'tool', stack: 10, weight: 0.05, rarity: 'uncommon', icon: { s: 'key', a: '#a9afb5', b: '#787d82' }, desc: 'Opens locked containers and doors.' });
def({ id: 'fishing_rod', name: 'Fishing Rod', cat: 'tool', w: 1, h: 4, weight: 0.7, icon: { s: 'rod', a: '#8a6134', b: '#c9cdd1' }, desc: 'Fish from any shoreline.', durability: 200 });
def({ id: 'hunting_trap', name: 'Hunting Trap', cat: 'placeable', w: 2, h: 2, stack: 4, weight: 2, rarity: 'uncommon', icon: { s: 'trap', a: '#8d9298', b: '#5f6469' }, desc: 'Snaps shut on legs.', deploy: 'bear_trap' });
def({ id: 'spike_trap', name: 'Wooden Spikes', cat: 'placeable', w: 2, h: 2, stack: 6, weight: 3, icon: { s: 'trap', a: '#8a6134', b: '#6b4a27' }, desc: 'Cheap area denial.', deploy: 'spikes' });

// =============================================================================
// DEPLOYABLES
// =============================================================================

def({ id: 'campfire', name: 'Campfire', cat: 'placeable', w: 2, h: 2, weight: 3, icon: { s: 'campfire', a: '#8a6134', b: '#e0a02c' }, desc: 'Cook, warm up, and see at night.', deploy: 'campfire' });
def({ id: 'furnace', name: 'Furnace', cat: 'placeable', w: 2, h: 2, weight: 8, rarity: 'uncommon', icon: { s: 'furnace', a: '#7f8489', b: '#e0a02c' }, desc: 'Smelts ore into usable metal.', deploy: 'furnace' });
def({ id: 'workbench_1', name: 'Workbench Level 1', cat: 'placeable', w: 3, h: 2, weight: 12, icon: { s: 'workbench', a: '#8a6134', b: '#8d9298' }, desc: 'Unlocks tier 1 crafting.', deploy: 'workbench_1' });
def({ id: 'workbench_2', name: 'Workbench Level 2', cat: 'placeable', w: 3, h: 2, weight: 20, rarity: 'uncommon', icon: { s: 'workbench', a: '#6b4a27', b: '#9aa0a6' }, desc: 'Unlocks tier 2 crafting.', deploy: 'workbench_2' });
def({ id: 'workbench_3', name: 'Workbench Level 3', cat: 'placeable', w: 3, h: 2, weight: 30, rarity: 'rare', icon: { s: 'workbench', a: '#4a4f54', b: '#c9ccd1' }, desc: 'Unlocks the best blueprints.', deploy: 'workbench_3' });
def({ id: 'storage_box', name: 'Wood Storage Box', cat: 'placeable', w: 2, h: 2, weight: 10, icon: { s: 'box', a: '#8a6134', b: '#6b4a27' }, desc: '18 slots of safe storage.', deploy: 'storage_box' });
def({ id: 'large_box', name: 'Large Wood Box', cat: 'placeable', w: 3, h: 2, weight: 18, rarity: 'uncommon', icon: { s: 'box', a: '#6b4a27', b: '#4a3219' }, desc: '30 slots of safe storage.', deploy: 'large_box' });
def({ id: 'sleeping_bag', name: 'Sleeping Bag', cat: 'placeable', w: 2, h: 2, weight: 2, icon: { s: 'bed', a: '#4a5568', b: '#333d4a' }, desc: 'Sets your respawn point.', deploy: 'sleeping_bag' });
def({ id: 'water_catcher', name: 'Water Catcher', cat: 'placeable', w: 2, h: 2, weight: 6, icon: { s: 'catcher', a: '#5f6469', b: '#3d7fb5' }, desc: 'Collects clean water from rain.', deploy: 'water_catcher' });
def({ id: 'tool_cupboard', name: 'Tool Cupboard', cat: 'placeable', w: 2, h: 2, weight: 14, rarity: 'uncommon', icon: { s: 'box', a: '#8d9298', b: '#c9a227' }, desc: 'Claims and protects your base.', deploy: 'tool_cupboard' });
def({ id: 'door_wood', name: 'Wooden Door', cat: 'placeable', w: 2, h: 3, weight: 8, icon: { s: 'door', a: '#8a6134', b: '#6b4a27' }, desc: 'Fits a doorway frame.', deploy: 'door_wood' });
def({ id: 'door_metal', name: 'Sheet Metal Door', cat: 'placeable', w: 2, h: 3, weight: 16, rarity: 'uncommon', icon: { s: 'door', a: '#8d9298', b: '#5f6469' }, desc: 'Takes real explosives to breach.', deploy: 'door_metal' });
def({ id: 'saddle', name: 'Horse Saddle', cat: 'placeable', w: 2, h: 2, weight: 4, rarity: 'uncommon', icon: { s: 'saddle', a: '#7a5533', b: '#573a22' }, desc: 'Tame a wild horse and ride it.', deploy: 'saddle' });

export const ITEMS: ReadonlyMap<string, ItemDef> = DB;

export function itemDef(id: string): ItemDef {
  const d = DB.get(id);
  if (!d) throw new Error(`unknown item id: ${id}`);
  return d;
}

export const hasItem = (id: string): boolean => DB.has(id);

export const allItems = (): ItemDef[] => [...DB.values()];

/** Every ammo id that feeds a given weapon chamber. */
export function ammoFor(kind: AmmoKind): string[] {
  return allItems().filter((d) => d.ammoKind === kind).map((d) => d.id);
}

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
