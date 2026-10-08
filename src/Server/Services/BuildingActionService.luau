--!nonstrict
--[[
	BuildingActionService
	---------------------
	One validated entry point for every action a player takes on a building
	they own, and the server half of the selection panel.

	WHAT IT REPLACES
	----------------
	Owned buildings used to be operated through ProximityPrompts, which meant
	the SERVER decided what a press meant. A farm's prompt guessed between
	plant, harvest and uproot from the square's state; a pen needed four
	actions and ended up with two prompts on two keys, one of them held, drawn
	on top of each other until they were separated by a pixel offset. Neither
	building could offer a choice - which seed, which animal - which is why
	`SelectedSeed` was an attribute nothing ever set.

	Now the client says what it wants and the server decides whether it may.
	That is the normal shape for everything else in this project, and it is
	what makes a panel possible at all.

	THE VALIDATION LADDER
	---------------------
	Three rungs, each a different question, cheapest and most hostile first:

	  1. RATE        is this player spamming the remote?
	  2. OWNERSHIP   is this a building in THEIR profile?
	  3. AVAILABLE   does this building offer this action, and should the
	                 panel have offered it right now?

	and then the service behind the action asks the only question that
	actually grants anything: is it true, recomputed from the timestamps?

	Rung 3 is `Shared.BuildingActions`, which the client also runs - so a
	greyed-out button and a server refusal are the same verdict with the same
	reason code, exactly as `Shared.Buildability` already serves both the
	build menu and the placement service. It is a GATE, not the authority:
	attributes are only as fresh as the last tick, so the handler re-derives.

	"Does this building offer this action at all" was briefly a fourth rung
	here. It is the first thing `IsAvailable` asks, through the same function,
	so the separate call could not be made to fail independently - and a
	check no test can distinguish is a line that only looks like safety.

	WHY OWNERSHIP IS CHECKED AND REACH IS NOT
	-----------------------------------------
	The prompt path re-checked distance on the server, because prompt range
	is enforced on the client and an exploiter owns their client. That check
	does not carry over, deliberately: every action here affects only the
	caller's own buildings and their own inventory, so acting from across the
	base is not an exploit - it is what selecting a building across the base
	is FOR. Ownership is the real boundary, and it is read from the profile
	rather than from anything the client said.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local BuildingActions = require(Shared.BuildingActions)
local GameConfig = require(Shared.GameConfig)
local RateLimiter = require(Shared.RateLimiter)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local AnimalService = require(script.Parent.AnimalService)
local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local FarmService = require(script.Parent.FarmService)
local PlacementService = require(script.Parent.Parent.World.PlacementService)
local PlayerDataService = require(script.Parent.PlayerDataService)

local function failure(reason: string, extra: { [string]: any }?)
	local result = extra or {}
	result.Ok = false
	result.Reason = reason
	return result
end

local function success(fields: { [string]: any }?)
	local result = fields or {}
	result.Ok = true
	return result
end

local BuildingActionService = {}

BuildingActionService.FrameworkVersion = 15

BuildingActionService._started = false
BuildingActionService._limiter = nil

--- (player, instanceId, actionId, result)
BuildingActionService.Performed = Signal.new()

--------------------------------------------------------------------------------
-- Handlers
--------------------------------------------------------------------------------

--[[
	One handler per action id, each returning a result table.

	The handlers are thin on purpose: the rules live in the services that own
	the state, and this table is a routing decision rather than a second
	implementation of anything. A handler that started making rules would be
	a rule the panel could not see.

	`choice` is the item the action is performed WITH - a seed id, a livestock
	id - and is nil for actions with nothing to choose. It is untrusted; every
	handler that takes one passes it to a service that validates it.
]]
local HANDLERS = {}

--[[
	The seven that route to a service owning timestamped state.

	Each returns the service's own refusal code rather than a generic one, so
	the panel captions the button with the same reason the Notice remote turns
	into a sentence. The services return it because Signal:Fire dispatches
	asynchronously and a caller cannot observe the refusal signal.
]]
local function routed(method, service)
	return function(player, instanceId, _placed, choice)
		local ok, reason = method(service, player, instanceId, choice)

		if ok then
			return success()
		end

		return failure(reason or "Refused")
	end
end

HANDLERS.Plant = routed(FarmService.TryPlant, FarmService)
HANDLERS.Harvest = routed(FarmService.TryHarvest, FarmService)
HANDLERS.Uproot = routed(FarmService.TryUproot, FarmService)
HANDLERS.Stock = routed(AnimalService.TryStock, AnimalService)
HANDLERS.Feed = routed(AnimalService.TryFeed, AnimalService)
HANDLERS.Collect = routed(AnimalService.TryCollect, AnimalService)
HANDLERS.Slaughter = routed(AnimalService.TrySlaughter, AnimalService)

--[[
	Repair goes to the damageable registry, which owns health, prices the
	repair from the archetype and charges for it. The entity id comes from
	the placement record rather than from the client.
]]
HANDLERS.Repair = function(player, _instanceId, placed)
	if not placed.EntityId then
		return failure("NotRepairable")
	end

	return DamageableService:Repair(placed.EntityId, player)
end

HANDLERS.Demolish = function(player, instanceId)
	return PlacementService:Demolish(player, instanceId)
end

--------------------------------------------------------------------------------
-- The one public method
--------------------------------------------------------------------------------

--[[
	Performs `actionId` on the player's building `instanceId`.

	Called by the remote, and directly by tests. Returns a result table with
	`Ok`, and on failure a stable `Reason` code the panel can caption and the
	notice table can translate.
]]
function BuildingActionService:Perform(
	player: Player,
	instanceId: unknown,
	actionId: unknown,
	choice: unknown
): { [string]: any }
	local data = PlayerDataService:GetData(player)

	if not data then
		return failure("NoData")
	end

	if type(instanceId) ~= "string" or type(actionId) ~= "string" then
		return failure("BadRequest")
	end

	--[[
		OWNERSHIP, from the profile rather than from the world.

		GetPlaced is keyed per player, so a structure id belonging to someone
		else is simply absent here - there is no comparison to get wrong, and
		no attribute on a model for a client to have tampered with.
	]]
	local placed = PlacementService:GetPlaced(player)[instanceId]

	if not placed or not data.Structures[instanceId] then
		return failure("UnknownStructure")
	end

	--[[
		The same verdict the panel rendered, from the same function. A client
		that forces a greyed-out button gets the reason its own button was
		already showing.
	]]
	local context = BuildingActions.ReadContext(placed.Model, os.time())
	local action = GameConfig.GetAction(actionId)

	--[[
		What the player has to spend. Gathered here rather than inside the
		rules so the rules stay pure, and so the client can gather the same
		two things from its own replicated state.
	]]
	local resources = {}

	for _, resourceId in GameConfig.GetResourceIds() do
		resources[resourceId] = PlayerDataService:GetResource(player, resourceId)
	end

	local holdings = { Items = PlayerDataService:GetInventory(player), Resources = resources }

	local choices = {}

	if action and action.Choice then
		choices = BuildingActions.GetChoices(
			placed.StructureId,
			actionId,
			holdings.Items,
			PlayerDataService:GetLevel(player)
		)
	end

	local available, reason = BuildingActions.IsAvailable(actionId, context, choices, holdings)

	if not available then
		return failure(reason or "Unavailable")
	end

	--[[
		A choice must be one the player could actually have been offered.
		Nil is allowed and means "pick for me", which is what the services
		already do - the panel sends an explicit choice, a test or a future
		automation tool need not.
	]]
	if choice ~= nil then
		if type(choice) ~= "string" or not table.find(choices, choice) then
			return failure("BadChoice")
		end
	end

	local handler = HANDLERS[actionId]

	if not handler then
		return failure("NotOffered")
	end

	local result = handler(player, instanceId, placed, choice)

	self.Performed:Fire(player, instanceId, actionId, result)

	return result
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

--[[
	Why an action was refused, for the codes no other service explains.

	The farm and husbandry services already fire their own refusals through
	the Notice remote, so most presses explain themselves. These are the ones
	that can only come from here - a stale panel, or a client sending
	something it was never offered.
]]
local ACTION_REFUSALS = {
	NotOffered = "That building cannot do that.",
	NotGrown = "It is not ready yet.",
	UnknownStructure = "That building is not yours.",
	BadChoice = "You cannot use that here.",
	Occupied = "There is already something in there.",
	Undamaged = "That building is not damaged.",
	--[[
		The damageable registry's own codes. This panel is the first
		client-reachable path to Repair, so before it there was nothing to
		announce them and nobody to hear them.
	]]
	AlreadyFull = "That building is not damaged.",
	NotEnoughResources = "You cannot afford that repair.",
	NotOwner = "That is not yours to repair.",
	UnknownEntity = "There is nothing there to repair.",
	NotRepairable = "That building cannot be repaired.",
	Shattered = "That has to be rebuilt, not repaired.",
	RateLimited = "Slow down.",
}

--- Wraps every remote-facing call: throttle, run, never throw. An erroring
--- OnServerInvoke surfaces on the client and tells an attacker they found an
--- unhandled path.
function BuildingActionService:_handle(player: Player, operation: () -> any)
	if not self._limiter:Consume(player) then
		return failure("RateLimited")
	end

	local ok, result = pcall(operation)

	if not ok then
		warn(`[BuildingActionService] Action errored for {player.Name}: {result}`)
		return failure("InternalError")
	end

	return result
end

function BuildingActionService:Start()
	assert(RunService:IsServer(), "BuildingActionService is server-only")

	if self._started then
		return self
	end
	self._started = true

	self._limiter = RateLimiter.new(GameConfig.Selection.RequestsPerSecond, GameConfig.Selection.BurstSize)

	local notice = Remotes.GetEvent(GameConfig.RemoteNames.Notice)

	local perform = Remotes.GetFunction(GameConfig.RemoteNames.BuildingAction)

	perform.OnServerInvoke = function(player: Player, instanceId: unknown, actionId: unknown, choice: unknown)
		local result = self:_handle(player, function()
			return self:Perform(player, instanceId, actionId, choice)
		end)

		--[[
			Refusals the acting service did not already announce are
			announced here, so no press is ever silent. A press that does
			nothing and says nothing is indistinguishable from a broken
			button, which is the lesson the planting refusals taught.
		]]
		if not result.Ok then
			local message = ACTION_REFUSALS[result.Reason]

			if message then
				notice:FireClient(player, message)
			end
		end

		return result
	end

	Players.PlayerRemoving:Connect(function(player: Player)
		self._limiter:Forget(player)
	end)

	return self
end

return BuildingActionService
