import * as THREE from 'three';
import { blockDef } from '../world/blocks';
import { tryItem, type ItemDef } from '../combat/items';
import type { AttackMode } from '../combat/types';

/**
 * First-person view model: the weapon, torch, and shield you can actually see.
 *
 * Rendered in its own scene with the depth buffer cleared, so the held item is
 * never sliced open by a wall you are standing against. Meshes are built
 * procedurally from boxes, matching the world's art and keeping the game
 * asset-free.
 *
 * The animation is deliberately split into wind-up and strike phases mirroring
 * the combat timings, because that anticipation is the only cue telling the
 * player how long an attack commits them for. Swing sweeps a wide arc across the
 * screen; thrust drives straight down the centre with almost no rotation — so
 * the two modes are distinguishable at a glance rather than by reading the HUD.
 */

export type ViewAction = 'idle' | 'swing' | 'thrust' | 'mine' | 'place' | 'cast' | 'draw' | 'shoot' | 'reload';
export type ViewPhase = 'none' | 'windup' | 'recovery';

export interface ViewModelInput {
  action: ViewAction;
  phase: ViewPhase;
  /** 0..1 through the current phase. */
  progress: number;
  /** Bow draw strength, 0..1. */
  draw: number;
  blocking: boolean;
  mainItemId: string | null;
  shieldItemId: string | null;
  torchItemId: string | null;
  attackMode: AttackMode;
  /** Horizontal move speed, for walk sway. */
  speed: number;
  /** Monotonic counter; a change triggers a recoil kick. */
  shotCounter: number;
  /** 0..1, dims the held item at night. */
  daylight: number;
  /** Look delta this frame, for weapon lag. */
  lookDx: number;
  lookDy: number;
}

// ------------------------------------------------------------------ materials

const MAT = {
  steel: new THREE.MeshLambertMaterial({ color: 0xdde4ee }),
  darkIron: new THREE.MeshLambertMaterial({ color: 0x6b7280 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x7a5a34 }),
  darkWood: new THREE.MeshLambertMaterial({ color: 0x46321e }),
  leather: new THREE.MeshLambertMaterial({ color: 0x6f4a30 }),
  gold: new THREE.MeshLambertMaterial({ color: 0xc9a227 }),
  skin: new THREE.MeshLambertMaterial({ color: 0xc99a72 }),
  cloth: new THREE.MeshLambertMaterial({ color: 0x8a6a4a }),
  flame: new THREE.MeshBasicMaterial({ color: 0xffb347 }),
  string: new THREE.LineBasicMaterial({ color: 0xded4c0 }),
};

function box(w: number, h: number, d: number, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

/** A fist wrapped around the grip, so items look held rather than floating. */
function hand(x = 0, y = 0, z = 0): THREE.Mesh {
  return box(0.062, 0.068, 0.085, MAT.skin, x, y, z);
}

// ------------------------------------------------------------------ item meshes

/**
 * Weapons are built pointing along -Z (away from the camera). That is the
 * natural orientation for a thrust, and swings simply rotate this rest pose.
 */
function bladeWeapon(bladeLength: number, bladeWidth: number, guard: number, tint: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(hand(0, 0, 0.02));
  g.add(box(0.035, 0.045, 0.13, MAT.darkWood, 0, 0, 0.04)); // grip
  g.add(box(0.028, 0.028, 0.03, MAT.gold, 0, 0, 0.11)); // pommel
  if (guard > 0) g.add(box(guard, 0.03, 0.035, MAT.gold, 0, 0, -0.04)); // crossguard
  g.add(box(bladeWidth, 0.022, bladeLength, tint, 0, 0, -0.06 - bladeLength / 2));
  // Tapered tip.
  g.add(box(bladeWidth * 0.45, 0.02, 0.07, tint, 0, 0, -0.06 - bladeLength - 0.03));
  return g;
}

function haftedWeapon(shaft: number, head: 'mace' | 'hammer' | 'axe' | 'spear' | 'halberd'): THREE.Group {
  const g = new THREE.Group();
  g.add(hand(0, 0, 0.02));
  g.add(box(0.038, 0.038, shaft, MAT.wood, 0, 0, 0.06 - shaft / 2));
  const tipZ = 0.06 - shaft;

  switch (head) {
    case 'mace':
      g.add(box(0.11, 0.11, 0.13, MAT.darkIron, 0, 0, tipZ - 0.04));
      // Flanges, so it reads as blunt rather than bladed.
      for (const [dx, dy] of [[0.07, 0], [-0.07, 0], [0, 0.07], [0, -0.07]] as const) {
        g.add(box(0.05, 0.05, 0.09, MAT.darkIron, dx, dy, tipZ - 0.04));
      }
      break;
    case 'hammer':
      g.add(box(0.19, 0.13, 0.15, MAT.darkIron, 0, 0, tipZ - 0.05));
      g.add(box(0.05, 0.05, 0.1, MAT.steel, 0, 0, tipZ - 0.16));
      break;
    case 'axe':
      g.add(box(0.03, 0.2, 0.19, MAT.steel, 0.02, 0.06, tipZ - 0.05));
      g.add(box(0.06, 0.09, 0.08, MAT.darkIron, 0, 0, tipZ - 0.03));
      break;
    case 'spear':
      g.add(box(0.05, 0.05, 0.16, MAT.steel, 0, 0, tipZ - 0.06));
      g.add(box(0.02, 0.02, 0.08, MAT.steel, 0, 0, tipZ - 0.17));
      break;
    case 'halberd':
      // Axe head and a forward spike: the shape that justifies both attack modes.
      g.add(box(0.03, 0.18, 0.15, MAT.steel, 0.03, 0.05, tipZ + 0.02));
      g.add(box(0.045, 0.045, 0.2, MAT.steel, 0, 0, tipZ - 0.08));
      g.add(box(0.02, 0.09, 0.05, MAT.darkIron, -0.03, -0.04, tipZ + 0.02));
      break;
  }
  return g;
}

interface BowParts {
  group: THREE.Group;
  string: THREE.Line;
  nock: THREE.Object3D;
  arrow: THREE.Mesh;
}

function bowMesh(): BowParts {
  const group = new THREE.Group();
  group.add(hand(0.02, -0.02, 0.02));

  // Limbs, angled to suggest a curve without a real spline.
  const upper = box(0.03, 0.34, 0.03, MAT.darkWood, 0, 0.19, 0);
  upper.rotation.x = 0.22;
  const lower = box(0.03, 0.34, 0.03, MAT.darkWood, 0, -0.19, 0);
  lower.rotation.x = -0.22;
  group.add(box(0.045, 0.12, 0.045, MAT.wood, 0, 0, 0), upper, lower);

  const nock = new THREE.Object3D();
  nock.position.set(0, 0, 0.02);
  group.add(nock);

  const stringGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.35, 0.04),
    new THREE.Vector3(0, 0, 0.04),
    new THREE.Vector3(0, -0.35, 0.04),
  ]);
  const string = new THREE.Line(stringGeometry, MAT.string);
  group.add(string);

  const arrow = box(0.016, 0.016, 0.6, MAT.wood, 0, 0, -0.2);
  group.add(arrow);

  return { group, string, nock, arrow };
}

function crossbowMesh(): THREE.Group {
  const g = new THREE.Group();
  g.add(hand(0, -0.04, 0.06));
  g.add(box(0.05, 0.055, 0.42, MAT.darkWood, 0, 0, -0.06)); // stock
  g.add(box(0.34, 0.028, 0.035, MAT.darkIron, 0, 0.015, -0.2)); // limbs
  g.add(box(0.02, 0.02, 0.34, MAT.steel, 0, 0.045, -0.12)); // bolt track
  g.add(box(0.03, 0.06, 0.03, MAT.darkIron, 0, -0.05, 0.02)); // trigger guard
  return g;
}

function firearmMesh(long: boolean): THREE.Group {
  const g = new THREE.Group();
  const barrelLength = long ? 0.62 : 0.3;
  g.add(hand(0, -0.03, 0.05));
  g.add(box(0.05, 0.07, 0.2, MAT.darkWood, 0, -0.01, 0.06)); // stock
  g.add(box(0.036, 0.036, barrelLength, MAT.darkIron, 0, 0.03, -barrelLength / 2 - 0.02)); // barrel
  g.add(box(0.045, 0.05, 0.07, MAT.steel, 0.02, 0.04, 0.0)); // lock plate
  g.add(box(0.02, 0.05, 0.02, MAT.gold, 0.03, 0.07, 0.01)); // hammer/cock
  if (long) g.add(box(0.03, 0.05, 0.12, MAT.darkWood, 0, -0.04, 0.16)); // butt
  return g;
}

interface TorchParts {
  group: THREE.Group;
  flame: THREE.Mesh;
  light: THREE.PointLight;
}

function torchMesh(): TorchParts {
  const group = new THREE.Group();
  group.add(hand(0, -0.02, 0.04));
  group.add(box(0.026, 0.026, 0.24, MAT.darkWood, 0, 0, -0.07));

  const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.037, 0), MAT.flame);
  flame.position.set(0, 0.012, -0.21);
  group.add(flame);

  // Lights the view model itself; the world light is separate.
  const light = new THREE.PointLight(0xffb055, 1.5, 3.2, 2);
  light.position.copy(flame.position);
  group.add(light);

  return { group, flame, light };
}

function shieldMesh(size: number): THREE.Group {
  const g = new THREE.Group();
  const w = 0.24 * size;
  const h = 0.3 * size;
  g.add(box(w, h, 0.04, MAT.darkWood, 0, 0, 0));
  g.add(box(w * 1.06, 0.045, 0.05, MAT.darkIron, 0, h * 0.4, 0));
  g.add(box(w * 1.06, 0.045, 0.05, MAT.darkIron, 0, -h * 0.4, 0));
  g.add(box(0.06, 0.06, 0.055, MAT.gold, 0, 0, -0.025)); // boss
  g.add(hand(0.015, -0.015, 0.05));
  return g;
}

function blockMesh(color: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), new THREE.MeshLambertMaterial({ color })));
  g.add(hand(-0.04, -0.11, 0.07));
  return g;
}

interface SpellParts {
  group: THREE.Group;
  orb: THREE.Mesh;
  light: THREE.PointLight;
}

function spellMesh(color: number): SpellParts {
  const group = new THREE.Group();
  // An open palm with the spell gathering above it.
  group.add(box(0.11, 0.05, 0.14, MAT.skin, 0, -0.06, 0.02));
  group.add(box(0.1, 0.06, 0.04, MAT.cloth, 0, -0.05, 0.1));

  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.075, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  orb.position.set(0, 0.02, -0.04);
  group.add(orb);

  const light = new THREE.PointLight(color, 1.2, 2.4, 2);
  light.position.copy(orb.position);
  group.add(light);

  return { group, orb, light };
}

function fistMesh(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.1, 0.11, 0.15, MAT.skin, 0, 0, 0));
  g.add(box(0.085, 0.09, 0.12, MAT.cloth, 0, -0.01, 0.12));
  return g;
}

// ------------------------------------------------------------------ view model

interface HeldVisual {
  group: THREE.Group;
  bow?: BowParts;
  spell?: SpellParts;
  torch?: TorchParts;
  /** Rest pose, applied before animation offsets. */
  rest: { position: THREE.Vector3; rotation: THREE.Euler };
  /** True for long two-handed things that need to sit lower and further out. */
  bulky: boolean;
}

/**
 * Where the hands sit in camera space.
 *
 * Pushed further out and scaled down from a first attempt that had the weapon
 * filling a quarter of the screen: at 0.46 units from a ~67 degree camera the
 * visible frame is only about 0.6 units tall, so anything hand-sized dominates
 * the view.
 */
const REST_MAIN = new THREE.Vector3(0.29, -0.24, -0.6);
const REST_OFFHAND = new THREE.Vector3(-0.36, -0.32, -0.56);
/** Shrinks the whole rig without changing any individual mesh. */
const HAND_SCALE = 0.82;
/** Roughly where a blade's point sits, in the hand's local space. */
const TIP_LOCAL = new THREE.Vector3(0, 0, -0.78);

export class ViewModel {
  /** Rendered separately, after the world, with depth cleared. */
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private mainHand = new THREE.Group();
  private offHand = new THREE.Group();
  private torchHand = new THREE.Group();

  private cache = new Map<string, HeldVisual>();
  private currentMain: HeldVisual | null = null;
  private currentShield: HeldVisual | null = null;
  private currentTorch: HeldVisual | null = null;
  private currentMainId: string | null = null;
  private currentShieldId: string | null = null;
  private currentTorchId: string | null = null;

  private ambient: THREE.AmbientLight;
  private keyLight: THREE.DirectionalLight;

  private walkClock = 0;
  private mineClock = 0;
  private idleClock = 0;
  /**
   * Which way the next horizontal swing travels: +1 for right-to-left, -1 for
   * left-to-right. Alternating (with a random start) stops repeated attacks from
   * looking like the same looping clip.
   */
  private swingDirection = 1;
  private lastSwingPhase: ViewPhase = 'none';
  private recoil = 0;
  private lastShotCounter = 0;
  private readonly sway = new THREE.Vector2();
  private readonly swayTarget = new THREE.Vector2();
  private blockAmount = 0;

  constructor(fov: number, aspect: number) {
    // A slightly narrower FOV than the world camera keeps the weapon from
    // stretching at the screen edges.
    this.camera = new THREE.PerspectiveCamera(fov * 0.86, aspect, 0.01, 8);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.keyLight = new THREE.DirectionalLight(0xf2f6ff, 1.0);
    this.keyLight.position.set(-0.4, 0.9, 0.6);

    this.mainHand.scale.setScalar(HAND_SCALE);
    this.offHand.scale.setScalar(HAND_SCALE);
    this.torchHand.scale.setScalar(HAND_SCALE);
    this.scene.add(this.ambient, this.keyLight, this.mainHand, this.offHand, this.torchHand);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- building

  /**
   * A built visual for an item, cached per *slot*.
   *
   * The cache key includes the slot because a THREE.Object3D can only have one
   * parent. Sharing one cached group between the main hand and the off hand made
   * each frame's `add()` silently detach it from the other hand, so an item that
   * was both held and equipped — a torch, most obviously — flickered in and out
   * and looked like it kept unequipping itself.
   */
  private visualFor(slot: 'main' | 'shield' | 'torch', itemId: string | null): HeldVisual | null {
    if (!itemId) return null;
    const key = `${slot}:${itemId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const def = tryItem(itemId);
    if (!def) return null;
    const visual = this.build(def);
    this.cache.set(key, visual);
    return visual;
  }

  private build(def: ItemDef): HeldVisual {
    const rest = {
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
    };
    let bulky = false;
    let group: THREE.Group;
    let bow: BowParts | undefined;
    let spell: SpellParts | undefined;
    let torch: TorchParts | undefined;

    if (def.kind === 'block' && def.block !== undefined) {
      const c = blockDef(def.block).side;
      group = blockMesh(new THREE.Color(c[0], c[1], c[2]));
      rest.rotation.set(-0.2, 0.5, 0.1);
    } else if (def.kind === 'spell' && def.spell) {
      const color = def.spell.type === 'fire' ? 0xff7a30 : def.spell.kind === 'heal' ? 0x7ce890 : 0xa870ff;
      spell = spellMesh(color);
      group = spell.group;
      rest.rotation.set(-0.25, 0, 0);
    } else if (def.kind === 'torch') {
      torch = torchMesh();
      group = torch.group;
      // Held near-upright so the flame sits clear of the hand.
      rest.rotation.set(1.02, 0.15, 0.18);
    } else if (def.kind === 'shield') {
      // Bucklers are small, tower shields are walls; reflect that on screen.
      const size = def.id === 'tower_shield' ? 1.45 : def.id === 'iron_kite_shield' ? 1.18 : 1;
      group = shieldMesh(size);
      rest.rotation.set(0.05, 0.42, 0.08);
    } else if (def.kind === 'tool') {
      // A boxy sidearm silhouette, so it reads as a device rather than a weapon.
      group = new THREE.Group();
      group.add(box(0.07, 0.09, 0.26, MAT.darkIron, 0, 0.01, -0.06));
      group.add(box(0.05, 0.05, 0.16, MAT.steel, 0, 0.05, -0.2));
      group.add(box(0.05, 0.1, 0.06, MAT.gold, 0, 0.09, -0.02));
      group.add(box(0.05, 0.12, 0.06, MAT.darkWood, 0, -0.07, 0.05));
      group.add(hand(0, -0.05, 0.05));
      rest.rotation.set(-0.05, 0.2, 0.05);
    } else if (def.kind === 'consumable' || def.kind === 'ammo' || def.kind === 'armor') {
      group = blockMesh(0xa08050);
      rest.rotation.set(-0.2, 0.4, 0);
    } else if (def.weapon) {
      const weapon = def.weapon;
      bulky = weapon.twoHanded;

      switch (weapon.class) {
        case 'bow':
          bow = bowMesh();
          group = bow.group;
          rest.rotation.set(0, -0.55, 0.14);
          break;
        case 'crossbow':
          group = crossbowMesh();
          rest.rotation.set(-0.04, 0.16, 0.03);
          break;
        case 'firearm':
          group = firearmMesh(def.id !== 'flintlock_pistol');
          rest.rotation.set(-0.03, 0.18, 0.04);
          break;
        case 'thrown':
          group = new THREE.Group();
          group.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), MAT.darkIron));
          group.add(box(0.02, 0.06, 0.02, MAT.cloth, 0, 0.09, 0));
          group.add(hand(0, -0.06, 0.06));
          rest.rotation.set(-0.2, 0, 0);
          break;
        default: {
          // Melee: the silhouette follows the weapon's available attack modes.
          const id = def.id;
          if (id === 'mace') group = haftedWeapon(0.56, 'mace');
          else if (id === 'warhammer') group = haftedWeapon(0.72, 'hammer');
          else if (id === 'battleaxe') group = haftedWeapon(0.66, 'axe');
          else if (id === 'spear') group = haftedWeapon(0.95, 'spear');
          else if (id === 'halberd') group = haftedWeapon(0.9, 'halberd');
          else if (id === 'dagger') group = bladeWeapon(0.22, 0.035, 0.1, MAT.steel);
          else if (id === 'rapier') group = bladeWeapon(0.7, 0.026, 0.17, MAT.steel);
          else if (id === 'longsword') group = bladeWeapon(0.72, 0.062, 0.22, MAT.steel);
          else if (id === 'fists') group = fistMesh();
          else group = bladeWeapon(0.52, 0.05, 0.17, MAT.steel);
          // Angled across the screen with the tip raised. A weapon pointing
          // straight down the view axis is invisible in first person — you only
          // ever see its pommel — so the rest pose has to both yaw it out of the
          // line of sight and pitch the tip up. Note the sign: the blade runs
          // along -Z, and rotating that about +X by `a` gives (0, sin a, -cos a),
          // so a *positive* pitch is what lifts the point.
          rest.rotation.set(0.46, 0.6, 0.1);
          break;
        }
      }
    } else {
      group = fistMesh();
    }

    return { group, bow, spell, torch, rest, bulky };
  }

  // ---------------------------------------------------------------- update

  update(dt: number, input: ViewModelInput): void {
    this.swapHeld(input);

    this.idleClock += dt;
    this.walkClock += dt * (4 + input.speed * 1.7);
    if (input.action === 'mine') this.mineClock += dt * 9;

    // Weapon lag: the held item trails the camera when you turn.
    this.swayTarget.set(
      THREE.MathUtils.clamp(-input.lookDx * 0.0016, -0.09, 0.09),
      THREE.MathUtils.clamp(-input.lookDy * 0.0016, -0.07, 0.07),
    );
    this.sway.lerp(this.swayTarget, Math.min(1, dt * 9));

    // A new wind-up means a new attack: pick the other side, with a coin flip so
    // it never settles into a strict left-right-left rhythm.
    if (input.phase === 'windup' && this.lastSwingPhase !== 'windup') {
      this.swingDirection = Math.random() < 0.62 ? -this.swingDirection : this.swingDirection;
    }
    this.lastSwingPhase = input.phase;

    if (input.shotCounter !== this.lastShotCounter) {
      this.lastShotCounter = input.shotCounter;
      this.recoil = 1;
    }
    this.recoil = Math.max(0, this.recoil - dt * 5.5);

    // Shields ease up and down rather than snapping.
    const blockTarget = input.blocking ? 1 : 0;
    this.blockAmount += (blockTarget - this.blockAmount) * Math.min(1, dt * 12);

    this.poseMainHand(input);
    this.poseOffHand();
    this.poseTorchHand(input);

    // Held items dim at night unless a torch is lighting them.
    const lit = Math.max(input.daylight, this.currentTorch ? 0.85 : 0);
    this.ambient.intensity = 0.28 + lit * 0.5;
    this.keyLight.intensity = 0.35 + lit * 0.75;
  }

  private swapHeld(input: ViewModelInput): void {
    // When the torch is the item in your hand, do not also draw one in the off
    // hand — you are holding the same torch.
    const torchId = input.torchItemId === input.mainItemId ? null : input.torchItemId;
    const shieldId = input.shieldItemId === input.mainItemId ? null : input.shieldItemId;

    if (input.mainItemId !== this.currentMainId) {
      if (this.currentMain) this.mainHand.remove(this.currentMain.group);
      this.currentMainId = input.mainItemId;
      this.currentMain = this.visualFor('main', input.mainItemId);
      if (this.currentMain) this.mainHand.add(this.currentMain.group);
    }

    if (shieldId !== this.currentShieldId) {
      if (this.currentShield) this.offHand.remove(this.currentShield.group);
      this.currentShieldId = shieldId;
      this.currentShield = this.visualFor('shield', shieldId);
      if (this.currentShield) this.offHand.add(this.currentShield.group);
    }

    if (torchId !== this.currentTorchId) {
      if (this.currentTorch) this.torchHand.remove(this.currentTorch.group);
      this.currentTorchId = torchId;
      this.currentTorch = this.visualFor('torch', torchId);
      if (this.currentTorch) this.torchHand.add(this.currentTorch.group);
    }
  }

  private poseMainHand(input: ViewModelInput): void {
    const held = this.currentMain;
    this.mainHand.visible = !!held;
    if (!held) return;

    const rest = held.rest;
    const px = REST_MAIN.x + (held.bulky ? 0.04 : 0);
    const py = REST_MAIN.y - (held.bulky ? 0.05 : 0);
    const pz = REST_MAIN.z - (held.bulky ? 0.06 : 0);

    let ox = 0;
    let oy = 0;
    let oz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;

    // Walk bob and idle breathing.
    const moveFactor = Math.min(1, input.speed / 5);
    ox += Math.cos(this.walkClock) * 0.016 * moveFactor;
    oy += Math.abs(Math.sin(this.walkClock)) * -0.02 * moveFactor;
    oy += Math.sin(this.idleClock * 1.4) * 0.005;
    rz += Math.sin(this.walkClock) * 0.03 * moveFactor;

    switch (input.action) {
      case 'swing': {
        // A horizontal cut: the weapon is cocked back to one side, then sweeps
        // across the screen through the target. Yaw carries the motion, so the
        // arc is wide and lateral rather than a vertical chop — which is what
        // makes it look capable of catching several enemies at once.
        const side = this.swingDirection;
        if (input.phase === 'windup') {
          const t = easeOut(input.progress);
          ry += t * 1.05 * side;
          ox += t * 0.16 * side;
          rz += t * 0.42 * side;
          rx += t * -0.22;
          oy += t * 0.07;
        } else {
          const t = easeOut(input.progress);
          // Travel a long way past centre so the follow-through is visible.
          ry += (1.05 - t * 2.15) * side;
          ox += (0.16 - t * 0.42) * side;
          rz += (0.42 - t * 0.95) * side;
          rx += -0.22 + t * 0.3;
          oy += 0.07 - t * 0.12;
        }
        break;
      }

      case 'thrust': {
        // A vertical thrust: raise the point overhead, then drive it straight
        // down the centre of the screen. Staying on the view axis is what keeps
        // it visually distinct from the lateral swing.
        if (input.phase === 'windup') {
          const t = easeOut(input.progress);
          oy += t * 0.2;
          oz += t * 0.14;
          ox += t * -0.12;
          rx += t * -0.75;
          ry += t * -0.34;
        } else {
          // Snap out in the first third, then draw back more slowly.
          const t = input.progress;
          const extend = t < 0.32 ? easeOut(t / 0.32) : 1 - easeInOut((t - 0.32) / 0.68);
          oy += 0.2 - extend * 0.36;
          oz += 0.14 - extend * 0.82;
          ox += -0.12 + extend * 0.06;
          rx += -0.75 + extend * 0.92;
          ry += -0.34 + extend * 0.28;
        }
        break;
      }

      case 'mine': {
        // Short repeated chops, angled down at the block.
        const chop = Math.abs(Math.sin(this.mineClock));
        rx += -0.3 - chop * 0.5;
        oz += chop * -0.1;
        oy += chop * -0.06;
        ox += 0.02;
        break;
      }

      case 'place': {
        const t = easeOut(input.progress);
        const nudge = Math.sin(t * Math.PI);
        oz += nudge * -0.16;
        oy += nudge * -0.08;
        rx += nudge * 0.3;
        break;
      }

      case 'cast': {
        // The hand rises and the gathering orb swells with the cast.
        const t = easeOut(input.progress);
        oy += t * 0.14;
        oz += t * -0.12;
        rx += t * -0.35;
        if (held.spell) {
          const scale = 0.55 + t * 0.95;
          held.spell.orb.scale.setScalar(scale);
          held.spell.orb.rotation.x += 0.06;
          held.spell.orb.rotation.y += 0.08;
          held.spell.light.intensity = 0.6 + t * 2.4;
        }
        break;
      }

      case 'draw': {
        // Bring the bow up to centre and pull the string.
        const d = input.draw;
        ox += -0.16 * d;
        oy += 0.06 * d;
        oz += 0.05 * d;
        ry += 0.4 * d;
        this.poseBowString(held, d);
        break;
      }

      case 'reload': {
        const t = input.progress;
        const crank = Math.sin(t * Math.PI * 3);
        oy += -0.12 - crank * 0.04;
        rx += 0.5 + crank * 0.18;
        rz += 0.25;
        break;
      }

      default: {
        if (held.bow) this.poseBowString(held, input.draw);
        if (held.spell) {
          held.spell.orb.scale.setScalar(0.55);
          held.spell.orb.rotation.y += 0.02;
          held.spell.light.intensity = 0.6;
        }
        break;
      }
    }

    // Firearm recoil, layered on top of whatever else is happening.
    if (this.recoil > 0) {
      const kick = easeOut(this.recoil);
      oz += kick * 0.16;
      oy += kick * 0.05;
      rx += kick * -0.38;
      rz += kick * 0.1;
    }

    // Blocking tucks the weapon in behind the shield.
    ox += this.blockAmount * -0.08;
    oy += this.blockAmount * -0.06;
    ry += this.blockAmount * 0.3;

    this.mainHand.position.set(px + ox + this.sway.x, py + oy + this.sway.y, pz + oz);
    this.mainHand.rotation.set(rest.rotation.x + rx, rest.rotation.y + ry, rest.rotation.z + rz);

    // In thrust mode the weapon is levelled along the line of attack; in swing
    // mode it is carried angled, so the stance reads before you even attack.
    if (input.action === 'idle' && this.currentMain?.group && !held.bow) {
      // Thrust stance levels the point down the line of attack; swing stance
      // carries the weapon raised and angled. Readable before you even click.
      const levelled = input.attackMode === 'thrust';
      this.mainHand.rotation.x += levelled ? 0.22 : -0.14;
      this.mainHand.rotation.y += levelled ? -0.34 : 0.05;
      this.mainHand.rotation.z += levelled ? -0.06 : -0.2;
    }
  }

  private poseBowString(held: HeldVisual, draw: number): void {
    if (!held.bow) return;
    const pull = draw * 0.26;
    const positions = held.bow.string.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(1, 0, 0, 0.04 + pull);
    positions.needsUpdate = true;
    held.bow.arrow.position.z = -0.2 + pull;
    held.bow.arrow.visible = draw > 0.02;
  }

  private poseOffHand(): void {
    this.offHand.visible = !!this.currentShield;
    if (!this.currentShield) return;
    const rest = this.currentShield.rest;
    const raise = this.blockAmount;

    // Raised: swings across to cover the centre of the screen.
    this.offHand.position.set(
      REST_OFFHAND.x + raise * 0.2 + this.sway.x * 0.6,
      REST_OFFHAND.y + raise * 0.24 + this.sway.y * 0.6,
      REST_OFFHAND.z + raise * -0.1,
    );
    this.offHand.rotation.set(
      rest.rotation.x + raise * -0.1,
      rest.rotation.y - raise * 0.42,
      rest.rotation.z + raise * -0.12,
    );
  }

  private poseTorchHand(input: ViewModelInput): void {
    this.torchHand.visible = !!this.currentTorch;
    const torch = this.currentTorch;
    if (!torch) return;

    // Sits above and behind the shield, so both are visible at once.
    // Sits just above the shield rim, not up at the horizon.
    const shieldOffset = this.currentShield ? 0.07 : 0;
    const moveFactor = Math.min(1, input.speed / 5);
    const bob = Math.sin(this.walkClock * 0.9) * 0.018 * moveFactor;

    this.torchHand.position.set(
      REST_OFFHAND.x + 0.05 + this.sway.x * 0.5,
      REST_OFFHAND.y + 0.03 + shieldOffset + bob + this.sway.y * 0.5,
      REST_OFFHAND.z + 0.04,
    );
    this.torchHand.rotation.set(
      torch.rest.rotation.x + Math.sin(this.idleClock * 1.1) * 0.04,
      torch.rest.rotation.y,
      torch.rest.rotation.z + Math.sin(this.idleClock * 0.8) * 0.05,
    );

    // Flicker, so the flame is never a static blob.
    if (torch.torch) {
      const flicker = 0.82 + Math.sin(this.idleClock * 11) * 0.1 + Math.sin(this.idleClock * 23.3) * 0.07;
      torch.torch.light.intensity = 1.35 * flicker;
      torch.torch.flame.scale.setScalar(0.85 + flicker * 0.3);
      torch.torch.flame.rotation.y += 0.08;
    }
  }

  /** World-space position of the torch flame, for placing the world light. */
  get torchFlameLocalPosition(): THREE.Vector3 | null {
    if (!this.currentTorch?.torch) return null;
    return this.currentTorch.torch.flame.getWorldPosition(new THREE.Vector3());
  }

  get hasTorch(): boolean {
    return !!this.currentTorch;
  }

  /**
   * World-space position of the held weapon's tip.
   *
   * The view model lives in camera space, so this transforms the tip out through
   * the camera matrix. Used to trace the swing trail along the path the weapon
   * visibly takes, instead of along a separately invented arc that would not
   * match the animation.
   */
  weaponTipWorldPosition(cameraMatrix: THREE.Matrix4): THREE.Vector3 | null {
    if (!this.currentMain) return null;
    // The blade runs along -Z from the grip; a metre out covers every weapon here.
    return TIP_LOCAL.clone().applyMatrix4(this.mainHand.matrixWorld).applyMatrix4(cameraMatrix);
  }

  /** Recomputes hand transforms so the tip position is current this frame. */
  refreshMatrices(): void {
    this.mainHand.updateMatrixWorld(true);
  }

  /**
   * The main hand's current transform. Exposed so tests can assert that a swing
   * and a thrust actually produce different poses, rather than trusting that the
   * animation code is wired up.
   */
  debugPose(): Record<string, number> {
    return {
      posX: Number(this.mainHand.position.x.toFixed(3)),
      posY: Number(this.mainHand.position.y.toFixed(3)),
      posZ: Number(this.mainHand.position.z.toFixed(3)),
      rotX: Number(this.mainHand.rotation.x.toFixed(3)),
      rotY: Number(this.mainHand.rotation.y.toFixed(3)),
      rotZ: Number(this.mainHand.rotation.z.toFixed(3)),
      visible: this.mainHand.visible ? 1 : 0,
    };
  }

  /**
   * Draws the view model over the finished world image. The depth buffer is
   * cleared first so the held item is never clipped by nearby geometry.
   */
  render(renderer: THREE.WebGLRenderer): void {
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }
}

function easeOut(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c);
}

function easeInOut(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return c < 0.5 ? 2 * c * c : 1 - 2 * (1 - c) * (1 - c);
}
