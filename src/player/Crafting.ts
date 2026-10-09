import { item, itemForBlock, tryItem } from '../combat/items';
import { Block } from '../world/blocks';
import type { Inventory } from './Inventory';

/**
 * Crafting.
 *
 * A deliberately small system with one job: turn what the world drops into the
 * things you cannot find. Nothing here is a grid of shaped patterns — a recipe is
 * a list of ingredients and an output, because the interesting decision in this
 * game is *what to make*, not remembering where to put the sticks.
 *
 * Recipes are split by where they can be made. A handful are possible with your
 * hands, and they are exactly the ones needed to bootstrap: planks from a log, the
 * workbench itself, and the first pickaxe. Everything else wants a bench, which
 * gives the workbench a reason to exist beyond being craftable.
 */

export type RecipeGroup = 'tools' | 'building' | 'parts' | 'light';

export interface Ingredient {
  itemId: string;
  qty: number;
}

export interface Recipe {
  id: string;
  /** What it makes. */
  output: string;
  outputQty: number;
  inputs: readonly Ingredient[];
  /** Whether a workbench has to be within reach. */
  bench: boolean;
  group: RecipeGroup;
  /** Why you would want it. Shown under the name in the sheet. */
  note: string;
}


/**
 * Item id for a block.
 *
 * Block items are generated from the block registry and their ids are derived
 * from the block's display *name*, so writing them out by hand here would couple
 * this table to wording — rename "Stone Lintel" and a recipe silently vanishes.
 * Going through the enum makes a mistake a compile error instead.
 */
function b(block: Block): string {
  return itemForBlock(block)?.id ?? `missing_block_${block}`;
}

const RECIPES: readonly Recipe[] = [
  // --- by hand: the bootstrap ----------------------------------------------
  {
    id: 'planks',
    output: b(Block.Planks),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Wood), qty: 1 }],
    bench: false,
    group: 'building',
    note: 'Splits one log into four planks. The start of everything.',
  },
  {
    id: 'workbench',
    output: b(Block.Workbench),
    outputQty: 1,
    inputs: [{ itemId: b(Block.Planks), qty: 4 }],
    bench: false,
    group: 'building',
    note: 'Place it, stand near it, and the rest of this list opens up.',
  },
  {
    id: 'wood_pickaxe',
    output: 'wood_pickaxe',
    outputQty: 1,
    inputs: [{ itemId: b(Block.Planks), qty: 3 }],
    bench: false,
    group: 'tools',
    note: 'Enough to mine stone, which is what the better tools are made of.',
  },

  // --- tools, at a bench ----------------------------------------------------
  {
    id: 'stone_pickaxe',
    output: 'stone_pickaxe',
    outputQty: 1,
    inputs: [
      { itemId: b(Block.Cobble), qty: 3 },
      { itemId: b(Block.Planks), qty: 2 },
    ],
    bench: true,
    group: 'tools',
    note: 'Mines iron ore, which a wooden pick only destroys.',
  },
  {
    id: 'iron_pickaxe',
    output: 'iron_pickaxe',
    outputQty: 1,
    inputs: [
      { itemId: b(Block.IronOre), qty: 3 },
      { itemId: b(Block.Planks), qty: 2 },
    ],
    bench: true,
    group: 'tools',
    note: 'The only thing that will collect gold ore.',
  },
  {
    id: 'stone_axe',
    output: 'stone_axe',
    outputQty: 1,
    inputs: [
      { itemId: b(Block.Cobble), qty: 3 },
      { itemId: b(Block.Planks), qty: 2 },
    ],
    bench: true,
    group: 'tools',
    note: 'Fells timber several times faster than bare hands.',
  },
  {
    id: 'stone_shovel',
    output: 'stone_shovel',
    outputQty: 1,
    inputs: [
      { itemId: b(Block.Cobble), qty: 2 },
      { itemId: b(Block.Planks), qty: 2 },
    ],
    bench: true,
    group: 'tools',
    note: 'For soil, sand and snow.',
  },

  // --- the building kit -----------------------------------------------------
  {
    id: 'plank_wall',
    output: b(Block.PlankWall),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'Thin partition walls. Four from two planks — a wall is less than a block.',
  },
  {
    id: 'stone_wall',
    output: b(Block.StoneWall),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Stone), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'The same, in stone.',
  },
  {
    id: 'brick_wall',
    output: b(Block.BrickWall),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Brick), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'For a facade.',
  },
  {
    id: 'plank_post',
    output: b(Block.PlankPost),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'A timber column. Frame a building and fill between the posts.',
  },
  {
    id: 'stone_post',
    output: b(Block.StonePost),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Stone), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'A pillar.',
  },
  {
    id: 'plank_beam',
    output: b(Block.PlankBeam),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'Rafters and lintels. Sits high in its block, so you walk under it.',
  },
  {
    id: 'stone_beam',
    output: b(Block.StoneBeam),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Stone), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'A stone lintel, to span a doorway.',
  },
  {
    id: 'plank_plate',
    output: b(Block.PlankPlate),
    outputQty: 6,
    inputs: [{ itemId: b(Block.Planks), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'Boarding. Floor an upper storey without losing head height.',
  },
  {
    id: 'stone_plate',
    output: b(Block.StonePlate),
    outputQty: 6,
    inputs: [{ itemId: b(Block.Stone), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'Flagstones.',
  },

  // --- the pieces that already existed, now obtainable ----------------------
  {
    id: 'plank_stairs',
    output: b(Block.PlankStairs),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 3 }],
    bench: true,
    group: 'parts',
    note: 'Walkable, and they pick a top or bottom half from where you click.',
  },
  {
    id: 'stone_stairs',
    output: b(Block.StoneStairs),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Stone), qty: 3 }],
    bench: true,
    group: 'parts',
    note: 'Walkable stone steps.',
  },
  {
    id: 'brick_stairs',
    output: b(Block.BrickStairs),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Brick), qty: 3 }],
    bench: true,
    group: 'parts',
    note: 'Brick steps.',
  },
  {
    id: 'plank_slab',
    output: b(Block.PlankSlab),
    outputQty: 6,
    inputs: [{ itemId: b(Block.Planks), qty: 3 }],
    bench: true,
    group: 'parts',
    note: 'Half-height steps you can actually stand on.',
  },
  {
    id: 'stone_slab',
    output: b(Block.StoneSlab),
    outputQty: 6,
    inputs: [{ itemId: b(Block.Stone), qty: 3 }],
    bench: true,
    group: 'parts',
    note: 'Stone half-blocks.',
  },
  {
    id: 'door',
    output: b(Block.Door),
    outputQty: 1,
    inputs: [{ itemId: b(Block.Planks), qty: 5 }],
    bench: true,
    group: 'parts',
    note: 'Opens on right-click. An open door is a real hole, not a thin wall.',
  },
  {
    id: 'window',
    output: b(Block.Window),
    outputQty: 2,
    inputs: [{ itemId: b(Block.Glass), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'A glazed pane in a frame.',
  },
  {
    id: 'fence',
    output: b(Block.Fence),
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 2 }],
    bench: true,
    group: 'parts',
    note: 'Waist-high rails.',
  },
  {
    id: 'shingles',
    output: b(Block.Shingles),
    outputQty: 4,
    inputs: [
      { itemId: b(Block.Planks), qty: 2 },
      { itemId: b(Block.Brick), qty: 1 },
    ],
    bench: true,
    group: 'parts',
    note: 'Sloped roofing wedges.',
  },
  {
    id: 'brick',
    output: b(Block.Brick),
    outputQty: 1,
    inputs: [{ itemId: b(Block.Cobble), qty: 2 }],
    bench: true,
    group: 'building',
    note: 'Fires rubble into something worth building a wall from.',
  },
  {
    id: 'glass',
    output: b(Block.Glass),
    outputQty: 1,
    inputs: [{ itemId: b(Block.Sand), qty: 2 }],
    bench: true,
    group: 'building',
    note: 'Sand into glass.',
  },

  // --- light ----------------------------------------------------------------
  {
    id: 'torch',
    output: 'torch',
    outputQty: 4,
    inputs: [{ itemId: b(Block.Planks), qty: 1 }],
    bench: false,
    group: 'light',
    note: 'Light to build by, and to keep what comes out after dark at arm’s length.',
  },
];

/**
 * Every recipe whose output and inputs all exist in the item registry.
 *
 * Filtered rather than trusted. A recipe naming an item that is not registered
 * would otherwise be a dead row in the sheet that fails only when clicked, and
 * `item()` throws on an unknown id — so a typo in this table would take the whole
 * crafting tab down rather than just itself.
 */
export const CRAFTING_RECIPES: readonly Recipe[] = RECIPES.filter(
  (recipe) =>
    !!tryItem(recipe.output) && recipe.inputs.every((i) => i.qty <= 0 || !!tryItem(i.itemId)),
).map((recipe) => ({ ...recipe, inputs: recipe.inputs.filter((i) => i.qty > 0) }));

export function recipeById(id: string): Recipe | undefined {
  return CRAFTING_RECIPES.find((r) => r.id === id);
}

/** Whether the bag holds everything a recipe asks for. */
export function hasIngredients(inventory: Inventory, recipe: Recipe): boolean {
  return recipe.inputs.every((i) => inventory.count(i.itemId) >= i.qty);
}

export type CraftResult = 'ok' | 'missing' | 'needs-bench' | 'full';

/**
 * Consumes a recipe's inputs and grants its output.
 *
 * Ingredients are checked in full *before* any are removed. Removing as it goes
 * and bailing half way would silently eat the first ingredient of a recipe the
 * player could not afford, which is the kind of bug that reads as the game
 * stealing from you.
 */
export function craft(inventory: Inventory, recipe: Recipe, benchNearby: boolean): CraftResult {
  if (recipe.bench && !benchNearby) return 'needs-bench';
  if (!hasIngredients(inventory, recipe)) return 'missing';

  const output = item(recipe.output);
  for (const input of recipe.inputs) inventory.remove(input.itemId, input.qty);

  const leftover = inventory.add(output.id, recipe.outputQty);
  if (leftover > 0) {
    // Put the ingredients back rather than destroying them for nothing.
    for (const input of recipe.inputs) inventory.add(input.itemId, input.qty);
    inventory.remove(output.id, recipe.outputQty - leftover);
    return 'full';
  }
  return 'ok';
}
