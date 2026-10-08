--!nonstrict
--[[
	Combat
	------
	Pure damage and health mathematics. No instances, no state, no yielding —
	just functions, so both the server (which owns health) and the client (which
	draws health bars) reach identical numbers.

	HEALTH IS DERIVED, NOT TICKED
	-----------------------------
	A regenerating entity stores two values: a `Health` baseline and the
	`DamagedAt` timestamp when that baseline was set. Current health is then
	computed on read:

		current = min(MaxHealth, Health + RegenPerSecond * (now - DamagedAt))

	This is the same decision as crop growth, and it buys the same things:

	  * crops keep healing while the player is offline,
	  * a server restart or lag spike cannot lose or duplicate healing,
	  * there is no per-entity heartbeat, so a thousand damaged crops cost
	    nothing until someone looks at one,
	  * the client can draw a smoothly filling bar from two replicated
	    attributes, with no streaming updates.

	Taking damage resets the baseline: `Health` becomes the current derived
	value minus the hit, and `DamagedAt` becomes now.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local Combat = {}

--------------------------------------------------------------------------------
-- Health derivation
--------------------------------------------------------------------------------

--[[
	Current health from the stored baseline.

	Works on plain numbers so the client can call it straight from replicated
	attributes without needing the archetype table.

	A destroyed entity (baseline <= 0) stays destroyed: regeneration never
	revives something, because resurrection is a gameplay decision, not an
	arithmetic one.
]]
function Combat.DeriveHealth(
	baseHealth: number,
	maxHealth: number,
	regenPerSecond: number,
	damagedAt: number,
	now: number?
): number
	if baseHealth <= 0 then
		return 0
	end

	if regenPerSecond <= 0 then
		return math.clamp(baseHealth, 0, maxHealth)
	end

	local elapsed = math.max((now or os.time()) - damagedAt, 0)
	return math.clamp(baseHealth + regenPerSecond * elapsed, 0, maxHealth)
end

--- Convenience wrapper over a `{ Health, DamagedAt }` state and an archetype.
function Combat.GetHealth(state: { [string]: any }, archetype: { [string]: any }, now: number?): number
	return Combat.DeriveHealth(
		state.Health or archetype.MaxHealth,
		archetype.MaxHealth,
		archetype.RegenPerSecond or 0,
		state.DamagedAt or 0,
		now
	)
end

--- 0..1, for health bars.
function Combat.GetHealthFraction(state: { [string]: any }, archetype: { [string]: any }, now: number?): number
	if archetype.MaxHealth <= 0 then
		return 0
	end

	return Combat.GetHealth(state, archetype, now) / archetype.MaxHealth
end

function Combat.IsDestroyed(state: { [string]: any }, archetype: { [string]: any }, now: number?): boolean
	return Combat.GetHealth(state, archetype, now) <= 0
end

--------------------------------------------------------------------------------
-- Damage
--------------------------------------------------------------------------------

--[[
	Damage after the counter table and flat armour.

	The multiplier encodes the rock-paper-scissors layer: siege wrecks buildings
	and barely scratches infantry, pierce shreds the unarmoured and glances off
	heavy armour. Flat armour is subtracted *after* the multiplier, so armour is
	worth more against many small hits than one big one.

	Always returns at least `MinimumDamage`, so a heavily armoured target is
	hard to kill rather than literally immune — an immune target is a
	softlocked siege.
]]
function Combat.ComputeDamage(amount: number, damageType: string, armourClass: string, armour: number?): number
	local base = tonumber(amount)

	if base == nil or base ~= base or base == math.huge or base <= 0 then
		return 0
	end

	local row = GameConfig.Combat.Multipliers[damageType]
	local multiplier = if row then row[armourClass] else nil

	-- An unknown pairing must not silently become zero damage, which would read
	-- as invulnerability. Fall back to unmodified.
	if multiplier == nil then
		multiplier = 1
	end

	local reduced = base * multiplier - math.max(tonumber(armour) or 0, 0)

	return math.max(reduced, GameConfig.Combat.MinimumDamage)
end

--- Reward for killing an entity, scaled by its level.
function Combat.GetRewards(archetype: { [string]: any }, level: number): { XP: number, Gold: number }
	local rewards = archetype.Rewards

	if not rewards then
		return { XP = 0, Gold = 0 }
	end

	local scale = math.max(math.floor(tonumber(level) or 1), 1)

	return {
		XP = math.floor((rewards.XP or 0) * scale),
		Gold = math.floor((rewards.Gold or 0) * scale),
	}
end

--------------------------------------------------------------------------------
-- Repair
--------------------------------------------------------------------------------

--[[
	Resource cost to restore `missingHealth` points.

	Costs are declared per health point so an archetype's repair bill scales
	with its size automatically, and are rounded UP so a one-point scratch is
	never free.
]]
function Combat.GetRepairCost(archetype: { [string]: any }, missingHealth: number): { [string]: number }?
	if not archetype.Repairable or not archetype.RepairCostPerHealth then
		return nil
	end

	local missing = math.max(tonumber(missingHealth) or 0, 0)

	if missing <= 0 then
		return nil
	end

	local cost = {}

	for resourceId, perPoint in archetype.RepairCostPerHealth do
		local amount = math.ceil(perPoint * missing)

		if amount > 0 then
			cost[resourceId] = amount
		end
	end

	return if next(cost) then cost else nil
end

return Combat
