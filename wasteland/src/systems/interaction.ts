/**
 * Contextual interaction (the E key).
 *
 * Every frame we find the single best thing within reach and describe it; the
 * HUD shows the prompt and E runs the action.
 */

import { audio } from '../core/audio';
import { itemDef } from '../items/itemdefs';
import { PROPS } from '../world/props';
import { TIER_NAMES } from '../world/world';
import type { Deployable, Structure } from '../world/world';
import type { Horse } from '../entities/horse';
import type { Game } from '../game';

export interface Interaction {
  label: string;
  /** Extra line shown under the prompt. */
  hint?: string;
  dist: number;
  run(game: Game): void;
}

const REACH = 74;

/**
 * Can the player actually see a prop? Without this you can loot a fridge
 * through the wall of a house you're standing outside.
 *
 * The prop's own body is ignored, otherwise sight-blocking furniture such as a
 * bookshelf would occlude itself.
 */
function propVisible(game: Game, prop: { x: number; y: number }): boolean {
  const p = game.player;
  const dx = prop.x - p.x, dy = prop.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 6) return true;
  const hit = game.world.castRay(p.x, p.y, dx / d, dy / d, d, { sightOnly: true });
  if (!hit) return true;
  if (hit.prop && hit.prop.x === prop.x && hit.prop.y === prop.y) return true;
  return hit.dist >= d - 3;
}

export function findInteraction(game: Game): Interaction | null {
  const p = game.player;
  let best: Interaction | null = null;
  const consider = (i: Interaction | null) => {
    if (!i) return;
    if (!best || i.dist < best.dist) best = i;
  };

  // --- ground items (highest priority: they're what you just dropped) ---
  for (const gi of game.groundItems) {
    const d = p.distTo(gi.x, gi.y);
    if (d > 52) continue;
    consider({
      label: `Pick up ${gi.name}${gi.count > 1 ? ` x${gi.count}` : ''}`,
      dist: d - 20,
      run: (g) => g.pickUpGroundItem(gi),
    });
  }

  // --- corpses ---
  for (const c of game.corpses) {
    const d = p.distTo(c.x, c.y);
    if (d > REACH) continue;
    if (!game.world.hasLineOfSight(p.x, p.y, c.x, c.y)) continue;
    if ((c.kind === 'animal' || c.kind === 'horse') && !c.skinned) {
      const knife = hasCuttingTool(game);
      consider({
        label: knife ? `Skin ${c.label}` : `${c.label} — need a cutting tool`,
        hint: knife ? undefined : 'A knife, hatchet or machete will do',
        dist: d,
        run: (g) => {
          if (!hasCuttingTool(g)) { g.toast('You need a knife to skin this', 'warn'); return; }
          c.skin(g.dayNight.day);
          audio.play('hit_flesh', c.x, c.y, { volume: 0.7 });
          g.effects.blood(c.x, c.y, Math.random() * 6.28, 12);
          g.openContainer(c.container, c.label);
        },
      });
    } else {
      consider({
        label: `Loot ${c.label}`,
        dist: d,
        run: (g) => g.openContainer(c.container, c.label),
      });
    }
  }

  // --- world props ---
  const props = game.world.propsNear(p.x - REACH, p.y - REACH, REACH * 2, REACH * 2);
  for (const prop of props) {
    const def = PROPS[prop.kind];
    const d = p.distTo(prop.x, prop.y) - def.radius * 0.5;
    if (d > REACH) continue;
    if (!propVisible(game, prop)) continue;

    if (def.container) {
      const locked = prop.container?.locked ?? false;
      if (locked) {
        const picks = p.countItem('lockpick');
        consider({
          label: picks > 0 ? `Pick lock — ${def.name}` : `${def.name} (locked)`,
          hint: picks > 0 ? `${picks} lockpick${picks > 1 ? 's' : ''}` : 'Needs a lockpick',
          dist: d,
          run: (g) => {
            if (g.player.takeItem('lockpick', 1) <= 0) { g.toast('You need a lockpick', 'warn'); return; }
            if (g.rng.bool(0.68)) {
              prop.container!.locked = false;
              g.toast(`Unlocked ${def.name}`, 'pickup');
              audio.play('ui_click');
              g.openProp(prop);
            } else {
              g.toast('The lockpick snapped', 'bad');
              audio.play('hit_metal', prop.x, prop.y, { volume: 0.6 });
            }
          },
        });
      } else {
        consider({
          label: `Loot ${def.name}`,
          dist: d,
          run: (g) => g.openProp(prop),
        });
      }
      continue;
    }

    // Foraging: berries and fibre by hand.
    if (def.harvest && (prop.kind === 'bush' || prop.kind === 'hemp' || prop.kind === 'reeds'
      || prop.kind === 'corn_plant' || prop.kind === 'pumpkin_plant')) {
      consider({
        label: `Forage ${def.name}`,
        dist: d,
        run: (g) => g.forageProp(prop),
      });
      continue;
    }

    // Wells give clean water.
    if (prop.kind === 'well') {
      consider({
        label: 'Drink from the well',
        dist: d,
        run: (g) => {
          g.player.water = Math.min(100, g.player.water + 45);
          audio.play('drink', prop.x, prop.y);
          g.toast('Fresh water', 'pickup');
        },
      });
    }
  }

  // --- deployables ---
  for (const dep of game.world.deployables) {
    const d = p.distTo(dep.x, dep.y);
    if (d > REACH + 10) continue;
    if (!game.world.hasLineOfSight(p.x, p.y, dep.x, dep.y)) continue;
    consider(deployableInteraction(game, dep, d));
  }

  // --- player-built doors ---
  for (const s of game.world.structures) {
    if (s.kind !== 'door' && s.kind !== 'doorway') continue;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const d = p.distTo(cx, cy);
    if (d > REACH) continue;
    if (s.kind === 'doorway') {
      consider(doorwayInteraction(game, s, d));
    } else {
      consider({
        label: s.open ? 'Close door' : 'Open door',
        dist: d,
        run: () => {
          s.open = !s.open;
          audio.play('hit_wood', cx, cy, { volume: 0.5 });
        },
      });
    }
  }

  // --- horses ---
  for (const h of game.horses) {
    if (!h.alive || h.ridden) continue;
    const d = p.distTo(h.x, h.y);
    if (d > REACH + 16) continue;
    consider(horseInteraction(game, h, d));
  }

  // --- drinking from lakes and rivers ---
  const ahead = { x: p.x + Math.cos(p.facing) * 34, y: p.y + Math.sin(p.facing) * 34 };
  if (game.world.isWater(ahead.x, ahead.y)) {
    consider({
      label: 'Drink (dirty water)',
      hint: 'Risky — boil it at a campfire instead',
      dist: 30,
      run: (g) => {
        g.player.water = Math.min(100, g.player.water + 30);
        g.player.takeDamage({ amount: 6, type: 'bleed' });
        if (g.rng.bool(0.25)) g.player.infection = Math.max(g.player.infection, 6);
        audio.play('drink', p.x, p.y);
      },
    });
  }

  return best;
}

function hasCuttingTool(game: Game): boolean {
  const cutters = ['bone_knife', 'combat_knife', 'machete', 'hatchet', 'stone_hatchet', 'katana', 'fire_axe'];
  return cutters.some((id) => game.player.countItem(id) > 0);
}

function deployableInteraction(game: Game, dep: Deployable, dist: number): Interaction | null {
  const name = itemDef(dep.itemId).name;

  switch (dep.kind) {
    case 'campfire':
    case 'furnace': {
      if (!dep.lit) {
        const hasFuel = (dep.container?.items.length ?? 0) > 0 || game.player.countItem('wood') >= 5;
        return {
          label: hasFuel ? `Light ${name}` : `${name} — needs fuel`,
          hint: 'Wood, charcoal or fat will burn',
          dist,
          run: (g) => {
            // Pull fuel from inside first, otherwise take wood from the player.
            let burn = 0;
            if (dep.container) {
              for (const it of [...dep.container.items]) {
                const f = itemDef(it.stack.id).fuel;
                if (!f) continue;
                burn += f * it.stack.count;
                dep.container.remove(it);
              }
            }
            if (burn <= 0) {
              const taken = g.player.takeItem('wood', 25);
              if (taken <= 0) { g.toast('No fuel', 'warn'); return; }
              burn = taken * (itemDef('wood').fuel ?? 10);
            }
            dep.fuel += burn;
            dep.lit = true;
            audio.play('build', dep.x, dep.y, { volume: 0.6 });
            g.toast(`${name} lit`, 'pickup');
          },
        };
      }
      return {
        label: `Open ${name}`,
        hint: `Burning — ${Math.ceil(dep.fuel)}s of fuel left`,
        dist,
        run: (g) => g.openContainer(dep.container!, name),
      };
    }

    case 'storage_box':
    case 'large_box':
    case 'tool_cupboard':
      return {
        label: `Open ${name}`,
        dist,
        run: (g) => g.openContainer(dep.container!, name),
      };

    case 'sleeping_bag':
      return {
        label: 'Set respawn point',
        dist,
        run: (g) => {
          g.player.respawnPoint = { x: dep.x, y: dep.y };
          g.toast('Respawn point set', 'pickup');
          audio.play('ui_click');
        },
      };

    case 'water_catcher':
      return {
        label: dep.charge > 0.25 ? 'Drink clean water' : 'Water catcher (filling…)',
        hint: `${Math.round(dep.charge * 100)}% full`,
        dist,
        run: (g) => {
          if (dep.charge < 0.25) { g.toast('Not enough water yet', 'warn'); return; }
          g.player.water = Math.min(100, g.player.water + dep.charge * 80);
          dep.charge = 0;
          audio.play('drink', dep.x, dep.y);
        },
      };

    case 'bear_trap':
      return {
        label: dep.armed ? `${name} (armed)` : `Reset ${name}`,
        dist,
        run: (g) => {
          if (dep.armed) { g.pickUpDeployable(dep); return; }
          dep.armed = true;
          audio.play('hit_metal', dep.x, dep.y, { volume: 0.5 });
          g.toast('Trap reset', 'pickup');
        },
      };

    default:
      // Workbenches and anything else: allow pickup.
      return {
        label: `Pick up ${name}`,
        dist,
        run: (g) => g.pickUpDeployable(dep),
      };
  }
}

function doorwayInteraction(game: Game, s: Structure, dist: number): Interaction | null {
  const hasWood = game.player.countItem('door_wood') > 0;
  const hasMetal = game.player.countItem('door_metal') > 0;
  if (!hasWood && !hasMetal) {
    return { label: 'Doorway — no door to fit', dist, run: () => { } };
  }
  const id = hasMetal ? 'door_metal' : 'door_wood';
  return {
    label: `Fit ${itemDef(id).name}`,
    dist,
    run: (g) => {
      if (g.player.takeItem(id, 1) <= 0) return;
      s.kind = 'door';
      s.tier = id === 'door_metal' ? 3 : 1;
      s.hp = id === 'door_metal' ? 800 : 300;
      s.open = false;
      g.world.buildVersion++;
      audio.play('build', s.x, s.y, { volume: 0.9 });
      g.toast(`${TIER_NAMES[s.tier]} door fitted`, 'pickup');
    },
  };
}

function horseInteraction(game: Game, h: Horse, dist: number): Interaction | null {
  if (!h.tamed) {
    const hasSaddle = game.player.countItem('saddle') > 0;
    if (!hasSaddle) {
      return {
        label: `Wild horse — trust ${Math.round(h.trust)}%`,
        hint: 'Approach slowly (crouch) and bring a saddle',
        dist,
        run: () => { },
      };
    }
    if (h.trust < 60) {
      return {
        label: `Wild horse — trust ${Math.round(h.trust)}%`,
        hint: 'Too skittish. Crouch and wait nearby.',
        dist,
        run: () => { },
      };
    }
    return {
      label: 'Fit saddle',
      dist,
      run: (g) => {
        if (g.player.takeItem('saddle', 1) <= 0) return;
        h.saddle();
        g.toast('Horse tamed', 'pickup');
      },
    };
  }

  // Tamed: mount, or open the saddle bags while standing beside it.
  return {
    label: 'Mount horse',
    hint: 'Hold Shift while riding to gallop · E again for saddle bags',
    dist,
    run: (g) => {
      if (g.player.mount) return;
      if (h.mount()) {
        g.player.mount = h;
        g.toast('Mounted', 'pickup');
      }
    },
  };
}
