import * as THREE from 'three';
import { mesh, ngon, plate, sweep, turned, type Vec2 } from './models';

/**
 * Low-poly dungeon props.
 *
 * Dungeons were carved purely from voxels, so every room was a brick box with brick
 * corners. These add the furniture a dungeon needs to read as built rather than
 * excavated: braziers, columns, arches, sarcophagi, rubble, banners, barrels.
 *
 * ## Props never carry collision
 *
 * Physics queries the voxel grid, and teaching it about arbitrary prop geometry
 * would be a large change for a decorative win. So props are decoration layered over
 * voxels that already exist: a column is drawn over a real brick column, a brazier
 * over a real Glowstone block. Anything without a voxel behind it — rubble, bones,
 * banners — is deliberately something you would expect to walk through or over.
 *
 * `dungeonPropVoxels` in world/DungeonProps is what keeps the two in agreement: the
 * generator asks the same placement code which blocks to write, so the decoration
 * and the solid world can never drift apart.
 *
 * ## The kit is modular
 *
 * Columns come as base, shaft and capital so they stack to any room height, rather
 * than one fixed-height column stretched to fit and dragging its capital out of
 * proportion with it.
 *
 * Every prop is modelled with its footprint centred on the origin in XZ and its base
 * at y=0, so a placement only needs a block position and a facing.
 */

// ------------------------------------------------------------------ materials

function stoneMat(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

const PROP_MAT = {
  stone: stoneMat(0x8e8b84),
  paleStone: stoneMat(0xa6a29a),
  darkStone: stoneMat(0x5f5d58),
  mossStone: stoneMat(0x6d7a5c),
  iron: stoneMat(0x4a4d55),
  darkIron: stoneMat(0x33363d),
  wood: stoneMat(0x6b4c2c),
  darkWood: stoneMat(0x43301c),
  cloth: stoneMat(0x8e2f2a),
  bone: stoneMat(0xd8d2c0),
  // Basic materials are pulled into the glow pass, so they stay bright at night.
  fire: new THREE.MeshBasicMaterial({ color: 0xffa034 }),
  fireCore: new THREE.MeshBasicMaterial({ color: 0xffe9b0 }),
  ember: new THREE.MeshBasicMaterial({ color: 0xff6a1e }),
};

/** Lays a part flat so a +Z-built shape runs vertically. */
function standUp(part: THREE.Object3D, lean = 0): void {
  part.rotation.x = -Math.PI / 2 + lean;
}

/** A drum — column shafts, barrels, pedestals. */
function drum(radius: number, height: number, sides: number, material: THREE.Material, y = 0, taper = 1): THREE.Mesh {
  const geometry = sweep(ngon(sides, 0.5), [
    { z: 0, sx: radius * 2, sy: radius * 2 },
    { z: height, sx: radius * 2 * taper, sy: radius * 2 * taper },
  ]);
  const m = mesh(geometry, material, 0, y, 0);
  standUp(m);
  return m;
}

/** A square slab, for plinths and caps. */
function slab(width: number, height: number, depth: number, material: THREE.Material, y = 0): THREE.Mesh {
  const half = width / 2;
  const halfDepth = depth / 2;
  const geometry = sweep(
    [
      [-half, -halfDepth],
      [half, -halfDepth],
      [half, halfDepth],
      [-half, halfDepth],
    ],
    [
      { z: 0, sx: 1, sy: 1 },
      { z: height, sx: 1, sy: 1 },
    ],
  );
  const m = mesh(geometry, material, 0, y, 0);
  standUp(m);
  return m;
}

// ------------------------------------------------------------------ brazier

/**
 * A standing brazier: a drum pedestal, a bowl of coals, and flame.
 *
 * The pedestal is deliberately wide — radius 0.75 against a 1×1×1 block whose
 * corners reach 0.707 — because it has to completely hide the Glowstone block that
 * gives it light and collision. A narrower pedestal leaves four glowing corners
 * poking out of the stonework.
 */
export function brazierProp(): THREE.Group {
  const g = new THREE.Group();

  g.add(drum(0.75, 0.16, 12, PROP_MAT.darkStone, 0));
  g.add(drum(0.62, 0.7, 12, PROP_MAT.stone, 0.16, 0.78));
  g.add(drum(0.7, 0.14, 12, PROP_MAT.darkStone, 0.86));

  // Bowl: a flared basin on a short stem.
  g.add(drum(0.22, 0.26, 8, PROP_MAT.iron, 1.0));
  const bowl = mesh(
    turned(
      [
        [0.16, 0],
        [0.44, 0.22],
        [0.46, 0.3],
        [0.2, 0.06],
      ],
      12,
    ),
    PROP_MAT.darkIron,
    0,
    1.26,
    0,
  );
  g.add(bowl);

  // Coals and flame. Three nested teardrops, as the torch uses.
  g.add(mesh(turned([[0, -0.03], [0.34, -0.01], [0.36, 0.03], [0, 0.05]], 10), PROP_MAT.ember, 0, 1.4, 0));
  const flameSpec: Array<[THREE.Material, number, number]> = [
    [PROP_MAT.fire, 0.3, 0.66],
    [PROP_MAT.fireCore, 0.16, 0.4],
  ];
  for (const [material, radius, height] of flameSpec) {
    const flame = turned(
      [
        [0, 0],
        [radius * 0.6, height * 0.08],
        [radius, height * 0.32],
        [radius * 0.78, height * 0.6],
        [radius * 0.36, height * 0.84],
        [0, height],
      ],
      10,
    );
    g.add(mesh(flame, material, 0, 1.42, 0));
  }

  return g;
}

// ------------------------------------------------------------------ columns

/**
 * Columns are wider than the block they stand on, and have to be.
 *
 * A column decorates a real 1×1 brick column — that is where its collision comes
 * from — so the decoration has to *enclose* the voxel or it is simply invisible
 * inside it. The first version used a shaft of radius 0.38 and vanished completely,
 * leaving a room full of plain brick posts. A 1×1×1 block's corners reach 0.707 from
 * its centre, so anything narrower than that shows bare brick at the corners.
 */
const COLUMN_RADIUS = 0.78;

/** Column base: a stepped plinth one block tall. */
export function columnBaseProp(): THREE.Group {
  const g = new THREE.Group();
  g.add(slab(1.86, 0.18, 1.86, PROP_MAT.darkStone, 0));
  g.add(slab(1.68, 0.14, 1.68, PROP_MAT.stone, 0.18));
  g.add(drum(COLUMN_RADIUS + 0.04, 0.72, 10, PROP_MAT.paleStone, 0.32, 0.94));
  return g;
}

/**
 * Column shaft: one block tall and tileable, so columns reach any ceiling.
 *
 * Fluted, which is the only reason it is not simply a cylinder: the grooves give the
 * facets something to catch and stop a tall column reading as a grey tube.
 */
export function columnShaftProp(): THREE.Group {
  const g = new THREE.Group();
  g.add(drum(COLUMN_RADIUS, 1.0, 10, PROP_MAT.paleStone, 0));
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const flute = drum(0.1, 1.0, 5, PROP_MAT.stone, 0);
    flute.position.set(Math.cos(angle) * COLUMN_RADIUS, 0, Math.sin(angle) * COLUMN_RADIUS);
    g.add(flute);
  }
  return g;
}

/** Column capital: a flared head meeting the ceiling. */
export function columnCapitalProp(): THREE.Group {
  const g = new THREE.Group();
  g.add(drum(COLUMN_RADIUS, 0.12, 10, PROP_MAT.stone, 0));
  g.add(
    mesh(
      turned(
        [
          [COLUMN_RADIUS - 0.02, 0],
          [COLUMN_RADIUS + 0.16, 0.3],
          [COLUMN_RADIUS + 0.2, 0.44],
          [COLUMN_RADIUS - 0.02, 0.44],
        ],
        12,
      ),
      PROP_MAT.paleStone,
      0,
      0.12,
      0,
    ),
  );
  g.add(slab(2.0, 0.2, 2.0, PROP_MAT.darkStone, 0.56));
  g.add(slab(1.8, 0.24, 1.8, PROP_MAT.stone, 0.76));
  return g;
}

// ------------------------------------------------------------------ archway

/**
 * A voussoir arch spanning a three-wide opening.
 *
 * Built as discrete wedge blocks around a semicircle rather than as a smooth curve,
 * because a dungeon arch should look laid by hand. Springs from piers either side so
 * it reads as load-bearing.
 */
export function archwayProp(): THREE.Group {
  const g = new THREE.Group();

  // Sized to a three-wide, four-high corridor: everything stays inside x ±1.5 and
  // under y 2.8. An arch that oversteps either pokes through the corridor's own
  // walls and ceiling, which is worse than having no arch at all.
  const springLine = 1.2;
  const radius = 1.42;

  // Piers, tucked just inside the opening's edges.
  for (const sign of [1, -1]) {
    const pier = slab(0.3, springLine, 0.85, PROP_MAT.stone, 0);
    pier.position.x = sign * 1.35;
    g.add(pier);
    const cap = slab(0.42, 0.16, 0.95, PROP_MAT.darkStone, springLine);
    cap.position.x = sign * 1.35;
    g.add(cap);
  }

  // Voussoirs sweeping the semicircle. Discrete wedges rather than a smooth curve,
  // because a dungeon arch should look laid by hand.
  const blocks = 9;
  for (let i = 0; i < blocks; i++) {
    const angle = (Math.PI * (i + 0.5)) / blocks;
    const wedge = plate(
      [
        [-0.2, -0.26],
        [0.2, -0.29],
        [0.23, 0.29],
        [-0.23, 0.26],
      ],
      0.85,
      0.02,
    );
    const block = mesh(wedge, i % 3 === 1 ? PROP_MAT.darkStone : PROP_MAT.stone);
    block.position.set(-Math.cos(angle) * radius, springLine + 0.16 + Math.sin(angle) * radius, 0);
    // Each block leans to follow the curve, which is what makes it an arch rather
    // than a ring of loose stones.
    block.rotation.z = angle - Math.PI / 2;
    g.add(block);
  }

  // Keystone, standing proud of the ring.
  g.add(
    mesh(
      plate(
        [
          [-0.17, -0.3],
          [0.17, -0.24],
          [0.22, 0.3],
          [-0.22, 0.3],
        ],
        0.95,
        0.03,
      ),
      PROP_MAT.paleStone,
      0,
      springLine + 0.16 + radius + 0.02,
      0,
    ),
  );

  return g;
}

// ------------------------------------------------------------------ floor clutter

/** A scatter of angular masonry chunks. */
export function rubbleProp(): THREE.Group {
  const g = new THREE.Group();
  const chunks: Array<[number, number, number, number]> = [
    [0.0, 0.0, 0.34, 0.26],
    [0.36, 0.2, 0.22, 0.17],
    [-0.3, 0.26, 0.26, 0.2],
    [0.12, -0.36, 0.2, 0.14],
    [-0.34, -0.22, 0.17, 0.12],
  ];
  for (const [x, z, size, height] of chunks) {
    const chunk = mesh(
      turned(
        [
          [0, 0],
          [size, 0.02],
          [size * 0.7, height],
          [0, height],
        ],
        5,
      ),
      Math.abs(x + z) > 0.4 ? PROP_MAT.mossStone : PROP_MAT.stone,
      x,
      0,
      z,
    );
    chunk.rotation.y = (x - z) * 4;
    g.add(chunk);
  }
  return g;
}

/** A pile of bones with a skull on top. */
export function bonesProp(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const angle = i * 1.27;
    const bone = mesh(
      sweep(ngon(5, 0.5), [
        { z: 0, sx: 0.05, sy: 0.05 },
        { z: 0.2, sx: 0.035, sy: 0.035 },
        { z: 0.4, sx: 0.05, sy: 0.05 },
      ]),
      PROP_MAT.bone,
      Math.cos(angle) * 0.14,
      0.05,
      Math.sin(angle) * 0.14,
    );
    bone.rotation.y = angle;
    bone.rotation.x = Math.PI / 2 + 0.1;
    g.add(bone);
  }
  // Skull: a rounded braincase with two sockets.
  const skull = new THREE.Group();
  skull.position.set(0.02, 0.18, 0.02);
  skull.add(mesh(turned([[0, -0.13], [0.11, -0.07], [0.12, 0.04], [0, 0.13]], 7), PROP_MAT.bone));
  skull.add(
    mesh(sweep(ngon(6, 0.5), [{ z: 0, sx: 0.15, sy: 0.08 }, { z: 0.1, sx: 0.11, sy: 0.06 }]), PROP_MAT.bone, 0, -0.06, -0.06),
  );
  for (const sign of [1, -1]) {
    skull.add(mesh(turned([[0, -0.03], [0.035, 0], [0, 0.03]], 5), PROP_MAT.darkStone, sign * 0.05, 0.01, -0.11));
  }
  skull.rotation.y = 0.6;
  g.add(skull);
  return g;
}

/** A barrel: staves, hoops, and a lid. */
export function barrelProp(): THREE.Group {
  const g = new THREE.Group();
  g.add(
    mesh(
      turned(
        [
          [0, 0],
          [0.3, 0.02],
          [0.36, 0.34],
          [0.3, 0.66],
          [0, 0.68],
        ],
        10,
      ),
      PROP_MAT.wood,
      0,
      0,
      0,
    ),
  );
  for (const y of [0.1, 0.56]) {
    g.add(mesh(turned([[0.33, -0.035], [0.37, 0], [0.33, 0.035]], 10), PROP_MAT.darkIron, 0, y, 0));
  }
  g.add(drum(0.28, 0.04, 10, PROP_MAT.darkWood, 0.66));
  return g;
}

/** A stone sarcophagus with a tapered, slightly shifted lid. */
export function sarcophagusProp(): THREE.Group {
  const g = new THREE.Group();
  g.add(slab(1.1, 0.12, 2.1, PROP_MAT.darkStone, 0));
  g.add(slab(0.96, 0.62, 1.96, PROP_MAT.stone, 0.12));
  // Lid, pushed askew — the occupant did not close it behind them.
  const lid = slab(1.04, 0.22, 2.02, PROP_MAT.paleStone, 0.74);
  lid.position.z = 0.16;
  lid.rotation.y = 0.04;
  g.add(lid);
  // A carved effigy line down the lid.
  const ridge = slab(0.3, 0.1, 1.5, PROP_MAT.stone, 0.96);
  ridge.position.z = 0.16;
  g.add(ridge);
  return g;
}

/**
 * A hanging banner on an iron rail.
 *
 * Modelled in the XY plane so it hangs flat against a wall, with the cloth facing
 * +Z; a placement rotates it to face into the room.
 */
export function bannerProp(): THREE.Group {
  const g = new THREE.Group();
  // Rail.
  const rail = drum(0.05, 1.3, 6, PROP_MAT.darkIron, 0);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(-0.65, 2.3, 0);
  g.add(rail);
  // Cloth: a tapered hanging with a notched hem.
  const cloth = plate(
    [
      [-0.55, 0],
      [0.55, 0],
      [0.55, -1.7],
      [0.2, -1.42],
      [0, -1.72],
      [-0.2, -1.42],
      [-0.55, -1.7],
    ],
    0.05,
    0.01,
  );
  g.add(mesh(cloth, PROP_MAT.cloth, 0, 2.28, 0.06));
  // A pale device sewn on.
  const device: Vec2[] = [
    [0, 0.3],
    [0.22, 0.05],
    [0.13, -0.3],
    [-0.13, -0.3],
    [-0.22, 0.05],
  ];
  g.add(mesh(plate(device, 0.03, 0.006), PROP_MAT.bone, 0, 1.52, 0.1));
  return g;
}

// ------------------------------------------------------------------ merging

export interface MergedProp {
  /** Lambert geometry with colour baked per vertex. */
  solid: THREE.BufferGeometry;
  /** Self-lit geometry — flame, embers — or null if the prop has none. */
  glow: THREE.BufferGeometry | null;
}

/**
 * Flattens a prop group into at most two geometries with per-vertex colour.
 *
 * `InstancedMesh` draws one geometry with one material, but a prop is a group of
 * meshes in half a dozen colours. Baking each mesh's material colour into a vertex
 * attribute collapses them into a single draw while keeping the palette — the same
 * trick the chunk mesher already uses for block faces.
 *
 * Meshes using a `MeshBasicMaterial` are split into the `glow` geometry instead, so
 * a brazier's flame stays bright when the Lambert pass around it goes dark. Merging
 * them together would make fire respond to light, which is backwards.
 */
export function mergeProp(root: THREE.Object3D): MergedProp {
  root.updateMatrixWorld(true);

  const solid = { position: [] as number[], normal: [] as number[], color: [] as number[] };
  const glow = { position: [] as number[], normal: [] as number[], color: [] as number[] };

  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const white = new THREE.Color(0xffffff);

  root.traverse((child) => {
    const asMesh = child as THREE.Mesh;
    if (!asMesh.isMesh) return;
    const geometry = asMesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const normals = geometry.getAttribute('normal');
    const index = geometry.index;
    const count = index ? index.count : position.count;

    const material = asMesh.material as THREE.Material;
    const color = 'color' in material ? (material as THREE.MeshLambertMaterial).color : white;
    const target = (material as THREE.Material).type === 'MeshBasicMaterial' ? glow : solid;

    normalMatrix.getNormalMatrix(asMesh.matrixWorld);
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      vertex.fromBufferAttribute(position, vi).applyMatrix4(asMesh.matrixWorld);
      target.position.push(vertex.x, vertex.y, vertex.z);
      if (normals) {
        normal.fromBufferAttribute(normals, vi).applyMatrix3(normalMatrix).normalize();
        target.normal.push(normal.x, normal.y, normal.z);
      } else {
        target.normal.push(0, 1, 0);
      }
      target.color.push(color.r, color.g, color.b);
    }
  });

  const build = (parts: typeof solid): THREE.BufferGeometry | null => {
    if (parts.position.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(parts.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(parts.normal, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(parts.color, 3));
    geometry.computeBoundingSphere();
    return geometry;
  };

  const solidGeometry = build(solid);
  if (!solidGeometry) throw new Error('prop has no solid geometry');
  return { solid: solidGeometry, glow: build(glow) };
}

// ------------------------------------------------------------------ registry

export type PropKind =
  | 'brazier'
  | 'columnBase'
  | 'columnShaft'
  | 'columnCapital'
  | 'archway'
  | 'rubble'
  | 'bones'
  | 'barrel'
  | 'sarcophagus'
  | 'banner';

const BUILDERS: Record<PropKind, () => THREE.Object3D> = {
  brazier: brazierProp,
  columnBase: columnBaseProp,
  columnShaft: columnShaftProp,
  columnCapital: columnCapitalProp,
  archway: archwayProp,
  rubble: rubbleProp,
  bones: bonesProp,
  barrel: barrelProp,
  sarcophagus: sarcophagusProp,
  banner: bannerProp,
};

export const PROP_KINDS = Object.keys(BUILDERS) as PropKind[];

/** Builds and merges a prop. Callers cache the result; this is not cheap. */
export function buildMergedProp(kind: PropKind): MergedProp {
  return mergeProp(BUILDERS[kind]());
}
