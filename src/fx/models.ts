import * as THREE from 'three';

/**
 * Low-poly item models.
 *
 * The voxel grid is for the *world*. Items are not built from it: a sword is a
 * tapered blade with a real point, a shield is a bevelled plate with a rim, a bow
 * is a curve. Earlier versions assembled everything from axis-aligned boxes to
 * match the terrain, which made every weapon read as a stack of bricks — a
 * rectangular slab with a smaller slab on the end is not a sword.
 *
 * Everything here is still generated in code; there are no external assets.
 * Geometry is built **non-indexed** so that `computeVertexNormals` produces one
 * normal per triangle rather than averaging across them, which is what gives the
 * faceted low-poly look instead of a soft blob.
 *
 * Convention: parts are modelled pointing along **+Z** and the assembled weapon
 * is flipped to point along **-Z** (away from the camera) at the end, matching
 * what the view model's animation code expects.
 */

// ------------------------------------------------------------------ materials

/**
 * `flatShading` is the whole point: without it Lambert averages normals across
 * the facets and the low-poly silhouette loses its edges.
 */
function metal(color: number, emissive = 0x000000): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true });
}

export const MODEL_MAT = {
  steel: metal(0xc2cbd9),
  brightSteel: metal(0xdde5f0),
  darkIron: metal(0x69707e),
  blackIron: metal(0x3f4550),
  bronze: metal(0xb08040),
  gold: metal(0xd8b53c),
  wood: metal(0x7d5a33),
  darkWood: metal(0x4a3420),
  leather: metal(0x6b4630),
  darkLeather: metal(0x4c3122),
  cloth: metal(0x8d6c4a),
  skin: metal(0xc99a72),
  paintedField: metal(0xa33b32),
  flameCore: new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
  flameMid: new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.85 }),
  /**
   * The outer envelope is faint on purpose. At any real opacity it stops reading as
   * the glow around a flame and becomes a solid orange shape in its own right.
   * `depthWrite: false` keeps the inner layers visible through it.
   */
  flameOuter: new THREE.MeshBasicMaterial({
    color: 0xf2661c,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  }),
  string: new THREE.LineBasicMaterial({ color: 0xe6dcc6 }),
};

// ------------------------------------------------------------------ primitives

export type Vec2 = [number, number];

/** A cross-section station: where along Z, and how much to scale the profile. */
export interface Station {
  z: number;
  sx: number;
  sy: number;
}

/**
 * Sweeps a closed 2D profile along +Z through a series of scaled stations,
 * optionally converging on a point.
 *
 * This is the workhorse for anything with a taper — blades, grips, shafts, spear
 * heads. A pointed tip is a real apex the side faces converge on, not a smaller
 * box stuck on the end.
 */
export function sweep(profile: readonly Vec2[], stations: readonly Station[], tipZ?: number): THREE.BufferGeometry {
  const n = profile.length;
  const out: number[] = [];

  const at = (s: Station, i: number): THREE.Vector3 =>
    new THREE.Vector3(profile[i][0] * s.sx, profile[i][1] * s.sy, s.z);

  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  // Sides.
  for (let k = 0; k + 1 < stations.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = at(stations[k], i);
      const b = at(stations[k], j);
      const c = at(stations[k + 1], j);
      const d = at(stations[k + 1], i);
      tri(a, b, c);
      tri(a, c, d);
    }
  }

  // Base cap, facing -Z.
  const first = stations[0];
  for (let i = 1; i + 1 < n; i++) tri(at(first, 0), at(first, i + 1), at(first, i));

  const last = stations[stations.length - 1];
  if (tipZ !== undefined) {
    const apex = new THREE.Vector3(0, 0, tipZ);
    for (let i = 0; i < n; i++) tri(at(last, i), at(last, (i + 1) % n), apex);
  } else {
    for (let i = 1; i + 1 < n; i++) tri(at(last, 0), at(last, i), at(last, i + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A regular n-gon profile, for shafts and grips. */
export function ngon(sides: number, radius = 1): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    points.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return points;
}

/**
 * A blade cross-section: a flattened hexagon.
 *
 * Sharp corners at ±X are the cutting edges, the flats between them are the faces
 * and the central ridge. A plain rectangle here is exactly what made the old
 * weapons look like rulers.
 */
const BLADE_PROFILE: readonly Vec2[] = [
  [-0.5, 0],
  [-0.25, 0.5],
  [0.25, 0.5],
  [0.5, 0],
  [0.25, -0.5],
  [-0.25, -0.5],
];

/**
 * Splits shared vertices so every triangle gets its own normal.
 *
 * Careful with the indexed check: `toNonIndexed()` returns *the same object* when
 * a geometry is already non-indexed, so disposing the input unconditionally would
 * destroy the geometry being returned. `ExtrudeGeometry` is non-indexed while
 * `LatheGeometry` and `TubeGeometry` are indexed, so both cases occur here.
 */
function facet(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  if (flat.getAttribute('uv')) flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

function outlineToShape(outline: readonly Vec2[]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();
  return shape;
}

/**
 * A flat plate outline extruded to a thickness, with a single-segment bevel.
 *
 * Only the *depth* is centred, never the outline: parts like an axe bit are
 * authored with their socket at x=0 and their edge out at +x, so recentring the
 * bounding box would slide the head off the end of its own shaft.
 *
 * `hole` cuts the middle out, which is the difference between a rim and a lid. A
 * shield rim built as a slightly-enlarged solid plate sits in front of the face and
 * hides all of it — the shield came out a featureless grey slab that way.
 */
export function plate(
  outline: readonly Vec2[],
  thickness: number,
  bevel = 0.008,
  hole?: readonly Vec2[],
): THREE.BufferGeometry {
  const shape = outlineToShape(outline);
  if (hole) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -thickness / 2);
  return facet(geometry);
}

/** A turned part — pommel, boss, counterweight — from a half-profile. */
export function turned(points: readonly Vec2[], segments = 8): THREE.BufferGeometry {
  return facet(
    new THREE.LatheGeometry(
      points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y)),
      segments,
    ),
  );
}

/** A swept tube along a curve, for bow limbs, horns, and creature legs. */
export function tube(points: readonly THREE.Vector3[], radius: number, segments = 14): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([...points]);
  return facet(new THREE.TubeGeometry(curve, segments, radius, 5, false));
}

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

/**
 * Mounts a flat part radially around the shaft axis (+Z) — mace flanges, axe bits,
 * halberd beaks.
 *
 * The nesting is deliberate. A plate is authored in XY and extruded along Z, and it
 * needs two rotations to stand up around a shaft: one to swing its outline into the
 * shaft's plane, another to place it around the axis. Setting both on a single
 * object silently composes them in Euler XYZ order — the spin about Z is applied
 * *first*, so six "radial" flanges came out stacked in almost the same plane rather
 * than spaced around the head. A parent group makes the order explicit instead of
 * dependent on Euler conventions.
 *
 * @param angle where around the shaft the part sits, 0 being +X
 */
function radialPart(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  angle: number,
  z: number,
  radialOffset = 0,
): THREE.Group {
  const holder = new THREE.Group();
  const part = mesh(geometry, material, radialOffset, 0, 0);
  // Outline Y becomes the shaft direction; the extrusion thickness becomes
  // tangential, so the broad face is the one you see as it swings.
  part.rotation.x = Math.PI / 2;
  holder.add(part);
  holder.rotation.z = angle;
  holder.position.z = z;
  return holder;
}

/** Flips an assembled +Z group to point along -Z, away from the camera. */
function pointAway(group: THREE.Group): THREE.Group {
  const wrapper = new THREE.Group();
  group.rotation.y = Math.PI;
  wrapper.add(group);
  return wrapper;
}

// ------------------------------------------------------------------ hands

/**
 * A fist around the grip.
 *
 * Four stubby fingers and a thumb rather than one cube: the hand is right at the
 * bottom of the screen at all times, so it is the single most-looked-at piece of
 * geometry in the game.
 */
export function lowPolyHand(x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  const palm = sweep(ngon(6, 0.5), [
    { z: -0.045, sx: 0.1, sy: 0.115 },
    { z: 0.0, sx: 0.115, sy: 0.13 },
    { z: 0.05, sx: 0.105, sy: 0.12 },
  ]);
  g.add(mesh(palm, MODEL_MAT.skin));
  for (let i = 0; i < 4; i++) {
    const finger = sweep(ngon(5, 0.5), [
      { z: 0, sx: 0.03, sy: 0.028 },
      { z: 0.055, sx: 0.026, sy: 0.024 },
    ]);
    g.add(mesh(finger, MODEL_MAT.skin, -0.028 + i * 0.019, 0.052, -0.02));
  }
  const thumb = sweep(ngon(5, 0.5), [
    { z: 0, sx: 0.034, sy: 0.03 },
    { z: 0.05, sx: 0.028, sy: 0.026 },
  ]);
  const thumbMesh = mesh(thumb, MODEL_MAT.skin, 0.045, 0.0, -0.01);
  thumbMesh.rotation.set(0.5, 0, -0.7);
  g.add(thumbMesh);
  g.position.set(x, y, z);
  return g;
}

// ------------------------------------------------------------------ blades

export interface BladeOptions {
  length: number;
  width: number;
  /** Thickness as a fraction of width. Rapiers are nearly square, sabres flat. */
  thickness?: number;
  material?: THREE.Material;
  /** Fullered blades narrow towards the tip; needles barely taper. */
  taper?: number;
}

/** A tapered, double-edged blade converging on a real point. */
export function bladeGeometry(opts: BladeOptions): THREE.BufferGeometry {
  const { length, width } = opts;
  const thickness = (opts.thickness ?? 0.3) * width;
  const taper = opts.taper ?? 0.62;
  const L = length;
  return sweep(
    BLADE_PROFILE,
    [
      { z: 0, sx: width * 0.94, sy: thickness },
      { z: L * 0.12, sx: width, sy: thickness },
      { z: L * 0.55, sx: width * (0.55 + taper * 0.45), sy: thickness * 0.88 },
      { z: L * 0.84, sx: width * taper, sy: thickness * 0.72 },
      { z: L * 0.95, sx: width * taper * 0.55, sy: thickness * 0.55 },
    ],
    L,
  );
}

/** Grip, guard, and pommel — the parts every sword-like weapon shares. */
function hiltParts(gripLength: number, guardSpan: number, material: THREE.Material): THREE.Group {
  const g = new THREE.Group();

  // Grip: a slightly waisted octagonal handle, wrapped.
  const grip = sweep(ngon(8, 0.5), [
    { z: 0, sx: 0.036, sy: 0.03 },
    { z: gripLength * 0.4, sx: 0.031, sy: 0.026 },
    { z: gripLength, sx: 0.037, sy: 0.031 },
  ]);
  g.add(mesh(grip, MODEL_MAT.darkLeather, 0, 0, -gripLength));

  // Pommel: a turned disc-and-knop.
  g.add(
    mesh(
      turned([
        [0, -0.024],
        [0.02, -0.022],
        [0.032, -0.008],
        [0.03, 0.008],
        [0.014, 0.022],
        [0, 0.024],
      ]),
      material,
      0,
      0,
      -gripLength - 0.022,
    ),
  );

  if (guardSpan > 0) {
    // Cross-guard: a bar that swells at the centre and flares at the tips,
    // modelled across X and swept so it has a real silhouette from any angle.
    const bar = sweep(
      ngon(6, 0.5),
      [
        { z: 0, sx: 0.03, sy: 0.05 },
        { z: guardSpan * 0.3, sx: 0.022, sy: 0.036 },
        { z: guardSpan * 0.86, sx: 0.019, sy: 0.03 },
        { z: guardSpan, sx: 0.03, sy: 0.042 },
      ],
      guardSpan + 0.012,
    );
    for (const sign of [1, -1]) {
      const arm = mesh(bar, material, 0, 0, 0);
      arm.rotation.y = (sign * Math.PI) / 2;
      // A slight forward sweep, as a real cross-guard has.
      arm.rotation.x = 0.12;
      g.add(arm);
    }
    // Ricasso block where the blade meets the guard.
    g.add(
      mesh(
        sweep(ngon(6, 0.5), [
          { z: 0, sx: 0.05, sy: 0.042 },
          { z: 0.035, sx: 0.042, sy: 0.034 },
        ]),
        material,
        0,
        0,
        0.002,
      ),
    );
  }

  return g;
}

export interface SwordOptions {
  bladeLength: number;
  bladeWidth: number;
  guardSpan: number;
  gripLength?: number;
  bladeMaterial?: THREE.Material;
  fittingMaterial?: THREE.Material;
  thickness?: number;
  taper?: number;
}

/** A sword, dagger, or rapier: hilt at the origin, point along -Z. */
export function swordModel(opts: SwordOptions): THREE.Group {
  const build = new THREE.Group();
  const fittings = opts.fittingMaterial ?? MODEL_MAT.gold;
  const gripLength = opts.gripLength ?? 0.12;

  build.add(hiltParts(gripLength, opts.guardSpan, fittings));
  build.add(
    mesh(
      bladeGeometry({
        length: opts.bladeLength,
        width: opts.bladeWidth,
        thickness: opts.thickness,
        taper: opts.taper,
      }),
      opts.bladeMaterial ?? MODEL_MAT.steel,
      0,
      0,
      0.02,
    ),
  );

  const group = pointAway(build);
  group.add(lowPolyHand(0, -0.005, 0.055));
  return group;
}

// ------------------------------------------------------------------ hafted

export type HaftedHead = 'mace' | 'hammer' | 'axe' | 'spear' | 'halberd';

/** A shaft with a head on the end: mace, hammer, axe, spear, halberd. */
export function haftedModel(shaftLength: number, head: HaftedHead): THREE.Group {
  const build = new THREE.Group();

  const shaft = sweep(ngon(7, 0.5), [
    { z: -0.09, sx: 0.036, sy: 0.036 },
    { z: shaftLength * 0.5, sx: 0.032, sy: 0.032 },
    { z: shaftLength, sx: 0.029, sy: 0.029 },
  ]);
  build.add(mesh(shaft, MODEL_MAT.wood));
  // Butt cap, so the shaft does not end in a bare hexagon.
  build.add(
    mesh(
      turned([
        [0, -0.018],
        [0.024, -0.012],
        [0.022, 0.012],
        [0, 0.016],
      ]),
      MODEL_MAT.darkIron,
      0,
      0,
      -0.1,
    ),
  );

  const tip = shaftLength;

  switch (head) {
    case 'mace': {
      // A faceted core with tapered flanges standing proud of it. The flanges are
      // what make it read as blunt-and-brutal rather than as a ball on a stick.
      build.add(
        mesh(
          turned(
            [
              [0, -0.075],
              [0.05, -0.058],
              [0.068, -0.02],
              [0.068, 0.022],
              [0.05, 0.058],
              [0, 0.075],
            ],
            7,
          ),
          MODEL_MAT.darkIron,
          0,
          0,
          tip + 0.05,
        ),
      );
      const flange = plate(
        [
          [0, -0.072],
          [0.06, -0.05],
          [0.105, -0.012],
          [0.105, 0.012],
          [0.06, 0.05],
          [0, 0.068],
        ],
        0.022,
        0.005,
      );
      for (let i = 0; i < 6; i++) {
        build.add(radialPart(flange, MODEL_MAT.blackIron, (i / 6) * Math.PI * 2, tip + 0.05));
      }
      break;
    }

    case 'hammer': {
      // A boxy head with a chamfer, plus a back spike for balance.
      build.add(
        mesh(
          sweep(ngon(6, 0.5), [
            { z: 0, sx: 0.12, sy: 0.15 },
            { z: 0.03, sx: 0.15, sy: 0.18 },
            { z: 0.12, sx: 0.15, sy: 0.18 },
            { z: 0.15, sx: 0.12, sy: 0.14 },
          ]),
          MODEL_MAT.darkIron,
          0,
          0,
          tip - 0.02,
        ),
      );
      build.add(
        mesh(
          sweep(ngon(5, 0.5), [{ z: 0, sx: 0.06, sy: 0.06 }, { z: 0.09, sx: 0.03, sy: 0.03 }], 0.13),
          MODEL_MAT.steel,
          0,
          0,
          tip + 0.13,
        ),
      );
      break;
    }

    case 'axe': {
      // A crescent bit: thin, with a real curved edge and a socket.
      const bit = plate(
        [
          [0, -0.12],
          [0.07, -0.13],
          [0.15, -0.075],
          [0.175, 0],
          [0.15, 0.075],
          [0.07, 0.13],
          [0, 0.12],
          [0.02, 0],
        ],
        0.02,
        0.006,
      );
      build.add(radialPart(bit, MODEL_MAT.brightSteel, 0, tip - 0.02, 0.055));
      build.add(
        mesh(
          sweep(ngon(6, 0.5), [
            { z: 0, sx: 0.062, sy: 0.062 },
            { z: 0.085, sx: 0.055, sy: 0.055 },
          ]),
          MODEL_MAT.darkIron,
          0,
          0,
          tip - 0.06,
        ),
      );
      break;
    }

    case 'spear': {
      // A leaf-shaped head on a socket.
      build.add(
        mesh(
          bladeGeometry({ length: 0.2, width: 0.058, thickness: 0.34, taper: 0.5 }),
          MODEL_MAT.brightSteel,
          0,
          0,
          tip + 0.02,
        ),
      );
      build.add(
        mesh(
          sweep(ngon(6, 0.5), [
            { z: 0, sx: 0.042, sy: 0.042 },
            { z: 0.06, sx: 0.034, sy: 0.034 },
          ]),
          MODEL_MAT.darkIron,
          0,
          0,
          tip - 0.035,
        ),
      );
      break;
    }

    case 'halberd': {
      // Axe bit, forward spike, and a rear beak — the shape that earns both
      // attack modes.
      const bit = plate(
        [
          [0, -0.1],
          [0.06, -0.115],
          [0.13, -0.05],
          [0.14, 0.03],
          [0.06, 0.1],
          [0, 0.09],
        ],
        0.018,
        0.005,
      );
      build.add(radialPart(bit, MODEL_MAT.brightSteel, 0, tip - 0.05, 0.05));

      build.add(
        mesh(
          bladeGeometry({ length: 0.19, width: 0.05, thickness: 0.34, taper: 0.45 }),
          MODEL_MAT.brightSteel,
          0,
          0,
          tip + 0.01,
        ),
      );
      const beak = plate(
        [
          [0, -0.05],
          [0.08, -0.02],
          [0.095, 0.035],
          [0, 0.045],
        ],
        0.014,
        0.004,
      );
      // Opposite the bit, so the head is balanced front to back.
      build.add(radialPart(beak, MODEL_MAT.darkIron, Math.PI, tip - 0.05, 0.04));
      break;
    }
  }

  const group = pointAway(build);
  group.add(lowPolyHand(0, -0.005, 0.05));
  return group;
}

// ------------------------------------------------------------------ shields

export type ShieldShape = 'buckler' | 'kite' | 'tower';

/**
 * A shield as a curved, bevelled plate with a rim and a boss.
 *
 * Bowed by pushing vertices back along Z proportionally to their distance from
 * the centre line, so it reads as cover you are sheltering behind rather than a
 * flat sign held up in front of you.
 */
export function shieldModel(shape: ShieldShape, scale: number): THREE.Group {
  const g = new THREE.Group();

  let outline: Vec2[];
  let thickness = 0.03;

  if (shape === 'buckler') {
    outline = ngon(14, 0.17).map(([x, y]) => [x, y] as Vec2);
  } else if (shape === 'kite') {
    // Rounded top, straight flanks, point at the bottom.
    outline = [
      [-0.1, 0.2],
      [-0.145, 0.15],
      [-0.16, 0.02],
      [-0.13, -0.14],
      [-0.07, -0.26],
      [0, -0.32],
      [0.07, -0.26],
      [0.13, -0.14],
      [0.16, 0.02],
      [0.145, 0.15],
      [0.1, 0.2],
      [0, 0.23],
    ];
  } else {
    outline = [
      [-0.17, 0.3],
      [-0.19, 0.2],
      [-0.2, -0.16],
      [-0.16, -0.3],
      [0.16, -0.3],
      [0.2, -0.16],
      [0.19, 0.2],
      [0.17, 0.3],
      [0, 0.34],
    ];
    thickness = 0.036;
  }

  const face = plate(outline, thickness, 0.012);
  // Bow the plate.
  const position = face.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const bulge = (1 - Math.min(1, (x * x) / 0.028 + (y * y) / 0.16)) * 0.045;
    position.setZ(i, position.getZ(i) - bulge);
  }
  position.needsUpdate = true;
  face.computeVertexNormals();
  g.add(mesh(face, MODEL_MAT.paintedField));

  // Rim: a true band, cut as a ring so the painted face shows through it.
  const rim = plate(
    outline.map(([x, y]) => [x * 1.06, y * 1.04] as Vec2),
    thickness * 0.85,
    0.006,
    outline.map(([x, y]) => [x * 0.9, y * 0.93] as Vec2),
  );
  g.add(mesh(rim, MODEL_MAT.darkIron, 0, 0, 0.004));

  // Boss.
  g.add(
    mesh(
      turned(
        [
          [0, -0.03],
          [0.03, -0.028],
          [0.05, -0.012],
          [0.045, 0.012],
          [0, 0.028],
        ],
        9,
      ),
      MODEL_MAT.darkIron,
      0,
      shape === 'kite' ? 0.02 : 0,
      -0.05,
    ),
  );

  // Reinforcing straps across the face.
  for (const sign of [1, -1]) {
    const strap = plate(
      [
        [-0.16, -0.022],
        [0.16, -0.022],
        [0.16, 0.022],
        [-0.16, 0.022],
      ],
      0.012,
      0.004,
    );
    g.add(mesh(strap, MODEL_MAT.darkWood, 0, sign * 0.13, -0.03));
  }

  g.add(lowPolyHand(0.02, -0.02, 0.07));
  g.scale.setScalar(scale);
  return g;
}

// ------------------------------------------------------------------ ranged

export interface BowParts {
  group: THREE.Group;
  string: THREE.Line;
  arrow: THREE.Mesh;
}

/** A recurve bow: real curved limbs, not a stepped staircase. */
export function bowModel(): BowParts {
  const group = new THREE.Group();

  const limb = (sign: number): THREE.Mesh => {
    const points = [
      new THREE.Vector3(0, 0.02 * sign, 0),
      new THREE.Vector3(0, 0.16 * sign, -0.02),
      new THREE.Vector3(0, 0.3 * sign, 0.0),
      new THREE.Vector3(0, 0.38 * sign, 0.055),
      new THREE.Vector3(0, 0.42 * sign, 0.1),
    ];
    return mesh(tube(points, 0.017, 12), MODEL_MAT.darkWood);
  };
  group.add(limb(1), limb(-1));

  // Grip.
  group.add(
    mesh(
      sweep(ngon(7, 0.5), [
        { z: 0, sx: 0.048, sy: 0.05 },
        { z: 0.05, sx: 0.042, sy: 0.055 },
        { z: 0.1, sx: 0.048, sy: 0.05 },
      ]),
      MODEL_MAT.leather,
      0,
      -0.05,
      -0.025,
    ),
  );
  const gripWrap = group.children[group.children.length - 1];
  gripWrap.rotation.x = Math.PI / 2;

  const stringGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.42, 0.1),
    new THREE.Vector3(0, 0, 0.04),
    new THREE.Vector3(0, -0.42, 0.1),
  ]);
  const string = new THREE.Line(stringGeometry, MODEL_MAT.string);
  group.add(string);

  // Arrow: shaft, head, and fletching.
  const arrow = new THREE.Group();
  arrow.add(mesh(sweep(ngon(5, 0.5), [{ z: 0, sx: 0.013, sy: 0.013 }, { z: 0.62, sx: 0.012, sy: 0.012 }]), MODEL_MAT.wood));
  arrow.add(mesh(bladeGeometry({ length: 0.07, width: 0.03, thickness: 0.3, taper: 0.4 }), MODEL_MAT.steel, 0, 0, 0.62));
  for (let i = 0; i < 3; i++) {
    const vane = plate(
      [
        [0, 0],
        [0.055, 0.012],
        [0.055, 0.032],
        [0, 0.026],
      ],
      0.004,
      0,
    );
    const v = mesh(vane, MODEL_MAT.cloth, 0, 0, 0.03);
    v.rotation.z = (i / 3) * Math.PI * 2;
    v.rotation.y = Math.PI / 2;
    arrow.add(v);
  }
  arrow.rotation.y = Math.PI;
  const arrowHolder = new THREE.Mesh();
  arrowHolder.add(arrow);
  arrowHolder.position.set(0, 0, 0.04);
  group.add(arrowHolder);

  group.add(lowPolyHand(0.02, -0.03, 0.04));
  return { group, string, arrow: arrowHolder };
}

/** A crossbow: stock, curved prod, and a bolt in the track. */
export function crossbowModel(): THREE.Group {
  const build = new THREE.Group();

  build.add(
    mesh(
      sweep(ngon(6, 0.5), [
        { z: -0.12, sx: 0.055, sy: 0.075 },
        { z: 0, sx: 0.05, sy: 0.06 },
        { z: 0.3, sx: 0.042, sy: 0.05 },
      ]),
      MODEL_MAT.darkWood,
    ),
  );

  const prod = tube(
    [
      new THREE.Vector3(-0.19, 0.03, -0.02),
      new THREE.Vector3(-0.09, 0.015, 0.01),
      new THREE.Vector3(0, 0.012, 0.015),
      new THREE.Vector3(0.09, 0.015, 0.01),
      new THREE.Vector3(0.19, 0.03, -0.02),
    ],
    0.014,
    12,
  );
  build.add(mesh(prod, MODEL_MAT.blackIron, 0, 0.01, 0.26));

  // Bolt track and bolt.
  build.add(
    mesh(
      plate(
        [
          [-0.018, -0.16],
          [0.018, -0.16],
          [0.018, 0.16],
          [-0.018, 0.16],
        ],
        0.012,
        0.003,
      ),
      MODEL_MAT.steel,
      0,
      0.042,
      0.12,
    ),
  );
  build.add(mesh(sweep(ngon(5, 0.5), [{ z: 0, sx: 0.012, sy: 0.012 }, { z: 0.22, sx: 0.011, sy: 0.011 }], 0.25), MODEL_MAT.darkIron, 0, 0.055, 0.1));

  // Trigger and stirrup.
  build.add(
    mesh(
      plate(
        [
          [0, 0],
          [0.02, -0.05],
          [0.042, -0.048],
          [0.03, 0.01],
        ],
        0.016,
        0.004,
      ),
      MODEL_MAT.darkIron,
      0,
      -0.045,
      -0.02,
    ),
  );

  const group = pointAway(build);
  group.add(lowPolyHand(0, -0.05, 0.06));
  return group;
}

/** A flintlock: octagonal barrel, lock plate, and a shaped stock. */
export function firearmModel(long: boolean): THREE.Group {
  const build = new THREE.Group();
  const barrelLength = long ? 0.62 : 0.3;

  build.add(
    mesh(
      sweep(ngon(8, 0.5), [
        { z: 0, sx: 0.042, sy: 0.042 },
        { z: barrelLength * 0.7, sx: 0.034, sy: 0.034 },
        { z: barrelLength, sx: 0.031, sy: 0.031 },
      ]),
      MODEL_MAT.blackIron,
      0,
      0.03,
      0.02,
    ),
  );

  // Stock: a tapered, dropped shape rather than a slab.
  build.add(
    mesh(
      sweep(ngon(6, 0.5), [
        { z: -0.24, sx: 0.05, sy: 0.085 },
        { z: -0.12, sx: 0.055, sy: 0.075 },
        { z: 0.04, sx: 0.055, sy: 0.07 },
        { z: 0.18, sx: 0.045, sy: 0.052 },
      ]),
      MODEL_MAT.darkWood,
      0,
      -0.012,
      0,
    ),
  );

  build.add(
    mesh(
      plate(
        [
          [-0.05, -0.028],
          [0.05, -0.034],
          [0.055, 0.03],
          [-0.045, 0.036],
        ],
        0.014,
        0.004,
      ),
      MODEL_MAT.steel,
      0.028,
      0.035,
      -0.01,
    ),
  );
  // Cock.
  build.add(
    mesh(
      plate(
        [
          [0, -0.02],
          [0.022, -0.03],
          [0.03, 0.02],
          [0.008, 0.032],
        ],
        0.01,
        0.003,
      ),
      MODEL_MAT.gold,
      0.034,
      0.07,
      -0.02,
    ),
  );
  // Trigger guard.
  build.add(
    mesh(
      turned(
        [
          [0.03, -0.006],
          [0.038, 0],
          [0.03, 0.006],
        ],
        8,
      ),
      MODEL_MAT.darkIron,
      0,
      -0.06,
      -0.03,
    ),
  );

  const group = pointAway(build);
  group.add(lowPolyHand(0, -0.045, 0.05));
  return group;
}

// ------------------------------------------------------------------ torch

export interface TorchParts {
  group: THREE.Group;
  /** Flame layers, animated independently so the fire never looks static. */
  flameLayers: THREE.Mesh[];
  /** Empty marker at the flame's heart — where light and embers come from. */
  flameAnchor: THREE.Object3D;
  light: THREE.PointLight;
  /** Glowing coals at the top of the head. */
  coals: THREE.Mesh;
}

/**
 * A torch: tapered haft, bound rag head, layered flame.
 *
 * Deliberately chunky. The previous torch was slim enough that its flame read as
 * a speck, which made the light it cast look like it came from nowhere.
 */
export function torchModel(scale = 1): TorchParts {
  const group = new THREE.Group();
  const build = new THREE.Group();

  // Haft: tapered, with a visible grain of facets.
  build.add(
    mesh(
      sweep(ngon(7, 0.5), [
        { z: -0.02, sx: 0.045, sy: 0.045 },
        { z: 0.16, sx: 0.04, sy: 0.04 },
        { z: 0.3, sx: 0.05, sy: 0.05 },
      ]),
      MODEL_MAT.darkWood,
    ),
  );

  // Bound head: pitch-soaked rag, wider than the haft.
  build.add(
    mesh(
      sweep(ngon(8, 0.5), [
        { z: 0.28, sx: 0.07, sy: 0.07 },
        { z: 0.34, sx: 0.095, sy: 0.095 },
        { z: 0.4, sx: 0.085, sy: 0.085 },
      ]),
      MODEL_MAT.darkLeather,
    ),
  );
  // Binding cords.
  for (const z of [0.3, 0.37]) {
    build.add(
      mesh(
        turned(
          [
            [0.048, -0.008],
            [0.056, 0],
            [0.048, 0.008],
          ],
          8,
        ),
        MODEL_MAT.cloth,
        0,
        0,
        z,
      ),
    );
    const cord = build.children[build.children.length - 1];
    cord.rotation.x = Math.PI / 2;
  }

  // Glowing coals in the mouth of the head.
  const coals = mesh(
    turned(
      [
        [0, -0.012],
        [0.06, -0.008],
        [0.07, 0.008],
        [0, 0.014],
      ],
      8,
    ),
    new THREE.MeshBasicMaterial({ color: 0xff7a22 }),
    0,
    0,
    0.4,
  );
  build.add(coals);

  // Flame: three nested teardrops, animated at different rates.
  //
  // Lathed from a flame profile rather than built from cones. A six-sided cone
  // seen from the side is a triangle, and a translucent one reads as a flat orange
  // shard hanging over the torch — which is exactly how the first attempt looked.
  // A teardrop bulges near the coals and tapers to a licking tip, so the
  // silhouette is right from any angle.
  const flameLayers: THREE.Mesh[] = [];
  const layerSpec: Array<[THREE.Material, number, number, number]> = [
    [MODEL_MAT.flameOuter, 1.0, 1.0, 0.4],
    [MODEL_MAT.flameMid, 0.8, 0.84, 0.405],
    [MODEL_MAT.flameCore, 0.52, 0.62, 0.41],
  ];
  for (const [material, radiusScale, heightScale, z] of layerSpec) {
    const r = 0.058 * radiusScale;
    const h = 0.21 * heightScale;
    const geometry = turned(
      [
        [0, 0],
        [r * 0.55, h * 0.06],
        [r, h * 0.3],
        [r * 0.82, h * 0.58],
        [r * 0.4, h * 0.82],
        [0, h],
      ],
      10,
    );
    // Lathes turn about +Y; the torch runs along +Z.
    geometry.rotateX(Math.PI / 2);
    const layer = new THREE.Mesh(geometry, material);
    layer.position.set(0, 0, z);
    build.add(layer);
    flameLayers.push(layer);
  }

  const flameAnchor = new THREE.Object3D();
  flameAnchor.position.set(0, 0, 0.5);
  build.add(flameAnchor);

  const light = new THREE.PointLight(0xffa045, 1.6, 3.4, 2);
  light.position.set(0, 0, 0.5);
  build.add(light);

  // Stand it up: the torch is carried near-vertical, head up.
  build.rotation.x = -Math.PI / 2;
  group.add(build);
  group.add(lowPolyHand(0, -0.02, 0.03));
  group.scale.setScalar(scale);

  return { group, flameLayers, flameAnchor, light, coals };
}


/** A held block: still a cube, because that is what it is in the world. */
export function blockModel(color: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshLambertMaterial({ color, flatShading: true })));
  g.add(lowPolyHand(-0.05, -0.12, 0.08));
  return g;
}

export interface SpellParts {
  group: THREE.Group;
  orb: THREE.Mesh;
  light: THREE.PointLight;
}

/** An open palm with the spell gathering above it. */
export function spellModel(color: number): SpellParts {
  const group = new THREE.Group();

  const palm = sweep(ngon(6, 0.5), [
    { z: -0.05, sx: 0.11, sy: 0.05 },
    { z: 0.02, sx: 0.125, sy: 0.055 },
    { z: 0.08, sx: 0.1, sy: 0.045 },
  ]);
  group.add(mesh(palm, MODEL_MAT.skin, 0, -0.06, 0.02));
  for (let i = 0; i < 4; i++) {
    const finger = sweep(ngon(5, 0.5), [
      { z: 0, sx: 0.026, sy: 0.024 },
      { z: 0.06, sx: 0.022, sy: 0.02 },
    ]);
    const f = mesh(finger, MODEL_MAT.skin, -0.04 + i * 0.026, -0.05, -0.04);
    f.rotation.x = -0.5;
    group.add(f);
  }
  group.add(
    mesh(
      plate(
        [
          [-0.06, -0.03],
          [0.06, -0.03],
          [0.06, 0.03],
          [-0.06, 0.03],
        ],
        0.03,
        0.006,
      ),
      MODEL_MAT.cloth,
      0,
      -0.06,
      0.11,
    ),
  );

  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.08, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  orb.position.set(0, 0.03, -0.04);
  group.add(orb);

  const light = new THREE.PointLight(color, 1.2, 2.4, 2);
  light.position.copy(orb.position);
  group.add(light);

  return { group, orb, light };
}

/** Bare hands. */
export function fistModel(): THREE.Group {
  const g = new THREE.Group();
  const fist = sweep(ngon(6, 0.5), [
    { z: -0.06, sx: 0.1, sy: 0.105 },
    { z: 0, sx: 0.12, sy: 0.125 },
    { z: 0.06, sx: 0.105, sy: 0.11 },
  ]);
  g.add(mesh(fist, MODEL_MAT.skin));
  for (let i = 0; i < 4; i++) {
    const knuckle = turned(
      [
        [0, -0.022],
        [0.024, -0.012],
        [0.022, 0.012],
        [0, 0.02],
      ],
      6,
    );
    g.add(mesh(knuckle, MODEL_MAT.skin, -0.032 + i * 0.022, 0.04, -0.05));
  }
  g.add(
    mesh(
      sweep(ngon(6, 0.5), [
        { z: 0, sx: 0.095, sy: 0.1 },
        { z: 0.1, sx: 0.085, sy: 0.09 },
      ]),
      MODEL_MAT.cloth,
      0,
      -0.01,
      0.06,
    ),
  );
  return g;
}

/** A thrown bomb: a faceted iron sphere with a fuse. */
export function thrownModel(): THREE.Group {
  const g = new THREE.Group();
  g.add(
    mesh(
      turned(
        [
          [0, -0.09],
          [0.06, -0.07],
          [0.09, 0],
          [0.06, 0.07],
          [0, 0.085],
        ],
        8,
      ),
      MODEL_MAT.blackIron,
    ),
  );
  g.add(
    mesh(
      sweep(ngon(5, 0.5), [
        { z: 0, sx: 0.022, sy: 0.022 },
        { z: 0.07, sx: 0.016, sy: 0.016 },
      ]),
      MODEL_MAT.cloth,
      0,
      0.09,
      0,
    ),
  );
  const fuse = g.children[g.children.length - 1];
  fuse.rotation.x = -Math.PI / 2 + 0.3;
  g.add(lowPolyHand(0, -0.07, 0.06));
  return g;
}
