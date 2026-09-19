import { RNG } from '../core/rng';
import { Container } from '../items/container';
import { rollLoot, type LootTableName } from '../items/lootTables';
import type { Faction } from './actor';

export type CorpseKind = 'zombie' | 'bandit' | 'animal' | 'horse' | 'player';

let nextCorpseId = 1;

/**
 * A body on the ground.
 *
 * Human corpses carry a rolled inventory. Animal corpses must be skinned with a
 * cutting tool, which is where most early-game meat and leather comes from.
 */
export class Corpse {
  readonly id = nextCorpseId++;
  container: Container;
  /** Seconds until the body disappears. */
  life = 300;
  /** Animals need a knife; `skinned` flips once harvested. */
  skinned = false;
  dead = false;
  /** Visual rotation so bodies don't all face the same way. */
  readonly angle: number;
  readonly variant: number;

  constructor(
    public x: number,
    public y: number,
    public kind: CorpseKind,
    public label: string,
    table: LootTableName,
    /** Visual scale, copied from the actor that died. */
    public size = 1,
    /** Colour copied from the actor for continuity. */
    public color = '#6d7a58',
    public fromFaction: Faction = 'zombie',
    seed = Math.random() * 1e9,
    day = 1,
  ) {
    const rng = new RNG(Math.floor(seed));
    this.angle = rng.angle();
    this.variant = rng.int(0, 255);

    const cols = kind === 'animal' || kind === 'horse' ? 5 : 6;
    const rows = kind === 'bandit' ? 5 : 4;
    this.container = new Container(`corpse_${this.id}`, cols, rows, label);

    // Animal bodies start empty; their yield comes from skinning.
    if (kind !== 'animal' && kind !== 'horse') {
      for (const stack of rollLoot(table, rng, day)) this.container.add(stack);
    }
    this.harvestTable = table;
    this.rng = rng;
  }

  private readonly harvestTable: LootTableName;
  private readonly rng: RNG;

  /** Requires a cutting tool; fills the container with meat/hide/bone. */
  skin(day: number): boolean {
    if (this.skinned) return false;
    this.skinned = true;
    for (const stack of rollLoot(this.harvestTable, this.rng, day)) this.container.add(stack);
    this.life = Math.max(this.life, 180);
    return true;
  }

  get isEmpty(): boolean { return this.container.isEmpty; }

  update(dt: number): void {
    this.life -= dt;
    // Empty, picked-over bodies vanish faster to keep the world tidy.
    if (this.isEmpty && (this.skinned || this.kind !== 'animal')) this.life -= dt * 2;
    if (this.life <= 0) this.dead = true;
  }
}
