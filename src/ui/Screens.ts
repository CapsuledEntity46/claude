import { describeMode, item } from '../combat/items';
import { availableModes } from '../combat/types';
import { BAG_CAPACITY, type BagTab, type EquipSlot } from '../player/Inventory';
import type { Player } from '../player/Player';
import { ABILITY_INFO, ABILITY_KEYS, abilityModifier } from '../player/PointBuy';
import { ABILITY_MAX } from '../player/Stats';
import {
  BRANCH_INFO,
  SKILL_BRANCHES,
  blockOnPurchase,
  describeModifiers,
  nodesInBranch,
  pointsSpentOnSkills,
  rankOf,
  respecCost,
  totalSkillPoints,
  type SkillBranch,
} from '../player/Skills';
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
  private skillHost = el<HTMLElement>('sheet-skills');
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
    this.renderSkills(this.player);
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
      ['Gold', String(stats.gold)],
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

    this.statsHost.append(heading('Abilities'));
    if (stats.unspent > 0) {
      const note = document.createElement('div');
      note.className = 'points';
      note.textContent = `${stats.unspent} ability point${stats.unspent === 1 ? '' : 's'} available`;
      this.statsHost.append(note);
    }

    for (const key of ABILITY_KEYS) {
      const info = ABILITY_INFO[key];
      const score = stats.abilities[key];
      const mod = abilityModifier(score);
      const row = document.createElement('div');
      row.className = 'attr';
      row.title = info.blurb;

      const name = document.createElement('span');
      name.className = 'an';
      name.textContent = info.abbr;

      // Score and modifier together. The modifier is what the formulas actually
      // use, so hiding it would leave the player unable to tell why 13 and 12
      // play identically.
      const value = document.createElement('span');
      value.className = 'av';
      value.textContent = `${score} (${mod >= 0 ? '+' : ''}${mod})`;

      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = stats.unspent <= 0 || score >= ABILITY_MAX;
      if (score >= ABILITY_MAX) plus.title = `${info.name} is at the cap of ${ABILITY_MAX}`;
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

  // ---------------------------------------------------------------- skills

  /**
   * The four-branch skill tree, plus the respec button.
   *
   * Nodes are indented by tier so the prerequisite chain is visible without
   * drawing connectors, and a blocked node states its reason in the tooltip —
   * "needs Strength 14" is a goal, whereas a greyed-out button is a mystery.
   */
  private renderSkills(player: Player): void {
    const stats = player.stats;
    const available = totalSkillPoints(stats.level) - pointsSpentOnSkills(stats.skills);

    this.skillHost.replaceChildren();
    this.skillHost.append(heading('Skills'));

    const points = document.createElement('div');
    points.className = 'points';
    points.textContent = `${available} skill point${available === 1 ? '' : 's'} available`;
    this.skillHost.append(points);

    for (const branch of SKILL_BRANCHES) {
      this.skillHost.append(this.renderBranch(player, branch, available));
    }

    // What the whole build currently adds up to, so the player can see the tree's
    // effect without totalling tooltips by hand.
    const summary = describeModifiers(stats.skillModifiers);
    if (summary.length > 0) {
      const mods = document.createElement('div');
      mods.className = 'skill-mods';
      mods.textContent = summary.join(' · ');
      this.skillHost.append(mods);
    }

    const cost = respecCost(stats.level);
    const spent = pointsSpentOnSkills(stats.skills);
    const respec = document.createElement('button');
    respec.id = 'respec';
    respec.textContent = cost > 0 ? `Respec skills — ${cost} gold` : 'Respec skills — free';
    // Disabled with a reason rather than hidden: a player who cannot afford it
    // should still learn the price exists and what it is.
    respec.disabled = spent === 0 || stats.gold < cost;
    respec.title =
      spent === 0
        ? 'Nothing to refund yet.'
        : stats.gold < cost
          ? `You have ${stats.gold} of the ${cost} gold needed.`
          : `Refunds all ${spent} spent skill point${spent === 1 ? '' : 's'}. Abilities are not affected.`;
    respec.addEventListener('click', () => {
      if (!stats.respecSkills(cost)) return;
      player.syncEquipmentDerived();
      this.refresh();
    });
    this.skillHost.append(respec);
  }

  private renderBranch(player: Player, branch: SkillBranch, available: number): HTMLElement {
    const stats = player.stats;
    const info = BRANCH_INFO[branch];

    const wrap = document.createElement('div');
    wrap.className = 'skill-branch';

    const title = document.createElement('h3');
    title.textContent = info.name;
    const blurb = document.createElement('p');
    blurb.textContent = info.blurb;
    wrap.append(title, blurb);

    for (const node of nodesInBranch(branch)) {
      const rank = rankOf(stats.skills, node.id);
      const block = blockOnPurchase(stats.skills, node.id, stats.level, stats.abilities);

      const row = document.createElement('div');
      row.className = `skill-node skill-tier-${node.tier}`;
      if (node.tier > 1) row.classList.add('skill-tier');
      if (rank > 0) row.classList.add('owned');
      // "Maxed" and "cannot afford" are not the same as locked: a maxed node is a
      // success and a node you are saving up for is a plan, so neither is dimmed.
      if (block && block.kind !== 'maxed' && block.kind !== 'not-enough-points') row.classList.add('locked');

      const name = document.createElement('span');
      name.className = 'sn';
      name.textContent = node.name;

      const rankLabel = document.createElement('span');
      rankLabel.className = 'sr';
      rankLabel.textContent = `${rank}/${node.maxRank}`;

      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.disabled = block !== null;

      const reason = ((): string => {
        if (!block) return `${node.blurb} Costs ${node.cost} point${node.cost === 1 ? '' : 's'}.`;
        switch (block.kind) {
          case 'maxed':
            return `${node.name} is fully ranked. ${node.blurb}`;
          case 'requires-node':
            return `Requires ${block.node.name} first. ${node.blurb}`;
          case 'requires-ability':
            return `Requires ${ABILITY_INFO[block.ability].name} ${block.score}. ${node.blurb}`;
          case 'not-enough-points':
            return `Needs ${block.needed} skill point${block.needed === 1 ? '' : 's'}; you have ${block.available}.`;
          default:
            return node.blurb;
        }
      })();
      row.title = reason;
      plus.title = reason;

      plus.addEventListener('click', () => {
        if (!player.buySkill(node.id)) return;
        this.refresh();
      });

      row.append(name, rankLabel, plus);
      wrap.append(row);
    }

    void available;
    return wrap;
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

    // Spell out what the equipped weapon's shape allows — this is where the
    // swing/thrust rules are explained to the player.
    //
    // No longer a selection. The mouse gesture picks the stroke, so there is nothing
    // to mark as active and nothing to switch; what matters is which motions the
    // weapon can perform at all.
    const weapon = player.inventory.equippedDef('weapon');
    const weaponModes = availableModes(weapon?.weapon?.melee);
    if (weapon?.weapon && weaponModes.length > 0) {
      this.equipHost.append(heading('Attack Modes  (hold LMB and move the mouse)'));
      weaponModes.forEach((attack) => {
        const row = document.createElement('div');
        row.className = 'eq-slot';
        const left = document.createElement('div');
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
