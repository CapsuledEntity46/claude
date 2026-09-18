import * as THREE from 'three';
import type { HudCombatState } from '../combat/CombatSystem';
import { item } from '../combat/items';
import type { FloaterClass, LogClass } from '../core/Context';
import { HOTBAR_SIZE } from '../player/Inventory';
import type { Player } from '../player/Player';
import { applyGlyph } from './glyphs';
import { Minimap } from './Minimap';

const LOG_LIMIT = 7;
const LOG_LIFETIME = 6000;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing HUD element #${id}`);
  return node as T;
}

/**
 * All the on-screen readouts. Kept as DOM rather than in-canvas: text, bars, and
 * grids are simply better in HTML, and it costs nothing at these update rates.
 */
export interface HudEnvironment {
  fps: number;
  chunks: number;
  entities: number;
  clock: string;
  phase: string;
  weather: string;
  underwater: boolean;
}

export class Hud {
  private hpFill = el<HTMLDivElement>('hp-fill');
  private hpText = el<HTMLSpanElement>('hp-text');
  private staFill = el<HTMLDivElement>('sta-fill');
  private manaFill = el<HTMLDivElement>('mana-fill');
  private manaText = el<HTMLSpanElement>('mana-text');
  private grdFill = el<HTMLDivElement>('grd-fill');
  private grdRow = this.grdFill.parentElement!.parentElement!;
  private slotsHost = el<HTMLDivElement>('spell-slots');

  private xpFill = el<HTMLDivElement>('xp-fill');
  private xpText = el<HTMLSpanElement>('xp-text');
  private hotbarHost = el<HTMLDivElement>('hotbar');
  private activeName = el<HTMLSpanElement>('active-name');
  private activeMode = el<HTMLSpanElement>('active-mode');

  private armorLine = el<HTMLDivElement>('armor-line');
  private posLine = el<HTMLDivElement>('pos-line');
  private perfLine = el<HTMLDivElement>('perf-line');

  private logHost = el<HTMLDivElement>('log');
  private floaterHost = el<HTMLDivElement>('floaters');
  private crosshair = el<HTMLDivElement>('crosshair');

  private deathScreen = el<HTMLDivElement>('death');
  private deathDetail = el<HTMLParagraphElement>('death-detail');
  private menu = el<HTMLDivElement>('menu');

  readonly minimap = new Minimap();
  private slotCells: HTMLDivElement[][] = [];
  private hotbarCells: { root: HTMLDivElement; glyph: HTMLSpanElement; qty: HTMLSpanElement; cd: HTMLDivElement }[] = [];

  private camera: THREE.Camera | null = null;
  private lastLogMessage = '';
  private lastLogTime = 0;

  constructor() {
    this.buildHotbar();
    const host = document.getElementById('minimap');
    host?.append(this.minimap.canvas, this.minimap.compass);
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  private buildHotbar(): void {
    this.hotbarHost.replaceChildren();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const root = document.createElement('div');
      root.className = 'hs';

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);

      const glyph = document.createElement('span');
      const qty = document.createElement('span');
      qty.className = 'qty';
      const cd = document.createElement('div');
      cd.className = 'cd';
      cd.style.transform = 'scaleY(0)';

      root.append(key, glyph, qty, cd);
      this.hotbarHost.append(root);
      this.hotbarCells.push({ root, glyph, qty, cd });
    }
  }

  // ---------------------------------------------------------------- per-frame

  update(player: Player, combat: HudCombatState, info: HudEnvironment): void {
    const stats = player.stats;

    const hpFraction = Math.max(0, stats.hp / stats.maxHp);
    this.hpFill.style.width = `${hpFraction * 100}%`;
    this.hpText.textContent = `${Math.ceil(Math.max(0, stats.hp))} / ${stats.maxHp}`;

    this.staFill.style.width = `${(stats.stamina / stats.maxStamina) * 100}%`;

    // Mana never refills on its own, so its exact value matters more than stamina's.
    this.manaFill.style.width = `${(stats.mana / stats.maxMana) * 100}%`;
    this.manaText.textContent = `${Math.floor(stats.mana)} / ${stats.maxMana}`;

    // The guard bar only exists when a shield does.
    if (stats.maxGuard > 0) {
      this.grdRow.classList.remove('hidden');
      this.grdFill.style.width = `${(stats.guard / stats.maxGuard) * 100}%`;
    } else {
      this.grdRow.classList.add('hidden');
    }

    this.updateSpellSlots(player);
    this.updateXp(player);
    this.updateHotbar(player, combat);
    this.updateStatus(player, combat, info);

    // Crosshair turns gold while a bow is drawn, as the only draw-strength cue.
    this.crosshair.classList.toggle('charging', combat.draw > 0.05);
  }

  private updateSpellSlots(player: Player): void {
    const max = player.stats.maxSlots();
    const used = player.stats.slotsUsed;

    // Rebuild only when the shape changes; otherwise just repaint fill state.
    const shapeChanged =
      this.slotCells.length !== max.filter((n) => n > 0).length ||
      this.slotCells.some((row, i) => row.length !== max.filter((n) => n > 0)[i]);

    if (shapeChanged) {
      this.slotsHost.replaceChildren();
      this.slotCells = [];
      max.forEach((count, tier) => {
        if (count <= 0) return;
        const wrap = document.createElement('div');
        wrap.className = 'slot-tier';
        const label = document.createElement('span');
        label.className = 'tier-label';
        label.textContent = `T${tier + 1}`;
        wrap.append(label);
        const row: HTMLDivElement[] = [];
        for (let i = 0; i < count; i++) {
          const pip = document.createElement('div');
          pip.className = 'pip';
          wrap.append(pip);
          row.push(pip);
        }
        this.slotsHost.append(wrap);
        this.slotCells.push(row);
      });
    }

    let visibleTier = 0;
    max.forEach((count, tier) => {
      if (count <= 0) return;
      const row = this.slotCells[visibleTier++];
      if (!row) return;
      const available = count - used[tier];
      row.forEach((pip, i) => pip.classList.toggle('full', i < available));
    });
  }

  private updateXp(player: Player): void {
    const { current, needed } = player.stats.xpIntoLevel();
    this.xpFill.style.width = `${Math.min(100, (current / needed) * 100)}%`;
    const points = player.stats.unspent > 0 ? `  ·  ${player.stats.unspent} points to spend (Tab)` : '';
    this.xpText.textContent = `Lv ${player.stats.level}   ${current} / ${needed} XP${points}`;
  }

  private updateHotbar(player: Player, combat: HudCombatState): void {
    const inv = player.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const cell = this.hotbarCells[i];
      const id = inv.hotbar[i];
      cell.root.classList.toggle('active', i === inv.selected);

      if (!id) {
        cell.glyph.textContent = '';
        cell.qty.textContent = '';
        cell.cd.style.transform = 'scaleY(0)';
        continue;
      }

      const def = item(id);
      applyGlyph(cell.glyph, def);
      cell.qty.textContent = def.stackable ? String(inv.count(id)) : '';

      // Grey out anything the player cannot currently use.
      const unusable =
        (def.stackable && inv.count(id) === 0) ||
        (def.kind === 'spell' && def.spell && player.stats.slotsAvailable(def.spell.tier) === 0);
      cell.root.style.opacity = unusable ? '0.4' : '1';

      const busy = i === inv.selected && combat.progress > 0 && combat.progress < 1;
      cell.cd.style.transform = busy ? `scaleY(${1 - combat.progress})` : 'scaleY(0)';
    }

    const active = inv.activeItem;
    this.activeName.textContent = active ? active.name : 'Bare hands';
    const bits: string[] = [];
    if (combat.modeLabel) bits.push(combat.modeLabel);
    if (combat.ammoLoaded >= 0) bits.push(`${combat.ammoLoaded} loaded / ${combat.ammoReserve} ${combat.ammoLabel}`);
    else if (combat.ammoReserve >= 0) bits.push(`${combat.ammoReserve} ${combat.ammoLabel}`);
    if (combat.actionLabel) bits.push(combat.actionLabel);
    this.activeMode.textContent = bits.join('  ·  ');
  }

  private updateStatus(player: Player, combat: HudCombatState, info: HudEnvironment): void {
    const defense = player.defense;
    const armorName = player.inventory.equippedDef('armor')?.name ?? 'Unarmoured';
    const resists = Object.entries(defense.resist)
      .filter(([, v]) => v && Math.abs(v) > 0.001)
      .map(([k, v]) => `${k} ${v! > 0 ? '-' : '+'}${Math.abs(Math.round(v! * 100))}%`)
      .join('  ');

    const ward = player.stats.wardArmor > 0 ? `  (+${player.stats.wardArmor} ward)` : '';

    // Off-hand: shield and torch can be carried together, so show both.
    const shield = player.inventory.equippedDef('shield');
    const torch = player.inventory.equippedDef('torch');
    const offhand = [shield?.name, torch ? `${torch.name} (lit)` : null].filter(Boolean).join(' + ') || 'Off-hand empty';

    this.armorLine.innerHTML =
      `${armorName} · Armor ${defense.armor}${ward}<br>` +
      `<span style="opacity:.7">${resists}</span><br>` +
      `<span style="opacity:.8">${offhand}</span>`;

    const target = combat.targetName
      ? `<br><span style="color:#ffd9a0">${combat.targetName} — ${Math.round(combat.targetHpFraction * 100)}%</span>`
      : '';
    this.posLine.innerHTML =
      `${player.position.x.toFixed(0)}, ${player.position.y.toFixed(0)}, ${player.position.z.toFixed(0)}${target}`;

    const night = info.phase === 'Night' || info.phase === 'Dusk';
    const clockColor = night ? '#9fb4e0' : '#ffe0a0';
    const weatherNote = info.weather === 'Clear' ? '' : ` · ${info.weather}`;
    const submerged = info.underwater ? ' · <span style="color:#7fd0e8">underwater</span>' : '';
    this.perfLine.innerHTML =
      `<span style="color:${clockColor}">${info.clock} ${info.phase}</span>${weatherNote}${submerged}<br>` +
      `<span style="opacity:.65">${info.fps} fps · ${info.chunks} chunks · ${info.entities} foes</span>`;
  }

  // ---------------------------------------------------------------- log

  log(message: string, cls: LogClass = 'info'): void {
    const now = performance.now();
    // Collapse identical messages fired in quick succession.
    if (message === this.lastLogMessage && now - this.lastLogTime < 700) return;
    this.lastLogMessage = message;
    this.lastLogTime = now;

    const line = document.createElement('div');
    line.className = `log-${cls}`;
    line.textContent = message;
    this.logHost.append(line);

    while (this.logHost.childElementCount > LOG_LIMIT) {
      this.logHost.firstElementChild?.remove();
    }

    window.setTimeout(() => {
      line.classList.add('fade');
      window.setTimeout(() => line.remove(), 700);
    }, LOG_LIFETIME);
  }

  // ---------------------------------------------------------------- floaters

  /** Projects a world position to screen space and spawns a rising number. */
  floater(worldPosition: THREE.Vector3, text: string, cls: FloaterClass): void {
    if (!this.camera) return;
    const projected = worldPosition.clone().project(this.camera);
    // Behind the camera, or well off-screen: not worth showing.
    if (projected.z > 1 || Math.abs(projected.x) > 1.4 || Math.abs(projected.y) > 1.4) return;

    const node = document.createElement('div');
    node.className = `floater ${cls}`;
    node.textContent = text;
    node.style.left = `${(projected.x * 0.5 + 0.5) * 100}%`;
    node.style.top = `${(-projected.y * 0.5 + 0.5) * 100}%`;
    // Small horizontal jitter so simultaneous hits do not stack illegibly.
    node.style.marginLeft = `${(Math.random() - 0.5) * 34}px`;
    this.floaterHost.append(node);
    window.setTimeout(() => node.remove(), 950);
  }

  // ---------------------------------------------------------------- overlays

  showDeath(sourceName: string, level: number): void {
    this.deathDetail.textContent = `Slain by ${sourceName} at level ${level}.`;
    this.deathScreen.classList.remove('hidden');
  }

  hideDeath(): void {
    this.deathScreen.classList.add('hidden');
  }

  setMenuVisible(visible: boolean): void {
    this.menu.classList.toggle('hidden', !visible);
  }
}
