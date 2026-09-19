/**
 * The inventory screen: spatial grid drag & drop, equipment slots, the belt,
 * a side-by-side loot panel and the crafting list.
 *
 * Grids are plain DOM. Items are absolutely positioned inside a `.grid-host`
 * and sized from their footprint, so a 3x2 rifle genuinely occupies six cells
 * and has to be tetris'd into place.
 */

import { audio } from '../core/audio';
import { Container, footprintOf, type PlacedItem } from '../items/container';
import {
  attachmentMods, canMerge, durabilityFrac, merge, split, type ItemStack,
} from '../items/item';
import {
  CATEGORY_LABEL, EQUIP_SLOTS, itemDef, AMMO_LABEL, type EquipSlot, type ItemDef,
} from '../items/itemdefs';
import { itemIcon } from '../items/icons';
import { RECIPE_GROUPS, STATION_LABEL, type Recipe } from '../items/recipes';
import type { Game } from '../game';

type SlotRef =
  | { kind: 'grid'; container: Container; cx: number; cy: number }
  | { kind: 'belt'; index: number }
  | { kind: 'equip'; slot: EquipSlot };

interface DragState {
  stack: ItemStack;
  from: SlotRef;
  rot: boolean;
  /** Which cell of the item was grabbed, so it drops where you expect. */
  grabX: number;
  grabY: number;
}

const SLOT_PLACEHOLDER: Record<EquipSlot, string> = {
  head: 'Head', face: 'Face', chest: 'Chest', hands: 'Hands',
  legs: 'Legs', feet: 'Feet', back: 'Back',
};

export class InventoryUI {
  private game: Game;
  private screen = document.getElementById('inventory-screen')!;
  private playerGrid = document.getElementById('player-grid')!;
  private beltGrid = document.getElementById('belt-grid')!;
  private lootGrid = document.getElementById('loot-grid')!;
  private lootPanel = document.getElementById('panel-loot')!;
  private lootTitle = document.getElementById('loot-title')!;
  private equipHost = document.getElementById('equip-slots')!;
  private craftList = document.getElementById('craft-list')!;
  private craftQueue = document.getElementById('craft-queue')!;
  private craftSearch = document.getElementById('craft-search') as HTMLInputElement;
  private charStats = document.getElementById('char-stats')!;
  private weightLabel = document.getElementById('inv-weight')!;
  private tooltip = document.getElementById('item-tooltip')!;
  private ghost = document.getElementById('drag-ghost')!;
  private splitDialog = document.getElementById('split-dialog')!;
  private splitRange = document.getElementById('split-range') as HTMLInputElement;
  private splitValue = document.getElementById('split-value')!;

  isOpen = false;
  private drag: DragState | null = null;
  /** Element -> container, for hit-testing drops. */
  private hostContainers = new Map<HTMLElement, Container>();
  private splitTarget: { stack: ItemStack; from: SlotRef } | null = null;
  private craftFilter = '';
  private queueSig = '';

  constructor(game: Game) {
    this.game = game;
    this.bindGlobalEvents();
  }

  // =========================================================================
  // Open / close
  // =========================================================================

  open(withLoot = false): void {
    this.isOpen = true;
    this.screen.classList.remove('hidden');
    this.lootPanel.classList.toggle('hidden', !withLoot || !this.game.loot);
    this.refresh();
    audio.play('ui_open');
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.screen.classList.add('hidden');
    this.cancelDrag();
    this.hideTooltip();
    this.closeSplit();
    this.game.loot = null;
    this.game.input.textCaptured = false;
    audio.play('ui_click');
  }

  // =========================================================================
  // Events
  // =========================================================================

  private bindGlobalEvents(): void {
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (this.drag && (e.code === 'KeyR')) {
        e.preventDefault();
        this.drag.rot = !this.drag.rot;
        this.updateGhostSize();
        this.updateHighlight(this.lastMouse.x, this.lastMouse.y);
      }
      if (this.drag && e.code === 'Escape') this.cancelDrag();
    });

    this.craftSearch.addEventListener('focus', () => { this.game.input.textCaptured = true; });
    this.craftSearch.addEventListener('blur', () => { this.game.input.textCaptured = false; });
    this.craftSearch.addEventListener('input', () => {
      this.craftFilter = this.craftSearch.value;
      this.renderCrafting();
    });

    document.getElementById('loot-take-all')!.addEventListener('click', () => this.takeAll());

    // Split dialog.
    this.splitRange.addEventListener('input', () => {
      this.splitValue.textContent = this.splitRange.value;
    });
    document.getElementById('split-ok')!.addEventListener('click', () => this.confirmSplit());
    document.getElementById('split-cancel')!.addEventListener('click', () => this.closeSplit());

    // Suppress the browser context menu inside the inventory.
    this.screen.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private lastMouse = { x: 0, y: 0 };

  private onMouseMove(e: MouseEvent): void {
    this.lastMouse.x = e.clientX;
    this.lastMouse.y = e.clientY;
    if (!this.drag) return;
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
    this.updateHighlight(e.clientX, e.clientY);
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.drag || e.button !== 0) return;
    const target = this.resolveSlot(e.clientX, e.clientY);
    const drag = this.drag;
    this.clearHighlights();
    this.ghost.classList.add('hidden');
    this.drag = null;

    if (!target) {
      // Dropped outside any container: drop it into the world.
      if (!this.screen.contains(document.elementFromPoint(e.clientX, e.clientY))) {
        this.removeFrom(drag.from, drag.stack);
        this.game.dropStack(drag.stack);
        this.refresh();
        return;
      }
      this.returnToSource(drag);
      this.refresh();
      return;
    }

    this.performMove(drag, target);
    this.refresh();
  }

  // =========================================================================
  // Drag & drop
  // =========================================================================

  private beginDrag(stack: ItemStack, from: SlotRef, el: HTMLElement, e: MouseEvent, rot: boolean): void {
    const { cell, gap } = this.metrics();
    const rect = el.getBoundingClientRect();
    const fp = footprintOf(stack, rot);

    this.drag = {
      stack,
      from,
      rot,
      grabX: Math.min(fp.w - 1, Math.max(0, Math.floor((e.clientX - rect.left) / (cell + gap)))),
      grabY: Math.min(fp.h - 1, Math.max(0, Math.floor((e.clientY - rect.top) / (cell + gap)))),
    };

    // Detach from the source so the grid can validate the new position freely.
    this.removeFrom(from, stack);

    this.ghost.innerHTML = '';
    const icon = itemIcon(itemDef(stack.id));
    const c = document.createElement('canvas');
    c.width = icon.width;
    c.height = icon.height;
    c.getContext('2d')!.drawImage(icon, 0, 0);
    this.ghost.appendChild(c);
    this.ghost.classList.remove('hidden');
    this.updateGhostSize();
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
    this.hideTooltip();
    this.refresh();
  }

  private updateGhostSize(): void {
    if (!this.drag) return;
    const { cell, gap } = this.metrics();
    const fp = footprintOf(this.drag.stack, this.drag.rot);
    this.ghost.style.width = `${fp.w * cell + (fp.w - 1) * gap}px`;
    this.ghost.style.height = `${fp.h * cell + (fp.h - 1) * gap}px`;
    const canvas = this.ghost.querySelector('canvas');
    if (canvas) {
      // Rotate the icon with the item.
      canvas.style.transform = this.drag.rot ? 'rotate(90deg)' : '';
      canvas.style.width = this.drag.rot ? `${fp.h * cell}px` : '100%';
      canvas.style.height = this.drag.rot ? `${fp.w * cell}px` : '100%';
      canvas.style.transformOrigin = 'center';
    }
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.returnToSource(this.drag);
    this.drag = null;
    this.ghost.classList.add('hidden');
    this.clearHighlights();
    this.refresh();
  }

  /** Put a dragged stack back where it came from, or anywhere it fits. */
  private returnToSource(drag: DragState): void {
    const from = drag.from;
    if (from.kind === 'belt' && this.game.player.belt[from.index] === null) {
      this.game.player.belt[from.index] = drag.stack;
      return;
    }
    if (from.kind === 'equip' && this.game.player.equipment[from.slot] === null) {
      this.game.player.equipment[from.slot] = drag.stack;
      return;
    }
    if (from.kind === 'grid' && from.container.placeAt(drag.stack, from.cx, from.cy, drag.rot)) return;

    // Fallback: anywhere in the player's inventory, else on the floor.
    if (this.game.player.give(drag.stack) > 0) this.game.dropStack(drag.stack);
  }

  private removeFrom(ref: SlotRef, stack: ItemStack): void {
    switch (ref.kind) {
      case 'belt':
        if (this.game.player.belt[ref.index] === stack) this.game.player.belt[ref.index] = null;
        break;
      case 'equip':
        if (this.game.player.equipment[ref.slot] === stack) {
          this.game.player.equipment[ref.slot] = null;
          this.afterEquipChange();
        }
        break;
      case 'grid':
        ref.container.removeStack(stack);
        break;
    }
  }

  /** Execute a validated drop. */
  private performMove(drag: DragState, target: SlotRef): void {
    const { stack, rot } = drag;
    const player = this.game.player;

    switch (target.kind) {
      case 'grid': {
        const container = target.container;
        const fp = footprintOf(stack, rot);
        const cx = target.cx - drag.grabX;
        const cy = target.cy - drag.grabY;

        // Merge into an existing compatible stack.
        const occupant = container.at(target.cx, target.cy);
        if (occupant && canMerge(occupant.stack, stack)) {
          merge(occupant.stack, stack);
          if (stack.count > 0) this.returnToSource(drag);
          audio.play('ui_click');
          return;
        }
        // Swap with a single occupant if the footprints allow it.
        if (occupant && !container.canPlaceAt(cx, cy, fp)) {
          const otherStack = occupant.stack;
          const otherRot = occupant.rot;
          container.remove(occupant);
          if (container.canPlaceAt(cx, cy, fp)) {
            container.placeAt(stack, cx, cy, rot);
            // Put the displaced item where the dragged one came from.
            if (!this.placeAtSource(drag.from, otherStack, otherRot)) {
              if (player.give(otherStack) > 0) this.game.dropStack(otherStack);
            }
            audio.play('ui_click');
            return;
          }
          // Couldn't swap: restore both.
          container.placeAt(otherStack, occupant.x, occupant.y, otherRot);
          this.returnToSource(drag);
          return;
        }

        if (container.placeAt(stack, cx, cy, rot)) {
          audio.play('ui_click');
          return;
        }
        // Last resort: let the container find a free spot.
        if (container.add(stack) > 0) this.returnToSource(drag);
        else audio.play('ui_click');
        return;
      }

      case 'belt': {
        const existing = player.belt[target.index];
        if (existing && canMerge(existing, stack)) {
          merge(existing, stack);
          if (stack.count > 0) this.returnToSource(drag);
          audio.play('ui_click');
          return;
        }
        player.belt[target.index] = stack;
        if (existing) {
          if (!this.placeAtSource(drag.from, existing, false)) {
            if (player.give(existing) > 0) this.game.dropStack(existing);
          }
        }
        audio.play('ui_click');
        return;
      }

      case 'equip': {
        const def = itemDef(stack.id);
        if (def.armor?.slot !== target.slot) {
          this.game.toast(`${def.name} doesn't go there`, 'warn');
          this.returnToSource(drag);
          return;
        }
        const existing = player.equipment[target.slot];
        player.equipment[target.slot] = stack;
        this.afterEquipChange();
        if (existing) {
          if (!this.placeAtSource(drag.from, existing, false)) {
            if (player.give(existing) > 0) this.game.dropStack(existing);
          }
        }
        audio.play('ui_click');
        return;
      }
    }
  }

  /** Try to place a displaced item back into the drag's origin slot. */
  private placeAtSource(from: SlotRef, stack: ItemStack, rot: boolean): boolean {
    switch (from.kind) {
      case 'belt':
        if (this.game.player.belt[from.index] === null) {
          this.game.player.belt[from.index] = stack;
          return true;
        }
        return false;
      case 'equip': {
        const def = itemDef(stack.id);
        if (def.armor?.slot === from.slot && this.game.player.equipment[from.slot] === null) {
          this.game.player.equipment[from.slot] = stack;
          this.afterEquipChange();
          return true;
        }
        return false;
      }
      case 'grid':
        return from.container.placeAt(stack, from.cx, from.cy, rot);
    }
  }

  private afterEquipChange(): void {
    const evicted = this.game.player.refreshCapacity();
    for (const stack of evicted) this.game.dropStack(stack);
  }

  // =========================================================================
  // Hit testing
  // =========================================================================

  private metrics(): { cell: number; gap: number } {
    const style = getComputedStyle(document.documentElement);
    return {
      cell: parseFloat(style.getPropertyValue('--cell')) || 52,
      gap: parseFloat(style.getPropertyValue('--gap')) || 3,
    };
  }

  /** Which slot is under the cursor? */
  private resolveSlot(clientX: number, clientY: number): SlotRef | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!el) return null;

    const eslot = el.closest<HTMLElement>('.eslot');
    if (eslot) {
      if (eslot.dataset.slot) return { kind: 'equip', slot: eslot.dataset.slot as EquipSlot };
      if (eslot.dataset.belt !== undefined) return { kind: 'belt', index: Number(eslot.dataset.belt) };
    }

    const host = el.closest<HTMLElement>('.grid-host');
    if (host) {
      const container = this.hostContainers.get(host);
      if (!container) return null;
      const { cell, gap } = this.metrics();
      const rect = host.getBoundingClientRect();
      const cx = Math.floor((clientX - rect.left - gap) / (cell + gap));
      const cy = Math.floor((clientY - rect.top - gap) / (cell + gap));
      if (cx < 0 || cy < 0 || cx >= container.cols || cy >= container.rows) return null;
      return { kind: 'grid', container, cx, cy };
    }
    return null;
  }

  private clearHighlights(): void {
    for (const c of Array.from(this.screen.querySelectorAll('.hl-ok, .hl-bad'))) {
      c.classList.remove('hl-ok', 'hl-bad');
    }
  }

  private updateHighlight(clientX: number, clientY: number): void {
    this.clearHighlights();
    const drag = this.drag;
    if (!drag) return;
    const target = this.resolveSlot(clientX, clientY);
    if (!target) return;

    if (target.kind === 'equip') {
      const eslot = this.equipHost.querySelector<HTMLElement>(`.eslot[data-slot="${target.slot}"]`);
      const ok = itemDef(drag.stack.id).armor?.slot === target.slot;
      eslot?.classList.add(ok ? 'hl-ok' : 'hl-bad');
      return;
    }
    if (target.kind === 'belt') {
      const el = this.beltGrid.querySelector<HTMLElement>(`.eslot[data-belt="${target.index}"]`);
      el?.classList.add('hl-ok');
      return;
    }

    const container = target.container;
    const host = this.hostFor(container);
    if (!host) return;
    const fp = footprintOf(drag.stack, drag.rot);
    const cx = target.cx - drag.grabX;
    const cy = target.cy - drag.grabY;
    const occupant = container.at(target.cx, target.cy);
    const canFit = container.canPlaceAt(cx, cy, fp)
      || (occupant ? canMerge(occupant.stack, drag.stack) : false);

    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= container.cols || gy >= container.rows) continue;
        const cellEl = host.querySelector<HTMLElement>(`.cell[data-cx="${gx}"][data-cy="${gy}"]`);
        cellEl?.classList.add(canFit ? 'hl-ok' : 'hl-bad');
      }
    }
  }

  private hostFor(container: Container): HTMLElement | null {
    for (const [el, c] of this.hostContainers) if (c === container) return el;
    return null;
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  refresh(): void {
    if (!this.isOpen) return;
    this.hostContainers.clear();

    const player = this.game.player;
    this.renderGrid(this.playerGrid, player.inventory);
    this.renderBelt();
    this.renderEquipment();

    const loot = this.game.loot;
    this.lootPanel.classList.toggle('hidden', !loot);
    if (loot) {
      this.lootTitle.textContent = loot.label;
      this.renderGrid(this.lootGrid, loot.container);
    }

    this.weightLabel.textContent =
      `${player.carriedWeight.toFixed(1)} / ${player.weightLimit} kg`;
    this.weightLabel.style.color = player.carriedWeight > player.weightLimit ? 'var(--blood)' : '';

    this.renderCharStats();
    this.renderCrafting();
    this.renderQueue();
  }

  private renderGrid(host: HTMLElement, container: Container): void {
    const { cell, gap } = this.metrics();
    this.hostContainers.set(host, container);

    host.style.gridTemplateColumns = `repeat(${container.cols}, ${cell}px)`;
    host.style.gridTemplateRows = `repeat(${container.rows}, ${cell}px)`;
    host.innerHTML = '';

    for (let y = 0; y < container.rows; y++) {
      for (let x = 0; x < container.cols; x++) {
        const c = document.createElement('div');
        c.className = 'cell';
        c.dataset.cx = String(x);
        c.dataset.cy = String(y);
        host.appendChild(c);
      }
    }

    for (const placed of container.items) {
      host.appendChild(this.makeItemEl(placed, container, cell, gap));
    }
  }

  private makeItemEl(placed: PlacedItem, container: Container, cell: number, gap: number): HTMLElement {
    const stack = placed.stack;
    const def = itemDef(stack.id);
    const fp = footprintOf(stack, placed.rot);

    const el = document.createElement('div');
    el.className = 'item';
    el.dataset.rarity = def.rarity;
    el.style.left = `${gap + placed.x * (cell + gap)}px`;
    el.style.top = `${gap + placed.y * (cell + gap)}px`;
    el.style.width = `${fp.w * cell + (fp.w - 1) * gap}px`;
    el.style.height = `${fp.h * cell + (fp.h - 1) * gap}px`;

    const icon = itemIcon(def);
    const canvas = document.createElement('canvas');
    canvas.width = icon.width;
    canvas.height = icon.height;
    canvas.getContext('2d')!.drawImage(icon, 0, 0);
    if (placed.rot) {
      canvas.style.transform = 'rotate(90deg)';
      canvas.style.width = `${fp.h * cell}px`;
      canvas.style.height = `${fp.w * cell}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = '50%';
      canvas.style.top = '50%';
      canvas.style.marginLeft = `${-(fp.h * cell) / 2}px`;
      canvas.style.marginTop = `${-(fp.w * cell) / 2}px`;
    }
    el.appendChild(canvas);

    this.decorateItemEl(el, stack, def);
    const ref: SlotRef = { kind: 'grid', container, cx: placed.x, cy: placed.y };
    this.wireItemEl(el, stack, ref, placed.rot);
    return el;
  }

  private decorateItemEl(el: HTMLElement, stack: ItemStack, def: ItemDef): void {
    if (stack.count > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'count';
      cnt.textContent = String(stack.count);
      el.appendChild(cnt);
    }
    if (def.ranged && stack.mag !== undefined) {
      const cnt = document.createElement('span');
      cnt.className = 'count';
      cnt.textContent = `${stack.mag}`;
      el.appendChild(cnt);
    }
    if (def.durability !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'durability';
      const inner = document.createElement('i');
      const frac = durabilityFrac(stack);
      inner.style.width = `${frac * 100}%`;
      inner.style.background = frac > 0.5 ? 'var(--good)' : frac > 0.22 ? 'var(--accent)' : 'var(--blood)';
      bar.appendChild(inner);
      el.appendChild(bar);
    }
  }

  private wireItemEl(el: HTMLElement, stack: ItemStack, ref: SlotRef, rot: boolean): void {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 0) {
        if (e.shiftKey) { this.quickTransfer(stack, ref); return; }
        this.beginDrag(stack, ref, el, e, rot);
      } else if (e.button === 2) {
        this.contextAction(stack, ref);
      } else if (e.button === 1) {
        this.openSplit(stack, ref);
      }
    });
    el.addEventListener('mouseenter', () => this.showTooltip(stack, el));
    el.addEventListener('mouseleave', () => this.hideTooltip());
  }

  private renderBelt(): void {
    const { cell } = this.metrics();
    this.beltGrid.style.gridTemplateColumns = `repeat(${this.game.player.belt.length}, ${cell}px)`;
    this.beltGrid.style.gridTemplateRows = `${cell}px`;
    this.beltGrid.innerHTML = '';

    this.game.player.belt.forEach((stack, i) => {
      const slot = document.createElement('div');
      slot.className = 'eslot';
      slot.dataset.belt = String(i);
      if (i === this.game.player.activeSlot) slot.style.borderColor = 'var(--accent)';

      if (!stack) {
        const ph = document.createElement('span');
        ph.className = 'ph';
        ph.textContent = String(i + 1);
        slot.appendChild(ph);
      } else {
        const def = itemDef(stack.id);
        const el = document.createElement('div');
        el.className = 'item';
        el.dataset.rarity = def.rarity;
        el.style.left = '0';
        el.style.top = '0';
        el.style.width = '100%';
        el.style.height = '100%';

        const icon = itemIcon(def);
        const canvas = document.createElement('canvas');
        canvas.width = icon.width;
        canvas.height = icon.height;
        canvas.getContext('2d')!.drawImage(icon, 0, 0);
        canvas.style.objectFit = 'contain';
        el.appendChild(canvas);
        this.decorateItemEl(el, stack, def);
        this.wireItemEl(el, stack, { kind: 'belt', index: i }, false);
        slot.appendChild(el);
      }
      this.beltGrid.appendChild(slot);
    });
  }

  private renderEquipment(): void {
    this.equipHost.innerHTML = '';
    for (const slotName of EQUIP_SLOTS) {
      const slot = document.createElement('div');
      slot.className = 'eslot';
      slot.dataset.slot = slotName;
      const stack = this.game.player.equipment[slotName];

      if (!stack) {
        const ph = document.createElement('span');
        ph.className = 'ph';
        ph.textContent = SLOT_PLACEHOLDER[slotName];
        slot.appendChild(ph);
      } else {
        const def = itemDef(stack.id);
        const el = document.createElement('div');
        el.className = 'item';
        el.dataset.rarity = def.rarity;
        el.style.left = '0';
        el.style.top = '0';
        el.style.width = '100%';
        el.style.height = '100%';
        const icon = itemIcon(def);
        const canvas = document.createElement('canvas');
        canvas.width = icon.width;
        canvas.height = icon.height;
        canvas.getContext('2d')!.drawImage(icon, 0, 0);
        el.appendChild(canvas);
        this.decorateItemEl(el, stack, def);
        this.wireItemEl(el, stack, { kind: 'equip', slot: slotName }, false);
        slot.appendChild(el);
      }
      this.equipHost.appendChild(slot);
    }
  }

  private renderCharStats(): void {
    const p = this.game.player;
    const rows: [string, string][] = [
      ['Armour', `${(p.protection * 100).toFixed(0)}%`],
      ['Insulation', `+${p.warmth.toFixed(0)}°C`],
      ['Body temp', `${p.bodyTemp.toFixed(1)}°C`],
      ['Carry', `${p.carriedWeight.toFixed(1)} kg`],
      ['Infection', p.infection > 0 ? `${p.infection.toFixed(0)}%` : '—'],
      ['Zombie kills', String(p.zombieKills)],
      ['Total kills', String(p.kills)],
      ['Crafted', String(p.itemsCrafted)],
      ['Survived', `Day ${this.game.dayNight.day}`],
      ['Travelled', `${(p.distanceTravelled / 1000).toFixed(2)} km`],
    ];
    this.charStats.innerHTML = rows.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
  }

  // =========================================================================
  // Item actions
  // =========================================================================

  /** Shift-click: move between the loot window and the player. */
  private quickTransfer(stack: ItemStack, ref: SlotRef): void {
    const loot = this.game.loot;
    const player = this.game.player;

    if (ref.kind === 'grid' && loot && ref.container === loot.container) {
      // Loot -> player.
      loot.container.removeStack(stack);
      const left = player.give(stack);
      if (left > 0) {
        stack.count = left;
        loot.container.add(stack);
        this.game.toast('Inventory full', 'warn');
      } else {
        audio.play('pickup');
      }
    } else if (loot) {
      // Player -> loot.
      this.removeFrom(ref, stack);
      const left = loot.container.add(stack);
      if (left > 0) {
        stack.count = left;
        if (player.give(stack) > 0) this.game.dropStack(stack);
        this.game.toast('Container full', 'warn');
      } else {
        audio.play('ui_click');
      }
    } else if (ref.kind === 'grid') {
      // No loot open: shift-click sends items to the belt.
      const free = player.belt.indexOf(null);
      if (free >= 0) {
        this.removeFrom(ref, stack);
        player.belt[free] = stack;
        audio.play('ui_click');
      } else {
        this.game.toast('Belt is full', 'warn');
      }
    } else if (ref.kind === 'belt') {
      this.removeFrom(ref, stack);
      if (player.inventory.add(stack) > 0) {
        player.belt[ref.index] = stack;
        this.game.toast('Inventory full', 'warn');
      }
    }
    this.refresh();
  }

  /** Right-click: the item's natural action. */
  private contextAction(stack: ItemStack, ref: SlotRef): void {
    const def = itemDef(stack.id);
    const player = this.game.player;

    // Wear it.
    if (def.armor) {
      const slot = def.armor.slot;
      if (ref.kind === 'equip') {
        // Take it off.
        this.removeFrom(ref, stack);
        if (player.give(stack) > 0) this.game.dropStack(stack);
      } else {
        const existing = player.equipment[slot];
        this.removeFrom(ref, stack);
        player.equipment[slot] = stack;
        this.afterEquipChange();
        if (existing && player.give(existing) > 0) this.game.dropStack(existing);
      }
      audio.play('ui_click');
      this.refresh();
      return;
    }

    // Eat, drink, bandage.
    if (def.consume) {
      this.game.useConsumable(stack);
      this.close();
      return;
    }

    // Place a deployable.
    if (def.deploy) {
      if (this.game.deployItem(stack)) this.close();
      return;
    }

    // Fit an attachment to the weapon in hand.
    if (def.attach) {
      const weapon = player.heldItem;
      if (!weapon || !itemDef(weapon.id).ranged) {
        this.game.toast('Hold a firearm first', 'warn');
        return;
      }
      weapon.attachments = weapon.attachments ?? [];
      if (weapon.attachments.includes(stack.id)) {
        this.game.toast('Already fitted', 'warn');
        return;
      }
      weapon.attachments.push(stack.id);
      this.removeFrom(ref, stack);
      if (stack.count > 1) {
        stack.count -= 1;
        player.give(stack);
      }
      const mods = attachmentMods(weapon);
      this.game.toast(`Fitted ${def.name}${mods.silence ? ' (silenced)' : ''}`, 'pickup');
      audio.play('reload_in');
      this.refresh();
      return;
    }

    // Weapons and tools: send to the belt so they can be held.
    if (def.ranged || def.melee || def.throwable || def.cat === 'tool') {
      if (ref.kind === 'belt') {
        this.removeFrom(ref, stack);
        if (player.inventory.add(stack) > 0) player.belt[ref.index] = stack;
      } else {
        const free = player.belt.indexOf(null);
        if (free < 0) { this.game.toast('Belt is full', 'warn'); return; }
        this.removeFrom(ref, stack);
        player.belt[free] = stack;
        player.selectSlot(free);
      }
      audio.play('ui_click');
      this.refresh();
      return;
    }

    this.game.toast(`${def.name} — nothing to do`, 'warn');
  }

  private takeAll(): void {
    const loot = this.game.loot;
    if (!loot) return;
    let moved = 0;
    for (const placed of [...loot.container.items]) {
      loot.container.remove(placed);
      const left = this.game.player.give(placed.stack);
      if (left > 0) {
        placed.stack.count = left;
        loot.container.add(placed.stack);
        this.game.toast('Inventory full', 'warn');
        break;
      }
      moved++;
    }
    if (moved > 0) audio.play('pickup');
    this.refresh();
  }

  // =========================================================================
  // Split dialog
  // =========================================================================

  private openSplit(stack: ItemStack, ref: SlotRef): void {
    if (stack.count < 2) return;
    this.splitTarget = { stack, from: ref };
    this.splitRange.min = '1';
    this.splitRange.max = String(stack.count - 1);
    this.splitRange.value = String(Math.floor(stack.count / 2));
    this.splitValue.textContent = this.splitRange.value;
    this.splitDialog.classList.remove('hidden');
  }

  private closeSplit(): void {
    this.splitTarget = null;
    this.splitDialog.classList.add('hidden');
  }

  private confirmSplit(): void {
    const target = this.splitTarget;
    if (!target) return;
    const n = Number(this.splitRange.value);
    const piece = split(target.stack, n);
    this.closeSplit();
    if (!piece) return;
    if (this.game.player.give(piece) > 0) this.game.dropStack(piece);
    audio.play('ui_click');
    this.refresh();
  }

  // =========================================================================
  // Tooltip
  // =========================================================================

  private showTooltip(stack: ItemStack, anchor: HTMLElement): void {
    if (this.drag) return;
    const def = itemDef(stack.id);
    const rows: string[] = [];
    const stat = (k: string, v: string) => rows.push(`<div class="t-stat"><span>${k}</span><b>${v}</b></div>`);

    if (def.ranged) {
      const r = def.ranged;
      stat('Damage', `${r.damage}${r.pellets ? ` x${r.pellets}` : ''}`);
      stat('Ammo', AMMO_LABEL[r.ammo]);
      stat('Magazine', `${stack.mag ?? 0} / ${r.magSize}`);
      stat('Fire rate', r.auto ? `${r.rpm} rpm auto` : `${r.rpm} rpm`);
      stat('Spread', `${r.spread.toFixed(1)}°`);
      stat('Range', `${Math.round(r.range / 32)} m`);
      stat('Reload', `${r.reload.toFixed(2)} s`);
      if (stack.attachments?.length) {
        stat('Attachments', stack.attachments.map((a) => itemDef(a).name).join(', '));
      }
    }
    if (def.melee) {
      const m = def.melee;
      stat('Damage', String(m.damage));
      stat('Reach', `${Math.round(m.range)} cm`);
      stat('Arc', `${m.arc}°`);
      stat('Speed', `${m.speed.toFixed(2)} s`);
      stat('Stamina', String(m.stamina));
      if (m.power > 0.5) stat('Gathering', `${m.power.toFixed(1)} (${m.classes.join(', ')})`);
      if (m.bleed) stat('Bleed chance', `${(m.bleed * 100).toFixed(0)}%`);
    }
    if (def.throwable) {
      const t = def.throwable;
      stat('Damage', String(t.damage));
      if (t.radius) stat('Blast radius', `${Math.round(t.radius / 32)} m`);
      if (t.fuse) stat('Fuse', `${t.fuse.toFixed(1)} s`);
    }
    if (def.armor) {
      stat('Protection', `${(def.armor.protection * 100).toFixed(0)}%`);
      stat('Insulation', `+${def.armor.warmth}°C`);
      if (def.armor.rows) stat('Extra rows', `+${def.armor.rows}`);
      if (def.armor.bulk) stat('Bulk', `-${(def.armor.bulk * 100).toFixed(0)}% speed`);
      if (def.armor.vision) stat('Vision', def.armor.vision === 'night' ? 'Night vision' : 'Gas filter');
    }
    if (def.consume) {
      const c = def.consume;
      if (c.food) stat('Food', `${c.food > 0 ? '+' : ''}${c.food}`);
      if (c.water) stat('Water', `${c.water > 0 ? '+' : ''}${c.water}`);
      if (c.health) stat('Health', `${c.health > 0 ? '+' : ''}${c.health}`);
      if (c.regen) stat('Regen', `+${c.regen} over ${c.overTime}s`);
      if (c.stamina) stat('Stamina', `+${c.stamina}`);
      if (c.stopBleed) stat('Stops bleeding', 'yes');
      if (c.cureInfection) stat('Cures infection', 'yes');
      stat('Use time', `${c.useTime.toFixed(1)} s`);
    }
    if (def.ammoKind) stat('Calibre', AMMO_LABEL[def.ammoKind]);
    if (def.fuel) stat('Burn time', `${def.fuel} s`);
    if (def.light) stat('Light radius', `${Math.round(def.light / 32)} m`);
    if (def.durability !== undefined) {
      stat('Condition', `${(durabilityFrac(stack) * 100).toFixed(0)}%`);
    }
    stat('Size', `${def.w}x${def.h}`);
    stat('Weight', `${(def.weight * stack.count).toFixed(2)} kg`);

    const actions: string[] = [];
    if (def.armor) actions.push('<b>RMB</b> wear');
    if (def.consume) actions.push('<b>RMB</b> use');
    if (def.deploy) actions.push('<b>RMB</b> place');
    if (def.attach) actions.push('<b>RMB</b> fit to held gun');
    if (def.ranged || def.melee || def.throwable) actions.push('<b>RMB</b> to belt');
    if (stack.count > 1) actions.push('<b>MMB</b> split');
    actions.push('<b>Shift+LMB</b> transfer');
    if (def.w !== def.h) actions.push('<b>R</b> rotate while dragging');

    this.tooltip.innerHTML = `
      <div class="t-name" style="color:${rarityColor(def.rarity)}">${def.name}</div>
      <div class="t-cat">${CATEGORY_LABEL[def.cat]}${def.rarity !== 'common' ? ` · ${def.rarity}` : ''}</div>
      ${def.desc ? `<div class="t-desc">${def.desc}</div>` : ''}
      ${rows.join('')}
      <div class="t-actions">${actions.join(' · ')}</div>`;

    this.tooltip.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const tipRect = this.tooltip.getBoundingClientRect();
    let left = rect.right + 10;
    let top = rect.top;
    if (left + tipRect.width > window.innerWidth - 8) left = rect.left - tipRect.width - 10;
    if (top + tipRect.height > window.innerHeight - 8) top = window.innerHeight - tipRect.height - 8;
    this.tooltip.style.left = `${Math.max(8, left)}px`;
    this.tooltip.style.top = `${Math.max(8, top)}px`;
  }

  private hideTooltip(): void {
    this.tooltip.classList.add('hidden');
  }

  // =========================================================================
  // Crafting
  // =========================================================================

  private renderCrafting(): void {
    const game = this.game;
    const crafting = game.crafting;
    const recipes = crafting.list(this.craftFilter);

    const byGroup = new Map<string, Recipe[]>();
    for (const r of recipes) {
      const arr = byGroup.get(r.group) ?? [];
      arr.push(r);
      byGroup.set(r.group, arr);
    }

    const frag = document.createDocumentFragment();
    for (const group of RECIPE_GROUPS) {
      const list = byGroup.get(group);
      if (!list || list.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'craft-group';
      header.textContent = group;
      frag.appendChild(header);

      for (const recipe of list) {
        frag.appendChild(this.makeRecipeRow(recipe));
      }
    }
    this.craftList.innerHTML = '';
    this.craftList.appendChild(frag);
    void crafting;
  }

  private makeRecipeRow(recipe: Recipe): HTMLElement {
    const game = this.game;
    const def = itemDef(recipe.out);
    const stationOk = game.crafting.available(recipe);
    const missing = game.crafting.missing(game, recipe);
    const affordable = missing.size === 0;

    const row = document.createElement('div');
    row.className = 'recipe' + (stationOk && affordable ? '' : ' locked');

    const ico = document.createElement('div');
    ico.className = 'r-ico';
    const icon = itemIcon(def);
    const canvas = document.createElement('canvas');
    canvas.width = icon.width;
    canvas.height = icon.height;
    canvas.getContext('2d')!.drawImage(icon, 0, 0);
    canvas.style.objectFit = 'contain';
    ico.appendChild(canvas);
    row.appendChild(ico);

    const body = document.createElement('div');
    body.className = 'r-body';
    const costHtml = recipe.cost.map(([id, n]) => {
      const have = game.player.countItem(id);
      const cls = have >= n ? 'have' : 'miss';
      return `<span class="${cls}">${n} ${itemDef(id).name}</span>`;
    }).join(', ');

    body.innerHTML = `
      <div class="r-name">${def.name}${recipe.count > 1 ? ` x${recipe.count}` : ''}</div>
      <div class="r-cost">${costHtml}</div>
      ${!stationOk ? `<div class="r-need">Needs ${STATION_LABEL[recipe.station]}</div>` : ''}`;
    row.appendChild(body);

    row.addEventListener('click', (e) => {
      const qty = e.shiftKey ? 5 : 1;
      if (game.crafting.enqueue(game, recipe, qty)) this.refresh();
    });
    row.addEventListener('mouseenter', () => {
      // Reuse the item tooltip for the recipe output.
      const tempStack: ItemStack = { uid: -1, id: recipe.out, count: recipe.count };
      this.showTooltip(tempStack, row);
    });
    row.addEventListener('mouseleave', () => this.hideTooltip());
    return row;
  }

  private renderQueue(): void {
    const queue = this.game.crafting.queue;
    const sig = queue.map((q) => `${q.recipe.out}:${q.remaining}`).join('|') + `:${queue.length}`;
    // The progress bar needs updating every frame, so always redraw widths.
    if (sig !== this.queueSig) {
      this.queueSig = sig;
      this.craftQueue.innerHTML = '';
      queue.forEach((q, i) => {
        const el = document.createElement('div');
        el.className = 'qitem';
        el.innerHTML = `
          <span>${itemDef(q.recipe.out).name}${q.remaining > 1 ? ` x${q.remaining}` : ''}</span>
          <div class="qbar"><i></i></div>
          <span class="dim">cancel</span>`;
        el.addEventListener('click', () => {
          this.game.crafting.cancel(this.game, i);
          this.queueSig = '';
          this.refresh();
        });
        this.craftQueue.appendChild(el);
      });
    }
    const first = this.craftQueue.querySelector<HTMLElement>('.qitem .qbar > i');
    if (first && queue[0]) {
      first.style.width = `${(1 - queue[0].timeLeft / queue[0].recipe.time) * 100}%`;
    }
  }
}

function rarityColor(rarity: string): string {
  switch (rarity) {
    case 'uncommon': return 'var(--rar-uncommon)';
    case 'rare': return 'var(--rar-rare)';
    case 'epic': return 'var(--rar-epic)';
    case 'legendary': return 'var(--rar-legendary)';
    default: return 'var(--txt)';
  }
}
