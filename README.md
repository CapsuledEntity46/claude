# RPG Gardening Simulator

A modular Roblox Luau game built on a strict server-authoritative architecture.
Built in steps; this repository currently contains **Step 1: Data & Stats**.

## Project layout

```
src/
├── Shared/                       → ReplicatedStorage.Shared
│   ├── GameConfig.luau           Tunables: economy, XP curve, seed definitions, attribute names
│   ├── Types.luau                Shared type definitions for persisted data
│   ├── Signal.luau               Pure-Luau event (no BindableEvent serialisation cost)
│   └── TableUtil.luau            DeepCopy / Reconcile
└── Server/                       → ServerScriptService.Server
    ├── Bootstrap.server.luau     Single server entry point; starts services in order
    ├── Data/
    │   ├── DataSchema.luau       Saved data template, migrations, normalisation
    │   └── ProfileStore.luau     Session-locked, auto-saving, backup-mirrored DataStore layer
    └── Services/
        └── PlayerDataService.luau  The only module permitted to mutate player data
```

Built with [Rojo](https://rojo.space): `rojo serve` or `rojo build -o game.rbxl`.

## Step 1: Data & Stats

### What is tracked

| Field       | Type   | Notes                                              |
| ----------- | ------ | -------------------------------------------------- |
| `Cash`      | int    | Clamped to `[0, GameConfig.Economy.MaxCash]`        |
| `Level`     | int    | Clamped to `[1, GameConfig.Progression.MaxLevel]`   |
| `XP`        | int    | Resets on level up; carries leftover               |
| `Inventory` | table  | Bucketed: `Seeds` and `Crops`, each `id -> amount` |
| `Stats`     | table  | Harvest/plant counters, play time, join count      |

### Data-loss protection

`ProfileStore.luau` implements the ProfileService pattern directly rather than
pulling in a dependency, so the failure behaviour is explicit and auditable:

- **Session locking.** A profile is owned by exactly one server at a time. Every
  save stamps a `{JobId, Timestamp}` lock. A second server loading the same key
  retries while the lock is being refreshed and **never force-steals from a live
  server** — it gives up with `SessionLocked` instead. A crashed server simply
  stops refreshing, its lock ages out after `SessionLockExpire`, and the next
  loader claims it normally. This is what closes the rejoin-duplication exploit.
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
| `Player/Inventory/Seeds`    | `<seedId>`              | Amount held; absent means none      |
| `Player/Inventory/Crops`    | `<cropId>`              | Amount held; absent means none      |

A `leaderstats` folder is also maintained for the default player list.

Client-side read example:

```lua
local player = game:GetService("Players").LocalPlayer

local function refresh()
    print("Cash:", player:GetAttribute("Cash"))
end

player:GetAttributeChangedSignal("Cash"):Connect(refresh)
```

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

Example of a correct purchase — spend first, grant second, and never trust a
client-supplied price:

```lua
local seed = GameConfig.GetSeed(requestedSeedId)
if not seed then return end
if PlayerDataService:GetLevel(player) < seed.RequiredLevel then return end

if PlayerDataService:TrySpendCash(player, seed.SeedPrice) then
    PlayerDataService:AddItem(player, "Seeds", seed.Id, 1)
end
```

### Evolving the schema

- **Adding a field:** add it to `DataSchema.Template`. Existing players receive
  it on next load via `TableUtil.Reconcile`. No migration needed.
- **Renaming or reshaping:** bump `GameConfig.Data.SchemaVersion` and add a
  function to `DataSchema.Migrations` keyed by the version you migrate *from*.
  Migrations run in sequence, so a player returning several versions behind
  passes through every step.

### Conventions

- `task.wait` / `task.spawn` / `task.defer` only; no `wait`, `spawn` or `delay`.
- No legacy `Instance.new(class, parent)` second argument.
- Server-authoritative: nothing in Step 1 exposes a writable remote.
- Numeric inputs are floored and range-checked before they touch a profile.
