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
		Cash, Level, XP, XPToNextLevel, DataLoaded

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

		if PlayerDataService:TrySpendCash(player, seed.SeedPrice) then
			PlayerDataService:AddItem(player, "Seeds", seed.Id, 1)
		end
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)
local TableUtil = require(Shared.TableUtil)

local DataSchema = require(script.Parent.Parent.Data.DataSchema)
local ProfileStore = require(script.Parent.Parent.Data.ProfileStore)

local ATTR = GameConfig.Attributes
local KICK_DATA_FAILURE =
	"We could not load your saved garden. Please rejoin in a moment - your progress is safe."
local KICK_LOCK_LOST = "Your data is active on another server. Please rejoin."

local PlayerDataService = {}

PlayerDataService._started = false
PlayerDataService._profiles = {} :: { [Player]: any }
PlayerDataService._store = nil

--------------------------------------------------------------------------------
-- Signals (server-side only; gameplay systems subscribe to these)
--------------------------------------------------------------------------------

PlayerDataService.ProfileLoaded = Signal.new() -- (player, data)
PlayerDataService.ProfileReleased = Signal.new() -- (player)
PlayerDataService.CashChanged = Signal.new() -- (player, newCash, delta)
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

	local cashValue = Instance.new("IntValue")
	cashValue.Name = "Cash"
	cashValue.Parent = leaderstats

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
	player:SetAttribute(ATTR.Cash, data.Cash)
	player:SetAttribute(ATTR.Level, data.Level)
	player:SetAttribute(ATTR.XP, data.XP)
	player:SetAttribute(ATTR.RevengeTokens, data.RevengeTokens)

	local required = GameConfig.GetXPForLevel(data.Level)
	-- Attributes cannot store math.huge; use -1 to mean "max level reached".
	player:SetAttribute(ATTR.XPToNextLevel, if required == math.huge then -1 else required)

	local leaderstats = player:FindFirstChild("leaderstats")
	if leaderstats then
		local cashValue = leaderstats:FindFirstChild("Cash")
		local levelValue = leaderstats:FindFirstChild("Level")

		if cashValue then
			cashValue.Value = data.Cash
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
		print(`[PlayerDataService] Granted starter kit to {player.Name}`)
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
-- Public API: currency
--------------------------------------------------------------------------------

function PlayerDataService:GetCash(player: Player): number
	local data = self:GetData(player)
	return if data then data.Cash else 0
end

--- Credits cash. `amount` must be a positive integer; use TrySpendCash to debit.
--- Returns the new balance, or nil when the call was rejected.
function PlayerDataService:AddCash(player: Player, amount: number): number?
	local data = self:GetData(player)
	if not data then
		return nil
	end

	local credit = toPositiveInteger(amount)
	if not credit then
		warn(`[PlayerDataService] AddCash rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return nil
	end

	local previous = data.Cash
	data.Cash = math.min(previous + credit, GameConfig.Economy.MaxCash)
	data.Stats.TotalCashEarned += data.Cash - previous

	syncStats(player, data)
	self.CashChanged:Fire(player, data.Cash, data.Cash - previous)

	return data.Cash
end

--- Atomically debits cash. Returns true only if the player could afford it;
--- on false, nothing changed. This is the only sanctioned way to spend.
function PlayerDataService:TrySpendCash(player: Player, amount: number): boolean
	local data = self:GetData(player)
	if not data then
		return false
	end

	local cost = toPositiveInteger(amount)
	if not cost then
		warn(`[PlayerDataService] TrySpendCash rejected invalid amount for {player.Name}: {tostring(amount)}`)
		return false
	end

	if data.Cash < cost then
		return false
	end

	data.Cash -= cost

	syncStats(player, data)
	self.CashChanged:Fire(player, data.Cash, -cost)

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
