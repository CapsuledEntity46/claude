--[[
	DefeatService
	-------------
	The Checkpoint, and what happens when a player falls.

	THE LOOP, from docs/ROADMAP.md
	------------------------------
	  1. Build a Checkpoint. It becomes where you respawn.
	  2. While it stands, dying is an inconvenience: you reappear at it.
	  3. Destroyed while you live, it SHATTERS rather than vanishing. That is
	     a setback, not a loss - you keep fighting.
	  4. Once the area is clear, a prompt on the wreck lets you rebuild it.
	  5. Fall while it lies in ruins and that is a defeat.
	  6. A defeat offers two ways back, and they cost different things.

	WHY SHATTERING IS THE WHOLE DESIGN
	----------------------------------
	A respawn anchor that can be destroyed outright makes a bad raid
	unrecoverable: lose it at the wrong moment and you are homeless with no
	way to get home. A respawn anchor that cannot be destroyed makes a raid
	toothless. Shattering is the third option - the anchor is gone but the
	SITE remains, so losing it costs you safety without costing you the place
	you were standing.

	That is why the only thing that ends a run is falling while already
	shattered. One disaster is a story; two in a row is a defeat.

	WHERE PLAYER HEALTH LIVES
	-------------------------
	In the Humanoid, not in DamageableService. The engine already owns
	respawning and the health bar above a character, and a second authority
	for one number shows up as health flickering between two values. This
	service listens to `Humanoid.Died` and never writes health.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)
local Spatial = require(Shared.Spatial)

local AttackService = require(script.Parent.AttackService)
local DamageableService = require(script.Parent.DamageableService)
local RaidService = require(script.Parent.RaidService)
local PlayerDataService = require(script.Parent.Parent.Services.PlayerDataService)
local PlacementService = require(script.Parent.Parent.World.PlacementService)

local DefeatService = {}

DefeatService.FrameworkVersion = 15

DefeatService._started = false
--- player -> true while down and yet to choose
DefeatService._defeated = {}
--- model -> prompt, for the wreck prompts this service owns
DefeatService._wreckPrompts = {}

local PROMPT_NAME = "RebuildPrompt"

--[[
	Why a rebuild was refused, in words the player can act on.

	A refusal with no explanation is indistinguishable from a broken button -
	the prompt was turning down rebuilds for want of resources and saying
	nothing at all, which read as the prompt not working.
]]
local REBUILD_REFUSALS = {
	NotSecure = "Clear the raiders near the wreck before rebuilding.",
	NotEnoughResources = "Not enough resources to rebuild the Checkpoint.",
	NotShattered = "Your Checkpoint is already standing.",
	NoAnchor = "You have no Checkpoint to rebuild.",
}
local ANCHOR_STRUCTURE = "Checkpoint"

--- (player) - the anchor shattered; the player is still up
DefeatService.AnchorLost = Signal.new()
--- (player) - rebuilt, by prompt or by coming back
DefeatService.AnchorRestored = Signal.new()
--- (player) - fell while shattered
DefeatService.Defeated = Signal.new()
--- (player, choice) - "FightOn" or "Surrender"
DefeatService.Resolved = Signal.new()

--------------------------------------------------------------------------------
-- Finding the anchor
--------------------------------------------------------------------------------

--[[
	The player's Checkpoint: its instance id, its placement record and its
	damageable entity. Nil when they have never built one.
]]
function DefeatService:GetAnchor(player: Player)
	for instanceId, placed in PlacementService:GetPlaced(player) do
		if placed.StructureId == ANCHOR_STRUCTURE then
			return instanceId, placed, DamageableService:Get(placed.EntityId)
		end
	end

	return nil, nil, nil
end

--- Whether the anchor exists and is standing.
function DefeatService:HasStandingAnchor(player: Player): boolean
	local _, _, entity = self:GetAnchor(player)
	return entity ~= nil and not entity.Shattered
end

--- Whether the anchor exists and lies in ruins. This is the vulnerable state.
function DefeatService:IsAnchorShattered(player: Player): boolean
	local _, _, entity = self:GetAnchor(player)
	return entity ~= nil and entity.Shattered == true
end

function DefeatService:IsDefeated(player: Player): boolean
	return self._defeated[player] == true
end

--------------------------------------------------------------------------------
-- Respawning
--------------------------------------------------------------------------------

--[[
	Puts a freshly spawned character on their anchor.

	Only when it is STANDING. A shattered anchor is exactly the state where
	the player has lost their safe place to reappear, so respawning on the
	wreck would hand back the thing the raid just took.
]]
--- Where a character should appear, given a standing anchor. Nil otherwise.
function DefeatService:GetAnchorSpawn(player: Player): Vector3?
	if not self:HasStandingAnchor(player) then
		return nil
	end

	local _, placed = self:GetAnchor(player)
	local model = if placed then placed.Model else nil
	local body = if model then model.PrimaryPart else nil

	if not body then
		return nil
	end

	--[[
		Beside it, not inside it. The anchor is a solid building, and spawning
		a character in the middle of one either wedges them or shunts them
		somewhere arbitrary.
	]]
	local structure = GameConfig.GetStructure(ANCHOR_STRUCTURE)
	local clearance = structure.Size.X / 2 + 4

	return Vector3.new(
		body.Position.X + clearance,
		GameConfig.Placement.GroundY + 4,
		body.Position.Z
	)
end

--[[
	Moves a freshly spawned character to their anchor.

	WAITS FOR THE ROOT PART, and that is the bug this function used to have.
	It read `character.PrimaryPart` the instant CharacterAdded fired and gave
	up when it was nil - which in the engine it almost always is, because the
	HumanoidRootPart has not been added and assigned yet. So the move silently
	never happened and players respawned at the world spawn with a perfectly
	good Checkpoint standing.

	The test harness hid it: its fake characters were fully built before the
	signal fired, so the stub was readier than the engine ever is.
]]
function DefeatService:_placeAtAnchor(player: Player, character: Instance)
	local position = self:GetAnchorSpawn(player)

	if not position then
		return false
	end

	local root = character.PrimaryPart or character:WaitForChild("HumanoidRootPart", 5)

	-- Gone again already: the player died or left while we waited.
	if not root or not character.Parent then
		return false
	end

	-- Re-checked after the wait, because the anchor could have fallen during
	-- it - and respawning onto a wreck is exactly what must not happen.
	if not self:HasStandingAnchor(player) then
		return false
	end

	root.CFrame = CFrame.new(position)

	return true
end

--[[
	Keeps the engine's own respawn point on the anchor.

	Belt and braces with the move above, and worth having: RespawnLocation
	means the character APPEARS at the anchor instead of appearing at the
	world spawn and being teleported a frame later, which the player sees as
	a flash. Cleared when the anchor falls, so a shattered anchor sends them
	back to the world spawn.
]]
function DefeatService:_syncRespawnLocation(player: Player)
	local _, placed = self:GetAnchor(player)
	local model = if placed then placed.Model else nil

	if not model or not self:HasStandingAnchor(player) then
		player.RespawnLocation = nil
		return
	end

	local spawn = model:FindFirstChild("AnchorSpawn")

	if not spawn then
		local position = self:GetAnchorSpawn(player)

		if not position then
			return
		end

		spawn = Instance.new("SpawnLocation")
		spawn.Name = "AnchorSpawn"
		spawn.Size = Vector3.new(6, 1, 6)
		spawn.Position = Vector3.new(position.X, GameConfig.Placement.GroundY, position.Z)
		spawn.Anchored = true
		spawn.CanCollide = false
		spawn.Transparency = 1
		-- Neutral, because teams are not a concept here.
		spawn.Neutral = true
		spawn.Duration = 0
		spawn.Parent = model
	end

	player.RespawnLocation = spawn
end

--------------------------------------------------------------------------------
-- The wreck
--------------------------------------------------------------------------------

--[[
	Whether the area around the wreck is clear enough to rebuild in.

	"Survive and secure the area" taken literally: rebuilding under fire would
	make shattering meaningless, because a player would simply stand in the
	rubble and tap the prompt while raiders hit them.
]]
function DefeatService:IsSecure(player: Player): boolean
	local _, placed = self:GetAnchor(player)
	local model = if placed then placed.Model else nil
	local body = if model then model.PrimaryPart else nil

	if not body then
		return false
	end

	for _, entityId in DamageableService:GetAllEntityIds() do
		local entity = DamageableService:Get(entityId)

		if
			entity
			and entity.Archetype.Faction == GameConfig.Factions.Hostile
			and DamageableService:IsAlive(entityId)
		then
			local position = AttackService.GetPosition(entity)

			if position and Spatial.IsWithin(body.Position, position, GameConfig.Defeat.SecureRadius) then
				return false
			end
		end
	end

	return true
end

--- Attaches the rebuild prompt to a shattered anchor, if it has none.
function DefeatService:_attachWreckPrompt(player: Player, model: Instance)
	local body = model.PrimaryPart

	if not body or body:FindFirstChild(PROMPT_NAME) then
		return
	end

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = PROMPT_NAME
	prompt.ActionText = "Rebuild"
	prompt.ObjectText = "Ruined Checkpoint"
	prompt.HoldDuration = GameConfig.Interaction.DestructiveHoldDuration
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	prompt.Triggered:Connect(function(triggering: Player)
		-- Only the owner, and only from arm's reach: prompt range is enforced
		-- on the machine an exploiter owns.
		if triggering ~= player then
			return
		end

		local character = triggering.Character
		local root = if character then character.PrimaryPart else nil

		if not root then
			return
		end

		local reach = GameConfig.Interaction.MaxActivationDistance + GameConfig.Interaction.DistanceTolerance

		if (root.Position - body.Position).Magnitude > reach then
			return
		end

		local result = self:TryRebuildAnchor(triggering)

		if not result.Ok then
			self:_notify(triggering, REBUILD_REFUSALS[result.Reason] or tostring(result.Reason))
		end
	end)

	self._wreckPrompts[model] = prompt
end

local function removePrompt(model: Instance)
	local body = model and model.PrimaryPart
	local prompt = if body then body:FindFirstChild(PROMPT_NAME) else nil

	if prompt then
		prompt:Destroy()
	end
end

--[[
	Rebuilds the wreck, charged at the normal repair rate.

	This is the path for a player who SURVIVED the raid, so it costs
	resources - the player still has a base and an economy. Coming back from a
	defeat is the other path, and it has already been paid for.
]]
function DefeatService:TryRebuildAnchor(player: Player): { [string]: any }
	local _, placed, entity = self:GetAnchor(player)

	if not entity then
		return { Ok = false, Reason = "NoAnchor" }
	end

	if not entity.Shattered then
		return { Ok = false, Reason = "NotShattered" }
	end

	if not self:IsSecure(player) then
		return { Ok = false, Reason = "NotSecure" }
	end

	--[[
		Charged the BUILD price, not the repair price.

		Repair is per health point, which for a two thousand health anchor is
		800 Wood and 800 Stone - five times what the Checkpoint costs new, and
		far beyond what a player holds after losing a raid. The prompt simply
		refused, silently, which is how this was found. A ruin costing what a
		new one costs is also easier to reason about than a number derived
		from a health total.
	]]
	local cost = GameConfig.GetStructure(ANCHOR_STRUCTURE).Cost

	if not PlayerDataService:TryPayConstruction(player, cost) then
		return { Ok = false, Reason = "NotEnoughResources", Cost = cost }
	end

	DamageableService:Restore(placed.EntityId)

	return { Ok = true, Cost = cost }
end

--------------------------------------------------------------------------------
-- Defeat
--------------------------------------------------------------------------------

--- Sends a short message to one player. Silent if the remote is not up yet.
function DefeatService:_notify(player: Player, message: string)
	if self._notice then
		self._notice:FireClient(player, message)
	end
end

function DefeatService:_setDefeated(player: Player, defeated: boolean)
	self._defeated[player] = if defeated then true else nil

	if player.Parent then
		-- Replicated rather than announced, so the panel is right for a client
		-- that joins, rejoins or reconnects mid-defeat.
		player:SetAttribute(GameConfig.Attributes.Defeated, defeated)
	end
end

--[[
	Called when a character dies.

	Death with an anchor standing is nothing: the respawn handler puts them
	back on it. Death with the anchor in ruins is the defeat.
]]
function DefeatService:_onDied(player: Player)
	if self:IsDefeated(player) then
		return
	end

	if not self:IsAnchorShattered(player) then
		return
	end

	self:_setDefeated(player, true)
	self.Defeated:Fire(player)
end

--[[
	Answers a defeat. Returns a result table.

	`choice`:
	  "FightOn"   spends Revenge Tokens, restores the anchor, clears the raid
	  "Surrender" free, but the raiders carry off a cut of the treasury

	Both end the raid and put the anchor back, because a defeat the player
	cannot come back from is just a dead end. The difference is the price, and
	that is the whole decision: a player with tokens spends one, a player
	without pays in resources and feels it.
]]
function DefeatService:Resolve(player: Player, choice: unknown): { [string]: any }
	if not self:IsDefeated(player) then
		return { Ok = false, Reason = "NotDefeated" }
	end

	if choice ~= "FightOn" and choice ~= "Surrender" then
		return { Ok = false, Reason = "UnknownChoice" }
	end

	local lost = nil

	if choice == "FightOn" then
		--[[
			Spent BEFORE anything is granted, and the spend is atomic. A
			player with no tokens is told so and stays defeated, rather than
			being quietly handed a free recovery.
		]]
		if not PlayerDataService:TrySpendRevengeTokens(player, GameConfig.Defeat.FightOnTokenCost) then
			return { Ok = false, Reason = "NoTokens" }
		end
	else
		lost = self:_takeSurrenderLoss(player)
	end

	-- The raid is called off either way: the player needs a moment to stand
	-- back up, and raiders still swinging would make the choice pointless.
	RaidService:ClearRaid(player)

	local _, placed = self:GetAnchor(player)

	if placed and placed.EntityId then
		--[[
			Restored, not Rebuilt: the price has already been paid, in tokens
			or in stores. Charging the repair cost on top would bill the
			player twice for one recovery.
		]]
		DamageableService:Restore(placed.EntityId)
	end

	self:_setDefeated(player, false)
	self.Resolved:Fire(player, choice)

	return { Ok = true, Choice = choice, Lost = lost }
end

--[[
	Takes the raiders' cut: a share of the PURSE, and nothing else.

	The treasury is untouched. Its stores are what the player's farms and
	mills exist to fill, and emptying them undoes hours of building to punish
	one bad fight. The purse is loot - gold won from kills, carried on the
	person - and losing it is exactly the kind of setback a lost fight should
	be. A raid can cost you what you were carrying; it cannot cost you what
	you built.

	Rounded DOWN, so a nearly empty purse loses nothing rather than its last
	coin: being broke should not be made worse.
]]
function DefeatService:_takeSurrenderLoss(player: Player): { [string]: number }
	local held = PlayerDataService:GetInventoryGold(player)
	local take = math.floor(held * GameConfig.Defeat.SurrenderPurseLoss)

	if take > 0 and PlayerDataService:TrySpendInventoryGold(player, take) then
		return { Purse = take }
	end

	return {}
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function DefeatService:Start()
	assert(RunService:IsServer(), "DefeatService is server-only")

	if self._started then
		return self
	end
	self._started = true

	self._notice = Remotes.GetEvent(GameConfig.RemoteNames.Notice)

	--[[
		A newly placed or restored anchor becomes the respawn point at once,
		rather than at the next death.
	]]
	PlacementService.Spawned:Connect(function(player: Player)
		self:_syncRespawnLocation(player)
	end)

	local function watchCharacter(player: Player, character: Instance)
		-- Spawned, so the wait inside cannot block the signal.
		task.spawn(function()
			self:_placeAtAnchor(player, character)
		end)

		local humanoid = character:FindFirstChildOfClass("Humanoid")

		if humanoid then
			humanoid.Died:Connect(function()
				self:_onDied(player)
			end)
		end
	end

	local function watchPlayer(player: Player)
		if player.Character then
			watchCharacter(player, player.Character)
		end

		player.CharacterAdded:Connect(function(character: Instance)
			watchCharacter(player, character)
		end)
	end

	for _, player in Players:GetPlayers() do
		watchPlayer(player)
	end

	Players.PlayerAdded:Connect(watchPlayer)

	Players.PlayerRemoving:Connect(function(player: Player)
		self._defeated[player] = nil
	end)

	--[[
		The anchor shattering is the moment the player becomes vulnerable, and
		the moment the wreck needs its prompt.
	]]
	DamageableService.Destroyed:Connect(function(entityId: number, _killer, entity)
		if not entity.Shattered or entity.Archetype.Id ~= ANCHOR_STRUCTURE then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)

		if not owner or not entity.Model then
			return
		end

		self:_attachWreckPrompt(owner, entity.Model)

		-- Back to the world spawn: the safe place to reappear is what the
		-- raid just took.
		self:_syncRespawnLocation(owner)

		self:_notify(owner, "Your Checkpoint has shattered. Clear the area, then rebuild it.")
		self.AnchorLost:Fire(owner)
	end)

	DamageableService.Rebuilt:Connect(function(_entityId: number, entity)
		if entity.Archetype.Id ~= ANCHOR_STRUCTURE or not entity.Model then
			return
		end

		removePrompt(entity.Model)
		self._wreckPrompts[entity.Model] = nil

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)

		if owner then
			self:_syncRespawnLocation(owner)
			self.AnchorRestored:Fire(owner)
		end
	end)

	--[[
		How a defeated player answers. A function rather than an event, so
		"you have no tokens left" reaches the player instead of the panel
		appearing to do nothing.
	]]
	local resolve = Remotes.GetFunction(GameConfig.RemoteNames.ResolveDefeat)

	resolve.OnServerInvoke = function(player: Player, choice: unknown)
		return self:Resolve(player, choice)
	end

	return self
end

return DefeatService
