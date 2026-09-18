import * as THREE from 'three';
import { blockDef } from '../world/blocks';
import { tryItem, type ItemDef } from '../combat/items';
import type { AttackMode } from '../combat/types';
import { Particles, POINT_SIZE_SCALE } from './Particles';
import {
  MODEL_MAT,
  blockModel,
  bowModel,
  buildToolModel,
  crossbowModel,
  firearmModel,
  fistModel,
  haftedModel,
  shieldModel,
  spellModel,
  swordModel,
  thrownModel,
  torchModel,
  type BowParts,
  type SpellParts,
  type TorchParts,
} from './models';

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

// ------------------------------------------------------------------ models
//
// Item geometry lives in ./models. It used to be assembled here out of
// axis-aligned boxes to match the voxel world, which made every weapon read as a
// stack of bricks. Items are now free low-poly shapes with no grid restriction.

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
const REST_MAIN = new THREE.Vector3(0.30, -0.30, -0.52);
const REST_OFFHAND = new THREE.Vector3(-0.34, -0.34, -0.48);
/**
 * Scales the whole rig without changing any individual mesh.
 *
 * Raised from 0.82: held items looked correctly proportioned when inspected in
 * isolation and too small in the actual viewport, which is the usual way round for
 * a first-person model. A weapon has to have real presence at the bottom of the
 * screen to feel like you are holding it.
 */
const HAND_SCALE = 0.95;
/** Off-hand items sit slightly closer, so they need a little less scale. */
const OFFHAND_SCALE = 1.0;
/**
 * The torch model is chunky in its own right — haft, bound head, and flame come to
 * roughly 0.65 units — so it needs scaling *down* here, not up.
 *
 * At 0.52 units from a camera this wide the visible frame is only about 0.65 units
 * tall, so an unscaled torch is taller than the screen; the first attempt at
 * "bigger" did exactly that and blotted out the middle of the view. This lands it
 * at roughly twice the old torch's size while still leaving somewhere to look.
 */
const TORCH_SCALE = 0.6;
/** Roughly where a blade's point sits, in the hand's local space. */
const TIP_LOCAL = new THREE.Vector3(0, 0, -0.78);
/** The direction a weapon points in its own space. Blades run along -Z. */
const BLADE_AXIS = new THREE.Vector3(0, 0, -1);
/** Half-angle of the swing arc, in radians. Wide enough to cross the whole view. */
/**
 * Swing geometry, cut to Skyrim's one-handed rhythm.
 *
 * What distinguishes a Skyrim slash from the generic screen-space sweep this
 * replaced is that the *arm* commits, not just the wrist. The sequence is:
 *
 *  1. The weapon hauls back behind the shoulder — out and away from the screen,
 *     partly leaving frame — which is the telegraph.
 *  2. It drives across the view at roughly chest height *and forward*, so the blade
 *     travels towards what it is hitting rather than merely rotating in place. The
 *     cut is flatter than a diagonal slash, with a modest downward cant.
 *  3. It over-travels past the far side, then drifts back to a low, central guard
 *     rather than snapping straight back to the carry pose.
 *
 * Consecutive attacks still alternate sides, as Skyrim's do.
 *
 * Two earlier attempts are worth remembering. A circular screen-space path sent the
 * blade off the edge of the view. A pure horizontal yaw sweep read as the weapon
 * being waved, because rotation alone never moves the blade towards the target.
 */
/** How far the weapon hauls back before the cut. */
const SWING_WINDBACK = 0.42;
/** Total yaw travel, about 75 degrees: across the view and past the far side. */
const SWING_ARC = 1.3;
/** Pitch cocked up before the cut, and the downward cant carried through it. */
const SWING_PITCH_RISE = 0.26;
const SWING_PITCH_DROP = 0.54;
/** Roll travel, which keeps the edge leading through the arc. */
const SWING_ROLL = 0.44;
/** Screen-space travel of the hand across and down the view. */
const SWING_RISE_Y = 0.1;
const SWING_DROP_Y = 0.13;
const SWING_CROSS_X = 0.46;
/**
 * How far the hand drives forward through the cut.
 *
 * This is the part that makes it read as a swing rather than a wave: the arm
 * extends into the strike and pulls back out of it.
 */
const SWING_REACH = 0.2;
/** Where the hand settles after the cut, before easing back to carry. */
const SWING_GUARD_Y = -0.05;
/** Share of the recovery window spent cutting, with the rest settling to guard. */
const SWING_SWEEP_FRACTION = 0.42;
/** How far a thrust pulls the hand in towards screen centre. */
const THRUST_CENTRING = 0.72;

/** Stepped ember palette, matching the world's torches. */
const EMBER_COLORS = [0xfff0c0, 0xffc050, 0xff8a28, 0xd8541a] as const;
/**
 * On-screen size of a torch ember, in pixels.
 *
 * Specified in pixels rather than world units on purpose. The flame is about half
 * a unit from the camera, where an eyeballed world size is wildly wrong: the first
 * attempt filled the screen with 14px slabs, and correcting it by distance alone
 * overshot into 4px specks. `POINT_SIZE_SCALE` inverts the shader's perspective
 * divide so the intended size is what actually lands.
 */
const EMBER_PIXELS = 7;

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

  /**
   * Embers for the held torch, in the view model's *own* scene.
   *
   * Deliberately not the world particle system. The view model renders through its
   * own narrower camera, so a point shared between the two spaces projects to two
   * different places on screen — which is exactly why the torch's sparks used to
   * drift away from the flame that was supposedly throwing them. Keeping the
   * effect in the same scene as the flame makes the two agree by construction.
   */
  private readonly embers = new Particles();
  private emberTimer = 0;
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpTip = new THREE.Vector3();
  private readonly tmpTarget = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpAim = new THREE.Quaternion();
  private readonly tmpPose = new THREE.Quaternion();

  private walkClock = 0;
  private mineClock = 0;
  private idleClock = 0;
  /**
   * Which diagonal the next slash cuts along: +1 from the upper right down to the
   * lower left, -1 the mirror image.
   *
   * Strictly alternating, not randomised. This used to flip on a 62% coin toss to
   * avoid a mechanical rhythm, but the two diagonals are only read as an X if they
   * reliably follow one another — a random repeat of the same cut breaks the shape.
   */
  private swingDirection = 1;
  /**
   * The diagonal each recent slash cut along, most recent last.
   *
   * Recorded rather than inferred. A test can only tell which way a slash went by
   * catching it mid-animation, and sampling the "most extreme" pose picks whichever
   * frame happened to land — which reported two swings as travelling the same way
   * when they had not. The history makes the alternation checkable after the fact.
   */
  private swingHistory: number[] = [];
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
    this.offHand.scale.setScalar(OFFHAND_SCALE);
    this.torchHand.scale.setScalar(OFFHAND_SCALE);
    this.scene.add(this.ambient, this.keyLight, this.mainHand, this.offHand, this.torchHand, this.embers.points);
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
      group = blockModel(new THREE.Color(c[0], c[1], c[2]));
      rest.rotation.set(-0.2, 0.5, 0.1);
    } else if (def.kind === 'spell' && def.spell) {
      const color = def.spell.type === 'fire' ? 0xff7a30 : def.spell.kind === 'heal' ? 0x7ce890 : 0xa870ff;
      spell = spellModel(color);
      group = spell.group;
      rest.rotation.set(-0.25, 0, 0);
    } else if (def.kind === 'torch') {
      torch = torchModel(TORCH_SCALE);
      group = torch.group;
      // Carried near-upright and canted outwards, so the flame sits clear of both
      // the hand and the shield behind it.
      rest.rotation.set(-0.2, 0.12, 0.2);
    } else if (def.kind === 'shield') {
      // Bucklers are round and small; kite and tower shields are cover you hide
      // behind, and have to be big enough on screen to read that way.
      const shape = def.id === 'wooden_buckler' ? 'buckler' : def.id === 'tower_shield' ? 'tower' : 'kite';
      const size = def.id === 'tower_shield' ? 1.25 : def.id === 'iron_kite_shield' ? 1.2 : 1.1;
      group = shieldModel(shape, size);
      rest.rotation.set(0.04, 0.34, 0.06);
    } else if (def.kind === 'tool') {
      group = buildToolModel();
      rest.rotation.set(-0.05, 0.2, 0.05);
    } else if (def.kind === 'consumable' || def.kind === 'ammo' || def.kind === 'armor') {
      group = blockModel(0xa08050);
      rest.rotation.set(-0.2, 0.4, 0);
    } else if (def.weapon) {
      const weapon = def.weapon;
      bulky = weapon.twoHanded;

      switch (weapon.class) {
        case 'bow':
          bow = bowModel();
          group = bow.group;
          rest.rotation.set(0, -0.55, 0.14);
          break;
        case 'crossbow':
          group = crossbowModel();
          rest.rotation.set(-0.04, 0.16, 0.03);
          break;
        case 'firearm':
          group = firearmModel(def.id !== 'flintlock_pistol');
          rest.rotation.set(-0.03, 0.18, 0.04);
          break;
        case 'thrown':
          group = thrownModel();
          rest.rotation.set(-0.2, 0, 0);
          break;
        default: {
          // Melee: the silhouette follows the weapon's available attack modes.
          const id = def.id;
          if (id === 'mace') group = haftedModel(0.56, 'mace');
          else if (id === 'warhammer') group = haftedModel(0.72, 'hammer');
          else if (id === 'battleaxe') group = haftedModel(0.66, 'axe');
          else if (id === 'spear') group = haftedModel(0.95, 'spear');
          else if (id === 'halberd') group = haftedModel(0.9, 'halberd');
          else if (id === 'dagger') {
            group = swordModel({ bladeLength: 0.24, bladeWidth: 0.05, guardSpan: 0.07, gripLength: 0.09 });
          } else if (id === 'rapier') {
            // Almost no taper and a square section: all point, no cutting edge.
            group = swordModel({
              bladeLength: 0.74,
              bladeWidth: 0.032,
              guardSpan: 0.12,
              thickness: 0.8,
              taper: 0.85,
              fittingMaterial: MODEL_MAT.darkIron,
            });
          } else if (id === 'longsword') {
            group = swordModel({ bladeLength: 0.76, bladeWidth: 0.085, guardSpan: 0.17, gripLength: 0.16 });
          } else if (id === 'fists') {
            group = fistModel();
          } else {
            group = swordModel({ bladeLength: 0.56, bladeWidth: 0.07, guardSpan: 0.13 });
          }
          // Angled across the screen with the tip raised. A weapon pointing
          // straight down the view axis is invisible in first person — you only
          // ever see its pommel — so the rest pose has to both yaw it out of the
          // line of sight and pitch the tip up. Note the sign: the blade runs
          // along -Z, and rotating that about +X by `a` gives (0, sin a, -cos a),
          // so a *positive* pitch is what lifts the point.
          rest.rotation.set(0.42, 0.52, 0.16);
          break;
        }
      }
    } else {
      group = fistModel();
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

    // A new wind-up means a new attack: cut along the other diagonal.
    if (input.phase === 'windup' && this.lastSwingPhase !== 'windup') {
      this.swingDirection = -this.swingDirection;
      this.swingHistory.push(this.swingDirection);
      if (this.swingHistory.length > 8) this.swingHistory.shift();
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

    // After posing, so embers spawn from where the flame actually ended up rather
    // than from where it was last frame.
    this.torchHand.updateMatrixWorld(true);
    this.emitTorchEmbers(dt);
    this.embers.update(dt);

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
    /** 0 = pose as composed, 1 = blade aimed at the crosshair. Set by the thrust. */
    let thrustAim = 0;

    // Walk bob and idle breathing.
    const moveFactor = Math.min(1, input.speed / 5);
    ox += Math.cos(this.walkClock) * 0.016 * moveFactor;
    oy += Math.abs(Math.sin(this.walkClock)) * -0.02 * moveFactor;
    oy += Math.sin(this.idleClock * 1.4) * 0.005;
    rz += Math.sin(this.walkClock) * 0.03 * moveFactor;

    switch (input.action) {
      case 'swing': {
        // `side` is +1 for a cut travelling right-to-left, -1 for the backhand;
        // consecutive attacks alternate, as Skyrim's do.
        //
        // The pivot is the hand group's own origin, which sits at the grip, so the
        // weapon rotates about the wrist rather than about its own centre.
        //
        // The cut and the settle occupy the recovery window, where the visible
        // motion belongs; the haul-back rides the tail of the wind-up so the blade
        // is already travelling when the damage lands.
        const side = this.swingDirection;

        if (input.phase === 'windup') {
          // Haul back behind the shoulder: out to the side, up a little, and back
          // towards the camera so the weapon partly leaves frame. Late, because
          // anticipation only reads if it happens just before the strike.
          const w = easeIn(Math.max(0, (input.progress - 0.45) / 0.55));
          ry += w * SWING_WINDBACK * side;
          rx += w * SWING_PITCH_RISE;
          rz += w * SWING_ROLL * side;
          ox += w * SWING_CROSS_X * 0.42 * side;
          oy += w * SWING_RISE_Y;
          // Positive Z is towards the camera: the weapon is being cocked back.
          oz += w * SWING_REACH * 0.55;
          break;
        }

        if (input.progress < SWING_SWEEP_FRACTION) {
          // The cut. Fast, flat-ish, and driving forward — the arm extends into the
          // strike instead of the wrist merely rotating.
          const t = easeOut(input.progress / SWING_SWEEP_FRACTION);
          ry += (SWING_WINDBACK - (SWING_WINDBACK + SWING_ARC) * t) * side;
          rx += SWING_PITCH_RISE - SWING_PITCH_DROP * t;
          rz += (SWING_ROLL - SWING_ROLL * 2 * t) * side;
          ox += (SWING_CROSS_X * 0.42 - SWING_CROSS_X * 1.42 * t) * side;
          oy += SWING_RISE_Y - (SWING_RISE_Y + SWING_DROP_Y) * t;
          // Cocked back, thrown forward past the carry position, then easing off as
          // the arm reaches the end of its travel.
          oz += SWING_REACH * 0.55 - SWING_REACH * 1.55 * Math.sin(t * 1.9);
        } else {
          // The settle: having over-travelled, the weapon comes back to a low
          // central guard rather than snapping straight to the carry pose.
          const t = easeInOut((input.progress - SWING_SWEEP_FRACTION) / (1 - SWING_SWEEP_FRACTION));
          const settle = 1 - t;
          ry += -SWING_ARC * side * settle;
          rx += (SWING_PITCH_RISE - SWING_PITCH_DROP) * settle;
          rz += -SWING_ROLL * side * settle;
          ox += -SWING_CROSS_X * side * settle;
          // A hold at the end of the follow-through, which is what stops the
          // recovery looking like the cut played backwards.
          oy += (SWING_GUARD_Y - SWING_DROP_Y) * settle;
          oz += -SWING_REACH * 0.25 * settle;
        }
        break;
      }
      case 'thrust': {
        // Straight at the crosshair.
        //
        // The angles are not hand-tuned. Earlier versions cancelled fractions of
        // the resting rotation and pulled the hand part-way towards screen centre,
        // which got the tip *close* to the crosshair and left it visibly low and to
        // one side — a residual you cannot fix by nudging constants, because the
        // error depends on the hand's position, the blade's length and the camera's
        // field of view all at once.
        //
        // Instead the blade is aimed: `thrustAim` below solves for the rotation
        // that puts the tip on the view axis from wherever the hand actually is, so
        // it converges on the crosshair by construction. See `aimAt`.
        const extension =
          input.phase === 'windup'
            ? -0.2 * easeOut(input.progress)
            : input.progress < 0.3
              ? // Snap out fast...
                -0.2 + easeOut(input.progress / 0.3) * 0.92
              : // ...then draw back more slowly.
                0.72 * (1 - easeInOut((input.progress - 0.3) / 0.7));

        // Only aim while actually extending forward.
        thrustAim = Math.max(0, extension) / 0.72;
        // Draw the hand in towards centre as it extends, so the whole weapon — not
        // just its point — reads as committed down the line of attack.
        ox -= px * THRUST_CENTRING * thrustAim;
        oy += (-0.05 - py) * 0.3 * thrustAim;
        oz -= extension;
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

    // Note: the thrust is applied as a view-space offset in the pose above rather
    // than as a translation along the weapon's local axis. Moving along the local
    // axis is more physically honest, but with the weapon carried at an angle it
    // drives the point away from the crosshair — which is where the player is
    // actually aiming, and what they judge the attack against.

    // Aim the blade at the crosshair, blending in over the thrust's extension.
    if (thrustAim > 0) this.aimAt(this.mainHand, thrustAim);

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

  /**
   * Rotates a hand so the weapon it holds points its tip at the crosshair.
   *
   * The crosshair is the camera's -Z axis, so the target is any point along it.
   * Picking one a blade's length ahead of the hand keeps the weapon reaching
   * forward rather than swinging round to point across itself.
   *
   * Solving this beats tuning it. The offset between tip and crosshair depends on
   * where the hand sits, how long the blade is, and the camera's field of view; a
   * constant that lines them up for one weapon is wrong for the next. Aiming is
   * correct for all of them, and stays correct when any of those change.
   *
   * @param weight 0 leaves the composed pose alone, 1 aims fully
   */
  private aimAt(hand: THREE.Group, weight: number): void {
    const reach = TIP_LOCAL.length() * hand.scale.z;
    // A point on the view axis, `reach` further out than the hand already is.
    this.tmpTarget.set(0, 0, hand.position.z - reach);
    this.tmpForward.copy(this.tmpTarget).sub(hand.position);
    if (this.tmpForward.lengthSq() < 1e-8) return;
    this.tmpForward.normalize();

    this.tmpAim.setFromUnitVectors(BLADE_AXIS, this.tmpForward);
    this.tmpPose.setFromEuler(hand.rotation);
    this.tmpPose.slerp(this.tmpAim, THREE.MathUtils.clamp(weight, 0, 1));
    hand.quaternion.copy(this.tmpPose);
  }

  /**
   * Where the held weapon's tip lands on screen, in normalised device coordinates
   * relative to the crosshair. (0, 0) is dead centre; 1 is half the viewport.
   *
   * Exposed so "the thrust points at the crosshair" can be checked as a measured
   * offset rather than as a proxy like "the hand moved inwards", which was true
   * while the tip still sat visibly low and to the right.
   */
  tipScreenOffset(): { x: number; y: number } | null {
    if (!this.currentMain || !this.mainHand.visible) return null;
    this.mainHand.updateMatrixWorld(true);
    this.tmpTip.copy(TIP_LOCAL).applyMatrix4(this.mainHand.matrixWorld);
    // Behind the camera: no meaningful screen position.
    if (this.tmpTip.z > -0.001) return null;
    this.tmpTip.project(this.camera);
    return { x: this.tmpTip.x, y: this.tmpTip.y };
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

    // Sits out to the left and low, with the head up and clear of the shield.
    const shieldOffset = this.currentShield ? 0.06 : 0;
    const moveFactor = Math.min(1, input.speed / 5);
    const bob = Math.sin(this.walkClock * 0.9) * 0.02 * moveFactor;

    this.torchHand.position.set(
      REST_OFFHAND.x + 0.02 + this.sway.x * 0.5,
      REST_OFFHAND.y - 0.02 + shieldOffset + bob + this.sway.y * 0.5,
      REST_OFFHAND.z + 0.04,
    );
    this.torchHand.rotation.set(
      torch.rest.rotation.x + Math.sin(this.idleClock * 1.1) * 0.04,
      torch.rest.rotation.y,
      torch.rest.rotation.z + Math.sin(this.idleClock * 0.8) * 0.05,
    );

    if (!torch.torch) return;
    const parts = torch.torch;

    // Flame animation.
    //
    // Each layer is driven by its own pair of incommensurate sine terms, so the
    // fire never repeats visibly and the layers never move in lockstep — a single
    // shared flicker scaled uniformly just looks like the whole flame pulsing.
    for (let i = 0; i < parts.flameLayers.length; i++) {
      const layer = parts.flameLayers[i];
      const rate = 9 + i * 4.5;
      const wobble = Math.sin(this.idleClock * rate) * 0.5 + Math.sin(this.idleClock * (rate * 1.71) + i) * 0.5;
      const lean = Math.sin(this.idleClock * (rate * 0.6) + i * 2);
      // Stretch along the flame rather than uniformly: fire is tall and licks up.
      // The teardrops run along local Z, so that is the axis to stretch.
      layer.scale.set(0.92 + wobble * 0.1, 0.92 + wobble * 0.1, 1 + wobble * 0.24);
      // Lean the tongue, but only a little, and about the two axes across the
      // flame. Rotating about Y is a *tumble*, not a spin: the flame's long axis is
      // Z, so an accumulating Y rotation turned each layer end-over-end until they
      // stuck out sideways as separate petals instead of nesting.
      layer.rotation.x = wobble * 0.1;
      layer.rotation.y = lean * 0.08;
      // This one is a spin about the flame's own axis: free shimmer on the facets,
      // and invisible in silhouette because the teardrop is symmetric about it.
      layer.rotation.z += 0.05 + i * 0.03;
    }

    const flicker = 0.84 + Math.sin(this.idleClock * 11) * 0.1 + Math.sin(this.idleClock * 23.3) * 0.07;
    parts.light.intensity = 1.7 * flicker;
    parts.coals.scale.setScalar(0.94 + flicker * 0.1);
  }

  /** Sparks lifting off the held torch's flame. */
  private emitTorchEmbers(dt: number): void {
    const parts = this.currentTorch?.torch;
    if (!parts) return;

    this.emberTimer -= dt;
    if (this.emberTimer > 0) return;
    this.emberTimer = 0.03;

    const origin = parts.flameAnchor.getWorldPosition(this.tmpVec);
    // Distance from the view model camera, which sits at this scene's origin.
    const distance = Math.max(0.15, origin.length());

    for (let i = 0; i < 2; i++) {
      const pixels = EMBER_PIXELS + Math.random() * 3;
      this.embers.spawn(
        new THREE.Vector3(
          origin.x + (Math.random() - 0.5) * 0.035,
          origin.y + (Math.random() - 0.5) * 0.02,
          origin.z + (Math.random() - 0.5) * 0.035,
        ),
        // Small velocities: this scene is only about half a unit deep, so world
        // scale speeds would fling every spark off the screen instantly.
        new THREE.Vector3((Math.random() - 0.5) * 0.11, 0.2 + Math.random() * 0.17, (Math.random() - 0.5) * 0.11),
        {
          color: EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)],
          size: (pixels * distance) / POINT_SIZE_SCALE,
          life: 0.3 + Math.random() * 0.26,
          gravity: -0.4,
          drag: 1.1,
        },
      );
    }
  }

  /** Live ember count, for tests. */
  get emberCount(): number {
    return this.embers.count;
  }

  /** The diagonal each recent slash cut along, for tests. */
  get recentSwingDirections(): readonly number[] {
    return this.swingHistory;
  }

  /**
   * Position of the torch flame in the view model's scene, for placing the world
   * light that the held torch casts.
   *
   * Fine for a light, whose job is to illuminate geometry a few blocks away, but
   * *not* fine for anything that has to line up with the flame on screen: this
   * scene is viewed through a narrower camera than the world, so the same point
   * projects to two different pixels. Embers are emitted inside this scene instead
   * for exactly that reason.
   */
  get torchFlameLocalPosition(): THREE.Vector3 | null {
    if (!this.currentTorch?.torch) return null;
    return this.currentTorch.torch.flameAnchor.getWorldPosition(new THREE.Vector3());
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

function easeIn(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return c * c;
}

function easeOut(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c);
}

function easeInOut(t: number): number {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  return c < 0.5 ? 2 * c * c : 1 - 2 * (1 - c) * (1 - c);
}
