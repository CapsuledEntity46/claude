/**
 * Character-creation point buy, following the D&D 5e / Baldur's Gate 3 rules.
 *
 * Six ability scores start at 8, may be raised to at most 15 during creation, and
 * are paid for out of a fixed bank of 27 points on a scale that charges double for
 * the last two steps. That cost curve is the whole point of the system: it makes a
 * 15 cost more than twice a 13, so a spread of good scores is a real alternative to
 * two maxed ones rather than a strictly worse choice.
 *
 * ## Deliberately free of DOM, three.js and game imports
 *
 * Everything here is arithmetic over a plain record, which means the rules can be
 * unit-tested directly instead of through a browser — the same reason
 * `combat/GestureTracker.ts` is written this way. It also means the module drops
 * unchanged into any view layer: this project drives its UI from plain DOM, but the
 * state is immutable, so a React `useState` or a Vue `ref` can hold it and
 * re-render from identity alone.
 *
 * ## Why the state is immutable
 *
 * `increase` and `decrease` return a new state rather than mutating. Mutating in
 * place is cheaper, but it defeats change detection in every reactive view layer and
 * makes an undo stack impossible — and "let me try a different build" is exactly
 * what a creation screen is for.
 *
 * The 15 cap applies *only to this phase*. Levelling raises scores past it later,
 * which is how 5e works: point buy is the floor you start from, not the ceiling.
 */

/**
 * The six core abilities.
 *
 * Written out as an interface rather than a `Record<AbilityKey, number>` alias so
 * that a missing ability is a compile error at every construction site, and so the
 * shape shows up in editor tooltips as six named fields.
 */
export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** A single ability's key. Derived from the interface, so the two cannot drift. */
export type AbilityKey = keyof AbilityScores;

/**
 * Iteration order for the UI.
 *
 * The canonical 5e order, which players read as a familiar block rather than an
 * arbitrary list. Exported as the single source of truth for "which abilities
 * exist": loops and validation walk this, so adding or removing one is a change
 * here plus the interface above.
 */
export const ABILITY_KEYS: readonly AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export interface AbilityInfo {
  /** Three-letter form, as the sheet labels it. */
  abbr: string;
  name: string;
  /** What the score does, for a tooltip. */
  blurb: string;
}

export const ABILITY_INFO: Readonly<Record<AbilityKey, AbilityInfo>> = {
  str: { abbr: 'STR', name: 'Strength', blurb: 'Melee damage, knockback, and how much you can carry.' },
  dex: { abbr: 'DEX', name: 'Dexterity', blurb: 'Ranged damage, movement speed, and critical hits.' },
  con: { abbr: 'CON', name: 'Constitution', blurb: 'Health, stamina recovery, and resistance to falling.' },
  int: { abbr: 'INT', name: 'Intelligence', blurb: 'Spell damage and the size of your mana pool.' },
  wis: { abbr: 'WIS', name: 'Wisdom', blurb: 'Spell slots, mana recovery, and magical resistance.' },
  cha: { abbr: 'CHA', name: 'Charisma', blurb: 'Presence: how readily foes commit to you, and what they carry.' },
};

/** The rules of the creation phase, in one place. */
export const POINT_BUY = {
  /** Every ability starts here, and may not be reduced below it. */
  baseline: 8,
  /** The highest score buyable during creation. Levelling exceeds this later. */
  manualMax: 15,
  /** Points available to spend across all six abilities. */
  budget: 27,
} as const;

/**
 * The cost of *reaching* each score from the one below it.
 *
 * Written as the per-step price because that is how the rule is stated — "going
 * from 13 to 14 costs 2" — and the cumulative table below is derived from it. The
 * reverse (hard-coding totals) invites the two from disagreeing.
 */
const STEP_COST: Readonly<Record<number, number>> = {
  9: 1,
  10: 1,
  11: 1,
  12: 1,
  13: 1,
  14: 2,
  15: 2,
};

/**
 * Total points sunk into a score, measured from the baseline.
 *
 * Built once from `STEP_COST` by running the steps up, so the familiar 5e table
 * (8:0, 9:1, 10:2, 11:3, 12:4, 13:5, 14:7, 15:9) is a consequence of the rule
 * rather than a second copy of it.
 */
const CUMULATIVE_COST: Readonly<Record<number, number>> = ((): Record<number, number> => {
  const table: Record<number, number> = { [POINT_BUY.baseline]: 0 };
  let running = 0;
  for (let score = POINT_BUY.baseline + 1; score <= POINT_BUY.manualMax; score++) {
    running += STEP_COST[score] ?? 0;
    table[score] = running;
  }
  return table;
})();

/**
 * Immutable snapshot of an allocation.
 *
 * `spent` and `remaining` are stored rather than recomputed by the view so that
 * every reader agrees on the budget, and so a UI can bind straight to them.
 */
export interface PointBuyState {
  readonly scores: Readonly<AbilityScores>;
  /** Points committed so far. */
  readonly spent: number;
  /** Points still in the bank. Never negative for a state this module produced. */
  readonly remaining: number;
}

/** Why a build is not yet legal. Empty means it is. */
export type PointBuyIssue =
  | { readonly kind: 'points-remaining'; readonly remaining: number }
  | { readonly kind: 'over-budget'; readonly spent: number }
  | { readonly kind: 'out-of-range'; readonly ability: AbilityKey; readonly score: number };

/**
 * The 5e ability modifier: the number that actually reaches the rest of the game.
 *
 * Scores are flavour; modifiers are mechanics. Exported here because the creation
 * screen has to show it — a player choosing between 13 and 14 needs to see that
 * only one of them moves the modifier.
 */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Total cost of a single score, from the baseline. Unreachable scores cost Infinity. */
export function costOfScore(score: number): number {
  const cost = CUMULATIVE_COST[score];
  return cost === undefined ? Number.POSITIVE_INFINITY : cost;
}

/**
 * Cost of the next point in an ability, or null if that step is not available.
 *
 * Null rather than Infinity so callers must acknowledge the "no such step" case;
 * a UI wants to disable the button, not price it at infinity.
 */
export function costToRaise(from: number): number | null {
  const next = from + 1;
  if (next > POINT_BUY.manualMax) return null;
  const step = STEP_COST[next];
  return step === undefined ? null : step;
}

/** Points refunded by lowering an ability by one, or null if it is already at the floor. */
export function refundToLower(from: number): number | null {
  if (from - 1 < POINT_BUY.baseline) return null;
  const step = STEP_COST[from];
  return step === undefined ? null : step;
}

/** Points committed by a set of scores. */
export function pointsSpent(scores: Readonly<AbilityScores>): number {
  let total = 0;
  for (const key of ABILITY_KEYS) total += costOfScore(scores[key]);
  return total;
}

function baselineScores(): AbilityScores {
  return { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
}

/** Wraps a set of scores into a state, recomputing the budget from scratch. */
function stateFrom(scores: AbilityScores): PointBuyState {
  const spent = pointsSpent(scores);
  return { scores, spent, remaining: POINT_BUY.budget - spent };
}

/** A fresh allocation: every ability at the baseline, the full bank unspent. */
export function createPointBuyState(): PointBuyState {
  return stateFrom(baselineScores());
}

/** Returns the allocation to its starting position. */
export function reset(): PointBuyState {
  return createPointBuyState();
}

/** Whether one more point can be put into an ability. */
export function canIncrease(state: PointBuyState, ability: AbilityKey): boolean {
  const cost = costToRaise(state.scores[ability]);
  return cost !== null && cost <= state.remaining;
}

/** Whether a point can be taken back out of an ability. */
export function canDecrease(state: PointBuyState, ability: AbilityKey): boolean {
  return refundToLower(state.scores[ability]) !== null;
}

/**
 * Spends the next point in an ability.
 *
 * Returns the state unchanged when the move is illegal — the cap, the floor and the
 * bank are all enforced here, so a caller that forgets to check `canIncrease` gets
 * a no-op instead of a corrupt allocation.
 */
export function increase(state: PointBuyState, ability: AbilityKey): PointBuyState {
  if (!canIncrease(state, ability)) return state;
  const scores: AbilityScores = { ...state.scores, [ability]: state.scores[ability] + 1 };
  return stateFrom(scores);
}

/** Takes one point back out of an ability, refunding its scaled cost. */
export function decrease(state: PointBuyState, ability: AbilityKey): PointBuyState {
  if (!canDecrease(state, ability)) return state;
  const scores: AbilityScores = { ...state.scores, [ability]: state.scores[ability] - 1 };
  return stateFrom(scores);
}

/**
 * Everything wrong with an allocation, for the UI to explain.
 *
 * Separate from `isComplete` so the screen can say *why* the Confirm button is
 * disabled. "27 points must be spent" is actionable; a dead button is not.
 */
export function validationIssues(state: PointBuyState): readonly PointBuyIssue[] {
  const issues: PointBuyIssue[] = [];
  for (const key of ABILITY_KEYS) {
    const score = state.scores[key];
    if (!Number.isInteger(score) || score < POINT_BUY.baseline || score > POINT_BUY.manualMax) {
      issues.push({ kind: 'out-of-range', ability: key, score });
    }
  }
  if (state.spent > POINT_BUY.budget) issues.push({ kind: 'over-budget', spent: state.spent });
  else if (state.remaining > 0) issues.push({ kind: 'points-remaining', remaining: state.remaining });
  return issues;
}

/**
 * Whether the build is legal and finished.
 *
 * Finished means the bank is empty, not merely "not overdrawn". Leftover points are
 * always a mistake rather than a choice — there is nothing to save them for, since
 * levelling grants its own separate points.
 */
export function isComplete(state: PointBuyState): boolean {
  return validationIssues(state).length === 0;
}

/**
 * Rebuilds a state from untrusted scores, clamping anything out of range.
 *
 * For loading a saved or hand-edited allocation: a score of 900 or a missing
 * ability must not produce NaN budgets downstream, which is exactly what spreading
 * a stored object straight into the state would do.
 */
export function sanitizeScores(raw: Partial<Record<AbilityKey, unknown>> | null | undefined): PointBuyState {
  const scores: AbilityScores = baselineScores();
  if (raw) {
    for (const key of ABILITY_KEYS) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const rounded = Math.round(value);
      scores[key] = Math.max(POINT_BUY.baseline, Math.min(POINT_BUY.manualMax, rounded));
    }
  }
  return stateFrom(scores);
}

/**
 * A spread that spends the whole bank, for a "recommended" button.
 *
 * 15/15/14/10/8/8 costs exactly 9+9+7+2 = 27: two abilities at the cap, a strong
 * third, one ability nudged to average, and two conceded. The obvious-looking
 * 15/15/13/10 is only 25 — the double-priced steps make totals easy to get wrong
 * by hand, which is the same reason the cost table above is derived rather than
 * typed out.
 */
export function suggestedAllocation(primary: AbilityKey, secondary: AbilityKey, tertiary: AbilityKey): PointBuyState {
  const scores: AbilityScores = baselineScores();
  if (primary === secondary || secondary === tertiary || primary === tertiary) return stateFrom(scores);
  scores[primary] = 15;
  scores[secondary] = 15;
  scores[tertiary] = 14;
  // The last two points go to whichever ability is left over first, taking it to 10.
  const spare = ABILITY_KEYS.find((key) => key !== primary && key !== secondary && key !== tertiary);
  if (spare) scores[spare] = 10;
  return stateFrom(scores);
}
