# Roadmap

The long-term design target, recorded so incremental work can be judged against
it. **Nothing here is a commitment to build in this order** — it exists so that
decisions made now do not block the systems described later.

Status legend: ✅ built · 🟡 partially built · ⬜ not started

---

## The game

A first/third-person RTS-survival hybrid in the spirit of StarCraft and Age of
Empires, with an MMORPG control scheme. The player levels up, builds an economy,
gathers resources, raises animals, fishes, fortifies a base, and commands armies
against rival civilisations and enemy hordes.

---

## Systems

### 1. Economy and progression ✅

Cash, Level, XP, a flat item inventory, a master item directory, buy/sell
through a physical shop. See the main README.

### 2. Farming 🟡

- ✅ Six plots per garden, unlock by level, timestamp-driven growth, harvest
- ⬜ Watering, fertiliser and compost to accelerate growth
- ⬜ Crop health bar; crops regenerate slowly, faster when tended
- ⬜ Companions (animals, creatures, flying robots) that water and fertilise
  automatically

### 3. Animal husbandry 🟡

Drop items already exist in the directory and are sellable; nothing produces
them yet.

| Animal | Produces |
| ------ | -------- |
| Chicken | Egg, RawChicken |
| Pig | RawPork, Fat |
| Cow | Milk, Leather, RawBeef, Fat |

- ✅ `Egg`, `Milk`, `RawBeef`, `Leather` registered and sellable
- ⬜ Animal entities, pens, feeding, growth-to-maturity, collection cadence

### 4. Fishing ⬜

Rivers and lakes with varied catches — fish species, lobster, squid, octopus.
Caught by hand, by placed fish traps, or by villagers assigned to traps
(Age of Empires style). All catches are sellable items.

### 5. Base building ⬜

Free-placement construction in the spirit of Rust/DayZ: walls, floors, ramps,
foundations, snapping and stability rules.

> **Architectural note.** `data.Plots` is a fixed six-slot map keyed by plot
> index. That deliberately does not generalise to free placement. Arbitrary
> structures will need a separate `data.Structures` collection holding an id,
> structure type, position/rotation and health. That is an additive schema
> change for a new field, but the placement system itself is a large piece of
> work and should be its own step.

### 6. Defences and sieges ⬜

- Watch towers and automatic turrets, freely placeable around the base and crops
- Enemy hordes that path to the base and attack buildings, crops and the player
- Building health bars; buildings do **not** self-repair — the player or
  assigned villagers spend resources to repair, with a **Repair All** button
- Enemies drop XP orbs and gold coins scaled to their level

> **Architectural note.** Crops, buildings, turrets, animals, units and the
> player all need health, damage and death. That belongs in **one shared
> "damageable" system** from the start, not bolted onto `PlotService`. Doing it
> per-system is the single most likely source of rework.

### 7. Checkpoint and the defeat loop ⬜

This is the match structure:

1. The player starts with **nothing but a `Checkpoint` structure** in inventory.
2. Placing it establishes the respawn point.
3. While the Checkpoint stands, death simply respawns the player.
4. If the Checkpoint is destroyed while the player lives, it enters a
   **shattered** state — not a loss. The player keeps fighting.
5. Survive and secure the area → a **Rebuild** prompt appears near the wreck.
6. Fall with the Checkpoint shattered → **defeat**, offering:
   - **Revenge** — re-enter the fight against the player or horde that won
   - **Surrender**
7. Revenge uses a **Revenge Token**. Two are granted free; more are purchasable.

> ✅ `RevengeTokens` already exists as a tracked, purchasable, atomically
> spendable counter — this design is what it is for. Whatever consumes it must
> call `TrySpendRevengeTokens` **before** granting the revenge, and validate the
> target server-side.

### 8. RTS unit command ⬜

Box-select multiple units with a free-moving cursor, issue move/attack/gather
orders, assign villagers to tasks.

> **Architectural note.** This needs a custom camera and
> `UserInputService.MouseBehavior`, because Roblox locks the cursor to the camera
> in first person. Camera work was deliberately deferred; this is the system
> that will require revisiting it. Orders must be validated server-side — unit
> selection is a client convenience, never an authority.

### 9. Player combat and traversal ⬜

MMORPG-style HUD with selectable spells and an action bar. Swords, spears,
maces, bows, crossbows, shields, grenades, flintlocks, spells. Horses, hang
gliders, climbing.

### 10. Trade and logistics ⬜

Markets; pack donkeys and carts carrying goods to other players or to an NPC
city. Player-to-player trade.

> **Architectural note.** Resource types (wood, stone, food, ore) should be
> **items in the existing flat inventory**, not new currencies. The directory
> and inventory already handle any item id; adding a currency per resource would
> duplicate the economy layer. Keep `Cash` as the only true currency.

### 11. Monetisation 🟡

Clash-of-Clans style: resource packs, instant-finish boosts, permanent
unlocks, revenge tokens.

- ✅ Receipt processing with a durable idempotency ledger and save-before-grant
- ✅ Revenge Tokens, Instant Grow, Cash packs, Plot unlocks
- ⬜ Real Developer Product IDs (placeholders are `0`)
- ⬜ Cosmetics, battle pass, builder slots

---

## Suggested order

Each step should be shippable and testable on its own.

| Step | Why here |
| ---- | -------- |
| **Verify persistence against a real DataStore** | Highest risk in the project; cheapest to check |
| **Animal husbandry** | The directory already supports it; proves the framework scales |
| **Shared damageable system** | Blocks sieges, buildings and combat; cheap now, expensive later |
| **Checkpoint and defeat loop** | Defines the match; gives Revenge Tokens meaning |
| **Base building** | Large; needs `data.Structures` |
| **Defences and hordes** | Depends on damageable + building |
| **RTS unit command** | Needs the custom camera |
| **Player combat and traversal** | Largest surface area; benefits from everything above |
| **Fishing, trade, companions** | Content layers over established systems |

## Principles that should not bend

1. **The server is authoritative.** Clients send intent; the server validates
   against config it owns. Selection, aiming and UI are client conveniences.
2. **Storage is flat; categorisation is metadata.** New item kinds must not
   require inventory, replication or schema changes.
3. **State is derived from timestamps, not accumulated.** It survives restarts,
   lag and logouts.
4. **Grants are durable before they are acknowledged.** Especially receipts.
5. **Config is asserted at require time**, so bad edits fail on startup.
