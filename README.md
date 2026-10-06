# RPG Gardening Simulator

A modular Roblox Luau game built on a strict server-authoritative architecture.
Built in steps; this repository currently contains **Step 1 (Data & Stats)**,
**Step 2 (Plots & Growth Loop)**, **Step 3 (Microtransactions)** and
**Step 4 (Shop & Selling)**.

## Project layout

```
src/
├── Shared/                       → ReplicatedStorage.Shared
│   ├── GameConfig.luau           Tunables: economy, XP curve, seeds, garden, growth stages
│   ├── Types.luau                Shared type definitions for persisted data
│   ├── Growth.luau               Pure stage math, used by both server and client
│   ├── Remotes.luau              Lazy remote creation (server) / lookup (client)
│   ├── RateLimiter.luau          Token-bucket throttle
│   ├── Signal.luau               Pure-Luau event (no BindableEvent serialisation cost)
│   └── TableUtil.luau            DeepCopy / Reconcile
└── Server/                       → ServerScriptService.Server
    ├── Bootstrap.server.luau     Single server entry point; starts services in order
    ├── Data/
    │   ├── DataSchema.luau       Saved data template, migrations, normalisation
    │   └── ProfileStore.luau     Session-locked, auto-saving, backup-mirrored DataStore layer
    ├── Plots/
    │   ├── PlotBuilder.luau      Procedurally builds gardens, soil and prompts
    │   └── CropFactory.luau      Builds the crop model for a seed at a growth stage
    └── Services/
        ├── PlayerDataService.luau   The only module permitted to mutate player data
        ├── PlotService.luau         Garden assignment, plant/harvest, growth loop
        ├── ShopService.luau         Seed buying and crop selling
        └── MarketplaceService.luau  Developer Product receipt processing
```

Built with [Rojo](https://rojo.space): `rojo serve` or `rojo build -o game.rbxl`.

Nothing needs to be placed in Workspace by hand. `PlotService` creates
`Workspace.Gardens` at runtime and `PlotBuilder` generates each garden's parts,
so the game builds and runs from source with no manual Studio setup.

---

## Step 1: Data & Stats

### What is tracked

| Field       | Type   | Notes                                              |
| ----------- | ------ | -------------------------------------------------- |
| `Cash`      | int    | Clamped to `[0, GameConfig.Economy.MaxCash]`        |
| `Level`     | int    | Clamped to `[1, GameConfig.Progression.MaxLevel]`   |
| `XP`        | int    | Resets on level up; carries leftover               |
| `RevengeTokens`   | int | Premium counter; 2 granted free to new players |
| `Inventory` | table  | Bucketed: `Seeds`, `Crops`, `Boosts`, each `id -> amount` |
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
| `Player/Inventory/Seeds`    | `<seedId>`              | Amount held; absent means none      |
| `Player/Inventory/Crops`    | `<cropId>`              | Amount held; absent means none      |

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
Workspace/Gardens/Garden_<slot>   (Model, PrimaryPart = Base)
├── Base   (Part)
└── Plots  (Folder)
    ├── Plot_1 (Model, PrimaryPart = Soil, carries the attributes above)
    │   ├── Soil (Part)
    │   │   └── Interact (ProximityPrompt)
    │   └── Crop (Model, created/destroyed by PlotService)
    └── Plot_2 ...
```

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

Closes the economy loop: **Cash → seeds → crops → Cash**, using the `SeedPrice`
and `SellPrice` already in `GameConfig`.

### Where each new file goes

| File | Destination | Class |
| ---- | ----------- | ----- |
| `src/Shared/RateLimiter.luau` | `ReplicatedStorage.Shared.RateLimiter` | ModuleScript |
| `src/Server/Services/ShopService.luau` | `ServerScriptService.Server.Services.ShopService` | ModuleScript |

No new folders. Edits to existing files: `GameConfig` (`GameConfig.Shop`, three
remote names, `GetPurchasableSeeds`), `Remotes` (`GetFunction` for
RemoteFunctions), `DataSchema` (`TotalSeedsBought`, `TotalCropsSold` stats), and
`Bootstrap` (starts `ShopService` after `PlotService`).

The three RemoteFunctions are created by the server at startup and appear at
runtime under `ReplicatedStorage.Remotes`. Nothing to place by hand:

```
ReplicatedStorage/
└── Remotes/                 (created at runtime by Shared.Remotes)
    ├── SelectSeed           RemoteEvent     (Step 2)
    ├── SelectPlot           RemoteEvent     (Step 3)
    ├── UseBoost             RemoteEvent     (Step 3)
    ├── BuySeed              RemoteFunction  (Step 4)
    ├── SellCrop             RemoteFunction  (Step 4)
    └── SellAllCrops         RemoteFunction  (Step 4)
```

### Why RemoteFunctions here

Steps 2–3 use RemoteEvents because the client was only expressing intent. A
transaction is different: the UI needs to distinguish "not enough cash" from
"stack full" from "level too low" to show the right message, and a
request/response pair is clearer than two one-way events the caller has to
correlate.

Every handler follows the same rule — validate, act, return promptly, and never
let an error escape. An erroring `OnServerInvoke` reports that error to the
caller, which breaks the UI *and* tells an attacker they found an unhandled
path. Each handler is wrapped in `pcall` and returns `InternalError` instead.

### Transaction rules

1. **The client sends intent only** — a seed id and a quantity. Prices, level
   gates and stack limits all come from `GameConfig` on the server. A client
   cannot propose a price.
2. **Capacity is checked before money moves**, so the happy path never needs a
   refund. The refund branches that remain are defence in depth, not expected
   flow — and they `warn` if they ever fire.
3. **Quantities are sanitised** to a positive integer and clamped to a
   per-request cap (`MaxBuyQuantity` 100). Rejects NaN, infinity, negatives and
   non-numbers; floors fractional values. The cap bounds the arithmetic as much
   as the economy — unbounded quantities push intermediate products past the
   range where doubles represent integers exactly.
4. **Selling respects the Cash ceiling precisely** rather than letting `AddCash`
   clamp. At the cap the sale is refused with `CashCapped` and the crops are
   kept; just below it, only the affordable portion sells. Clamping instead
   would consume crops for less than they are worth, which looks exactly like
   theft to the player.
5. **Sell-all iterates in sorted id order.** Luau dictionary order is
   unspecified, so without this a player at the ceiling would have an arbitrary
   subset of their crops sold, differing between calls.

### Rate limiting

Transaction remotes are throttled by a token bucket
(`GameConfig.Shop.RequestsPerSecond` 8, `BurstSize` 12). A bucket rather than a
fixed cooldown because shop traffic is bursty by nature: clicking "buy" five
times in a row is normal, five hundred requests a second is not.

Buckets are keyed by `Player` and dropped on `PlayerRemoving` — otherwise the
table keeps every player who ever joined alive for the life of the server.

### Server API

```lua
local ShopService = require(ServerScriptService.Server.Services.ShopService)

ShopService:BuySeed(player, "Carrot", 5)   -- → result table
ShopService:SellCrop(player, "Carrot", 3)  -- → result table
ShopService:SellAllCrops(player)           -- → result table
ShopService:GetCatalog(player)             -- → seeds buyable at their level

ShopService.SeedPurchased  -- (player, seedId, quantity, totalCost)
ShopService.CropSold       -- (player, cropId, quantity, totalEarned)
```

These are safe to call directly from server code (NPCs, quest rewards,
tutorials); the remote handlers are thin validated wrappers around them.

Results are `{ Ok = true, ... }` or `{ Ok = false, Reason = "<code>" }`. Reasons
are stable codes for the UI to map to copy:

`NoData`, `InvalidSeed`, `InvalidCrop`, `InvalidQuantity`, `LevelTooLow`,
`NotEnoughCash`, `NotEnoughCrops`, `StackFull`, `CashCapped`, `NothingToSell`,
`RateLimited`, `InternalError`

### Client usage

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = require(ReplicatedStorage.Shared.Remotes)
local GameConfig = require(ReplicatedStorage.Shared.GameConfig)

local buySeed = Remotes.GetFunction(GameConfig.RemoteNames.BuySeed)

local result = buySeed:InvokeServer("Carrot", 5)

if result.Ok then
    print(`Bought {result.Quantity} for {result.Spent}; cash is now {result.Cash}`)
else
    print(`Could not buy: {result.Reason}`)
end
```

Stock and prices need no round trip — the client reads them straight from the
shared config:

```lua
for _, seed in GameConfig.GetPurchasableSeeds(player:GetAttribute("Level")) do
    print(seed.DisplayName, seed.SeedPrice, seed.SellPrice)
end
```

### Not included

There is no world-space shop stall. Buying and selling are UI-driven through the
remotes above, and the service deliberately does not require proximity. If you
want a physical stall later, add a `ProximityPrompt` that calls
`ShopService:SellAllCrops` and apply the same server-side distance check
`PlotService` uses.

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

## Conventions

- `task.wait` / `task.spawn` / `task.defer` only; no `wait`, `spawn` or `delay`.
- No legacy `Instance.new(class, parent)` second argument.
- Server-authoritative: state flows to clients as attributes; remotes carry
  intent only and are always validated and rate limited.
- Numeric inputs are floored and range-checked before they touch a profile.
- Config is asserted at require time so bad edits fail on startup.
