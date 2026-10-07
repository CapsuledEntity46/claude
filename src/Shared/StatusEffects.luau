--!nonstrict
--[[
	StatusEffects
	-------------
	Pure mathematics and naming for burns, chills and poisons. No instances, no
	state, no yielding - so the server (which owns effects) and the client
	(which draws the pips) agree by construction.

	THE RECORD
	----------
	One effect on one entity is a flat table:

		{ EffectId, Stacks, AppliedAt, ExpiresAt, LastTickAt, SourceUserId }

	`ExpiresAt` is absolute, so "is this still burning?" is a comparison rather
	than a countdown someone has to remember to decrement.

	`LastTickAt` is the high-water mark of time already BILLED. Accrual asks
	"how much of this effect has happened that I have not charged for yet?",
	which is a subtraction of two timestamps - not a count of ticks. A loop
	that runs late, twice, or not at all still produces the same total, which
	is the entire reason this module exists separately from the service that
	drives it.

	See GameConfig.StatusEffects for why there is a loop at all.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local StatusEffects = {}

--------------------------------------------------------------------------------
-- Replication naming
--------------------------------------------------------------------------------

--[[
	Attribute names for one effect on a model.

	Two attributes per active effect rather than one encoded string: the client
	iterates GameConfig.StatusEffects, which it already has, and needs no
	parser that could disagree with the writer.
]]
function StatusEffects.StackAttribute(effectId: string): string
	return `Status{effectId}Stacks`
end

function StatusEffects.ExpiryAttribute(effectId: string): string
	return `Status{effectId}ExpiresAt`
end

--------------------------------------------------------------------------------
-- Records
--------------------------------------------------------------------------------

--- A fresh record for `effectId`, starting at one stack.
function StatusEffects.NewRecord(effectId: string, now: number, sourceUserId: number?)
	local effect = GameConfig.GetStatusEffect(effectId)

	if not effect then
		return nil
	end

	return {
		EffectId = effect.Id,
		Stacks = 1,
		AppliedAt = now,
		ExpiresAt = now + effect.Duration,
		-- Nothing has elapsed yet, so nothing is owed yet.
		LastTickAt = now,
		SourceUserId = tonumber(sourceUserId) or 0,
	}
end

function StatusEffects.IsActive(record: { [string]: any }?, now: number): boolean
	return record ~= nil and record.ExpiresAt > now
end

function StatusEffects.GetRemaining(record: { [string]: any }?, now: number): number
	if not record then
		return 0
	end

	return math.max(record.ExpiresAt - now, 0)
end

--- Stacks currently in force. An expired record reads as zero rather than as
--- its last value, so a caller cannot act on a lapsed effect by accident.
function StatusEffects.GetStacks(record: { [string]: any }?, now: number): number
	if not StatusEffects.IsActive(record, now) then
		return 0
	end

	return record.Stacks
end

--------------------------------------------------------------------------------
-- Accrual
--------------------------------------------------------------------------------

--[[
	Seconds of this effect that have happened but not yet been charged for.

	Clamped at both ends:

	  * never negative, so a clock that steps backwards cannot heal the target,
	  * never past ExpiresAt, so a loop that notices a lapsed effect late bills
	    the effect's duration and not the delay.

	The second clamp is what makes a missed tick safe in both directions: run
	the loop ten seconds late on a five second Burn and you get five seconds of
	damage, not ten.
]]
function StatusEffects.GetUnbilledSeconds(record: { [string]: any }, now: number): number
	local chargeableUntil = math.min(now, record.ExpiresAt)
	return math.max(chargeableUntil - record.LastTickAt, 0)
end

--- The timestamp `LastTickAt` should advance to once the caller has applied
--- the amount from GetUnbilledSeconds. Kept here so the clamp cannot be
--- written one way in the reader and another way in the writer.
function StatusEffects.GetBilledThrough(record: { [string]: any }, now: number): number
	return math.max(math.min(now, record.ExpiresAt), record.LastTickAt)
end

--[[
	The amount a record owes, before the counter table.

	Positive for both damage and healing - the Kind says which it is. Scales
	linearly with stacks, so three Burns hurt three times as much.
]]
function StatusEffects.GetPendingAmount(record: { [string]: any }, now: number): number
	local effect = GameConfig.GetStatusEffect(record.EffectId)

	if not effect or effect.PerSecond <= 0 then
		return 0
	end

	return effect.PerSecond * record.Stacks * StatusEffects.GetUnbilledSeconds(record, now)
end

--------------------------------------------------------------------------------
-- Aggregation
--------------------------------------------------------------------------------

--[[
	Combined movement multiplier from every active effect.

	Compounds rather than adding, so stacking slows diminishes instead of
	hitting zero, and is then floored by MinimumSpeedMultiplier - because a
	target at zero speed is stun-locked, and a stun-lock with no counterplay is
	invulnerability wearing a different hat.
]]
function StatusEffects.GetSpeedMultiplier(records: { [string]: any }, now: number): number
	local multiplier = 1

	for _, record in records do
		local stacks = StatusEffects.GetStacks(record, now)

		if stacks > 0 then
			local effect = GameConfig.GetStatusEffect(record.EffectId)

			if effect and effect.SpeedMultiplier < 1 then
				multiplier *= effect.SpeedMultiplier ^ stacks
			end
		end
	end

	return math.max(multiplier, GameConfig.StatusEffectRules.MinimumSpeedMultiplier)
end

--- Active effects as a sorted list, for UI. Sorted by effect id so the pips
--- do not reshuffle themselves between frames.
function StatusEffects.GetActiveList(records: { [string]: any }, now: number)
	local list = {}

	for _, record in records do
		if StatusEffects.IsActive(record, now) then
			table.insert(list, {
				EffectId = record.EffectId,
				Stacks = record.Stacks,
				Remaining = StatusEffects.GetRemaining(record, now),
			})
		end
	end

	table.sort(list, function(a, b)
		return a.EffectId < b.EffectId
	end)

	return list
end

return StatusEffects
