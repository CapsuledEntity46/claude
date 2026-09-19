/**
 * Crafting queue.
 *
 * Costs are consumed up front (so you can't queue ten rifles off one pile of
 * metal), and cancelling refunds whatever hasn't been produced yet.
 */

import { audio } from '../core/audio';
import { RECIPES, stationSatisfied, type Recipe, type Station } from '../items/recipes';
import { itemDef } from '../items/itemdefs';
import type { Game } from '../game';

export interface QueueEntry {
  recipe: Recipe;
  /** Batches remaining, including the one in progress. */
  remaining: number;
  /** Seconds left on the current batch. */
  timeLeft: number;
}

export class Crafting {
  queue: QueueEntry[] = [];
  /** Stations in range as of the last update, for the UI. */
  stations = new Set<Station>();

  /** Can the player afford one batch right now? */
  canAfford(game: Game, recipe: Recipe): boolean {
    return recipe.cost.every(([id, n]) => game.player.countItem(id) >= n);
  }

  /** Missing quantities per ingredient, for the recipe tooltip. */
  missing(game: Game, recipe: Recipe): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, n] of recipe.cost) {
      const have = game.player.countItem(id);
      if (have < n) out.set(id, n - have);
    }
    return out;
  }

  available(recipe: Recipe): boolean {
    return stationSatisfied(recipe.station, this.stations);
  }

  /** Queue up `count` batches, consuming resources immediately. */
  enqueue(game: Game, recipe: Recipe, count = 1): boolean {
    if (!this.available(recipe)) {
      game.toast(`Requires ${recipe.station.startsWith('bench') ? 'a workbench' : recipe.station}`, 'warn');
      return false;
    }
    let queued = 0;
    for (let i = 0; i < count; i++) {
      if (!this.canAfford(game, recipe)) break;
      for (const [id, n] of recipe.cost) game.player.takeItem(id, n);
      queued++;
    }
    if (queued === 0) {
      game.toast(`Not enough materials for ${itemDef(recipe.out).name}`, 'warn');
      return false;
    }

    const existing = this.queue.find((q) => q.recipe.out === recipe.out);
    if (existing) {
      existing.remaining += queued;
    } else {
      this.queue.push({ recipe, remaining: queued, timeLeft: recipe.time });
    }
    audio.play('ui_click');
    return true;
  }

  /** Cancel an entry and refund everything not yet produced. */
  cancel(game: Game, index: number): void {
    const entry = this.queue[index];
    if (!entry) return;
    for (let i = 0; i < entry.remaining; i++) {
      for (const [id, n] of entry.recipe.cost) game.player.giveItem(id, n);
    }
    this.queue.splice(index, 1);
    game.toast(`Cancelled ${itemDef(entry.recipe.out).name}`, 'warn');
  }

  cancelAll(game: Game): void {
    while (this.queue.length) this.cancel(game, 0);
  }

  update(dt: number, game: Game): void {
    this.stations = game.world.stationsNear(game.player.x, game.player.y);

    const entry = this.queue[0];
    if (!entry) return;

    // Crafting pauses if you walk away from the station it needs.
    if (!this.available(entry.recipe)) return;

    entry.timeLeft -= dt;
    if (entry.timeLeft > 0) return;

    const def = itemDef(entry.recipe.out);
    const left = game.player.giveItem(entry.recipe.out, entry.recipe.count);
    if (left > 0) {
      // No room — spill it at the player's feet rather than deleting it.
      game.dropItemAt(game.player.x, game.player.y, entry.recipe.out, left);
    }
    game.player.itemsCrafted += entry.recipe.count;
    game.toast(`Crafted ${def.name}${entry.recipe.count > 1 ? ` x${entry.recipe.count}` : ''}`, 'pickup');
    audio.play('craft_done');

    entry.remaining--;
    if (entry.remaining <= 0) this.queue.shift();
    else entry.timeLeft = entry.recipe.time;
  }

  /** Progress of the active batch, 0..1. */
  get progress(): number {
    const e = this.queue[0];
    if (!e) return 0;
    return 1 - e.timeLeft / e.recipe.time;
  }

  /** Recipes sorted for display, filtered by a search string. */
  list(filter = ''): Recipe[] {
    const f = filter.trim().toLowerCase();
    return RECIPES.filter((r) => {
      if (!f) return true;
      return itemDef(r.out).name.toLowerCase().includes(f) || r.group.toLowerCase().includes(f);
    });
  }
}
