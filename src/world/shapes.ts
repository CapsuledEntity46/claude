/**
 * Block shapes.
 *
 * Until now every block was a full cube, which is why a placed torch looked like
 * a glowing crate. A shape is a small list of axis-aligned boxes inside the unit
 * cube, used for both geometry and collision, plus a per-voxel `meta` byte
 * carrying orientation and state.
 *
 * The same machinery gives us stairs, slabs, panes, doors, fences, and roof
 * wedges — all of which are just different box lists.
 */

/**
 * The building kit.
 *
 * A voxel world does not have to be built out of voxels. Terrain is a grid because
 * that is the game, but a *structure* made only of full cubes can only ever be a
 * box with holes in it — so the pieces below are the architectural vocabulary:
 * walls thinner than a block, posts and beams to frame with, and plates for thin
 * floors and ceilings. Each is still one voxel's worth of space, which keeps
 * placement, collision and the mesher unchanged; what varies is the geometry
 * inside it.
 */
export type BlockShape =
  | 'cube'
  | 'slab'
  | 'stairs'
  | 'wedge'
  | 'pane'
  | 'torch'
  | 'door'
  | 'fence'
  /** A thin vertical panel against one face of the voxel. Partition walls. */
  | 'wall'
  /** A square column up the middle of the voxel. Pillars and corner posts. */
  | 'post'
  /** A horizontal bar across the voxel, at head height. Lintels and rafters. */
  | 'beam'
  /** A very thin floor or ceiling panel. Boarding, suspended ceilings. */
  | 'plate';

/** An axis-aligned box inside the unit cube, coordinates in [0, 1]. */
export interface ShapeBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

// ------------------------------------------------------------------ meta byte

/**
 * Per-voxel metadata layout:
 *   bits 0-1  horizontal facing (0 = -Z, 1 = +X, 2 = +Z, 3 = -X)
 *   bit  2    upper half (top slab, upside-down stairs)
 *   bit  3    open (doors)
 */
export const META_FACING_MASK = 0b11;
export const META_UPPER = 0b100;
export const META_OPEN = 0b1000;

export type Facing = 0 | 1 | 2 | 3;

export function metaFacing(meta: number): Facing {
  return (meta & META_FACING_MASK) as Facing;
}

export function metaIsUpper(meta: number): boolean {
  return (meta & META_UPPER) !== 0;
}

export function metaIsOpen(meta: number): boolean {
  return (meta & META_OPEN) !== 0;
}

export function makeMeta(facing: Facing, upper = false, open = false): number {
  return facing | (upper ? META_UPPER : 0) | (open ? META_OPEN : 0);
}

/** Facing derived from a yaw angle, snapped to the nearest cardinal direction. */
export function facingFromYaw(yaw: number): Facing {
  // The player's forward is (-sin yaw, 0, -cos yaw). Snap that to a quadrant.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 1 : 3;
  return fz > 0 ? 2 : 0;
}

/** Unit vector for a facing. */
export function facingVector(facing: Facing): readonly [number, number, number] {
  switch (facing) {
    case 1:
      return [1, 0, 0];
    case 2:
      return [0, 0, 1];
    case 3:
      return [-1, 0, 0];
    default:
      return [0, 0, -1];
  }
}

// ------------------------------------------------------------------ box helpers

const FULL_CUBE: readonly ShapeBox[] = [{ min: [0, 0, 0], max: [1, 1, 1] }];

function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): ShapeBox {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Rotates a box about the cube's vertical centre by a facing.
 * Facing 0 is the identity, so shapes are authored pointing towards -Z.
 */
function rotate(b: ShapeBox, facing: Facing): ShapeBox {
  if (facing === 0) return b;
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  switch (facing) {
    case 1: // 90 degrees: (x, z) -> (1 - z, x)
      return box(1 - z1, y0, x0, 1 - z0, y1, x1);
    case 2: // 180 degrees
      return box(1 - x1, y0, 1 - z1, 1 - x0, y1, 1 - z0);
    default: // 270 degrees
      return box(z0, y0, 1 - x1, z1, y1, 1 - x0);
  }
}

/** Mirrors a box vertically, for upside-down stairs and top slabs. */
function flipY(b: ShapeBox): ShapeBox {
  return box(b.min[0], 1 - b.max[1], b.min[2], b.max[0], 1 - b.min[1], b.max[2]);
}

// ------------------------------------------------------------------ shape tables

/** Authored facing -Z, lower half. */
const STAIRS_BASE: readonly ShapeBox[] = [
  box(0, 0, 0, 1, 0.5, 1), // bottom slab
  box(0, 0.5, 0, 1, 1, 0.5), // upper step towards -Z
];

/** A four-step ramp, which reads as a sloped roof at voxel scale. */
const WEDGE_BASE: readonly ShapeBox[] = [
  box(0, 0, 0, 1, 0.25, 1),
  box(0, 0.25, 0, 1, 0.5, 0.75),
  box(0, 0.5, 0, 1, 0.75, 0.5),
  box(0, 0.75, 0, 1, 1, 0.25),
];

const TORCH_BOXES: readonly ShapeBox[] = [
  box(0.44, 0, 0.44, 0.56, 0.58, 0.56), // shaft
  box(0.4, 0.58, 0.4, 0.6, 0.72, 0.6), // burning head
];

const FENCE_BOXES: readonly ShapeBox[] = [
  box(0.4, 0, 0.4, 0.6, 1, 0.6), // post
  box(0.44, 0.28, 0, 0.56, 0.44, 1), // lower rail
  box(0.44, 0.66, 0, 0.56, 0.82, 1), // upper rail
];

/** A pane sits in the middle of the block, on the axis it faces. */
const PANE_BASE: readonly ShapeBox[] = [box(0, 0, 0.44, 1, 1, 0.56)];

/** A door leaf: a thin full-height panel against one edge. */
const DOOR_CLOSED: readonly ShapeBox[] = [box(0, 0, 0, 1, 1, 0.18)];
/** Swung open: the same panel rotated onto the side wall. */
const DOOR_OPEN: readonly ShapeBox[] = [box(0, 0, 0, 0.18, 1, 1)];

/**
 * A partition wall: thicker than a pane, thinner than a block, flush to one face.
 *
 * Against the face rather than down the middle, unlike the pane. A wall is a
 * boundary, and a boundary that floats half a block inside the voxel leaves a lip
 * on both sides — you can see it where two walls meet at a corner, and you can
 * feel it, because the collision box does the same thing.
 */
const WALL_BASE: readonly ShapeBox[] = [box(0, 0, 0, 1, 1, 0.28)];

/** A pillar. Not orientable: a square column looks the same from every side. */
const POST_BOXES: readonly ShapeBox[] = [box(0.31, 0, 0.31, 0.69, 1, 0.69)];

/**
 * A beam, spanning the voxel at head height.
 *
 * High in the voxel rather than centred, so a run of them reads as rafters you
 * walk under rather than as a fence you climb over — and so a beam placed along
 * the top of a wall sits where a lintel would.
 */
const BEAM_BASE: readonly ShapeBox[] = [box(0, 0.6, 0.32, 1, 0.92, 0.68)];

/**
 * The boxes making up a block, in unit-cube space.
 *
 * Returns the shared FULL_CUBE array for ordinary blocks so the common path
 * allocates nothing.
 */
export function shapeBoxes(shape: BlockShape, meta: number): readonly ShapeBox[] {
  switch (shape) {
    case 'cube':
      return FULL_CUBE;

    case 'slab':
      return metaIsUpper(meta) ? [box(0, 0.5, 0, 1, 1, 1)] : [box(0, 0, 0, 1, 0.5, 1)];

    case 'stairs': {
      const facing = metaFacing(meta);
      const upper = metaIsUpper(meta);
      return STAIRS_BASE.map((b) => {
        const rotated = rotate(b, facing);
        return upper ? flipY(rotated) : rotated;
      });
    }

    case 'wedge': {
      const facing = metaFacing(meta);
      const upper = metaIsUpper(meta);
      return WEDGE_BASE.map((b) => {
        const rotated = rotate(b, facing);
        return upper ? flipY(rotated) : rotated;
      });
    }

    case 'pane':
      return PANE_BASE.map((b) => rotate(b, metaFacing(meta)));

    case 'door':
      return (metaIsOpen(meta) ? DOOR_OPEN : DOOR_CLOSED).map((b) => rotate(b, metaFacing(meta)));

    case 'fence':
      return FENCE_BOXES.map((b) => rotate(b, metaFacing(meta)));

    case 'torch':
      return TORCH_BOXES;

    case 'wall':
      return WALL_BASE.map((b) => rotate(b, metaFacing(meta)));

    case 'post':
      return POST_BOXES;

    case 'beam':
      // Rotated by facing, and flipped to the floor when placed on a ceiling, so
      // the same piece serves as a rafter and as a kerb.
      return BEAM_BASE.map((b) => {
        const rotated = rotate(b, metaFacing(meta));
        return metaIsUpper(meta) ? rotated : flipY(rotated);
      });

    case 'plate':
      // Thinner than a slab by design: a slab is a half step you stand on, a plate
      // is boarding. At slab thickness there would be no reason for both.
      return metaIsUpper(meta) ? [box(0, 0.88, 0, 1, 1, 1)] : [box(0, 0, 0, 1, 0.12, 1)];

    default:
      return FULL_CUBE;
  }
}

/** True when this shape fills the whole voxel, and so can cull its neighbours. */
export function shapeIsFullCube(shape: BlockShape): boolean {
  return shape === 'cube';
}

/**
 * True when a shape is placed against the face that was clicked rather than
 * standing in the middle of its voxel.
 *
 * Walls and plates are surfaces, so which face you pointed at decides where they
 * go; posts and beams are objects, so they sit where the voxel is.
 */
export function shapeHugsFace(shape: BlockShape): boolean {
  return shape === 'wall' || shape === 'plate';
}

/**
 * True when a shape should stop movement.
 *
 * Torches are decoration you can walk through; an open door is a hole. Everything
 * else collides using its own boxes, which is what lets a slab be a half step and
 * stairs be walkable.
 */
export function shapeBlocksMovement(shape: BlockShape, meta: number): boolean {
  if (shape === 'torch') return false;
  if (shape === 'door') return !metaIsOpen(meta);
  return true;
}
