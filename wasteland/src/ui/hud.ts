/**
 * The heads-up display.
 *
 * All DOM, updated once per frame from game state. Kept deliberately cheap:
 * elements are created once and only their text/width/class change.
 */

import { clamp01 } from '../core/math';
import { itemDef } from '../items/itemdefs';
import { durabilityFrac } from '../items/item';
import { itemIcon } from '../items/icons';
import { reserveAmmo } from '../systems/combat';
import { PIECE_LABEL } from '../systems/building';
import { BELT_SLOTS } from '../entities/player';
import type { Game } from '../game';

type ToastKind = 'pickup' | 'warn' | 'bad' | 'info';

const DIRECTIONS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

export class Hud {
  private game: Game;

  private clockTime = document.getElementById('clock-time')!;
  private clockDay = document.getElementById('clock-day')!;
  private compassDir = document.getElementById('compass-dir')!;
  private tempVal = document.getElementById('temp-val')!;
  private weaponName = document.getElementById('weapon-name')!;
  private weaponReadout = document.getElementById('weapon-readout')!;
  private ammoMag = document.getElementById('ammo-mag')!;
  private ammoReserve = document.getElementById('ammo-reserve')!;
  private prompt = document.getElementById('interact-prompt')!;
  private effectsEl = document.getElementById('hud-effects')!;
  private toastsEl = document.getElementById('toasts')!;
  private hitmarkerEl = document.getElementById('hitmarker')!;
  private vignette = document.getElementById('damage-vignette')!;
  private crosshair = document.getElementById('crosshair')!;
  private buildHint = document.getElementById('build-hint')!;
  private hotbarEl = document.getElementById('hotbar')!;

  private vitals = new Map<string, { bar: HTMLElement; num: HTMLElement; row: HTMLElement }>();
  private slots: HTMLElement[] = [];
  /** Batches repeated gather pickups into a single updating toast. */
  private gatherToasts = new Map<string, { el: HTMLElement; count: number; timer: number }>();
  private activeToasts: { el: HTMLElement; life: number }[] = [];

  constructor(game: Game) {
    this.game = game;

    for (const row of Array.from(document.querySelectorAll<HTMLElement>('.vital'))) {
      const key = row.dataset.vital!;
      this.vitals.set(key, {
        bar: row.querySelector('.vital-bar > i')!,
        num: row.querySelector('.vital-num')!,
        row,
      });
    }

    this.buildHotbar();
  }

  private buildHotbar(): void {
    this.hotbarEl.innerHTML = '';
    this.slots = [];
    for (let i = 0; i < BELT_SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'hslot';
      slot.dataset.beltIndex = String(i);
      slot.innerHTML = `<span class="key">${i + 1}</span>`;
      slot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.game.player.selectSlot(i);
      });
      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    }
  }

  // -------------------------------------------------------------------------

  update(dt: number): void {
    const game = this.game;
    const p = game.player;
    const dn = game.dayNight;

    // --- clock & environment ---
    this.clockTime.textContent = dn.clockString;
    this.clockDay.textContent = `Day ${dn.day} · ${game.locationName}`;

    const deg = ((p.facing * 180) / Math.PI + 360) % 360;
    this.compassDir.textContent = DIRECTIONS[Math.round(deg / 45) % 8];

    const biome = game.world.biomeAt(p.x, p.y);
    const ambient = dn.ambientTemp(biome, game.world.isIndoors(p.x, p.y));
    this.tempVal.textContent = `${ambient.toFixed(0)}°C · ${dn.weather}`;

    // --- vitals ---
    this.setVital('health', p.hp, p.maxHp);
    this.setVital('stamina', p.mount ? p.mount.stamina : p.stamina, 100);
    this.setVital('food', p.food, 100);
    this.setVital('water', p.water, 100);

    // --- status effects ---
    this.updateEffects();

    // --- weapon readout ---
    this.updateWeapon();

    // --- hotbar ---
    this.updateHotbar();

    // --- interaction prompt ---
    const inter = game.interaction;
    if (inter) {
      this.prompt.innerHTML = `<b>E</b> ${inter.label}${inter.hint ? `<br><span class="dim" style="font-size:12px">${inter.hint}</span>` : ''}`;
      this.prompt.classList.add('show');
    } else {
      this.prompt.classList.remove('show');
    }

    // --- build mode hint ---
    if (game.building.active) {
      const cost = game.building.cost().map(([id, n]) => `${n} ${itemDef(id).name}`).join(', ');
      this.buildHint.textContent = `BUILD · ${PIECE_LABEL[game.building.piece]} — ${cost} · scroll to change · B to exit`;
      this.buildHint.classList.remove('hidden');
    } else {
      this.buildHint.classList.add('hidden');
    }

    // --- crosshair spread feedback ---
    const held = p.heldItem ? itemDef(p.heldItem.id) : null;
    if (held?.ranged) {
      const spread = p.aiming ? held.ranged.spread * held.ranged.adsSpread : held.ranged.spread;
      const scale = 1 + spread * 0.14 + Math.abs(p.recoil) * 5 + (p.sprinting ? 0.8 : 0);
      this.crosshair.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(2)})`;
      this.crosshair.classList.remove('hidden');
    } else {
      this.crosshair.style.transform = 'translate(-50%,-50%) scale(1)';
      this.crosshair.classList.toggle('hidden', game.inv.isOpen);
    }

    // --- damage vignette ---
    this.vignette.style.opacity = String(clamp01(game.effects.hurt * 0.9));

    // --- toast lifetimes ---
    this.tickToasts(dt);
  }

  private setVital(key: string, value: number, max: number): void {
    const v = this.vitals.get(key);
    if (!v) return;
    const frac = clamp01(value / max);
    v.bar.style.width = `${(frac * 100).toFixed(1)}%`;
    v.num.textContent = String(Math.round(value));
    v.row.classList.toggle('critical', frac < 0.22);
  }

  private updateEffects(): void {
    const p = this.game.player;
    const s = p.status;
    const lines: { text: string; cls: string }[] = [];

    if (s.bleeding) lines.push({ text: `Bleeding (${p.bleed.toFixed(0)})`, cls: '' });
    if (s.infected) lines.push({ text: `Infected ${p.infection.toFixed(0)}%`, cls: '' });
    if (s.brokenLeg) lines.push({ text: 'Broken leg', cls: '' });
    if (s.cold) lines.push({ text: `Freezing ${p.bodyTemp.toFixed(1)}°C`, cls: 'cold' });
    if (s.hot) lines.push({ text: `Overheating ${p.bodyTemp.toFixed(1)}°C`, cls: 'warm' });
    if (s.wet) lines.push({ text: 'Soaked', cls: 'cold' });
    if (s.starving) lines.push({ text: 'Starving', cls: '' });
    if (s.dehydrated) lines.push({ text: 'Dehydrated', cls: '' });
    if (s.overweight) lines.push({ text: `Overloaded ${p.carriedWeight.toFixed(1)}kg`, cls: 'warm' });
    if (s.painkillers) lines.push({ text: 'Painkillers', cls: 'buff' });
    if (p.mount) lines.push({ text: 'Mounted', cls: 'buff' });
    if (this.game.crafting.queue.length > 0) {
      const q = this.game.crafting.queue[0];
      lines.push({
        text: `Crafting ${itemDef(q.recipe.out).name} ${(this.game.crafting.progress * 100).toFixed(0)}%`,
        cls: 'buff',
      });
    }

    // Only rebuild when the content actually changes.
    const signature = lines.map((l) => l.text).join('|');
    if (signature === this.lastEffectSig) return;
    this.lastEffectSig = signature;
    this.effectsEl.innerHTML = lines.map((l) => `<div class="effect ${l.cls}">${l.text}</div>`).join('');
  }

  private lastEffectSig = '';

  private updateWeapon(): void {
    const p = this.game.player;
    const held = p.heldItem;
    if (!held) {
      this.weaponName.textContent = 'Unarmed';
      this.ammoMag.textContent = '—';
      this.ammoReserve.textContent = '';
      this.weaponReadout.classList.remove('empty');
      return;
    }
    const def = itemDef(held.id);
    this.weaponName.textContent = def.name;

    if (def.ranged) {
      const mag = held.mag ?? 0;
      this.ammoMag.textContent = `${mag}`;
      this.ammoReserve.textContent = `/ ${reserveAmmo(this.game, held)}`;
      this.weaponReadout.classList.toggle('empty', mag === 0);
      if (p.action === 'reload') {
        this.weaponName.textContent = `${def.name} — reloading ${(p.actionProgress * 100).toFixed(0)}%`;
      }
    } else if (def.melee) {
      this.ammoMag.textContent = `${def.melee.damage}`;
      this.ammoReserve.textContent = 'dmg';
      this.weaponReadout.classList.remove('empty');
    } else if (def.throwable) {
      this.ammoMag.textContent = `${held.count}`;
      this.ammoReserve.textContent = 'left';
      this.weaponReadout.classList.remove('empty');
    } else {
      this.ammoMag.textContent = '—';
      this.ammoReserve.textContent = '';
      this.weaponReadout.classList.remove('empty');
    }
  }

  private updateHotbar(): void {
    const p = this.game.player;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const stack = p.belt[i];
      slot.classList.toggle('active', i === p.activeSlot);

      const sig = stack ? `${stack.id}:${stack.count}:${stack.dur ?? ''}:${stack.mag ?? ''}` : '';
      if (slot.dataset.sig === sig) continue;
      slot.dataset.sig = sig;

      slot.innerHTML = `<span class="key">${i + 1}</span>`;
      if (!stack) continue;

      const def = itemDef(stack.id);
      const icon = itemIcon(def);
      const img = document.createElement('canvas');
      img.width = icon.width;
      img.height = icon.height;
      img.getContext('2d')!.drawImage(icon, 0, 0);
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      slot.appendChild(img);

      if (stack.count > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'cnt';
        cnt.textContent = String(stack.count);
        slot.appendChild(cnt);
      }
      if (def.durability !== undefined) {
        const dura = document.createElement('div');
        dura.className = 'dura';
        const frac = durabilityFrac(stack);
        dura.style.width = `${frac * 100}%`;
        dura.style.background = frac > 0.5 ? '#63a84b' : frac > 0.22 ? '#c9a227' : '#a3251f';
        slot.appendChild(dura);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  toast(text: string, kind: ToastKind = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.toastsEl.appendChild(el);
    this.activeToasts.push({ el, life: 3.4 });
    // Keep the stack short.
    while (this.activeToasts.length > 7) {
      const old = this.activeToasts.shift()!;
      old.el.remove();
    }
  }

  /** Aggregate repeated resource pickups into one line that counts up. */
  flashGather(itemId: string, count: number): void {
    if (count <= 0) return;
    const name = itemDef(itemId).name;
    const existing = this.gatherToasts.get(itemId);
    if (existing && existing.el.isConnected) {
      existing.count += count;
      existing.timer = 2.4;
      existing.el.textContent = `+${existing.count} ${name}`;
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast pickup';
    el.textContent = `+${count} ${name}`;
    this.toastsEl.appendChild(el);
    this.gatherToasts.set(itemId, { el, count, timer: 2.4 });
  }

  private tickToasts(dt: number): void {
    for (let i = this.activeToasts.length - 1; i >= 0; i--) {
      const t = this.activeToasts[i];
      t.life -= dt;
      if (t.life <= 0.5) t.el.classList.add('fade');
      if (t.life <= 0) {
        t.el.remove();
        this.activeToasts.splice(i, 1);
      }
    }
    for (const [id, g] of [...this.gatherToasts]) {
      g.timer -= dt;
      if (g.timer <= 0.5) g.el.classList.add('fade');
      if (g.timer <= 0) {
        g.el.remove();
        this.gatherToasts.delete(id);
      }
    }
  }

  hitmarker(crit: boolean): void {
    this.hitmarkerEl.classList.remove('show');
    // Force a reflow so the animation restarts on rapid hits.
    void this.hitmarkerEl.offsetWidth;
    this.hitmarkerEl.style.filter = crit ? 'drop-shadow(0 0 4px #ffd257)' : '';
    this.hitmarkerEl.classList.add('show');
  }
}
