--!nonstrict
--[[
	PlotService
	-----------
	Owns the gardening loop: assigning a garden per player, handling the
	plant/harvest ProximityPrompts, advancing growth stages, and persisting
	plot state through PlayerDataService.

	AUTHORITY MODEL
	---------------
	* The profile (`data.Plots`) is the source of truth. Plot attributes are a
	  replicated *projection* of it, never an input.
	* Growth is derived from timestamps, so crops keep growing while the player
	  is offline and a lag spike cannot lose progress.
	* ProximityPrompt.Triggered is client-driven, so every interaction is
	  re-validated server-side: ownership, unlock level, plot state, character
	  distance, and a per-player cooldown.
	* Item and currency changes go through PlayerDataService's atomic mutators,
	  so a seed is consumed exactly once even under prompt spam.

	PERSISTENCE NOTE
	----------------
	`data.Plots` is keyed by *stringified* plot index. Roblox DataStores
	serialise through JSON, which does not preserve sparse integer keys -
	a table with holes comes back with string keys. Using strings from the
	start keeps the saved and in-memory shapes identical.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Growth = require(Shared.Growth)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local DamageableService = require(script.Parent.Parent.Combat.DamageableService)

local CropFactory = require(script.Parent.Parent.Plots.CropFactory)
local PlotBuilder = require(script.Parent.Parent.Plots.PlotBuilder)
local PlayerDataService = require(script.Parent.PlayerDataService)

local PLOT_ATTR = GameConfig.PlotAttributes
local EMPTY_STAGE = GameConfig.Growth.EmptyStage

local PlotService = {}

-- Checked against GameConfig.FrameworkVersion by Server.FrameworkGuard.
PlotService.FrameworkVersion = 9

PlotService._started = false
PlotService._gardens = {} :: { [Player]: any }
PlotService._slots = {} :: { [number]: Player }
PlotService._lastInteraction = {} :: { [Player]: number }
PlotService._gardensFolder = nil

--------------------------------------------------------------------------------
-- Signals for later steps (selling, quests, analytics)
--------------------------------------------------------------------------------

PlotService.Planted = Signal.new() -- (player, plotIndex, seedId)
PlotService.Harvested = Signal.new() -- (player, plotIndex, seedId)
PlotService.PlantFailed = Signal.new() -- (player, plotIndex, reason)
PlotService.GrowthBoosted = Signal.new() -- (player, plotIndex, seedId)
PlotService.CropDestroyed = Signal.new() -- (player, plotIndex, seedId)

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function plotKey(index: number): string
	return tostring(index)
end

--[[
	Validates an untrusted plot index, returning nil when unusable.

	The integer test also rejects NaN (NaN ~= NaN), and the range test rejects
	infinity, which survives math.floor.
]]
local function validatePlotIndex(value: unknown): number?
	local index = tonumber(value)

	if index == nil or index ~= math.floor(index) then
		return nil
	end

	if index < 1 or index > GameConfig.Garden.PlotsPerGarden then
		return nil
	end

	return index
end

--- Per-player interaction throttle. Prompt triggers originate on the client,
--- so this is the backstop against a spammed prompt.
function PlotService:_consumeInteraction(player: Player): boolean
	local now = os.clock()
	local last = self._lastInteraction[player]

	if last and now - last < GameConfig.Garden.InteractionCooldown then
		return false
	end

	self._lastInteraction[player] = now
	return true
end

--- Re-checks proximity on the server. The engine enforces activation distance
--- on the client, which an exploiter controls, so we verify it ourselves with
--- a little slack for latency and character movement.
local function isWithinReach(player: Player, soil: BasePart): boolean
	local character = player.Character
	local root = character and character.PrimaryPart

	if not root then
		return false
	end

	local limit = GameConfig.Garden.MaxActivationDistance + GameConfig.Garden.DistanceTolerance
	return (root.Position - soil.Position).Magnitude <= limit
end

local function getPrompt(plot: Model): ProximityPrompt?
	local soil = plot.PrimaryPart or plot:FindFirstChild("Soil")
	return if soil then soil:FindFirstChild("Interact") else nil
end

--------------------------------------------------------------------------------
-- Visual / attribute projection
--------------------------------------------------------------------------------

function PlotService:_renderCrop(plot: Model, seedId: string, stage: string)
	local existing = plot:FindFirstChild(CropFactory.ModelName)
	if existing then
		existing:Destroy()
	end

	if stage == EMPTY_STAGE or seedId == "" then
		return
	end

	local crop = CropFactory.Create(seedId, stage, PlotBuilder.GetPlantPosition(plot))
	if crop then
		crop.Parent = plot
	end
end

--[[
	Registers a planted crop with the damageable registry, so it has health like
	any building or unit, and keeps its health persisted on the plot entry.

	Crops regenerate (slowly) and cannot be repaired - the asymmetry against
	buildings is deliberate. Because health is derived from a timestamp, a crop
	heals while the player is offline with no ticking.
]]
function PlotService:_registerCrop(player: Player, plot: Model, index: number, entry: { [string]: any })
	self:_unregisterCrop(plot)

	local entityId = DamageableService:Register({
		ArchetypeId = "Crop",
		Model = plot,
		OwnerUserId = player.UserId,
		Level = 1,
		State = if entry.Health then { Health = entry.Health, DamagedAt = entry.DamagedAt } else nil,
	})

	if not entityId then
		return
	end

	plot:SetAttribute("EntityId", entityId)

	local garden = self._gardens[player]
	if garden then
		garden.Entities[index] = entityId
	end
end

function PlotService:_unregisterCrop(plot: Model)
	local existing = plot:GetAttribute("EntityId")

	if existing then
		DamageableService:Unregister(existing)
		plot:SetAttribute("EntityId", nil)
	end
end

--- Writes the planted state onto the plot's attributes and rebuilds its crop.
function PlotService:_projectPlanted(plot: Model, seedId: string, plantedAt: number, now: number)
	local stage = Growth.GetStage(seedId, plantedAt, now)

	plot:SetAttribute(PLOT_ATTR.SeedId, seedId)
	plot:SetAttribute(PLOT_ATTR.PlantedAt, plantedAt)
	plot:SetAttribute(PLOT_ATTR.ReadyAt, Growth.GetReadyAt(seedId, plantedAt))
	plot:SetAttribute(PLOT_ATTR.Stage, stage)

	self:_renderCrop(plot, seedId, stage)
end

function PlotService:_projectEmpty(plot: Model)
	self:_unregisterCrop(plot)

	plot:SetAttribute(PLOT_ATTR.SeedId, "")
	plot:SetAttribute(PLOT_ATTR.PlantedAt, 0)
	plot:SetAttribute(PLOT_ATTR.ReadyAt, 0)
	plot:SetAttribute(PLOT_ATTR.Stage, EMPTY_STAGE)

	self:_renderCrop(plot, "", EMPTY_STAGE)
end

--[[
	Whether `index` is usable by this player.

	A plot opens either by reaching its level requirement OR by spending a
	purchased slot. Purchased slots apply to the LOWEST-INDEXED still-locked
	plots, so the result is deterministic and a player cannot influence which
	plot a purchase opens.
]]
function PlotService:_isPlotUnlocked(player: Player, index: number): boolean
	local unlockLevels = GameConfig.Garden.PlotUnlockLevels
	local level = PlayerDataService:GetLevel(player)

	if level >= (unlockLevels[index] or 1) then
		return true
	end

	local data = PlayerDataService:GetData(player)
	local purchased = if data then data.BonusPlotSlots or 0 else 0

	if purchased < 1 then
		return false
	end

	local lockedSoFar = 0

	for candidate = 1, GameConfig.Garden.PlotsPerGarden do
		if level < (unlockLevels[candidate] or 1) then
			lockedSoFar += 1

			if candidate == index then
				return lockedSoFar <= purchased
			end
		end
	end

	return false
end

--- Re-evaluates every plot for a player. Called after a level up or after a
--- purchased slot is granted.
function PlotService:RefreshPlots(player: Player)
	self:_refreshAllPrompts(player)
end

--- Updates lock state, soil tint and the prompt's enabled state / labels to
--- match the plot's current contents and the player's level.
function PlotService:_refreshPrompt(player: Player, plot: Model)
	local prompt = getPrompt(plot)
	if not prompt then
		return
	end

	local soil = plot.PrimaryPart
	local unlockLevel = plot:GetAttribute(PLOT_ATTR.UnlockLevel) or 1
	local index = plot:GetAttribute(PLOT_ATTR.PlotIndex)
	local locked = not self:_isPlotUnlocked(player, index)

	plot:SetAttribute(PLOT_ATTR.Locked, locked)

	if soil then
		soil.Color = if locked then GameConfig.Garden.LockedSoilColor else GameConfig.Garden.SoilColor
	end

	if locked then
		prompt.Enabled = false
		prompt.ActionText = "Locked"
		prompt.ObjectText = `Unlocks at level {unlockLevel}`
		return
	end

	local seedId = plot:GetAttribute(PLOT_ATTR.SeedId)
	local stage = plot:GetAttribute(PLOT_ATTR.Stage)

	if seedId == "" or stage == EMPTY_STAGE then
		local selected = self:_resolveSeedId(player)
		local selectedItem = GameConfig.GetItem(selected)

		prompt.Enabled = true
		prompt.ActionText = "Plant"
		prompt.ObjectText = if selectedItem then selectedItem.Name else "No seeds"
		return
	end

	local seedItem = GameConfig.GetItem(seedId)
	local displayName = if seedItem then seedItem.Name else seedId

	if Growth.IsMature(stage) then
		prompt.Enabled = true
		prompt.ActionText = "Harvest"
		prompt.ObjectText = displayName
	else
		-- Clients render the live countdown from the ReadyAt attribute; the
		-- server does not push per-second text updates.
		prompt.Enabled = false
		prompt.ActionText = "Growing"
		prompt.ObjectText = displayName
	end
end

function PlotService:_refreshAllPrompts(player: Player)
	local garden = self._gardens[player]
	if not garden then
		return
	end

	for _, plot in garden.Plots do
		self:_refreshPrompt(player, plot)
	end
end

--------------------------------------------------------------------------------
-- Seed selection
--------------------------------------------------------------------------------

--[[
	Decides which seed a plant action will use: the player's explicit selection
	when it is valid and in stock, otherwise the cheapest plantable seed they
	own. Returns nil when they have nothing plantable.

	The fallback is ordered deterministically (price, then id) because Luau
	dictionary iteration order is unspecified - without a tie-break, two
	players with identical inventories could plant different seeds.
]]
function PlotService:_resolveSeedId(player: Player): string?
	local level = PlayerDataService:GetLevel(player)
	local selected = player:GetAttribute(GameConfig.Attributes.SelectedSeed)
	local selectedPlantable = GameConfig.GetPlantable(selected)

	if
		selectedPlantable
		and level >= selectedPlantable.RequiredLevel
		and PlayerDataService:HasItem(player, selectedPlantable.SeedId, 1)
	then
		return selectedPlantable.SeedId
	end

	local bestId, bestPrice = nil, nil

	-- Iterate the plantable directory rather than the inventory, so the result
	-- does not depend on inventory key order at all.
	for _, plantable in GameConfig.GetAvailablePlantables(level) do
		if PlayerDataService:HasItem(player, plantable.SeedId, 1) then
			local price = GameConfig.Items[plantable.SeedId].BuyPrice or 0
			local isBetter = bestPrice == nil or price < bestPrice or (price == bestPrice and plantable.SeedId < bestId)

			if isBetter then
				bestId, bestPrice = plantable.SeedId, price
			end
		end
	end

	return bestId
end

--------------------------------------------------------------------------------
-- Planting and harvesting
--------------------------------------------------------------------------------

function PlotService:_tryPlant(player: Player, plot: Model): boolean
	local data = PlayerDataService:GetData(player)
	if not data then
		return false
	end

	local index = plot:GetAttribute(PLOT_ATTR.PlotIndex)

	if not self:_isPlotUnlocked(player, index) then
		self.PlantFailed:Fire(player, index, "PlotLocked")
		return false
	end

	-- Guard against planting over an existing crop: the profile, not the
	-- attribute, decides whether the plot is occupied.
	if data.Plots[plotKey(index)] ~= nil then
		self.PlantFailed:Fire(player, index, "PlotOccupied")
		return false
	end

	local seedId = self:_resolveSeedId(player)
	if not seedId then
		self.PlantFailed:Fire(player, index, "NoSeeds")
		return false
	end

	-- _resolveSeedId already gates on level; re-checked here so this function is
	-- safe to call directly from future systems (quests, tutorials, admin tools).
	local plantable = GameConfig.GetPlantable(seedId)
	if not plantable or PlayerDataService:GetLevel(player) < plantable.RequiredLevel then
		self.PlantFailed:Fire(player, index, "LevelTooLow")
		return false
	end

	-- Atomic: consume the seed first, so a spammed prompt cannot plant twice
	-- from one seed.
	if not PlayerDataService:RemoveItem(player, seedId, 1) then
		self.PlantFailed:Fire(player, index, "NoSeeds")
		return false
	end

	local plantedAt = os.time()
	data.Plots[plotKey(index)] = { SeedId = seedId, PlantedAt = plantedAt }

	PlayerDataService:IncrementStat(player, "TotalPlanted", 1)

	self:_projectPlanted(plot, seedId, plantedAt, plantedAt)
	self:_registerCrop(player, plot, index, data.Plots[plotKey(index)])
	self:_refreshPrompt(player, plot)
	self.Planted:Fire(player, index, seedId)

	return true
end

function PlotService:_tryHarvest(player: Player, plot: Model): boolean
	local data = PlayerDataService:GetData(player)
	if not data then
		return false
	end

	local index = plot:GetAttribute(PLOT_ATTR.PlotIndex)
	local entry = data.Plots[plotKey(index)]

	if not entry then
		return false
	end

	local plantable = GameConfig.GetPlantable(entry.SeedId)
	if not plantable then
		-- Seed was removed from the config; free the plot rather than trapping it.
		data.Plots[plotKey(index)] = nil
		self:_projectEmpty(plot)
		self:_refreshPrompt(player, plot)
		return false
	end

	-- Recompute maturity from the timestamp instead of trusting the Stage
	-- attribute, which is only refreshed once per tick.
	local stage = Growth.GetStage(entry.SeedId, entry.PlantedAt, os.time())
	if not Growth.IsMature(stage) then
		return false
	end

	-- Grant the crop before clearing the plot: if the stack is full the player
	-- keeps the crop in the ground rather than losing it.
	-- The seed decides what it yields and how much; harvest does not assume the
	-- crop shares the seed's id.
	if not PlayerDataService:AddItem(player, plantable.Yields, plantable.YieldAmount) then
		return false
	end

	PlayerDataService:AddXP(player, plantable.XPReward)
	PlayerDataService:IncrementStat(player, "TotalHarvested", 1)

	data.Plots[plotKey(index)] = nil

	self:_projectEmpty(plot)
	self:_refreshPrompt(player, plot)
	self.Harvested:Fire(player, index, plantable.Yields)

	return true
end

--- Single entry point for every prompt trigger. Validates first, acts second.
function PlotService:_onPromptTriggered(plot: Model, player: Player)
	if plot:GetAttribute(PLOT_ATTR.OwnerUserId) ~= player.UserId then
		return
	end

	local garden = self._gardens[player]
	if not garden then
		return
	end

	local soil = plot.PrimaryPart
	if not soil or not isWithinReach(player, soil) then
		return
	end

	if not self:_consumeInteraction(player) then
		return
	end

	local index = plot:GetAttribute(PLOT_ATTR.PlotIndex)
	local data = PlayerDataService:GetData(player)

	if not data then
		return
	end

	if data.Plots[plotKey(index)] then
		self:_tryHarvest(player, plot)
	else
		self:_tryPlant(player, plot)
	end
end

--------------------------------------------------------------------------------
-- Garden lifecycle
--------------------------------------------------------------------------------

function PlotService:_acquireSlot(player: Player): number
	local slot = 1
	while self._slots[slot] do
		slot += 1
	end

	self._slots[slot] = player
	return slot
end

function PlotService:_assignGarden(player: Player, data: { [string]: any })
	if self._gardens[player] then
		return
	end

	local slot = self:_acquireSlot(player)
	local model = PlotBuilder.CreateGarden(slot, self._gardensFolder)
	model:SetAttribute(PLOT_ATTR.OwnerUserId, player.UserId)

	local garden = {
		Model = model,
		Slot = slot,
		Plots = {},
		Entities = {},
		Connections = {},
	}

	self._gardens[player] = garden

	local now = os.time()

	for _, plot in model:FindFirstChild("Plots"):GetChildren() do
		local index = plot:GetAttribute(PLOT_ATTR.PlotIndex)
		garden.Plots[index] = plot

		plot:SetAttribute(PLOT_ATTR.OwnerUserId, player.UserId)

		local prompt = getPrompt(plot)
		if prompt then
			table.insert(
				garden.Connections,
				prompt.Triggered:Connect(function(triggeringPlayer: Player)
					self:_onPromptTriggered(plot, triggeringPlayer)
				end)
			)
		end

		-- Restore whatever was growing when the player last logged out.
		local entry = data.Plots[plotKey(index)]

		if entry and GameConfig.GetPlantable(entry.SeedId) then
			self:_projectPlanted(plot, entry.SeedId, entry.PlantedAt, now)
			self:_registerCrop(player, plot, index, entry)
		else
			data.Plots[plotKey(index)] = nil
			self:_projectEmpty(plot)
		end

		self:_refreshPrompt(player, plot)
	end

	-- Seed the UI's selection so the first plant action is predictable.
	if player:GetAttribute(GameConfig.Attributes.SelectedSeed) == nil then
		player:SetAttribute(GameConfig.Attributes.SelectedSeed, self:_resolveSeedId(player))
	end
end

function PlotService:_releaseGarden(player: Player)
	local garden = self._gardens[player]
	self._lastInteraction[player] = nil

	if not garden then
		return
	end

	for _, connection in garden.Connections do
		connection:Disconnect()
	end

	garden.Model:Destroy()

	self._slots[garden.Slot] = nil
	self._gardens[player] = nil
end

--------------------------------------------------------------------------------
-- Growth loop
--------------------------------------------------------------------------------

--- Advances every planted plot. Attributes and visuals are only touched on a
--- stage *transition*, so a full server of mature gardens costs one comparison
--- per plot per tick.
function PlotService:_tick()
	local now = os.time()

	for player, garden in self._gardens do
		for _, plot in garden.Plots do
			local seedId = plot:GetAttribute(PLOT_ATTR.SeedId)

			if seedId ~= "" then
				local plantedAt = plot:GetAttribute(PLOT_ATTR.PlantedAt) or 0
				local stage = Growth.GetStage(seedId, plantedAt, now)

				if stage ~= plot:GetAttribute(PLOT_ATTR.Stage) then
					plot:SetAttribute(PLOT_ATTR.Stage, stage)
					self:_renderCrop(plot, seedId, stage)
					self:_refreshPrompt(player, plot)
				end
			end
		end
	end
end

--------------------------------------------------------------------------------
-- Growth boosts (Instant Grow)
--------------------------------------------------------------------------------

--[[
	Chooses which plot an un-targeted boost should apply to: the player's
	explicitly targeted plot when it is still growing, otherwise the plot with
	the MOST time remaining, since that is where the boost is worth most.

	Ties break on the lower index so the choice is deterministic - Luau
	dictionary iteration order is unspecified.
]]
function PlotService:_pickBoostTarget(player: Player): number?
	local data = PlayerDataService:GetData(player)
	if not data then
		return nil
	end

	local now = os.time()

	local targeted = tonumber(player:GetAttribute(GameConfig.Attributes.TargetPlot))
	if targeted then
		local entry = data.Plots[plotKey(targeted)]

		if entry and Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, now) > 0 then
			return targeted
		end
	end

	local bestIndex, bestRemaining = nil, 0

	for key, entry in data.Plots do
		local index = tonumber(key)
		local remaining = Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, now)

		if index and remaining > 0 then
			local isBetter = bestIndex == nil
				or remaining > bestRemaining
				or (remaining == bestRemaining and index < bestIndex)

			if isBetter then
				bestIndex, bestRemaining = index, remaining
			end
		end
	end

	return bestIndex
end

--[[
	Completes a crop's growth immediately, consuming one GrowthBoost from the
	player's Boosts inventory. Returns true only if a boost was actually spent.

	WHY THIS REWRITES PlantedAt RATHER THAN ReadyAt
	-----------------------------------------------
	ReadyAt and Stage are a replicated *projection* of PlantedAt, not state.
	Overriding either attribute would be reverted by the next growth tick, would
	not persist (attributes are not saved - the profile is), and would not make
	the crop harvestable, because _tryHarvest recomputes maturity from
	PlantedAt and deliberately ignores Stage.

	Backdating PlantedAt by the seed's full GrowTime is the only change that
	survives the tick, survives a rejoin, and is honoured by harvest validation.
]]
function PlotService:CompleteGrowth(player: Player, plotIndex: number?): boolean
	local data = PlayerDataService:GetData(player)
	if not data then
		return false
	end

	local index = plotIndex or self:_pickBoostTarget(player)
	if not index then
		return false
	end

	local entry = data.Plots[plotKey(index)]
	if not entry then
		return false
	end

	local plantable = GameConfig.GetPlantable(entry.SeedId)
	if not plantable then
		return false
	end

	local now = os.time()

	-- Never burn a boost on a crop that is already harvestable.
	if Growth.IsMature(Growth.GetStage(entry.SeedId, entry.PlantedAt, now)) then
		return false
	end

	-- Atomic: the consumable is spent before the effect is applied.
	if not PlayerDataService:RemoveItem(player, GameConfig.Monetization.GrowthBoostItemId, 1) then
		return false
	end

	entry.PlantedAt = now - plantable.GrowTime

	local plot = self:GetPlot(player, index)
	if plot then
		self:_projectPlanted(plot, entry.SeedId, entry.PlantedAt, now)
		self:_refreshPrompt(player, plot)
	end

	self.GrowthBoosted:Fire(player, index, entry.SeedId)

	return true
end

--------------------------------------------------------------------------------
-- Public API
--------------------------------------------------------------------------------

function PlotService:GetGarden(player: Player): Model?
	local garden = self._gardens[player]
	return if garden then garden.Model else nil
end

function PlotService:GetPlot(player: Player, index: number): Model?
	local garden = self._gardens[player]
	return if garden then garden.Plots[index] else nil
end

--- Seconds until the given plot is harvestable; nil when it is empty.
function PlotService:GetTimeRemaining(player: Player, index: number): number?
	local data = PlayerDataService:GetData(player)
	if not data then
		return nil
	end

	local entry = data.Plots[plotKey(index)]
	if not entry then
		return nil
	end

	return Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, os.time())
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function PlotService:Start()
	assert(RunService:IsServer(), "PlotService is server-only")

	if self._started then
		return self
	end
	self._started = true

	local folder = Workspace:FindFirstChild(GameConfig.GardensFolderName)
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = GameConfig.GardensFolderName
		folder.Parent = Workspace
	end
	self._gardensFolder = folder

	PlayerDataService.ProfileLoaded:Connect(function(player: Player, data)
		self:_assignGarden(player, data)
	end)

	-- Cleanup is driven by PlayerRemoving rather than ProfileReleased so a
	-- player kicked during a failed data load still has no orphaned garden.
	Players.PlayerRemoving:Connect(function(player: Player)
		self:_releaseGarden(player)
	end)

	-- Levelling up can unlock plots, so prompts and lock tints must refresh.
	PlayerDataService.LevelChanged:Connect(function(player: Player)
		self:_refreshAllPrompts(player)
	end)

	--[[
		Crop health lives in the damageable registry, but must survive a rejoin,
		so it is mirrored back onto the plot entry whenever it changes. The
		registry deliberately knows nothing about profiles - persisting its
		state is the owning system's job.
	]]
	local function resolveCrop(entity)
		if entity.ArchetypeId ~= "Crop" or not entity.Model then
			return nil, nil, nil
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		local data = if owner then PlayerDataService:GetData(owner) else nil

		if not data then
			return nil, nil, nil
		end

		local index = entity.Model:GetAttribute(PLOT_ATTR.PlotIndex)
		local key = if index then plotKey(index) else nil

		return owner, key, if key then data.Plots[key] else nil
	end

	DamageableService.StateChanged:Connect(function(_, state, entity)
		local _owner, _key, plotEntry = resolveCrop(entity)

		if plotEntry then
			plotEntry.Health = state.Health
			plotEntry.DamagedAt = state.DamagedAt
		end
	end)

	-- A crop killed by damage frees its plot, exactly like harvesting does.
	DamageableService.Destroyed:Connect(function(_, _killer, entity)
		local owner, key, plotEntry = resolveCrop(entity)

		if not owner or not plotEntry then
			return
		end

		local seedId = plotEntry.SeedId
		PlayerDataService:GetData(owner).Plots[key] = nil

		self:_projectEmpty(entity.Model)
		self:_refreshPrompt(owner, entity.Model)
		self.CropDestroyed:Fire(owner, tonumber(key), seedId)
	end)

	local selectSeed = Remotes.GetEvent(GameConfig.RemoteNames.SelectSeed)

	selectSeed.OnServerEvent:Connect(function(player: Player, seedId: unknown)
		-- Rate limited on the same budget as prompts; `seedId` is untrusted.
		if not self:_consumeInteraction(player) then
			return
		end

		local plantable = GameConfig.GetPlantable(seedId)
		if not plantable then
			return
		end

		player:SetAttribute(GameConfig.Attributes.SelectedSeed, plantable.SeedId)
		self:_refreshAllPrompts(player)
	end)

	--[[
		Target selection for boost purchases.

		ProcessReceipt receives only a player and a product id - it cannot carry
		a plot index. So the client records its intended target ahead of the
		purchase, and the receipt handler reads it. The value is validated here
		and stored as a server-written attribute, so the receipt path never
		touches client input.
	]]
	local selectPlot = Remotes.GetEvent(GameConfig.RemoteNames.SelectPlot)

	selectPlot.OnServerEvent:Connect(function(player: Player, plotIndex: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		local index = validatePlotIndex(plotIndex)
		if not index then
			return
		end

		player:SetAttribute(GameConfig.Attributes.TargetPlot, index)
	end)

	-- Spends a GrowthBoost the player already owns (for example one bought
	-- while they had nothing growing).
	local useBoost = Remotes.GetEvent(GameConfig.RemoteNames.UseBoost)

	useBoost.OnServerEvent:Connect(function(player: Player, plotIndex: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		-- nil is allowed and means "pick the best target for me"; anything
		-- non-nil must be a real plot index.
		local index = nil

		if plotIndex ~= nil then
			index = validatePlotIndex(plotIndex)
			if not index then
				return
			end
		end

		self:CompleteGrowth(player, index)
	end)

	task.spawn(function()
		while true do
			task.wait(GameConfig.Growth.TickInterval)
			self:_tick()
		end
	end)

	-- Players whose profiles loaded before this service started.
	for _, player in Players:GetPlayers() do
		local data = PlayerDataService:GetData(player)
		if data then
			task.spawn(function()
				self:_assignGarden(player, data)
			end)
		end
	end

	return self
end

return PlotService
