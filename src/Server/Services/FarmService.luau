--!nonstrict
--[[
	FarmService
	-----------
	Growing, harvesting and boosting crops on PLACED FARMS.

	Replaces PlotService. The difference is not cosmetic: a plot was a slot in
	a pre-built garden handed out by player level, whereas a farm is a
	structure the player chose to build, beside a Mill, paid for in Wood. There
	is nothing to "unlock" because nothing exists until it is built.

	WHAT CARRIED OVER
	-----------------
	The growth model, unchanged and still the right shape: a crop stores only
	`SeedId` and `PlantedAt`, and its stage is DERIVED on read. Crops keep
	growing while the player is offline, a restart cannot lose progress, and the
	stage cannot drift because it is recomputed rather than accumulated.

	WHAT STATE LIVES WHERE
	----------------------
	Crop state is stored ON the farm's structure entry in `data.Structures`,
	rather than in a parallel table keyed by farm id. That is deliberate:
	one record per farm means demolishing a farm takes its crop with it, so
	there is no way to orphan a crop whose farm no longer exists.

	ENTITY LAYOUT
	-------------
		Farm (Model)              structure entity - health, repairable
		└── Crop (Model)          crop entity - health, regenerates
		    └── Visual (Model)    rebuilt per growth stage
		└── Body
		    └── Interact          ProximityPrompt

	The Crop container is stable so it can host the crop's health attributes,
	while only the Visual inside it is rebuilt on a stage change.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Growth = require(Shared.Growth)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local PlacementService = require(script.Parent.Parent.World.PlacementService)
local PlayerDataService = require(script.Parent.PlayerDataService)
local CropFactory = require(script.Parent.Parent.Plots.CropFactory)

local FARM_ATTR = GameConfig.FarmAttributes
local EMPTY_STAGE = GameConfig.Growth.EmptyStage
local PROMPT_NAME = "Interact"
local CROP_CONTAINER = "Crop"

local FarmService = {}

FarmService.FrameworkVersion = 11

FarmService._started = false
FarmService._farms = {} :: { [Player]: any }
FarmService._lastInteraction = {} :: { [Player]: number }

--- (player, instanceId, seedId)
FarmService.Planted = Signal.new()
--- (player, instanceId, itemId, amount)
FarmService.Harvested = Signal.new()
--- (player, instanceId, reason)
FarmService.PlantFailed = Signal.new()
--- (player, instanceId, seedId)
FarmService.GrowthBoosted = Signal.new()
--- (player, instanceId, seedId)
FarmService.CropDestroyed = Signal.new()

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

function FarmService:_consumeInteraction(player: Player): boolean
	local now = os.clock()
	local last = self._lastInteraction[player]

	if last and now - last < GameConfig.Interaction.Cooldown then
		return false
	end

	self._lastInteraction[player] = now
	return true
end

--- Re-checks reach on the server. The engine enforces prompt distance on the
--- client, which an exploiter controls.
local function isWithinReach(player: Player, part: BasePart): boolean
	local character = player.Character
	local root = character and character.PrimaryPart

	if not root then
		return false
	end

	local limit = GameConfig.Interaction.MaxActivationDistance + GameConfig.Interaction.DistanceTolerance
	return (root.Position - part.Position).Magnitude <= limit
end

function FarmService:_getFarms(player: Player)
	return self._farms[player] or {}
end

function FarmService:GetFarm(player: Player, instanceId: string)
	return self:_getFarms(player)[instanceId]
end

--- The crop record on a farm, or nil when fallow.
function FarmService:_getEntry(player: Player, instanceId: string)
	local data = PlayerDataService:GetData(player)
	local entry = if data then data.Structures[instanceId] else nil

	if entry and entry.StructureId == "Farm" then
		return entry
	end

	return nil
end

--------------------------------------------------------------------------------
-- Projection
--------------------------------------------------------------------------------

--[[
	Rebuilds the crop visual for the current stage, keeping the Crop container
	so the crop entity's model reference and health attributes stay valid.
]]
function FarmService:_renderCrop(farm, seedId: string, stage: string)
	local container = farm.Model:FindFirstChild(CROP_CONTAINER)

	if stage == EMPTY_STAGE or seedId == "" then
		if container then
			container:Destroy()
		end
		return
	end

	if not container then
		container = Instance.new("Model")
		container.Name = CROP_CONTAINER
		container.Parent = farm.Model
	end

	local existing = container:FindFirstChild("Visual")
	if existing then
		existing:Destroy()
	end

	local structure = GameConfig.GetStructure("Farm")
	local base = farm.Model.PrimaryPart.Position + Vector3.new(0, structure.Size.Y / 2, 0)
	local visual = CropFactory.Create(seedId, stage, base)

	if visual then
		visual.Name = "Visual"
		visual.Parent = container
	end

	return container
end

function FarmService:_projectCrop(player: Player, farm, entry, now: number)
	local stage = Growth.GetStage(entry.SeedId, entry.PlantedAt, now)

	farm.Model:SetAttribute(FARM_ATTR.SeedId, entry.SeedId)
	farm.Model:SetAttribute(FARM_ATTR.PlantedAt, entry.PlantedAt)
	farm.Model:SetAttribute(FARM_ATTR.ReadyAt, Growth.GetReadyAt(entry.SeedId, entry.PlantedAt))
	farm.Model:SetAttribute(FARM_ATTR.Stage, stage)

	local container = self:_renderCrop(farm, entry.SeedId, stage)

	-- The crop is its own damageable entity: it regenerates, unlike the farm
	-- it sits on, which must be repaired with resources.
	if container and not farm.CropEntityId then
		farm.CropEntityId = DamageableService:Register({
			ArchetypeId = "Crop",
			Model = container,
			OwnerUserId = player.UserId,
			State = if entry.CropHealth then { Health = entry.CropHealth, DamagedAt = entry.CropDamagedAt } else nil,
		})
	end

	self:_refreshPrompt(player, farm)
end

function FarmService:_projectFallow(player: Player, farm)
	if farm.CropEntityId then
		DamageableService:Unregister(farm.CropEntityId)
		farm.CropEntityId = nil
	end

	farm.Model:SetAttribute(FARM_ATTR.SeedId, "")
	farm.Model:SetAttribute(FARM_ATTR.PlantedAt, 0)
	farm.Model:SetAttribute(FARM_ATTR.ReadyAt, 0)
	farm.Model:SetAttribute(FARM_ATTR.Stage, EMPTY_STAGE)

	self:_renderCrop(farm, "", EMPTY_STAGE)
	self:_refreshPrompt(player, farm)
end

function FarmService:_refreshPrompt(player: Player, farm)
	local prompt = farm.Model.PrimaryPart and farm.Model.PrimaryPart:FindFirstChild(PROMPT_NAME)

	if not prompt then
		return
	end

	local entry = self:_getEntry(player, farm.InstanceId)
	local seedId = if entry then entry.SeedId else nil

	if not seedId or seedId == "" then
		local selected = self:_resolveSeedId(player)
		local item = GameConfig.GetItem(selected)

		prompt.Enabled = true
		prompt.ActionText = "Plant"
		prompt.ObjectText = if item then item.Name else "No seeds"
		return
	end

	local plantable = GameConfig.GetPlantable(seedId)
	local yieldItem = if plantable then GameConfig.GetItem(plantable.Yields) else nil
	local displayName = if yieldItem then yieldItem.Name else seedId

	if Growth.IsMature(farm.Model:GetAttribute(FARM_ATTR.Stage)) then
		prompt.Enabled = true
		prompt.ActionText = "Harvest"
		prompt.ObjectText = displayName
	else
		-- Clients render the countdown from ReadyAt; the server pushes no
		-- per-second text.
		prompt.Enabled = false
		prompt.ActionText = "Growing"
		prompt.ObjectText = displayName
	end
end

function FarmService:_refreshAll(player: Player)
	for _, farm in self:_getFarms(player) do
		self:_refreshPrompt(player, farm)
	end
end

--------------------------------------------------------------------------------
-- Seed selection
--------------------------------------------------------------------------------

--[[
	Which seed a plant action will use: the explicit selection when valid and in
	stock, otherwise the cheapest plantable seed owned.

	Iterates the plantable directory rather than the inventory, so the result
	never depends on inventory key order.
]]
function FarmService:_resolveSeedId(player: Player): string?
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

function FarmService:TryPlant(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local farm = self:GetFarm(player, instanceId)

	if not entry or not farm then
		return false
	end

	-- The profile, not the attribute, decides whether the farm is occupied.
	if entry.SeedId and entry.SeedId ~= "" then
		self.PlantFailed:Fire(player, instanceId, "Occupied")
		return false
	end

	local seedId = self:_resolveSeedId(player)
	if not seedId then
		self.PlantFailed:Fire(player, instanceId, "NoSeeds")
		return false
	end

	local plantable = GameConfig.GetPlantable(seedId)
	if not plantable or PlayerDataService:GetLevel(player) < plantable.RequiredLevel then
		self.PlantFailed:Fire(player, instanceId, "LevelTooLow")
		return false
	end

	-- Atomic: the seed is consumed before the crop exists, so a spammed prompt
	-- cannot plant twice from one seed.
	if not PlayerDataService:RemoveItem(player, seedId, 1) then
		self.PlantFailed:Fire(player, instanceId, "NoSeeds")
		return false
	end

	local now = os.time()
	entry.SeedId = seedId
	entry.PlantedAt = now
	entry.CropHealth = nil
	entry.CropDamagedAt = nil

	PlayerDataService:IncrementStat(player, "TotalPlanted", 1)

	self:_projectCrop(player, farm, entry, now)
	self.Planted:Fire(player, instanceId, seedId)

	return true
end

function FarmService:TryHarvest(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local farm = self:GetFarm(player, instanceId)

	if not entry or not farm or not entry.SeedId or entry.SeedId == "" then
		return false
	end

	local plantable = GameConfig.GetPlantable(entry.SeedId)

	if not plantable then
		-- The seed left the config; free the farm rather than trapping it.
		entry.SeedId = ""
		self:_projectFallow(player, farm)
		return false
	end

	-- Recomputed from the timestamp, not read from the Stage attribute, which
	-- is only as fresh as the last tick.
	if not Growth.IsMature(Growth.GetStage(entry.SeedId, entry.PlantedAt, os.time())) then
		return false
	end

	-- Granted before the farm is cleared, so a full stack leaves the crop in
	-- the ground rather than destroying it.
	if not PlayerDataService:AddItem(player, plantable.Yields, plantable.YieldAmount) then
		return false
	end

	PlayerDataService:AddXP(player, plantable.XPReward)
	PlayerDataService:IncrementStat(player, "TotalHarvested", 1)

	entry.SeedId = ""
	entry.PlantedAt = nil
	entry.CropHealth = nil
	entry.CropDamagedAt = nil

	self:_projectFallow(player, farm)
	self.Harvested:Fire(player, instanceId, plantable.Yields, plantable.YieldAmount)

	return true
end

--- Single entry point for a farm prompt. Validates first, acts second.
function FarmService:_onPromptTriggered(player: Player, farm)
	local owner = farm.Model:GetAttribute(GameConfig.StructureAttributes.OwnerUserId)

	if owner ~= player.UserId then
		return
	end

	local body = farm.Model.PrimaryPart
	if not body or not isWithinReach(player, body) then
		return
	end

	if not self:_consumeInteraction(player) then
		return
	end

	local entry = self:_getEntry(player, farm.InstanceId)
	if not entry then
		return
	end

	if entry.SeedId and entry.SeedId ~= "" then
		self:TryHarvest(player, farm.InstanceId)
	else
		self:TryPlant(player, farm.InstanceId)
	end
end

--------------------------------------------------------------------------------
-- Growth boosts
--------------------------------------------------------------------------------

--[[
	Picks a target for an un-aimed boost: the explicitly targeted farm when it
	is still growing, otherwise the farm with the MOST time remaining, where
	the boost is worth most. Ties break on instance id for determinism.
]]
function FarmService:_pickBoostTarget(player: Player): string?
	local data = PlayerDataService:GetData(player)
	if not data then
		return nil
	end

	local now = os.time()

	local targeted = player:GetAttribute(GameConfig.Attributes.TargetFarm)
	if type(targeted) == "string" then
		local entry = self:_getEntry(player, targeted)

		if entry and entry.SeedId ~= "" and Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, now) > 0 then
			return targeted
		end
	end

	local bestId, bestRemaining = nil, 0

	for instanceId, entry in data.Structures do
		if entry.StructureId == "Farm" and entry.SeedId and entry.SeedId ~= "" then
			local remaining = Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, now)

			if remaining > 0 then
				local better = bestId == nil
					or remaining > bestRemaining
					or (remaining == bestRemaining and instanceId < bestId)

				if better then
					bestId, bestRemaining = instanceId, remaining
				end
			end
		end
	end

	return bestId
end

--[[
	Completes a crop's growth, consuming one GrowthBoost.

	Backdates PlantedAt rather than writing ReadyAt or Stage, because those are
	a derived projection: an attribute write would be undone by the next tick,
	would not persist, and would be ignored by harvest validation.
]]
function FarmService:CompleteGrowth(player: Player, instanceId: string?): boolean
	local target = instanceId or self:_pickBoostTarget(player)
	if not target then
		return false
	end

	local entry = self:_getEntry(player, target)
	local farm = self:GetFarm(player, target)

	if not entry or not farm or not entry.SeedId or entry.SeedId == "" then
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

	if not PlayerDataService:RemoveItem(player, GameConfig.Monetization.GrowthBoostItemId, 1) then
		return false
	end

	entry.PlantedAt = now - plantable.GrowTime

	self:_projectCrop(player, farm, entry, now)
	self.GrowthBoosted:Fire(player, target, entry.SeedId)

	return true
end

--- Seconds until a farm's crop is harvestable; nil when fallow.
function FarmService:GetTimeRemaining(player: Player, instanceId: string): number?
	local entry = self:_getEntry(player, instanceId)

	if not entry or not entry.SeedId or entry.SeedId == "" then
		return nil
	end

	return Growth.GetTimeRemaining(entry.SeedId, entry.PlantedAt, os.time())
end

--------------------------------------------------------------------------------
-- Farm lifecycle, driven by the placement service
--------------------------------------------------------------------------------

function FarmService:_attach(player: Player, instanceId: string, entry, model: Model)
	local structure = GameConfig.GetStructure(entry.StructureId)

	if not structure or not structure.HoldsCrop then
		return
	end

	local body = model.PrimaryPart
	if not body then
		return
	end

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = PROMPT_NAME
	prompt.ActionText = "Plant"
	prompt.ObjectText = "Farm"
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	local farm = {
		InstanceId = instanceId,
		Model = model,
		Connections = {},
		CropEntityId = nil,
	}

	local farms = self._farms[player]
	if not farms then
		farms = {}
		self._farms[player] = farms
	end
	farms[instanceId] = farm

	table.insert(
		farm.Connections,
		prompt.Triggered:Connect(function(triggering: Player)
			self:_onPromptTriggered(triggering, farm)
		end)
	)

	if entry.SeedId and entry.SeedId ~= "" and GameConfig.GetPlantable(entry.SeedId) then
		self:_projectCrop(player, farm, entry, os.time())
	else
		entry.SeedId = ""
		self:_projectFallow(player, farm)
	end
end

function FarmService:_detach(player: Player, instanceId: string)
	local farms = self._farms[player]
	local farm = if farms then farms[instanceId] else nil

	if not farm then
		return
	end

	for _, connection in farm.Connections do
		connection:Disconnect()
	end

	if farm.CropEntityId then
		DamageableService:Unregister(farm.CropEntityId)
	end

	farms[instanceId] = nil
end

--------------------------------------------------------------------------------
-- Growth loop
--------------------------------------------------------------------------------

--- Advances every growing crop. Attributes and visuals are only touched on a
--- stage transition, so idle farms cost one comparison per tick.
function FarmService:_tick()
	local now = os.time()

	for player, farms in self._farms do
		for instanceId, farm in farms do
			local entry = self:_getEntry(player, instanceId)

			if entry and entry.SeedId and entry.SeedId ~= "" then
				local stage = Growth.GetStage(entry.SeedId, entry.PlantedAt, now)

				if stage ~= farm.Model:GetAttribute(FARM_ATTR.Stage) then
					farm.Model:SetAttribute(FARM_ATTR.Stage, stage)
					self:_renderCrop(farm, entry.SeedId, stage)
					self:_refreshPrompt(player, farm)
				end
			end
		end
	end
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function FarmService:Start()
	assert(RunService:IsServer(), "FarmService is server-only")

	if self._started then
		return self
	end
	self._started = true

	-- Fires for both new placements and rebuilds on rejoin, so a farm restored
	-- from saved data gets its prompt and crop exactly like a fresh one.
	PlacementService.Spawned:Connect(function(player: Player, instanceId: string, entry, model: Model)
		self:_attach(player, instanceId, entry, model)
	end)

	PlacementService.Despawned:Connect(function(player: Player, instanceId: string)
		self:_detach(player, instanceId)
	end)

	Players.PlayerRemoving:Connect(function(player: Player)
		for instanceId in self:_getFarms(player) do
			self:_detach(player, instanceId)
		end

		self._farms[player] = nil
		self._lastInteraction[player] = nil
	end)

	--[[
		Crop health is owned by the damageable registry but must survive a
		rejoin, so it is mirrored onto the farm's structure entry.
	]]
	DamageableService.StateChanged:Connect(function(_, state, entity)
		if entity.ArchetypeId ~= "Crop" then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		if not owner then
			return
		end

		for instanceId, farm in self:_getFarms(owner) do
			if farm.CropEntityId == entity.Id then
				local entry = self:_getEntry(owner, instanceId)

				if entry then
					entry.CropHealth = state.Health
					entry.CropDamagedAt = state.DamagedAt
				end

				return
			end
		end
	end)

	-- A crop killed by damage leaves the farm fallow, exactly like harvesting.
	DamageableService.Destroyed:Connect(function(_, _killer, entity)
		if entity.ArchetypeId ~= "Crop" then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		if not owner then
			return
		end

		for instanceId, farm in self:_getFarms(owner) do
			if farm.CropEntityId == entity.Id then
				local entry = self:_getEntry(owner, instanceId)
				local seedId = if entry then entry.SeedId else nil

				farm.CropEntityId = nil

				if entry then
					entry.SeedId = ""
					entry.PlantedAt = nil
					entry.CropHealth = nil
					entry.CropDamagedAt = nil
				end

				self:_projectFallow(owner, farm)
				self.CropDestroyed:Fire(owner, instanceId, seedId)

				return
			end
		end
	end)

	local selectSeed = Remotes.GetEvent(GameConfig.RemoteNames.SelectSeed)

	selectSeed.OnServerEvent:Connect(function(player: Player, seedId: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		local plantable = GameConfig.GetPlantable(seedId)
		if not plantable then
			return
		end

		player:SetAttribute(GameConfig.Attributes.SelectedSeed, plantable.SeedId)
		self:_refreshAll(player)
	end)

	--[[
		Boost targeting. ProcessReceipt cannot carry a farm id, so the client
		records its intended target beforehand and the receipt handler reads it.
		Validated here, stored as a server-written attribute, so the receipt
		path never touches client input.
	]]
	local selectFarm = Remotes.GetEvent(GameConfig.RemoteNames.SelectFarm)

	selectFarm.OnServerEvent:Connect(function(player: Player, instanceId: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		if type(instanceId) ~= "string" or not self:_getEntry(player, instanceId) then
			return
		end

		player:SetAttribute(GameConfig.Attributes.TargetFarm, instanceId)
	end)

	local useBoost = Remotes.GetEvent(GameConfig.RemoteNames.UseBoost)

	useBoost.OnServerEvent:Connect(function(player: Player, instanceId: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		-- nil means "pick the best target for me"; anything else must be real.
		local target = nil

		if instanceId ~= nil then
			if type(instanceId) ~= "string" or not self:_getEntry(player, instanceId) then
				return
			end

			target = instanceId
		end

		self:CompleteGrowth(player, target)
	end)

	task.spawn(function()
		while true do
			task.wait(GameConfig.Growth.TickInterval)
			self:_tick()
		end
	end)

	return self
end

return FarmService
