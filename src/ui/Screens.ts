import type { SoundId } from '../audio/Audio';
import { describeMode, item } from '../combat/items';
import { availableModes } from '../combat/types';
import { BAG_CAPACITY, type BagTab, type EquipSlot } from '../player/Inventory';
import type { Player } from '../player/Player';
import { ABILITY_INFO, ABILITY_KEYS, abilityModifier, type AbilityScores } from '../player/PointBuy';
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
import { applyGlyph, applyIcon, itemGlyph } from './glyphs';

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
  private hotbarHost = el<HTMLElement>('sheet-hotbar');
  private abilityHost = el<HTMLElement>('sheet-abilities');
  private gearPane = el<HTMLDivElement>('pane-gear');
  private skillsPane = el<HTMLDivElement>('pane-skills');
  private gearTab = el<HTMLButtonElement>('tab-gear');
  private skillsTab = el<HTMLButtonElement>('tab-skills');

  /** Which top-level tab is showing. Remembered across openings. */
  private pane: 'gear' | 'skills' = 'gear';

  /**
   * The bag slot being dragged, if any.
   *
   * Held here rather than in the drag event's dataTransfer because the drop
   * targets need the item's *kind* to decide whether they will accept it, and
   * reading dataTransfer during dragover is not permitted.
   */
  private dragging: { itemId: string; index: number; tab: BagTab } | null = null;
  private bagHost = el<HTMLElement>('sheet-bag');

  private player: Player | null = null;
  private onChange: () => void;
  /** Which bag tab is showing. Remembered across openings. */
  private activeTab: BagTab = 'main';
  /** Scroll offset per tab, so switching back does not jump to the top. */
  private scrollByTab: Record<BagTab, number> = { main: 0, tools: 0, materials: 0 };

  /**
   * Plays a UI sound.
   *
   * A callback rather than an `AudioEngine` reference, for the same reason the
   * sheet does not hold the `Game`: it is a DOM view, and the only thing it needs
   * from the audio system is permission to make a noise.
   */
  private sound: (id: SoundId) => void;

  constructor(onChange: () => void, sound: (id: SoundId) => void = () => {}) {
    this.onChange = onChange;
    this.sound = sound;
    el<HTMLButtonElement>('sheet-close').addEventListener('click', () => this.close());
    this.gearTab.addEventListener('click', () => {
      this.sound('uiSelect');
      this.showPane('gear');
    });
    this.skillsTab.addEventListener('click', () => {
      this.sound('uiSelect');
      this.showPane('skills');
    });
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
    this.renderHotbar(this.player);
    this.applyPane();
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

    // Abilities get their own column. Stacked under the stats they made the left
    // column taller than the viewport, so the cards and the radar — the part the
    // player actually interacts with — sat below the fold.
    this.abilityHost.replaceChildren();
    this.abilityHost.append(heading('Abilities'));
    this.abilityHost.append(abilityRadar(stats.abilities));
    if (stats.unspent > 0) {
      const note = document.createElement('div');
      note.className = 'points';
      note.textContent = `${stats.unspent} ability point${stats.unspent === 1 ? '' : 's'} available`;
      this.abilityHost.append(note);
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
          this.sound('uiSpend');
          player.syncEquipmentDerived();
          this.refresh();
        } else {
          this.sound('uiDeny');
        }
      });

      row.append(name, value, plus);
      this.abilityHost.append(row);
    }

    const slots = stats.maxSlots();
    this.abilityHost.append(heading('Spell Slots'));
    slots.forEach((count, i) => {
      if (count <= 0) {
        this.abilityHost.append(statRow(`Tier ${i + 1}`, i === 1 ? 'unlocks at level 4' : 'unlocks at level 8'));
        return;
      }
      this.abilityHost.append(statRow(`Tier ${i + 1}`, `${count - stats.slotsUsed[i]} / ${count}`));
    });
  }

  // ---------------------------------------------------------------- panes

  private showPane(pane: 'gear' | 'skills'): void {
    this.pane = pane;
    this.applyPane();
  }

  /**
   * Shows the active pane and lays out the tree.
   *
   * The connector geometry is measured from the DOM, and a hidden pane measures
   * as zero — so the branches have to be drawn *after* the pane is made visible,
   * not when its nodes were created.
   */
  private applyPane(): void {
    const skills = this.pane === 'skills';
    this.gearPane.classList.toggle('hidden', skills);
    this.skillsPane.classList.toggle('hidden', !skills);
    this.gearTab.classList.toggle('active', !skills);
    this.skillsTab.classList.toggle('active', skills);
    if (skills) requestAnimationFrame(() => this.layoutBranches());
  }

  /**
   * Draws the curved connectors between skill nodes.
   *
   * Real geometry rather than CSS borders: a tree drawn with straight rules reads
   * as a list with a line down the side. Each branch gets a trunk up its centre,
   * limbs curving out to the tier-1 nodes, and a bezier from every node to its
   * prerequisite — so the shape of the dependency graph is the shape on screen.
   *
   * Positions are measured after layout rather than computed from constants,
   * which means the curves stay attached when the panel is resized or the font
   * metrics differ.
   */
  private layoutBranches(attempt = 0): void {
    const svgNs = 'http://www.w3.org/2000/svg';
    const branches = Array.from(this.skillHost.querySelectorAll<HTMLElement>('.skill-branch'));

    // A pane that has just been unhidden may not be laid out yet, in which case
    // every branch measures zero and no connector can be placed. One animation
    // frame is usually enough, but not always — under load the first frame can
    // still see a zero-width panel, and the tree then renders permanently
    // unconnected. So detect it and try again rather than assuming.
    if (branches.length > 0 && branches[0].getBoundingClientRect().width < 2) {
      if (attempt < 8) requestAnimationFrame(() => this.layoutBranches(attempt + 1));
      return;
    }

    for (const branch of branches) {
      const canvas = branch.querySelector<SVGSVGElement>('.branch-canvas');
      if (!canvas) continue;
      const box = branch.getBoundingClientRect();
      if (box.width < 2) continue;
      canvas.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      canvas.replaceChildren();

      const centre = (node: Element): { x: number; y: number } => {
        const r = node.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      };

      const nodes = Array.from(branch.querySelectorAll<HTMLElement>('.skill-node'));
      const byId = new Map<string, HTMLElement>();
      for (const node of nodes) byId.set(node.dataset.skill ?? '', node);

      const line = (d: string, cls: string): void => {
        const path = document.createElementNS(svgNs, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', cls);
        canvas.append(path);
      };

      // A short root stub above the first row, which the tier-1 limbs spring
      // from. Deliberately not a full-height trunk: run a line from the top to
      // the deepest row and it passes straight through any centred disc, which
      // looked like a pole skewering the capstone.
      const tops = nodes.map((n) => centre(n));
      if (tops.length > 0) {
        const shallowest = Math.min(...tops.map((t) => t.y));
        const anyOwned = nodes.some((n) => n.classList.contains('owned'));
        line(
          `M ${box.width / 2} ${shallowest - 40} L ${box.width / 2} ${shallowest - 30}`,
          `trunk${anyOwned ? ' grown' : ''}`,
        );
      }

      for (const node of nodes) {
        const id = node.dataset.skill ?? '';
        const parentId = node.dataset.requires ?? '';
        const here = centre(node);
        const grown = node.classList.contains('owned') ? ' grown' : '';

        if (!parentId) {
          // A tier-1 node hangs off the trunk, so the limb starts at the centre
          // line a little above it and curves outward.
          const trunkX = box.width / 2;
          const startY = here.y - 30;
          // Leaves the root heading straight down, then sweeps out and drops into
          // the disc from above — the shape a real limb makes off a trunk.
          line(
            `M ${trunkX} ${startY} C ${trunkX} ${here.y - 12}, ${here.x} ${here.y - 30}, ${here.x} ${here.y}`,
            `limb${grown}`,
          );
          continue;
        }

        const parent = byId.get(parentId);
        if (!parent) continue;
        const from = centre(parent);
        // An S-curve: leaves the parent heading down, arrives at the child
        // heading down, bowing out sideways in between.
        const midY = (from.y + here.y) / 2;
        line(
          `M ${from.x} ${from.y} C ${from.x} ${midY}, ${here.x} ${midY}, ${here.x} ${here.y}`,
          `limb${node.classList.contains('owned') && parent.classList.contains('owned') ? ' grown' : ''}`,
        );
        void id;
      }
    }
  }

  // ---------------------------------------------------------------- skills

  /**
   * The four-branch skill tree, plus the respec button.
   *
   * Nodes are discs grouped into tier rows, with the prerequisite chain drawn as
   * curved limbs by `layoutBranches`. A blocked node states its reason in the
   * tooltip — "needs Strength 14" is a goal, whereas a dimmed disc is a mystery.
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

    const grove = document.createElement('div');
    grove.className = 'skill-grove';
    for (const branch of SKILL_BRANCHES) {
      grove.append(this.renderBranch(player, branch, available));
    }
    this.skillHost.append(grove);

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
      if (!stats.respecSkills(cost)) {
        this.sound('uiDeny');
        return;
      }
      this.sound('uiRespec');
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

    // The connector layer, filled in by layoutBranches once this is on screen.
    const canvas = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    canvas.setAttribute('class', 'branch-canvas');
    canvas.setAttribute('preserveAspectRatio', 'none');

    wrap.append(title, blurb, canvas);

    // Grouped into rows by tier, so depth in the tree is depth down the panel.
    const nodes = nodesInBranch(branch);
    const tiers = Array.from(new Set(nodes.map((n) => n.tier))).sort((a, b) => a - b);

    for (const tier of tiers) {
      const row = document.createElement('div');
      row.className = 'skill-tier-row';

      for (const node of nodes.filter((n) => n.tier === tier)) {
        const rank = rankOf(stats.skills, node.id);
        const block = blockOnPurchase(stats.skills, node.id, stats.level, stats.abilities);

        const disc = document.createElement('div');
        disc.className = 'skill-node';
        // The ids the connector pass walks to find parents and children.
        disc.dataset.skill = node.id;
        if (node.requires) disc.dataset.requires = node.requires;

        if (rank > 0) disc.classList.add('owned');
        if (rank >= node.maxRank) disc.classList.add('maxed');
        // Three states, not two. "Maxed" is a success and "saving up" is a plan,
        // so neither should look like the locked discs the player cannot use.
        if (block === null) disc.classList.add('available');
        else if (block.kind !== 'maxed' && block.kind !== 'not-enough-points') disc.classList.add('locked');

        const icon = document.createElement('span');
        applyIcon(icon, node.icon, node.name);

        // Kept for the tests and for screen readers; the disc shows the icon.
        const name = document.createElement('span');
        name.className = 'sn';
        name.textContent = node.name;

        const rankLabel = document.createElement('span');
        rankLabel.className = 'sr';
        rankLabel.textContent = `${rank}/${node.maxRank}`;

        const caption = document.createElement('span');
        caption.className = 'sl';
        caption.textContent = node.name;

        const reason = ((): string => {
          if (!block) return `${node.name}\n${node.blurb}\nCosts ${node.cost} point${node.cost === 1 ? '' : 's'}.`;
          switch (block.kind) {
            case 'maxed':
              return `${node.name} — fully ranked.\n${node.blurb}`;
            case 'requires-node':
              return `${node.name}\nRequires ${block.node.name} first.\n${node.blurb}`;
            case 'requires-ability':
              return `${node.name}\nRequires ${ABILITY_INFO[block.ability].name} ${block.score}.\n${node.blurb}`;
            case 'not-enough-points':
              return `${node.name}\nNeeds ${block.needed} skill point${block.needed === 1 ? '' : 's'}; you have ${block.available}.`;
            default:
              return node.blurb;
          }
        })();
        disc.title = reason;

        if (block === null) {
          // The whole disc is the button now, which is a much larger target than
          // the 20px "+" it replaces.
          disc.addEventListener('click', () => {
            if (!player.buySkill(node.id)) {
              this.sound('uiDeny');
              return;
            }
            this.sound('uiSpend');
            this.refresh();
          });
        }

        disc.append(icon, name, rankLabel);
        // The caption is a sibling in a fixed-width column rather than absolutely
        // positioned under the disc: positioned captions overlapped each other,
        // because two 76px labels do not fit in the 62px between two 50px discs.
        const cell = document.createElement('div');
        cell.className = 'skill-cell';
        cell.append(disc, caption);
        row.append(cell);
      }

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

      // Dropping onto the slot equips, which is the fast path the old flow
      // lacked: click the item, hope it went to the right place.
      this.makeDropTarget(
        row,
        (itemId) => this.acceptsInSlot(itemId, slot),
        (itemId) => {
          player.inventory.equip(itemId);
          if (item(itemId).kind === 'weapon' && !player.inventory.hotbar.includes(itemId)) {
            player.inventory.assignToHotbar(player.inventory.selected, itemId);
          }
          player.syncEquipmentDerived();
          this.refresh();
        },
      );

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

  // ------------------------------------------------------- drag and drop

  /**
   * Whether a dragged item can be dropped on an equipment slot.
   *
   * Checked on dragover so the slot can light up, which is why the dragged item
   * is held on the instance: `dataTransfer` cannot be read during dragover, only
   * on drop.
   */
  private acceptsInSlot(itemId: string, slot: EquipSlot): boolean {
    const def = item(itemId);
    if (slot === 'weapon') return def.kind === 'weapon';
    if (slot === 'shield') return def.kind === 'shield';
    if (slot === 'armor') return def.kind === 'armor';
    if (slot === 'torch') return def.kind === 'torch';
    return false;
  }

  /** Marks a bag cell as a drag source. */
  private makeDraggable(cell: HTMLElement, itemId: string, index: number, tab: BagTab): void {
    cell.draggable = true;
    cell.addEventListener('dragstart', (event) => {
      this.dragging = { itemId, index, tab };
      cell.classList.add('dragging');
      this.sound('uiSelect');
      // Some payload has to be set or Firefox refuses to start the drag at all.
      event.dataTransfer?.setData('text/plain', itemId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragend', () => {
      this.dragging = null;
      cell.classList.remove('dragging');
      // Clear any highlight left behind if the drag ended outside a target.
      for (const node of Array.from(this.root.querySelectorAll('.drop-ok, .drop-bad'))) {
        node.classList.remove('drop-ok', 'drop-bad');
      }
    });
  }

  /** Wires a drop target that accepts an item and runs `onDrop`. */
  private makeDropTarget(
    target: HTMLElement,
    accepts: (itemId: string) => boolean,
    onDrop: (itemId: string) => void,
  ): void {
    target.addEventListener('dragover', (event) => {
      const held = this.dragging;
      if (!held) return;
      const ok = accepts(held.itemId);
      // preventDefault is what actually permits the drop; without it the browser
      // treats the target as inert and the cursor stays a "no entry" sign.
      if (ok) event.preventDefault();
      target.classList.toggle('drop-ok', ok);
      target.classList.toggle('drop-bad', !ok);
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-ok', 'drop-bad'));
    target.addEventListener('drop', (event) => {
      event.preventDefault();
      target.classList.remove('drop-ok', 'drop-bad');
      const held = this.dragging;
      this.dragging = null;
      if (!held || !accepts(held.itemId)) {
        this.sound('uiDeny');
        return;
      }
      this.sound('uiEquip');
      onDrop(held.itemId);
    });
  }

  // ---------------------------------------------------------------- hotbar

  /**
   * The hotbar, repeated inside the sheet as a row of drop targets.
   *
   * It exists because assigning a slot used to be a round trip: leave the sheet,
   * scroll the hotbar to the slot you wanted, reopen the sheet, then click the
   * item. Showing the eight slots next to the bag turns that into one drag.
   */
  private renderHotbar(player: Player): void {
    this.hotbarHost.replaceChildren();
    this.hotbarHost.append(heading('Hotbar  (drag an item onto a slot)'));

    const strip = document.createElement('div');
    strip.className = 'hotbar-strip';

    player.inventory.hotbar.forEach((id, slot) => {
      const cell = document.createElement('div');
      cell.className = `hotbar-slot${slot === player.inventory.selected ? ' selected' : ''}`;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(slot + 1);
      cell.append(num);

      if (id) {
        const def = item(id);
        const glyph = document.createElement('span');
        applyGlyph(glyph, def);
        cell.append(glyph);
        const count = player.inventory.count(id);
        if (count > 1) {
          const qty = document.createElement('span');
          qty.className = 'qty';
          qty.textContent = String(count);
          cell.append(qty);
        }
        cell.title = `${def.name}\nClick to select this slot. Right-click to clear it.`;
      } else {
        cell.title = 'Empty slot. Drag an item here.';
      }

      cell.addEventListener('click', () => {
        this.sound('uiSelect');
        player.inventory.select(slot);
        player.syncEquipmentDerived();
        this.refresh();
      });
      // Right-click clears, so a slot can be freed without finding a replacement.
      cell.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.sound('uiDrop');
        player.inventory.assignToHotbar(slot, null);
        this.refresh();
      });

      // Anything with a hotbar use is droppable here.
      this.makeDropTarget(
        cell,
        (itemId) => {
          const def = item(itemId);
          return (
            def.kind === 'weapon' ||
            def.kind === 'spell' ||
            def.kind === 'block' ||
            def.kind === 'consumable' ||
            def.kind === 'torch'
          );
        },
        (itemId) => {
          player.inventory.assignToHotbar(slot, itemId);
          // Dropping a weapon on a slot means "I want to hold this", so select it
          // too — otherwise the player assigns it and then has to go and pick it.
          const def = item(itemId);
          if (def.kind === 'weapon') {
            player.inventory.equip(itemId);
            player.inventory.select(slot);
          }
          player.syncEquipmentDerived();
          this.refresh();
        },
      );

      strip.append(cell);
    });

    this.hotbarHost.append(strip);
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
        this.sound('uiSelect');
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
        // The id on the element, so a drop target or a test can identify the
        // item without parsing the tooltip — display names are not unique
        // enough for that: the Healing spell and the Healing Draught both
        // begin "Healing".
        cell.dataset.item = stack.itemId;
        applyGlyph(cell, def);
        cell.title = `${def.name}\n${def.blurb}\n\nDrag onto an equipment or hotbar slot\nClick: ${equipVerb(def.kind)}\nShift-click: drop`;
        if (stack.qty > 1) {
          const qty = document.createElement('span');
          qty.className = 'qty';
          qty.textContent = String(stack.qty);
          cell.append(qty);
        }
        const tab = this.activeTab;
        cell.addEventListener('click', (event) => this.onBagClick(player, i, event.shiftKey, tab));
        this.makeDraggable(cell, stack.itemId, i, tab);
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
      this.sound('uiDrop');
      player.inventory.removeAtBagIndex(index, stack.qty, tab);
      // Also clear it off the hotbar so no dead reference is left behind.
      player.inventory.hotbar.forEach((id, slot) => {
        if (id === def.id) player.inventory.assignToHotbar(slot, null);
      });
      this.refresh();
      return;
    }

    if (def.kind === 'weapon' || def.kind === 'shield' || def.kind === 'armor') {
      this.sound('uiEquip');
      player.inventory.equip(def.id);
      player.syncEquipmentDerived();
      // Weapons also want a hotbar home so they can be re-drawn quickly.
      if (def.kind === 'weapon' && !player.inventory.hotbar.includes(def.id)) {
        player.inventory.assignToHotbar(player.inventory.selected, def.id);
      }
    } else {
      this.sound('uiSelect');
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

/**
 * A radar chart of the five ability scores.
 *
 * Five numbers in a column tell you what you have; the polygon tells you what
 * *shape* your character is, which is the thing a player actually wants to see
 * when deciding where the next point goes. A pentagon because there are five
 * abilities — the axis count is derived from `ABILITY_KEYS`, so dropping or
 * adding an ability reshapes it rather than breaking it.
 *
 * Plain SVG rather than a canvas: it scales with the panel, needs no redraw on
 * resize, and the rings can be styled from the stylesheet with everything else.
 */
function abilityRadar(scores: Readonly<AbilityScores>): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const size = 240;
  const centre = size / 2;
  // Generous room for the labels outside the outer ring. At 34px the leftmost
  // label was clipped by the viewBox and "WIS 11" rendered as "S 11".
  const radius = centre - 52;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('id', 'ability-radar');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const axes = ABILITY_KEYS.length;
  // Scored against the 5e ceiling of 20, so the polygon fills the chart only at
  // a maximal character and a starting 8 reads as the small core it is.
  const scale = (score: number): number => Math.max(0.08, Math.min(1, score / 20));
  const point = (index: number, r: number): { x: number; y: number } => {
    // Start at the top and go clockwise, which is how the reference reads.
    const angle = -Math.PI / 2 + (index / axes) * Math.PI * 2;
    return { x: centre + Math.cos(angle) * r, y: centre + Math.sin(angle) * r };
  };
  const polygon = (points: { x: number; y: number }[], cls: string): SVGPolygonElement => {
    const node = document.createElementNS(ns, 'polygon');
    node.setAttribute('points', points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    node.setAttribute('class', cls);
    return node;
  };

  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    svg.append(polygon(ABILITY_KEYS.map((_, i) => point(i, radius * fraction)), 'ring'));
  }

  for (let i = 0; i < axes; i++) {
    const spoke = document.createElementNS(ns, 'line');
    const end = point(i, radius);
    spoke.setAttribute('x1', String(centre));
    spoke.setAttribute('y1', String(centre));
    spoke.setAttribute('x2', end.x.toFixed(1));
    spoke.setAttribute('y2', end.y.toFixed(1));
    spoke.setAttribute('class', 'spoke');
    svg.append(spoke);
  }

  const shapePoints = ABILITY_KEYS.map((key, i) => point(i, radius * scale(scores[key])));
  svg.append(polygon(shapePoints, 'shape'));

  for (const p of shapePoints) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', p.x.toFixed(1));
    dot.setAttribute('cy', p.y.toFixed(1));
    dot.setAttribute('r', '2.8');
    dot.setAttribute('class', 'dot');
    svg.append(dot);
  }

  ABILITY_KEYS.forEach((key, i) => {
    const at = point(i, radius + 20);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', at.x.toFixed(1));
    label.setAttribute('y', at.y.toFixed(1));
    // Anchored by which side of the centre the axis sits on, so labels never
    // overlap the outer ring.
    label.setAttribute('text-anchor', at.x > centre + 6 ? 'start' : at.x < centre - 6 ? 'end' : 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = `${ABILITY_INFO[key].abbr} ${scores[key]}`;
    svg.append(label);
  });

  return svg;
}
