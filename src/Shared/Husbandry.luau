--!nonstrict
--[[
	Husbandry
	---------
	Pure maturity and produce math for a pen of livestock. The counterpart of
	Shared.Growth, and in Shared for the same reason: the server owns the real
	state, the client draws the timers, and both derive them from the same
	functions so they can never disagree.

	THE STATE OF A PEN IS FOUR NUMBERS
	----------------------------------
		StockedAt        when the herd was put in
		AnimalCount      how many
		FedUntil         when the feed runs out (a FUTURE timestamp)
		LastCollectedAt  the produce clock

	Everything a player sees is derived from those: how grown the animals are,
	whether they are fed, how many batches of produce are waiting, when the
	next one lands. Nothing accumulates, so a pen keeps working while the
	player is offline and a restart cannot lose progress.

	WHY PRODUCE IS COUNTED IN WHOLE CYCLES
	--------------------------------------
	`GetReadyCycles` returns an integer, and collecting ADVANCES
	LastCollectedAt by exactly the cycles paid rather than setting it to now.
	That is what makes the payout exact: the remainder of a part-finished
	cycle stays on the clock instead of being rounded away, and a player who
	collects every few seconds is paid the same as one who collects once.

	It is also why the payout can be derived from a timestamp at all. Maturity
	can be re-derived harmlessly - it is a fact about the herd - but produce is
	a GRANT, and a grant that re-derives is a grant that pays twice. The
	consumed-exactly-once property lives in the advance, not in a flag.

	WHY THE WINDOW IS CLAMPED TO THE FEED
	-------------------------------------
	Produce accrues only over time the herd was fed, so the window ends at
	`min(now, FedUntil)`. An unfed herd stops paying - that is the whole
	cadence of the mechanic - and because feeding can only be stacked a couple
	of windows deep, offline production is bounded without a separate cap.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local Husbandry = {}

--------------------------------------------------------------------------------
-- Maturity
--------------------------------------------------------------------------------

--- Fraction of the maturity time elapsed, clamped to [0, 1].
function Husbandry.GetProgress(stockedAt: number, matureTime: number, now: number?): number
	if matureTime <= 0 then
		return 1
	end

	local elapsed = (now or os.time()) - stockedAt
	return math.clamp(elapsed / matureTime, 0, 1)
end

--- Maps a [0, 1] progress value onto a maturity stage id.
function Husbandry.GetStageFromProgress(progress: number): string
	local stages = GameConfig.Husbandry.Stages
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

--- Maturity stage for a stocked animal, or the empty stage for an unknown one.
function Husbandry.GetStage(stockId: string, stockedAt: number, now: number?): string
	local animal = GameConfig.GetAnimal(stockId)
	if not animal then
		return GameConfig.Husbandry.EmptyStage
	end

	return Husbandry.GetStageFromProgress(Husbandry.GetProgress(stockedAt, animal.MatureTime, now))
end

--- Unix timestamp at which a herd stocked at `stockedAt` is fully grown.
function Husbandry.GetGrownAt(stockId: string, stockedAt: number): number
	local animal = GameConfig.GetAnimal(stockId)
	if not animal then
		return 0
	end

	return stockedAt + animal.MatureTime
end

--- Seconds until the herd is grown; 0 once it is.
function Husbandry.GetTimeToGrown(stockId: string, stockedAt: number, now: number?): number
	local grownAt = Husbandry.GetGrownAt(stockId, stockedAt)
	if grownAt == 0 then
		return 0
	end

	return math.max(grownAt - (now or os.time()), 0)
end

function Husbandry.IsGrown(stage: string): boolean
	return stage == GameConfig.Husbandry.GrownStage
end

--------------------------------------------------------------------------------
-- Feed
--------------------------------------------------------------------------------

function Husbandry.IsFed(fedUntil: number?, now: number?): boolean
	return (tonumber(fedUntil) or 0) > (now or os.time())
end

--- Seconds of feed left; 0 when the herd is hungry.
function Husbandry.GetFeedRemaining(fedUntil: number?, now: number?): number
	return math.max((tonumber(fedUntil) or 0) - (now or os.time()), 0)
end

--- The furthest ahead a pen may be fed, so stacking feed has a ceiling.
function Husbandry.GetFeedCeiling(stockId: string, now: number): number
	local animal = GameConfig.GetAnimal(stockId)
	if not animal then
		return now
	end

	return now + animal.FeedDuration * GameConfig.Husbandry.MaxFedWindows
end

--[[
	What one feeding costs: the per-animal amount times the herd.

	Priced by headcount rather than per pen, so a bigger flock is a bigger
	commitment and not just a bigger payout.
]]
function Husbandry.GetFeedCost(stockId: string, count: number): number
	local animal = GameConfig.GetAnimal(stockId)
	if not animal then
		return 0
	end

	return animal.Feed.Amount * math.max(math.floor(count), 0)
end

--------------------------------------------------------------------------------
-- Produce
--------------------------------------------------------------------------------

--[[
	When the current produce clock starts.

	The later of "last collected" and "finished growing", because a juvenile
	herd produces nothing - without the second term, a herd stocked an hour
	before it matured would pay out that hour the moment it grew up.
]]
function Husbandry.GetWindowStart(stockId: string, stockedAt: number, lastCollectedAt: number?): number
	return math.max(tonumber(lastCollectedAt) or stockedAt, Husbandry.GetGrownAt(stockId, stockedAt))
end

--[[
	How many whole batches of produce are waiting.

	Zero for an animal that produces nothing periodically, for a herd that is
	not grown yet, and for one whose feed ran out before the next batch was
	due. Never negative.
]]
function Husbandry.GetReadyCycles(
	stockId: string,
	stockedAt: number,
	lastCollectedAt: number?,
	fedUntil: number?,
	count: number?,
	now: number?
): number
	local animal = GameConfig.GetAnimal(stockId)

	if not animal or not GameConfig.HasProduce(stockId) then
		return 0
	end

	if (tonumber(count) or 0) < 1 then
		return 0
	end

	local at = now or os.time()

	-- The window ends where the FEED ends, which is what makes neglect stop
	-- the payout rather than merely delay it.
	local windowEnd = math.min(at, tonumber(fedUntil) or 0)
	local windowStart = Husbandry.GetWindowStart(stockId, stockedAt, lastCollectedAt)

	if windowEnd <= windowStart then
		return 0
	end

	--[[
		Capped, and the cap costs nothing: collecting advances the clock by the
		batches PAID, so a capped collection leaves the rest on the clock for
		the next press rather than discarding it.

		The cap is here rather than at the call site because this is the
		function the client derives its display from too - a prompt promising
		a number this large is a bug of its own - and because a corrupt or
		clock-skewed profile can present a window decades wide.
	]]
	return math.min(
		math.floor((windowEnd - windowStart) / animal.ProduceInterval),
		GameConfig.Husbandry.MaxStoredCycles
	)
end

--[[
	Where the produce clock sits after collecting `cycles` batches.

	Advanced by the cycles PAID, not set to now, so the part-finished cycle
	the player has already waited through is not thrown away by collecting
	early. See the header.
]]
function Husbandry.AdvanceClock(stockId: string, stockedAt: number, lastCollectedAt: number?, cycles: number): number
	local animal = GameConfig.GetAnimal(stockId)
	local start = Husbandry.GetWindowStart(stockId, stockedAt, lastCollectedAt)

	if not animal or not animal.ProduceInterval or cycles <= 0 then
		return start
	end

	return start + math.floor(cycles) * animal.ProduceInterval
end

--[[
	When the next batch lands, or nil if none ever will.

	Nil covers three different "never": the animal has no periodic produce,
	the pen is empty, and the herd is out of feed - that last one being a
	state the player can fix, which is why the prompt says so rather than
	showing a countdown that would not move.
]]
function Husbandry.GetNextProduceAt(
	stockId: string,
	stockedAt: number,
	lastCollectedAt: number?,
	fedUntil: number?,
	count: number?,
	now: number?
): number?
	local animal = GameConfig.GetAnimal(stockId)

	if not animal or not GameConfig.HasProduce(stockId) or (tonumber(count) or 0) < 1 then
		return nil
	end

	local at = now or os.time()
	local cycles = Husbandry.GetReadyCycles(stockId, stockedAt, lastCollectedAt, fedUntil, count, at)
	local nextAt = Husbandry.AdvanceClock(stockId, stockedAt, lastCollectedAt, cycles) + animal.ProduceInterval

	-- Beyond the feed, there is no next batch until the player feeds again.
	if nextAt > (tonumber(fedUntil) or 0) then
		return nil
	end

	return nextAt
end

--- Total items one collection would hand over, as item id -> amount.
function Husbandry.GetProduceTotals(stockId: string, cycles: number, count: number): { [string]: number }
	local animal = GameConfig.GetAnimal(stockId)
	local totals = {}

	if not animal or cycles <= 0 or count <= 0 then
		return totals
	end

	for _, yield in animal.Produces do
		totals[yield.ItemId] = (totals[yield.ItemId] or 0) + yield.Amount * cycles * count
	end

	return totals
end

--- Total items slaughtering a herd of `count` would hand over. Summed rather
--- than assigned, because two entries may name the same item.
function Husbandry.GetSlaughterTotals(stockId: string, count: number): { [string]: number }
	local animal = GameConfig.GetAnimal(stockId)
	local totals = {}

	if not animal or count <= 0 then
		return totals
	end

	for _, yield in animal.Slaughter do
		totals[yield.ItemId] = (totals[yield.ItemId] or 0) + yield.Amount * count
	end

	return totals
end

return Husbandry
