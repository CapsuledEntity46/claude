--!nonstrict
--[[
	PlacementService
	----------------
	Owns the build tree: validating, placing, persisting and demolishing
	structures.

	This is the system the RTS economy hangs off. A structure cannot be placed
	unless the player has the Age, owns the prerequisite buildings, is inside
	the required influence radius, has room, and can pay — and all of that is
	resolved from GameConfig on the server. The client sends a structure id and
	a position; nothing else is trusted.

	VALIDATION ORDER MATTERS
	------------------------
	Everything is checked BEFORE a single resource moves, so the happy path
	never needs a refund. Ordering is cheapest-and-most-likely-to-fail first,
	so a spammed request does the least work:

		1. data loaded
		2. structure exists in the directory
		3. Age requirement
		4. per-player limit
		5. prerequisite structures owned
		6. position is finite and inside the world
		7. inside the required influence radius
		8. footprint does not overlap an existing structure
		9. pay (TryPayConstruction — treasury first, purse on opt-in)
		10. build, register health, persist

	Only step 9 mutates anything. If it fails, nothing has changed.

	PERSISTENCE
	-----------
	`data.Structures` is keyed by a STRINGIFIED instance id, for the same
	reason plots are: DataStores serialise through JSON, which does not
	round-trip sparse integer keys.

	Structures are rebuilt from saved data when a player joins and torn down
	when they leave, so the world always matches the profile.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local RateLimiter = require(Shared.RateLimiter)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local PlayerDataService = require(script.Parent.Parent.Services.PlayerDataService)
local StructureBuilder = require(script.Parent.StructureBuilder)

local PlacementService = {}

PlacementService.FrameworkVersion = 9

PlacementService._started = false
PlacementService._placed = {} :: { [Player]: any }
PlacementService._limiter = nil
PlacementService._folder = nil

--- (player, instanceId, structureId, position)
PlacementService.Placed = Signal.new()
--- (player, instanceId, structureId)
PlacementService.Demolished = Signal.new()

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function failure(reason: string, extra: { [string]: any }?)
	local result = extra or {}
	result.Ok = false
	result.Reason = reason
	return result
end

local function success(fields: { [string]: any })
	fields.Ok = true
	return fields
end

--- Coerces an untrusted coordinate, rejecting NaN, infinity and out-of-bounds.
local function sanitizeCoordinate(value: unknown): number?
	local number = tonumber(value)

	-- NaN fails the self-comparison; infinity survives math.floor and would
	-- poison every later distance test, so both are rejected outright.
	if number == nil or number ~= number or number == math.huge or number == -math.huge then
		return nil
	end

	local limit = GameConfig.Placement.WorldLimit

	if number < -limit or number > limit then
		return nil
	end

	-- Snapped to whole studs so saved positions stay compact and two players
	-- cannot wedge structures together with sub-stud offsets.
	return math.floor(number + 0.5)
end

--- Half-extents on the ground plane, plus the required gap.
local function footprint(structure): (number, number)
	local gap = GameConfig.Placement.MinimumGap
	return structure.Size.X / 2 + gap / 2, structure.Size.Z / 2 + gap / 2
end

--------------------------------------------------------------------------------
-- Queries
--------------------------------------------------------------------------------

function PlacementService:GetPlaced(player: Player)
	return self._placed[player] or {}
end

--- How many of `structureId` the player owns.
function PlacementService:CountOwned(player: Player, structureId: string): number
	local count = 0

	for _, placed in self:GetPlaced(player) do
		if placed.StructureId == structureId then
			count += 1
		end
	end

	return count
end

function PlacementService:HasStructure(player: Player, structureId: string): boolean
	return self:CountOwned(player, structureId) > 0
end

--[[
	Whether (x, z) lies inside the influence radius of any owned structure of
	type `parentId`.

	Measured on the ground plane only - height is irrelevant, and including it
	would make a radius behave differently on a slope.
]]
function PlacementService:IsWithinRadiusOf(player: Player, parentId: string, x: number, z: number): boolean
	local parent = GameConfig.GetStructure(parentId)

	if not parent or not parent.ProvidesRadius then
		return false
	end

	local radiusSquared = parent.ProvidesRadius * parent.ProvidesRadius

	for _, placed in self:GetPlaced(player) do
		if placed.StructureId == parentId then
			local dx = placed.X - x
			local dz = placed.Z - z

			if dx * dx + dz * dz <= radiusSquared then
				return true
			end
		end
	end

	return false
end

--- Axis-aligned footprint overlap against every structure already placed,
--- including other players' - bases must not interpenetrate.
function PlacementService:IsBlocked(structure, x: number, z: number, ignoreInstanceId: string?): boolean
	local halfX, halfZ = footprint(structure)

	for _, owned in self._placed do
		for instanceId, placed in owned do
			if instanceId ~= ignoreInstanceId then
				local other = GameConfig.GetStructure(placed.StructureId)

				if other then
					local otherHalfX, otherHalfZ = footprint(other)

					if
						math.abs(placed.X - x) < halfX + otherHalfX
						and math.abs(placed.Z - z) < halfZ + otherHalfZ
					then
						return true
					end
				end
			end
		end
	end

	return false
end

--[[
	Why a structure cannot currently be built, ignoring position. Drives the
	build menu, so the UI greys out entries for the same reasons the server
	would reject them - no second rule set to drift.
]]
function PlacementService:GetBuildability(player: Player, structureId: string): (boolean, string?)
	local structure = GameConfig.GetStructure(structureId)

	if not structure then
		return false, "UnknownStructure"
	end

	if PlayerDataService:GetAge(player) < structure.RequiredAge then
		return false, "AgeTooLow"
	end

	if self:CountOwned(player, structure.Id) >= structure.MaxPerPlayer then
		return false, "LimitReached"
	end

	for _, prerequisiteId in structure.Prerequisites do
		if not self:HasStructure(player, prerequisiteId) then
			return false, "MissingPrerequisite"
		end
	end

	return true, nil
end

--------------------------------------------------------------------------------
-- Placement
--------------------------------------------------------------------------------

--[[
	Places a structure. Safe to call from server code; the remote handler is a
	throttled wrapper.

	Returns a result table. Failure reasons are stable codes:
	  NoData, UnknownStructure, AgeTooLow, LimitReached, MissingPrerequisite,
	  InvalidPosition, OutsideRadius, Blocked, NotEnoughResources, RateLimited,
	  InternalError
]]
function PlacementService:Place(player: Player, structureId: unknown, x: unknown, z: unknown)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	local structure = GameConfig.GetStructure(structureId)
	if not structure then
		return failure("UnknownStructure")
	end

	local buildable, reason = self:GetBuildability(player, structure.Id)
	if not buildable then
		return failure(reason)
	end

	local px = sanitizeCoordinate(x)
	local pz = sanitizeCoordinate(z)

	if px == nil or pz == nil then
		return failure("InvalidPosition")
	end

	if structure.RequiresWithinRadiusOf then
		if not self:IsWithinRadiusOf(player, structure.RequiresWithinRadiusOf, px, pz) then
			return failure("OutsideRadius", { ParentId = structure.RequiresWithinRadiusOf })
		end
	end

	if self:IsBlocked(structure, px, pz) then
		return failure("Blocked")
	end

	-- Everything above is read-only. This is the first mutation, and if it
	-- fails nothing has changed.
	if not PlayerDataService:TryPayConstruction(player, structure.Cost) then
		return failure("NotEnoughResources", { Cost = structure.Cost })
	end

	data.NextStructureId = (tonumber(data.NextStructureId) or 0) + 1
	local instanceId = tostring(data.NextStructureId)

	local entry = {
		StructureId = structure.Id,
		X = px,
		Z = pz,
	}

	data.Structures[instanceId] = entry
	self:_spawn(player, instanceId, entry)

	self.Placed:Fire(player, instanceId, structure.Id, Vector3.new(px, GameConfig.Placement.GroundY, pz))

	return success({
		InstanceId = instanceId,
		StructureId = structure.Id,
		X = px,
		Z = pz,
		Cost = structure.Cost,
	})
end

--[[
	Builds the model and registers health for one saved structure.

	Health is restored from the entry, so damage taken before a logout is still
	there on return, and the registry mirrors it back as it changes.
]]
function PlacementService:_spawn(player: Player, instanceId: string, entry: { [string]: any })
	local structure = GameConfig.GetStructure(entry.StructureId)
	if not structure then
		return
	end

	local model = StructureBuilder.Build(structure, instanceId, player.UserId, entry.X, entry.Z, self._folder)

	local entityId = DamageableService:Register({
		ArchetypeId = structure.ArchetypeId,
		Model = model,
		OwnerUserId = player.UserId,
		Shattered = entry.Shattered == true,
		State = if entry.Health then { Health = entry.Health, DamagedAt = entry.DamagedAt } else nil,
	})

	local owned = self._placed[player]
	if not owned then
		owned = {}
		self._placed[player] = owned
	end

	owned[instanceId] = {
		StructureId = entry.StructureId,
		X = entry.X,
		Z = entry.Z,
		Model = model,
		EntityId = entityId,
	}
end

--[[
	Demolishes an owned structure.

	Deliberately refunds nothing, matching Age of Empires. A partial refund is
	defensible, but it has to be below cost to avoid a laundering loop, and
	"below cost" is a balance decision rather than a systems one - so it is left
	out until the balance is being tuned.
]]
function PlacementService:Demolish(player: Player, instanceId: unknown)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	if type(instanceId) ~= "string" then
		return failure("UnknownStructure")
	end

	local owned = self._placed[player]
	local placed = if owned then owned[instanceId] else nil

	if not placed or not data.Structures[instanceId] then
		return failure("UnknownStructure")
	end

	local structureId = placed.StructureId

	self:_despawn(player, instanceId)
	data.Structures[instanceId] = nil

	self.Demolished:Fire(player, instanceId, structureId)

	return success({ InstanceId = instanceId, StructureId = structureId })
end

function PlacementService:_despawn(player: Player, instanceId: string)
	local owned = self._placed[player]
	local placed = if owned then owned[instanceId] else nil

	if not placed then
		return
	end

	if placed.EntityId then
		DamageableService:Unregister(placed.EntityId)
	end

	if placed.Model then
		placed.Model:Destroy()
	end

	owned[instanceId] = nil
end

--------------------------------------------------------------------------------
-- Lifecycle
--------------------------------------------------------------------------------

function PlacementService:_restore(player: Player, data: { [string]: any })
	self._placed[player] = {}

	-- Sorted so rebuild order is deterministic, which matters because the
	-- overlap check consults already-placed structures.
	local ids = {}
	for instanceId in data.Structures do
		table.insert(ids, instanceId)
	end
	table.sort(ids, function(a, b)
		return (tonumber(a) or 0) < (tonumber(b) or 0)
	end)

	for _, instanceId in ids do
		self:_spawn(player, instanceId, data.Structures[instanceId])
	end
end

function PlacementService:_release(player: Player)
	for instanceId in self:GetPlaced(player) do
		self:_despawn(player, instanceId)
	end

	self._placed[player] = nil
	self._limiter:Forget(player)
end

--------------------------------------------------------------------------------
-- Remote plumbing
--------------------------------------------------------------------------------

function PlacementService:_handle(player: Player, operation: () -> any)
	if not self._limiter:Consume(player) then
		return failure("RateLimited")
	end

	local ok, result = pcall(operation)

	if not ok then
		warn(`[PlacementService] Placement errored for {player.Name}: {result}`)
		return failure("InternalError")
	end

	return result
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function PlacementService:Start()
	assert(RunService:IsServer(), "PlacementService is server-only")

	if self._started then
		return self
	end
	self._started = true

	self._limiter = RateLimiter.new(GameConfig.Placement.RequestsPerSecond, GameConfig.Placement.BurstSize)

	local folder = Workspace:FindFirstChild(GameConfig.StructuresFolderName)
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = GameConfig.StructuresFolderName
		folder.Parent = Workspace
	end
	self._folder = folder

	PlayerDataService.ProfileLoaded:Connect(function(player: Player, data)
		self:_restore(player, data)
	end)

	Players.PlayerRemoving:Connect(function(player: Player)
		self:_release(player)
	end)

	--[[
		Structure health is owned by the damageable registry but must survive a
		rejoin, so it is mirrored onto the saved entry. The registry knows
		nothing about profiles; persisting is the owner's job.
	]]
	DamageableService.StateChanged:Connect(function(_, state, entity)
		local model = entity.Model
		if not model then
			return
		end

		local instanceId = model:GetAttribute(GameConfig.StructureAttributes.InstanceId)
		if not instanceId then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		local data = if owner then PlayerDataService:GetData(owner) else nil
		local entry = if data then data.Structures[instanceId] else nil

		if entry then
			entry.Health = state.Health
			entry.DamagedAt = state.DamagedAt
			entry.Shattered = entity.Shattered == true
		end
	end)

	-- A destroyed structure leaves the world and the profile, unless it
	-- shattered - a shattered Checkpoint must persist so it can be rebuilt.
	DamageableService.Destroyed:Connect(function(_, _killer, entity)
		local model = entity.Model
		if not model or entity.Shattered then
			return
		end

		local instanceId = model:GetAttribute(GameConfig.StructureAttributes.InstanceId)
		if not instanceId then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		local data = if owner then PlayerDataService:GetData(owner) else nil

		if not data or not data.Structures[instanceId] then
			return
		end

		local structureId = data.Structures[instanceId].StructureId

		self:_despawn(owner, instanceId)
		data.Structures[instanceId] = nil

		self.Demolished:Fire(owner, instanceId, structureId)
	end)

	local placeRemote = Remotes.GetFunction(GameConfig.RemoteNames.PlaceStructure)
	local demolishRemote = Remotes.GetFunction(GameConfig.RemoteNames.DemolishStructure)

	placeRemote.OnServerInvoke = function(player: Player, structureId: unknown, x: unknown, z: unknown)
		return self:_handle(player, function()
			return self:Place(player, structureId, x, z)
		end)
	end

	demolishRemote.OnServerInvoke = function(player: Player, instanceId: unknown)
		return self:_handle(player, function()
			return self:Demolish(player, instanceId)
		end)
	end

	-- Players whose profiles loaded before this service started.
	for _, player in Players:GetPlayers() do
		local data = PlayerDataService:GetData(player)

		if data then
			self:_restore(player, data)
		end
	end

	return self
end

return PlacementService
