--!nonstrict
--[[
	BuildingActions
	---------------
	Which actions a selected building offers, whether each one is available
	right now, and what its state bars read. Pure, and in Shared, for the same
	reason Buildability is: **the panel and the server must reach identical
	verdicts.**

	That is the whole design. The selection panel is client-side - it has to
	be, it is a mouse and some buttons - so every verdict it renders is also
	computed on the server before the action runs. A button the panel greys
	out is a button the server would refuse, with the same reason code, and
	neither side is the authority on the rule because the rule lives here.

	WHAT THIS IS NOT
	----------------
	It is not the last line of defence. Availability is derived from the
	REPLICATED ATTRIBUTES, which are only as fresh as the last tick of the
	loop that publishes them - a crop's Stage can be one tick behind, a herd's
	produce a few seconds stale. So this answers "should the panel have
	offered this?", and the service behind the action still recomputes the
	real answer from the timestamps before granting anything.

	Three layers, each with a different job:

		BuildingActions   did the panel legitimately offer this?  (both sides)
		BuildingActionService  does this player own it, and is the action
		                       one this building has at all?      (server)
		Farm/AnimalService     is it actually true, from the timestamps?
		                       (server, authoritative)

	Returning `(ok, reason?)` rather than a boolean is deliberate and matches
	Buildability: a refusal that cannot explain itself leaves the panel with a
	dead button and no caption.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Combat = require(Shared.Combat)
local GameConfig = require(Shared.GameConfig)
local Growth = require(Shared.Growth)
local Husbandry = require(Shared.Husbandry)

local FARM_ATTR = GameConfig.FarmAttributes
local ANIMAL_ATTR = GameConfig.AnimalAttributes
local HEALTH_ATTR = GameConfig.HealthAttributes
local STRUCT_ATTR = GameConfig.StructureAttributes

local BuildingActions = {}

--------------------------------------------------------------------------------
-- Reading a building
--------------------------------------------------------------------------------

--[[
	Everything the rules below need, read off one model's attributes.

	Both sides call this with the same model - the server wrote those
	attributes, so reading them back costs nothing and guarantees the two
	sides are looking at the same numbers rather than at two derivations that
	were supposed to agree.
]]
function BuildingActions.ReadContext(model: Instance?, now: number?): { [string]: any }?
	if not model then
		return nil
	end

	local structureId = model:GetAttribute(STRUCT_ATTR.StructureId)
	local structure = GameConfig.GetStructure(structureId)

	if not structure then
		return nil
	end

	local context = {
		Now = now or os.time(),
		StructureId = structure.Id,
		InstanceId = model:GetAttribute(STRUCT_ATTR.InstanceId),
		OwnerUserId = model:GetAttribute(STRUCT_ATTR.OwnerUserId),

		MaxHealth = model:GetAttribute(HEALTH_ATTR.MaxHealth),
		HealthBase = model:GetAttribute(HEALTH_ATTR.HealthBase),
		DamagedAt = model:GetAttribute(HEALTH_ATTR.DamagedAt),
		RegenPerSecond = model:GetAttribute(HEALTH_ATTR.RegenPerSecond),
		Shattered = model:GetAttribute(HEALTH_ATTR.Shattered) == true,
	}

	if structure.HoldsCrop then
		context.SeedId = model:GetAttribute(FARM_ATTR.SeedId) or ""
		context.PlantedAt = model:GetAttribute(FARM_ATTR.PlantedAt)
		context.PlantCount = model:GetAttribute(FARM_ATTR.PlantCount) or 0
	end

	if structure.HousesLivestock then
		context.AnimalId = model:GetAttribute(ANIMAL_ATTR.AnimalId) or ""
		context.StockedAt = model:GetAttribute(ANIMAL_ATTR.StockedAt)
		context.AnimalCount = model:GetAttribute(ANIMAL_ATTR.AnimalCount) or 0
		context.FedUntil = model:GetAttribute(ANIMAL_ATTR.FedUntil) or 0
		context.LastCollectedAt = model:GetAttribute(ANIMAL_ATTR.LastCollectedAt)
	end

	return context
end

--- The actions this building offers, in their declared order.
function BuildingActions.GetActions(structureId: unknown): { string }
	local structure = GameConfig.GetStructure(structureId)

	if not structure or not structure.Actions then
		return {}
	end

	return structure.Actions
end

--- Whether `structureId` offers `actionId` at all. The question the server
--- asks before it asks anything else.
function BuildingActions.Offers(structureId: unknown, actionId: unknown): boolean
	if type(actionId) ~= "string" then
		return false
	end

	return table.find(BuildingActions.GetActions(structureId), actionId) ~= nil
end

--------------------------------------------------------------------------------
-- Choices
--------------------------------------------------------------------------------

--[[
	The item ids an action may be performed WITH, out of what the player
	holds: seeds for Plant, livestock for Stock.

	Filtered by what the building accepts, so a coop never offers a calf, and
	by level, so the panel does not list something the server will refuse.
	`held` is the player's inventory as `{ [itemId] = amount }`, which the
	client reads from its Inventory folder and the server from the profile.
]]
function BuildingActions.GetChoices(
	structureId: unknown,
	actionId: unknown,
	held: { [string]: number },
	level: number
): { string }
	local action = GameConfig.GetAction(actionId)
	local structure = GameConfig.GetStructure(structureId)
	local choices = {}

	if not action or not action.Choice or not structure then
		return choices
	end

	for itemId, amount in held do
		if amount < 1 then
			continue
		end

		local item = GameConfig.GetItem(itemId)

		if not item or item.Category ~= action.Choice then
			continue
		end

		if level < GameConfig.GetRequiredLevel(itemId) then
			continue
		end

		-- A pen only takes the species it houses; a farm takes any seed.
		if action.Choice == "Livestock" and GameConfig.GetPenCapacity(structure.Id, itemId) < 1 then
			continue
		end

		table.insert(choices, itemId)
	end

	--[[
		Cheapest first, then by id. The same order GetAvailablePlantables and
		GetAvailableAnimals use, so the panel's list and the server's fallback
		pick agree on what "the obvious one" is.
	]]
	table.sort(choices, function(a, b)
		local priceA = GameConfig.Items[a].BuyPrice or 0
		local priceB = GameConfig.Items[b].BuyPrice or 0

		if priceA == priceB then
			return a < b
		end
		return priceA < priceB
	end)

	return choices
end

--------------------------------------------------------------------------------
-- Availability
--------------------------------------------------------------------------------

local function health(context): (number, number)
	local maxHealth = tonumber(context.MaxHealth) or 0

	if maxHealth <= 0 then
		return 0, 0
	end

	local base = tonumber(context.HealthBase) or maxHealth
	local regen = tonumber(context.RegenPerSecond) or 0
	local damagedAt = tonumber(context.DamagedAt) or context.Now

	local current = math.clamp(base + regen * math.max(context.Now - damagedAt, 0), 0, maxHealth)
	return current, maxHealth
end

--[[
	One rule per action, each returning `(ok, reason?)`.

	Reason codes are the SAME strings the services fire on their refusal
	signals, so the notice the player reads when they force an action is the
	caption the panel already showed on the greyed-out button.
]]
--[[
	Whether the player can hold `totals` on top of what they already have.

	Both harvesting and collecting can be refused for a full bag by the
	service that grants them, so the rule has to be able to say so too - a
	button that promises nine carrots and refuses on press is the exact
	failure this module exists to prevent.
]]
local function hasRoomFor(held: { [string]: number }, totals: { [string]: number }): boolean
	for itemId, amount in totals do
		local item = GameConfig.GetItem(itemId)

		if not item or (held[itemId] or 0) + amount > item.MaxStack then
			return false
		end
	end

	return true
end

local RULES = {}

RULES.Plant = function(context, choices)
	if context.SeedId == nil then
		return false, "NotAFarm"
	end

	if context.SeedId ~= "" then
		return false, "Occupied"
	end

	if #choices < 1 then
		return false, "NoSeeds"
	end

	return true
end

RULES.Harvest = function(context, _choices, holdings)
	if context.SeedId == nil or context.SeedId == "" then
		return false, "Empty"
	end

	if not GameConfig.IsHarvestable(context.SeedId) then
		return false, "NotHarvestable"
	end

	if not Growth.IsMature(Growth.GetStage(context.SeedId, context.PlantedAt, context.Now)) then
		return false, "NotGrown"
	end

	--[[
		Room for the whole stack. TryHarvest refuses a full bag and leaves the
		crop in the ground, so the panel has to grey the button rather than
		promise a yield it cannot hand over.
	]]
	local plantable = GameConfig.GetPlantable(context.SeedId)
	local yield = plantable.YieldAmount * math.max(context.PlantCount or 1, 1)

	if not hasRoomFor(holdings.Items or {}, { [plantable.Yields] = yield }) then
		return false, "InventoryFull"
	end

	return true
end

RULES.Uproot = function(context)
	if context.SeedId == nil or context.SeedId == "" then
		return false, "Empty"
	end

	-- Food crops are harvested, and harvesting pays. Offering Uproot on one
	-- would be offering to throw a ripe square away.
	if GameConfig.IsHarvestable(context.SeedId) then
		return false, "Harvestable"
	end

	--[[
		DELIBERATELY NOT GATED ON MATURITY. The old prompt only offered Uproot
		once the plant had grown, which left a mis-planted square stuck until
		it finished growing something the player did not want. The roadmap
		asked for the opposite - "so a mis-planted square can be cleared
		without waiting for it to grow" - and a panel can offer it without the
		risk a shared keypress carried.
	]]
	return true
end

RULES.Stock = function(context, choices)
	if context.AnimalId == nil then
		return false, "NotAPen"
	end

	if context.AnimalId ~= "" then
		return false, "Occupied"
	end

	if #choices < 1 then
		return false, "NoLivestock"
	end

	return true
end

RULES.Feed = function(context, _choices, holdings)
	if context.AnimalId == nil or context.AnimalId == "" then
		return false, "Empty"
	end

	local animal = GameConfig.GetAnimal(context.AnimalId)

	if not animal then
		return false, "Empty"
	end

	local remaining = Husbandry.GetFeedRemaining(context.FedUntil, context.Now)

	if remaining > animal.FeedDuration * (GameConfig.Husbandry.MaxFedWindows - 1) then
		return false, "FeedFull"
	end

	--[[
		Enough feed for the WHOLE herd. Feeding is all-or-nothing, so a pen of
		six needs six - and the old prompt said `Needs Wheat x6` where this
		rule said nothing at all.
	]]
	local cost = Husbandry.GetFeedCost(context.AnimalId, context.AnimalCount)

	if ((holdings.Items or {})[animal.Feed.ItemId] or 0) < cost then
		return false, "NotEnoughFeed"
	end

	return true
end

RULES.Collect = function(context, _choices, holdings)
	if context.AnimalId == nil or context.AnimalId == "" then
		return false, "Empty"
	end

	if not GameConfig.HasProduce(context.AnimalId) then
		return false, "NoProduce"
	end

	local cycles = Husbandry.GetReadyCycles(
		context.AnimalId,
		context.StockedAt,
		context.LastCollectedAt,
		context.FedUntil,
		context.AnimalCount,
		context.Now
	)

	if cycles < 1 then
		--[[
			Three different nothings, and the player can act on exactly one of
			them, so the button's caption distinguishes them: a juvenile herd
			needs time, a hungry one needs feed, a fed grown one needs waiting.
		]]
		if not Husbandry.IsGrown(Husbandry.GetStage(context.AnimalId, context.StockedAt, context.Now)) then
			return false, "NotGrown"
		end

		if not Husbandry.IsFed(context.FedUntil, context.Now) then
			return false, "Hungry"
		end

		return false, "NothingReady"
	end

	--[[
		Room for at least one batch.

		Without this the panel advertises a payout the server refuses, which
		is exactly how the collection deadlock presented itself to a player:
		an enabled button naming a precise number of eggs, refusing on every
		press, with nothing to suggest the bag was the problem.
	]]
	if not hasRoomFor(holdings.Items or {}, Husbandry.GetProduceTotals(context.AnimalId, 1, context.AnimalCount)) then
		return false, "InventoryFull"
	end

	return true
end

RULES.Slaughter = function(context)
	if context.AnimalId == nil or context.AnimalId == "" then
		return false, "Empty"
	end

	local animal = GameConfig.GetAnimal(context.AnimalId)

	if not animal or #animal.Slaughter < 1 then
		return false, "NotSlaughterable"
	end

	if not Husbandry.IsGrown(Husbandry.GetStage(context.AnimalId, context.StockedAt, context.Now)) then
		return false, "NotGrown"
	end

	return true
end

RULES.Repair = function(context, _choices, holdings)
	local structure = GameConfig.GetStructure(context.StructureId)
	local archetype = if structure then GameConfig.GetArchetype(structure.ArchetypeId) else nil

	if not archetype or not archetype.Repairable then
		return false, "NotRepairable"
	end

	if context.Shattered then
		-- A shattered Checkpoint is rebuilt rather than repaired, and that is
		-- the defeat loop's business, not the panel's.
		return false, "Shattered"
	end

	local current, maxHealth = health(context)

	if current >= maxHealth then
		return false, "Undamaged"
	end

	--[[
		Priced, the way Buildability prices a placement. The registry charges
		for a repair and refuses when it cannot afford it, and this panel is
		the first client-reachable path to Repair - so without this the button
		was always green and the refusal always a surprise.
	]]
	local cost = Combat.GetRepairCost(archetype, maxHealth - current)

	if cost then
		local resources = holdings.Resources or {}

		for resourceId, amount in cost do
			if (resources[resourceId] or 0) < amount then
				return false, "NotEnoughResources"
			end
		end
	end

	return true
end

-- Always available on a building you own. The confirmation step is what
-- stops it being an accident.
RULES.Demolish = function()
	return true
end

--[[
	Whether `actionId` can be performed on the building `context` describes.

	`choices` is only consulted by the actions that need one, and is passed in
	rather than computed here so the caller can reuse one list for the button
	and the picker.

	`holdings` is `{ Items = {...}, Resources = {...} }` - what the player has
	to spend. Three rules price something (a harvest needs bag room, feeding
	needs feed, repairing needs resources), and without it they were greener
	than the services behind them, which is the one way this module can
	actively mislead rather than merely lag.
]]
function BuildingActions.IsAvailable(
	actionId: unknown,
	context: { [string]: any }?,
	choices: { string }?,
	holdings: { [string]: any }?
): (boolean, string?)
	if not context then
		return false, "NoBuilding"
	end

	if not BuildingActions.Offers(context.StructureId, actionId) then
		return false, "NotOffered"
	end

	local rule = RULES[actionId]

	if not rule then
		return false, "NotOffered"
	end

	return rule(context, choices or {}, holdings or {})
end

--------------------------------------------------------------------------------
-- State bars
--------------------------------------------------------------------------------

--[[
	A bar's current reading: a fraction for the fill, and a caption.

	Derived, never stored. The caption carries the thing a fraction cannot
	say - "2m 05s" rather than "0.6" - which is most of why a bar is worth
	more than a number.
]]
local READINGS = {}

READINGS.Health = function(context)
	local current, maxHealth = health(context)

	if maxHealth <= 0 then
		return nil
	end

	if context.Shattered then
		return 0, "Shattered"
	end

	return current / maxHealth, `{math.floor(current)} / {math.floor(maxHealth)}`
end

READINGS.Growth = function(context)
	if context.SeedId == nil or context.SeedId == "" then
		return 0, "Fallow"
	end

	local plantable = GameConfig.GetPlantable(context.SeedId)

	if not plantable then
		return 0, "Fallow"
	end

	local progress = Growth.GetProgress(context.PlantedAt, plantable.GrowTime, context.Now)
	local remaining = Growth.GetTimeRemaining(context.SeedId, context.PlantedAt, context.Now)

	local crop = GameConfig.GetItem(plantable.Yields)
	local name = if crop then crop.Name else context.SeedId

	if remaining <= 0 then
		return 1, `{name} x{context.PlantCount} - ready`
	end

	return progress, `{name} x{context.PlantCount} - {Growth.FormatTimeRemaining(remaining)}`
end

READINGS.Maturity = function(context)
	if context.AnimalId == nil or context.AnimalId == "" then
		return 0, "Empty"
	end

	local animal = GameConfig.GetAnimal(context.AnimalId)

	if not animal then
		return 0, "Empty"
	end

	local progress = Husbandry.GetProgress(context.StockedAt, animal.MatureTime, context.Now)
	local remaining = Husbandry.GetTimeToGrown(context.AnimalId, context.StockedAt, context.Now)

	if remaining <= 0 then
		return 1, `{animal.Name} x{context.AnimalCount} - grown`
	end

	--[[
		A hungry herd's countdown is not moving, and saying so is the whole
		reason this bar exists: "growing, 2m left" on a timer that is frozen
		is a worse lie than no bar at all.
	]]
	if not Husbandry.IsFed(context.FedUntil, context.Now) then
		return progress, `{animal.Name} x{context.AnimalCount} - growth halted, they are hungry`
	end

	return progress, `{animal.Name} x{context.AnimalCount} - {Growth.FormatTimeRemaining(remaining)}`
end

READINGS.Feed = function(context)
	if context.AnimalId == nil or context.AnimalId == "" then
		return nil
	end

	local animal = GameConfig.GetAnimal(context.AnimalId)

	if not animal then
		return nil
	end

	local remaining = Husbandry.GetFeedRemaining(context.FedUntil, context.Now)
	local ceiling = animal.FeedDuration * GameConfig.Husbandry.MaxFedWindows

	--[[
		The cost is on the bar, because the old prompt showed it
		(`Needs Wheat x6`) and the first draft of this panel dropped it - and
		"feed them" is not actionable without knowing what it takes.
	]]
	local feedItem = GameConfig.GetItem(animal.Feed.ItemId)
	local feedName = if feedItem then feedItem.Name else animal.Feed.ItemId
	local cost = `{feedName} x{Husbandry.GetFeedCost(context.AnimalId, context.AnimalCount)}`

	if remaining <= 0 then
		return 0, `HUNGRY - they stop growing and producing. Needs {cost}`
	end

	return math.clamp(remaining / ceiling, 0, 1),
		`fed for {Growth.FormatTimeRemaining(remaining)} - tops up with {cost}`
end

--[[
	Every bar this building draws, as `{ Id, Name, Colour, Fraction, Caption }`.

	A bar whose reading is nil is omitted rather than drawn empty: a pen with
	no herd has nothing to say about feed, and an empty bar invites the
	question of why it is empty.
]]
function BuildingActions.GetBars(context: { [string]: any }?): { { [string]: any } }
	local bars = {}

	if not context then
		return bars
	end

	local structure = GameConfig.GetStructure(context.StructureId)

	if not structure or not structure.Bars then
		return bars
	end

	for _, barId in structure.Bars do
		local bar = GameConfig.PanelBars[barId]
		local reading = if bar then READINGS[bar.Kind] else nil

		if reading then
			local fraction, caption = reading(context)

			if fraction ~= nil then
				table.insert(bars, {
					Id = bar.Id,
					Name = bar.Name,
					Colour = bar.Colour,
					Fraction = math.clamp(fraction, 0, 1),
					Caption = caption or "",
				})
			end
		end
	end

	return bars
end

return BuildingActions
