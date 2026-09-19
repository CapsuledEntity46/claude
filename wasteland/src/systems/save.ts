/**
 * Save/load to localStorage.
 *
 * Terrain is never serialised — it regenerates deterministically from the seed.
 * Only mutable state is stored: the player, world mutations (harvested nodes,
 * looted containers, built structures), time of day and the crafting queue.
 */

import { Container } from '../items/container';
import { reviveStack, type ItemStack } from '../items/item';
import { EQUIP_SLOTS, itemDef, type EquipSlot } from '../items/itemdefs';
import { RECIPE_BY_OUT } from '../items/recipes';
import { Horse } from '../entities/horse';
import type { World } from '../world/world';
import type { Player } from '../entities/player';
import type { DayNight } from '../world/daynight';
import type { Game } from '../game';

const KEY = 'wasteland.save.v1';
const VERSION = 1;

export interface SaveData {
  version: number;
  savedAt: number;
  seedLabel: string;
  dayNight: ReturnType<DayNight['serialize']>;
  player: ReturnType<Player['serialize']>;
  world: ReturnType<World['serialize']>;
  seededBuildings: number[];
  craftQueue: { out: string; remaining: number; timeLeft: number }[];
  horses: {
    x: number; y: number; hp: number; tamed: boolean; coat: string;
    bags: ReturnType<Container['serialize']> | null;
  }[];
}

export function hasSave(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}

export function clearSave(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export function saveGame(game: Game): boolean {
  try {
    const data: SaveData = {
      version: VERSION,
      savedAt: Date.now(),
      seedLabel: game.seedLabel,
      dayNight: game.dayNight.serialize(),
      player: game.player.serialize(),
      world: game.world.serialize(),
      seededBuildings: game.spawner.seeded,
      craftQueue: game.crafting.queue.map((q) => ({
        out: q.recipe.out, remaining: q.remaining, timeLeft: q.timeLeft,
      })),
      // Only tamed horses persist; wild ones respawn naturally.
      horses: game.horses.filter((h) => h.tamed && h.alive).map((h) => ({
        x: h.x, y: h.y, hp: h.hp, tamed: true, coat: h.coat,
        bags: h.saddleBags ? h.saddleBags.serialize() : null,
      })),
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.warn('save failed', err);
    return false;
  }
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== VERSION) return null;
    return data;
  } catch (err) {
    console.warn('load failed', err);
    return null;
  }
}

/** Apply a loaded save onto a freshly-constructed game. */
export function applySave(game: Game, save: SaveData): void {
  game.dayNight.load(save.dayNight);
  game.world.load(save.world);
  game.spawner.markSeeded(save.seededBuildings);

  const p = game.player;
  const s = save.player;
  p.x = s.x;
  p.y = s.y;
  p.hp = s.hp;
  p.food = s.food;
  p.water = s.water;
  p.stamina = s.stamina;
  p.bodyTemp = s.bodyTemp;
  p.infection = s.infection;
  p.wetness = s.wetness;
  p.brokenLeg = s.brokenLeg;
  p.bleed = s.bleed;
  p.activeSlot = s.activeSlot;
  p.kills = s.kills;
  p.zombieKills = s.zombieKills;
  p.itemsCrafted = s.itemsCrafted;
  p.timeAlive = s.timeAlive;
  p.distanceTravelled = s.distanceTravelled;
  p.respawnPoint = s.respawnPoint;

  p.inventory = Container.deserialize(s.inventory);
  p.belt = s.belt.map((b) => (b && safeItem(b) ? reviveStack(b) : null));
  for (const slot of EQUIP_SLOTS) {
    const raw = s.equipment[slot as EquipSlot] as ItemStack | null | undefined;
    p.equipment[slot] = raw && safeItem(raw) ? reviveStack(raw) : null;
  }
  p.refreshCapacity();

  for (const entry of save.craftQueue) {
    const recipe = RECIPE_BY_OUT.get(entry.out);
    if (!recipe) continue;
    game.crafting.queue.push({ recipe, remaining: entry.remaining, timeLeft: entry.timeLeft });
  }

  for (const h of save.horses) {
    const horse = new Horse(h.x, h.y);
    horse.hp = h.hp;
    horse.tamed = true;
    horse.trust = 100;
    horse.saddleBags = h.bags ? Container.deserialize(h.bags) : new Container(`saddle_${horse.id}`, 6, 4, 'Saddle Bags');
    game.horses.push(horse);
  }
}

/** Guard against items removed from the database between versions. */
function safeItem(stack: ItemStack): boolean {
  try { itemDef(stack.id); return true; } catch { return false; }
}
