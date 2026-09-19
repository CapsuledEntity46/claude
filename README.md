# VoxelQuest

A browser voxel action-RPG. Mine and build a procedurally generated world, then
fight what comes out of it in real time — with melee that changes depending on
the *shape* of your weapon, black-powder firearms, thrown explosives, and spells
drawn from a limited pool of spell slots.

No classes. You level by collecting EXP orbs and spend the points however you
like, so your "build" is just what you chose to invest in.

```bash
npm install
npm run dev     # then open the printed localhost URL
```

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move · `Space` jump / swim up · `Shift` sprint |
| Mouse | Look (click the canvas to capture the pointer) |
| `LMB` | Attack, cast, throw, use — or mine, when a block or torch is selected |
| `RMB` | Guard · place a block · **aim** a bow or grenade · open a door |
| `X` | Switch swing / thrust, or cycle the build tool's shape |
| `R` | Reload a firearm, or sample a block with the build tool |
| `1`–`8` / wheel | Hotbar |
| `Tab` | Character sheet: stats, attribute points, equipment, bag |
| `F5` / `F9` | Save / load · `Esc` pause |

You can see what you are holding. Weapons, torches, shields, spells, and blocks
all have a first-person model, and a swing sweeps a wide arc across the screen
while a thrust drives straight down the centre — the two motions are meant to be
distinguishable without reading the HUD.

## The central idea: weapon geometry decides how you can attack

A weapon's available attack modes follow from its shape, and each mode deals a
different damage type:

| Weapon | Swing | Thrust | Why |
| --- | :-: | :-: | --- |
| Sword, dagger, halberd | ● | ● | Sharp along the edge *and* pointed at the tip |
| Mace, warhammer, battleaxe | ● | — | No point to thrust with |
| Spear, rapier | — | ● | Nothing worth calling an edge |

- **Swings** sweep a wide arc, hit several enemies, and deal slashing or blunt
  damage. They barely get past armour.
- **Thrusts** commit along a narrow line, reach further, hit one target, crit more
  often, and **bypass about half of the target's armour**.

## Armour, and why the choice matters

Armour resists damage types unevenly, so there is no single best weapon:

| Armour | Armor | vs Slash | vs Pierce | vs Blunt |
| --- | :-: | :-: | :-: | :-: |
| Quilted | 2 | −10% | — | **−25%** |
| Leather | 4 | −30% | −10% | −15% |
| Iron plate | 7 | **−45%** | −35% | **+25% taken** |

Iron plate is the best armour in the game against blades and the *worst* against
a hammer: rigid plate transmits impact to the body instead of absorbing it. That
is modelled two ways — a negative blunt resistance, and an `armorFactor` that
makes only a quarter of plate's flat armour value apply to blunt damage. A
percentage resistance alone cannot express it, because the flat term is large
enough to swamp any sane negative percentage.

The practical consequence, from `npm run test:unit`:

```
a mace out-damages a longsword swing against iron plate — mace 8.4 vs sword-swing 1
thrusting beats swinging against iron plate            — thrust 4 vs swing 1
swinging beats thrusting against unarmoured targets    — swing 13 vs thrust 11
plate is the worst armour against blunt force          — vs plate 8.4 > vs quilted 7.1
```

So: **sword for the unarmoured, mace for the armoured, thrust when you have
neither.** The Skeleton Knight deliberately mirrors iron plate, to teach this.

Better armour comes from killing higher-level enemies. Plate only drops from
level 7 and up.

## Ranged, explosives, and spells

- **Bows** charge while you hold the button; loosing early wastes the shot.
- **Crossbows** fire instantly and then take ~2s to crank back.
- **Flintlock, musket, blunderbuss** — one shot, a long reload, heavy armour
  penetration, and loud enough to pull every enemy within 46 blocks onto you.
- **Grenades** bounce, cook for ~2.6s, and blow a hole in the terrain. They do
  not care who threw them.
- **Aiming** — hold right-click with a bow or a grenade to zoom in and see a
  dotted arc showing exactly where the shot will land. The preview is traced with
  the projectile's own integration, so it cannot disagree with the real shot. A
  crossbow is excluded on purpose: it is held at tension and fires flat.

## Magic: mana and spell slots

Two separate resources, for two different kinds of spell.

**Mana spells** are what you actually fight with. You start with three, and mana
has *no passive regeneration* — the only sources are potions and the mana orbs
enemies drop, with casters carrying the most. That makes casting a resource you
manage rather than a cooldown you wait out.

| Spell | Cost | Effect |
| --- | --- | --- |
| Flames | 14/sec, held | A cone of fire that leaves targets burning |
| Sparks | 16/sec, held | A tight arc of lightning with a chance to stun rigid |
| Healing | 11/sec, held | Channels health back into you |
| Fire Dart | 20 | A fast bolt that hits harder than Flames and keeps its distance |
| Oakflesh | 32 | +14 armor for a minute — vital if you travel light |

**Slot spells** stay rationed for the powerful ones: Arcane Nova, Chain Lightning,
Stoneskin, and the Meteor. Tier 2 unlocks at level 4, tier 3 at level 8, slot
counts come from Focus, and slots refill on level-up and trickle back over time.

## Building

Blocks are not all cubes. A block carries a shape and an orientation byte, which
gives stairs, slabs, panes, doors, fences, and roof wedges — all of them just
different lists of boxes used for both geometry and collision. Slabs really are
half-height steps, stairs really are walkable, and an open door really is a hole.

Shaped pieces orient themselves to face you when placed, and stairs and slabs pick
a top or bottom half from where on the face you clicked, so you can run a
staircase downwards without walking round to the other side. Doors open on
right-click rather than stacking another door against themselves.

### The Mason's Gun

A build tool for working in bulk. Left-click clears the target region, right-click
fills it, `X` cycles the shape, and `R` samples whatever you are looking at so you
can change material without opening the inventory.

| Mode | Shape |
| --- | --- |
| Single | one block |
| Line | a run straight ahead |
| Wall | a vertical panel across your view |
| Floor | a flat square |
| Box | a solid cube |

It draws from your materials and stops when they run out, and it will not wall you
into your own build.

## Dungeons

Stone complexes are cut into the rock across the world: connected rooms, corridors,
wall torches, rubble, and a vault at the end holding the best loot and a guard
several levels above you.

Look for a **lit stone frame at ground level** — two braziers on the rim make it
visible at night. Inside, a stairway descends one block per step down to the first
room. The compass carries a pip for the nearest entrance.

The entrance is carved in a deliberate order: the surface frame first, the tunnel
second, the braziers last. Both of the ways of getting that wrong actually shipped.
Carving the tunnel first let the frame's back wall land inside the stairway and
seal the entrance shut. Fixing that by carving the frame first then put the
tunnel's full-height wall pass straight over the braziers, leaving the mouth open
but pitch dark. Anything written into a column that two passes share belongs in the
pass that runs last.

Stair treads face *uphill*, so descending steps you down onto the low half of each
one. Facing them the other way — which is how they first shipped — puts a riser in
front of every step and reads as a staircase built backwards.

### The prop kit

Rooms are furnished from a modular low-poly kit: standing braziers, fluted columns,
voussoir archways over the corridors, stone sarcophagi in the vaults, hanging
banners, barrels, rubble and bone piles. Columns come as a base, a stack of shafts
and a capital so they reach any ceiling — a single fixed-height column scaled to fit
drags its capital out of proportion with its shaft.

**Props never carry collision.** Physics only knows the voxel grid, and teaching it
about arbitrary prop geometry would be a large change for a decorative win. So props
are decoration layered over voxels that already exist: a column is drawn over a real
brick column, and a brazier over a real Glowstone block — solid, so you cannot walk
through it, and emissive, so the world's existing light-source scan lights the room
with no further wiring. Anything with no voxel behind it (rubble, bones, banners) is
deliberately something you would expect to walk through or over.

`world/DungeonProps.ts` is the single source of truth, read by both the renderer and
the generator, so the decoration and the solid world cannot drift apart. Placement is
a pure function of the site and the seed — the same rule the layout follows, for the
same reason.

They are drawn as one `InstancedMesh` per kind, rebuilt only when the set of nearby
sites changes: 335 props in 10 draw calls in the smoke test. Self-lit pieces (flame,
embers) are split into a separate unlit pass, because merging fire into the Lambert
material makes it respond to light, which is backwards.

Three mistakes in this, all found by looking at renders rather than test output:

- **A clear-centre rule wider than the room.** Props avoid the middle of a room so
  corridors can enter, but the exclusion was five tiles across and the *minimum* room
  is 7×7, whose entire interior is that five-tile square. The commonest rooms in the
  game came out completely bare. It is three tiles now, matching the corridor width.
- **Decoration smaller than the block it decorates.** The column shaft had radius
  0.38 and sat entirely inside the 1×1 voxel it was meant to dress, so it was
  invisible. Anything decorating a full block has to be wider than 0.707 — the
  distance to the block's corners — or bare brick shows through.
- **Banners hung inside the wall.** A prop on a wall belongs on the wall's inner
  *face*, not at the centre of the tile beside it; half a block of difference buried
  the cloth in masonry.

Layouts are generated per *site* from the world seed and the site's grid position,
never from neighbouring chunks. That matters because chunks stream in an
unpredictable order — a dungeon that depended on its neighbours already existing
would come out differently every time you approached it from a new direction.

Depth is measured from the terrain above, not from a fixed altitude. An earlier
version put rooms at a fixed y and ran the entrance a fixed height upward, so
wherever the ground happened to sit lower it stood proud of the landscape as a
hollow tower with no way in.

## Enemies

Each archetype has its own silhouette. Goblins are hunched and spindly, with swept
ears, a long snout and arms that hang past the knees; orcs are barrel-chested and
tusked with the head sunk between the shoulders; skeletons show ribs through the
chest under a helmet; cultists are a robe with no legs and two lights in an empty
hood; the ogre is a potbellied slab with arms that reach the ground; the giant
spider is a banded bulb on eight jointed legs.

Before this they were all the same five boxes — torso, head, two arms, two legs —
recoloured and rescaled per archetype, which meant the single thing a player most
needs to read at a glance, *what is running at me and how worried should I be*,
carried no information beyond size and hue.

Two things worth knowing about `fx/creatures.ts`:

- **A creature's own height is authoritative.** The archetype only multiplies it. An
  earlier version normalised everything to 1.8 units before scaling, which stretched
  the spider — modelled deliberately low and wide — up onto man-length legs.
- **Orientation goes through named helpers** (`standUp`, `hangDown`, `faceForward`,
  `alongBody`) rather than raw Euler angles. Which way a part ends up pointing
  depends on the sign of a rotation you can talk yourself into either way, and
  getting it wrong grew a goblin's torso downwards out of its own hips.

`Enemy` drives four pivot groups to animate, so every creature supplies them
whatever its anatomy. Creatures with more than two legs report them all through
`legs` with per-leg gait phases — driving only the named pair left the spider
hauling itself along on two legs with six held rigid.

## Sun, moon, and weather

A full day runs about eighteen minutes. Daylight is when you build: enemies see
barely half as far and the population cap is a fraction of its night-time value.
After dark the world presses in — more spawns, longer sight lines, and you will
want a light.

The sun and moon are real objects in the sky, riding the same camera-centred shell
as the stars so they read as infinitely distant. The shell sits outside the render
distance but inside the far plane, which means terrain occludes them — the sun
genuinely sets behind a hill. The sun reddens and its corona swells as it nears the
horizon; the moon is a cratered disc opposite it that fades out after dawn rather
than blinking off at a threshold.

Both opt out of fog. Everything else is fogged by distance, and at that radius fog
washes a disc into the haze and leaves the sky empty, which defeats the point of
drawing it.

Weather rolls between clear skies, ground fog, rain, and storms. Fog and rain
both pull your view distance in; a storm darkens the sky enough to matter.

## Torches, shields, and the off hand

A torch has its own equipment slot, separate from the shield, because the point
of carrying one is to light your way *while still being able to block*. You can
hold a one-handed weapon, a shield, and a torch at once. (A two-handed weapon
still costs you the shield.)

A held torch casts a real moving light. Planting torches with right-click lights
a building site — up to six nearby placed lights are rendered at a time, chosen
by distance. This is not a voxel lighting engine: there is no light propagation
or per-block light level, so a distant cave full of torches will not glow. What
it does do is make a torch feel like it lights the room you are standing in.

The torch is a chunky model — tapered haft, bound pitch-soaked head, glowing coals
— under a flame of three nested lathed teardrops, each leaning and stretching on
its own pair of incommensurate sine terms so the fire never visibly repeats.

Its embers are emitted **inside the view model's own scene**, and that detail
matters. The view model renders through a separate, narrower camera, so a point
expressed in that space and a point expressed in the world project to two
different pixels. Sparks spawned in the world therefore drifted visibly away from
the flame that was supposedly throwing them. Scaling them by distance — an earlier
attempt at the same symptom — fixed only their size, and overshot into specks.
Sharing a scene with the flame makes the two agree by construction.

Ember size is specified in **screen pixels** and converted through the shader's
perspective divide, rather than guessed in world units. Half a block from the lens,
an eyeballed world size is wrong by an order of magnitude in either direction.

## Water and food

Fish swim in lakes and rivers. They flee rather than fight, and out of water they
suffocate — so spearing one in the shallows works. A raw fish is barely worth
eating, but **use one while carrying a lit torch and you cook it**, which turns it
into a proper heal.

## Progression

Kills drop glowing orbs that home in on you once you are close — purple for
experience, blue for mana. Each level grants 2 points to spend on **Might** (melee
damage, health), **Agility** (ranged damage, stamina, speed), or **Focus** (spell
damage, mana, spell slots).

### Dying looks like a block breaking

An enemy that dies **shatters into its own pixels**: 20–40 hard-edged squares burst
outward, coloured from that enemy's own materials, arc under gravity, and blink out.
There is no fade and no dissolve — the body simply stops being drawn on the frame
the burst spawns.

Every particle in the game follows the same rules, so nothing looks smoother than
the world it sits in:

- **Squares, never discs.** No round mask, no soft edges.
- **Whole-pixel sizes.** Point size is rounded and clamped, because a sub-pixel
  square renders as a soft blur — the 3D equivalent of drawing on integer pixel
  coordinates with image smoothing off.
- **Alpha in four discrete steps**, so particles blink out in stages instead of
  dissolving continuously.

Torch embers and orb motes draw from small stepped palettes for the same reason.
Embers from the torch *in your hand* are scaled down by their distance from the eye:
on-screen point size goes as 1/distance, and a flame burning half a block from the
lens drove every ember into the size clamp, so they read as orange debris floating
across the view rather than as sparks.

## Inventory

Three bags, split by purpose so a building session never buries your potions:

| Tab | Slots | Holds |
| --- | --- | --- |
| Main | 48 | Potions, ammunition, food, spells |
| Tools | 44 | Weapons, armour, shields, torches, the build tool |
| Materials | 192 | Building blocks — **and these carry no weight** |

Materials are weightless on purpose. Hauling a thousand blocks around is the point
of a voxel game, and taxing it would make building feel like a penalty.

## Project layout

```
src/
  core/        Game loop, input, and the service interface entities talk through
  world/       Blocks and shapes, chunks, AO mesher, terrain, dungeons, time, weather
  player/      Physics and collision, stats and levelling, tabbed inventory
  combat/      Damage model, item registry, player actions, the build tool
  entities/    Enemy AI, fish, projectiles, orbs, loot tables
  fx/          Low-poly item, creature and dungeon-prop models, particles,
               view model, trails, rain, stars, sun and moon, lights, cracks, arc
  ui/          HUD, minimap and compass, character sheet, icon fallback
  save/        IndexedDB persistence
scripts/       Tests: unit checks, headless smoke test, screenshots, diagnostics
```

### Items are low-poly, not voxelised

**The voxel grid is for the world, not for the things in it.** Terrain and placed
blocks are voxels because that is the game; weapons, shields, tools and torches are
free low-poly geometry with no grid restriction at all. Swords are tapered blades
with a real point, a cross-guard and a turned pommel; shields are bowed bevelled
plates with a ring rim and a boss; bows are swept curves; mace heads carry flanges.

Everything is still generated in code — there are no external assets. Geometry is
built **non-indexed** so `computeVertexNormals` gives one normal per triangle
instead of averaging across them, which is what produces faceted low-poly shading
rather than a soft blob.

Earlier versions assembled every item from axis-aligned boxes to match the terrain,
which made each weapon read as a stack of bricks — a rectangular slab with a
smaller slab on the end is not a sword. The unit checks now assert this directly by
counting distinct face normals: a cube has exactly six, so anything built from boxes
cannot get far past six however it is arranged. A sword has 118.

Three traps worth knowing if you extend `fx/models.ts`:

- **`toNonIndexed()` returns the same object** when a geometry is already
  non-indexed, so disposing the input unconditionally destroys the geometry you are
  returning. `ExtrudeGeometry` is non-indexed; `LatheGeometry` and `TubeGeometry`
  are not, so both paths occur.
- **Never recentre an extruded outline.** Parts like an axe bit are authored with
  their socket at x=0 and their edge out at +x; centring the bounding box slides the
  head off the end of its own shaft.
- **Compose two rotations with a parent group, not two Euler angles.** Setting both
  on one object applies them in Euler XYZ order, which is rarely the order you
  meant: six "radial" mace flanges came out stacked in nearly the same plane.

### Block textures

Ground cover and trees are textured: turf on top of a grass block with a ragged fringe
of it hanging over gritty pebbled soil on the sides, leaves as dense overlapping
foliage with veins, and logs showing **growth rings on their cut faces and bark around
their sides**. Everything else is still flat-coloured.

The atlas is **generated in code on a canvas at load** — no external assets, same rule
as the models. Tiles are 128px and sampled with `LinearFilter`, so the result reads as
a photograph of soil or bark rather than as pixel art. Drawn from a fixed seed, so the
atlas is identical every run and screenshots stay comparable.

Getting there took three passes. 32px with nearest-filter sampling was far too coarse —
a 3px pebble is a tenth of a 32px face, so soil read as confetti. 64px fixed the scale
but kept the deliberately blocky filtering. The textures are now *painted* rather than
plotted: soft radial dabs, translucent grain and curved strokes, layered. Hard-edged
speckle is legible at 32px and reads as noise at 128px; the same detail painted with
translucent brushes reads as grain and wear.

Two palette corrections worth knowing, because both are counter-intuitive:

- **Layered translucent painting darkens as it accumulates.** Palettes are pitched
  brighter than the reference to land where the reference sits once the layers, the
  baked face brightness (0.70–0.88 on sides) and ambient occlusion have all applied.
- **Brightening is not the same as desaturating.** A first correction made the grass
  brighter and it came out a vivid emerald lawn. Turf needs the *red* channel raised —
  olive, not emerald.

Ground cover and foliage come in **two variants each**, chosen by a hash of the block's
world position. One tile per block type makes a dug pit or a canopy visibly
checkerboard, because every block carries the identical image. The choice is a pure
function of position, so it never changes as chunks stream in.

Leaves are drawn opaque, with deep shadow green between the leaves rather than an
alpha cutout. They render in the opaque pass on a material shared with every other
block, so a cutout would mean either a second material for one block type or
`alphaTest` across the whole world — and the inside of a canopy is dark anyway.

It coexists with the vertex colours rather than replacing them. The material
multiplies the map by the vertex colour, and the mesher keeps writing ambient
occlusion and per-face shading there, so occlusion, face shading and the day/night
tint all keep working untouched. Two cases:

- **Textured blocks** get greyscale shading in the vertex colour and take their hue
  from the texture. Multiplying a green texture by an already-green tint darkens it
  twice over. Their `top`/`side`/`bottom` colours stay defined, because the HUD, the
  held-block model and the break particles all still read them.
- **Everything else** samples a blank white tile and keeps writing tint×shade, which
  multiplies to exactly what it drew before textures existed. Adding a texture to one
  block cannot disturb the rest of the world.

Two details that matter more than they look:

- **Tiles are padded, and the padding is a copy of the tile's own border.** Mipmapping
  averages neighbouring texels, and at a tile's edge those neighbours belong to a
  different tile — so without a gutter, grass bleeds into dirt as the camera pulls
  back. Mipmaps are on: nearest-only sampling shimmers badly on terrain seen edge-on
  across a valley.
- **Soil is painted lighter than the reference.** Side faces carry a baked brightness
  of 0.70–0.88 plus ambient occlusion, so a texture painted at the reference's own
  values lands visibly darker on the block than in the reference.

Textures are easy to get wrong in ways that look like nothing happened — a null map, a
missing UV attribute, or UVs that all land on the blank tile each reproduce the flat
world exactly. `debugTerrainMaterial` reports the plumbing, and the smoke test asserts
the atlas is bound, that UVs exist, that they span more than one tile, and that vertex
colours are still in play.

There is a subtler version of the same trap: a tile that is drawn, uploaded and
sampled perfectly, but which came out **flat**. That happened to the grass — seven
passes of blades overdrew each other until only the lightest survived and the tile
averaged out to a single tone, at a third of the contrast the leaf tiles carry. On
screen it is identical to having no texture. So `debugAtlasStats` reads the atlas back
and reports each tile's mean brightness and standard deviation, and the smoke test
fails any tile whose contrast falls below a floor:

```bash
node scripts/atlas.mjs   # per-tile brightness and contrast
```

Tuning textures by eye does not work well; tuning them against that number does. It
caught bark falling to 0.053 contrast during the realistic rewrite, which on a trunk
looks like a flat brown smear.

`tileRect` throws on an unknown tile rather than returning `NaN` UVs. Renaming a tile
once left a stale list in the tests referring to `undefined`, every UV came out NaN,
and the only symptom was untextured ground — which is exactly the failure mode above.

### Texture orientation

The face bases in the mesher are chosen so that `u × v === n`, which is what guarantees
counter-clockwise winding without a hand-maintained corner table. That is the right
constraint for geometry, but it means the bases are **not** consistently oriented: on
the -Z face `u` is the one pointing up, not `v`. Mapping texture coordinates straight
from the corner parameters therefore laid the image on its side on exactly one of the
six faces — grass appearing at the edge of a block instead of on top, and bark furrows
running around a trunk instead of along it.

`FACE_UV_SWAP` corrects it, and is *derived* from the bases rather than written out, so
it cannot fall out of step with them. A unit check asserts the invariant directly: on
every side face, the upper edge of the quad samples the upper edge of the tile.

### How the world is shaded

There is no texture atlas and no shadow map. The look comes from three things
working together, and it is worth knowing which does what:

1. **Baked per-face brightness.** Every face gets a fixed multiplier by direction
   — tops brightest, undersides darkest, sides between — written straight into the
   vertex colours. This is what keeps a cube legible as a cube. Relying on the
   dynamic light for it does not work: once the sun sets, every face receives
   almost the same value and the world flattens into silhouettes.
2. **Per-vertex ambient occlusion** at corners and edges, sampled from the eight
   voxels around each vertex. This is what gives contact shading where blocks
   meet. The ramp depth is a genuine trade-off — too steep and one-block terrain
   steps produce hard dark wedges across open ground, too shallow and corners stop
   reading at all.
3. **Distance fog**, tinted and pulled in by the time of day and the weather. It
   hides the chunk-streaming frontier and does most of the work of making the world
   feel large.

On top of that sits ordinary directional and hemisphere lighting for the
time-of-day colour shift, and a small pool of point lights for torches.

Some notes on the parts that are less obvious than they look:

- **The mesher** emits one quad per exposed face and bakes per-vertex ambient
  occlusion into vertex colours. Face basis vectors are chosen so `u × v == n`,
  which guarantees correct winding without a hand-maintained corner table. The AO
  ramp is deliberately gentle — a steeper one looks right on a test cube but
  produces hard dark wedges all over real terrain, which is full of one-block
  steps.
- **Chunk streaming** generates and meshes under a per-frame budget, so walking
  into new terrain costs a little pop-in (hidden by fog) rather than a stall.
  When a chunk is generated, all **eight** neighbours are marked dirty, not just
  the four orthogonal ones: AO samples voxels diagonally, so corner shading
  depends on the diagonal neighbour.
- **Saves store the world seed plus your block edits only.** Terrain is
  regenerated on load, so a save stays tiny however far you explore.
- **Melee aims at the point on the enemy's body nearest your eye level**, not at
  its centre. Using the centre means a short enemy's torso falls outside a narrow
  thrust cone at close range and the attack whiffs with the crosshair dead on it.
- **Item icons are emoji with a letter-code fallback.** The game probes for a
  colour emoji font at startup; without one, every icon would otherwise render as
  a "tofu" box. Codes are made unique, so Shortsword and Shortbow don't both
  read `SH`.
- **The view model renders in its own scene with the depth buffer cleared**, so
  the weapon in your hand is never sliced open by a wall you are standing against.
  Weapons are also yawed out of the line of sight and pitched tip-up: a blade
  aimed straight down the view axis is invisible in first person, because all you
  can see of it is the pommel.
- **Block edits update one height-map column, not the whole chunk.** The full
  rebuild scans ~18k voxels, so doing it per edit made placing a block hundreds of
  times more expensive than it needed to be and turned an explosion into a stall.
- **Mining progress resets when the targeted block changes**, which is correct but
  means being knocked around mid-dig costs you the block.
- **Non-cube blocks are flat-shaded rather than AO-shaded.** Ambient occlusion is
  defined against the voxel lattice; sampling it at arbitrary sub-block positions
  puts creases in the wrong places.
- **A shaped block never culls its neighbours.** It does not fill its voxel, so
  hiding the faces behind it would let you see through the gaps around it.
- **Melee attacks deliberately do not damage terrain.** They used to, which meant a
  run of missed swings could quietly break the floor out from under you.
- **Melee does not move the camera.** Kicking the view during a swing reads as the
  camera glitching or clipping rather than as a weapon being swung, so all of the
  motion belongs to the weapon. Firearms still recoil, where a shove is expected.
- **A swing follows Skyrim's one-handed rhythm.** The weapon hauls back behind the
  shoulder and partly out of frame, drives across the view at chest height *and
  forward*, over-travels past the far side, then drifts back to a low central guard.
  Consecutive attacks alternate sides. What distinguishes it from the sweeps that
  came before is that the arm commits: the hand travels forward into the strike
  rather than the wrist merely rotating in place. Three earlier versions each failed
  a different way — a circular screen-space path sent the blade off the edge of the
  view, a flat horizontal yaw sweep read as the weapon being waved, and a symmetric
  diagonal X never looked like it was hitting anything.
- **A thrust is aimed, not tuned.** The blade's rotation is *solved* so its tip lands
  on the view axis from wherever the hand happens to be, blended in as the thrust
  extends. Translating along the blade's own local axis is the physically honest
  reading, but with the weapon carried at an angle it drives the point away from the
  crosshair. Two rounds were then spent nudging constants — cancel 92% of the
  resting yaw, pull the hand 72% of the way to centre — which got the tip close and
  left it stubbornly low and to one side, because the residual depends on the hand's
  position, the blade's length and the camera's field of view all at once. Aiming is
  correct for every weapon and stays correct when any of those change. The smoke test
  measures it in pixels: currently 3px from the crosshair at closest approach.
- **Animation timings ride the combat phases rather than a fixed clock.** The
  visible sweep lands in the 200–300ms a swing should feel like, but tying it to
  wind-up and commitment keeps the telegraph window that makes the fighting
  readable.
- **Enemies hold their distance and circle** rather than walking into you. They
  also lose interest if you get far enough away, so a fight is escapable.

## Tests

```bash
npm test            # typecheck + 235 unit checks
npm run test:unit   # damage model, mesher, terrain determinism, inventory
npm run test:smoke  # boots the real build in headless Chromium and plays it
```

The unit checks assert the *design*, not just the code: that a sword is not built
out of boxes and converges on a real point, that a tower shield is big enough to be
cover, that torch embers are anchored inside the flame, that a placed torch is a
slim post rather than a cube, that an open door has no collision, that mana never
regenerates on its own, that materials add no carry weight, that dungeon layouts
are deterministic and chunk-order independent, that a dungeon entrance is both
open *and* lit at the mouth, that stair treads face uphill, that a mace beats plate,
that thrusts beat swings against armour, that a weapon's attack modes follow from
its shape, that the mesher culls shared faces and bakes AO, that terrain is
deterministic per seed, that night raises the spawn cap above daytime, that
weather never switches kind mid-downpour, and that a corrupt save is sanitised
rather than trusted.

The smoke test drives a real browser — it walks in all four directions, swings,
switches to a thrust, kills an enemy and collects the orbs, fires the bow, casts a
spell, mines a block through its crack animation, plants a torch, cooks a fish,
cycles day to night and clear to storm, saves and loads, and opens the character
sheet, asserting the *effects* of each rather than just the absence of exceptions.

It checks movement by *direction*, not distance. An earlier version only measured
how far the player travelled, which passed happily while W and S were inverted. The
walk also holds the key until the player has actually covered ground rather than for
a fixed stretch of wall-clock: the distance-travelled gate that survived the rewrite
later failed a run where the direction under test was perfectly correct, simply
because a slow frame rate meant 1.6 real seconds moved the player less than half a
block.

Two more lessons the animation checks paid for, both worth copying:

- **Measure a motion by its range over the whole animation, not from one sampled
  frame.** "Is the swing diagonal?" was first asked of the most extreme pose seen
  during an attack. But a diagonal cut crosses the middle of its own X, where the
  vertical offset is back at rest by construction — so the answer depended purely on
  which frame the poller caught, and it failed a swing that was behaving perfectly.
  Sampling the trajectory and taking each axis's range gives the same numbers
  (1.85 across, 1.03 down) whether the run captures 24 frames or 51.
- **Assert state the game records rather than state a test infers.** Whether
  consecutive swings alternate is now read from a recorded history of the directions
  used. Inferring it from sampled poses reported two swings as cutting the same way
  when the second had simply been caught at the start of its travel.

And the recurring one: **a single synthetic click behind a fixed wait is not a
test.** Placement and the build tool share a cooldown with whatever attack just ran,
so a click can be swallowed entirely. Those checks now retry and poll for the
outcome, which is what they were always meant to assert.

It needs Playwright:

```bash
npx playwright install chromium
```

Three notes if you extend it. The game clamps `dt`, so on a software renderer
game-time runs several times slower than wall-clock — poll for outcomes instead
of sleeping a fixed interval, and wait for the combat state to return to `idle`
before issuing another attack. Synthetic mouse events report meaningless movement
deltas under pointer lock, so the test suspends mouse-look and sets the aim
explicitly. And `renderer.info` is reset by every render call, so world triangle
counts have to be snapshotted before the view model pass.

Two more scripts help when something looks wrong rather than behaves wrong:

```bash
node scripts/shots.mjs      # day, night, weather, mining, both attack motions
node scripts/pose.mjs       # every weapon's first-person pose, side by side
node scripts/diagnose.mjs   # toggle visual layers off one at a time to isolate one
node scripts/ao-probe.mjs   # is a shading artifact stale geometry, or real AO?
```

`ao-probe` renders a frame, forces every loaded chunk to re-mesh with all
neighbours present, and diffs the two images. A large difference means chunks
were meshed against unloaded neighbours and never corrected; a negligible one
means the shading is genuine and the mesher is behaving.

`window.__voxelquest` is exposed in the browser console; `debugSnapshot()` and
`debugCombatDiag()` are the quickest way to tell whether a problem is meshing,
streaming, spawning, or aim.

## Known limitations

- Single player, no networking. Adding it later means revisiting who owns state.
- No pathfinding — enemies steer straight at you, step up one block, and hop at
  walls. Fine in the open; they can get stuck on complex structures.
- Terrain is one continuous overworld. There are no hand-authored dungeons yet,
  which is the most obvious thing to build next.
- Lighting is direct only. Placed torches light their surroundings through a small
  pool of point lights rather than a propagating light level, so deep caves stay
  dark no matter how many torches are in them, and only the nearest few planted
  torches actually cast light.
- Dungeon rooms are rectangles connected by axis-aligned corridors. There are no
  hand-authored layouts, traps, or puzzles yet.
- Doors are a single block tall; stack two for a full doorway.
- No audio.
