--[[
	RaidService
	-----------
	Hostile raiders: spawning them, walking them to the base, and choosing
	what they hit when they get there.

	WHY THIS EXISTS SEPARATELY FROM AttackService
	---------------------------------------------
	AttackService answers "has my cooldown elapsed, and what is in range". It
	never moves anything. Getting into range is this service's job, and keeping
	the two apart means a tower needs no movement code and a raider needs no
	second damage path.

	TARGET SELECTION - THE PIECE WITH NO FOUNDATION
	----------------------------------------------
	docs/ROADMAP.md calls this out as the one part of combat plants that could
	not be built on something existing: "tanks protect plants behind" is an
	ENEMY TARGETING rule, not a plant property.

	In a lane game it is free - there is only one way through. In an open 3D
	base it has to be stated, or a raider walks past a wall of defences to hit
	the soft thing behind them and looks like it is cheating.

	So a raider picks its mark in three steps:

	  1. An OBJECTIVE, by priority: the nearest thing matching its archetype's
	     TargetPriority, or the nearest anything if it sees none of those.
	  2. A BLOCKER: the nearest entity standing in the corridor between the
	     raider and that objective (Spatial.FindBlocking).
	  3. It walks at whichever of those it must deal with first, and hits it
	     once in reach.

	Step 2 is the whole trick. Put a Bulwark in front of your Ember Blooms and
	the raiders engage the Bulwark, because it is what they walk into - no
	aggro table, no taunt stat, just geometry.

	MOVEMENT
	--------
	Straight-line, server-authoritative, speed scaled by status effects - so a
	Chill visibly slows the horde, which is the whole point of the Frost Lily.

	Timed on `time()` rather than os.time(), for the reason AttackService sets
	out: whole seconds would make a seven-stud-per-second raider teleport in
	seven-stud jumps. `LastMoveAt` is internal and never replicated.
	No pathfinding: raiders walk through nothing and over nothing, and a wall
	does not stop them, it only gets hit. Pathfinding belongs with the defeat
	loop, where walls become a real decision.

	WAVES ARE SUMMONED, NOT TIMED
	-----------------------------
	Nothing spawns on a clock. A raid happens when a player sounds the Raid
	Horn. That is deliberate: pacing, escalation and the consequences of losing
	belong to the Checkpoint and defeat loop, and a timer that attacks players
	mid-build before any of that exists would be a worse game, not an earlier
	one. It also makes defences testable on demand.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)
local Spatial = require(Shared.Spatial)

local AttackService = require(script.Parent.AttackService)
local DamageableService = require(script.Parent.DamageableService)
local StatusEffectService = require(script.Parent.StatusEffectService)

local RaidService = {}

RaidService.FrameworkVersion = 14

RaidService._started = false
--- entityId -> { EntityId, Model, OwnerUserId, TargetUserId, LastMoveAt }
RaidService._raiders = {}
RaidService._folder = nil

--- (userId, raiderCount)
RaidService.WaveStarted = Signal.new()
--- (userId) - every raider of that wave is down
RaidService.WaveCleared = Signal.new()

--------------------------------------------------------------------------------
-- Model
--------------------------------------------------------------------------------

local function buildRaiderModel(archetype, position: Vector3): Model
	local model = Instance.new("Model")
	model.Name = `Raider_{archetype.Id}`

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = Vector3.new(2.6, 5, 2.6)
	body.Position = position
	-- Anchored because the server owns the position outright; an unanchored
	-- part would be shoved around by physics and fight the mover.
	body.Anchored = true
	body.CanCollide = false
	body.Material = Enum.Material.Slate
	body.Color = if archetype.Id == "EnemyLooter"
		then Color3.fromRGB(150, 120, 60)
		else Color3.fromRGB(122, 58, 58)
	body.TopSurface = Enum.SurfaceType.Smooth
	body.BottomSurface = Enum.SurfaceType.Smooth
	body.Parent = model

	local billboard = Instance.new("BillboardGui")
	billboard.Name = "Label"
	billboard.Size = UDim2.fromOffset(150, 22)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, 3.6, 0)
	billboard.AlwaysOnTop = true
	billboard.Parent = body

	local text = Instance.new("TextLabel")
	text.Size = UDim2.fromScale(1, 1)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamBold
	text.TextSize = 13
	text.Text = archetype.Name
	text.TextColor3 = Color3.fromRGB(255, 222, 222)
	text.TextStrokeTransparency = 0.4
	text.Parent = billboard

	model.PrimaryPart = body

	return model
end

--------------------------------------------------------------------------------
-- Targets
--------------------------------------------------------------------------------

--[[
	Everything a raider may attack, belonging to one player.

	Scoped to the raid's victim rather than to "anything of the Player
	faction", so a raid on one base cannot wander into a neighbour's.
]]
function RaidService:_targetsOf(userId: number)
	local candidates = {}

	for _, entityId in DamageableService:GetAllEntityIds() do
		local entity = DamageableService:Get(entityId)

		if
			entity
			and entity.OwnerUserId == userId
			and entity.Archetype.Faction == GameConfig.Factions.Player
			and DamageableService:IsAlive(entityId)
		then
			local position = AttackService.GetPosition(entity)

			if position then
				table.insert(candidates, {
					EntityId = entityId,
					Position = position,
					Radius = AttackService.GetBodyRadius(entity),
					Tag = entity.Archetype.TargetTag,
				})
			end
		end
	end

	--[[
		And the player themselves, so a raid is something to survive rather
		than something to stand inside and watch.

		Added last, so Spatial's list-position tie-break prefers the base: a
		raider walks past you to hit the Mill, which reads as a raid rather
		than as a vendetta.
	]]
	local owner = Players:GetPlayerByUserId(userId)

	if owner then
		local candidate = AttackService.GetPlayerCandidate(owner)

		if candidate then
			table.insert(candidates, candidate)
		end
	end

	return candidates
end

--[[
	What this raider should be walking at, and how far away it is.

	See the header: objective by priority, then whatever is blocking the way
	there. Returns nil when the player has nothing left standing.
]]
function RaidService:ChooseMark(raider, candidates)
	local entity = DamageableService:Get(raider.EntityId)
	local origin = if entity then AttackService.GetPosition(entity) else nil

	if not origin or #candidates == 0 then
		return nil, math.huge
	end

	--[[
		The objective is chosen with an unlimited range: a raider that spawned
		at the edge of the map has to know where it is going before anything is
		within weapon reach. AttackService.SelectTarget handles the priority
		filter and its fallback.
	]]
	local objective = AttackService.SelectTarget(
		origin,
		candidates,
		entity.Archetype.TargetPriority,
		math.huge
	)

	if not objective then
		return nil, math.huge
	end

	--[[
		Now: is anything in the way? A blocker closer than the objective is
		what the raider meets first, so that is what it fights.

		This is the line that makes a tank plant mean something.
	]]
	local blocker, blockerDistance = Spatial.FindBlocking(
		origin,
		objective.Position,
		candidates,
		GameConfig.Combat.BlockingCorridor
	)

	if blocker and blocker.EntityId ~= objective.EntityId then
		return blocker, blockerDistance
	end

	return objective, Spatial.GroundDistance(origin, objective.Position)
end

--------------------------------------------------------------------------------
-- Movement
--------------------------------------------------------------------------------

--[[
	Walks every raider toward its mark.

	Distance is `speed * elapsed`, from the stored `LastMoveAt`, for the same
	reason status effect damage is: a late tick must cover the time it missed,
	or a stuttering server quietly slows the whole horde and the raid feels
	different depending on how busy the place is.
]]
function RaidService:_move(now: number)
	for entityId, raider in self._raiders do
		local entity = DamageableService:Get(entityId)

		if not entity then
			self:_forget(entityId)
			continue
		end

		local elapsed = math.max(now - raider.LastMoveAt, 0)
		raider.LastMoveAt = now

		if elapsed <= 0 then
			continue
		end

		local mark, distance = self:ChooseMark(raider, self:_targetsOf(raider.TargetUserId))

		if not mark then
			continue
		end

		local attack = GameConfig.GetAttack(entity.Archetype.AttackId)
		local reach = if attack then attack.Range else 0

		--[[
			How far it still has to walk, measured to the target's SURFACE and
			stopping comfortably INSIDE reach rather than exactly on it.

			Both halves matter. Centre-to-centre put raiders inside buildings,
			because a nine stud club against a sixteen stud wide Town Center
			meant closing to nine studs of its middle. And stopping exactly at
			reach was a deadlock waiting to happen: a hair of floating point
			error leaves the raider a fraction outside attack range, where its
			step is zero and it will never move again or fire again.
		]]
		local surfaceDistance = math.max(distance - (mark.Radius or 0), 0)
		local stopAt = reach * GameConfig.Raids.EngageFraction

		if surfaceDistance <= stopAt then
			continue
		end

		local body = entity.Model and entity.Model.PrimaryPart

		if not body then
			continue
		end

		--[[
			Speed is scaled by the raider's status effects, which is the
			entire payoff of the Frost Lily: a chilled horde takes visibly
			longer to cross the field and spends that time being shot.
		]]
		local speed = (entity.Archetype.MoveSpeed or 0)
			* StatusEffectService:GetSpeedMultiplier(entityId)

		if speed <= 0 then
			continue
		end

		-- Never overshoot, or a raider would oscillate across its target and
		-- never settle inside its own reach.
		local step = math.min(speed * elapsed, surfaceDistance - stopAt)

		local direction = Vector3.new(
			mark.Position.X - body.Position.X,
			0,
			mark.Position.Z - body.Position.Z
		)

		if direction.Magnitude > 1e-4 then
			local moved = body.Position + direction.Unit * step
			body.Position = Vector3.new(moved.X, body.Position.Y, moved.Z)
		end
	end
end

--------------------------------------------------------------------------------
-- Waves
--------------------------------------------------------------------------------

function RaidService:_forget(entityId: number)
	local raider = self._raiders[entityId]

	if not raider then
		return
	end

	self._raiders[entityId] = nil

	if raider.Model then
		raider.Model:Destroy()
	end

	-- Last one down: the wave is over.
	if self:CountRaiders(raider.TargetUserId) == 0 then
		self.WaveCleared:Fire(raider.TargetUserId)
	end
end

function RaidService:CountRaiders(userId: number): number
	local count = 0

	for _, raider in self._raiders do
		if raider.TargetUserId == userId then
			count += 1
		end
	end

	return count
end

function RaidService:GetRaiders()
	return self._raiders
end

--[[
	Calls off a player's raid, removing every raider still standing.

	Used by the defeat loop: whichever way a player chooses to come back, they
	need a moment to stand up, and raiders still swinging would make the
	choice pointless. The raiders simply leave - they are not killed, so no
	rewards are paid for a fight the player lost.
]]
function RaidService:ClearRaid(player: Player): number
	local cleared = 0

	-- Collected first: _forget mutates the table it would be iterating.
	local doomed = {}

	for entityId, raider in self._raiders do
		if raider.TargetUserId == player.UserId then
			table.insert(doomed, entityId)
		end
	end

	for _, entityId in doomed do
		DamageableService:Unregister(entityId)
		self:_forget(entityId)
		cleared += 1
	end

	return cleared
end

--[[
	Spawns one raider for `player`, `distance` studs from their base centre at
	`angle` radians.
]]
function RaidService:SpawnRaider(player: Player, archetypeId: string, angle: number, distance: number): number?
	local archetype = GameConfig.GetArchetype(archetypeId)

	if not archetype or archetype.Faction ~= GameConfig.Factions.Hostile then
		return nil
	end

	local centre = self:_baseCentre(player)
	local spawnAt = Vector3.new(
		centre.X + math.cos(angle) * distance,
		GameConfig.Placement.GroundY + 2.5,
		centre.Z + math.sin(angle) * distance
	)

	local model = buildRaiderModel(archetype, spawnAt)
	model.Parent = self._folder

	local entityId = DamageableService:Register({
		ArchetypeId = archetype.Id,
		Model = model,
		-- Hostile entities belong to nobody, so killing one always pays.
		OwnerUserId = 0,
	})

	if not entityId then
		model:Destroy()
		return nil
	end

	AttackService:Register(entityId)

	self._raiders[entityId] = {
		EntityId = entityId,
		Model = model,
		TargetUserId = player.UserId,
		LastMoveAt = time(),
	}

	return entityId
end

--- The middle of a player's holdings, which is where a raid converges.
function RaidService:_baseCentre(player: Player): Vector3
	local sum = Vector3.zero
	local count = 0

	for _, entityId in DamageableService:GetAllEntityIds() do
		local entity = DamageableService:Get(entityId)

		if entity and entity.OwnerUserId == player.UserId then
			local position = AttackService.GetPosition(entity)

			if position then
				sum += position
				count += 1
			end
		end
	end

	if count == 0 then
		local character = player.Character
		local root = if character then character.PrimaryPart else nil
		return if root then root.Position else Vector3.new(0, GameConfig.Placement.GroundY, 0)
	end

	return sum / count
end

--[[
	Sends a wave at `player`.

	Refused while one is already in progress, so the horn cannot be spammed
	into an unwinnable pile-up - and so the wave-cleared signal means what it
	says.
]]
function RaidService:SummonWave(player: Player): { [string]: any }
	local raid = GameConfig.Raids

	if self:CountRaiders(player.UserId) > 0 then
		return { Ok = false, Reason = "RaidInProgress" }
	end

	if #self:_targetsOf(player.UserId) == 0 then
		return { Ok = false, Reason = "NothingToRaid" }
	end

	local spawned = 0
	local index = 0
	local total = 0

	for _, entry in raid.Wave do
		total += entry.Count
	end

	for _, entry in raid.Wave do
		for _ = 1, entry.Count do
			-- Spread evenly around the base, so a wave arrives from all sides
			-- rather than single file.
			local angle = (index / math.max(total, 1)) * math.pi * 2

			if self:SpawnRaider(player, entry.ArchetypeId, angle, raid.SpawnDistance) then
				spawned += 1
			end

			index += 1
		end
	end

	if spawned < 1 then
		return { Ok = false, Reason = "SpawnFailed" }
	end

	self.WaveStarted:Fire(player.UserId, spawned)

	return { Ok = true, Raiders = spawned }
end

--------------------------------------------------------------------------------
-- The loop
--------------------------------------------------------------------------------

--- Public for the same reason the other combat loops are: a test, or anything
--- that wants the raid brought up to date, gets the loop's own answer.
function RaidService:Step()
	self:_move(time())
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function RaidService:Start()
	assert(RunService:IsServer(), "RaidService is server-only")

	if self._started then
		return self
	end
	self._started = true

	local folder = Workspace:FindFirstChild(GameConfig.RaidersFolderName)

	if not folder then
		folder = Instance.new("Folder")
		folder.Name = GameConfig.RaidersFolderName
		folder.Parent = Workspace
	end
	self._folder = folder

	DamageableService.Destroyed:Connect(function(entityId: number)
		self:_forget(entityId)
	end)

	-- A player leaving takes their raid with them: raiders exist to attack a
	-- base, and the base has gone.
	Players.PlayerRemoving:Connect(function(player: Player)
		for entityId, raider in self._raiders do
			if raider.TargetUserId == player.UserId then
				DamageableService:Unregister(entityId)
				self:_forget(entityId)
			end
		end
	end)

	task.spawn(function()
		while true do
			task.wait(GameConfig.Raids.MoveTickInterval)

			local ok, err = pcall(function()
				self:Step()
			end)

			if not ok then
				warn(`[RaidService] Step errored: {err}`)
			end
		end
	end)

	return self
end

return RaidService
