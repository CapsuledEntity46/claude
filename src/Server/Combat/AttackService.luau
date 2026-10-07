--[[
	AttackService
	-------------
	Makes things shoot each other. One registry, one loop, one code path for
	every attacker in the game - towers, combat plants, raiders, and troops
	when they arrive.

	WHAT AN ATTACKER IS
	-------------------
	An entity already in DamageableService whose archetype names an `AttackId`.
	Nothing is duplicated here: health, armour, death and rewards stay where
	they were, and this service only answers "what does it shoot, and has its
	cooldown elapsed".

	CADENCE IS DERIVED, BUT SHOTS ARE NOT BANKED
	--------------------------------------------
	Each attacker stores `LastAttackAt` and fires when `now - LastAttackAt`
	clears the profile's cooldown. No timer per attacker, so a thousand idle
	towers cost a subtraction each.

	WHICH CLOCK, AND WHY THIS ONE
	-----------------------------
	Cadence uses `time()` - seconds since the server started - rather than
	`os.time()`, which everything else here uses. The rule is:

	  * os.time() for anything PERSISTED or REPLICATED. It is unix time, so
	    the client and the next session both agree on what it means. Growth,
	    health baselines, lock expiry and status effect expiry are all this.
	  * time() for cadence that is purely internal. It is monotonic and
	    sub-second, and it never leaves this service.

	os.time() cannot do cadence: it is whole seconds, so a 1.2 second cooldown
	would round to 2 and become indistinguishable from a 2 second one. Every
	attack profile would collapse into "once or twice a second" and the
	numbers in config would be lies.

	The reason this is safe is that `LastAttackAt` is never compared against a
	persisted timestamp, never saved, and never sent to a client. The moment
	any of those stops being true it has to move back to os.time().

	This is a DIFFERENT rule from status effects, and the difference is the
	interesting part. A burn accrues a quantity, so a late tick must bill the
	whole elapsed time or the damage is silently lost. An attack is a discrete
	event, so a late tick must NOT fire the shots it missed - a tower starved
	of ticks fires once and resumes. Banking arrows would turn a lag spike into
	a volley, which is far worse than dropping a shot.

	TARGETING IS DATA
	-----------------
	Nothing here knows what a Mill is. An attacker has a `TargetPriority` and
	every target has a `TargetTag`; the selector matches one against the other.
	A siege unit that hunts walls is a config edit.

	WHAT IT DOES NOT DO
	-------------------
	It does not move anything. Walking into range is the mover's job - see
	RaidService - and this service only ever asks where things are now.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Combat = require(Shared.Combat)
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)
local Spatial = require(Shared.Spatial)

local DamageableService = require(script.Parent.DamageableService)
local StatusEffectService = require(script.Parent.StatusEffectService)

local AttackService = {}

AttackService.FrameworkVersion = 14

AttackService._started = false
--- entityId -> { EntityId, LastAttackAt, Suspended }
AttackService._attackers = {}

--- (attackerId, targetId, attack, dealt, origin, impact) - one per shot
AttackService.Fired = Signal.new()

--------------------------------------------------------------------------------
-- Faction
--------------------------------------------------------------------------------

--[[
	Whether `a` shoots `b`.

	Player and Hostile fight each other; Neutral fights nobody and nobody
	fights it, which is what lets a practice dummy stand beside a tower.

	Two PLAYERS are not hostile. When player-versus-player arrives it needs a
	raid or truce relationship rather than a fourth faction, because "are these
	two at war" is a fact about the pair and not about either one.
]]
function AttackService.IsHostile(a: string?, b: string?): boolean
	local factions = GameConfig.Factions

	if a == nil or b == nil then
		return false
	end

	if a == factions.Neutral or b == factions.Neutral then
		return false
	end

	return a ~= b
end

--------------------------------------------------------------------------------
-- Registration
--------------------------------------------------------------------------------

--[[
	Registers an existing damageable entity as an attacker.

	Everything needed is read from the entity, so a caller cannot describe an
	attacker differently from the thing it actually is. Returns false when the
	entity is unknown or its archetype has no attack - a Bulwark is registered
	by the same code path as an Ember Bloom and simply declines.
]]
function AttackService:Register(entityId: number): boolean
	local entity = DamageableService:Get(entityId)

	if not entity or not entity.Archetype.AttackId then
		return false
	end

	--[[
		`LastAttackAt` starts at now, so a freshly built tower waits one
		cooldown before its first shot. Starting it in the past would let a
		player drop a tower into a crowd for an instant free volley, which
		makes placement a reflex test rather than a plan.
	]]
	self._attackers[entityId] = {
		EntityId = entityId,
		LastAttackAt = time(),
	}

	return true
end

function AttackService:Unregister(entityId: number)
	self._attackers[entityId] = nil
end

function AttackService:IsAttacker(entityId: number): boolean
	return self._attackers[entityId] ~= nil
end

function AttackService:Get(entityId: number)
	return self._attackers[entityId]
end

--------------------------------------------------------------------------------
-- Targets
--------------------------------------------------------------------------------

--[[
	Half an entity's footprint on the ground plane.

	Used so range is measured to a target's surface. Without it a nine stud
	club could not reach a sixteen stud wide Town Center without the raider
	standing inside the walls - which is exactly what it did.
]]
function AttackService.GetBodyRadius(entity): number
	local model = entity.Model
	local part = if model then model.PrimaryPart else nil

	if not part then
		return 0
	end

	-- The larger horizontal half-extent: a conservative circle around a
	-- rectangular footprint, so nothing is unreachable from any angle.
	return math.max(part.Size.X, part.Size.Z) / 2
end

--- Where an entity is, or nil if it has no body to shoot at.
function AttackService.GetPosition(entity): Vector3?
	local model = entity.Model

	if not model or not model.Parent then
		return nil
	end

	local part = model.PrimaryPart

	return if part then part.Position else nil
end

--[[
	A player's character as a candidate, or nil if they have no body.

	THE PLAYER IS NOT A DAMAGEABLE ENTITY. Their health belongs to their
	Humanoid, because the engine already owns it - respawning, falling damage
	and the health bar over their head all go through it, and a second
	authority for one number shows up as health flickering between two values.

	So a player is a candidate with a Humanoid instead of an EntityId, and the
	one place that difference matters is where damage is applied. The counter
	table still prices the hit, using GameConfig.PlayerCombat.
]]
function AttackService.GetPlayerCandidate(player: Player)
	local character = player.Character

	if not character or not character.Parent then
		return nil
	end

	local root = character.PrimaryPart
	local humanoid = character:FindFirstChildOfClass("Humanoid")

	if not root or not humanoid or humanoid.Health <= 0 then
		return nil
	end

	return {
		Humanoid = humanoid,
		UserId = player.UserId,
		Position = root.Position,
		Radius = GameConfig.PlayerCombat.BodyRadius,
		Tag = GameConfig.PlayerCombat.TargetTag,
	}
end

--[[
	Everything `attacker` could legally shoot, as Spatial candidates.

	Built fresh each time rather than cached. The registry is small (tens of
	entities, not thousands) and a stale cache in a combat loop produces the
	worst class of bug: shots at things that are already dead, or at where
	something used to be.
]]
function AttackService:GetCandidates(attacker)
	local entity = DamageableService:Get(attacker.EntityId)

	if not entity then
		return {}
	end

	local myFaction = entity.Archetype.Faction
	local candidates = {}

	for _, targetId in DamageableService:GetAllEntityIds() do
		if targetId ~= attacker.EntityId then
			local target = DamageableService:Get(targetId)

			if target and AttackService.IsHostile(myFaction, target.Archetype.Faction) then
				-- A shattered entity is at the floor and cannot be hurt
				-- further, so shooting it would waste every shot.
				if DamageableService:IsAlive(targetId) then
					local position = AttackService.GetPosition(target)

					if position then
						table.insert(candidates, {
							EntityId = targetId,
							Position = position,
							Radius = AttackService.GetBodyRadius(target),
							Tag = target.Archetype.TargetTag,
						})
					end
				end
			end
		end
	end

	--[[
		Players are added last, so a tie between a player and a building
		resolves to the building - Spatial breaks ties by list position.
		Raiders preferring masonry over people is the kinder default, and it
		keeps a raid readable as an attack on the base.
	]]
	if myFaction == GameConfig.Factions.Hostile then
		for _, player in Players:GetPlayers() do
			local candidate = AttackService.GetPlayerCandidate(player)

			if candidate then
				table.insert(candidates, candidate)
			end
		end
	end

	return candidates
end

--[[
	The target `priority` wants, from `candidates`, or nil.

	Priority FILTERS, then distance decides. A Defence-specific attacker that
	can see no defences falls back to anything rather than standing idle -
	Clash of Clans does the same, and the alternative is a unit that walks into
	a base and refuses to fight.
]]
function AttackService.SelectTarget(origin: Vector3, candidates, priority: string?, range: number)
	local preferred = nil

	if priority == "Defence" then
		preferred = "Defence"
	elseif priority == "Resource" then
		preferred = "Resource"
	end

	--[[
		Measured to the target's SURFACE, so reach means what it says against
		a building as well as against a raider.
	]]
	if preferred then
		local target = Spatial.FindNearestInReach(origin, candidates, range, function(candidate)
			return candidate.Tag == preferred
		end)

		if target then
			return target
		end
	end

	return Spatial.FindNearestInReach(origin, candidates, range)
end

--------------------------------------------------------------------------------
-- Firing
--------------------------------------------------------------------------------

--[[
	Resolves one shot against `targetId`, plus its splash.

	The primary target takes full damage; everything else inside the blast
	takes a share that falls off with distance. Splash deliberately hits ONLY
	things the attacker could legally shoot - a tower's blast does not scorch
	the farm it is defending, because friendly fire is a feature nobody asked
	for and a very confusing bug to be on the receiving end of.
]]
function AttackService:_resolveShot(attacker, entity, attack, target, origin: Vector3)
	local owner = nil

	-- Attribution: a player-owned attacker's kills pay that player.
	if entity.OwnerUserId and entity.OwnerUserId ~= 0 then
		owner = Players:GetPlayerByUserId(entity.OwnerUserId)
	end

	--[[
		A player, hit. The one place the two kinds of target differ.

		Damage still goes through the counter table, so armour classes mean
		the same thing for a person as for a wall - the Humanoid is only where
		the number is stored.
	]]
	local function hitPlayer(candidate, fraction: number): number
		local dealt = Combat.ComputeDamage(
			attack.Damage * fraction,
			attack.DamageType,
			GameConfig.PlayerCombat.ArmourClass,
			GameConfig.PlayerCombat.Armour
		)

		if dealt <= 0 or candidate.Humanoid.Health <= 0 then
			return 0
		end

		candidate.Humanoid:TakeDamage(dealt)
		return dealt
	end

	local function hit(id: number, fraction: number)
		local amount = attack.Damage * fraction

		if amount <= 0 then
			return 0
		end

		local result = DamageableService:ApplyDamage(id, amount, attack.DamageType, owner)

		--[[
			The status effect lands on anything the shot touched, including
			splash. That is most of what an Ember Bloom is for: the direct hit
			is small and the point is that the whole cluster catches fire.
		]]
		if result.Ok and attack.StatusEffect then
			StatusEffectService:Apply(id, attack.StatusEffect, owner)
		end

		return if result.Ok then result.Dealt else 0
	end

	local dealt = 0

	if target.Humanoid then
		dealt = hitPlayer(target, 1)
	else
		dealt = hit(target.EntityId, 1)
	end

	if attack.SplashRadius then
		local epicentre = target.Position

		--[[
			Centred on the TARGET, not the attacker: a blast arrives where the
			shot lands. Falling back to the attacker's own position would have
			a tower shelling its own feet when its target died mid-flight.
		]]
		if epicentre then
			for _, candidate in self:GetCandidates(attacker) do
				local isPrimary = if target.Humanoid
					then candidate.Humanoid == target.Humanoid
					else candidate.EntityId == target.EntityId

				if not isPrimary then
					local distance = Spatial.GroundDistance(epicentre, candidate.Position)

					if distance <= attack.SplashRadius then
						local fraction = Spatial.GetFalloff(
							distance,
							attack.SplashRadius,
							attack.SplashMinFraction or 1
						)

						if candidate.Humanoid then
							dealt += hitPlayer(candidate, fraction)
						else
							dealt += hit(candidate.EntityId, fraction)
						end
					end
				end
			end
		end
	end

	return dealt
end

--------------------------------------------------------------------------------
-- The loop
--------------------------------------------------------------------------------

--[[
	One pass over every attacker.

	Public for the same reason StatusEffectService:Step is: the loop is not
	special, and anything that wants the fight brought up to date immediately -
	a test, a wave resolution - gets the same answer the loop would.
]]
function AttackService:Step()
	local now = time()

	for entityId, attacker in self._attackers do
		local entity = DamageableService:Get(entityId)

		-- Gone from the registry: drop it. Costs nothing, and means no signal
		-- has to be invented for unregistering.
		if not entity then
			self._attackers[entityId] = nil
			continue
		end

		local attack = GameConfig.GetAttack(entity.Archetype.AttackId)

		if attack and not attacker.Suspended and DamageableService:IsAlive(entityId) then
			if now - attacker.LastAttackAt >= attack.Cooldown then
				local origin = AttackService.GetPosition(entity)

				if origin then
					local target = AttackService.SelectTarget(
						origin,
						self:GetCandidates(attacker),
						entity.Archetype.TargetPriority,
						attack.Range
					)

					if target then
						--[[
							The clock is reset only on a shot that actually
							fired. An attacker with nothing in range stays
							ready, so it shoots the instant something walks
							in rather than waiting out a cooldown it never
							spent.
						]]
						attacker.LastAttackAt = now

						--[[
							The impact point is read BEFORE the shot, because
							resolving it can destroy the target and take its
							model with it - and a tracer to nowhere is worse
							than no tracer.
						]]
						local impact = target.Position
						local dealt = self:_resolveShot(attacker, entity, attack, target, origin)

						self.Fired:Fire(entityId, target.EntityId, attack, dealt, origin, impact)
					end
				end
			end
		end
	end
end

--[[
	Stops an attacker firing without forgetting it.

	A combat plant that is still growing is suspended rather than unregistered,
	so maturing does not have to re-derive everything about it - and so an
	immature plant cannot be registered twice by two code paths.
]]
function AttackService:SetSuspended(entityId: number, suspended: boolean)
	local attacker = self._attackers[entityId]

	if attacker then
		attacker.Suspended = suspended == true
	end
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function AttackService:Start()
	assert(RunService:IsServer(), "AttackService is server-only")

	if self._started then
		return self
	end
	self._started = true

	-- A dead attacker stops shooting. Shattered entities stay in the registry,
	-- so without this a shattered Checkpoint with a weapon would keep firing.
	DamageableService.Destroyed:Connect(function(entityId: number)
		self:Unregister(entityId)
	end)

	-- A rebuilt one starts shooting again.
	DamageableService.Rebuilt:Connect(function(entityId: number)
		self:Register(entityId)
	end)

	--[[
		Shots are broadcast to everyone, not just the owner: a raid is a
		spectacle, and a neighbour watching your towers work is the point of
		building them where they can be seen.

		Fire-and-forget on purpose. A dropped effect costs a missing tracer
		and nothing else, because the remote carries no state - every number
		that matters is already replicated as an attribute.
	]]
	local effect = Remotes.GetEvent(GameConfig.RemoteNames.CombatEffect)

	self.Fired:Connect(function(_attackerId, _targetId, attack, _dealt, origin, impact)
		if origin and impact then
			effect:FireAllClients(attack.Id, origin, impact)
		end
	end)

	task.spawn(function()
		while true do
			task.wait(GameConfig.Combat.AttackTickInterval)

			--[[
				Wrapped because this thread must outlive any single bad
				attacker. One error killing the loop would stop every tower in
				the game firing, with nothing pointing at the cause.
			]]
			local ok, err = pcall(function()
				self:Step()
			end)

			if not ok then
				warn(`[AttackService] Step errored: {err}`)
			end
		end
	end)

	return self
end

return AttackService
