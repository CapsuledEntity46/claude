--!nonstrict
--[[
	Buildability
	------------
	Whether a structure can be built, as pure functions over plain tables. No
	instances, no services, no yielding.

	WHY THIS IS SHARED
	------------------
	Two things ask this question and they must never disagree:

	  * the server, before it places anything,
	  * the build menu, to decide which rows are greyed out and whether
	    placement mode can continue.

	Written twice they drift, and the symptom is miserable: a row that looks
	available and is refused, or one greyed out for a reason that no longer
	applies. The client used to carry its own copy with a comment promising it
	mirrored the server's. This is that promise made structural.

	The functions return stable CODES, not sentences. Wording is presentation
	and belongs to whichever UI is asking - the server puts the code in a
	result table, the menu turns it into something a player can read.

	POSITION IS NOT HERE
	--------------------
	Nothing in this module knows where a structure is going. Overlap and world
	bounds are the placement service's business, because only it knows what is
	already standing.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local Buildability = {}

--[[
	The tech-tree rules: age, per-player limit, prerequisites.

	`counts` is structureId -> how many the player owns. A missing key counts
	as zero, so a caller may pass a sparse table.
]]
function Buildability.CheckTree(structureId: unknown, counts: { [string]: number }, age: number): (boolean, string?)
	local structure = GameConfig.GetStructure(structureId)

	if not structure then
		return false, "UnknownStructure"
	end

	if (tonumber(age) or 1) < structure.RequiredAge then
		return false, "AgeTooLow"
	end

	if (counts[structure.Id] or 0) >= structure.MaxPerPlayer then
		return false, "LimitReached"
	end

	for _, prerequisiteId in structure.Prerequisites do
		if (counts[prerequisiteId] or 0) < 1 then
			return false, "MissingPrerequisite"
		end
	end

	return true, nil
end

--[[
	Whether `held` covers the structure's cost, and the first resource it does
	not.

	TREASURY ONLY. PlayerDataService.TryPayConstruction can also draw the
	player's personal purse, but only for a cost that is gold and nothing
	else - and no structure has one, so the treasury is the whole answer. Give
	a structure a gold-only cost and this has to learn about the purse, or the
	menu will grey out something the player can actually afford.
]]
function Buildability.CheckCost(structureId: unknown, held: { [string]: number }): (boolean, string?, string?)
	local structure = GameConfig.GetStructure(structureId)

	if not structure then
		return false, "UnknownStructure", nil
	end

	-- Resource order from the directory, so the resource named as missing is
	-- the same one on both sides rather than whichever the hash reached first.
	for _, resourceId in GameConfig.GetResourceIds() do
		local needed = structure.Cost[resourceId]

		if needed and (tonumber(held[resourceId]) or 0) < needed then
			return false, "NotEnoughResources", resourceId
		end
	end

	return true, nil, nil
end

--[[
	Both checks, tree first.

	Tree before cost on purpose: "requires a Mill" is a more useful thing to
	be told than "not enough wood" when both are true, because the wood is
	temporary and the Mill is a decision.

	Returns (ok, code, resourceId?) where resourceId is set only for
	NotEnoughResources.
]]
function Buildability.Check(
	structureId: unknown,
	counts: { [string]: number },
	age: number,
	held: { [string]: number }?
): (boolean, string?, string?)
	local ok, code = Buildability.CheckTree(structureId, counts, age)

	if not ok then
		return false, code, nil
	end

	-- Omitting `held` skips affordability, which is what the server wants:
	-- it checks the cost when it takes payment, after validating position.
	if held == nil then
		return true, nil, nil
	end

	return Buildability.CheckCost(structureId, held)
end

return Buildability
