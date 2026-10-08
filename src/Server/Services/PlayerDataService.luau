--!nonstrict
--[[
	PlayerDataService
	-----------------
	The only module in the game allowed to mutate player data.

	Every other system (planting, shop, selling, quests) goes through this API,
	which means validation, clamping, replication and persistence all live in
	one auditable place. No RemoteEvent in this service is writable by the
	client: there are no client-facing remotes here at all.

	REPLICATION MODEL
	-----------------
	Scalars replicate as attributes on the Player instance:
		Food, Wood, Gold, Stone, InventoryGold, Age, AgeName,
		Level, XP, XPToNextLevel, DataLoaded

	Inventory replicates as attributes on one flat folder, because attributes
	cannot hold tables:
		Player/Inventory  -> one attribute per ITEM ID, value = amount

	The inventory is deliberately category-agnostic: it stores `Egg = 4` the
	same way it stores `CarrotSeed = 3`. Whether an id is a seed, a crop or a
	side of beef is a property of GameConfig.Items, not of storage. A new
	category therefore needs no change here at all.

	Clients therefore need zero remotes to read state; they listen to
	GetAttributeChangedSignal and AttributeChanged. Attributes replicate
	server -> client only, so this is read-only from the client's perspective.

	USAGE
	-----
		local PlayerDataService = require(...)
		PlayerDataService:Start()

		if PlayerDataService:TrySpendGold(player, seed.SeedPrice) then
			PlayerDataService:AddItem(player, seed.Id, 1)
		end
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local RateLimiter = require(Shared.RateLimiter)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)
local TableUtil = require(Shared.TableUtil)

local DataSchema = require(script.Parent.Parent.Data.DataSchema)
local ProfileStore = require(script.Parent.Parent.Data.ProfileStore)

local ATTR = GameConfig.Attributes
local KICK_DATA_FAILURE =
	"We could not load your saved garden. Please rejoin in a moment - your progress is safe."
local KICK_LOCK_LOST = "Your data is active on another server. Please rejoin."

local PlayerDataService = {}

-- Checked against GameConfig.FrameworkVersion by Server.FrameworkGuard.
PlayerDataService.FrameworkVersion = 15

PlayerDataService._started = false
PlayerDataService._profiles = {} :: { [Player]: any }
PlayerDataService._store = nil

--------------------------------------------------------------------------------
-- Signals (server-side only; gameplay systems subscribe to these)
--------------------------------------------------------------------------------

PlayerDataService.ProfileLoaded = Signal.new() -- (player, data)
PlayerDataService.ProfileReleased = Signal.new() -- (player)
PlayerDataService.ResourceChanged = Signal.new() -- (player, resourceId, newAmount, delta)
PlayerDataService.InventoryGoldChanged = Signal.new() -- (player, newAmount, delta)
PlayerDataService.AgeChanged = Signal.new() -- (player, newAge, previousAge)
PlayerDataService.RevengeTokensChanged = Signal.new() -- (player, newTotal, delta)
PlayerDataService.XPChanged = Signal.new() -- (player, newXP, delta)
PlayerDataService.LevelChanged = Signal.new() -- (player, newLevel, previousLevel)
PlayerDataService.InventoryChanged = Signal.new() -- (player, itemId, newAmount, delta)

--------------------------------------------------------------------------------
-- Validation helpers
--------------------------------------------------------------------------------

--- Coerces an untrusted amount into a safe positive integer, or nil if invalid.
--- Rejects NaN, infinity and non-numbers, which are the usual vectors for
--- turning an arithmetic bug into an economy-breaking value.
local function toPositiveInteger(value: unknown): number?
	local number = tonumber(value)

	if number == nil or number ~= number or number == math.huge or number == -math.huge then
		return nil
	end

	number = math.floor(number)
	if number <= 0 then
		return nil
	end

	return number
end

--------------------------------------------------------------------------------
-- Replication
--------------------------------------------------------------------------------

local function getInventoryFolder(player: Player): Folder?
	return player:FindFirstChild(GameConfig.InventoryFolderName) :: Folder?
end

local function buildReplicationContainers(player: Player)
	-- leaderstats drives Roblox's built-in player list.
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"

	local goldValue = Instance.new("IntValue")
	goldValue.Name = "Gold"
	goldValue.Parent = leaderstats

	local levelValue = Instance.new("IntValue")
	levelValue.Name = "Level"
	levelValue.Parent = leaderstats

	leaderstats.Parent = player

	-- One flat folder for every item id, regardless of category.
	local inventory = Instance.new("Folder")
	inventory.Name = GameConfig.InventoryFolderName
	inventory.Parent = player
end

--- Pushes every scalar from the profile onto the player's attributes.
local function syncStats(player: Player, data: { [string]: any })
	-- One attribute per resource, named from the directory, so adding a
	-- resource needs no change here.
	for resourceId in GameConfig.Resources do
		player:SetAttribute(resourceId, data.Resources[resourceId] or 0)
	end

	player:SetAttribute(ATTR.InventoryGold, data.InventoryGold)
	player:SetAttribute(ATTR.Age, data.Age)

	local age = GameConfig.GetAge(data.Age)
	player:SetAttribute(ATTR.AgeName, if age then age.Name else "Unknown")

	player:SetAttribute(ATTR.Level, data.Level)
	player:SetAttribute(ATTR.XP, data.XP)
	player:SetAttribute(ATTR.RevengeTokens, data.RevengeTokens)

	local required = GameConfig.GetXPForLevel(data.Level)
	-- Attributes cannot store math.huge; use -1 to mean "max level reached".
	player:SetAttribute(ATTR.XPToNextLevel, if required == math.huge then -1 else required)

	local leaderstats = player:FindFirstChild("leaderstats")
	if leaderstats then
		local goldValue = leaderstats:FindFirstChild("Gold")
		local levelValue = leaderstats:FindFirstChild("Level")

		if goldValue then
			goldValue.Value = data.Resources[GameConfig.PrimaryResource] or 0
		end
		if levelValue then
			levelValue.Value = data.Level
		end
	end
end

local function syncInventoryItem(player: Player, itemId: string, amount: number)
	local folder = getInventoryFolder(player)
	if not folder then
		return
	end

	-- Clearing the attribute (rather than writing 0) keeps the replicated set
	-- identical to the saved set: only owned items exist.
	folder:SetAttribute(itemId, if amount > 0 then amount else nil)
end

local function syncInventory(player: Player, data: { [string]: any })
	local folder = getInventoryFolder(player)
	if not folder then
		return
	end

	for itemId in folder:GetAttributes() do
		folder:SetAttribute(itemId, nil)
	end

	for itemId, amount in data.Inventory do
		folder:SetAttribute(itemId, amount)
	end
end

--------------------------------------------------------------------------------
-- Session lifecycle
--------------------------------------------------------------------------------

function PlayerDataService:_onPlayerAdded(player: Player)
	buildReplicationContainers(player)
	player:SetAttribute(ATTR.DataLoaded, false)

	local profile, failureReason = self._store:LoadProfileAsync(tostring(player.UserId), { player.UserId })

	if not profile then
		warn(`[PlayerDataService] Could not load profile for {player.Name} ({failureReason})`)

		if player.Parent then
			player:Kick(KICK_DATA_FAILURE)
		end

		return
	end

	-- The player may have left during the load yield.
	if not player.Parent then
		profile:Release()
		return
	end

	profile.Released:Connect(function(reason: string)
		self._profiles[player] = nil

		if player.Parent then
			player:SetAttribute(ATTR.DataLoaded, false)

			if reason == "LockLost" then
				player:Kick(KICK_LOCK_LOST)
			end
		end
	end)

	local data = profile.Data
	data.Stats.JoinCount += 1
	data.Stats.LastSeen = os.time()

	-- Monotonic clock, so play time cannot be skewed by wall-clock changes.
	profile._sessionStart = os.clock()
	self._profiles[player] = profile

	-- Granted once per profile, before the first replication pass.
	if DataSchema.GrantStarterKit(data) then
		print(`[PlayerDataService] Granted starter kit and resources to {player.Name}`)
	end

	syncStats(player, data)
	syncInventory(player, data)

	-- Resolve any XP accumulated past a level threshold by an older build.
	self:_resolveLevelUps(player, data)

	player:SetAttribute(ATTR.DataLoaded, true)

	if profile.IsRecovered then
		warn(`[PlayerDataService] {player.Name} is playing on backup-recovered data`)
	end

	self.ProfileLoaded:Fire(player, data)
end

function PlayerDataService:_onPlayerRemoving(player: Player)
	local profile = self._profiles[player]
	if not profile then
		return
	end

	if profile:IsActive() then
		profile.Data.Stats.LastSeen = os.time()
		profile.Data.Stats.PlayTime += math.floor(os.clock() - (profile._sessionStart or os.clock()))
	end

	self._profiles[player] = nil

	-- Or the limiter would hold a bucket per player who ever joined.
	if self._ageLimiter then
		self._ageLimiter:Forget(player)
	end

	self.ProfileReleased:Fire(player)

	-- Release performs the final save and frees the session lock so the player
	-- can immediately join another server.
	profile:Release()
end

--------------------------------------------------------------------------------
-- Public API: access
--------------------------------------------------------------------------------

--- Returns the live profile, or nil when data has not loaded (or was released).
function PlayerDataService:GetProfile(player: Player)
	local profile = self._profiles[player]

	if profile and profile:IsActive() then
		return profile
	end

	return nil
end

--- Returns the mutable data table. Prefer the typed mutators below over editing
--- this directly; direct edits will not replicate.
function PlayerDataService:GetData(player: Player): { [string]: any }?
	local profile = self:GetProfile(player)
	return if profile then profile.Data else nil
end

--- Yields until the player's data is ready. Returns nil on timeout or if the
--- player leaves. Use this in systems that may run before the profile loads.
function PlayerDataService:WaitForData(player: Player, timeout: number?): { [string]: any }?
	local deadline = os.clock() + (timeout or 20)

	while os.clock() < deadline do
		local data = self:GetData(player)
		if data then
			return data
		end

		if not player.Parent then
			return nil
		end

		task.wait(0.1)
	end

	return nil
end

--- Read-only snapshot, safe to hand to logging or analytics code.
function PlayerDataService:GetDataSnapshot(player: Player): { [string]: any }?
	local data = self:GetData(player)
	return if data then TableUtil.DeepCopy(data) else nil
end

--------------------------------------------------------------------------------
-- Public API: treasury resources
--------------------------------------------------------------------------------

--[[
	The civilisation treasury. Food, Wood, Gold and Stone behave identically, so
	every function takes a resource id and adding a fifth resource needs no code
	here.

	`Gold` in this section always means BASE gold. The personal purse is the
	section below, and nothing here can reach it.
]]
function PlayerDataService:GetResource(player: Player, resourceId: unknown): number
	local data = self:GetData(player)

	if not data or type(resourceId) ~= "string" then
		return 0
	end

	return data.Resources[resourceId] or 0
end

--- Credits the treasury. Returns the new balance, or nil when rejected.
function PlayerDataService:AddResource(player: Player, resourceId: unknown, amount: number): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local resource = GameConfig.GetResource(resourceId)
	if not resource then
		warn(`[PlayerDataService] AddResource rejected unknown resource: {tostring(resourceId)}`)
		return nil
	end

	local credit = toPositiveInteger(amount)
	if not credit then
		warn(`[PlayerDataService] AddResource rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return nil
	end

	local previous = data.Resources[resource.Id] or 0
	data.Resources[resource.Id] = math.min(previous + credit, GameConfig.Economy.MaxResource)

	local gained = data.Resources[resource.Id] - previous

	if resource.Id == GameConfig.PrimaryResource then
		data.Stats.TotalGoldEarned += gained
	end

	syncStats(player, data)
	self.ResourceChanged:Fire(player, resource.Id, data.Resources[resource.Id], gained)

	return data.Resources[resource.Id]
end

--- Atomically debits one resource. Returns true only if the player could
--- afford it; on false, nothing changed.
function PlayerDataService:TrySpendResource(player: Player, resourceId: unknown, amount: number): boolean
	return self:TrySpendResources(player, { [tostring(resourceId)] = amount })
end

--[[
	Atomically debits SEVERAL resources - the normal case for construction and
	aging up, which cost a mix.

	All-or-nothing on purpose: a partial deduction would leave a player charged
	for a building they did not get. Every cost is validated before anything is
	written.
]]
function PlayerDataService:TrySpendResources(player: Player, costs: { [string]: number }): boolean
	local data = self:GetData(player)
	if not data then
		return false
	end

	if type(costs) ~= "table" then
		return false
	end

	local validated = {}

	for resourceId, amount in costs do
		local resource = GameConfig.GetResource(resourceId)
		if not resource then
			return false
		end

		local cost = toPositiveInteger(amount)
		if not cost then
			return false
		end

		if (data.Resources[resource.Id] or 0) < cost then
			return false
		end

		validated[resource.Id] = cost
	end

	if next(validated) == nil then
		return false
	end

	for resourceId, cost in validated do
		data.Resources[resourceId] -= cost
		self.ResourceChanged:Fire(player, resourceId, data.Resources[resourceId], -cost)
	end

	syncStats(player, data)
	return true
end

--- Convenience accessors for the primary currency, which the market uses.
function PlayerDataService:GetGold(player: Player): number
	return self:GetResource(player, GameConfig.PrimaryResource)
end

function PlayerDataService:AddGold(player: Player, amount: number): number?
	return self:AddResource(player, GameConfig.PrimaryResource, amount)
end

function PlayerDataService:TrySpendGold(player: Player, amount: number): boolean
	return self:TrySpendResource(player, GameConfig.PrimaryResource, amount)
end

--------------------------------------------------------------------------------
-- Public API: personal purse
--------------------------------------------------------------------------------

--[[
	The player's own gold, carried on their person.

	DIRECTIONAL RULES, enforced by which functions exist:
	  * Credited only by kills and loot. The market never calls AddInventoryGold.
	  * Spent on personal equipment, or willingly on construction.
	  * There is NO function moving treasury gold into the purse. That omission
	    is the rule - if one is ever added, the economy breaks.
]]
function PlayerDataService:GetInventoryGold(player: Player): number
	local data = self:GetData(player)
	return if data then data.InventoryGold else 0
end

--- Credits the purse. Reserved for combat drops and loot.
function PlayerDataService:AddInventoryGold(player: Player, amount: number): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local credit = toPositiveInteger(amount)
	if not credit then
		warn(`[PlayerDataService] AddInventoryGold rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return nil
	end

	data.InventoryGold = math.min(data.InventoryGold + credit, GameConfig.Economy.MaxInventoryGold)

	syncStats(player, data)
	self.InventoryGoldChanged:Fire(player, data.InventoryGold, credit)

	return data.InventoryGold
end

--- Atomically debits the purse. Used for equipment, and for construction when
--- the player has opted in.
function PlayerDataService:TrySpendInventoryGold(player: Player, amount: number): boolean
	local data = self:GetData(player)
	if not data then
		return false
	end

	local cost = toPositiveInteger(amount)
	if not cost then
		return false
	end

	if data.InventoryGold < cost then
		return false
	end

	data.InventoryGold -= cost

	syncStats(player, data)
	self.InventoryGoldChanged:Fire(player, data.InventoryGold, -cost)

	return true
end

--- Whether construction may fall back to the personal purse without asking.
function PlayerDataService:GetAutoUsePersonalGold(player: Player): boolean
	local data = self:GetData(player)
	return if data then data.AutoUsePersonalGold == true else false
end

function PlayerDataService:SetAutoUsePersonalGold(player: Player, enabled: boolean)
	local data = self:GetData(player)
	if data then
		data.AutoUsePersonalGold = enabled == true
	end
end

--[[
	Pays a construction cost. Returns (paid, source) where source is
	"Treasury", "Purse" or nil.

	The treasury is tried first and in full. Only if it cannot cover the cost is
	the purse considered, and only when the player has opted in via
	`allowPurse` or the persisted preference. Costs are never split across both:
	a half-and-half payment would make refunds ambiguous.
]]
function PlayerDataService:TryPayConstruction(
	player: Player,
	costs: { [string]: number },
	allowPurse: boolean?
): (boolean, string?)
	if self:TrySpendResources(player, costs) then
		return true, "Treasury"
	end

	local permitted = allowPurse == true or self:GetAutoUsePersonalGold(player)
	if not permitted then
		return false, nil
	end

	-- The purse holds gold only, so it can only cover a gold-only cost.
	local goldOwed = 0

	for resourceId, amount in costs do
		if resourceId ~= GameConfig.PrimaryResource then
			return false, nil
		end

		goldOwed += toPositiveInteger(amount) or 0
	end

	if goldOwed < 1 then
		return false, nil
	end

	if self:TrySpendInventoryGold(player, goldOwed) then
		return true, "Purse"
	end

	return false, nil
end

--------------------------------------------------------------------------------
-- Public API: ages
--------------------------------------------------------------------------------

function PlayerDataService:GetAge(player: Player): number
	local data = self:GetData(player)
	return if data then data.Age else 1
end

--[[
	Advances to the next age, paying its cost from the treasury.

	Deliberately refuses the purse: aging up is a civilisation act, so it is
	funded by the civilisation. Returns (advanced, reason).
]]
function PlayerDataService:TryAdvanceAge(player: Player): (boolean, string?)
	local data = self:GetData(player)
	if not data then
		return false, "NoData"
	end

	if data.Age >= GameConfig.MaxAge then
		return false, "MaxAge"
	end

	local cost = GameConfig.GetAdvanceCost(data.Age)
	if not cost then
		return false, "MaxAge"
	end

	if not self:TrySpendResources(player, cost) then
		return false, "NotEnoughResources"
	end

	local previous = data.Age
	data.Age += 1

	syncStats(player, data)
	self.AgeChanged:Fire(player, data.Age, previous)

	return true, nil
end

--------------------------------------------------------------------------------
-- Public API: raids
--------------------------------------------------------------------------------

--[[
	The level of the last raid sent at this player.

	Persisted because the revenge army in docs/ROADMAP.md is sized from the
	horde that beat you - and by the time you choose revenge, that horde has
	been cleared off the field. A number that only existed while the raiders
	did could not size anything.
]]
function PlayerDataService:GetLastRaidLevel(player: Player): number
	local data = self:GetData(player)
	return if data then data.LastRaidLevel or 1 else 1
end

function PlayerDataService:SetLastRaidLevel(player: Player, level: unknown): boolean
	local data = self:GetData(player)
	local value = toPositiveInteger(level)

	if not data or not value then
		return false
	end

	-- Only ever rises within a session's run of raids, so choosing revenge
	-- after clearing an easy wave cannot shrink the army you were promised.
	data.LastRaidLevel = math.max(data.LastRaidLevel or 1, value)

	return true
end

--------------------------------------------------------------------------------
-- Public API: revenge tokens
--------------------------------------------------------------------------------

function PlayerDataService:GetRevengeTokens(player: Player): number
	local data = self:GetData(player)
	return if data then data.RevengeTokens else 0
end

--- Credits tokens. Returns the new total, or nil when the call was rejected.
function PlayerDataService:AddRevengeTokens(player: Player, amount: number): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local credit = toPositiveInteger(amount)
	if not credit then
		warn(`[PlayerDataService] AddRevengeTokens rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return nil
	end

	data.RevengeTokens = math.min(data.RevengeTokens + credit, GameConfig.Economy.MaxRevengeTokens)

	syncStats(player, data)
	self.RevengeTokensChanged:Fire(player, data.RevengeTokens, credit)

	return data.RevengeTokens
end

--[[
	Atomically debits tokens. Returns true only if the player had enough; on
	false, nothing changed.

	Whatever mechanic eventually consumes these must call this *before* applying
	its effect, and must validate its own target server-side. Tokens being
	purchasable makes this the spend path an exploiter will probe first.
]]
function PlayerDataService:TrySpendRevengeTokens(player: Player, amount: number?): boolean
	local data = self:GetData(player)
	if not data then
		return false
	end

	local cost = toPositiveInteger(amount or 1)
	if not cost then
		return false
	end

	if data.RevengeTokens < cost then
		return false
	end

	data.RevengeTokens -= cost

	syncStats(player, data)
	self.RevengeTokensChanged:Fire(player, data.RevengeTokens, -cost)

	return true
end

--------------------------------------------------------------------------------
-- Public API: durable save
--------------------------------------------------------------------------------

--[[
	Forces an immediate save and reports whether it reached the DataStore.

	Needed by anything that must not acknowledge an action until it is durable -
	above all Developer Product receipts, which Roblox stops retrying once the
	server returns PurchaseGranted.
]]
function PlayerDataService:SaveNow(player: Player): boolean
	local profile = self:GetProfile(player)
	if not profile then
		return false
	end

	return profile:Save(true)
end

--------------------------------------------------------------------------------
-- Public API: progression
--------------------------------------------------------------------------------

function PlayerDataService:GetLevel(player: Player): number
	local data = self:GetData(player)
	return if data then data.Level else 0
end

--- Consumes banked XP while it covers the next level's requirement.
--- Handles multi-level jumps from a single large reward.
function PlayerDataService:_resolveLevelUps(player: Player, data: { [string]: any })
	local startingLevel = data.Level

	while data.Level < GameConfig.Progression.MaxLevel do
		local required = GameConfig.GetXPForLevel(data.Level)

		if data.XP < required then
			break
		end

		data.XP -= required
		data.Level += 1
	end

	if data.Level >= GameConfig.Progression.MaxLevel then
		data.Level = GameConfig.Progression.MaxLevel
		data.XP = 0
	end

	if data.Level ~= startingLevel then
		syncStats(player, data)
		self.LevelChanged:Fire(player, data.Level, startingLevel)
	end
end

--- Grants XP and applies any resulting level ups. Returns the new level.
function PlayerDataService:AddXP(player: Player, amount: number): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local gain = toPositiveInteger(amount)
	if not gain then
		warn(`[PlayerDataService] AddXP rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return nil
	end

	if data.Level >= GameConfig.Progression.MaxLevel then
		return data.Level
	end

	data.XP += gain

	syncStats(player, data)
	self.XPChanged:Fire(player, data.XP, gain)
	self:_resolveLevelUps(player, data)

	return data.Level
end

--------------------------------------------------------------------------------
-- Public API: inventory
--------------------------------------------------------------------------------

--[[
	Every function below takes an ITEM ID and nothing else. There is no category
	parameter by design: callers should not have to know, and must not be able to
	disagree about, which bucket an item belongs to.

	Unknown ids are rejected outright - GameConfig.Items is the authority on what
	can exist, so a typo or a removed item fails loudly instead of creating a
	phantom stack.
]]
function PlayerDataService:GetItemCount(player: Player, itemId: unknown): number
	local data = self:GetData(player)

	if not data or type(itemId) ~= "string" then
		return 0
	end

	return data.Inventory[itemId] or 0
end

function PlayerDataService:HasItem(player: Player, itemId: unknown, amount: number?): boolean
	return self:GetItemCount(player, itemId) >= (amount or 1)
end

--- Adds items, clamped to the item's own MaxStack. Returns the new amount, or
--- nil when rejected.
function PlayerDataService:AddItem(player: Player, itemId: unknown, amount: number?): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local item = GameConfig.GetItem(itemId)
	if not item then
		warn(`[PlayerDataService] AddItem rejected unknown item id: {tostring(itemId)}`)
		return nil
	end

	local quantity = toPositiveInteger(amount or 1)
	if not quantity then
		return nil
	end

	local previous = data.Inventory[item.Id] or 0
	local updated = math.min(previous + quantity, item.MaxStack)

	if updated == previous then
		return previous -- Stack is already full.
	end

	data.Inventory[item.Id] = updated

	syncInventoryItem(player, item.Id, updated)
	self.InventoryChanged:Fire(player, item.Id, updated, updated - previous)

	return updated
end

--- Atomically removes items. Returns true only when the player had enough;
--- on false, nothing changed.
function PlayerDataService:RemoveItem(player: Player, itemId: unknown, amount: number?): boolean
	local data = self:GetData(player)
	if not data then
		return false
	end

	if type(itemId) ~= "string" then
		return false
	end

	local quantity = toPositiveInteger(amount or 1)
	if not quantity then
		return false
	end

	local previous = data.Inventory[itemId] or 0

	if previous < quantity then
		return false
	end

	local updated = previous - quantity
	-- Drop the key entirely at zero so saved data stays compact. This is why
	-- starting items must never live in the DataSchema template.
	data.Inventory[itemId] = if updated > 0 then updated else nil

	syncInventoryItem(player, itemId, updated)
	self.InventoryChanged:Fire(player, itemId, updated, -quantity)

	return true
end

--- Snapshot of the whole inventory: item id -> amount.
function PlayerDataService:GetInventory(player: Player): { [string]: number }
	local data = self:GetData(player)

	if not data then
		return {}
	end

	return TableUtil.DeepCopy(data.Inventory)
end

--- Snapshot filtered to one category, for UI and category-specific systems.
function PlayerDataService:GetInventoryByCategory(player: Player, category: string): { [string]: number }
	local data = self:GetData(player)

	if not data or not GameConfig.IsValidCategory(category) then
		return {}
	end

	local filtered = {}

	for itemId, amount in data.Inventory do
		local item = GameConfig.GetItem(itemId)

		if item and item.Category == category then
			filtered[itemId] = amount
		end
	end

	return filtered
end

--------------------------------------------------------------------------------
-- Public API: stats counters
--------------------------------------------------------------------------------

--- Increments a counter in data.Stats. Used by gameplay systems for quests and
--- analytics without giving them write access to the whole profile.
function PlayerDataService:IncrementStat(player: Player, statName: string, amount: number?): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	if type(statName) ~= "string" or data.Stats[statName] == nil then
		warn(`[PlayerDataService] IncrementStat rejected unknown stat: {tostring(statName)}`)
		return nil
	end

	local delta = tonumber(amount) or 1
	if delta ~= delta or math.abs(delta) == math.huge then
		return nil
	end

	data.Stats[statName] += math.floor(delta)
	return data.Stats[statName]
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function PlayerDataService:Start()
	assert(RunService:IsServer(), "PlayerDataService is server-only")

	if self._started then
		return self
	end
	self._started = true

	self._store = ProfileStore.new(GameConfig.Data.StoreName, DataSchema.Template, DataSchema.Normalize, {
		AutoSaveInterval = GameConfig.Data.AutoSaveInterval,
		SessionLockExpire = GameConfig.Data.SessionLockExpire,
		BackupInterval = GameConfig.Data.BackupInterval,
	})

	Players.PlayerAdded:Connect(function(player)
		self:_onPlayerAdded(player)
	end)

	Players.PlayerRemoving:Connect(function(player)
		self:_onPlayerRemoving(player)
	end)

	--[[
		Advancing an age.

		A RemoteFunction rather than an event, because the player needs to be
		told WHY it was refused - "not enough food" and "already Imperial" are
		different problems and a silent no-op for either is maddening.

		The client sends nothing but the request. Cost, availability and the
		spend all live in TryAdvanceAge, which is the only thing that may
		decide any of it.
	]]
	self._ageLimiter = RateLimiter.new(2, 4)

	local advanceAge = Remotes.GetFunction(GameConfig.RemoteNames.AdvanceAge)

	advanceAge.OnServerInvoke = function(player: Player)
		if not self._ageLimiter:Consume(player) then
			return { Ok = false, Reason = "RateLimited" }
		end

		local ok, reason = self:TryAdvanceAge(player)

		if not ok then
			return { Ok = false, Reason = reason or "Refused" }
		end

		return { Ok = true, Age = self:GetAge(player) }
	end

	-- Players who joined before this service finished requiring are still
	-- handled, which matters during live server updates.
	for _, player in Players:GetPlayers() do
		task.spawn(function()
			self:_onPlayerAdded(player)
		end)
	end

	return self
end

return PlayerDataService
