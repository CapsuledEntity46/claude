/**
 * Base building.
 *
 * A 96-unit grid of foundations; walls, doorways and doors snap to the edges of
 * those cells. Pieces start as twig and are upgraded in place with the hammer,
 * exactly like Rust's build-then-upgrade loop.
 */

import { audio } from '../core/audio';
import { TILE_SIZE } from '../world/tiles';
import { propDef } from '../world/props';
import { TIER_COST, TIER_NAMES, TIER_HP, type Structure, type StructureKind } from '../world/world';
import type { Game } from '../game';

export const BUILD_CELL = TILE_SIZE * 3;
const WALL_T = 12;

export type BuildPiece = 'foundation' | 'floor' | 'wall' | 'doorway';

export const PIECE_ORDER: BuildPiece[] = ['foundation', 'wall', 'doorway', 'floor'];

export const PIECE_LABEL: Record<BuildPiece, string> = {
  foundation: 'Foundation', floor: 'Floor', wall: 'Wall', doorway: 'Doorway',
};

/** Twig-tier cost multiplier per piece. */
const PIECE_COST: Record<BuildPiece, number> = {
  foundation: 5, floor: 4, wall: 3, doorway: 4,
};

export interface Ghost {
  kind: StructureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  valid: boolean;
  reason: string;
}

export class Building {
  active = false;
  piece: BuildPiece = 'foundation';
  /** Last computed placement preview. */
  ghost: Ghost | null = null;

  toggle(game: Game): void {
    this.active = !this.active;
    this.ghost = null;
    if (this.active && !game.player.countItem('building_plan')) {
      game.toast('You need a Building Plan', 'warn');
      this.active = false;
      return;
    }
    audio.play('ui_open');
  }

  cyclePiece(dir: number): void {
    const i = PIECE_ORDER.indexOf(this.piece);
    this.piece = PIECE_ORDER[(i + dir + PIECE_ORDER.length) % PIECE_ORDER.length];
  }

  /** Cost of the current piece at twig tier. */
  cost(): readonly (readonly [string, number])[] {
    return TIER_COST[0].map(([id, n]) => [id, n * PIECE_COST[this.piece]] as const);
  }

  /** Recompute the ghost from the aim position. */
  updateGhost(game: Game): void {
    if (!this.active) { this.ghost = null; return; }

    const aim = game.aimWorld;
    const px = game.player.x, py = game.player.y;
    // Keep placement within arm's reach-ish.
    const maxReach = 170;
    const dx = aim.x - px, dy = aim.y - py;
    const dist = Math.hypot(dx, dy);
    const tx = dist > maxReach ? px + (dx / dist) * maxReach : aim.x;
    const ty = dist > maxReach ? py + (dy / dist) * maxReach : aim.y;

    const gx = Math.floor(tx / BUILD_CELL);
    const gy = Math.floor(ty / BUILD_CELL);
    const localX = tx - gx * BUILD_CELL;
    const localY = ty - gy * BUILD_CELL;

    let ghost: Ghost;
    if (this.piece === 'foundation' || this.piece === 'floor') {
      ghost = {
        kind: this.piece,
        x: gx * BUILD_CELL, y: gy * BUILD_CELL,
        w: BUILD_CELL, h: BUILD_CELL,
        valid: true, reason: '',
      };
    } else {
      // Snap to whichever cell edge the cursor is nearest.
      const distToEdges = [
        { edge: 'n', d: localY },
        { edge: 's', d: BUILD_CELL - localY },
        { edge: 'w', d: localX },
        { edge: 'e', d: BUILD_CELL - localX },
      ].sort((a, b) => a.d - b.d)[0];

      const kind: StructureKind = this.piece === 'wall' ? 'wall' : 'doorway';
      switch (distToEdges.edge) {
        case 'n': ghost = { kind, x: gx * BUILD_CELL, y: gy * BUILD_CELL - WALL_T / 2, w: BUILD_CELL, h: WALL_T, valid: true, reason: '' }; break;
        case 's': ghost = { kind, x: gx * BUILD_CELL, y: (gy + 1) * BUILD_CELL - WALL_T / 2, w: BUILD_CELL, h: WALL_T, valid: true, reason: '' }; break;
        case 'w': ghost = { kind, x: gx * BUILD_CELL - WALL_T / 2, y: gy * BUILD_CELL, w: WALL_T, h: BUILD_CELL, valid: true, reason: '' }; break;
        default: ghost = { kind, x: (gx + 1) * BUILD_CELL - WALL_T / 2, y: gy * BUILD_CELL, w: WALL_T, h: BUILD_CELL, valid: true, reason: '' }; break;
      }
    }

    this.validate(game, ghost, gx, gy);
    this.ghost = ghost;
  }

  private validate(game: Game, ghost: Ghost, gx: number, gy: number): void {
    const world = game.world;

    // Affordability.
    for (const [id, n] of this.cost()) {
      if (game.player.countItem(id) < n) {
        ghost.valid = false;
        ghost.reason = `Need ${n} ${id === 'wood' ? 'Wood' : id}`;
        return;
      }
    }

    // Don't overlap an existing piece of the same sort.
    const cx = ghost.x + ghost.w / 2, cy = ghost.y + ghost.h / 2;
    for (const s of world.structures) {
      const overlap =
        Math.abs(s.x + s.w / 2 - cx) < (s.w + ghost.w) / 2 - 2 &&
        Math.abs(s.y + s.h / 2 - cy) < (s.h + ghost.h) / 2 - 2;
      if (!overlap) continue;
      const sameLayer = (s.kind === 'foundation' || s.kind === 'floor')
        ? (ghost.kind === 'foundation' || ghost.kind === 'floor')
        : true;
      if (sameLayer) {
        ghost.valid = false;
        ghost.reason = 'Occupied';
        return;
      }
    }

    if (ghost.kind === 'foundation') {
      // Foundations need solid, dry ground across the whole cell.
      for (const [ox, oy] of [[8, 8], [ghost.w - 8, 8], [8, ghost.h - 8], [ghost.w - 8, ghost.h - 8], [ghost.w / 2, ghost.h / 2]]) {
        if (world.isWater(ghost.x + ox, ghost.y + oy)) {
          ghost.valid = false;
          ghost.reason = 'Cannot build on water';
          return;
        }
      }
      // Don't build inside existing town buildings.
      if (world.buildingAt(cx, cy)) {
        ghost.valid = false;
        ghost.reason = 'Blocked by a building';
        return;
      }
      // Nor on top of a boulder, tree or ore node.
      for (const prop of world.propsNear(ghost.x, ghost.y, ghost.w, ghost.h)) {
        const def = propDef(prop.kind);
        if (def.radius < 12) continue;
        if (prop.x < ghost.x - def.radius || prop.x > ghost.x + ghost.w + def.radius) continue;
        if (prop.y < ghost.y - def.radius || prop.y > ghost.y + ghost.h + def.radius) continue;
        ghost.valid = false;
        ghost.reason = `Blocked by ${def.name}`;
        return;
      }
    } else {
      // Walls, doorways and floors need a foundation to attach to.
      const supported = world.structures.some((s) => {
        if (s.kind !== 'foundation' && s.kind !== 'floor') return false;
        const sameCell = Math.floor((s.x + 4) / BUILD_CELL) === gx && Math.floor((s.y + 4) / BUILD_CELL) === gy;
        if (sameCell) return true;
        // An edge piece can also rest on the neighbouring cell's foundation.
        return Math.abs(s.x + s.w / 2 - cx) < BUILD_CELL && Math.abs(s.y + s.h / 2 - cy) < BUILD_CELL;
      });
      if (!supported) {
        ghost.valid = false;
        ghost.reason = 'Needs a foundation';
        return;
      }
    }

    ghost.valid = true;
    ghost.reason = '';
  }

  /** Commit the ghost. */
  place(game: Game): boolean {
    const ghost = this.ghost;
    if (!ghost || !ghost.valid) {
      if (ghost?.reason) game.toast(ghost.reason, 'warn');
      return false;
    }
    for (const [id, n] of this.cost()) game.player.takeItem(id, n);

    game.world.addStructure(ghost.kind, ghost.x, ghost.y, ghost.w, ghost.h, 0);
    audio.play('build', ghost.x, ghost.y, { volume: 0.9 });
    game.effects.dust(ghost.x + ghost.w / 2, ghost.y + ghost.h / 2, 6);
    return true;
  }

  /**
   * Upgrade a structure one tier with the hammer.
   * Returns true when something was upgraded.
   */
  static upgrade(game: Game, s: Structure): boolean {
    if (s.tier >= TIER_COST.length - 1) {
      game.toast('Already fully upgraded', 'warn');
      return false;
    }
    const nextTier = s.tier + 1;
    // Cost scales with the size of the piece.
    const scale = s.kind === 'foundation' || s.kind === 'floor' ? 1 : 0.6;
    const cost = TIER_COST[nextTier].map(([id, n]) => [id, Math.ceil(n * scale)] as const);

    for (const [id, n] of cost) {
      if (game.player.countItem(id) < n) {
        game.toast(`Need ${n} ${id}`, 'warn');
        return false;
      }
    }
    for (const [id, n] of cost) game.player.takeItem(id, n);

    s.tier = nextTier;
    s.hp = TIER_HP[nextTier];
    audio.play('build', s.x, s.y, { volume: 1 });
    game.toast(`Upgraded to ${TIER_NAMES[nextTier]}`, 'pickup');
    return true;
  }

  /** Repair a damaged structure with the hammer. */
  static repair(game: Game, s: Structure): boolean {
    const max = TIER_HP[s.tier];
    if (s.hp >= max) return false;
    const deficit = 1 - s.hp / max;
    const cost = TIER_COST[s.tier].map(([id, n]) => [id, Math.max(1, Math.ceil(n * deficit * 0.4))] as const);
    for (const [id, n] of cost) {
      if (game.player.countItem(id) < n) {
        game.toast(`Need ${n} ${id} to repair`, 'warn');
        return false;
      }
    }
    for (const [id, n] of cost) game.player.takeItem(id, n);
    s.hp = max;
    audio.play('build', s.x, s.y, { volume: 0.8 });
    game.toast('Repaired', 'pickup');
    return true;
  }
}
