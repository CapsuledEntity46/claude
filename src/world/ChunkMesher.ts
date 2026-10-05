import * as THREE from 'three';
import { Block, type BlockDef, blockDef, OPAQUE_BY_ID} from './blocks';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, Chunk, voxelIndex } from './Chunk';
import { shapeBoxes } from './shapes';
import { isTexturedBlock, tileForFace, tileRect } from './textures';

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
 * Whether a face's texture axes need swapping relative to its geometry basis.
 *
 * The face bases above are chosen so that u × v === n, which is what guarantees
 * counter-clockwise winding without a hand-maintained corner table. That is the right
 * constraint for geometry, but it means the bases are *not* consistently oriented:
 * on the -Z face `u` is the one pointing up, not `v`. Mapping texture coordinates
 * straight from (a, b) therefore laid the image on its side on exactly that one face
 * — grass appearing at the edge of a block instead of on top, and bark furrows
 * running around a trunk instead of along it.
 *
 * Derived from the bases rather than written out, so it cannot fall out of step with
 * them: on any face with a vertical tangent, the texture's vertical axis follows it.
 */
const FACE_UV_SWAP: readonly boolean[] = FACES.map((face) => face.u[1] === 1 && face.v[1] !== 1);

/**
 * Brightness for AO levels 0..3 (0 = most enclosed).
 *
 * A balance found by trial: a very steep ramp (0.42 at the darkest) produces hard
 * dark wedges across open ground, because voxel terrain is full of one-block steps
 * whose inside corners drive a vertex to the darkest level and then interpolate it
 * across a whole quad. Too gentle a ramp and corners stop reading at all. This
 * sits between the two.
 */
const AO_SHADE = [0.5, 0.7, 0.87, 1.0];

/**
 * Baked per-face brightness, indexed to match FACES: +X, -X, +Y, -Y, +Z, -Z.
 *
 * Cube faces used to be differentiated only by the dynamic directional light,
 * which meant that once the sun went down every face of every block received
 * almost the same value and the world flattened into silhouettes. Baking a fixed
 * light direction into the vertex colours keeps top, side, and underside legible
 * at any hour, independent of the lighting.
 */
const CUBE_FACE_SHADE = [0.78, 0.7, 1.0, 0.45, 0.88, 0.82];

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
  uv: number[];
  idx: number[];
}

function newBuffers(): Buffers {
  return { pos: [], norm: [], col: [], uv: [], idx: [] };
}

function toGeometry(b: Buffers): THREE.BufferGeometry | null {
  if (b.idx.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.norm), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

export interface MeshResult {
  opaque: THREE.BufferGeometry | null;
  translucent: THREE.BufferGeometry | null;
}

/**
 * Emits every box of a shaped block.
 *
 * All six faces of every box are written. Culling them against neighbours would
 * need to know how much of each shared plane the adjacent shape actually covers,
 * which is far more bookkeeping than the handful of hidden triangles is worth —
 * shaped blocks are a small fraction of any chunk.
 */
function emitShape(
  buf: Buffers,
  x: number,
  y: number,
  z: number,
  wx: number,
  wy: number,
  wz: number,
  def: BlockDef,
  meta: number,
): void {
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
      const shade = CUBE_FACE_SHADE[f];
      const start = buf.pos.length / 3;
      const rect = tileRect(tileForFace(def.id, face.tint, wx, wy, wz));
      const swapUV = FACE_UV_SWAP[f];
      // A shaped block's boxes are sub-cube, so its faces take the whole tile
      // rather than a slice of it. Every shaped block currently samples the blank
      // tile anyway, so there is nothing to stretch.

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
        const tu = swapUV ? b : a;
        const tv = swapUV ? a : b;
        buf.uv.push(rect.u0 + (rect.u1 - rect.u0) * tu, rect.v0 + (rect.v1 - rect.v0) * tv);
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

  const occluded = (x: number, y: number, z: number): number => OPAQUE_BY_ID[at(x, y, z)];

  // Neighbour offsets in the flat voxel array. The layout is y-major, so a step
  // along each axis is a fixed index delta and an interior voxel's six
  // neighbours can be read without any bounds arithmetic at all.
  const STRIDE_X = 1;
  const STRIDE_Z = CHUNK_SX;
  const STRIDE_Y = CHUNK_SX * CHUNK_SZ;

  /**
   * Stop scanning above the tallest voxel in this chunk.
   *
   * Chunks are full-height columns, and in a world with a raised ceiling most of
   * that column is empty sky — visiting it costs a read and a branch per voxel
   * for nothing. Skipping it is what pays for the taller world: the mesher does
   * *less* work at height 160 than it used to at 72.
   *
   * Derived from the voxel data rather than from `heightMap`, deliberately. The
   * height map is a cache maintained by the generator and by edits, and reading
   * it here would make meshing silently wrong whenever it is stale — a chunk
   * assembled voxel by voxel (as the unit tests do) has an all-zero map and
   * would mesh as empty. The layout is y-major, so the last non-air byte in the
   * flat array gives the top row directly, and the scan breaks the moment it
   * finds it.
   *
   * The +1 matters: the row above the highest block has to be visited so that
   * block's top face is still emitted.
   */
  let scanTop = 0;
  const layer = CHUNK_SX * CHUNK_SZ;
  for (let i = vox.length - 1; i >= 0; i--) {
    if (vox[i] !== Block.Air) {
      scanTop = Math.min(CHUNK_SY - 1, Math.floor(i / layer) + 1);
      break;
    }
  }

  for (let y = 0; y <= scanTop; y++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const index = voxelIndex(x, y, z);
        const id = vox[index];
        if (id === Block.Air) continue;

        // Fully buried voxels are the overwhelming majority — underground rock
        // with rock on all six sides — and they emit nothing at all. Detecting
        // that with six typed-array reads, before touching the face loop, skips
        // the whole per-face machinery for them.
        //
        // Only taken away from the chunk's x/z borders and the world's floor and
        // ceiling, where the neighbour lives in another chunk and the slower
        // lookup is needed.
        if (
          x > 0 &&
          x < CHUNK_SX - 1 &&
          z > 0 &&
          z < CHUNK_SZ - 1 &&
          y > 0 &&
          y < CHUNK_SY - 1 &&
          OPAQUE_BY_ID[vox[index - STRIDE_X]] === 1 &&
          OPAQUE_BY_ID[vox[index + STRIDE_X]] === 1 &&
          OPAQUE_BY_ID[vox[index - STRIDE_Z]] === 1 &&
          OPAQUE_BY_ID[vox[index + STRIDE_Z]] === 1 &&
          OPAQUE_BY_ID[vox[index - STRIDE_Y]] === 1 &&
          OPAQUE_BY_ID[vox[index + STRIDE_Y]] === 1
        ) {
          continue;
        }

        const def = blockDef(id);
        const translucent = isTranslucent(id);
        const buf = translucent ? transBuf : opaqueBuf;

        // Anything that is not a full cube is emitted as an explicit set of
        // boxes. Those get flat face shading rather than per-vertex AO: the AO
        // term is defined against the voxel lattice, and sampling it at
        // arbitrary sub-block positions produces creases in the wrong places.
        if (def.shape !== 'cube') {
          emitShape(buf, x, y, z, baseX + x, y, baseZ + z, def, chunk.meta[index]);
          continue;
        }

        for (let faceIndex = 0; faceIndex < FACES.length; faceIndex++) {
          const face = FACES[faceIndex];
          const [nx, ny, nz] = face.n;
          const ax = x + nx;
          const ay = y + ny;
          const az = z + nz;
          const neighborId = at(ax, ay, az);

          // Draw when the neighbour lets light through, but never between two
          // blocks of the same kind (keeps glass and water hollow).
          if (OPAQUE_BY_ID[neighborId] === 1 || neighborId === id) continue;

          const tint = def[face.tint];
          const emissive = def.emissive ?? 0;
          const faceShade = CUBE_FACE_SHADE[faceIndex];
          // World coordinates, so a block's texture variant is the same however the
          // world streams in and does not change at chunk boundaries. The vertical
          // coordinate is included because stone stacks: without it a cliff face
          // picks one variant for its whole column and comes out striped.
          const rect = tileRect(tileForFace(id, face.tint, baseX + x, y, baseZ + z));
          const swapUV = FACE_UV_SWAP[faceIndex];
          // For a textured block the vertex colour carries shading only and the
          // texture supplies the hue. Multiplying a green texture by an already
          // green tint would darken it twice over.
          const textured = isTexturedBlock(id);

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

            // Ambient occlusion at the corner, times the face's baked brightness.
            const shade = AO_SHADE[ao] * faceShade;
            buf.pos.push(x + ox + ux * a + vx * b, y + oy + uy * a + vy * b, z + oz + uz * a + vz * b);
            buf.norm.push(nx, ny, nz);
            const tu = swapUV ? b : a;
            const tv = swapUV ? a : b;
            buf.uv.push(rect.u0 + (rect.u1 - rect.u0) * tu, rect.v0 + (rect.v1 - rect.v0) * tv);
            buf.col.push(
              Math.min(1, (textured ? shade : tint[0] * shade) + emissive),
              Math.min(1, (textured ? shade : tint[1] * shade) + emissive),
              Math.min(1, (textured ? shade : tint[2] * shade) + emissive),
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
