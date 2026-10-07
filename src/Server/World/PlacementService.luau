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
local Buildability = require(Shared.Buildability)
local GameConfig = require(Shared.GameConfig)
local RateLimiter = require(Shared.RateLimiter)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local AttackService = require(script.Parent.Parent.Combat.AttackService)
local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local PlayerDataService = require(script.Parent.Parent.Services.PlayerDataService)
local StructureBuilder = require(script.Parent.StructureBuilder)

local PlacementService = {}

PlacementService.FrameworkVersion = 14

PlacementService._started = false
PlacementService._placed = {} :: { [Player]: any }
PlacementService._limiter = nil
PlacementService._folder = nil

--- (player, instanceId, structureId, position)
PlacementService.Placed = Signal.new()
--- (player, instanceId, structureId)
PlacementService.Demolished = Signal.new()
--[[
	Fires for BOTH a fresh placement and a rebuild on rejoin, which is what
	systems attaching behaviour to a structure need - a farm restored from
	saved data must get its prompt exactly like a new one.
]]
--- (player, instanceId, entry, model, entityId)
PlacementService.Spawned = Signal.new()
--- (player, instanceId)
PlacementService.Despawned = Signal.new()

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

--[[
	Coerces an untrusted coordinate to a finite number.

	Bounds are NOT checked here. Snapping moves a coordinate by up to half a
	tile, so the limit has to be tested after the snap - otherwise a position
	the ghost showed as legal could be rejected, or one it showed as illegal
	accepted, and the preview would be subtly wrong near the world edge.
]]
local function toFiniteCoordinate(value: unknown): number?
	local number = tonumber(value)

	-- NaN fails the self-comparison; infinity survives math.floor and would
	-- poison every later comparison, so both are rejected outright.
	if number == nil or number ~= number or number == math.huge or number == -math.huge then
		return nil
	end

	return number
end

local function isWithinWorld(value: number): boolean
	local limit = GameConfig.Placement.WorldLimit
	return value >= -limit and value <= limit
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

--------------------------------------------------------------------------------
-- Count replication
--------------------------------------------------------------------------------

--[[
	Mirrors "how many of each structure does this player own" onto attributes of
	a folder under the Player.

	The build menu needs this to know when a prerequisite has just been met. The
	obvious alternative - have the client count the models in Workspace.Structures
	as they arrive - loses a race: a model replicates before its OwnerUserId
	attribute does, so the client either miscounts or has to poll. Replicating the
	count the server already knows removes the race entirely.

	Every known structure gets an attribute, zero included, so a reader never has
	to distinguish "none built" from "not replicated yet".
]]
function PlacementService:_countsFolder(player: Player): Folder
	local name = GameConfig.StructureCountsFolderName
	local folder = player:FindFirstChild(name)

	if not folder then
		folder = Instance.new("Folder")
		folder.Name = name

		for structureId in GameConfig.Structures do
			folder:SetAttribute(structureId, 0)
		end

		folder.Parent = player
	end

	return folder
end

function PlacementService:_publishCounts(player: Player)
	-- Parent may be gone if this runs during a disconnect.
	if not player.Parent then
		return
	end

	local folder = self:_countsFolder(player)
	local counts = {}

	for _, placed in self:GetPlaced(player) do
		counts[placed.StructureId] = (counts[placed.StructureId] or 0) + 1
	end

	for structureId in GameConfig.Structures do
		folder:SetAttribute(structureId, counts[structureId] or 0)
	end
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
	--[[
		Delegated to Shared.Buildability so the build menu reaches the same
		verdict from replicated data. This used to be written here and again on
		the client, with a comment on each promising they matched.

		Cost is deliberately NOT included: it is taken in TryPayConstruction
		after the position has been validated, so that aiming at an illegal
		spot reports the position rather than the price.
	]]
	local counts = {}

	for _, placed in self:GetPlaced(player) do
		counts[placed.StructureId] = (counts[placed.StructureId] or 0) + 1
	end

	return Buildability.CheckTree(structureId, counts, PlayerDataService:GetAge(player))
end

--------------------------------------------------------------------------------
-- Placement
--------------------------------------------------------------------------------

--[[
	Places a structure. Safe to call from server code; the remote handler is a
	throttled wrapper.

	Returns a result table. Failure reasons are stable codes:
	  NoData, UnknownStructure, AgeTooLow, LimitReached, MissingPrerequisite,
	  InvalidPosition, Blocked, NotEnoughResources, RateLimited, InternalError

	Position is unrestricted inside the world bounds: anywhere not already
	occupied is legal. Ownership of ground is established by building on it,
	not granted by an existing building's radius.
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

	local rawX = toFiniteCoordinate(x)
	local rawZ = toFiniteCoordinate(z)

	if rawX == nil or rawZ == nil then
		return failure("InvalidPosition")
	end

	--[[
		Snapped server-side rather than trusting the client's snap. The ghost
		snaps too, using the same config function, so an honest client sees
		exactly where the building lands - but a dishonest one cannot wedge a
		structure off-grid into a gap the grid is supposed to forbid.
	]]
	local px, pz = GameConfig.SnapPlacement(structure, rawX, rawZ)

	if not isWithinWorld(px) or not isWithinWorld(pz) then
		return failure("InvalidPosition")
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

	--[[
		A structure whose archetype names an attack becomes an attacker. This
		is the whole of the Watch Tower's behaviour: it had stats and a
		footprint and did nothing, and now it shoots, with no tower-specific
		code anywhere.

		Declines for everything else, so Mills and Farms take the same path.
	]]
	if entityId then
		AttackService:Register(entityId)
	end

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

	-- Published before the signal so any listener already sees the new count.
	self:_publishCounts(player)

	self.Spawned:Fire(player, instanceId, entry, model, entityId)
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
		AttackService:Unregister(placed.EntityId)
		DamageableService:Unregister(placed.EntityId)
	end

	-- Announced before the model goes away, so listeners can still read it.
	self.Despawned:Fire(player, instanceId)

	if placed.Model then
		placed.Model:Destroy()
	end

	owned[instanceId] = nil

	self:_publishCounts(player)
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

	-- Also covers the empty-base case, where no _spawn runs to publish.
	self:_publishCounts(player)

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

	local folder = player:FindFirstChild(GameConfig.StructureCountsFolderName)
	if folder then
		folder:Destroy()
	end
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
