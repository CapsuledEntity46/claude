import type { AbilityKey, AbilityScores } from './PointBuy';

/**
 * The skill tree: four branches, ranked nodes, and a modifier layer.
 *
 * ## Why a modifier layer had to exist first
 *
 * Every derived number in `PlayerStats` used to be a getter over hard-coded
 * constants — `maxHp = 30 + (level - 1) * 6 + might * 3` and so on. There was
 * nowhere for a skill to *say* "+10% melee damage", so the first job here is a
 * plain bag of modifiers that the stat getters consult. Skills contribute to the
 * bag; nothing reaches into the formulas directly.
 *
 * The bag is additive for percentages (two +10% skills give +20%, not +21%).
 * Multiplicative stacking is the usual alternative and it is worse here: it makes
 * every number depend on the order the tree was bought in, which is impossible to
 * explain on a tooltip and unpleasant to test.
 *
 * ## Deliberately free of DOM, three.js and game imports
 *
 * Same reason as `PointBuy.ts` and `combat/GestureTracker.ts`: the rules are then
 * directly unit-testable, and prerequisites are exactly the kind of thing that
 * silently rots without tests.
 */

export type SkillBranch = 'blade' | 'hunt' | 'arcana' | 'endurance';

export const SKILL_BRANCHES: readonly SkillBranch[] = ['blade', 'hunt', 'arcana', 'endurance'];

export interface BranchInfo {
  name: string;
  blurb: string;
  /** The ability the branch leans on, shown in the UI as a hint. */
  ability: AbilityKey;
}

export const BRANCH_INFO: Readonly<Record<SkillBranch, BranchInfo>> = {
  blade: { name: 'Blade', blurb: 'Melee: heavier strokes, wider sweeps, armour broken open.', ability: 'str' },
  hunt: { name: 'Hunt', blurb: 'Ranged: faster draws, surer shots, crueller criticals.', ability: 'dex' },
  arcana: { name: 'Arcana', blurb: 'Magic: cheaper spells, deeper mana, faster recovery.', ability: 'int' },
  endurance: { name: 'Endurance', blurb: 'Survival: health, armour, stamina, and hard landings.', ability: 'con' },
};

/**
 * Everything a skill can change.
 *
 * Flat fields rather than a `Map<string, number>` so that a typo in a skill
 * definition is a compile error instead of a modifier that silently does nothing.
 * Percentage fields are stored as fractions: 0.1 means +10%.
 */
export interface SkillModifiers {
  meleeDamage: number;
  rangedDamage: number;
  spellDamage: number;
  /** Added to an attack's crit chance, as an absolute probability. */
  critChance: number;
  /** Added to armour pierce, clamped to 1 by the damage formula. */
  armorPierce: number;
  /** Extra degrees on a swing's arc, as a fraction of the base. */
  swingArc: number;
  knockback: number;
  /** Flat bonus hit points. */
  maxHp: number;
  /** Flat bonus armour, before resistances. */
  armor: number;
  maxStamina: number;
  maxMana: number;
  /** Multiplies health regeneration. */
  healthRegen: number;
  staminaRegen: number;
  /** Multiplies mana cost: -0.2 means spells cost 20% less. */
  manaCost: number;
  /** Speeds spell-slot recovery. */
  slotRegen: number;
  moveSpeed: number;
  /** Reduces fall damage: 0.5 means half. */
  fallDamage: number;
  /** Reduces the stamina cost of attacks. */
  attackStamina: number;
  /** Shortens bow draw time. */
  drawSpeed: number;
}

export const NO_MODIFIERS: Readonly<SkillModifiers> = {
  meleeDamage: 0,
  rangedDamage: 0,
  spellDamage: 0,
  critChance: 0,
  armorPierce: 0,
  swingArc: 0,
  knockback: 0,
  maxHp: 0,
  armor: 0,
  maxStamina: 0,
  maxMana: 0,
  healthRegen: 0,
  staminaRegen: 0,
  manaCost: 0,
  slotRegen: 0,
  moveSpeed: 0,
  fallDamage: 0,
  attackStamina: 0,
  drawSpeed: 0,
};

export interface SkillNode {
  id: string;
  branch: SkillBranch;
  name: string;
  blurb: string;
  /** Depth in the branch. Tier 1 needs nothing; deeper tiers need their parent. */
  tier: number;
  /** How many points can be sunk into it. */
  maxRank: number;
  /** Skill points per rank. */
  cost: number;
  /** The node that must be bought into first, if any. */
  requires?: string;
  /** A minimum ability score, in the spirit of 5e multiclass requirements. */
  minAbility?: { ability: AbilityKey; score: number };
  /** What one rank contributes. Ranks multiply this. */
  perRank: Partial<SkillModifiers>;
}

/**
 * The tree.
 *
 * Each branch runs three tiers: two cheap entry nodes, a middle pair, and a
 * capstone that costs more and asks for a real investment in the branch's ability.
 * The ability gates are what stop a character with 8 Strength buying the whole
 * Blade capstone line — point buy decided what you are good at, and the tree has
 * to respect that or the two systems are unrelated.
 */
export const SKILL_NODES: readonly SkillNode[] = [
  // ---------------------------------------------------------------- blade
  {
    id: 'blade_edge',
    branch: 'blade',
    name: 'Keen Edge',
    blurb: '+6% melee damage per rank.',
    tier: 1,
    maxRank: 3,
    cost: 1,
    perRank: { meleeDamage: 0.06 },
  },
  {
    id: 'blade_sweep',
    branch: 'blade',
    name: 'Wide Sweep',
    blurb: '+10% swing arc per rank, so a cut catches more of what is in front of you.',
    tier: 1,
    maxRank: 2,
    cost: 1,
    perRank: { swingArc: 0.1 },
  },
  {
    id: 'blade_vigour',
    branch: 'blade',
    name: 'Tireless Arm',
    blurb: 'Attacks cost 12% less stamina per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'blade_edge',
    perRank: { attackStamina: 0.12 },
  },
  {
    id: 'blade_sunder',
    branch: 'blade',
    name: 'Sunder',
    blurb: '+8% armour pierce and +15% knockback per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'blade_edge',
    minAbility: { ability: 'str', score: 12 },
    perRank: { armorPierce: 0.08, knockback: 0.15 },
  },
  {
    id: 'blade_executioner',
    branch: 'blade',
    name: 'Executioner',
    blurb: '+10% melee damage and +5% critical chance.',
    tier: 3,
    maxRank: 1,
    cost: 2,
    requires: 'blade_sunder',
    minAbility: { ability: 'str', score: 14 },
    perRank: { meleeDamage: 0.1, critChance: 0.05 },
  },

  // ---------------------------------------------------------------- hunt
  {
    id: 'hunt_aim',
    branch: 'hunt',
    name: 'Steady Aim',
    blurb: '+6% ranged damage per rank.',
    tier: 1,
    maxRank: 3,
    cost: 1,
    perRank: { rangedDamage: 0.06 },
  },
  {
    id: 'hunt_draw',
    branch: 'hunt',
    name: 'Quick Draw',
    blurb: 'Bows come to full draw 12% faster per rank.',
    tier: 1,
    maxRank: 2,
    cost: 1,
    perRank: { drawSpeed: 0.12 },
  },
  {
    id: 'hunt_footwork',
    branch: 'hunt',
    name: 'Footwork',
    blurb: '+4% movement speed per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'hunt_aim',
    perRank: { moveSpeed: 0.04 },
  },
  {
    id: 'hunt_precision',
    branch: 'hunt',
    name: 'Precision',
    blurb: '+4% critical chance per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'hunt_aim',
    minAbility: { ability: 'dex', score: 12 },
    perRank: { critChance: 0.04 },
  },
  {
    id: 'hunt_deadeye',
    branch: 'hunt',
    name: 'Deadeye',
    blurb: '+12% ranged damage and +10% armour pierce.',
    tier: 3,
    maxRank: 1,
    cost: 2,
    requires: 'hunt_precision',
    minAbility: { ability: 'dex', score: 14 },
    perRank: { rangedDamage: 0.12, armorPierce: 0.1 },
  },

  // ---------------------------------------------------------------- arcana
  {
    id: 'arcana_power',
    branch: 'arcana',
    name: 'Focused Will',
    blurb: '+7% spell damage per rank.',
    tier: 1,
    maxRank: 3,
    cost: 1,
    perRank: { spellDamage: 0.07 },
  },
  {
    id: 'arcana_reservoir',
    branch: 'arcana',
    name: 'Deep Reservoir',
    blurb: '+15 maximum mana per rank.',
    tier: 1,
    maxRank: 2,
    cost: 1,
    perRank: { maxMana: 15 },
  },
  {
    id: 'arcana_thrift',
    branch: 'arcana',
    name: 'Thrift',
    blurb: 'Spells cost 10% less mana per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'arcana_power',
    perRank: { manaCost: 0.1 },
  },
  {
    id: 'arcana_recovery',
    branch: 'arcana',
    name: 'Second Wind',
    blurb: 'Spell slots return 20% faster per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'arcana_reservoir',
    minAbility: { ability: 'wis', score: 12 },
    perRank: { slotRegen: 0.2 },
  },
  {
    id: 'arcana_archmage',
    branch: 'arcana',
    name: 'Archmage',
    blurb: '+12% spell damage and +4% critical chance.',
    tier: 3,
    maxRank: 1,
    cost: 2,
    requires: 'arcana_thrift',
    minAbility: { ability: 'int', score: 14 },
    perRank: { spellDamage: 0.12, critChance: 0.04 },
  },

  // ---------------------------------------------------------------- endurance
  {
    id: 'end_vitality',
    branch: 'endurance',
    name: 'Vitality',
    blurb: '+8 maximum health per rank.',
    tier: 1,
    maxRank: 3,
    cost: 1,
    perRank: { maxHp: 8 },
  },
  {
    id: 'end_wind',
    branch: 'endurance',
    name: 'Long Wind',
    blurb: '+10 stamina and 15% faster stamina recovery per rank.',
    tier: 1,
    maxRank: 2,
    cost: 1,
    perRank: { maxStamina: 10, staminaRegen: 0.15 },
  },
  {
    id: 'end_hide',
    branch: 'endurance',
    name: 'Thick Hide',
    blurb: '+1 armour per rank.',
    tier: 2,
    maxRank: 3,
    cost: 1,
    requires: 'end_vitality',
    perRank: { armor: 1 },
  },
  {
    id: 'end_landing',
    branch: 'endurance',
    name: 'Sure Footing',
    blurb: 'Fall damage reduced by 25% per rank.',
    tier: 2,
    maxRank: 2,
    cost: 1,
    requires: 'end_vitality',
    perRank: { fallDamage: 0.25 },
  },
  {
    id: 'end_resurgence',
    branch: 'endurance',
    name: 'Resurgence',
    blurb: 'Health recovers twice as fast, and +10 maximum health.',
    tier: 3,
    maxRank: 1,
    cost: 2,
    requires: 'end_hide',
    minAbility: { ability: 'con', score: 14 },
    perRank: { healthRegen: 1, maxHp: 10 },
  },
];

const NODE_BY_ID: Readonly<Record<string, SkillNode>> = (():
  Record<string, SkillNode> => {
  const map: Record<string, SkillNode> = {};
  for (const node of SKILL_NODES) map[node.id] = node;
  return map;
})();

export function skillNode(id: string): SkillNode | undefined {
  return NODE_BY_ID[id];
}

export function nodesInBranch(branch: SkillBranch): readonly SkillNode[] {
  return SKILL_NODES.filter((node) => node.branch === branch);
}

/** Ranks bought, keyed by node id. A missing key means rank 0. */
export type SkillRanks = Readonly<Record<string, number>>;

/** One skill point per level, so the tree grows at a predictable pace. */
export const SKILL_POINTS_PER_LEVEL = 1;

/**
 * Points a character of this level has ever had.
 *
 * Level 1 starts with one, so the tree is not inert for the whole first level.
 */
export function totalSkillPoints(level: number): number {
  return Math.max(0, level) * SKILL_POINTS_PER_LEVEL;
}

export function pointsSpentOnSkills(ranks: SkillRanks): number {
  let total = 0;
  for (const [id, rank] of Object.entries(ranks)) {
    const node = NODE_BY_ID[id];
    if (!node || rank <= 0) continue;
    total += Math.min(rank, node.maxRank) * node.cost;
  }
  return total;
}

export function rankOf(ranks: SkillRanks, id: string): number {
  return ranks[id] ?? 0;
}

/** Why a node cannot be bought. Null means it can. */
export type SkillBlock =
  | { kind: 'unknown-node' }
  | { kind: 'maxed' }
  | { kind: 'not-enough-points'; needed: number; available: number }
  | { kind: 'requires-node'; node: SkillNode }
  | { kind: 'requires-ability'; ability: AbilityKey; score: number };

/**
 * Whether a node can take another rank, and if not, why.
 *
 * Returns the reason rather than a bare boolean so the UI can print it. "Needs
 * Strength 14" is a goal; a greyed-out button is a mystery.
 */
export function blockOnPurchase(
  ranks: SkillRanks,
  id: string,
  level: number,
  scores: Readonly<AbilityScores>,
): SkillBlock | null {
  const node = NODE_BY_ID[id];
  if (!node) return { kind: 'unknown-node' };
  if (rankOf(ranks, id) >= node.maxRank) return { kind: 'maxed' };

  if (node.requires) {
    const parent = NODE_BY_ID[node.requires];
    if (parent && rankOf(ranks, parent.id) <= 0) return { kind: 'requires-node', node: parent };
  }

  if (node.minAbility && scores[node.minAbility.ability] < node.minAbility.score) {
    return { kind: 'requires-ability', ability: node.minAbility.ability, score: node.minAbility.score };
  }

  const available = totalSkillPoints(level) - pointsSpentOnSkills(ranks);
  if (node.cost > available) return { kind: 'not-enough-points', needed: node.cost, available };

  return null;
}

export function canBuy(ranks: SkillRanks, id: string, level: number, scores: Readonly<AbilityScores>): boolean {
  return blockOnPurchase(ranks, id, level, scores) === null;
}

/**
 * Buys one rank, returning a new rank map.
 *
 * Immutable for the same reasons as `PointBuy`: reactive views and a workable
 * undo. Returns the input untouched when the purchase is illegal.
 */
export function buySkill(
  ranks: SkillRanks,
  id: string,
  level: number,
  scores: Readonly<AbilityScores>,
): SkillRanks {
  if (!canBuy(ranks, id, level, scores)) return ranks;
  return { ...ranks, [id]: rankOf(ranks, id) + 1 };
}

/**
 * Nodes that depend on this one, directly or through a chain.
 *
 * Needed because refunding a single rank must not orphan the nodes bought on top
 * of it — a tree where a prerequisite can vanish underneath its children is not a
 * tree, and the modifiers it reports would describe a build the player cannot have.
 */
export function dependentsOf(id: string): readonly SkillNode[] {
  const out: SkillNode[] = [];
  const frontier = [id];
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const node of SKILL_NODES) {
      if (node.requires !== current || out.some((n) => n.id === node.id)) continue;
      out.push(node);
      frontier.push(node.id);
    }
  }
  return out;
}

/**
 * Sums a build into one modifier bag.
 *
 * Unknown ids are skipped and ranks are clamped to the node's maximum, so a save
 * written by an older build — or hand-edited — degrades to a legal subset instead
 * of granting something impossible.
 */
export function aggregateModifiers(ranks: SkillRanks): SkillModifiers {
  const total: SkillModifiers = { ...NO_MODIFIERS };
  for (const [id, rawRank] of Object.entries(ranks)) {
    const node = NODE_BY_ID[id];
    if (!node) continue;
    const rank = Math.min(Math.max(0, Math.floor(rawRank)), node.maxRank);
    if (rank <= 0) continue;
    for (const [key, value] of Object.entries(node.perRank) as [keyof SkillModifiers, number][]) {
      total[key] += value * rank;
    }
  }
  return total;
}

/**
 * Drops ranks that the build no longer supports, repeatedly until it settles.
 *
 * One pass is not enough: clearing a tier-1 node invalidates tier 2, which in turn
 * invalidates tier 3, and a single sweep in definition order would leave the
 * deepest node standing on nothing. Loops until a pass changes nothing.
 *
 * This is what makes respeccing *abilities* safe too — dropping Strength below 14
 * has to take Executioner with it.
 */
export function pruneIllegalSkills(ranks: SkillRanks, level: number, scores: Readonly<AbilityScores>): SkillRanks {
  let current: Record<string, number> = {};
  for (const [id, rank] of Object.entries(ranks)) {
    const node = NODE_BY_ID[id];
    if (!node || rank <= 0) continue;
    current[id] = Math.min(Math.floor(rank), node.maxRank);
  }

  for (let pass = 0; pass < SKILL_NODES.length + 1; pass++) {
    let changed = false;
    const next: Record<string, number> = {};
    for (const [id, rank] of Object.entries(current)) {
      const node = NODE_BY_ID[id] as SkillNode;
      const parentOk = !node.requires || (current[node.requires] ?? 0) > 0;
      const abilityOk = !node.minAbility || scores[node.minAbility.ability] >= node.minAbility.score;
      if (parentOk && abilityOk) next[id] = rank;
      else changed = true;
    }
    current = next;

    // Over-spent builds shed their most expensive deepest nodes until affordable.
    while (pointsSpentOnSkills(current) > totalSkillPoints(level)) {
      const ids = Object.keys(current);
      if (ids.length === 0) break;
      let worst = ids[0];
      for (const id of ids) {
        const a = NODE_BY_ID[id] as SkillNode;
        const b = NODE_BY_ID[worst] as SkillNode;
        if (a.tier > b.tier || (a.tier === b.tier && a.cost > b.cost)) worst = id;
      }
      const remaining = (current[worst] ?? 0) - 1;
      if (remaining > 0) current[worst] = remaining;
      else delete current[worst];
      changed = true;
    }

    if (!changed) break;
  }
  return current;
}

/** Clears every skill, for a respec. */
export function clearSkills(): SkillRanks {
  return {};
}

/**
 * The gold a respec costs.
 *
 * Priced off level rather than off how much is invested, so the fee is predictable
 * before the player opens the screen, and so it scales with the income a character
 * of that level actually sees. Free at level 1, where there is nothing to undo.
 */
export function respecCost(level: number): number {
  if (level <= 1) return 0;
  return 40 + (level - 1) * 35;
}

/** A readable summary of a modifier bag, for the sheet. */
export function describeModifiers(mods: SkillModifiers): readonly string[] {
  const out: string[] = [];
  const pct = (value: number): string => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
  if (mods.meleeDamage) out.push(`${pct(mods.meleeDamage)} melee damage`);
  if (mods.rangedDamage) out.push(`${pct(mods.rangedDamage)} ranged damage`);
  if (mods.spellDamage) out.push(`${pct(mods.spellDamage)} spell damage`);
  if (mods.critChance) out.push(`${pct(mods.critChance)} critical chance`);
  if (mods.armorPierce) out.push(`${pct(mods.armorPierce)} armour pierce`);
  if (mods.swingArc) out.push(`${pct(mods.swingArc)} swing arc`);
  if (mods.knockback) out.push(`${pct(mods.knockback)} knockback`);
  if (mods.maxHp) out.push(`+${mods.maxHp} max health`);
  if (mods.armor) out.push(`+${mods.armor} armour`);
  if (mods.maxStamina) out.push(`+${mods.maxStamina} stamina`);
  if (mods.maxMana) out.push(`+${mods.maxMana} max mana`);
  if (mods.healthRegen) out.push(`${pct(mods.healthRegen)} health recovery`);
  if (mods.staminaRegen) out.push(`${pct(mods.staminaRegen)} stamina recovery`);
  if (mods.manaCost) out.push(`${pct(-mods.manaCost)} mana cost`);
  if (mods.slotRegen) out.push(`${pct(mods.slotRegen)} spell slot recovery`);
  if (mods.moveSpeed) out.push(`${pct(mods.moveSpeed)} movement speed`);
  if (mods.fallDamage) out.push(`${pct(-mods.fallDamage)} fall damage`);
  if (mods.attackStamina) out.push(`${pct(-mods.attackStamina)} attack stamina cost`);
  if (mods.drawSpeed) out.push(`${pct(mods.drawSpeed)} draw speed`);
  return out;
}
