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
| `RMB` | Raise your shield — or place a block / plant a torch |
| `X` | Switch between swinging and thrusting |
| `R` | Reload a crossbow or firearm |
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
- **Spells** consume a slot of their tier. Tier 2 unlocks at level 4, tier 3 at
  level 8, and slot counts come from Focus. Slots refill on level-up, trickle
  back over time, and can be restored with a Mana Tonic.

## Day, night, and weather

A full day runs about eighteen minutes. Daylight is when you build: enemies see
barely half as far and the population cap is a fraction of its night-time value.
After dark the world presses in — more spawns, longer sight lines, and you will
want a light.

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

## Water and food

Fish swim in lakes and rivers. They flee rather than fight, and out of water they
suffocate — so spearing one in the shallows works. A raw fish is barely worth
eating, but **use one while carrying a lit torch and you cook it**, which turns it
into a proper heal.

## Progression

Kills drop EXP orbs that home in on you once you are close. Each level grants
2 points to spend on **Might** (melee damage, health), **Agility** (ranged damage,
stamina, speed), or **Focus** (spell damage, spell slots).

## Project layout

```
src/
  core/        Game loop, input, and the service interface entities talk through
  world/       Blocks, chunks, AO mesher, terrain gen, streaming, time, weather
  player/      Physics and collision, stats and levelling, inventory
  combat/      Damage model, item registry, and the player action system
  entities/    Enemy AI, fish, projectiles, EXP orbs, loot tables
  fx/          Particles, first-person view model, rain, stars, lights, cracks
  ui/          HUD, character sheet, icon fallback
  save/        IndexedDB persistence
scripts/       Tests: unit checks, headless smoke test, screenshot capture
```

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

## Tests

```bash
npm test            # typecheck + 67 unit checks
npm run test:unit   # damage model, mesher, terrain determinism, inventory
npm run test:smoke  # boots the real build in headless Chromium and plays it
```

The unit checks assert the *design*, not just the code: that a mace beats plate,
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
how far the player travelled, which passed happily while W and S were inverted.

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
  dark no matter how many torches are in them.
- No audio.
