--[[
	StatusEffectService
	-------------------
	Applies and resolves burns, chills, poisons and regeneration on anything in
	the damageable registry.

	WHAT IT OWNS
	------------
	A map of entityId -> effectId -> record. Nothing else; health still belongs
	to DamageableService, and every point of damage this service deals goes
	through ApplyDamage so the counter table, the death path and the kill
	rewards stay written once.

	THE LOOP, AND WHY THE LOOP IS NOT THE CLOCK
	-------------------------------------------
	A single thread wakes every TickInterval and calls Step(). That is the only
	periodic work in the project, and it exists for one reason: a burning
	raider has to die on its own, without anything querying it first.

	But the loop does not decide HOW MUCH happens. Step bills elapsed time:

		amount = PerSecond * Stacks * (now - LastTickAt)

	So the loop's frequency is a precision setting, not a damage setting. Run
	it twice as often and nothing changes but the smoothness. Skip ten ticks to
	a lag spike and the eleventh charges for all of it. The alternative -
	`PerSecond * TickInterval` per tick - silently converts server stutter into
	free healing for the enemy, and the symptom (enemies feel tanky when busy)
	is almost impossible to trace back to its cause.

	SELF-CLEANING
	-------------
	Entities leave the registry without announcing it (Unregister is called
	directly when a player disconnects). Rather than add a signal for that,
	Step drops records whose entity has gone. The loop was going to visit them
	anyway, so cleanup is free and cannot be forgotten.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)
local StatusEffects = require(Shared.StatusEffects)

local DamageableService = require(script.Parent.DamageableService)

local RULES = GameConfig.StatusEffectRules

local StatusEffectService = {}

StatusEffectService.FrameworkVersion = 14

StatusEffectService._started = false
--- entityId -> { [effectId]: record }
StatusEffectService._effects = {}

--- (entityId, effectId, stacks, record)
StatusEffectService.Applied = Signal.new()
--- (entityId, effectId) - ran out, as opposed to being cleansed
StatusEffectService.Expired = Signal.new()
--- (entityId, effectId, amount) - amount is positive for damage and healing
--- alike; the effect's Kind says which. For floating combat numbers.
StatusEffectService.Ticked = Signal.new()

--------------------------------------------------------------------------------
-- Replication
--------------------------------------------------------------------------------

--[[
	Mirrors an entity's effects onto its model as attribute pairs.

	Unlike health, this cannot be a write-once description of the whole curve:
	an effect's stack count genuinely changes. But it is still only written on
	application and expiry, not every tick, because the expiry timestamp lets
	the client run its own countdown.
]]
local function publish(entityId: number, records: { [string]: any })
	local entity = DamageableService:Get(entityId)
	local model = if entity then entity.Model else nil

	if not model or not model.Parent then
		return
	end

	local now = os.time()

	for effectId in GameConfig.StatusEffects do
		local stacks = StatusEffects.GetStacks(records[effectId], now)

		if stacks > 0 then
			model:SetAttribute(StatusEffects.StackAttribute(effectId), stacks)
			model:SetAttribute(StatusEffects.ExpiryAttribute(effectId), records[effectId].ExpiresAt)
		else
			-- Cleared rather than zeroed, so "no attribute" and "not affected"
			-- are the same state and the client needs only one check.
			model:SetAttribute(StatusEffects.StackAttribute(effectId), nil)
			model:SetAttribute(StatusEffects.ExpiryAttribute(effectId), nil)
		end
	end
end

--------------------------------------------------------------------------------
-- Queries
--------------------------------------------------------------------------------

--- The live record table for an entity. Empty table if it has none.
function StatusEffectService:Get(entityId: number): { [string]: any }
	return self._effects[entityId] or {}
end

function StatusEffectService:GetRecord(entityId: number, effectId: string)
	return self:Get(entityId)[effectId]
end

function StatusEffectService:GetStacks(entityId: number, effectId: string): number
	return StatusEffects.GetStacks(self:GetRecord(entityId, effectId), os.time())
end

function StatusEffectService:HasEffect(entityId: number, effectId: string): boolean
	return self:GetStacks(entityId, effectId) > 0
end

function StatusEffectService:GetRemaining(entityId: number, effectId: string): number
	return StatusEffects.GetRemaining(self:GetRecord(entityId, effectId), os.time())
end

function StatusEffectService:GetActive(entityId: number)
	return StatusEffects.GetActiveList(self:Get(entityId), os.time())
end

--- Combined movement multiplier. Whatever moves the entity reads this; the
--- service does not reach out and set WalkSpeed, because it has no idea
--- whether the entity walks.
function StatusEffectService:GetSpeedMultiplier(entityId: number): number
	return StatusEffects.GetSpeedMultiplier(self:Get(entityId), os.time())
end

--------------------------------------------------------------------------------
-- Application
--------------------------------------------------------------------------------

--[[
	Applies one stack of `effectId`, or refreshes it if already at MaxStacks.

	Returns { Ok, Reason?, Stacks, ExpiresAt }.

	`source` may be a Player or nil, and is remembered only so a kill by a
	burn can still be attributed to whoever lit the fire.
]]
function StatusEffectService:Apply(entityId: number, effectId: unknown, source: Player?): { [string]: any }
	local effect = GameConfig.GetStatusEffect(effectId)

	if not effect then
		return { Ok = false, Reason = "UnknownEffect" }
	end

	-- Refusing to burn a corpse keeps the registry from accumulating effects
	-- on entities that will never tick again.
	if not DamageableService:IsAlive(entityId) then
		return { Ok = false, Reason = "NotAlive" }
	end

	local now = os.time()
	local records = self._effects[entityId]

	if not records then
		records = {}
		self._effects[entityId] = records
	end

	local existing = records[effect.Id]

	if StatusEffects.IsActive(existing, now) then
		--[[
			Bill the time already elapsed BEFORE adding the stack.

			Otherwise a stack applied late is charged retroactively: four
			seconds of a single Burn followed by a second stack would bill all
			four seconds at the doubled rate. The player would be punished for
			the attacker's timing rather than for the overlap.
		]]
		self:_settle(entityId, existing, now)

		existing.Stacks = math.min(existing.Stacks + 1, effect.MaxStacks)
		existing.ExpiresAt = now + effect.Duration
		existing.SourceUserId = if source then source.UserId else existing.SourceUserId
	else
		--[[
			A lapsed record is replaced rather than revived. Reusing it would
			carry a LastTickAt from the previous application, and the clamp in
			GetUnbilledSeconds would then charge the new effect for the gap
			between the two.
		]]
		records[effect.Id] = StatusEffects.NewRecord(effect.Id, now, if source then source.UserId else 0)
		existing = records[effect.Id]
	end

	publish(entityId, records)
	self.Applied:Fire(entityId, effect.Id, existing.Stacks, existing)

	return { Ok = true, Stacks = existing.Stacks, ExpiresAt = existing.ExpiresAt }
end

--- Removes an effect outright - a cleanse, a cure, stepping into water.
function StatusEffectService:Clear(entityId: number, effectId: string): boolean
	local records = self._effects[entityId]

	if not records or not records[effectId] then
		return false
	end

	records[effectId] = nil

	if next(records) == nil then
		self._effects[entityId] = nil
	end

	publish(entityId, records)

	return true
end

function StatusEffectService:ClearAll(entityId: number)
	local records = self._effects[entityId]

	if not records then
		return
	end

	self._effects[entityId] = nil

	-- Published from an empty table so the model's attributes are stripped
	-- even though the records are already gone.
	publish(entityId, {})
end

--------------------------------------------------------------------------------
-- Accrual
--------------------------------------------------------------------------------

--[[
	Charges one record for the time it owes, and advances its high-water mark.

	Returns the amount applied, which is zero whenever less than a whole
	unit has built up - the mark only moves once something was actually
	charged, so fractions accumulate rather than being rounded away tick after
	tick.
]]
function StatusEffectService:_settle(entityId: number, record: { [string]: any }, now: number): number
	local effect = GameConfig.GetStatusEffect(record.EffectId)

	if not effect or effect.PerSecond <= 0 then
		-- A pure debuff owes nothing, but its mark still advances so it is not
		-- reconsidered every tick.
		record.LastTickAt = StatusEffects.GetBilledThrough(record, now)
		return 0
	end

	local pending = StatusEffects.GetPendingAmount(record, now)

	--[[
		Amounts below one point are left on the clock rather than dropped.

		os.time() is whole seconds, so a 3/second poison on a half-second loop
		sees elapsed = 0 most ticks and elapsed = 1 occasionally. Advancing the
		mark on a zero charge would discard the remainder every time and the
		poison would deal visibly less than its stated rate.
	]]
	if pending < 1 then
		return 0
	end

	record.LastTickAt = StatusEffects.GetBilledThrough(record, now)

	local applied = 0

	if effect.Kind == "HealOverTime" then
		local result = DamageableService:Heal(entityId, pending)
		applied = if result.Ok then result.Restored else 0
	else
		local source = nil

		if record.SourceUserId and record.SourceUserId ~= 0 then
			source = Players:GetPlayerByUserId(record.SourceUserId)
		end

		-- Flat armour is skipped on purpose; see StatusEffectRules.
		local result = DamageableService:ApplyDamage(entityId, pending, effect.DamageType, source, {
			IgnoreArmour = RULES.IgnoreFlatArmour,
		})

		applied = if result.Ok then result.Dealt else 0
	end

	if applied > 0 then
		self.Ticked:Fire(entityId, effect.Id, applied)
	end

	return applied
end

--[[
	One pass over every entity carrying an effect.

	Public because the loop is not special: anything that wants effects brought
	up to date immediately - a test, a shutdown handler - can call this, and
	gets the same answer the loop would have reached.
]]
function StatusEffectService:Step()
	local now = os.time()

	for entityId, records in self._effects do
		-- Gone from the registry: drop the records and move on.
		if not DamageableService:Get(entityId) then
			self._effects[entityId] = nil
			continue
		end

		local expired = {}

		for effectId, record in records do
			self:_settle(entityId, record, now)

			if not StatusEffects.IsActive(record, now) then
				table.insert(expired, effectId)
			end
		end

		--[[
			Removed after the loop rather than during it. Settling an effect
			can kill the entity, which clears `records` through the Destroyed
			handler, and mutating a table mid-iteration is undefined in Luau.
		]]
		if #expired > 0 then
			local surviving = self._effects[entityId]

			for _, effectId in expired do
				if surviving then
					surviving[effectId] = nil
				end

				self.Expired:Fire(entityId, effectId)
			end

			if surviving then
				if next(surviving) == nil then
					self._effects[entityId] = nil
				end

				publish(entityId, surviving)
			end
		end
	end
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function StatusEffectService:Start()
	assert(RunService:IsServer(), "StatusEffectService is server-only")

	if self._started then
		return self
	end
	self._started = true

	--[[
		A destroyed entity stops burning. Shattered entities are still in the
		registry, so without this a shattered Checkpoint would keep ticking
		against a floor it can never fall below.
	]]
	DamageableService.Destroyed:Connect(function(entityId: number)
		self:ClearAll(entityId)
	end)

	--[[
		A rebuilt entity starts clean. Inheriting the effects that killed it
		would mean a Checkpoint rebuilt mid-raid was already on fire, which
		reads as the repair having failed.
	]]
	DamageableService.Rebuilt:Connect(function(entityId: number)
		self:ClearAll(entityId)
	end)

	task.spawn(function()
		while true do
			task.wait(RULES.TickInterval)

			--[[
				Wrapped because this thread must outlive any single bad entity.
				If one Step error killed the loop, every effect in the game
				would silently stop expiring - targets would stay chilled
				forever and nothing would point at the cause.
			]]
			local ok, err = pcall(function()
				self:Step()
			end)

			if not ok then
				warn(`[StatusEffectService] Step errored: {err}`)
			end
		end
	end)

	return self
end

return StatusEffectService
