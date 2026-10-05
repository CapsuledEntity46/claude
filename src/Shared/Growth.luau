--!nonstrict
--[[
	Growth
	------
	Pure stage math for planted crops. Lives in Shared so the server (which
	owns the real state) and the client (which draws timers and previews) derive
	stages from exactly the same function and can never disagree.

	Growth is derived from wall-clock timestamps rather than counted up by a
	loop, which means:
	  * crops keep growing while the player is offline,
	  * a server restart or lag spike cannot lose growth progress,
	  * the stage is recomputed, never accumulated, so it cannot drift.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local Growth = {}

--- Fraction of the grow time elapsed, clamped to [0, 1].
function Growth.GetProgress(plantedAt: number, growTime: number, now: number?): number
	if growTime <= 0 then
		return 1
	end

	local elapsed = (now or os.time()) - plantedAt
	return math.clamp(elapsed / growTime, 0, 1)
end

--- Maps a [0, 1] progress value onto a stage id.
function Growth.GetStageFromProgress(progress: number): string
	local stages = GameConfig.Growth.Stages
	local current = stages[1].Id

	-- Thresholds ascend (asserted in GameConfig), so the last one we clear wins.
	for _, stage in stages do
		if progress >= stage.Threshold then
			current = stage.Id
		else
			break
		end
	end

	return current
end

--- Stage id for a planted seed, or the empty stage if the seed id is unknown.
function Growth.GetStage(seedId: string, plantedAt: number, now: number?): string
	local seed = GameConfig.GetSeed(seedId)
	if not seed then
		return GameConfig.Growth.EmptyStage
	end

	return Growth.GetStageFromProgress(Growth.GetProgress(plantedAt, seed.GrowTime, now))
end

--- Unix timestamp at which a crop planted at `plantedAt` becomes harvestable.
function Growth.GetReadyAt(seedId: string, plantedAt: number): number
	local seed = GameConfig.GetSeed(seedId)
	if not seed then
		return 0
	end

	return plantedAt + seed.GrowTime
end

--- Seconds until harvest; 0 once ready.
function Growth.GetTimeRemaining(seedId: string, plantedAt: number, now: number?): number
	local readyAt = Growth.GetReadyAt(seedId, plantedAt)
	if readyAt == 0 then
		return 0
	end

	return math.max(readyAt - (now or os.time()), 0)
end

function Growth.IsMature(stage: string): boolean
	return stage == GameConfig.Growth.MatureStage
end

--- Formats a remaining duration for UI, e.g. "2m 05s".
function Growth.FormatTimeRemaining(seconds: number): string
	seconds = math.max(math.floor(seconds), 0)

	local minutes = math.floor(seconds / 60)
	local remainder = seconds % 60

	if minutes >= 60 then
		return string.format("%dh %02dm", math.floor(minutes / 60), minutes % 60)
	end

	if minutes > 0 then
		return string.format("%dm %02ds", minutes, remainder)
	end

	return string.format("%ds", remainder)
end

return Growth
