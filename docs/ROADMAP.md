# Roadmap

The long-term design target, recorded so incremental work can be judged against
it. **Nothing here is a commitment to build in this order** — it exists so that
decisions made now do not block the systems described later, and so that
anything already built which *conflicts* with the target is marked as
provisional rather than quietly treated as settled.

Status legend: ✅ built · 🟡 partially built · ⬜ not started · ⚠️ built but
provisional (conflicts with the target)

---

## The game

A real-time strategy game in the lineage of Age of Empires and StarCraft,
played from a first/third-person perspective with an MMORPG control scheme. The
player guides a civilisation from a handful of gatherers into an empire:
exploring, expanding, exploiting resources, and exterminating rivals.

Everything is simultaneous and real time. The player balances macro-managing an
economy against micro-managing battles, while personally fighting, building and
riding as an embodied character rather than a disembodied cursor.

---

## RTS core

### Resources

Four gathered resources, in the Age of Empires model:

| Resource | Gathered from | Spent on |
| -------- | ------------- | -------- |
| **Food** | Hunting, foraging, herding, **farms** | Villagers, basic infantry, aging up |
| **Wood** | Forests | Buildings, archers, ships, siege |
| **Gold** | Veins, trade, selling goods | Advanced tech, elite units, aging up |
| **Stone** | Quarries | Walls, towers, castles |

> ⚠️ **This revises an earlier note in this document.** It previously said
> resources should be inventory *items*, with `Cash` as the only currency.
> That is wrong for an RTS: these four are spent continuously on construction
> and training, which is currency behaviour, not inventory behaviour.

### Two kinds of gold ✅

Gold is split in two, with **deliberately asymmetric flows**. This is the most
unusual rule in the economy and the one most likely to be broken by accident.

| | **Base Gold** (treasury) | **Inventory Gold** (purse) |
| --- | --- | --- |
| Earned from | Selling harvested goods at the market | Defeating enemies and players, chest loot |
| Spent on | Building, upgrading, market trade | Equipment, armour, spellbooks, clothing, decorations, items for self or base |
| Can pay for construction | Yes, always | Yes, but only if the player opts in |
| Can be withdrawn to the other | **Never** | n/a |

Rules that follow, and must hold in code:

1. Market sales credit **Base Gold only**. Harvesting and selling can never
   fill the personal purse.
2. Loot and kills credit **Inventory Gold only**.
3. **There is no transfer from Base Gold to Inventory Gold.** Not a restricted
   one — none. The absence of that function *is* the rule.
4. Construction draws Base Gold first. If short, the player may *willingly*
   spend from the purse — a per-player persisted preference decides whether to
   prompt or pay automatically, so repeat builds are one click.
5. Equipment is bought with **Inventory Gold only**.

⬜ A safe in the main house for storing personal gold (a container with its own
capacity and vulnerability, rather than a number on the player).

### Ages

Progression through historical epochs, researched at the Town Center
(Stone → Feudal → Castle → Imperial). Each age costs a large resource sum and
unlocks stronger units, better buildings and technology upgrades.

> **Open decision: Age vs player Level.** The project currently has an MMO-style
> player `Level` and `XP`, and uses Level to gate content. Age of Empires has no
> player level — progression *is* the Age, gated by resources rather than
> experience. This game has both, so their roles must be separated:
>
> - **Age** should gate civilisation capability (what you can build and train).
> - **Level** should gate personal capability (your character's gear, spells,
>   stats) — the MMORPG half.
>
> Anything currently gated by Level that is really a *civilisation* capability
> needs to move to Age. The garden plots are exactly that case (below).

### Building upgrades and per-building tech ⬜

Buildings level up Clash-of-Clans style, and **each building hosts its own
research**, Age of Empires style. Two different mechanics that coexist:

1. **Building level** — upgrading the structure itself (cost, build time,
   health, capacity).
2. **Researched technology** — one-off purchases at a building that
   permanently buff everything of a type, globally and retroactively.

Worked examples of the research half:

**Mill** (AoE2 — farm yield)

| Tech | Age | Cost | Effect |
| ---- | --- | ---- | ------ |
| Horse Collar | Feudal | 75 Food, 75 Wood | +75 food per farm |
| Heavy Plow | Castle | 125 Food, 125 Wood | +125 food per farm, +1 carry |
| Crop Rotation | Imperial | 250 Food, 250 Wood | +175 food per farm |

**Mill** (AoE4 — gather rate)

| Tech | Age | Cost | Effect |
| ---- | --- | ---- | ------ |
| Horticulture | Feudal | 50 Food, 125 Gold | +15% farm gather rate |
| Agricultural Fertilization | Castle | 100 Food, 250 Gold | +15% |
| Soluble Fertilizer | Imperial | 300 Food, 700 Gold | +15% |

**Barracks** — both unit-line transformations (Militia → Man-at-Arms → Long
Swordsman → Two-Handed → Champion; Spearman → Pikeman → Halberdier) and global
infantry buffs (Supplies: −15 food cost; Gambesons: +1 pierce armour; Squires:
+10% infantry speed; Arson: +2 damage to buildings).

> **Architectural notes.**
>
> - A researched tech **retroactively affects units already on the field**, so
>   unit stats must be *computed* from base stats plus owned techs, never
>   stamped onto a unit at spawn. Same discipline as deriving growth from
>   timestamps rather than accumulating it.
> - Techs are a **set of owned ids per player** (`data.Technologies`), and
>   building levels a map of `structureId -> level`. Both are additive schema
>   fields.
> - Effects must be **data, not code**: a tech declares `{ Stat = "GatherRate",
>   Mode = "Multiply", Value = 1.15 }` so adding one is a config edit. A tech
>   that needs new code is a tech that will not scale to a full tree.
> - Tech availability depends on **Age AND building level AND prerequisite
>   techs** — the same dependency check as the build tree, so both should share
>   one resolver.

### Tech tree and build dependencies

Buildings and units unlock in a dependency order — a **build tree**. Each node
has **prerequisites**:

```
Town Center ──▶ Mill ──▶ Wheat Farm
            └─▶ Barracks ──▶ Blacksmith upgrades
            └─▶ Lumber Camp
            └─▶ Mining Camp
```

**Prerequisite dependency** ✅ — the parent building must *exist* somewhere
before the child can be placed. Owning a Mill is what unlocks the Farm; where
either one stands is irrelevant.

> ⚠️ **Proximity radius: tried, removed.** An earlier revision also required
> the child to be placed inside the parent's **influence radius**, as
> city-builders do (Anno, The Settlers). That was a misreading of Age of
> Empires. In AoE, putting a Mill near berries is an **optimisation** — it
> shortens villager walking time — not a permission the Mill grants the ground.
> Enforcing it as a rule made the build menu lie about what was buildable and
> made players fight the game for the right to choose a spot.
>
> Placement is now free inside the world bounds, and **overlap is the only
> positional restriction** — on a four-stud tile grid, so farms tile into an
> unbroken quilt the way AoE's do. Footprints snap by their min corner rather
> than their centre, which is what lets an odd-tile building sit flush against
> an even-tile one.
>
> The radius may well come back, but as an **efficiency bonus** rather than a
> gate: a Farm near its Mill yields faster, or a villager hauls a shorter
> distance. That is the same spatial query, used to reward good layout instead
> of forbidding bad layout — and a bonus cannot softlock a base the way a gate
> can.

> **Architectural note.** The spatial query still wants a single shared
> placement/validation service rather than per-building logic, and that service
> is also the natural home for grid snapping, collision and territory rules.

### Victory conditions

| Condition | Requirement |
| --------- | ----------- |
| **Conquest** | Destroy all enemy production buildings |
| **Wonder** | Build an expensive Wonder and hold it for a countdown |
| **Relics** | Capture relics, hold them in Monasteries for a duration |

> These coexist with the Checkpoint defeat loop below, which governs the
> *player's* survival rather than the match outcome.

---

## Systems

### 1. Economy and progression ✅ / ⚠️

- ✅ Cash, Level, XP, flat item inventory, master item directory, buy/sell
- ⚠️ `Cash` as sole currency — see Resources above
- ⚠️ `Level` used to gate civilisation content — see Ages above

### 2. Farming ⚠️

Currently six fixed plots per garden, unlocked by player Level, with
timestamp-driven growth and harvest.

> ✅ **Replaced.** Farms are *built* by the player, require a **Mill** as
> prerequisite, and may be placed anywhere unoccupied — not in fixed slots
> handed out by player level. The six-slot garden and `PlotBuilder` are gone.
>
> What survives the rewrite: the growth model (timestamps, three visual stages,
> offline growth), `CropFactory`, the item directory and the harvest→sell loop.
> What does not: the fixed six-slot `data.Plots` map, level-gated unlocking, and
> `PlotBuilder`'s pre-built garden.

✅ **Plant density.** A farm square holds a stack of one crop — nine small
(carrot, wheat, tomato), three large (pumpkin, watermelon), one Special. The
point is to make food cheap in *space*: one plant per square meant a player
feeding themselves had no room left, and the combat plants below would never
get built. Density is a property of the plant, not the farm.

> A square fills in one action and is then committed — no topping up a growing
> stack. The two alternatives are both bad: keep the original `PlantedAt` and
> you can plant one carrot, wait until it ripens, add eight and harvest nine
> (the same duplication exploit the Instant Grow backdating turned out to be);
> reset it and adding a ninth throws away eight nearly-ripe plants, which reads
> as a bug rather than a rule.
>
> All plants in a square share one `PlantedAt` and one crop entity, so growth
> stays derived from a single timestamp and a fire takes the whole square.
> Density buys yield at the cost of concentrating risk — a trade worth having.
> Per-plant timestamps and partial harvests are the upgrade path if that ever
> stops being true.

Still to add: watering, fertiliser and compost to accelerate growth; crop health
that regenerates slowly and faster when tended; companion creatures and flying
robots that tend crops automatically.

### 2b. Combat plants ✅

A gardening *and defence* simulator: alongside food crops, plants that fight.

> The `Special` plant-size tier already exists and holds **one per square**, so
> the space budget for these is settled before the first one is written.
> Retrofitting density onto a combat plant would mean rebalancing every wave
> that fights it.
Reference is Plants vs Zombies, adapted to a 3D base under siege.

| Role | Behaviour |
| ---- | --------- |
| **Offensive** | Attack enemies in range on a cooldown |
| **Defensive / tank** | High health, soaks damage and shields plants behind it |
| **Support** | Area effects — slows, buffs, damage over time |

Damage flavours: **fire**, **ice**, **poison**, **splash**.

> **Architectural notes.**
>
> - Most of this is already built. `DamageableService` gives plants health,
>   armour, death and rewards; `GameConfig.Archetypes` gives them stats. A
>   combat plant is an archetype plus a behaviour, not a new system.
> - **Add Fire/Ice/Poison to `GameConfig.Combat.DamageTypes`** and a row each in
>   the multiplier table. The config asserts every damage type prices every
>   armour class, so a half-added type fails at startup rather than silently
>   dealing unmodified damage.
> - ✅ **Status effects** are built: `Shared.StatusEffects` (pure) and
>   `Server.Combat.StatusEffectService`, with Burn, Chill, Poison and
>   Regeneration as config and Fire/Ice/Poison damage types.
>
>   This roadmap previously said effects must be *purely* derived from
>   timestamps, like growth and health. **That was wrong, and the distinction
>   is worth keeping written down.** Growth and health can be derived because
>   nothing depends on observing them at a particular moment; a crop that
>   finishes growing unobserved is simply finished when someone looks. Damage
>   over time is different: the *death* has to happen whether or not anyone is
>   looking. A burning raider that only dies when queried is not burning.
>
>   So the resolution is **tick for liveness, timestamps for correctness**.
>   There is one loop, and its only job is to make death happen on time. The
>   amount is still `PerSecond * Stacks * (now - LastTickAt)` — never
>   `PerSecond * TickInterval`. The two look identical while ticks are regular,
>   which is exactly what makes the naive form dangerous: it converts server
>   stutter into free healing for the enemy, and the symptom (enemies feel
>   tanky when the server is busy) points nowhere near the cause.
>
>   Two further findings: damage over time must **skip flat armour**, because
>   armour is subtracted per hit and a tick is the smallest possible hit — charge
>   it and every effect floors at `MinimumDamage` and armoured targets become
>   fireproof by accident. And effects are **session state**, deliberately not
>   persisted: logging out cures poison, which is a mild exploit, but the
>   alternative is logging in to find you drowned in a loading screen.
> - ✅ **Spatial helper** extracted as `Shared.Spatial`: ground-plane distance,
>   nearest, within-radius, splash falloff and blocking. Ties break by list
>   position, because two equidistant targets would otherwise swap every tick
>   and an attacker would stutter between them instead of killing either.
> - ✅ **"Tanks protect plants behind"** is implemented as
>   `Spatial.FindBlocking`: a raider picks an objective by priority, then
>   fights whatever stands in the corridor between it and that objective.
>
>   Building it taught one thing the note above missed. For an **"Any"**
>   raider the rule is free — the nearest target *is* the thing in the way, so
>   nearest-first gives tanking for nothing. The blocking step only earns its
>   keep for a **priority** raider: a Looter's objective is a Mill deep in the
>   base, and without it the Looter walks straight past the Bulwark. That is
>   the case worth testing, and the first version of the test did not cover it.
> - ✅ **Attack cadence is derived** from `LastAttackAt`, and the rule is the
>   OPPOSITE of status effects. A burn accrues a quantity, so a late tick must
>   bill the time it missed. An attack is a discrete event, so a late tick must
>   **not** fire the shots it missed — a stalled tower fires once and resumes,
>   because banking arrows turns a lag spike into a volley. An attacker with
>   nothing in range also does not spend its cooldown, so it fires the instant
>   something walks in.
>
>   This forced a **second clock**, and the rule is now written down:
>   `os.time()` for anything persisted or replicated (it is unix time, so the
>   client and the next session agree what it means), `time()` for cadence that
>   never leaves the server. `os.time()` is whole seconds, so a 1.2 second
>   cooldown would round to 2 and become indistinguishable from a 2 second one
>   — every attack profile would collapse into the same rate.

### 2c. Selection and building menus ✅

Interaction was all ProximityPrompts, and it did not scale. Reported from play:
the harvest prompt is large, repeatedly pressing **E** down a row of farms
uproots combat plants by accident, and there is no way to *choose* which seed to
plant — the server picked from a `SelectedSeed` attribute that nothing set. Then
husbandry arrived with a building that needed four actions, grew a second prompt
on a second key, and the two drew on top of each other until a pixel offset
pulled them apart.

Built as `Client.SelectionClient` (the panel), `Shared.BuildingActions` (the
rules) and `Server.Services.BuildingActionService` (one validated remote).

- ✅ **Click a building to select it**, or press E on its one remaining prompt.
  A panel opens with the actions that building actually has.
- ✅ **A farm's panel** lists the seeds the player holds, so planting is a
  choice rather than whatever the server guessed. `SelectedSeed` is no longer
  an attribute nothing sets — the panel sends an explicit pick, validated
  server-side like any other client input.
- ✅ **Other buildings** get their actions in the same frame: a pen's four, and
  **Repair** and **Demolish** on everything. Upgrade and per-building
  technology slot into the same list when they exist.
- ✅ **State bars**: condition on every building, plus growth on a farm and
  maturity and feed on a pen. Derived from the replicated attributes on a
  timer, so a countdown ticks without a single remote call.

**A building's actions are data.** `Structures.Coop.Actions` is a list of ids
into `BuildingActions`, and the panel generates itself from it — so a Barracks
with `{ "TrainTroop", "Upgrade", "Rally" }` gets three buttons and needs no UI
code, only a handler. Config asserts that every action a building offers exists,
that no action is offered twice, that a crop-holder offers Plant and Harvest and
a pen offers Stock and Feed, and that no action is declared which no building
offers.

> **Architectural notes.**
>
> - **The panel and the server reach identical verdicts**, because the rule
>   lives in `Shared.BuildingActions` and both sides run it — the same
>   arrangement `Shared.Buildability` already has with the build menu. A greyed
>   out button is a button the server would refuse, with the same reason code.
>   It is a *gate*, not the authority: attributes are only as fresh as the last
>   tick, so the service behind each action still re-derives from timestamps.
> - **Three rungs, not four.** Rate, ownership, availability — and "does this
>   building offer this action" was briefly a fourth until it turned out to be
>   the first thing `IsAvailable` asks, through the same function. A check no
>   test can make fail independently is a line that only looks like safety.
> - **Ownership is the boundary; distance is not.** The prompt path re-checked
>   distance because prompt range is client-enforced. That did not carry over:
>   every action affects only the caller's own buildings and their own
>   inventory, so acting from across the base is not an exploit — it is what
>   selecting a building across the base is *for*. Ownership is read from the
>   profile, not from an attribute a client could have touched.
> - **One remote, dispatched by action id.** The alternative is a remote per
>   verb, each an attack surface to validate separately. Throttling sits on the
>   remote rather than on the public method, so a villager or an automation
>   tool calling `Perform` directly is not rationed — and a *refused* action
>   still costs a token, or spamming a doomed one would be free.
> - **Destructive actions confirm instead of being held.** `Kind =
>   "Destructive"` turns the button into "Confirm?" for a few seconds. The hold
>   gesture existed because an irreversible action sat beside a repeatable one
>   on the same key; a panel can simply ask. `DestructiveHoldDuration` survives
>   for the Checkpoint rebuild, which is still a prompt.
> - **Prompts stay for *world* interactions** that are not about a building you
>   own — the shop, the practice range, the raid horn. Owned buildings keep
>   exactly one, which opens the panel and does nothing else: the server
>   connects nothing to it, because `Triggered` fires on both sides and opening
>   a menu is a client concern. That was already how the shop worked.
> - 🟡 The panel is keyboard-less and has no tabs. A farm with twenty seed
>   types will want them, and so will a Barracks with a research tree.

### 3. Animal husbandry ✅

Built as `Server.Services.AnimalService`, with the maturity and produce
arithmetic in `Shared.Husbandry` so the client derives the same timers the
server validates against.

| Animal | Produces | Slaughtered for |
| ------ | -------- | --------------- |
| Chicken | Egg | RawChicken |
| Pig | — | RawPork, Fat |
| Cow | Milk | RawBeef, Leather, Fat |

✅ Animal entities, pens, feeding, growth to maturity, collection cadence.

The loop is **stock → grow → feed → collect → slaughter**. A pen is to a herd
what a farm square is to a crop: a placed structure holding a stack of one
kind of thing, whose state is four timestamps on its own structure entry. Pens
require a **Mill** — existence, not proximity, per the radius decision above.

Two things turned out to be the whole design:

- **Feed is the throttle.** Produce accrues only over time the herd was fed,
  and feed can be stacked at most `Husbandry.MaxFedWindows` deep. That bounds
  offline production without a separate cap, gives farming a customer other
  than the market, and gives the mechanic an attention cadence.
- **Neglect has teeth.** An unfed herd starves through the ordinary damageable
  registry and dies if ignored. Without it, feeding a pig would be a cost with
  no consequence for skipping it, because maturity is derived from the stocking
  time and arrives whether or not anybody turned up with a bucket.

Three things about those two rules were wrong in the first pass, found by
review rather than by play, and all three are the same mistake — a rule that
looks enforced and is not:

- A newly stocked herd was granted a full **feed window** of grace. A pig's
  `FeedDuration` is longer than its `MatureTime`, so the grace covered the
  whole raise and a barn could be taken to slaughter having never been fed.
  The grace is now a short fixed `StockingGrace`, asserted to be shorter than
  the fastest animal's maturity.
- **Maturity ignored the feed entirely**, which made "can this be raised
  unfed?" an accident of two unrelated numbers — whether the animal matured
  faster than it starved. Reported from play: *"the chickens grow without
  feeding and I didn't notice starvation; cows and pigs had starvation and
  died."* Both halves were true. A chicken matures in 120s and starves in 133,
  so an unfed flock grew up with thirteen seconds to spare; a pig needs 300s
  and dies in 120. Feeding was mandatory for livestock and optional for
  poultry, which is worse than it being either, because the rule looked
  enforced. **A herd now only ages while it is fed** — the hungry span is
  pushed into `StockedAt`, so maturity stays derived from one timestamp and
  nothing accumulates. A test now asserts, for every animal, that starvation
  arrives before the raise could finish.
- **Going hungry was silent.** A hungry herd stops growing, stops laying and
  starts dying, and all three were invisible until the animals were gone. It
  now fires a notice once per spell.
- **And feeding looked like it did nothing.** Reported next as *"the animals
  only get hungry and fed once, after that there is no starvation, but the
  feed button still appears."* The mechanic was working — a test now runs
  three hunger/feed cycles and checks each announces itself and costs health —
  but feed stacks two windows deep, so feeding a hungry herd correctly leaves
  the prompt still offering Feed, and with nothing else on it that reads as a
  button that failed. Every pen prompt now carries the feed state on whatever
  action it is offering (collecting outranks feeding, so a starving flock with
  eggs waiting was saying nothing about the hunger), and the pen's name plate
  shows `fed 4m` or `HUNGRY` from across the base. The countdown moving is
  the acknowledgement that the press worked.

> **The pattern in all of these.** Every husbandry bug so far has been a rule
> that was real but unobservable, and the fix has been the same shape as the
> refusal notices on planting: if the player cannot see a rule, they conclude
> it is not there, and they are not wrong to.
- Starvation was applied only by the tick, which runs for online players,
  while health **regenerates from elapsed time** whether or not anyone is
  watching. Logging out healed a starving herd, so neglect could be reset by
  taking a break. The unfed span is now charged on attach.
- Nothing asserted that starvation **outpaces** regeneration, which two
  numbers in the archetype table could have silently reversed.

> **Architectural notes.**
>
> - Produce is the first **grant** in the project derived from a timestamp, and
>   that needed care. Maturity can be re-derived harmlessly; a payout cannot.
>   Collecting advances the produce clock by the cycles *paid* rather than to
>   `now`, so the grant is consumed exactly once and collecting early does not
>   discard a part-finished cycle.
> - A collection pays **the batches that fit**, not all or nothing. The
>   all-or-nothing version deadlocked: pending produce grows without limit for
>   a herd kept fed, a refused collection leaves the clock untouched, and
>   slaughtering collects first — so past a stack limit the pen could never be
>   emptied by any action, and both prompts went on advertising the eggs. The
>   atomicity argument applies to the items within one batch, not to the number
>   of batches.
> - Feeding after a lapse pushes the produce clock forward by the starved
>   duration. Leaving it alone would let a player feed once a day and be paid
>   for the day; resetting it to `now` would discard batches the herd earned
>   before the feed ran out. Both were wrong, and the second one is the kind of
>   wrong that reads as a bug rather than a rule.
> - One **herd entity** per pen, not one per animal, mirroring the one crop
>   entity per farm square. Density therefore concentrates risk — a Looter that
>   reaches a full coop takes the flock — which is the same trade the farm
>   makes. Herds are tagged `Resource`, so raiders aimed at the economy count
>   livestock as part of it with no targeting change at all.
> - Capacity is a per-animal **space cost** against a per-pen allowance rather
>   than a headcount, per the housing rule below.
> - 🟡 Animals are static props. The roadmap's "herdable units" need the unit
>   command system; writing movement against a pen now would mean writing it
>   twice.
> - ✅ **The pen is what forced §2c.** Four actions against a
>   ProximityPrompt's one gesture meant two prompts on two keys, the
>   irreversible one held — and reported from play, the two **drew on top of
>   each other**, because Roblox puts every prompt on a part in the same
>   screen position. A pixel offset pulled them apart; the selection panel
>   removed the second prompt and with it the reason for the offset. Even
>   then, two prompts could not offer a *choice* of animal.
>
>   The service needed no rework for it: it exposes
>   `TryStock`/`TryFeed`/`TryCollect`/`TrySlaughter`, each validating its own
>   rules, and the panel is one of several things that may call them.

### 4. Fishing ⬜

Rivers and lakes with varied catches — fish species, lobster, squid, octopus.
Caught by hand, by placed fish traps, or by villagers assigned to traps. All
catches sellable.

### 5. Base building ⬜

Free-placement construction in the spirit of Rust/DayZ: walls, floors, ramps,
foundations, snapping and stability.

> **Architectural note.** `data.Plots` is a fixed six-slot map keyed by index
> and deliberately does not generalise. Arbitrary structures need a
> `data.Structures` collection holding id, type, position/rotation and health.
> Since farms become structures too, this system subsumes the plot system — so
> building and farming should be reworked together rather than separately.

### 6. Defences, sieges and combat counters ⬜

- ✅ Watch towers shoot: `Server.Combat.AttackService` is one registry and one
  loop for every attacker. An attacker is an entity whose archetype names an
  `AttackId`, so the tower gained its behaviour with no tower-specific code.
- 🟡 Enemy hordes: raiders spawn, walk to the base and attack it
  (`Server.Combat.RaidService`). **Waves are summoned with a Raid Horn, not
  timed** — pacing and the cost of losing belong to the defeat loop below, and a
  timer attacking players mid-build before any of that exists would be a worse
  game rather than an earlier one. Movement is straight-line with no
  pathfinding, so walls are hit rather than navigated; pathfinding belongs with
  the defeat loop, where walls become a real decision.
- Building health; buildings do **not** self-repair — the player or assigned
  villagers spend resources, with a **Repair All** button
- Enemies drop XP orbs and gold scaled to their level
- Rock-paper-scissors unit counters:

| Unit | Beats | Loses to |
| ---- | ----- | -------- |
| Spearmen / Pikemen | Cavalry | Archers |
| Cavalry | Archers | Spearmen |
| Archers | Spearmen | Cavalry |
| Siege | Buildings, walls | All regular units |

> **Architectural note.** Crops, buildings, turrets, animals, units and the
> player all need health, damage and death. That belongs in **one shared
> damageable system** from the start. Doing it per-system is the single most
> likely source of rework in this plan, and it blocks sieges, building repair
> and combat simultaneously.

### 7. Checkpoint and the defeat loop ✅

The player's survival structure, distinct from match victory:

✅ Built as `Server.Combat.DefeatService`.

1. ✅ The Checkpoint is **built from the build menu** rather than held in
   inventory — it is a structure like any other, and the placement system
   arrived after this was written. It costs 150 Wood and 50 Stone, needs no
   prerequisites, and is available from the Stone Age.
2. ✅ Placing it establishes the respawn point.
3. ✅ While it stands, death respawns the player beside it.
4. ✅ Destroyed while the player lives → **shattered**, not a loss.
5. ✅ A **Rebuild** prompt appears on the wreck, and is blocked while hostiles
   are within `Defeat.SecureRadius` — "secure the area" enforced rather than
   implied, because otherwise a player would stand in the rubble tanking the
   raid and tap it. Rebuilding this way costs the normal repair bill: this
   player survived and still has an economy.
6. ✅ Fall while shattered → **defeat**, offering two ways back.
7. ✅ **Fight On** spends a Revenge Token (`TrySpendRevengeTokens` first, so a
   player with none is told rather than quietly given a free recovery);
   **Surrender** is free in tokens but costs `Defeat.SurrenderPurseLoss` of
   the carried purse.

> **The penalty is the purse, not the treasury.** An earlier revision took a
> quarter of every treasury resource, and that was the wrong pocket. The
> treasury is the settlement — its stores are what farms and mills exist to
> fill, and emptying them undoes hours of building to punish one bad fight.
> The purse is loot won from kills and carried on the person. A raid can cost
> you what you were carrying; it cannot cost you what you built.

> **Why shattering is the whole design.** An anchor that can be destroyed
> outright makes a bad raid unrecoverable — lose it at the wrong moment and you
> are homeless with no way home. One that cannot be destroyed makes a raid
> toothless. Shattering is the third option: the anchor is gone but the *site*
> remains. That is why the only thing that ends a run is falling while
> *already* shattered — one disaster is a story, two in a row is a defeat.
>
> It is also why respawning deliberately does **not** work on a wreck. The
> anchor is the safe place to reappear and the raid has just taken it; putting
> the player back on it would hand straight back the only thing that was lost.

> **Defeat by another player** is agreed and recorded in
> `GameConfig.Defeat.PlayerVictory`, but not reachable: nothing can attack
> another player's base. The victor takes 40% of the loser's purse into their
> own and 60% of each treasury resource into their base, and the loser's
> treasury then **resets to `StartingResources`** rather than being left at
> whatever remained. The reset is a floor as much as a penalty — a wiped-out
> player restarts with a working economy instead of a ruin they cannot rebuild
> from.

### 7c. Revenge as reconquest ⬜

**The agreed replacement for "Fight On".** Today the token simply undoes the
defeat: the raid is called off and the anchor goes back up. That is a
*continue*, and it wastes the most dramatic moment the game has.

Instead: **the enemy keeps your base, and you take it back.**

| | Now | Agreed |
| --- | --- | --- |
| Raid on defeat | Called off | **Stays.** The horde holds your base |
| Anchor | Restored free | Stays ruined until you retake the ground |
| The player | Respawns and carries on | Respawns **with an army**, to fight back |
| Losing again | — | Another token, or the wipe below |

**The army is sized from the horde that beat you.** A level 5 raid earns a
level 5 relief force — roughly 2 tanks, 5 melee, 5 archers. The player fights
alongside it with their own equipment (sword, shield, bow, crossbow, bombs,
armour, spells).

**Out of tokens, or surrender → a full restart**: default resources, a fresh
site on the map, nothing carried over but the account.

> ✅ **Raid levels exist** (`GameConfig.GetRaidLevel`, scaled off Age, with
> `LevelScaling` driving health and damage) and the worst level a player has
> faced is persisted as `data.LastRaidLevel` — because the army is chosen
> *after* the horde is gone, so the number has to outlive the raiders.

> **What this needs that does not exist.** In dependency order:
>
> 1. **Troops** (7b) — the relief force is player-owned units. The attack,
>    targeting and spatial layers already serve them; what is missing is
>    player-unit movement and a housing/roster model.
> 2. **Occupation as persistent state** — "the enemy holds your base" has to
>    survive a logout, which means the occupying force is saved, not just the
>    session's raiders. It also forces answers: do farms keep growing while
>    occupied? can the player build? That is a real design surface, not a flag.
> 3. **Player equipment** (9) — the player's own contribution to the fight.
> 4. **Relocation** — "a fresh site on the map" implies the map has *sites*.
>    Placement is currently free anywhere inside the world bounds, so there is
>    no such concept yet.

> ⚠️ **Open questions worth settling before any of it is built.**
>
> - **What exactly does the wipe take?** Structures and resources are clear.
>   Does it also take XP level, the item inventory, unlocked ages? A total
>   reset makes the game a roguelike; keeping level and items makes it a
>   setback. These are very different games and the answer changes how harsh
>   defeat may safely be.
> - **Is the wipe reachable by accident?** A player who ignores the panel,
>   or closes the game while defeated, must not wake up wiped. The defeat
>   state persists, so this needs an explicit rule.
> - **Can the occupying force be ground down?** If the player chips at it with
>   combat plants and towers that survived, reconquest may need no army at all.
>   Either that is a legitimate strategy or the garrison needs to not be
>   attackable until revenge begins.

> ✅ **Raiders can hurt the player**, which the loop needs or "fall while
> shattered" is unreachable except by accident. The player is **not** a
> damageable entity: their health belongs to their Humanoid, because the engine
> already owns respawning and the bar above a character, and a second authority
> for one number shows up as health flickering between two values. So a player
> is a target carrying a Humanoid instead of an `EntityId`, and the one place
> that difference matters is where damage lands — the counter table still
> prices the hit, from `GameConfig.PlayerCombat`.

### 7b. Troops and the Barracks ⬜

Age of Empires units plus custom ones, with Clash-of-Clans style progression:
**each Barracks upgrade unlocks new troops**, rather than only improving old
ones.

**Movement and attack classes** — every combination is wanted:
ground melee, ground ranged, flying melee, flying ranged.

**Tactical roles (the combat trifecta).** Army composition should require
mixing all three, or one unit becomes strictly correct:

| Role | Profile | Purpose |
| ---- | ------- | ------- |
| **Tank** | High HP, low DPS, slow | Deployed first to absorb tower fire |
| **Brawler** | Medium HP, high DPS | Punches through the core |
| **Nuker / Support** | Low HP, extreme DPS or healing | Sits behind tanks |

**Special behaviours** to support: summoners that spawn low-HP minions,
healers, and elemental damage (fire, ice, poison) — the same flavours the
combat plants use, so one damage-type table serves both.

**Housing space.** Every unit costs capacity in Army Camps, and camp upgrades
raise the cap. This is the main lever limiting army composition, and it must be
a per-unit config number, not a unit count.

> 🟡 Already proven by husbandry: `GameConfig.AnimalSizes` gives each animal a
> `Space` cost and each pen a `LivestockSpace` allowance, and
> `GetPenCapacity(structureId, stockId)` divides one by the other. Army Camps
> want the same two fields under different names.

#### Target priority

Troops act autonomously once deployed. Clash of Clans distinguishes:

| Priority | Behaviour |
| -------- | --------- |
| **Any target** | Attacks the nearest building. Ground units evaluate the three closest reachable targets; air units use straight-line distance |
| **Defence-specific** | Ignores resource and trash buildings, paths straight at defensive towers |
| **Resource-specific** | Targets mines, collectors and storages, with bonus damage |

> **Decision: priority is a per-archetype default, and a toggle is deferred.**
> Enemy armies get a fixed priority from config, which is enough to make hordes
> read as intentional rather than random. A player-facing "priority target"
> toggle is technically straightforward — it is one field on an order sent to
> selected units — but it only becomes meaningful once unit selection exists,
> so it belongs with RTS unit command rather than here.

> **Architectural notes.**
>
> - ✅ Target priority is **data on the archetype**, not a branch in the AI:
>   `TargetPriority = "Any" | "Defence" | "Resource"`, matched against each
>   target's `TargetTag`. Nothing in the selector knows what a Mill is. A
>   priority that finds nothing falls back to anything, so a Resource-specific
>   unit in a base with no Mills fights rather than standing idle.
> - ✅ The shared spatial helper was extracted with combat plants, so troops
>   inherit it. Factions came with it: `Player` and `Hostile` fight, `Neutral`
>   fights nobody. Player-versus-player is deliberately absent — when it
>   arrives it needs a raid or truce *relationship*, not a fourth faction,
>   because "are these two at war" is a fact about the pair.
> - **Housing space, troop stats and unlock tier are config**; only the
>   behaviours (summon, heal, elemental hit) are code, and each should be a
>   small named behaviour an archetype references.
> - A Barracks upgrade unlocking a troop is the **same dependency check** the
>   build tree already does — structure level and Age gating a recipe. Reuse
>   the resolver rather than writing a second one.

### 8. RTS unit command ⬜

Box-select multiple units with a free-moving cursor; issue move, attack, gather
and build orders; assign villagers to tasks and to drop-off buildings.

> **Architectural note.** Needs a custom camera and
> `UserInputService.MouseBehavior`, because Roblox locks the cursor to the
> camera in first person. Camera work was deliberately deferred; this is the
> system that requires revisiting it. Orders must be validated server-side —
> selection is a client convenience, never an authority.

### 9. Player combat, equipment and traversal ⬜

MMORPG HUD with selectable spells and an action bar. Swords, spears, maces,
bows, crossbows, shields, grenades, flintlocks, spells. Horses, hang gliders,
climbing.

**Character sheet** — reference is the Titan Quest style panel:

- A **paper-doll** centre panel rendering the equipped character
- **Equipment slots** around it: main hand, off hand / shield, head, torso,
  gloves, boots, amulet, two rings — mirrored left and right of the doll
- **Primary / Secondary** stat tabs. Secondary holds resistances (physical,
  cold, poison, lightning, and a generic one), health and energy regeneration,
  offensive and defensive ability, cast speed, run speed
- **Lifetime record** lines: greatest monster killed, monsters killed, greatest
  damage dealt, elapsed time, total deaths
- **Carried gold** shown on the panel — this is the *purse*, not the treasury
- A **multi-tab inventory grid** at the bottom, several bags of slots

> **Architectural notes.**
>
> - Resistances, regeneration, offensive/defensive ability, cast and run speed
>   are all **derived stats**: base + equipment + buffs + researched tech. They
>   must be computed on read, never stored, for the same reason growth is
>   derived from timestamps. Storing them means every stat source has to
>   remember to recompute, and one that forgets desynchronises silently.
> - The lifetime record lines are counters and belong in `data.Stats`, which
>   already exists and already persists.
> - A **grid** inventory is a different model from the current flat
>   `itemId -> amount` map: grids need per-slot positions and stack splitting.
>   That is an additive change (`data.InventorySlots`) but it is a real
>   redesign, not a UI skin over the current map. Worth deciding whether the
>   grid is cosmetic (auto-arranged from the flat map) or authoritative
>   (player-arranged, persisted) before building it.
> - The purse shown here is `InventoryGold`, which already exists and is already
>   loot-only.

### 10. Trade and logistics ⬜

Markets; pack donkeys and carts carrying goods to other players or an NPC city.
Player-to-player trade. In AoE terms this is also how Gold is earned without a
vein.

### 11. Monetisation 🟡

Clash-of-Clans style: resource packs, instant finishes, permanent unlocks,
revenge continues.

- ✅ Receipt processing with a durable idempotency ledger and save-before-grant
- ✅ Cash packs, Instant Grow (×1 and ×10), Revenge Tokens
- ✅ **Extra Garden Plot removed**, replaced by Food/Wood/Stone resource packs.
  A "plot slot" stops being a meaningful unit once farms are freely placed
  structures, and changing what a *live* product grants is far worse than
  changing it before launch. `BonusPlotSlots` remains in the schema and is still
  honoured, so it can be granted as a quest or admin reward.
- ⬜ Real Developer Product IDs (all placeholders are `0`)
- ⬜ Cosmetics, battle pass

---

## Suggested order

Each step should be shippable and testable on its own.

| Step | Why here |
| ---- | -------- |
| **Verify persistence against a real DataStore** | Highest risk in the project; cheapest to check |
| **Four-resource economy + Ages** | Everything below prices in resources and gates on Age; doing it late means repricing everything |
| **Shared damageable system** | Blocks buildings, sieges, repair and combat at once |
| **Placement service** (prerequisites, free placement, overlap only) | The foundation for farms, drop-off points, defences and base building |
| **Rework farming onto placement** | Farms become Mill-dependent structures; retires the fixed plot map |
| **Selection and building menus** ✅ | Prompts did not scale: no seed picker, E-spam destroyed defences, and a pen needed two overlapping prompts. Actions are data now, so the next building's menu is a config edit |
| **Checkpoint and the defeat loop** ✅ | Gives a raid stakes: an anchor that shatters, and two ways back that cost different things |
| **Combat plants, attacks and raiders** ✅ | Towers and plants shoot, raiders walk in and pick targets; the spatial helper three systems wanted |
| **Build UX: sticky placement** ✅ | Hold a building and place a row of them; one shared buildability rule for the server and the menu |
| **Grid snapping + plant density** ✅ | Farms tile like AoE's, and a square holds a stack so food stops eating the whole base |
| **Status effects** ✅ | Burn/Chill/Poison; the layer combat plants, troops and towers all need before any of them can be interesting |
| **Animal husbandry** ✅ | Herds in Mill-dependent pens; the directory did already support the drops, and feed gave farming a customer |
| **Checkpoint and defeat loop** | Defines player survival; gives Revenge Tokens meaning |
| **Defences and hordes** | Depends on damageable + placement |
| **RTS unit command** | Needs the custom camera |
| **Player combat and traversal** | Largest surface area; benefits from everything above |
| **Fishing, trade, companions, victory conditions** | Content layers over established systems |

> The order changed from the previous revision: the four-resource economy and
> the placement service moved up, because farming, husbandry, defences and
> building all depend on them. Building farming first and reworking it later
> costs more than doing resources first.

## Principles that should not bend

1. **The server is authoritative.** Clients send intent; the server validates
   against config it owns. Selection, aiming and UI are client conveniences.
2. **Storage is flat; categorisation is metadata.** New item kinds must not
   require inventory, replication or schema changes.
3. **State is derived from timestamps, not accumulated.** It survives restarts,
   lag and logouts.
4. **Grants are durable before they are acknowledged.** Especially receipts.
5. **Config is asserted at require time**, so bad edits fail on startup.
6. **Dependencies are data, not code.** Build-tree prerequisites and proximity
   radii belong in `GameConfig`, so adding a building is a config edit.
