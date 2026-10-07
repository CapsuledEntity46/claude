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
> positional restriction**.
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

Still to add: watering, fertiliser and compost to accelerate growth; crop health
that regenerates slowly and faster when tended; companion creatures and flying
robots that tend crops automatically.

### 2b. Combat plants ⬜

A gardening *and defence* simulator: alongside food crops, plants that fight.
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
> - **Splash damage** is a radius query. The placement radius has been removed,
>   so this is now the first real need for a spatial helper — worth extracting
>   one rather than writing the distance loop per ability.
> - **"Tanks protect plants behind" is an enemy-targeting rule, not a plant
>   property.** In a lane game it falls out of the geometry; in 3D it has to be
>   explicit — enemies must prefer the nearest blocking entity over whatever is
>   closest in a straight line. That belongs in enemy target selection, and is
>   the one piece here with no existing foundation.
> - Attack cadence should be **derived**: store `LastAttackAt` and compare
>   against a config cooldown, rather than running a timer per plant.

### 3. Animal husbandry 🟡

Drop items exist and are sellable; nothing produces them.

| Animal | Produces |
| ------ | -------- |
| Chicken | Egg, RawChicken |
| Pig | RawPork, Fat |
| Cow | Milk, Leather, RawBeef, Fat |

⬜ Animal entities, pens, feeding, growth to maturity, collection cadence.
In the RTS frame these are herdable units near a Mill, not free-standing props.

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

- Watch towers and automatic turrets, freely placeable
- Enemy hordes that path to the base and attack buildings, crops and the player
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

### 7. Checkpoint and the defeat loop ⬜

The player's survival structure, distinct from match victory:

1. The player starts with **nothing but a `Checkpoint`** in inventory.
2. Placing it establishes the respawn point.
3. While it stands, death simply respawns the player.
4. Destroyed while the player lives → **shattered** state, not a loss. The
   player keeps fighting.
5. Survive and secure the area → a **Rebuild** prompt appears near the wreck.
6. Fall while shattered → **defeat**, offering **Revenge** or **Surrender**.
7. Revenge spends a **Revenge Token**: two free, more purchasable. Revenge may
   target a player or a horde.

> ✅ `RevengeTokens` already exists as a tracked, purchasable, atomically
> spendable counter — this is what it is for. Whatever consumes it must call
> `TrySpendRevengeTokens` **before** granting the revenge, and validate the
> target server-side.

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
> - Target priority is **data on the archetype**, not a branch in the AI:
>   `TargetPriority = "Any" | "Defence" | "Resource"`. The selector reads it.
> - "Nearest building" needs the same spatial query as placement proximity and
>   splash damage. That is now three callers, so the shared spatial helper is
>   worth extracting before troops, not after.
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
| **Status effects** ✅ | Burn/Chill/Poison; the layer combat plants, troops and towers all need before any of them can be interesting |
| **Animal husbandry** | Herds near a Mill; directory already supports the drops |
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
