--!nonstrict
--[[
	DamageableService
	-----------------
	The single registry for anything that can be damaged: crops, buildings,
	turrets, animals, units, the player, enemies.

	WHY ONE SYSTEM
	--------------
	Every one of those needs health, armour, death and (sometimes) repair. Built
	per-system they drift immediately: six slightly different damage formulas,
	six death paths, six ways to forget to replicate. One registry means the
	counter table, the destruction rules and the reward payout are written once.

	WHAT IT DOES NOT DO
	-------------------
	It does not decide *who* can attack *what*, or how damage is aimed. That is
	the job of whatever calls ApplyDamage - a weapon, a turret, a siege engine -
	and each of those is responsible for its own authority checks. This service
	validates the numbers, not the intent.

	STATE OWNERSHIP
	---------------
	Health lives here in memory, as a `{ Health, DamagedAt }` baseline. Entities
	that must survive a rejoin (crops, buildings) are registered by an owner
	system which persists that state itself, via `StateChanged` and
	`GetState`. The registry deliberately does not reach into profiles: it has
	no idea which entities are persistent.

	REPLICATION
	-----------
	Health is published as attributes on the entity's model and clients derive
	the current value with Shared.Combat. Because regeneration is derived from
	a timestamp rather than ticked, a damaged entity needs ZERO updates while it
	heals - the attributes already describe the whole curve.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Combat = require(Shared.Combat)
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)

local PlayerDataService = require(script.Parent.Parent.Services.PlayerDataService)

local HEALTH_ATTR = GameConfig.HealthAttributes

local DamageableService = {}

DamageableService.FrameworkVersion = 8

DamageableService._started = false
DamageableService._entities = {}
DamageableService._byModel = {}
DamageableService._nextId = 0

--- (entityId, amount, attacker, entity)
DamageableService.Damaged = Signal.new()
--- (entityId, killer, entity) - fired for both removal and shattering
DamageableService.Destroyed = Signal.new()
--- (entityId, entity) - a Shatter-behaviour entity was rebuilt
DamageableService.Rebuilt = Signal.new()
--- (entityId, restored, entity)
DamageableService.Repaired = Signal.new()
--- (entityId, state, entity) - owners persist from this
DamageableService.StateChanged = Signal.new()

--------------------------------------------------------------------------------
-- Internals
--------------------------------------------------------------------------------

local function publish(entity)
	local model = entity.Model

	if not model or not model.Parent then
		return
	end

	local archetype = entity.Archetype

	model:SetAttribute(HEALTH_ATTR.MaxHealth, archetype.MaxHealth)
	model:SetAttribute(HEALTH_ATTR.HealthBase, entity.State.Health)
	model:SetAttribute(HEALTH_ATTR.DamagedAt, entity.State.DamagedAt)
	model:SetAttribute(HEALTH_ATTR.RegenPerSecond, archetype.RegenPerSecond or 0)
	model:SetAttribute(HEALTH_ATTR.ArmourClass, archetype.ArmourClass)
	model:SetAttribute(HEALTH_ATTR.Shattered, entity.Shattered == true)
end

local function commit(self, entity)
	publish(entity)
	self.StateChanged:Fire(entity.Id, entity.State, entity)
end

--------------------------------------------------------------------------------
-- Registration
--------------------------------------------------------------------------------

--[[
	Registers an entity and returns its id.

	descriptor:
	  ArchetypeId   required, must exist in GameConfig.Archetypes
	  Model         optional instance to publish health attributes on
	  OwnerUserId   0 for neutral or hostile
	  Level         scales kill rewards, default 1
	  State         optional { Health, DamagedAt } to restore a persisted entity
]]
function DamageableService:Register(descriptor: { [string]: any }): number?
	local archetype = GameConfig.GetArchetype(descriptor.ArchetypeId)

	if not archetype then
		warn(`[DamageableService] Register rejected unknown archetype: {tostring(descriptor.ArchetypeId)}`)
		return nil
	end

	self._nextId += 1
	local id = self._nextId

	local restored = descriptor.State
	local health = if restored then tonumber(restored.Health) else nil
	local damagedAt = if restored then tonumber(restored.DamagedAt) else nil

	local entity = {
		Id = id,
		ArchetypeId = archetype.Id,
		Archetype = archetype,
		Model = descriptor.Model,
		OwnerUserId = tonumber(descriptor.OwnerUserId) or 0,
		Level = math.max(math.floor(tonumber(descriptor.Level) or 1), 1),
		Shattered = descriptor.Shattered == true,
		State = {
			Health = math.clamp(health or archetype.MaxHealth, 0, archetype.MaxHealth),
			DamagedAt = damagedAt or os.time(),
		},
	}

	self._entities[id] = entity

	if entity.Model then
		self._byModel[entity.Model] = id
	end

	publish(entity)

	return id
end

function DamageableService:Unregister(entityId: number)
	local entity = self._entities[entityId]

	if not entity then
		return
	end

	if entity.Model then
		self._byModel[entity.Model] = nil
	end

	self._entities[entityId] = nil
end

function DamageableService:Get(entityId: number)
	return self._entities[entityId]
end

function DamageableService:GetByModel(model: Instance): number?
	return self._byModel[model]
end

--- The persistable baseline. Owners write this into their own saved data.
function DamageableService:GetState(entityId: number): { [string]: number }?
	local entity = self._entities[entityId]

	if not entity then
		return nil
	end

	return { Health = entity.State.Health, DamagedAt = entity.State.DamagedAt }
end

--------------------------------------------------------------------------------
-- Health
--------------------------------------------------------------------------------

function DamageableService:GetHealth(entityId: number): number
	local entity = self._entities[entityId]
	return if entity then Combat.GetHealth(entity.State, entity.Archetype, os.time()) else 0
end

function DamageableService:GetHealthFraction(entityId: number): number
	local entity = self._entities[entityId]
	return if entity then Combat.GetHealthFraction(entity.State, entity.Archetype, os.time()) else 0
end

function DamageableService:IsAlive(entityId: number): boolean
	local entity = self._entities[entityId]
	return entity ~= nil and not entity.Shattered and self:GetHealth(entityId) > 0
end

--------------------------------------------------------------------------------
-- Damage
--------------------------------------------------------------------------------

--[[
	Applies damage and resolves death.

	Returns a result table: { Ok, Reason?, Dealt, Health, Destroyed, Shattered }

	`attacker` may be a Player, a non-player identifier, or nil. It is used only
	for reward attribution and for the Destroyed signal; this function does not
	ask whether the attacker was *allowed* to attack. Callers own that.
]]
function DamageableService:ApplyDamage(
	entityId: number,
	amount: number,
	damageType: string,
	attacker: any?
): { [string]: any }
	local entity = self._entities[entityId]

	if not entity then
		return { Ok = false, Reason = "UnknownEntity" }
	end

	-- A shattered entity is already at the floor; further hits are wasted
	-- rather than driving health negative or re-firing Destroyed.
	if entity.Shattered then
		return { Ok = false, Reason = "AlreadyDestroyed" }
	end

	local archetype = entity.Archetype
	local now = os.time()
	local current = Combat.GetHealth(entity.State, archetype, now)

	if current <= 0 then
		return { Ok = false, Reason = "AlreadyDestroyed" }
	end

	local dealt = Combat.ComputeDamage(amount, damageType, archetype.ArmourClass, archetype.Armour)

	if dealt <= 0 then
		return { Ok = false, Reason = "NoDamage" }
	end

	-- Rebase: the derived value becomes the new stored baseline, so healing
	-- restarts from this moment rather than from the last time we wrote.
	entity.State.Health = math.max(current - dealt, 0)
	entity.State.DamagedAt = now

	self.Damaged:Fire(entityId, dealt, attacker, entity)

	if entity.State.Health > 0 then
		commit(self, entity)
		return { Ok = true, Dealt = dealt, Health = entity.State.Health, Destroyed = false }
	end

	-- Dead. Pay out before the entity goes away, so a reward cannot be lost to
	-- the unregister below.
	self:_payRewards(entity, attacker)

	local shattered = archetype.DestroyBehaviour == "Shatter"
	entity.Shattered = shattered

	commit(self, entity)
	self.Destroyed:Fire(entityId, attacker, entity)

	if not shattered then
		self:Unregister(entityId)
	end

	return { Ok = true, Dealt = dealt, Health = 0, Destroyed = true, Shattered = shattered }
end

--[[
	Pays kill rewards to a player attacker.

	Gold goes to the killer's PURSE, never the treasury. That is the whole rule
	from docs/ROADMAP.md: the purse is filled by kills and loot and nothing
	else, and market income can never reach it.
]]
function DamageableService:_payRewards(entity, attacker: any?)
	if typeof(attacker) ~= "Instance" or not attacker:IsA("Player") then
		return
	end

	-- No farming your own buildings for XP.
	if entity.OwnerUserId == attacker.UserId then
		return
	end

	local rewards = Combat.GetRewards(entity.Archetype, entity.Level)

	if rewards.XP > 0 then
		PlayerDataService:AddXP(attacker, rewards.XP)
	end

	if rewards.Gold > 0 then
		PlayerDataService:AddInventoryGold(attacker, rewards.Gold)
	end
end

--------------------------------------------------------------------------------
-- Repair and rebuild
--------------------------------------------------------------------------------

--[[
	Repairs one entity, charging the payer.

	Buildings never self-heal, so this is the only way they recover. Payment
	goes through TryPayConstruction, which means it draws the treasury first and
	only touches the personal purse if the player opted in.

	Resources are spent BEFORE health is restored, and the restore cannot fail,
	so there is no path where a player is charged for nothing.
]]
function DamageableService:Repair(entityId: number, payer: Player): { [string]: any }
	local entity = self._entities[entityId]

	if not entity then
		return { Ok = false, Reason = "UnknownEntity" }
	end

	local archetype = entity.Archetype

	if not archetype.Repairable then
		return { Ok = false, Reason = "NotRepairable" }
	end

	if entity.OwnerUserId ~= payer.UserId then
		return { Ok = false, Reason = "NotOwner" }
	end

	if entity.Shattered then
		return { Ok = false, Reason = "Shattered" }
	end

	local now = os.time()
	local current = Combat.GetHealth(entity.State, archetype, now)
	local missing = archetype.MaxHealth - current

	if missing <= 0 then
		return { Ok = false, Reason = "AlreadyFull" }
	end

	local cost = Combat.GetRepairCost(archetype, missing)

	if not cost then
		return { Ok = false, Reason = "NotRepairable" }
	end

	local paid = PlayerDataService:TryPayConstruction(payer, cost)

	if not paid then
		return { Ok = false, Reason = "NotEnoughResources", Cost = cost }
	end

	entity.State.Health = archetype.MaxHealth
	entity.State.DamagedAt = now

	commit(self, entity)
	self.Repaired:Fire(entityId, missing, entity)

	return { Ok = true, Restored = missing, Cost = cost }
end

--[[
	Repairs every damaged entity the player owns - the "Repair All" button.

	Iterated in id order so the outcome is deterministic: when resources run
	short partway through, the same subset is repaired every time rather than an
	arbitrary one decided by hash order.
]]
function DamageableService:RepairAll(player: Player): { [string]: any }
	local ids = {}

	for id, entity in self._entities do
		if entity.OwnerUserId == player.UserId and entity.Archetype.Repairable and not entity.Shattered then
			table.insert(ids, id)
		end
	end

	table.sort(ids)

	local repaired, restored = 0, 0
	local lastReason = nil

	for _, id in ids do
		local result = self:Repair(id, player)

		if result.Ok then
			repaired += 1
			restored += result.Restored
		else
			lastReason = result.Reason
		end
	end

	if repaired < 1 then
		return { Ok = false, Reason = lastReason or "NothingToRepair" }
	end

	return { Ok = true, Repaired = repaired, Restored = restored }
end

--[[
	Rebuilds a shattered entity, charging full-health repair cost.

	Only reachable for Shatter-behaviour archetypes, which is how a destroyed
	Checkpoint becomes recoverable instead of a loss.
]]
function DamageableService:Rebuild(entityId: number, payer: Player): { [string]: any }
	local entity = self._entities[entityId]

	if not entity then
		return { Ok = false, Reason = "UnknownEntity" }
	end

	if not entity.Shattered then
		return { Ok = false, Reason = "NotShattered" }
	end

	if entity.OwnerUserId ~= payer.UserId then
		return { Ok = false, Reason = "NotOwner" }
	end

	local archetype = entity.Archetype
	local cost = Combat.GetRepairCost(archetype, archetype.MaxHealth)

	if cost and not PlayerDataService:TryPayConstruction(payer, cost) then
		return { Ok = false, Reason = "NotEnoughResources", Cost = cost }
	end

	entity.Shattered = false
	entity.State.Health = archetype.MaxHealth
	entity.State.DamagedAt = os.time()

	commit(self, entity)
	self.Rebuilt:Fire(entityId, entity)

	return { Ok = true, Cost = cost }
end

--------------------------------------------------------------------------------
-- Queries
--------------------------------------------------------------------------------

function DamageableService:GetEntitiesOwnedBy(userId: number): { number }
	local ids = {}

	for id, entity in self._entities do
		if entity.OwnerUserId == userId then
			table.insert(ids, id)
		end
	end

	table.sort(ids)
	return ids
end

--- Total missing health across a player's repairable entities, so a UI can
--- show the Repair All cost before committing to it.
function DamageableService:GetRepairEstimate(player: Player): { [string]: number }
	local total = {}

	for _, id in self:GetEntitiesOwnedBy(player.UserId) do
		local entity = self._entities[id]

		if entity.Archetype.Repairable and not entity.Shattered then
			local missing = entity.Archetype.MaxHealth - self:GetHealth(id)
			local cost = Combat.GetRepairCost(entity.Archetype, missing)

			for resourceId, amount in cost or {} do
				total[resourceId] = (total[resourceId] or 0) + amount
			end
		end
	end

	return total
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function DamageableService:Start()
	assert(RunService:IsServer(), "DamageableService is server-only")

	if self._started then
		return self
	end
	self._started = true

	-- Entities owned by a departing player are dropped, so the registry does
	-- not grow for the life of the server. Persistent ones are restored from
	-- saved data by whichever system owns them.
	Players.PlayerRemoving:Connect(function(player: Player)
		for _, id in self:GetEntitiesOwnedBy(player.UserId) do
			self:Unregister(id)
		end
	end)

	return self
end

return DamageableService
