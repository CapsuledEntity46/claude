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
| `LMB` | Attack, cast, throw, use — or mine, when a block is selected |
| `RMB` | Raise your shield — or place a block, when a block is selected |
| `X` | Switch between swinging and thrusting |
| `R` | Reload a crossbow or firearm |
| `1`–`8` / wheel | Hotbar |
| `Tab` | Character sheet: stats, attribute points, equipment, bag |
| `F5` / `F9` | Save / load · `Esc` pause |

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

## Progression

Kills drop EXP orbs that home in on you once you are close. Each level grants
2 points to spend on **Might** (melee damage, health), **Agility** (ranged damage,
stamina, speed), or **Focus** (spell damage, spell slots).

## Project layout

```
src/
  core/        Game loop, input, and the service interface entities talk through
  world/       Block registry, chunk storage, AO mesher, terrain gen, streaming
  player/      Physics and collision, stats and levelling, inventory
  combat/      Damage model, item registry, and the player action system
  entities/    Enemy AI, projectiles, EXP orbs, loot tables
  fx/ ui/      Particles, HUD, character sheet
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

## Tests

```bash
npm test            # typecheck + 67 unit checks
npm run test:unit   # damage model, mesher, terrain determinism, inventory
npm run test:smoke  # boots the real build in headless Chromium and plays it
```

The unit checks assert the *design*, not just the code: that a mace beats plate,
that thrusts beat swings against armour, that the mesher culls shared faces and
bakes AO, that terrain is deterministic per seed, and that a corrupt save is
sanitised rather than trusted.

The smoke test drives a real browser — it walks, swings, switches to a thrust,
fires the bow, casts a spell, mines and places a block, saves and loads, and
opens the character sheet, asserting the *effects* of each rather than just the
absence of exceptions. It needs Playwright:

```bash
npx playwright install chromium
```

Two notes if you extend it. The game clamps `dt`, so on a software renderer
game-time runs several times slower than wall-clock — poll for outcomes instead
of sleeping a fixed interval. And synthetic mouse events report meaningless
movement deltas under pointer lock, so the test suspends mouse-look and sets the
aim explicitly.

Two more scripts help when something looks wrong rather than behaves wrong:

```bash
node scripts/shots.mjs      # capture views of terrain, AO, combat, and the sheet
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
- No audio.
