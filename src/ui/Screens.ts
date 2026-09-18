import { describeMode, item } from '../combat/items';
import { BAG_CAPACITY, type BagTab, type EquipSlot } from '../player/Inventory';
import type { Player } from '../player/Player';
import { ATTRIBUTE_INFO, type AttributeKey } from '../player/Stats';
import { applyGlyph, itemGlyph } from './glyphs';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/**
 * The character sheet: stats, attribute spending, equipment, and the bag.
 *
 * Rebuilt from scratch whenever it changes — it is only visible while the game
 * is paused, so there is no reason to diff anything.
 */
export class Screens {
  private root = el<HTMLDivElement>('sheet');
  private statsHost = el<HTMLElement>('sheet-stats');
  private equipHost = el<HTMLElement>('sheet-equip');
  private bagHost = el<HTMLElement>('sheet-bag');

  private player: Player | null = null;
  private onChange: () => void;
  /** Which bag tab is showing. Remembered across openings. */
  private activeTab: BagTab = 'main';
  /** Scroll offset per tab, so switching back does not jump to the top. */
  private scrollByTab: Record<BagTab, number> = { main: 0, tools: 0, materials: 0 };

  constructor(onChange: () => void) {
    this.onChange = onChange;
    el<HTMLButtonElement>('sheet-close').addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(player: Player): void {
    this.player = player;
    this.root.classList.remove('hidden');
    this.refresh();
  }

  close(): void {
    this.root.classList.add('hidden');
    this.onChange();
  }

  toggle(player: Player): void {
    if (this.isOpen) this.close();
    else this.open(player);
  }

  refresh(): void {
    if (!this.player || !this.isOpen) return;
    this.renderStats(this.player);
    this.renderEquipment(this.player);
    this.renderBag(this.player);
  }

  // ---------------------------------------------------------------- stats

  private renderStats(player: Player): void {
    const stats = player.stats;
    const defense = player.defense;
    const { current, needed } = stats.xpIntoLevel();

    this.statsHost.replaceChildren();
    this.statsHost.append(heading('Stats'));

    const rows: [string, string][] = [
      ['Level', String(stats.level)],
      ['Experience', `${current} / ${needed}`],
      ['Health', `${Math.ceil(stats.hp)} / ${stats.maxHp}`],
      ['Stamina', `${Math.round(stats.stamina)} / ${stats.maxStamina}`],
      ['Armor', `${defense.armor}${stats.wardArmor > 0 ? ` (+${stats.wardArmor} ward)` : ''}`],
      ['Melee damage', `x${stats.meleeMultiplier.toFixed(2)}`],
      ['Ranged damage', `x${stats.rangedMultiplier.toFixed(2)}`],
      ['Spell damage', `x${stats.spellMultiplier.toFixed(2)}`],
      ['Move speed', `${stats.moveSpeed.toFixed(1)} b/s`],
      ['Equipment weight', stats.weight.toFixed(1)],
      ['Carried weight', `${player.inventory.carriedWeight.toFixed(1)} (materials free)`],
      ['Mana', `${Math.floor(stats.mana)} / ${stats.maxMana}`],
    ];
    for (const [label, value] of rows) this.statsHost.append(statRow(label, value));

    // Resistances read directly off the equipped armour, negatives included.
    const resists = Object.entries(defense.resist).filter(([, v]) => v && Math.abs(v) > 0.001);
    if (resists.length > 0) {
      this.statsHost.append(heading('Resistances'));
      for (const [type, value] of resists) {
        const pct = Math.round((value ?? 0) * 100);
        this.statsHost.append(statRow(type, `${pct > 0 ? '' : '+'}${-pct}% damage taken`));
      }
    }

    this.statsHost.append(heading('Attributes'));
    if (stats.unspent > 0) {
      const note = document.createElement('div');
      note.className = 'points';
      note.textContent = `${stats.unspent} point${stats.unspent === 1 ? '' : 's'} available`;
      this.statsHost.append(note);
    }

    for (const key of Object.keys(ATTRIBUTE_INFO) as AttributeKey[]) {
      const info = ATTRIBUTE_INFO[key];
      const row = document.createElement('div');
      row.className = 'attr';
      row.title = info.note;

      const name = document.createElement('span');
      name.className = 'an';
      name.textContent = info.label;

      const value = document.createElement('span');
      value.className = 'av';
      value.textContent = String(stats.attributes[key]);

      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = stats.unspent <= 0;
      plus.addEventListener('click', () => {
        if (stats.spend(key)) {
          player.syncEquipmentDerived();
          this.refresh();
        }
      });

      row.append(name, value, plus);
      this.statsHost.append(row);
    }

    const slots = stats.maxSlots();
    this.statsHost.append(heading('Spell Slots'));
    slots.forEach((count, i) => {
      if (count <= 0) {
        this.statsHost.append(statRow(`Tier ${i + 1}`, i === 1 ? 'unlocks at level 4' : 'unlocks at level 8'));
        return;
      }
      this.statsHost.append(statRow(`Tier ${i + 1}`, `${count - stats.slotsUsed[i]} / ${count}`));
    });
  }

  // ---------------------------------------------------------------- equipment

  private renderEquipment(player: Player): void {
    this.equipHost.replaceChildren();
    this.equipHost.append(heading('Equipped'));

    const slots: [EquipSlot, string][] = [
      ['weapon', 'Weapon'],
      ['shield', 'Off-hand'],
      // A torch has its own slot so it can be carried alongside a shield.
      ['torch', 'Light'],
      ['armor', 'Armor'],
    ];

    for (const [slot, label] of slots) {
      const def = player.inventory.equippedDef(slot);
      const row = document.createElement('div');
      row.className = 'eq-slot';

      const left = document.createElement('div');
      const labelNode = document.createElement('span');
      labelNode.className = 'eq-label';
      labelNode.textContent = label;
      left.append(labelNode);

      const value = document.createElement('div');
      value.className = 'eq-val';
      if (!def) {
        value.textContent = slot === 'weapon' ? 'Bare hands' : slot === 'torch' ? 'Unlit' : 'None';
      } else {
        value.textContent = `${itemGlyph(def)} ${def.name}`;
        const sub = document.createElement('span');
        sub.className = 'eq-sub';
        sub.textContent = this.describeEquipped(def, slot);
        value.append(sub);
      }

      row.append(left, value);
      this.equipHost.append(row);
    }

    // Spell out every attack mode the equipped weapon has — this is where the
    // swing/thrust rules are explained to the player.
    const weapon = player.inventory.equippedDef('weapon');
    if (weapon?.weapon && weapon.weapon.melee.length > 0) {
      this.equipHost.append(heading('Attack Modes  (X to switch)'));
      const activeIndex = player.inventory.attackModeIndex(weapon.id, weapon.weapon.melee.length);
      weapon.weapon.melee.forEach((attack, i) => {
        const row = document.createElement('div');
        row.className = 'eq-slot';
        const left = document.createElement('div');
        if (i === activeIndex) {
          row.style.borderColor = '#d8b25a';
          // A CSS triangle, not a glyph — see .mode-marker in styles.css.
          const marker = document.createElement('div');
          marker.className = 'mode-marker';
          left.append(marker);
        }
        const value = document.createElement('div');
        value.className = 'eq-val';
        value.textContent = describeMode(attack);
        const sub = document.createElement('span');
        sub.className = 'eq-sub';
        sub.textContent = `${attack.reach.toFixed(1)}m reach · ${attack.arcDeg}° arc · ${attack.maxTargets} target${attack.maxTargets === 1 ? '' : 's'} · ${attack.stamina} stamina`;
        value.append(sub);
        row.append(left, value);
        this.equipHost.append(row);
      });
    }

    if (weapon) {
      const blurb = document.createElement('p');
      blurb.className = 'hint';
      blurb.textContent = weapon.blurb;
      this.equipHost.append(blurb);
    }
  }

  private describeEquipped(def: ReturnType<typeof item>, slot: EquipSlot): string {
    if (slot === 'armor' && def.armor) {
      return `Armor ${def.armor.armor} · weight ${def.armor.weight}`;
    }
    if (slot === 'shield' && def.shield) {
      return `Blocks ${Math.round(def.shield.absorb * 100)}% in a ${def.shield.coneDeg}° cone · guard ${def.shield.guard}`;
    }
    if (slot === 'torch' && def.torch) {
      return `Lights ${def.torch.radius} blocks · works with a shield`;
    }
    if (slot === 'weapon' && def.weapon) {
      const ranged = def.weapon.ranged;
      if (ranged) {
        const reload = ranged.reloadTime > 0 ? ` · ${ranged.reloadTime}s reload` : '';
        return `${ranged.damage} ${ranged.type}${reload}${def.weapon.twoHanded ? ' · two-handed' : ''}`;
      }
      return def.weapon.twoHanded ? 'Two-handed' : 'One-handed';
    }
    return '';
  }

  // ---------------------------------------------------------------- bag

  private renderBag(player: Player): void {
    this.bagHost.replaceChildren();
    this.bagHost.append(heading(`Inventory  (hotbar slot ${player.inventory.selected + 1} highlighted)`));

    // Tab strip. Counts are shown so you can see at a glance where things are.
    const tabs: [BagTab, string][] = [
      ['main', 'Main'],
      ['tools', 'Tools'],
      ['materials', 'Materials'],
    ];
    const strip = document.createElement('div');
    strip.className = 'bag-tabs';
    for (const [tab, label] of tabs) {
      const button = document.createElement('button');
      button.className = `bag-tab${tab === this.activeTab ? ' active' : ''}`;
      const used = player.inventory.slots(tab).filter(Boolean).length;
      button.textContent = `${label} ${used}/${BAG_CAPACITY[tab]}`;
      button.addEventListener('click', () => {
        this.activeTab = tab;
        this.refresh();
      });
      strip.append(button);
    }
    this.bagHost.append(strip);

    if (this.activeTab === 'materials') {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Building materials carry no weight.';
      this.bagHost.append(note);
    }

    // The grid keeps its visible size and scrolls, rather than growing the panel.
    const scroller = document.createElement('div');
    scroller.className = 'bag-scroll';

    const grid = document.createElement('div');
    grid.className = 'bag-grid';

    const slots = player.inventory.slots(this.activeTab);
    for (let i = 0; i < slots.length; i++) {
      const stack = slots[i];
      const cell = document.createElement('div');
      cell.className = stack ? 'bag-item' : 'bag-item empty';

      if (stack) {
        const def = item(stack.itemId);
        applyGlyph(cell, def);
        cell.title = `${def.name}\n${def.blurb}\n\nClick: ${equipVerb(def.kind)}\nShift-click: drop`;
        if (stack.qty > 1) {
          const qty = document.createElement('span');
          qty.className = 'qty';
          qty.textContent = String(stack.qty);
          cell.append(qty);
        }
        const tab = this.activeTab;
        cell.addEventListener('click', (event) => this.onBagClick(player, i, event.shiftKey, tab));
      }

      grid.append(cell);
    }

    scroller.append(grid);
    // Restore the previous scroll position for this tab once it is laid out.
    scroller.addEventListener('scroll', () => {
      this.scrollByTab[this.activeTab] = scroller.scrollTop;
    });
    this.bagHost.append(scroller);
    requestAnimationFrame(() => {
      scroller.scrollTop = this.scrollByTab[this.activeTab];
    });
  }

  private onBagClick(player: Player, index: number, drop: boolean, tab: BagTab = 'main'): void {
    const stack = player.inventory.slots(tab)[index];
    if (!stack) return;
    const def = item(stack.itemId);

    if (drop) {
      player.inventory.removeAtBagIndex(index, stack.qty, tab);
      // Also clear it off the hotbar so no dead reference is left behind.
      player.inventory.hotbar.forEach((id, slot) => {
        if (id === def.id) player.inventory.assignToHotbar(slot, null);
      });
      this.refresh();
      return;
    }

    if (def.kind === 'weapon' || def.kind === 'shield' || def.kind === 'armor') {
      player.inventory.equip(def.id);
      player.syncEquipmentDerived();
      // Weapons also want a hotbar home so they can be re-drawn quickly.
      if (def.kind === 'weapon' && !player.inventory.hotbar.includes(def.id)) {
        player.inventory.assignToHotbar(player.inventory.selected, def.id);
      }
    } else {
      player.inventory.assignToHotbar(player.inventory.selected, def.id);
    }
    this.refresh();
  }
}

function heading(text: string): HTMLHeadingElement {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

function statRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'stat';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = value;
  row.append(a, b);
  return row;
}

function equipVerb(kind: string): string {
  switch (kind) {
    case 'weapon':
    case 'shield':
    case 'armor':
      return 'equip';
    default:
      return 'assign to selected hotbar slot';
  }
}
