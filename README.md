# RPG Gardening Simulator

A modular Roblox Luau game built on a strict server-authoritative architecture.
Built in steps; this repository currently contains **Step 1 (Data & Stats)**,
**Step 2 (Plots & Growth Loop)**, **Step 3 (Microtransactions)**,
**Step 4 (Shop & Selling)** and **Step 5 (Master Framework & Hybrid Shop)**.

## Project layout

```
src/
├── Shared/                       → ReplicatedStorage.Shared
│   ├── GameConfig.luau           Master item directory, plantables, animals, economy, structures, shop
│   ├── Types.luau                Shared type definitions for persisted data
│   ├── Growth.luau               Pure crop stage math, used by both server and client
│   ├── Husbandry.luau            Pure maturity and produce math, likewise
│   ├── Buildability.luau         One build-tree verdict for the server and the build menu
│   ├── BuildingActions.luau      One action verdict for the panel and the server
│   ├── Spatial.luau              Reach, splash falloff and blocking queries
│   ├── Combat.luau               Health derivation and the damage/armour table
│   ├── StatusEffects.luau        Pure burn/chill/poison derivation
│   ├── Remotes.luau              Lazy remote creation (server) / lookup (client)
│   ├── RateLimiter.luau          Token-bucket throttle
│   ├── Signal.luau               Pure-Luau event (no BindableEvent serialisation cost)
│   └── TableUtil.luau            DeepCopy / Reconcile
└── Server/                       → ServerScriptService.Server
    ├── Bootstrap.server.luau     Single server entry point; starts services in order
    ├── FrameworkGuard.luau       Fails fast when modules disagree about shared config
    ├── Data/
    │   ├── DataSchema.luau       Saved data template, migrations, normalisation
    │   └── ProfileStore.luau     Session-locked, auto-saving, backup-mirrored DataStore layer
    ├── Plots/
    │   └── CropFactory.luau      Builds the crop model for a seed at a growth stage
    ├── Pens/
    │   └── AnimalFactory.luau    Builds the animal model for a species at a maturity stage
    ├── World/
    │   ├── PlacementService.luau Validate → pay → build → persist → replicate
    │   ├── StructureBuilder.luau Builds the model for a placed structure
    │   ├── ShopBuilder.luau      Builds the Workspace.ShopNPC storefront
    │   └── TrainingGround.luau   A practice range, so the combat layer can be felt
    ├── Combat/
    │   ├── DamageableService.luau One registry for everything with health
    │   ├── StatusEffectService.luau
    │   ├── AttackService.luau    One loop for every attacker
    │   ├── RaidService.luau      Summoned waves, levels and escalation
    │   └── DefeatService.luau    The Checkpoint and the two ways back
    └── Services/
        ├── PlayerDataService.luau   The only module permitted to mutate player data
        ├── FarmService.luau         Planting, harvesting and boosting on placed farms
        ├── AnimalService.luau       Stocking, feeding, collecting and slaughtering in placed pens
        ├── BuildingActionService.luau  One validated entry point for every action on a building
        ├── ShopService.luau         ProcessTransaction: buying and selling any item
        └── MarketplaceService.luau  Developer Product receipt processing

src/Client/                       → StarterPlayer.StarterPlayerScripts.Client
├── HudClient.client.luau         Resource strip, Level/XP, Inventory panel, Robux store
├── ShopClient.client.luau        Builds ShopGui; opens it from the ShopNPC prompt
├── BuildClient.client.luau       The build menu and the placement ghost
├── SelectionClient.client.luau   Click a building: the panel of actions it has
├── CombatClient.client.luau      Health bars and target feedback
├── DefeatClient.client.luau      The defeat panel
├── EffectsClient.client.luau     Draws shots, which have no state to derive from
└── NoticeClient.client.luau      Shows one-line refusals from the server
```

The long-term design target is recorded in [docs/ROADMAP.md](docs/ROADMAP.md).

Built with [Rojo](https://rojo.space): `rojo serve` or `rojo build -o game.rbxl`.

Nothing needs to be placed in Workspace by hand. Farms, pens, towers and the
storefront are all built at runtime from their `GameConfig` definitions, so the
game builds and runs from source with no manual Studio setup.

---

## Step 1: Data & Stats

### What is tracked

| Field       | Type   | Notes                                              |
| ----------- | ------ | -------------------------------------------------- |
| `Cash`      | int    | Clamped to `[0, GameConfig.Economy.MaxCash]`        |
| `Level`     | int    | Clamped to `[1, GameConfig.Progression.MaxLevel]`   |
| `XP`        | int    | Resets on level up; carries leftover               |
| `RevengeTokens`   | int | Premium counter; 2 granted free to new players |
| `Inventory` | table  | **Flat**: `itemId -> amount`, every category alike |
| `Plots`     | table  | Planted crops, keyed by stringified plot index     |
| `PurchaseHistory` | array | Granted `PurchaseId`s; the receipt idempotency ledger |
| `Stats`     | table  | Harvest/plant counters, play time, Robux spent     |

### Data-loss protection

`ProfileStore.luau` implements the ProfileService pattern directly rather than
pulling in a dependency, so the failure behaviour is explicit and auditable:

- **Session locking.** A profile is owned by exactly one server at a time. Every
  save stamps a `{JobId, Timestamp}` lock. A second server loading the same key
  retries while the lock is being refreshed and **never force-steals from a live
  server** — it gives up with `SessionLocked` instead. A crashed server simply
  stops refreshing, its lock ages out after `SessionLockExpire` (120s), and the
  next loader claims it normally. This is what closes the rejoin-duplication
  exploit.
- **No blind overwrites.** Every write is an `UpdateAsync` transform that
  re-checks the lock inside the transaction. If ownership was lost, the write is
  cancelled and the stale server discards its changes rather than clobbering the
  newer session.
- **Mirrored backup store.** Profiles are copied to `<StoreName>_Backup` on
  release and every `BackupInterval`. If the primary key becomes unreadable, the
  profile is rebuilt from the mirror and flagged `IsRecovered`; the flag clears
  once a primary write succeeds again.
- **Fail closed, never fresh.** If the primary cannot be read *and* no backup
  exists, the player is kicked with a rejoin message. Handing out default data
  on a transient outage is how an outage becomes a permanent wipe.
- **Version history.** `ListVersionsAsync` / `GetVersionAsync` expose Roblox's
  30-day DataStore version history for manual restores.
- **Auto-save + shutdown flush.** One `task.spawn` sweep saves due profiles;
  `BindToClose` releases everything within the shutdown budget.
- **Studio fallback.** With API access disabled, an in-memory mock store keeps
  the game playable without touching live data.

### Replication via attributes

No remotes are needed to read state. The server writes attributes; attributes
replicate server → client only, so this is inherently read-only for clients.

| Location                    | Attribute               | Meaning                             |
| --------------------------- | ----------------------- | ----------------------------------- |
| `Player`                    | `Cash`, `Level`, `XP`   | Current values                      |
| `Player`                    | `XPToNextLevel`         | `-1` once max level is reached       |
| `Player`                    | `DataLoaded`            | Gate gameplay on this being `true`  |
| `Player`                    | `SelectedSeed`          | Seed the next plant action will use |
| `Player/Inventory`          | `<itemId>`              | Amount held; absent means none      |

A `leaderstats` folder is also maintained for the default player list.

### Server API

`PlayerDataService` is the only module that mutates player data, so validation,
clamping, replication and persistence all live in one place.

```lua
local PlayerDataService = require(ServerScriptService.Server.Services.PlayerDataService)

-- Reads
PlayerDataService:GetData(player)           -- live table, or nil if not loaded
PlayerDataService:WaitForData(player, 20)   -- yields until ready
PlayerDataService:GetDataSnapshot(player)   -- deep copy, safe to pass around
PlayerDataService:GetCash(player)
PlayerDataService:GetLevel(player)
PlayerDataService:GetItemCount(player, "Seeds", "Carrot")
PlayerDataService:HasItem(player, "Seeds", "Carrot", 2)
PlayerDataService:GetInventory(player, "Seeds")

-- Mutations (all reject NaN, infinity, non-numbers and non-positive amounts)
PlayerDataService:AddCash(player, 50)              -- → new balance, or nil if rejected
PlayerDataService:TrySpendCash(player, 10)         -- → bool; atomic, no partial spend
PlayerDataService:AddXP(player, 25)                -- → new level; applies multi-level jumps
PlayerDataService:AddItem(player, "Seeds", "Carrot", 1)
PlayerDataService:RemoveItem(player, "Seeds", "Carrot", 1)   -- → bool; atomic
PlayerDataService:IncrementStat(player, "TotalHarvested", 1)

-- Signals for downstream systems
PlayerDataService.ProfileLoaded      -- (player, data)
PlayerDataService.ProfileReleased    -- (player)
PlayerDataService.CashChanged        -- (player, newCash, delta)
PlayerDataService.XPChanged          -- (player, newXP, delta)
PlayerDataService.LevelChanged       -- (player, newLevel, previousLevel)
PlayerDataService.InventoryChanged   -- (player, category, itemId, newAmount, delta)
```

---

## Step 2: Plots & Growth Loop

### Where each new file goes

| File                            | Destination                                       | Class        |
| ------------------------------- | ------------------------------------------------- | ------------ |
| `src/Shared/Growth.luau`        | `ReplicatedStorage.Shared.Growth`                 | ModuleScript |
| `src/Shared/Remotes.luau`       | `ReplicatedStorage.Shared.Remotes`                | ModuleScript |
| `src/Server/Plots/PlotBuilder.luau` | `ServerScriptService.Server.Plots.PlotBuilder` | ModuleScript |
| `src/Server/Plots/CropFactory.luau` | `ServerScriptService.Server.Plots.CropFactory` | ModuleScript |
| `src/Server/Services/PlotService.luau` | `ServerScriptService.Server.Services.PlotService` | ModuleScript |

Rules of thumb used above:

- **`Shared` (ReplicatedStorage)** — anything the client will also need.
  `Growth` is there because the client draws countdown timers and must compute
  stages identically to the server; `Remotes` is there because both sides
  resolve the same instances.
- **`Server/Plots`** — world-construction modules. They create instances and
  know nothing about players, rules or data.
- **`Server/Services`** — long-lived systems with state and lifecycle, started
  from `Bootstrap.server.luau`. `PlotService` is the only module here that
  enforces gardening rules.
- **Workspace** — nothing by hand. `Workspace.Gardens` and every garden model
  are created at runtime.

Rojo maps these automatically (`src/Shared` → `ReplicatedStorage.Shared`,
`src/Server` → `ServerScriptService.Server`). If you are placing them manually
in Studio instead, create the `Plots` folder under `Server` and match the table
above exactly — `PlotService` resolves its siblings by path.

### Growth phases

Stages are declared in `GameConfig.Growth.Stages` as fractions of each seed's
`GrowTime`, so all six seeds share one curve and a seventh needs no new code:

| Stage      | From  | Visual                                              |
| ---------- | ----- | --------------------------------------------------- |
| `Seedling` | 0%    | 30% scale, stem tinted strongly green               |
| `Growing`  | 35%   | 65% scale, partially ripened toward the seed colour |
| `Mature`   | 100%  | Full scale (× rarity), seed colour, harvestable     |

`GameConfig` asserts at require time that the thresholds ascend, start at 0 and
end at 1.0, so a bad edit fails loudly on startup instead of mid-session.

Growth is **derived from timestamps, never counted up**:

```lua
Growth.GetStage(seedId, plantedAt, os.time())
```

That single decision gives three properties for free — crops keep growing while
the player is offline, a server restart or lag spike cannot lose progress, and
the stage cannot drift because it is recomputed rather than accumulated.

The server loop (`GameConfig.Growth.TickInterval`, 1s) only writes attributes
and rebuilds a crop model on a stage *transition*, so a full server of mature
gardens costs one comparison per plot per tick. Per-second countdowns are the
client's job, computed from the `ReadyAt` attribute — the server never pushes
timer text.

### Plots

Each player is assigned a garden slot on `ProfileLoaded` and it is torn down on
`PlayerRemoving`. A garden holds `GameConfig.Garden.PlotsPerGarden` (6) plots
which unlock by level via `PlotUnlockLevels` (`{1, 1, 3, 8, 15, 25}`); locked
plots are tinted and their prompts disabled, and they refresh automatically on
`LevelChanged`.

Plot state replicates as attributes on each `Plot` model, so clients can render
crops, timers and lock states with **zero remote traffic**:

| Attribute     | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `OwnerUserId` | Owning player, `0` while unassigned            |
| `PlotIndex`   | 1-based index within the garden                |
| `SeedId`      | Planted seed, `""` while empty                 |
| `PlantedAt`   | Unix seconds                                   |
| `ReadyAt`     | Unix seconds; drive client countdowns from this |
| `Stage`       | `Empty` / `Seedling` / `Growing` / `Mature`    |
| `Locked`      | Whether the owner's level gates this plot      |
| `UnlockLevel` | Level required to use it                       |

Model contract (`PlotBuilder` is the only module that knows this shape):

```
Workspace/Structures/Farm_<instanceId>   (Model, PrimaryPart = Body)
├── Body (Part, carries the attributes above)
│   ├── Label  (BillboardGui -> Title)
│   └── Manage (ProximityPrompt, opens the selection panel)
└── Crop (Model, created/destroyed by FarmService)
```

> The fixed six-slot garden is gone: a farm is a placed structure, and the one
> prompt it carries opens its panel rather than acting. See §2c in
> [docs/ROADMAP.md](docs/ROADMAP.md).

### Interaction security

`ProximityPrompt.Triggered` is driven by the client, so an exploiter can fire it
for any prompt at any range. Every interaction is therefore re-validated on the
server, in this order:

1. **Ownership** — `OwnerUserId` must match the triggering player.
2. **Distance** — the character's `PrimaryPart` must be within
   `MaxActivationDistance + DistanceTolerance`. The engine's own check runs on
   the client, which the exploiter controls.
3. **Cooldown** — `InteractionCooldown` (0.35s) per player.
4. **Unlock level**, then **plot occupancy read from the profile**, not from the
   replicated attribute.
5. **Atomic item changes** — the seed is consumed via
   `PlayerDataService:RemoveItem` *before* the crop is planted, so a spammed
   prompt cannot plant twice from one seed. On harvest the crop is granted
   before the plot is cleared, so a full stack leaves the crop in the ground
   instead of destroying it.

Maturity is recomputed from `PlantedAt` at harvest time rather than trusting the
`Stage` attribute, which is only as fresh as the last tick.

The single remote, `SelectSeed`, carries client *intent* only: the payload is
validated with `GameConfig.GetSeed` (which rejects non-strings), rate limited on
the same budget as prompts, and the result is written back as an attribute.

### Server API

```lua
local PlotService = require(ServerScriptService.Server.Services.PlotService)

PlotService:GetGarden(player)              -- → Model?
PlotService:GetPlot(player, index)         -- → Model?
PlotService:GetTimeRemaining(player, index)-- → seconds, or nil if empty

PlotService.Planted      -- (player, plotIndex, seedId)
PlotService.Harvested    -- (player, plotIndex, seedId)
PlotService.PlantFailed  -- (player, plotIndex, reason)
```

Harvesting grants a crop into the `Crops` inventory bucket plus the seed's
`XPReward`. Converting crops to Cash via `SellPrice` is intentionally left to
the shop/selling step.

### Client-side read example

```lua
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Growth = require(ReplicatedStorage.Shared.Growth)

local player = Players.LocalPlayer

player:GetAttributeChangedSignal("Cash"):Connect(function()
    print("Cash:", player:GetAttribute("Cash"))
end)

-- Countdown for a plot, computed locally with no remote traffic.
local function describe(plot: Model): string
    local seedId = plot:GetAttribute("SeedId")
    if seedId == "" then
        return "Empty"
    end

    local remaining = Growth.GetTimeRemaining(seedId, plot:GetAttribute("PlantedAt"))
    return if remaining > 0 then Growth.FormatTimeRemaining(remaining) else "Ready!"
end
```

### Swapping in authored art

`PlotBuilder` and `CropFactory` are the only modules that know what the world
looks like, and each documents its contract at the top of the file. To use
artist-made models, replace `PlotBuilder.CreateGarden` to clone your template
(keeping the model contract above) and `CropFactory.Create` to clone a model
keyed by seed id and stage. `PlotService` needs no changes.

---

## Step 3: Microtransactions

### Where each new file goes

| File | Destination | Class |
| ---- | ----------- | ----- |
| `src/Server/Services/MarketplaceService.luau` | `ServerScriptService.Server.Services.MarketplaceService` | ModuleScript |

No new folders. Everything else is an edit to existing files: `GameConfig`
(product table, `RevengeTokens` economy values, two remote names), `DataSchema`
(`RevengeTokens`, `PurchaseHistory`, two new stats), `PlayerDataService` (token
API, `SaveNow`), `PlotService` (`CompleteGrowth` and the boost remotes), and
`Bootstrap` (starts `MarketplaceService` last, since its handlers grant through
the other two services).

> **Naming note.** This module intentionally shares a name with the engine's
> `MarketplaceService`. Inside the file the engine service is aliased
> `Marketplace` to keep them apart. Renaming the file to `PurchaseService` is a
> drop-in change — only `Bootstrap` requires it.

### Setup before it can sell anything

Create both Developer Products in the Creator Dashboard
(**Monetization → Developer Products**) and paste their ids into
`GameConfig.Monetization.Products`. Until then the ids are `0`, which never
resolves, and `MarketplaceService:Start()` warns loudly listing exactly which
products are unconfigured. It also reports two products sharing an id, which
would otherwise silently shadow one another.

Open the Robux dialog from the **server**, so the client never needs to be
trusted with product ids:

```lua
MarketplaceService:PromptPurchase(player, "RevengeToken")
```

### Why receipt processing is not like other handlers

Roblox calls `ProcessReceipt` **repeatedly** for the same purchase until the
server returns `PurchaseGranted`. Once granted it is never called again and the
Robux are spent. That creates two failure modes ordinary gameplay code never
faces:

1. **Granting without persisting** — the server dies, the grant is gone, but
   Roblox considers the receipt settled. The player paid for nothing.
2. **Granting without deduplicating** — a retry grants the same purchase twice.
   One payment, many items.

Both are closed:

- Every grant is appended to `data.PurchaseHistory` (the idempotency ledger) and
  the profile is **force-saved before** returning `PurchaseGranted`. If the save
  fails we return `NotProcessedYet` so Roblox retries.
- A retry for an already-recorded `PurchaseId` re-saves and grants **without
  re-applying the effect**.
- The ledger is capped at `MaxPurchaseHistory` (100) so saved data cannot grow
  without bound, trimming oldest first.

Anything unexpected returns `NotProcessedYet` rather than granting: unknown
product id, missing handler, a thrown error, a player who left mid-flight, or
data that is not loaded. `NotProcessedYet` is always safe — the worst case is a
delayed grant, whereas a wrong `PurchaseGranted` is unrecoverable for the player.

`PlayerDataService:SaveNow(player)` exists for exactly this: it queues behind an
in-flight auto-save rather than reporting a spurious failure, and returns
whether the write actually reached the DataStore.

### Product A — +1 Revenge Token

A counter increment, so it always succeeds once data is loaded.

```lua
PlayerDataService:GetRevengeTokens(player)
PlayerDataService:AddRevengeTokens(player, 1)        -- → new total, or nil if rejected
PlayerDataService:TrySpendRevengeTokens(player, 1)   -- → bool; atomic
```

New players receive `GameConfig.Economy.StartingRevengeTokens` (2) for free.
Because the field arrives via `Reconcile`, anyone who saved before it existed
also receives the starting amount on their next load — the intended behaviour
for a newly introduced currency.

`RevengeTokens` replicates as a `Player` attribute like `Cash`.

> There is no mechanic consuming these yet, so for now it is purely a counter.
> Whatever eventually spends them must call `TrySpendRevengeTokens` **before**
> applying its effect and validate its own target server-side — a purchasable
> token that affects other players is the first thing an exploiter will probe.

### Product B — Instant Grow

**This is implemented by backdating `PlantedAt`, not by overriding `ReadyAt`.**

`ReadyAt` and `Stage` are a replicated *projection* of `PlantedAt`, not state.
Writing to either attribute would:

- be reverted by the next 1s growth tick, which recomputes `Stage` from
  `PlantedAt`;
- not persist, since attributes are not saved — the profile is;
- not make the crop harvestable, because `_tryHarvest` deliberately recomputes
  maturity from `PlantedAt` and ignores `Stage`.

A paid purchase would visibly undo itself within a second. Setting
`PlantedAt = os.time() - seed.GrowTime` is the only change that survives the
tick, survives a rejoin, and is honoured by harvest validation.

The purchase also **grants a consumable before applying it**:

```lua
PlotService:CompleteGrowth(player, plotIndex)  -- nil index = pick the best target
```

The receipt handler adds a `GrowthBoost` to the player's `Boosts` inventory
bucket, then tries to spend it immediately. That ordering matters: a receipt
handler must never be able to fail because of world state. If the player bought
this with nothing growing — every crop already mature, or their garden not yet
built — the boost simply stays in inventory and is spent later through the
validated `UseBoost` remote. The purchase is never stranded, and the engine
never gets stuck retrying a receipt the player already paid for.

Supporting behaviour:

- A boost is **refused on an already-mature crop**, so it is never wasted.
- An un-targeted boost picks the plot with the **most time remaining** (where it
  is worth most), ties breaking on the lower index for determinism.
- `ProcessReceipt` cannot carry a plot index, so the client records its intended
  target beforehand via the `SelectPlot` remote. The index is validated there
  (integer, in range, rejecting NaN and infinity) and stored as a server-written
  attribute, so the receipt path never touches client input.

### Verification

The suite covers the ordering guarantees that make this safe: idempotent
replays, unknown product ids, absent players, a boost surviving the growth tick
and then actually harvesting, a boost bought with no valid target being kept
rather than lost, and an injected DataStore failure leaving the receipt pending
and then granting **exactly once** on retry.

---

## Step 4: Shop & Selling

Superseded by Step 5, which replaced the per-item remotes (`BuySeed`,
`SellCrop`) with a single `ProcessTransaction` and moved prices into the master
item directory. The transaction rules introduced here still hold and are
documented below.

---

## Step 5: Master Framework & Hybrid Shop

### Where each new file goes

| File | Destination | Class |
| ---- | ----------- | ----- |
| `src/Server/World/ShopBuilder.luau` | `ServerScriptService.Server.World.ShopBuilder` | ModuleScript |
| `src/Client/ShopClient.client.luau` | `StarterPlayer.StarterPlayerScripts.Client.ShopClient` | **LocalScript** |

`World` is a new folder under `Server`; `Client` is a new folder under
`StarterPlayerScripts` (and a new `StarterPlayer` branch in
`default.project.json`). Everything else is an edit to existing files.

Created at runtime, nothing to place by hand:

```
Workspace/
└── ShopNPC                  (Model, built by ShopBuilder)
    └── Body                 (Part)
        ├── ShopPrompt       (ProximityPrompt)  ← the client listens to this
        └── Title            (BillboardGui)

ReplicatedStorage/Remotes/
├── SelectSeed  SelectPlot  UseBoost      RemoteEvents
├── ProcessTransaction                    RemoteFunction
└── SellAll                               RemoteFunction

Players/<player>/
├── Inventory                (Folder — ONE attribute per item id)
└── leaderstats
```

The `ShopGui` ScreenGui is created by `ShopClient` into `PlayerGui` at runtime,
so the whole interface is version-controlled source rather than a hand-assembled
instance tree. To let an artist lay it out instead, author `StarterGui.ShopGui`
and replace `buildGui()` with lookups into it — nothing else in the file changes.

### 1. Master item directory

`GameConfig` is split by **concern**, not by content type:

| Table | Keyed by | Carries |
| ----- | -------- | ------- |
| `Items` | item id | `Name`, `Category`, `BuyPrice`, `SellPrice`, `MaxStack`, `Rarity` |
| `Plantables` | **seed** item id | `Yields`, `YieldAmount`, `GrowTime`, `XPReward`, `RequiredLevel`, `Color` |
| `Animals` | **livestock** item id | `MatureTime`, `Feed`, `Produces`, `Slaughter`, `HousedIn`, `RequiredLevel`, `Color` |

A `nil` price means "not tradeable in that direction". Seeds and livestock are
buyable but not sellable (no buy-back arbitrage); crops and animal drops are
sellable but not buyable; `GrowthBoost` is neither, because it is Robux-only —
it lives in the directory purely for stacking and UI.

Registered categories: `Seeds`, `Livestock`, `Crops`, `AnimalDrops`, `Boosts`.

| Category | Items |
| -------- | ----- |
| Seeds | `CarrotSeed`, `WheatSeed`, `TomatoSeed`, `PumpkinSeed`, `WatermelonSeed`, `GoldenAppleSeed`, `StarfruitSeed`, plus the combat-plant seeds |
| Livestock | `Chick`, `Piglet`, `Calf` |
| Crops | `Carrot`, `Wheat`, `Tomato`, `Pumpkin`, `Watermelon`, `GoldenApple`, `Starfruit` |
| AnimalDrops | `Egg`, `Milk`, `RawBeef`, `Leather`, `RawChicken`, `RawPork`, `Fat` |
| Boosts | `GrowthBoost` |

`Egg`, `Milk`, `RawBeef` and `Leather` predate husbandry: they were registered
when this directory was built, to prove a new item kind needed no inventory,
replication or schema change. **That claim held.** Adding the mechanic added
`RawChicken`, `RawPork`, `Fat`, a `Livestock` category and a table saying which
animal produces which drop — and nothing in storage, replication or the shop
moved. Selling an egg needed no new code at all, and the `Livestock` shop tab
appeared because the clients build their tabs by iterating `ItemCategories`.

`Plantables` and `Animals` are deliberately the same shape: a seed and a chick
are both an item you buy, consume into a structure, and wait on. Keying
husbandry by the livestock item rather than inventing a separate animal id is
what let the shop, the inventory and the level gate carry over unchanged —
`GetRequiredLevel` is one function serving both.

Future mechanics follow the same shape and touch nothing above:

```lua
GameConfig.Recipes    -- keyed by output id,    Inputs = { Wheat = 3 }
```

Config is asserted at require time: every item id must be a legal attribute
name, every plantable must reference a real `Seeds` item and yield a real
sellable item, every animal must fit in a pen that exists and be worth either
producing from or slaughtering, and every `StarterKit` entry must exist. A bad
edit fails on startup rather than mid-session.

### 2. Unified inventory API

**The rule that makes this scale: storage is flat, categorisation is metadata.**

Inventories are keyed by item id alone. `Category` exists for grouping in UI and
queries — never for addressing storage. So the API has no category parameter:

```lua
PlayerDataService:GetItemCount(player, "RawBeef")
PlayerDataService:HasItem(player, "CarrotSeed", 3)
PlayerDataService:AddItem(player, "Egg", 4)          -- → new amount, or nil
PlayerDataService:RemoveItem(player, "Egg", 2)       -- → bool; atomic
PlayerDataService:GetInventory(player)               -- → { [itemId] = amount }
PlayerDataService:GetInventoryByCategory(player, "AnimalDrops")
```

It genuinely does not care what an item is. Unknown ids are rejected outright —
`GameConfig.Items` is the authority on what can exist, so a typo fails loudly
instead of creating a phantom stack. `MaxStack` comes from the item itself.

Replication is one flat folder, `Player/Inventory`, with one attribute per item
id. Adding `AnimalDrops` required no change to storage, replication or schema.

### 3. Shop interaction remote

One entry point, exactly as specified:

```lua
ProcessTransaction(actionType, itemId, amount)   -- "Buy" | "Sell"
```

```lua
local Remotes = require(ReplicatedStorage.Shared.Remotes)
local transact = Remotes.GetFunction(GameConfig.RemoteNames.ProcessTransaction)

local result = transact:InvokeServer("Buy", "WheatSeed", 10)

if result.Ok then
    print(`Bought {result.Amount} for {result.Spent}; cash now {result.Cash}`)
else
    print(`Refused: {result.Reason}`)
end
```

`SellAll` stays a separate RemoteFunction because it is an aggregate operation,
not a single-item transaction.

`ShopService` is completely category-agnostic — it resolves price, stack limit
and level gate from the directory and never asks what kind of thing it is
trading. Validation order:

1. Action must be exactly `"Buy"` or `"Sell"` (case-sensitive).
2. Item id must resolve in the master directory.
3. The direction must have a price, else `NotPurchasable` / `NotSellable`.
4. Amount sanitised to a positive integer, clamped per request. Rejects NaN,
   infinity, negatives and non-numbers; floors fractions.
5. Level gate from the item's plantable entry.
6. **Capacity checked before money moves**, so the happy path never needs a
   refund. Remaining refund branches `warn` if they fire.
7. **Selling respects the Cash ceiling precisely** instead of letting `AddCash`
   clamp — at the cap the sale is refused and goods are kept; just below it only
   the affordable portion sells. Clamping would consume goods for less than they
   are worth.
8. Throttled by a token bucket, and handlers never let an error escape.

Stable reason codes for UI copy: `NoData`, `InvalidAction`, `InvalidItem`,
`InvalidAmount`, `NotPurchasable`, `NotSellable`, `LevelTooLow`,
`NotEnoughCash`, `NotEnoughItems`, `StackFull`, `CashCapped`, `NothingToSell`,
`RateLimited`, `InternalError`.

Server-side API (safe for NPCs, quests, tutorials):

```lua
ShopService:ProcessTransaction(player, "Sell", "Milk", 3)
ShopService:SellAll(player)
ShopService:GetCatalog(player)

ShopService.ItemBought  -- (player, itemId, amount, totalCost)
ShopService.ItemSold    -- (player, itemId, amount, totalEarned)
```

### 4. Hybrid interaction and 2D UI

`ShopBuilder` creates `Workspace.ShopNPC` with a `ShopPrompt`. `ShopClient`
listens to that prompt **on the client** and opens the panel.

That is deliberate: `ProximityPrompt.Triggered` fires on both sides, and opening
a menu is purely cosmetic, so handling it locally makes the panel appear with
zero latency and costs the server nothing. None of it is trusted — every button
sends a transaction that `ShopService` validates from scratch. The UI never
computes an outcome; it renders prices for display, sends intent, then re-renders
from the server's result and the replicated inventory attributes.

The panel is populated entirely from the directory: category tabs come from
`GameConfig.ItemCategories`, rows from `GetItemsByCategory`, and a Buy or Sell
button appears only if that price is non-nil. Registering a new item makes it
appear with no UI change. Walking away (`PromptHidden`) closes the panel, and an
amount selector (x1/x10/x50) feeds the `amount` argument.

### 5. Migration (breaking change, handled)

Flattening the inventory breaks saved data, so this is a real migration rather
than a reinterpretation. `SchemaVersion` 2:

- flattens `Inventory.{Seeds,Crops,Boosts}` into one item-id map;
- renames seeds so they no longer collide with the crop they yield
  (`Carrot` → `CarrotSeed`), since a flat namespace cannot hold both;
- re-points planted plots at the new seed ids;
- folds `TotalSeedsBought`/`TotalCropsSold` into `TotalItemsBought`/`TotalItemsSold`;
- marks existing players as already having their starter kit, so the first v2
  load is not a windfall.

Verified by loading a Step-1-era profile and asserting every field lands
correctly, plus that re-normalising a v2 profile changes nothing.

### 6. Economy exploit fixed

Found while refactoring, and live in Steps 1–4:

`Inventory.Seeds.Carrot = 3` sat in the `DataSchema` template. `Reconcile`
backfills template keys on every load, and `RemoveItem` **deletes an entry at
zero** — so planting all three starter seeds and rejoining regranted them.
Indefinitely.

Starting items now live in `GameConfig.StarterKit` and are granted once behind
`StarterKitGranted`. The regression test spends the kit, rejoins, and asserts
nothing is regranted.

---

## Evolving the schema

- **Adding a field:** add it to `DataSchema.Template`. Existing players receive
  it on next load via `TableUtil.Reconcile`. No migration needed — this is how
  `Plots` was added in Step 2.
- **Renaming or reshaping:** bump `GameConfig.Data.SchemaVersion` and add a
  function to `DataSchema.Migrations` keyed by the version you migrate *from*.
  Migrations run in sequence, so a player returning several versions behind
  passes through every step.

`DataSchema.Normalize` runs on every load and is the last line of defence
against corrupt or tampered saves: values are coerced and clamped, non-finite
numbers are rejected (`tonumber(1/0)` is `inf`, not `nil`), unknown inventory
buckets and item ids are dropped, and plot entries are discarded unless they map
onto a real plot index and name a seed that still exists in `GameConfig`.

### A note on plot keys

`data.Plots` is keyed by **stringified** plot index (`["1"]`, not `[1]`).
DataStores serialise through JSON, which does not round-trip sparse integer
keys — a table with holes comes back with string keys regardless. Using strings
from the start keeps the saved and in-memory shapes identical.

## Step 6: HUD and the Robux store

### Where each new file goes

| File | Destination | Class |
| ---- | ----------- | ----- |
| `src/Client/HudClient.client.luau` | `StarterPlayer.StarterPlayerScripts.Client.HudClient` | **LocalScript** |
| `docs/ROADMAP.md` | — (documentation) | — |

### HUD

An always-on strip showing Cash, Level, an XP bar and Revenge Tokens, plus
**Inventory** and **Store** panels. Everything is read from replicated state, so
there is nothing to poll and nothing to keep in sync:

| Shown | Source |
| ----- | ------ |
| Cash, Level, XP, XPToNextLevel, RevengeTokens | `Player` attributes |
| Inventory contents | `Player.Inventory` attributes |
| Item names, sell values, categories | `Shared.GameConfig` |
| Store products and descriptions | `Shared.GameConfig` |

The XP bar reads `-1` from `XPToNextLevel` as "max level", because an attribute
cannot hold `math.huge`. The inventory groups by the directory's category order
rather than attribute order, so the panel reads identically every time.

### Store products

Six Developer Products, Clash-of-Clans shaped. **Several share a handler
`Kind`** and differ only in `Amount`, so adding a bigger pack is a config edit
with no new code:

| Product | Kind | Grants |
| ------- | ---- | ------ |
| Pouch of Coins | `Cash` | 2,500 Cash |
| Chest of Coins | `Cash` | 15,000 Cash |
| Instant Grow | `GrowthBoost` | 1 boost |
| Instant Grow x10 | `GrowthBoost` | 10 boosts |
| Extra Garden Plot | `PlotUnlock` | +1 permanent plot |
| +1 Revenge Token | `RevengeToken` | 1 token |

Two handlers **refuse rather than absorb** a grant that would do nothing — a
cash pack when already at `MaxCash`, and a plot unlock at `MaxBonusPlotSlots`.
Both return `NotProcessedYet`, so the receipt stays pending and the player is
never charged for nothing.

### Purchased plot slots

`data.BonusPlotSlots` unlocks plots **past their level requirement**. It is a
purely additive schema field, so `Reconcile` backfills it and **no migration was
needed** — in contrast to the v2 inventory flattening.

Slots apply to the **lowest-indexed still-locked plots**, which makes the result
deterministic and stops a player influencing which plot a purchase opens. A plot
is usable if `level >= requirement` **or** a purchased slot covers it, and
`PlotService:RefreshPlots` re-evaluates after a level up or a grant.

### Purchase flow

The client never sees a Developer Product id. It sends the product's **config
name** over the `PromptPurchase` remote; the server validates it against
`GameConfig` and opens the Robux dialog. Robux prices are fetched per product
with `GetProductInfo` and cached; unconfigured products (`ProductId` `0`) render
as *unavailable* rather than failing.

---

## Troubleshooting a partially synced tree

Rojo only overwrites the paths listed in `default.project.json`, and **its file
watcher can miss files added while a sync session is already running**. The
result is a place holding modules from two different commits, which surfaces as
a nil-index or nil-call with a line number that no longer matches the file you
are reading.

Two guards exist for this:

- **`Bootstrap` resolves every dependency with `FindFirstChild` before requiring
  anything**, and aborts naming every missing path. It never calls
  `require(nil)`, which would otherwise report "Attempted to call require with
  invalid argument(s)" against a Bootstrap line number and tell you nothing.
- **`Server.FrameworkGuard`** compares `GameConfig.FrameworkVersion` against the
  `FrameworkVersion` each service declares, and names the stale module. It is
  loaded *optionally* — a missing guard warns and the server still boots, since
  a diagnostic must never be the thing that breaks startup.

`ShopClient` applies the same idea: version and remote problems warn and disable
the shop UI rather than throwing, and it distinguishes "Shared is from another
commit" from "the remotes never replicated, so the server failed to start".

### Positioning instances from `default.project.json`

Use **`CFrame`**, never `Position`. `BasePart.Position` is a *derived* property:
Rojo accepts it and writes a literal `Position` entry into the place file, but
Studio reads `CFrame` and ignores it, so the part silently lands at the origin.

A 20-stud-thick baseplate written that way centred itself on the origin and
buried the whole world 10 studs under the surface players stood on. The only
visible symptoms were a floating shop label and a working plant prompt, because
`ProximityPrompt`s and `AlwaysOnTop` billboards render through geometry.

Verified-working syntax:

```json
"CFrame": {
  "CFrame": {
    "position": [0, -2, 0],
    "orientation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }
}
```

A bare `[x, y, z]` is rejected at build time; a flat 12-number array also works.
After editing any position, confirm it with
`rojo build -o check.rbxlx` and grep the XML for `name="CFrame"`.

### Full resync

1. Stop the Rojo server. Confirm `git status` is clean and you are on the
   intended commit.
2. In Studio delete `ServerScriptService.Server`, `ReplicatedStorage.Shared` and
   `StarterPlayer.StarterPlayerScripts.Client`.
3. Run `rojo serve` **fresh** (restarting is what picks up newly added files)
   and re-connect — or `rojo build -o game.rbxl` and open the new place.

A healthy startup prints:

```
[Server] Bootstrap complete (framework v5)
```

### Bumping the framework version

Bump `GameConfig.FrameworkVersion` **and** every service's `FrameworkVersion`
whenever a change crosses module boundaries: a renamed config field, a changed
function signature, a reshaped table. Purely additive changes do not need it.

---

## Conventions

- `task.wait` / `task.spawn` / `task.defer` only; no `wait`, `spawn` or `delay`.
- No legacy `Instance.new(class, parent)` second argument.
- Server-authoritative: state flows to clients as attributes; remotes carry
  intent only and are always validated and rate limited.
- Numeric inputs are floored and range-checked before they touch a profile.
- Config is asserted at require time so bad edits fail on startup.
