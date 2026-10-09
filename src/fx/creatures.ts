import * as THREE from 'three';
import { mesh, ngon, plate, sweep, tube, turned } from './models';

/**
 * Low-poly enemy models.
 *
 * Every enemy used to be the same five boxes — torso, head, two arms, two legs —
 * recoloured and rescaled per archetype. That made a goblin, a skeleton and an ogre
 * the same creature in different paint, so the one thing a player most needs to read
 * at a glance (what is running at me, and how dangerous is it?) carried no
 * information beyond size and hue.
 *
 * Each archetype now has its own silhouette: goblins are hunched and spindly with
 * ears and a snout, orcs are barrel-chested with tusks, skeletons show ribs through
 * the chest, cultists are a robe with no visible legs, the ogre is a potbellied
 * slab, and the spider is a bulb on eight legs.
 *
 * ## The animation contract
 *
 * `Enemy` rotates four pivot groups about X to walk and to telegraph attacks, so
 * every creature must supply them, however little sense they make for its anatomy.
 * Creatures with more than two legs report them all through `legs`, each with a gait
 * phase, and the caller drives those instead of the two named ones.
 */

export interface CreatureLeg {
  pivot: THREE.Group;
  /** Offset into the gait cycle, in radians. */
  phase: number;
}

export interface CreatureParts {
  group: THREE.Group;
  /** The attacking limb. `Enemy` swings this one through the telegraph. */
  rightArm: THREE.Group;
  leftArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  /** Every leg, for gaits with more than two. */
  legs: CreatureLeg[];
  /** Standing height in world units, before the archetype's scale multiplier. */
  height: number;
}

interface Palette {
  body: THREE.MeshLambertMaterial;
  head: THREE.MeshLambertMaterial;
  accent: THREE.MeshLambertMaterial;
  dark: THREE.MeshLambertMaterial;
  bone: THREE.MeshLambertMaterial;
  eye: THREE.MeshBasicMaterial;
}

/**
 * Orientation helpers.
 *
 * Parts are modelled along +Z (the convention the geometry toolkit uses) and then
 * turned to face the right way. Doing that with bare Euler numbers at each call
 * site got the sign wrong repeatedly — a goblin's torso grew downwards out of its
 * hips — because which way +Z ends up depends on the sign of the rotation and it is
 * easy to talk yourself into either. These name the intent instead.
 *
 * Creatures face -Z, matching the enemy's yaw convention.
 */
/** Stands a part upright, extending up from its origin. `lean` tips it forward. */
function standUp(part: THREE.Object3D, lean = 0): void {
  part.rotation.x = -Math.PI / 2 + lean;
}

/** Hangs a part downward from its origin — cloaks, loincloths. */
function hangDown(part: THREE.Object3D): void {
  part.rotation.x = Math.PI / 2;
}

/** Points a part forward, the way the creature faces. */
function faceForward(part: THREE.Object3D): void {
  part.rotation.y = Math.PI;
}

/** Lays a part along the body's long axis — abdomens, banding rings. */
function alongBody(part: THREE.Object3D): void {
  part.rotation.x = Math.PI / 2;
}

/**
 * A limb as a pivot with its geometry hanging below the joint.
 *
 * Rotation therefore happens at the shoulder or hip rather than through the middle
 * of the limb, which is the difference between an arm swinging and an arm sliding.
 */
function limb(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  drop: number,
): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const part = mesh(geometry, material);
  part.position.y = -drop;
  pivot.add(part);
  return pivot;
}

/** A tapered limb segment running downwards, built along +Z then stood up. */
function limbGeometry(length: number, top: number, bottom: number): THREE.BufferGeometry {
  const geometry = sweep(ngon(6, 0.5), [
    { z: -length / 2, sx: top, sy: top },
    { z: 0, sx: (top + bottom) * 0.5, sy: (top + bottom) * 0.5 },
    { z: length / 2, sx: bottom, sy: bottom },
  ]);
  // Sweeps run along +Z; limbs hang along Y.
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** A blocky foot or hand, pointing forward (-Z). */
function extremity(width: number, length: number, material: THREE.Material, y: number): THREE.Mesh {
  const geometry = sweep(ngon(6, 0.5), [
    { z: 0, sx: width, sy: width * 0.7 },
    { z: length, sx: width * 0.8, sy: width * 0.55 },
  ]);
  geometry.rotateY(Math.PI);
  return mesh(geometry, material, 0, y, -length * 0.35);
}

/** Two glowing eyes. */
function eyes(palette: Palette, spread: number, y: number, z: number, size: number): THREE.Group {
  const g = new THREE.Group();
  for (const sign of [1, -1]) {
    g.add(mesh(turned([[0, -size], [size, 0], [0, size]], 6), palette.eye, sign * spread, y, z));
  }
  return g;
}

// ------------------------------------------------------------------ goblin

/**
 * Hunched, spindly, and top-heavy: a long snout, big swept ears, arms that hang
 * past the knees. Reads as opportunistic rather than threatening.
 */
function goblin(palette: Palette, skirmisher: boolean): CreatureParts {
  const g = new THREE.Group();

  // Torso, leaning forward so the shoulders sit ahead of the hips.
  const torso = mesh(
    sweep(ngon(7, 0.5), [
      { z: 0, sx: 0.34, sy: 0.24 },
      { z: 0.3, sx: 0.44, sy: 0.3 },
      { z: 0.62, sx: 0.4, sy: 0.27 },
    ]),
    palette.body,
    0,
    0.82,
    0,
  );
  // Leaning forward, so the shoulders sit ahead of the hips.
  standUp(torso, 0.26);
  g.add(torso);

  // Loincloth.
  g.add(mesh(sweep(ngon(6, 0.5), [{ z: 0, sx: 0.4, sy: 0.3 }, { z: 0.22, sx: 0.32, sy: 0.24 }]), palette.accent, 0, 0.78, 0.02));
  const cloth = g.children[g.children.length - 1];
  hangDown(cloth);

  // Head: skull, long snout, swept ears.
  const head = new THREE.Group();
  head.position.set(0, 1.38, -0.12);
  head.add(mesh(turned([[0, -0.17], [0.15, -0.1], [0.18, 0.04], [0.1, 0.16], [0, 0.19]], 7), palette.head));
  const snout = mesh(
    sweep(ngon(6, 0.5), [
      { z: 0, sx: 0.13, sy: 0.11 },
      { z: 0.2, sx: 0.05, sy: 0.05 },
    ], 0.26),
    palette.head,
    0,
    -0.02,
    0,
  );
  faceForward(snout);
  snout.position.z = -0.06;
  head.add(snout);
  for (const sign of [1, -1]) {
    const ear = plate([[0, -0.05], [0.26, -0.13], [0.3, 0.02], [0.05, 0.09]], 0.02, 0.004);
    const earMesh = mesh(ear, palette.head, sign * 0.15, 0.06, 0.02);
    earMesh.rotation.y = sign * 0.5;
    earMesh.rotation.z = sign * -0.3;
    earMesh.scale.x = sign;
    head.add(earMesh);
  }
  head.add(eyes(palette, 0.075, 0.04, -0.14, 0.032));
  g.add(head);

  // Limbs. Long arms, bandy legs.
  const rightArm = limb(limbGeometry(0.62, 0.075, 0.055), palette.body, -0.3, 1.16, 0, 0.31);
  const leftArm = limb(limbGeometry(0.62, 0.075, 0.055), palette.body, 0.3, 1.16, 0, 0.31);
  rightArm.add(extremity(0.09, 0.14, palette.head, -0.62));
  leftArm.add(extremity(0.09, 0.14, palette.head, -0.62));
  const leftLeg = limb(limbGeometry(0.66, 0.1, 0.07), palette.accent, 0.14, 0.72, 0, 0.33);
  const rightLeg = limb(limbGeometry(0.66, 0.1, 0.07), palette.accent, -0.14, 0.72, 0, 0.33);
  leftLeg.add(extremity(0.11, 0.2, palette.head, -0.66));
  rightLeg.add(extremity(0.11, 0.2, palette.head, -0.66));
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // A weapon that matches how the archetype actually fights.
  if (skirmisher) {
    const shaft = mesh(limbGeometry(1.1, 0.032, 0.028), palette.dark, 0, -0.58, 0);
    shaft.rotation.x = 1.45;
    rightArm.add(shaft);
    const point = mesh(
      sweep(ngon(6, 0.5), [{ z: 0, sx: 0.05, sy: 0.05 }, { z: 0.1, sx: 0.03, sy: 0.03 }], 0.16),
      palette.bone,
      0,
      -0.58,
      -0.56,
    );
    point.rotation.x = -Math.PI / 2;
    rightArm.add(point);
  } else {
    const club = mesh(
      sweep(ngon(6, 0.5), [
        { z: 0, sx: 0.045, sy: 0.045 },
        { z: 0.5, sx: 0.075, sy: 0.075 },
        { z: 0.62, sx: 0.065, sy: 0.065 },
      ]),
      palette.dark,
      0,
      -0.6,
      -0.1,
    );
    club.rotation.x = -1.15;
    rightArm.add(club);
  }

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 1.6 };
}

// ------------------------------------------------------------------ bandit

/** A human outlaw: hood, cloak, and a bow held across the body. */
function bandit(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  g.add(
    standingTorso(palette.body, 0.95, [
      { z: 0, sx: 0.36, sy: 0.24 },
      { z: 0.36, sx: 0.46, sy: 0.28 },
      { z: 0.72, sx: 0.42, sy: 0.26 },
    ]),
  );
  // Cloak: a tapered shell hanging off the shoulders.
  const cloak = mesh(
    sweep(ngon(8, 0.5), [
      { z: 0, sx: 0.5, sy: 0.34 },
      { z: 0.6, sx: 0.58, sy: 0.4 },
    ]),
    palette.accent,
    0,
    1.52,
    0.06,
  );
  hangDown(cloak);
  g.add(cloak);

  const head = new THREE.Group();
  head.position.set(0, 1.62, 0);
  head.add(mesh(turned([[0, -0.15], [0.14, -0.08], [0.15, 0.06], [0, 0.17]], 7), palette.head));
  // Hood: a cone open at the front.
  const hood = mesh(turned([[0.19, -0.14], [0.2, 0.0], [0.11, 0.14], [0, 0.2]], 8), palette.accent, 0, 0.03, 0.03);
  head.add(hood);
  head.add(eyes(palette, 0.06, 0.0, -0.13, 0.026));
  g.add(head);

  const rightArm = limb(limbGeometry(0.6, 0.085, 0.06), palette.body, -0.32, 1.38, 0, 0.3);
  const leftArm = limb(limbGeometry(0.6, 0.085, 0.06), palette.body, 0.32, 1.38, 0, 0.3);
  const leftLeg = limb(limbGeometry(0.76, 0.12, 0.085), palette.dark, 0.15, 0.8, 0, 0.38);
  const rightLeg = limb(limbGeometry(0.76, 0.12, 0.085), palette.dark, -0.15, 0.8, 0, 0.38);
  leftLeg.add(extremity(0.12, 0.22, palette.dark, -0.76));
  rightLeg.add(extremity(0.12, 0.22, palette.dark, -0.76));
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // Bow in the leading hand, curved rather than stepped.
  const bow = mesh(
    tube(
      [
        new THREE.Vector3(0, 0.44, 0.06),
        new THREE.Vector3(0, 0.22, -0.04),
        new THREE.Vector3(0, 0, -0.07),
        new THREE.Vector3(0, -0.22, -0.04),
        new THREE.Vector3(0, -0.44, 0.06),
      ],
      0.022,
      12,
    ),
    palette.dark,
    0,
    -0.58,
    -0.05,
  );
  leftArm.add(bow);
  // Quiver on the back.
  const quiver = mesh(limbGeometry(0.4, 0.07, 0.06), palette.dark, 0.16, 1.2, 0.2);
  quiver.rotation.x = 0.4;
  quiver.rotation.z = -0.3;
  g.add(quiver);

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 1.85 };
}

// ------------------------------------------------------------------ orc

/** Barrel-chested, tusked, with a head sunk between huge shoulders. */
function orc(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  g.add(
    standingTorso(palette.body, 0.86, [
      { z: 0, sx: 0.46, sy: 0.32 },
      { z: 0.4, sx: 0.66, sy: 0.42 },
      { z: 0.78, sx: 0.58, sy: 0.38 },
    ]),
  );

  const head = new THREE.Group();
  // Sunk low and pushed forward — no neck to speak of.
  head.position.set(0, 1.5, -0.12);
  head.add(mesh(turned([[0, -0.18], [0.19, -0.1], [0.21, 0.05], [0.12, 0.16], [0, 0.18]], 7), palette.head));
  // Heavy jaw.
  const jaw = mesh(
    sweep(ngon(6, 0.5), [
      { z: 0, sx: 0.26, sy: 0.14 },
      { z: 0.16, sx: 0.2, sy: 0.11 },
    ]),
    palette.head,
    0,
    -0.09,
    -0.06,
  );
  faceForward(jaw);
  head.add(jaw);
  // Tusks, curving up out of the jaw.
  for (const sign of [1, -1]) {
    const tusk = mesh(
      sweep(ngon(5, 0.5), [{ z: 0, sx: 0.035, sy: 0.035 }, { z: 0.12, sx: 0.018, sy: 0.018 }], 0.18),
      palette.bone,
      sign * 0.1,
      -0.1,
      -0.14,
    );
    tusk.rotation.x = -2.0;
    tusk.rotation.z = sign * 0.2;
    head.add(tusk);
  }
  head.add(eyes(palette, 0.085, 0.04, -0.17, 0.03));
  g.add(head);

  // Thick arms, hanging low.
  const rightArm = limb(limbGeometry(0.72, 0.14, 0.11), palette.body, -0.46, 1.32, 0, 0.36);
  const leftArm = limb(limbGeometry(0.72, 0.14, 0.11), palette.body, 0.46, 1.32, 0, 0.36);
  rightArm.add(extremity(0.15, 0.2, palette.head, -0.72));
  leftArm.add(extremity(0.15, 0.2, palette.head, -0.72));
  const leftLeg = limb(limbGeometry(0.7, 0.16, 0.12), palette.accent, 0.2, 0.74, 0, 0.35);
  const rightLeg = limb(limbGeometry(0.7, 0.16, 0.12), palette.accent, -0.2, 0.74, 0, 0.35);
  leftLeg.add(extremity(0.17, 0.26, palette.accent, -0.7));
  rightLeg.add(extremity(0.17, 0.26, palette.accent, -0.7));
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // A crude cleaver.
  const blade = mesh(
    plate([[0, -0.1], [0.12, -0.3], [0.2, -0.1], [0.19, 0.24], [0, 0.3]], 0.035, 0.008),
    palette.bone,
    0,
    -0.78,
    -0.1,
  );
  blade.rotation.y = Math.PI / 2;
  blade.rotation.x = 0.2;
  rightArm.add(blade);

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 1.9 };
}

// ------------------------------------------------------------------ skeleton

/** Ribs, a skull, and a helmet: unmistakably the thing maces are for. */
function skeleton(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  // Spine and pelvis instead of a solid torso.
  g.add(mesh(limbGeometry(0.66, 0.06, 0.05), palette.bone, 0, 1.36, 0));
  g.add(mesh(turned([[0, -0.1], [0.22, -0.04], [0.2, 0.06], [0, 0.1]], 7), palette.bone, 0, 0.9, 0));
  // Ribs: paired arcs down the chest, which is the whole silhouette.
  for (let i = 0; i < 4; i++) {
    const y = 1.34 - i * 0.12;
    const span = 0.3 - i * 0.022;
    const rib = mesh(
      tube(
        [
          new THREE.Vector3(-span, 0.02, 0.06),
          new THREE.Vector3(-span * 0.7, 0, -0.14),
          new THREE.Vector3(0, -0.03, -0.19),
          new THREE.Vector3(span * 0.7, 0, -0.14),
          new THREE.Vector3(span, 0.02, 0.06),
        ],
        0.022,
        10,
      ),
      palette.bone,
      0,
      y,
      0.04,
    );
    g.add(rib);
  }
  // Shoulder yoke.
  g.add(mesh(limbGeometry(0.72, 0.045, 0.045), palette.bone, 0, 1.46, 0.02));
  const yoke = g.children[g.children.length - 1];
  yoke.rotation.z = Math.PI / 2;

  const head = new THREE.Group();
  head.position.set(0, 1.62, 0);
  head.add(mesh(turned([[0, -0.14], [0.14, -0.08], [0.15, 0.05], [0, 0.15]], 7), palette.bone));
  // Jaw and eye sockets.
  const jaw = mesh(sweep(ngon(6, 0.5), [{ z: 0, sx: 0.2, sy: 0.1 }, { z: 0.12, sx: 0.15, sy: 0.08 }]), palette.bone, 0, -0.08, -0.05);
  faceForward(jaw);
  head.add(jaw);
  head.add(eyes(palette, 0.06, 0.01, -0.12, 0.032));
  // Helmet: a bowl with a nasal bar.
  head.add(mesh(turned([[0.17, -0.06], [0.17, 0.04], [0.1, 0.14], [0, 0.18]], 8), palette.accent, 0, 0.05, 0));
  head.add(mesh(plate([[-0.022, -0.12], [0.022, -0.12], [0.022, 0.05], [-0.022, 0.05]], 0.02, 0.004), palette.accent, 0, -0.02, -0.15));
  g.add(head);

  const rightArm = limb(limbGeometry(0.6, 0.05, 0.04), palette.bone, -0.34, 1.44, 0, 0.3);
  const leftArm = limb(limbGeometry(0.6, 0.05, 0.04), palette.bone, 0.34, 1.44, 0, 0.3);
  const leftLeg = limb(limbGeometry(0.8, 0.07, 0.05), palette.bone, 0.13, 0.86, 0, 0.4);
  const rightLeg = limb(limbGeometry(0.8, 0.07, 0.05), palette.bone, -0.13, 0.86, 0, 0.4);
  leftLeg.add(extremity(0.1, 0.2, palette.bone, -0.8));
  rightLeg.add(extremity(0.1, 0.2, palette.bone, -0.8));
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // A straight sword.
  const sword = mesh(
    sweep(
      [[-0.5, 0], [-0.25, 0.5], [0.25, 0.5], [0.5, 0], [0.25, -0.5], [-0.25, -0.5]],
      [
        { z: 0, sx: 0.07, sy: 0.025 },
        { z: 0.55, sx: 0.05, sy: 0.02 },
      ],
      0.66,
    ),
    palette.head,
    0,
    -0.62,
    0,
  );
  sword.rotation.x = -Math.PI / 2 + 0.25;
  rightArm.add(sword);
  rightArm.add(mesh(limbGeometry(0.18, 0.02, 0.02), palette.accent, 0, -0.62, -0.03));
  const guard = rightArm.children[rightArm.children.length - 1];
  guard.rotation.z = Math.PI / 2;

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 1.85 };
}

// ------------------------------------------------------------------ cultist

/** A robe with no legs showing, a deep empty hood, and a staff. */
function cultist(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  // The robe *is* the body: one tapered shell to the floor.
  const robe = mesh(
    sweep(ngon(9, 0.5), [
      { z: 0, sx: 0.66, sy: 0.6 },
      { z: 0.5, sx: 0.5, sy: 0.46 },
      { z: 1.0, sx: 0.44, sy: 0.36 },
      { z: 1.4, sx: 0.4, sy: 0.32 },
    ]),
    palette.body,
    0,
    0.02,
    0,
  );
  standUp(robe);
  g.add(robe);
  // A sash at the waist.
  const sash = mesh(turned([[0.42, -0.04], [0.46, 0], [0.42, 0.04]], 9), palette.accent, 0, 0.86, 0);
  g.add(sash);

  const head = new THREE.Group();
  head.position.set(0, 1.52, 0);
  // Hood: deep, and the face inside it is shadow with two lights in it.
  head.add(mesh(turned([[0, -0.2], [0.21, -0.12], [0.23, 0.02], [0.13, 0.16], [0, 0.21]], 8), palette.body));
  head.add(mesh(turned([[0, -0.02], [0.15, -0.02], [0.13, 0.06], [0, 0.06]], 8), palette.dark, 0, -0.02, -0.11));
  head.add(eyes(palette, 0.055, 0.0, -0.17, 0.028));
  g.add(head);

  // Sleeves rather than bare arms.
  const rightArm = limb(limbGeometry(0.58, 0.11, 0.07), palette.body, -0.34, 1.3, 0, 0.29);
  const leftArm = limb(limbGeometry(0.58, 0.11, 0.07), palette.body, 0.34, 1.3, 0, 0.29);
  rightArm.add(extremity(0.08, 0.12, palette.head, -0.58));
  leftArm.add(extremity(0.08, 0.12, palette.head, -0.58));
  // Legs exist only to satisfy the animation contract; the robe hides them.
  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  leftLeg.position.set(0.12, 0.6, 0);
  rightLeg.position.set(-0.12, 0.6, 0);
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // Staff with a glowing head, so the caster telegraph has something to swing.
  const staff = mesh(limbGeometry(1.3, 0.03, 0.026), palette.dark, 0, -0.5, 0);
  staff.rotation.x = 0.1;
  rightArm.add(staff);
  const crystal = mesh(turned([[0, -0.09], [0.06, 0], [0, 0.11]], 6), palette.eye, 0, -1.12, 0.06);
  rightArm.add(crystal);

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 1.8 };
}

// ------------------------------------------------------------------ ogre

/** A potbellied slab with a tiny head and arms that reach the ground. */
function ogre(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  // Enormous gut, narrow shoulders by comparison.
  const belly = mesh(
    sweep(ngon(8, 0.5), [
      { z: 0, sx: 0.6, sy: 0.5 },
      { z: 0.42, sx: 0.86, sy: 0.72 },
      { z: 0.86, sx: 0.78, sy: 0.6 },
      { z: 1.1, sx: 0.6, sy: 0.46 },
    ]),
    palette.body,
    0,
    0.6,
    0.04,
  );
  standUp(belly);
  g.add(belly);
  // A hide strap over one shoulder.
  const strap = mesh(plate([[-0.1, -0.5], [0.1, -0.5], [0.1, 0.5], [-0.1, 0.5]], 0.05, 0.01), palette.accent, 0.1, 1.2, -0.42);
  strap.rotation.z = 0.4;
  g.add(strap);

  const head = new THREE.Group();
  head.position.set(0, 1.78, -0.06);
  head.add(mesh(turned([[0, -0.16], [0.17, -0.08], [0.18, 0.06], [0, 0.16]], 7), palette.head));
  // Underbite and a squashed brow.
  const jaw = mesh(sweep(ngon(6, 0.5), [{ z: 0, sx: 0.24, sy: 0.12 }, { z: 0.14, sx: 0.2, sy: 0.1 }]), palette.head, 0, -0.08, -0.06);
  faceForward(jaw);
  head.add(jaw);
  head.add(mesh(plate([[-0.18, -0.03], [0.18, -0.03], [0.18, 0.04], [-0.18, 0.04]], 0.1, 0.01), palette.head, 0, 0.07, -0.1));
  head.add(eyes(palette, 0.07, 0.0, -0.15, 0.028));
  g.add(head);

  const rightArm = limb(limbGeometry(0.95, 0.18, 0.13), palette.body, -0.6, 1.5, 0, 0.48);
  const leftArm = limb(limbGeometry(0.95, 0.18, 0.13), palette.body, 0.6, 1.5, 0, 0.48);
  rightArm.add(extremity(0.2, 0.26, palette.head, -0.95));
  leftArm.add(extremity(0.2, 0.26, palette.head, -0.95));
  const leftLeg = limb(limbGeometry(0.62, 0.22, 0.17), palette.accent, 0.26, 0.66, 0, 0.31);
  const rightLeg = limb(limbGeometry(0.62, 0.22, 0.17), palette.accent, -0.26, 0.66, 0, 0.31);
  leftLeg.add(extremity(0.23, 0.3, palette.head, -0.62));
  rightLeg.add(extremity(0.23, 0.3, palette.head, -0.62));
  g.add(rightArm, leftArm, leftLeg, rightLeg);

  // A tree-trunk club.
  const club = mesh(
    sweep(ngon(7, 0.5), [
      { z: 0, sx: 0.07, sy: 0.07 },
      { z: 0.7, sx: 0.15, sy: 0.15 },
      { z: 0.9, sx: 0.13, sy: 0.13 },
    ]),
    palette.dark,
    0,
    -0.95,
    -0.1,
  );
  club.rotation.x = -1.2;
  rightArm.add(club);

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: pair(leftLeg, rightLeg), height: 2.15 };
}

// ------------------------------------------------------------------ spider

/**
 * A bulbous abdomen slung behind a low thorax, on eight jointed legs.
 *
 * All eight legs are reported through `legs` with alternating phases, so the gait
 * is a proper alternating tetrapod rather than two legs waving while six stay put.
 */
function spider(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  // Abdomen: the big banded bulb at the back.
  const abdomen = mesh(
    turned([[0, -0.3], [0.2, -0.22], [0.3, -0.02], [0.27, 0.16], [0.14, 0.28], [0, 0.32]], 9),
    palette.body,
    0,
    0.52,
    0.4,
  );
  alongBody(abdomen);
  g.add(abdomen);
  // Banding, as raised rings.
  for (let i = 0; i < 3; i++) {
    const ring = mesh(turned([[0.2 - i * 0.03, -0.02], [0.24 - i * 0.03, 0], [0.2 - i * 0.03, 0.02]], 9), palette.accent, 0, 0.52, 0.28 + i * 0.16);
    alongBody(ring);
    g.add(ring);
  }

  // Thorax and head, low and forward.
  const thorax = mesh(turned([[0, -0.16], [0.16, -0.1], [0.19, 0.04], [0, 0.17]], 8), palette.head, 0, 0.44, -0.02);
  alongBody(thorax);
  g.add(thorax);
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.42, -0.26);
  headGroup.add(mesh(turned([[0, -0.11], [0.12, -0.05], [0.12, 0.05], [0, 0.11]], 7), palette.head));
  // Eight small eyes in two rows, which is what makes it read as a spider.
  for (const row of [0, 1]) {
    for (const sign of [1, -1]) {
      for (const offset of [0.035, 0.085]) {
        headGroup.add(
          mesh(turned([[0, -0.018], [0.018, 0], [0, 0.018]], 5), palette.eye, sign * offset, 0.03 - row * 0.05, -0.1),
        );
      }
    }
  }
  // Fangs.
  for (const sign of [1, -1]) {
    const fang = mesh(sweep(ngon(5, 0.5), [{ z: 0, sx: 0.03, sy: 0.03 }, { z: 0.06, sx: 0.015, sy: 0.015 }], 0.1), palette.dark, sign * 0.05, -0.08, -0.08);
    fang.rotation.x = -2.4;
    headGroup.add(fang);
  }
  g.add(headGroup);

  // Eight legs: four a side, splayed forward to back, each a jointed tube that
  // rises from the body and comes back down to the ground.
  const legs: CreatureLeg[] = [];
  const named: THREE.Group[] = [];
  for (const sign of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const spreadZ = -0.24 + i * 0.2;
      const pivot = new THREE.Group();
      pivot.position.set(sign * 0.16, 0.46, spreadZ);
      const reach = 0.42 + (i === 1 || i === 2 ? 0.1 : 0);
      const knee = new THREE.Vector3(sign * reach * 0.7, 0.26, spreadZ * 0.3);
      const foot = new THREE.Vector3(sign * reach, -0.46, spreadZ * 0.5);
      pivot.add(
        mesh(
          tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(sign * reach * 0.3, 0.18, 0), knee, foot], 0.028, 10),
          palette.accent,
        ),
      );
      g.add(pivot);
      // Diagonal pairs move together, which is how an eight-legged gait reads.
      legs.push({ pivot, phase: ((i % 2) + (sign > 0 ? 0 : 1)) * Math.PI });
      named.push(pivot);
    }
  }

  return {
    group: g,
    // No arms. The front legs stand in, so the attack telegraph rears them up.
    rightArm: named[0],
    leftArm: named[4],
    leftLeg: named[5],
    rightLeg: named[1],
    legs,
    height: 0.95,
  };
}

// ------------------------------------------------------------------ fish

/** A tapered body with a beating tail. */
function fish(palette: Palette): CreatureParts {
  const g = new THREE.Group();

  const bodyGeometry = sweep(ngon(7, 0.5), [
    { z: -0.5, sx: 0.12, sy: 0.16 },
    { z: -0.25, sx: 0.3, sy: 0.38 },
    { z: 0.1, sx: 0.34, sy: 0.44 },
    { z: 0.45, sx: 0.16, sy: 0.24 },
  ]);
  g.add(mesh(bodyGeometry, palette.body, 0, 0, 0));
  // Snout.
  g.add(mesh(sweep(ngon(6, 0.5), [{ z: 0, sx: 0.12, sy: 0.16 }, { z: 0.14, sx: 0.05, sy: 0.07 }], 0.2), palette.head, 0, 0, -0.5));
  const snout = g.children[g.children.length - 1];
  faceForward(snout);
  g.add(mesh(turned([[0, -0.03], [0.045, 0], [0, 0.03]], 6), palette.eye, 0.11, 0.06, -0.34));
  g.add(mesh(turned([[0, -0.03], [0.045, 0], [0, 0.03]], 6), palette.eye, -0.11, 0.06, -0.34));

  // Dorsal fin.
  const dorsal = mesh(plate([[0, 0], [0.3, 0.1], [0.42, 0.26], [0.04, 0.2]], 0.02, 0.004), palette.accent, 0, 0.2, -0.02);
  dorsal.rotation.y = Math.PI / 2;
  g.add(dorsal);

  // The tail is its own pivot so it can beat while swimming.
  const rightArm = new THREE.Group();
  rightArm.position.z = 0.44;
  const tail = mesh(plate([[0, 0], [0.26, 0.24], [0.3, -0.02], [0.26, -0.26]], 0.025, 0.005), palette.accent, 0, 0, 0.12);
  tail.rotation.y = Math.PI / 2;
  rightArm.add(tail);
  g.add(rightArm);

  const leftArm = new THREE.Group();
  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  g.add(leftArm, leftLeg, rightLeg);

  return { group: g, rightArm, leftArm, leftLeg, rightLeg, legs: [], height: 0.5 };
}

// ------------------------------------------------------------------ shared

/** A torso standing upright, built along +Z and stood on its end. */
function standingTorso(material: THREE.Material, baseY: number, stations: Array<{ z: number; sx: number; sy: number }>): THREE.Mesh {
  const torso = mesh(sweep(ngon(7, 0.5), stations), material, 0, baseY, 0);
  standUp(torso);
  return torso;
}

function pair(left: THREE.Group, right: THREE.Group): CreatureLeg[] {
  return [
    { pivot: left, phase: 0 },
    { pivot: right, phase: Math.PI },
  ];
}

// ------------------------------------------------------------------ factory

/**
 * Builds the model for an archetype.
 *
 * Unknown ids fall back to the bandit, which is the most generic humanoid — a new
 * archetype gets a plausible body rather than an invisible one.
 */
export function buildCreature(
  archetypeId: string,
  colors: { body: number; head: number; accent: number },
  materials: THREE.MeshLambertMaterial[],
): CreatureParts {
  // Materials are cloned per enemy so a hit can flash one without flashing all.
  const track = <T extends THREE.MeshLambertMaterial>(m: T): T => {
    materials.push(m);
    return m;
  };
  const lambert = (color: number) => track(new THREE.MeshLambertMaterial({ color, flatShading: true }));

  const bodyColor = new THREE.Color(colors.body);
  const palette: Palette = {
    body: lambert(colors.body),
    head: lambert(colors.head),
    accent: lambert(colors.accent),
    // Derived, so every creature gets a matching shadow tone without the
    // archetype table having to name one.
    dark: lambert(bodyColor.clone().multiplyScalar(0.55).getHex()),
    bone: lambert(0xdcd6c4),
    eye: new THREE.MeshBasicMaterial({ color: 0xff8a3a }),
  };

  switch (archetypeId) {
    case 'goblin_grunt':
      return goblin(palette, false);
    case 'goblin_skirmisher':
      return goblin(palette, true);
    case 'orc_brute':
      return orc(palette);
    case 'skeleton_knight':
      return skeleton(palette);
    case 'cultist':
      return cultist(palette);
    case 'ogre':
      return ogre(palette);
    case 'giant_spider':
      return spider(palette);
    case 'river_fish':
      return fish(palette);
    default:
      return bandit(palette);
  }
}
