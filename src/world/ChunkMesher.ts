import * as THREE from 'three';
import { Block, type BlockDef, blockDef, isOpaque } from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from './Chunk';
import { shapeBoxes } from './shapes';

/**
 * Culled-face mesher with per-vertex ambient occlusion.
 *
 * For every solid voxel we emit a quad per face whose neighbour is see-through.
 * Each quad vertex samples the three voxels diagonally around it to compute the
 * classic voxel AO term, which is baked into the vertex colour. That single
 * detail is what stops a flat-coloured voxel world from looking like soup.
 *
 * Face basis vectors are chosen so that u × v == normal, which guarantees
 * counter-clockwise winding without hand-maintaining a corner table.
 */

interface Face {
  /** Outward normal. */
  n: readonly [number, number, number];
  /** Quad origin within the unit cube. */
  o: readonly [number, number, number];
  /** First tangent. */
  u: readonly [number, number, number];
  /** Second tangent, with u × v === n. */
  v: readonly [number, number, number];
  /** Which of the block's three colours this face uses. */
  tint: 'top' | 'side' | 'bottom';
}

const FACES: readonly Face[] = [
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0], tint: 'side' },
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], tint: 'side' },
  { n: [0, 1, 0], o: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], tint: 'top' },
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], tint: 'bottom' },
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], tint: 'side' },
  { n: [0, 0, -1], o: [0, 0, 0], u: [0, 1, 0], v: [1, 0, 0], tint: 'side' },
];

/** Corner positions on the face, as (a, b) multiples of u and v. */
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Brightness for AO levels 0..3 (0 = most enclosed).
 *
 * Kept deliberately gentle. A steeper ramp (0.42 at the darkest) looks correct on
 * a single test cube but is far too strong on real terrain: voxel landscapes are
 * full of one-block steps, every inside corner drives a vertex to the darkest
 * level, and the value then interpolates across the whole quad — producing hard
 * dark wedges across open ground instead of soft contact shading.
 */
const AO_SHADE = [0.62, 0.78, 0.9, 1.0];

/** Blocks drawn in the translucent pass instead of the opaque one. */
function isTranslucent(id: number): boolean {
  return id === Block.Water || id === Block.Glass;
}

/** Signature of a world-space voxel lookup used for cross-chunk neighbours. */
export type NeighborLookup = (wx: number, wy: number, wz: number) => number;

interface Buffers {
  pos: number[];
  norm: number[];
  col: number[];
  idx: number[];
}

function newBuffers(): Buffers {
  return { pos: [], norm: [], col: [], idx: [] };
}

function toGeometry(b: Buffers): THREE.BufferGeometry | null {
  if (b.idx.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.norm), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

export interface MeshResult {
  opaque: THREE.BufferGeometry | null;
  translucent: THREE.BufferGeometry | null;
}

/** Flat brightness per face direction, used for non-cube shapes. */
const FACE_SHADE = [0.86, 0.86, 1.0, 0.62, 0.93, 0.93];

/**
 * Emits every box of a shaped block.
 *
 * All six faces of every box are written. Culling them against neighbours would
 * need to know how much of each shared plane the adjacent shape actually covers,
 * which is far more bookkeeping than the handful of hidden triangles is worth —
 * shaped blocks are a small fraction of any chunk.
 */
function emitShape(buf: Buffers, x: number, y: number, z: number, def: BlockDef, meta: number): void {
  const boxes = shapeBoxes(def.shape, meta);
  const emissive = def.emissive ?? 0;

  for (const shapeBox of boxes) {
    const [bx0, by0, bz0] = shapeBox.min;
    const [bx1, by1, bz1] = shapeBox.max;
    const sizeX = bx1 - bx0;
    const sizeY = by1 - by0;
    const sizeZ = bz1 - bz0;

    for (let f = 0; f < FACES.length; f++) {
      const face = FACES[f];
      const [dx, dy, dz] = face.n;
      const [ox, oy, oz] = face.o;
      const [ux, uy, uz] = face.u;
      const [vx, vy, vz] = face.v;
      const tint = def[face.tint];
      const shade = FACE_SHADE[f];
      const start = buf.pos.length / 3;

      for (const [a, b] of CORNERS) {
        // Take the corner on the *unit* cube's face, then scale it into the box.
        // Every component there is exactly 0 or 1, so scaling maps 0 to the box's
        // low bound and 1 to its high bound — which keeps the winding identical
        // to the cube path instead of having to reason about signed bases.
        const cx = ox + ux * a + vx * b;
        const cy = oy + uy * a + vy * b;
        const cz = oz + uz * a + vz * b;
        buf.pos.push(x + bx0 + cx * sizeX, y + by0 + cy * sizeY, z + bz0 + cz * sizeZ);
        buf.norm.push(dx, dy, dz);
        buf.col.push(
          Math.min(1, tint[0] * shade + emissive),
          Math.min(1, tint[1] * shade + emissive),
          Math.min(1, tint[2] * shade + emissive),
        );
      }
      buf.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
}

/**
 * Builds geometry for one chunk. Positions are chunk-local; the caller
 * positions the resulting mesh in world space.
 */
export function meshChunk(chunk: Chunk, neighbor: NeighborLookup): MeshResult {
  const baseX = chunk.cx * CHUNK_SX;
  const baseZ = chunk.cz * CHUNK_SZ;
  const vox = chunk.voxels;

  const opaqueBuf = newBuffers();
  const transBuf = newBuffers();

  // Voxel read that stays inside this chunk when possible and only falls back to
  // the (slower) world lookup at chunk borders.
  const at = (x: number, y: number, z: number): number => {
    if (y < 0) return Block.Bedrock; // seal the world bottom
    if (y >= CHUNK_SY) return Block.Air;
    if (x >= 0 && x < CHUNK_SX && z >= 0 && z < CHUNK_SZ) {
      return vox[voxelIndex(x, y, z)];
    }
    return neighbor(baseX + x, y, baseZ + z);
  };

  const occluded = (x: number, y: number, z: number): number => (isOpaque(at(x, y, z)) ? 1 : 0);

  for (let y = 0; y < CHUNK_SY; y++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const index = voxelIndex(x, y, z);
        const id = vox[index];
        if (id === Block.Air) continue;

        const def = blockDef(id);
        const translucent = isTranslucent(id);
        const buf = translucent ? transBuf : opaqueBuf;

        // Anything that is not a full cube is emitted as an explicit set of
        // boxes. Those get flat face shading rather than per-vertex AO: the AO
        // term is defined against the voxel lattice, and sampling it at
        // arbitrary sub-block positions produces creases in the wrong places.
        if (def.shape !== 'cube') {
          emitShape(buf, x, y, z, def, chunk.meta[index]);
          continue;
        }

        for (const face of FACES) {
          const [nx, ny, nz] = face.n;
          const ax = x + nx;
          const ay = y + ny;
          const az = z + nz;
          const neighborId = at(ax, ay, az);

          // Draw when the neighbour lets light through, but never between two
          // blocks of the same kind (keeps glass and water hollow).
          if (isOpaque(neighborId) || neighborId === id) continue;

          const tint = def[face.tint];
          const emissive = def.emissive ?? 0;

          const [ox, oy, oz] = face.o;
          const [ux, uy, uz] = face.u;
          const [vx, vy, vz] = face.v;

          const vertStart = buf.pos.length / 3;
          const aoLevels: number[] = [0, 0, 0, 0];

          for (let c = 0; c < 4; c++) {
            const [a, b] = CORNERS[c];
            const su = a === 0 ? -1 : 1;
            const sv = b === 0 ? -1 : 1;

            // AO samples sit around the *air* voxel in front of this face.
            const s1 = occluded(ax + ux * su, ay + uy * su, az + uz * su);
            const s2 = occluded(ax + vx * sv, ay + vy * sv, az + vz * sv);
            const cn = occluded(ax + ux * su + vx * sv, ay + uy * su + vy * sv, az + uz * su + vz * sv);

            const ao = s1 === 1 && s2 === 1 ? 0 : 3 - (s1 + s2 + cn);
            aoLevels[c] = ao;

            const shade = AO_SHADE[ao];
            buf.pos.push(x + ox + ux * a + vx * b, y + oy + uy * a + vy * b, z + oz + uz * a + vz * b);
            buf.norm.push(nx, ny, nz);
            buf.col.push(
              Math.min(1, tint[0] * shade + emissive),
              Math.min(1, tint[1] * shade + emissive),
              Math.min(1, tint[2] * shade + emissive),
            );
          }

          // Split the quad along whichever diagonal has less AO contrast,
          // otherwise strongly-occluded corners produce a visible seam.
          if (aoLevels[0] + aoLevels[2] >= aoLevels[1] + aoLevels[3]) {
            buf.idx.push(vertStart, vertStart + 1, vertStart + 2, vertStart, vertStart + 2, vertStart + 3);
          } else {
            buf.idx.push(vertStart + 1, vertStart + 2, vertStart + 3, vertStart + 1, vertStart + 3, vertStart);
          }
        }
      }
    }
  }

  return { opaque: toGeometry(opaqueBuf), translucent: toGeometry(transBuf) };
}
