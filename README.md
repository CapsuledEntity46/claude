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
| `LMB` | **Melee: hold and move the mouse** — the direction is the attack · cast, throw, fire, use · mine, when a block or torch is selected |
| `RMB` | Guard · place a block · **aim** a bow or grenade · open a door |
| `X` | Cycle the build tool's shape |
| `R` | Reload a firearm, or sample a block with the build tool |
| `1`–`8` / wheel | Hotbar |
| `Tab` | Character sheet: abilities, skill tree, equipment, bag |
| `F5` / `F9` | Save / load · `Esc` pause |
| `M` · `[` `]` | Mute · volume down / up |

You can see what you are holding. Weapons, torches, shields, spells, and blocks
all have a first-person model, and the weapon travels the way you moved the mouse
— a left drag sweeps right-to-left across the screen, an up drag rips vertically,
a thrust drives straight down the centre. The motion is meant to be readable
without consulting the HUD.

## Melee is a mouse gesture, not a button

Hold `LMB` with a melee weapon (or bare fists) and move the mouse. The direction
you move picks the attack — nine of them:

| Gesture | Attack | Character |
| --- | --- | --- |
| ← / → | Left or right slash | Fast, wide arc |
| ↑ | Uppercut | Slow, hits hard, narrow arc |
| ↓ | Downcut | Slow, hits hard, narrow arc |
| ↖ ↗ ↙ ↘ | Diagonal cuts | Between the two |
| No movement, or a quick click | Thrust | Narrow, long reach, armour-piercing |

The attack fires the instant your movement crosses the commit threshold, so the
blow lands while the mouse is still moving rather than waiting for you to let go.
Releasing early commits whatever stroke you had made; releasing without having
moved past the dead zone is a thrust. While the button is held the mouse drives
the weapon and **not** the camera, so a stroke never spins your view; an arrow by
the crosshair shows the stroke being drawn.

The stroke also leans the hit cone towards the side it travels, so a left slash
favours targets on your left. Melee still never damages terrain and never kicks
the camera.

Tunables live in `GESTURE_CONFIG` in `src/combat/GestureTracker.ts` (dead zone,
commit threshold, sample window, sector tolerance, sensitivity) and in
`DIRECTION_MODIFIERS` in `src/combat/types.ts` (per-direction damage, timing,
stamina, reach and arc).

## The central idea: weapon geometry decides how you can attack

A gesture asks for an attack; the weapon's shape decides whether it can oblige.
Each family deals a different damage type:

| Weapon | Swing | Thrust | Why |
| --- | :-: | :-: | --- |
| Sword, dagger, halberd | ● | ● | Sharp along the edge *and* pointed at the tip |
| Mace, warhammer, battleaxe | ● | — | No point to thrust with |
| Spear, rapier | — | ● | Nothing worth calling an edge |

- **Swings** sweep a wide arc, hit several enemies, and deal slashing or blunt
  damage. They barely get past armour.
- **Thrusts** commit along a narrow line, reach further, hit one target, crit more
  often, and **bypass about half of the target's armour**.

A gesture the weapon cannot perform falls back to the nearest thing it can, and
says so in the log: thrust at something with a mace and you get a downward chop,
slash with a rapier and you get a thrust.

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
counts come from Wisdom, and slots refill on level-up and trickle back over time.
Each unlocked tier floors at one slot: a negative Wisdom modifier should make high
magic scarce, not impossible, and an unlock that grants nothing is a broken
promise rather than a hard build.

## Building

Blocks are not all cubes. A block carries a shape and an orientation byte, which
gives stairs, slabs, panes, doors, fences, and roof wedges — all of them just
different lists of boxes used for both geometry and collision. Slabs really are
half-height steps, stairs really are walkable, and an open door really is a hole.

Shaped pieces orient themselves to face you when placed, and stairs and slabs pick
a top or bottom half from where on the face you clicked, so you can run a
staircase downwards without walking round to the other side. Doors open on
right-click rather than stacking another door against themselves.

## The world

Terrain is shaped in the spirit of the **Tectonic** world generator: relief at a
scale you travel through rather than step over. The world is **160 blocks tall
with the sea at 62**, which leaves ~60 blocks of water below and ~95 above — the
old 72-with-sea-at-27 had room for neither an ocean nor a mountain.

A height is not one noise field but a negotiation between several, each answering
a different question:

| Field | Question |
| --- | --- |
| `continent` | ocean or land, at the scale of a thousand blocks? |
| `erosion` | how worn down is this region? |
| `ranges` | where do the mountain spines run? |
| `terrace` | where does ground step up in plateaus instead of sloping? |

Composing them is what gives terrain *regions* — a coastal plain that climbs into
foothills and then into a range. A single fbm field, however many octaves, always
reads as the same texture repeated to the horizon.

What that produces, measured over a 6000-block square (`npm run survey`):

- **Continents and oceans.** 37% of columns are below the waterline, with
  continents roughly 1200 blocks across, so crossing one is a journey.
- **Deep oceans** that drop into the stone layer — the floor reaches y=11 — with
  trench noise giving them valleys rather than a flat bowl.
- **Islands** out past the shelf, from ridged noise raised to a power so they stay
  small and distinct.
- **Mountain ranges** to y=152, connected into chains by ridged noise rather than
  scattered as lumps. Steepest 40-block relief measured: **111 blocks**.
- **Plateaus** with flat tops and ramps up their sides.
- **Canyons** carved *down* through banded rock, with strata that line up across a
  whole wall because the bands come from world y rather than from depth.
- **Dunes** in the deserts, from three scales of smooth hump.
- **Jungle pillars**, two thicknesses of them.
- **Wetlands** pressed to the waterline and pitted with ponds.
- **Underground rivers**, because terrain this tall leaves no room for a surface
  river to cross a range — the water goes under it instead.
- **Lava tunnels** deeper still, on a channel field offset far from the water one
  so the two networks never meet and drain into each other. Lava burns.

### Trees

Five species, chosen by biome and by altitude:

| Tree | Where | Trunk | Shape |
| --- | --- | :-: | --- |
| **Oak** | Forest, Plains | 9–12 | Broad irregular crown carried on 3–4 limbs |
| **Birch** | Forest, Plains | 11–14 | Slender, bare, a narrow crown held high |
| **Pine** | Tundra, high Forest | 12–17 | Whorls tapering from a wide skirt to a tip |
| **Jungle giant** | Jungle | 16–22 | Bare for most of its height, then a layered crown and buttress roots |
| **Willow** | Wetland | 7–9 | Low wide dome with foliage hanging off the rim |

A trunk used to be 4–6 blocks (7–11 in the jungle) with a squashed sphere on top,
which is a *pillar with a blob on it* rather than a tree. Measured on the same
sample, the median trunk went from 6 blocks to 13 and the canopy from about 40 leaf
voxels to 156. Conifers take over from oaks above y=92, so a forested mountainside
has a visible altitude band instead of oaks running to the tree line.

Four things worth knowing if you touch `placeTrees`:

- **Density had to fall by about a third as the trees grew**, and the two changes
  are not independent. Canopy *area* goes as the square of the crown radius, so
  doubling a tree without thinning the stand does not give a denser forest — it
  gives one unbroken slab of leaves at a single height, with no trunks and no sky
  underneath. The numbers are solved for the coverage wanted rather than guessed:
  for a crown of area `a` and target coverage `c`, trees per column is
  `-ln(1 - c) / a`. Total foliage in the world barely moved; it is simply gathered
  into a third as many trees that are each eight times the volume.

- **`margin >= MAX_TREE_REACH` is the invariant the whole approach rests on.**
  There is no inter-chunk messaging: each chunk grows its neighbours' trees too and
  clips whatever lands outside itself, which is seamless only because both sides
  compute a bit-identical tree. Let a canopy out-reach the margin and it is sliced
  flat along the chunk border — a bug that is invisible from inside any single
  chunk, because each chunk is self-consistent. A unit check regenerates with a
  deliberately over-wide margin and demands the same voxels, which turns the
  invariant into something the suite can prove rather than something a reviewer has
  to re-derive from the widest crown.

- **Widening the margin made generation *faster*.** It took the tree pass from 484
  columns per chunk to 900, and `biomeAt`/`surfaceHeight` are the two hottest paths
  in the generator. Taking the spawn roll *first*, against the largest density any
  biome uses, rejects ~98% of columns with one integer hash before anything pays
  for a biome lookup — the distribution is identical and the measured cost of
  `generate` fell from 2.82 ms to 2.63 ms.

- **A tree has to be a pure function of its root column.** Shape comes from a PRNG
  seeded from `(wx, wz, seed)`, so each tree's decisions depend only on which tree
  it is. A generator-wide RNG advanced once per tree would make a canopy depend on
  how many trees had been built before it, and the two chunks either side of a
  trunk would disagree about the tree and tear it along the seam.

- **A clump narrower than one block places nothing at all.** Foliage is centred on
  the trunk and will not overwrite the wood already there, so a radius under 1
  covers only that one voxel and writes no leaves. The conifers first tapered to
  0.9, which meant the top third of every pine drew *nothing* and the tree came out
  as five blocks of bare pole standing in a skirt — unmistakably upside down. The
  radius floor is 1.9 now, which is both over 1 and over `sqrt(squash)`: below that
  second threshold a whorl cannot reach a block up or down, so whorls spaced two
  apart hang in the air as separate discs with the bole showing between them.

  Neither failure shows up in a voxel count, because the missing leaves were never
  missing from anything — they simply never existed. `npm run trees` prints each
  species as an elevation, which is how both were found.

Bigger canopies cost less than they look like they should, because the mesher
already culls faces between two blocks of the same kind: a canopy is hollow, so its
triangles go as its surface area and never as its volume. Meshing a chunk went from
3.26 ms to 3.75 ms.

Trees also no longer root themselves in holes. Caves are carved *after* the surface
is laid down, so a column's top voxel may be air; the tree pass now re-asks the cave
function rather than reading the voxel back, because a tree rooted in the chunk next
door has to reach the same verdict on both sides.

Three things this cost that are worth knowing:

- **The mesher now skips the empty sky** above each chunk's tallest voxel. Chunks
  are full-height columns, and scanning 160 levels where terrain occupies 40 is
  most of the work for nothing. This is what paid for the taller world: meshing is
  *cheaper* at 160 than it was at 72. It derives the top from the voxel data
  rather than the height map on purpose — the map is a cache, and trusting it made
  a chunk assembled voxel-by-voxel mesh as empty.
- **View distance went from 6 chunks to 9.** At 6 the far plane sat around 75
  blocks, which is less than the height of one mountain: ranges were something you
  stood on rather than something you saw, and the whole point of the taller world
  was lost to fog.
- **Terracing must be nearly all-or-nothing.** Blending halfway towards a
  quantised height does not give a gentler plateau, it gives twice as many steps
  half as tall — which turned every grassy hillside into a flight of one-block
  stairs. It is a smoothstep now, and switched off entirely for deserts and
  wetlands, whose whole character is smoothness.

### Streaming inside the frame

The occasional drop from 60fps to the low 40s was not fog, lighting or draw
calls — fog is a shader uniform and costs nothing. It was chunk work overrunning
the frame. `npm run perf` measures where the time goes:

| Work | Cost |
| --- | --- |
| Generate one chunk | ~2.9 ms |
| Mesh one chunk | ~3.2 ms |

The budget used to be a count — two generates plus three meshes — which
authorises about **18 ms of work in a frame that has 16.7 ms**. Every frame that
streamed a full batch overran, which is exactly what an intermittent dip to the
low 40s looks like. A count cannot be right anyway: chunk cost varies several
fold with the terrain in it.

It is now a **time budget of 8 ms**, and three details matter more than the
number:

- **Predictive, not reactive.** Checking the clock after each chunk only
  discovers the overrun once the frame is already late. The scheduler stops
  *before* starting work it cannot afford.
- **Pessimistic estimates.** It decides using a high-water cost that rises
  instantly and decays slowly, not an average. A mesher cannot be interrupted
  once started, so planning with the mean means every expensive chunk is begun
  late in a frame and overruns it. The estimates are also seeded at 5 ms rather
  than 1 ms: an optimistic seed let the first frames authorise a dozen chunks and
  spike to 63 ms before the measurements caught up.
- **Meshing and generation each get one guaranteed operation.** Sharing a single
  guarantee starved generation outright — meshing claimed it, and since
  generating a chunk dirties all eight neighbours there is nearly always
  something to mesh, so the world grew only on the rare frame with nothing dirty.
  Measured: 3 chunks a second where the budget should have allowed twenty.

Two costs found by measuring rather than reasoning:

- **The streaming bookkeeping was the single largest cost in the frame**, not the
  chunk building. The queue held the chunk map's *string* keys, so the sort
  comparator re-parsed two keys per comparison — roughly sixteen thousand string
  operations every frame for a queue of 250. Entries now carry numeric
  coordinates and a precomputed distance.
- **The queue was fully rebuilt every frame that generated anything**, re-probing
  all 361 cells for a change it already knew about. Consumed entries are spliced
  off the front of the sorted queue instead.

The mesher also skips voxels buried on all six sides before touching the face
loop, and reads opacity from a flat byte table rather than dereferencing a block
definition — it asks that question about 270,000 times per chunk.

The budget is asserted, not trusted: the smoke suite records the worst frame's
chunk time and the bound in force at that instant, and fails if the scheduler
exceeded its own promise. A fixed millisecond ceiling would not do, because one
geometry upload costs tens of milliseconds on the software rasteriser CI uses and
a fraction of that on a real GPU — the same correct code would pass on one and
fail on the other.

### View distance is governed, not configured

Streaming inside the frame fixed the *spikes*. It does nothing about the steady
cost of what is on screen, and that cost is large. `npm run geom` measures it:

| | Triangles in view |
| --- | --- |
| Radius 9 chunks | **1,345,000** |
| Radius 6 chunks | 679,000 |

Nine chunks is about 1.35 million triangles of real, already-culled surface. At
60fps that is 81 million triangles a second, which is roughly where a laptop GPU
runs out — and it is why the frame rate sits at 60 on one machine and in the low
40s on another running identical code.

Where it goes is the surprising part: **55–66% of those faces are stone**, nearly
all of it cave wall tens of blocks underground. It is hidden by the terrain in
front of it, not by the view frustum, so nothing cheap removes it. Full-height
chunks make that worse than it sounds — a 16×160×16 chunk has a bounding sphere
of radius 81, so almost every loaded chunk counts as visible however the camera is
pointed, and splitting chunks vertically would not help either: underground
geometry directly ahead and below is *inside* the frustum. Removing it needs real
occlusion culling, which is a much larger piece of work than it looks.

So the dial that actually moves is the view radius, because triangles go as `r²`:
nine chunks down to seven is a 38% cut, and down to six is a halving. That dial is
now **automatic**. The governor watches smoothed frame time, gives up one chunk of
view distance when it stays in distress, and tries to win one back when it has
slack:

- **Frame time can reveal distress but never comfort.** A machine with enormous
  headroom still reports 16.7ms, because it spends the surplus blocked on vsync.
  The only observable difference between "coping" and "coping easily" is that the
  former drifts *above* the vsync period and the latter sits exactly on it — which
  is why the slack threshold is 17.4ms rather than something comfortably below 16.

- **Each concession is a one-way ratchet.** Giving up a chunk lowers a ceiling the
  governor will not try again. Without that it would drop to eight, see frame time
  return to vsync — because it *has* returned, that is what fixing it looks
  like — climb back to nine, stutter, and repeat for the whole session. The
  ratchet means a machine that cannot sustain the full view pays once.

- **Frames spent filling the streaming queue are not sampled.** Chunk work runs on
  a wider budget while the world fills in, so the frames after a spawn, a teleport
  or a view-distance change are legitimately slow. Sampling them makes the governor
  read its own churn as evidence and walk itself to the floor.

Fog tracks the live radius, or chunks would wink out in clear air at the new
boundary — far more noticeable than the shorter view itself.

The smoke suite runs on a software rasteriser at over 40ms a frame, which makes it
an ideal place to watch the governor give up: it asserts that the steps go down one
chunk at a time, that a rejected distance is never retried, and that once at the
floor the step count **stops changing** — a governor that kept hunting there would
thrash the chunk streamer. It also checks that writing the view distance
invalidates the streaming queue, because a widened ring that does not is simply
never serviced and nothing reports a problem.

## Stamina is a resource, not a formality

Attacking costs real stamina now, and getting it back takes time. Three changes,
because the old numbers cancelled each other out:

| | Before | Now |
| --- | :-: | :-: |
| Recovery rate | 22/s | 11/s |
| Delay before recovery starts | none | 0.95 s |
| Longsword swing / thrust | 11 / 9 | 15 / 19 |

**The delay matters more than the rate.** With none at all, recovery resumed on the
very next frame — so a melee cycle of about half a second clawed back most of what
the swing had just cost, and the bar never visibly moved however the rate was tuned.
A pause slightly longer than a full swing is what turns stamina into something you
spend and then wait for. Sprinting and blocking both restart it, so neither can be
feathered to dodge it.

**A thrust now costs more than a swing, not less.** It reaches further, lands
faster, bypasses five times as much armour, crits twice as often and crits harder.
It used to pay for all that with *less* stamina, which left no reason to ever swing
at anything. Price is the only axis left to balance it on, and a unit check holds
the ordering for every weapon that has both.

**Running yourself out now costs something.** Sprint used to re-arm at one point of
stamina, which meant running flat out forever by releasing and re-pressing: a single
frame under the threshold handed control to the recovery branch, which immediately
re-armed it. Bottoming out now latches sprinting off until a quarter of the bar is
back.

Builds still matter: Constitution adds 5% recovery per modifier point, Long Wind 15%
per rank, and Tireless Arm discounts attacks by 12% per rank down to a floor.

## Enemies

Each archetype has its own silhouette. Goblins are hunched and spindly, with swept
ears, a long snout and arms that hang past the knees; orcs are barrel-chested and
tusked with the head sunk between the shoulders; skeletons show ribs through the
chest under a helmet; cultists are a robe with no legs and two lights in an empty
hood; the ogre is a potbellied slab with arms that reach the ground; the giant
spider is a banded bulb on eight jointed legs.

### Why melee enemies used to be harmless

They were, and it was four compounding things rather than low damage numbers:

- **Every melee enemy retreated after every swing.** `recover` led unconditionally
  into a `backoff` that walked four units away, and the enemy then had to re-close a
  gap it had opened itself. This was the single biggest cause. A minority still do it
  — keyed on the enemy's own fixed jitter, so a given enemy is consistently a presser
  or a circler rather than flickering between the two mid-fight — because the in-out
  rhythm is worth keeping. Most now press.

- **They froze during the telegraph.** Committing to a swing cut velocity to 30% and
  then damped it further every frame, so for the 0.3–0.95 s of the wind-up the enemy
  stood still while the player walked out of the reach re-check at the end of it. A
  swing is a committed *movement*; melee attackers now keep most of their momentum
  and step into the blow.

- **They eased away while waiting on a cooldown.** Inside 55% of its own reach an
  enemy nudged outwards, which sounds sensible and in practice meant the cooldown
  kept expiring with the player just out of range. The circle now leans inwards.

- **Nothing could catch a walking player.** Every melee archetype was slower than
  the player's 4.6 walk except the spider. They now sit at or above it — a goblin at
  4.4, a skirmisher at 5.0, a spider at 5.7 — while sprinting (7.1) still escapes
  everything. That is deliberate: sprint should be the answer to being swarmed, and
  it now costs real stamina to use.

Daytime population also doubled. The pressure floor of 0.3 rounded the cap down to
the hard minimum of two hostiles, so daylight was not merely safer than night, it
was empty. Night is still twice as dangerous.

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

## Sound is synthesised, not sampled

There are no audio files. Every sound is built at the moment it plays from
oscillators and filtered noise, for the same reason there are no model files: a
sample you can only change in an editor cannot be tuned against the game, and a
world that streams its own terrain should not also be waiting on a megabyte of wav.

The palette is small because that is what the material is:

| Sound | How |
| --- | --- |
| Sword stroke | Noise through a bandpass sweeping up and away — the *sweep* is the effect; a static band is a hiss, not a movement |
| Hit on a body | Low sine thud with a slap of noise on the front |
| Hit on mail | Partials at non-integer ratios, which is what separates struck steel from a bell |
| Gunshot | A crack, a lowpassed body, and a tail |
| Growl | Low sawtooth, pitch wandering, under a closing lowpass |
| Level up | A rising major triad — the only melodic sound in the game, which is what makes it read as a reward |

Pitch carries information rather than decoration. A hit is pitched by the target's
size, so an ogre and a goblin are different events even unseen; a mining tick is
pitched by the block's hardness, so you can hear stone from soil; a swing is pitched
by the weapon's reach, because that is the best available proxy for how much steel
is moving.

Four things that took care:

- **The context must start inside the click.** A browser refuses to create an
  `AudioContext` without a user gesture, and one created early lands in `suspended`
  and stays there with no error — silent audio that looks like working audio. It is
  started from the same handler that locks the pointer.

- **Bursts need a retrigger floor.** A blunderbuss spawns a projectile per pellet, a
  mining tick repeats at the frame rate, three orbs land together. Without a minimum
  gap these phase-align into a buzz that is also much *louder* than any one of them,
  because correlated signals sum linearly while uncorrelated ones sum as the square
  root. The shot fires once outside the pellet loop for the same reason.

- **Rain is a bed, not ten thousand one-shots.** A raindrop is not worth a voice, and
  the voices would sum to a buzz rather than to rainfall. It is a looping noise
  filter whose gain the weather ramps.

- **Positional, but cheaply.** Distance attenuation and a stereo pan from the
  camera's right vector, rather than a `PannerNode` per voice doing HRTF
  convolution. In a first-person game the useful information is "how far" and "which
  side", and that is two multiplies.

`M` mutes; `[` and `]` set the volume, persisted to `localStorage`. There is no
options screen to put a slider in, and a game with no way to turn the sound down is
a game people mute at the browser tab instead.

**Testing sound is the interesting part.** There is no frame to screenshot, and
headless Chromium may have no audio device at all — so the engine counts what the
game *asked* to play independently of whether anything was audible. That is what
lets the smoke suite assert that swinging a sword makes a noise, and tell "nothing
was wired up" apart from "no speakers are attached".

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
experience, blue for mana, gold for coin.

### Five abilities, on 5e terms

Characters run on five D&D 5e ability scores. What reaches the formulas is never
the raw score but its **modifier**, `floor((score - 10) / 2)` — so 10 is the
average that changes nothing, 8 is a real weakness, and an odd score buys nothing
the even one below it did not. If you know 5e, you can predict this sheet.

| Ability | Drives |
| --- | --- |
| **STR** | Melee damage, knockback |
| **DEX** | Ranged damage, movement speed, critical chance |
| **CON** | Health, health and stamina recovery, fall damage |
| **INT** | Spell damage, mana pool |
| **WIS** | Spell slots, spell-slot recovery |

Health hangs off Constitution rather than the melee stat, which is the main thing
the old three-attribute system had wrong: a heavy hitter and a tough character are
different builds, and tying both to one number meant you could never be one
without the other.

Scores are chosen at creation by **point buy**: all five start at 8, cost 1 point
per step to 13 and 2 points each for 14 and 15, out of a bank of 27. Levelling
then grants **1 ability point** and **1 skill point** per level, and levelling can
take a score past the creation cap of 15 up to the 5e ceiling of 20.

### The skill tree

Four branches — **Blade**, **Hunt**, **Arcana**, **Endurance** — of five nodes
each, three tiers deep. Deeper nodes need their parent bought first, and the
capstones need the branch's ability at 14, so point buy decides what you are
*able* to specialise in rather than the two systems ignoring each other.

Skills never touch the stat formulas directly. They contribute to one modifier
bag that the formulas consult, which is what makes the arithmetic explainable:
every number is `ability modifier + equipment + skills`, with percentages adding
rather than compounding. Two +10% skills give +20%, not +21% — multiplicative
stacking would make every value depend on the order you bought the tree in, which
is impossible to put on a tooltip.

Dropping an ability score takes the skills it gated with it, and the prune
cascades: clearing a tier-1 node invalidates tier 2, which invalidates tier 3. A
single sweep in definition order would leave the deepest node standing on nothing.

### The character sheet

`Tab` opens a two-tab sheet. **Equipment & Inventory** holds the equipped slots,
the bag and a copy of the hotbar; **Skills and Stats** holds the stats, the five
ability cards with a radar chart, and the tree.

**The inventory is drag and drop.** Drag an item onto an equipment slot to equip
it, or onto a hotbar slot to bind it — dropping a weapon on a slot selects it too,
since "put this on the bar" almost always means "and draw it". Clicking still
equips, and shift-click still drops. The hotbar is repeated inside the sheet
purely as a drop target: binding a slot used to be a round trip out of the sheet,
scroll the bar to the slot you wanted, back into the sheet, then click.

Slots highlight while a compatible item is over them and show a refusal tint when
it is not, so the target is never in doubt mid-drag.

The tree is drawn from measured geometry rather than CSS rules: each branch has a
root, limbs curving out to its first tier, and a bezier from every node to its
prerequisite, so the shape of the dependency graph is the shape on screen. Grown
limbs are solid gold and unbought ones dashed. Positions are read from the DOM
after layout, which is why the connectors stay attached at any panel width — and
why they are drawn when the tab becomes visible, since a hidden panel measures as
zero.

Three node states, not two: available, owned, and locked. "Maxed" is a success
and "saving up for it" is a plan, so neither is dimmed like the nodes a character
cannot use at all.

### Respeccing, and gold

Hostile kills sometimes drop coin, scaled by both the archetype's own worth and
its level — a wolf and a captain at the same level are not paid alike. Passive
creatures carry nothing; a fish has no purse, and paying out for one would make
farming them the cheapest income in the game.

Gold buys a **respec**: a button on the sheet that refunds every skill point for
a fee of `40 + 35 per level`. It is priced off level rather than off how much you
have invested, so you know the cost before you open the screen. Ability scores
are deliberately left alone — a respec should let you try a different build, not
rewrite the character.

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
  world/       Blocks and shapes, chunks, AO mesher, terrain, time, weather
  player/      Physics and collision, stats and levelling, tabbed inventory
  combat/      Damage model, item registry, player actions, the build tool
  entities/    Enemy AI, fish, projectiles, orbs, loot tables
  fx/          Low-poly item and creature models, particles,
               view model, trails, rain, stars, sun and moon, lights, cracks, arc
  ui/          HUD, minimap and compass, character sheet, icon fallback
  audio/       Procedurally synthesised sound effects
  save/        IndexedDB persistence
assets/        Authored source art. Block GLBs, not shipped to the browser
public/        Baked block tiles, served as-is
scripts/       Tests: unit checks, headless smoke test, screenshots, diagnostics
               and the offline texture bake (npm run tiles)
```

### Items are low-poly, not voxelised

**The voxel grid is for the world, not for the things in it.** Terrain and placed
blocks are voxels because that is the game; weapons, shields, tools and torches are
free low-poly geometry with no grid restriction at all. Swords are tapered blades
with a real point, a cross-guard and a turned pommel; shields are bowed bevelled
plates with a ring rim and a boss; bows are swept curves; mace heads carry flanges.

Every item's geometry is generated in code — no model is ever loaded. (Block
*textures* are the one authored thing in the project; see below.) Geometry is
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

Ground cover, trees and natural rock are textured: turf on top of a grass block with a
ragged fringe of it hanging over gritty pebbled soil on the sides, leaves as dense
overlapping foliage with veins, logs showing **growth rings on their cut faces and bark
around their sides**, and cracked stone, rust-red canyon rock and rippled sand.
Masonry, ore, snow and everything built is still flat-coloured.

Tiles are 128px in an 800px atlas and sampled with `LinearFilter`, so the result reads
as a photograph of soil or bark rather than as pixel art. Every tile is painted in code
from a fixed seed, so the atlas is identical every run and screenshots stay comparable.

Ore stays flat on purpose, and it is a gameplay decision rather than an oversight:
now that stone carries detail, a flat iron or gold block is *easier* to pick out of a
wall than it was when both were plain colours.

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

Ground cover, foliage and rock come in **two variants each**, chosen by a hash of the
block's world position. One tile per block type makes a dug pit or a canopy visibly
checkerboard, because every block carries the identical image. The choice is a pure
function of position, so it never changes as chunks stream in.

The hash includes the block's **height** as well as its horizontal position, which
only matters for the things that stack. Ground cover is a single layer and never
noticed, but stone runs hundreds of blocks deep: keyed on x and z alone, every block
in a column picks the same variant and a cliff face or a mine shaft comes out in
vertical stripes — the exact artefact the second variant exists to prevent. Ground
cover deliberately still ignores height, so digging a grass block up and putting it
back does not change its tile.

### Rock and sand are authored

Stone, canyon rock and sand are the one part of the game that comes from art rather
than from code. The sources are in `assets/blocks/` as Blender cubes with 1024px
baked colour, normal and roughness maps. `npm run tiles` bakes them into the atlas
tiles committed under `public/textures/`, which is the only form the browser ever
sees — **7.3 MB of source becomes 252 KB of tiles**, and a checkout needs no build
step to run.

Four things that bake does which are not obvious:

- **It reads the model's UV layout instead of assuming one.** A Blender default cube
  unwrap is a cross on a 4×4 grid of quarter-cells, so each face is a 256px region
  and most of the image is unused grey filler. Slicing the image naively textures the
  world with that filler. Two of the six faces are shipped as the variants, chosen as
  the pair that differs most — they are baked from the same material, so a similar
  pair would waste the slot that exists to break up the per-block repeat.

- **It bakes relief from the normal map into the colour.** The terrain material is a
  `MeshLambertMaterial` with one `map`, so surface relief has nowhere to come from at
  runtime. Sand is the proof: its colour map measures a luma stdev of **0.017** — flat
  enough that the smoke suite's "every tile carries visible detail" check rejects
  it — while its normal map is full of ripples. Lighting that normal map from a fixed
  direction and multiplying it in puts the relief somewhere the renderer can see it,
  which is the same trick the mesher already plays with `CUBE_FACE_SHADE`.

- **It solves its tone curve instead of being tuned by hand.** A tile has to land near
  the brightness its block used to render at flat — stone at 0.49, sand at 0.85 — or
  turning textures on visibly re-lights the world. Rock bakes at 0.34, and multiplying
  by 1.6 clips every highlight, so the exponent is solved from the measurement:
  `pow(mean, g) = target`. Contrast then gets its own pass, because the two fight:
  relief is multiplied in *linear* light, which is correct, and sRGB encoding then
  compresses that variation by roughly the 2.4 exponent — a normal map with an N·L
  spread of 0.21 came out as a tile with a stdev of 0.043. Solving a stretch factor
  from the measured stdev makes the result a guarantee rather than a hope. The stretch
  is capped, because an uncapped factor on a nearly flat source amplifies 8-bit
  quantisation into banding rather than inventing detail that was never there.

- **Pale canyon rock is derived, not a second asset.** The strata alternate Terracotta
  with PaleTerracotta, and a textured block takes its colour from its *tile* rather
  than from its own tint — so pointing both at one tile textures the canyon
  beautifully and erases the banding the biome exists for. The pale tile is the red
  rock washed 30% towards white at atlas-build time. Not more than 30%: the wash
  scales contrast by `1 - alpha` as it lightens, and past about 0.45 the pale band
  stops clearing the contrast floor, which is the same thing as saying it stops
  looking like rock.

**Every authored tile is painted procedurally first, and the sheets composite over
it.** That is what keeps the load off the startup path: the atlas is complete and
correct the moment it is built, UVs come from `tileRect` rather than from the image,
so chunks meshed before the sheets arrive need no remeshing and simply sample better
pixels on the next frame. A slow or failed fetch therefore costs the painted look and
nothing else — never a loading screen, never an untextured world. It is also what
lets the unit tests mesh real chunks in Node, where no image can be fetched at all.

Since that fallback is deliberately invisible, the smoke suite asserts the authored
sheets actually arrived. A wrong path, a missing copy into `dist/`, or a broken bake
would otherwise leave a world that looks fine and is quietly not using the art.

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
- **A swing travels the way you moved the mouse.** The weapon hauls back opposite
  the stroke and partly out of frame, drives across the view at chest height *and
  forward*, over-travels past the far side, then drifts back to a low central guard.
  The stroke's screen-space vector is decomposed into horizontal and vertical
  components, so one animation covers all eight directions. Earlier versions
  alternated sides automatically on consecutive attacks; with the gesture choosing
  the direction, a forced alternation would fight the player's own input, so the
  history it needed is gone. Vertical cuts carry an extra gain
  (`SWING_VERTICAL_GAIN`) because the original constants were tuned for a full-width
  horizontal sweep and an unscaled uppercut barely moved. What distinguishes the
  motion from the sweeps that came before is that the arm commits: the hand travels
  forward into the strike rather than the wrist merely rotating in place. Three
  earlier versions each failed
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
npm test            # typecheck + 358 unit checks
npm run test:unit   # damage model, mesher, terrain determinism, inventory
npm run test:smoke  # boots the real build in headless Chromium and plays it
npm run survey      # terrain statistics over a 6000-block square
npm run perf        # chunk generation and meshing cost per chunk
npm run shots:terrain  # photographs each terrain feature
npm run trees       # elevation of every tree species
npm run geom        # triangles in view, and which blocks emit them
npm run tiles       # re-bakes assets/blocks/*.glb into public/textures/
```

`npm run tiles` is only needed after changing the source art; its output is
committed. `npm run trees` and `npm run geom` are diagnostics rather than tests:
they print, and the judgement is yours.

The unit checks assert the *design*, not just the code: that a sword is not built
out of boxes and converges on a real point, that a tower shield is big enough to be
cover, that torch embers are anchored inside the flame, that a placed torch is a
slim post rather than a cube, that an open door has no collision, that mana never
regenerates on its own, that materials add no carry weight, that a mace beats plate,
that thrusts beat swings against armour, that a weapon's attacks follow from
its shape, that every mouse direction classifies into the stroke you would expect
and slow drift never commits one, that the mesher culls shared faces and bakes AO, that terrain is
deterministic per seed, that night raises the spawn cap above daytime, that
weather never switches kind mid-downpour, and that a corrupt save is sanitised
rather than trusted.

The smoke test drives a real browser — it walks in all four directions, holds the
mouse button and drags out gesture attacks in several directions, clicks for a
thrust, kills an enemy and collects the orbs, fires the bow, casts a
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
- **Assert state the game records rather than state a test infers.** Which way a
  stroke travelled is read from the direction the game committed to, not guessed
  from sampled poses — inference reported two swings as cutting the same way when
  the second had simply been caught at the start of its travel. The same rule
  retired a signal built on `lastReason`: resolving a stroke that hits nothing, and
  mining whatever the miss landed on, both overwrite it before a test can read it,
  so "did an attack begin?" is now a monotonic `started` counter.

Driving the gestures needed one concession. **Synthetic mouse moves are unusable
under pointer lock**: Chromium reports them as cancelling pairs that sum to roughly
zero, so a scripted drag could never cross the commit threshold no matter how far it
travelled. The drag therefore injects deltas at exactly the point a real event
enters `Input`, while still using real `mouse.down` and `mouse.up`. Everything that
matters — accumulation, classification, look suppression, the geometry fallbacks and
the attack itself — remains the code under test.

And the recurring one: **a single synthetic click behind a fixed wait is not a
test.** Placement and the build tool share a cooldown with whatever attack just ran,
so a click can be swallowed entirely. Those checks now retry and poll for the
outcome, which is what they were always meant to assert. Waiting for the combat
state to read `idle` is not sufficient either: the between-uses cooldown outlives
the recovery phase, and an attack refused by it leaves the *previous* stroke's
direction on display — which reads as a misclassified gesture rather than a no-op.

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
- Terrain is one continuous overworld, with no authored structures in it.
- The world ceiling is 160 blocks, which is the practical limit of the Uint8
  height map. Mountains reach ~152, so there is little headroom left for taller
  terrain without widening that array.
- Lighting is direct only. Placed torches light their surroundings through a small
  pool of point lights rather than a propagating light level, so deep caves stay
  dark no matter how many torches are in them, and only the nearest few planted
  torches actually cast light.
- **No occlusion culling.** Faces are culled against their immediate neighbours and
  chunks against the frustum, and nothing removes the surface that is simply behind
  other surface. Over half the triangles in a surface view are cave wall underground
  (`npm run geom`). The frame-rate governor works around it by trading view
  distance; removing it properly is the largest performance item left.
- Doors are a single block tall; stack two for a full doorway.
- Sound is synthesised, not sampled, so it is stylised rather than realistic. There
  is no music, and no mixer beyond a master volume.
