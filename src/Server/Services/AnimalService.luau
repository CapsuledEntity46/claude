--!nonstrict
--[[
	AnimalService
	-------------
	Raising livestock in PLACED PENS: stocking, growing, feeding, collecting
	produce and slaughtering.

	The sibling of FarmService, and built the same way on purpose. A pen is to
	a coop what a farm square is to a crop: a structure the player chose to
	build, that holds a stack of ONE kind of thing, whose state is derived from
	timestamps on its own structure entry. Almost every decision here is
	FarmService's decision, re-applied - which is the point. If husbandry had
	needed a new growth model, a new persistence shape or a new interaction
	rule, that would have been evidence the first one was wrong.

	WHAT STATE LIVES WHERE
	----------------------
	Herd state is stored ON the pen's structure entry in `data.Structures`:

		AnimalId         livestock item id, "" when the pen is empty
		StockedAt        when the herd went in - maturity derives from this
		AnimalCount      how many
		FedUntil         when the feed runs out (a FUTURE timestamp)
		LastCollectedAt  the produce clock
		HerdHealth       mirrored from the damageable registry
		HerdDamagedAt

	One record per pen, so demolishing a pen takes its herd with it and there
	is no way to orphan a herd whose pen no longer exists.

	ENTITY LAYOUT
	-------------
		Coop (Model)             structure entity - health, repairable
		└── Herd (Model)         herd entity - health, regenerates
		    ├── Chick1 (Model)   rebuilt per maturity stage
		    └── Chick2..N        laid out on a grid across the footprint
		└── Body
		    └── Manage           ProximityPrompt - opens the panel

	FOUR ACTIONS, NO PROMPTS
	------------------------
	A pen has four actions and a ProximityPrompt has one gesture. This service
	first tried to live inside that: a contextual prompt offering whichever of
	stock/feed/collect looked most useful, plus a second prompt on a second
	key, held rather than tapped, for slaughtering - and the two drew on top of
	each other until a pixel offset pulled them apart. Even then the pen could
	not offer a CHOICE of animal.

	The four actions are now buttons in the selection panel, reached through
	BuildingActionService. This service never hears about the panel: it exposes
	TryStock/TryFeed/TryCollect/TrySlaughter, each validating its own rules,
	and the panel is one of several things that may call them. The pen's single
	remaining prompt opens the menu and does nothing else.

	THE ONE NEW RULE: FEED
	----------------------
	Crops need nothing after planting. Livestock need feeding, and that is the
	only mechanically new idea here:

	  * produce accrues only over time the herd was FED,
	  * feed can be stacked at most MaxFedWindows deep, which bounds offline
	    production without a separate cap,
	  * and an unfed herd STARVES - it loses health through the ordinary
	    damageable registry and dies if ignored.

	Starvation is what makes feeding matter for an animal with no periodic
	produce. A pig is raised for meat, maturity is derived from StockedAt, and
	it arrives whether or not anybody turned up with a bucket - so without
	hunger having teeth, feeding a pig would be a cost with no consequence for
	skipping it.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Growth = require(Shared.Growth)
local Husbandry = require(Shared.Husbandry)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local AttackService = require(script.Parent.Parent.Combat.AttackService)
local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local PlacementService = require(script.Parent.Parent.World.PlacementService)
local PlayerDataService = require(script.Parent.PlayerDataService)
local AnimalFactory = require(script.Parent.Parent.Pens.AnimalFactory)
local StructureBuilder = require(script.Parent.Parent.World.StructureBuilder)

local ANIMAL_ATTR = GameConfig.AnimalAttributes
local EMPTY_STAGE = GameConfig.Husbandry.EmptyStage
local HERD_CONTAINER = "Herd"

--- Fraction of the pen footprint the animals stand across, so the outer ones
--- are inside the walls rather than hanging over the edge.
local ANIMAL_SPAN_FRACTION = 0.7

--[[
	Every archetype that is a HERD rather than a building, derived from the
	config rather than listed here.

	The damageable registry is shared by crops, buildings, raiders and herds,
	and this service must ignore the other three. FarmService can compare
	against the single literal "Crop"; husbandry has one archetype per
	species, so the set is built once at require time and a new animal joins
	it by existing.
]]
local HERD_ARCHETYPES: { [string]: true } = {}

for _, animal in GameConfig.Animals do
	HERD_ARCHETYPES[animal.ArchetypeId] = true
end

--[[
	How many animals are in the pen. Zero when empty.

	An occupied pen with no count reads as ONE, never as zero, for the same
	reason a planted square does: read as zero and the pen would render empty,
	produce nothing and slaughter for nothing, which looks like the herd was
	stolen rather than like a missing default. Normalize guarantees the field
	for anything loaded from a profile, so this is the backstop for any path
	that did not come through it.
]]
local function herdCount(entry): number
	if not entry.AnimalId or entry.AnimalId == "" then
		return 0
	end

	return math.max(math.floor(tonumber(entry.AnimalCount) or 1), 1)
end

local AnimalService = {}

AnimalService.FrameworkVersion = 15

AnimalService._started = false
AnimalService._pens = {} :: { [Player]: any }
AnimalService._lastInteraction = {} :: { [Player]: number }

--- (player, instanceId, stockId, count)
AnimalService.Stocked = Signal.new()
--- (player, instanceId, stockId, fedUntil)
AnimalService.Fed = Signal.new()
--- (player, instanceId, stockId, totals, cycles)
AnimalService.Collected = Signal.new()
--- (player, instanceId, stockId, totals, count)
AnimalService.Slaughtered = Signal.new()
--- (player, instanceId, stockId) - the feed ran out; fires once per spell
AnimalService.HerdHungry = Signal.new()
--- (player, instanceId, stockId) - the herd died, by starvation or by raid
AnimalService.HerdLost = Signal.new()
--- (player, instanceId, reason)
AnimalService.ActionFailed = Signal.new()

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

function AnimalService:_consumeInteraction(player: Player): boolean
	local now = os.clock()
	local last = self._lastInteraction[player]

	if last and now - last < GameConfig.Interaction.Cooldown then
		return false
	end

	self._lastInteraction[player] = now
	return true
end

--[[
	Announces a refusal AND returns it, for the same reason FarmService does:
	the notice turns it into a sentence, the panel captions a button with it,
	and Signal:Fire is asynchronous so the reason cannot be observed.
]]
function AnimalService:_refuse(player: Player, instanceId: string, reason: string): (boolean, string)
	self.ActionFailed:Fire(player, instanceId, reason)
	return false, reason
end

function AnimalService:_getPens(player: Player)
	return self._pens[player] or {}
end

function AnimalService:GetPen(player: Player, instanceId: string)
	return self:_getPens(player)[instanceId]
end

--- The herd record on a pen, or nil when the structure is not a pen.
function AnimalService:_getEntry(player: Player, instanceId: string)
	local data = PlayerDataService:GetData(player)
	local entry = if data then data.Structures[instanceId] else nil

	if not entry then
		return nil
	end

	local structure = GameConfig.GetStructure(entry.StructureId)

	if structure and structure.HousesLivestock then
		return entry
	end

	return nil
end

--[[
	Whether the player can hold everything in `totals`.

	Checked for the WHOLE payout before any of it is granted, because a
	part-granted collection is unrecoverable: the produce clock must advance
	exactly once, so granting two items out of three and refusing to advance
	would pay the first two again on the next press. ShopService computes its
	headroom the same way and for the same reason.
]]
local function canHoldAll(player: Player, totals: { [string]: number }): boolean
	for itemId, amount in totals do
		local item = GameConfig.GetItem(itemId)

		if not item then
			return false
		end

		if PlayerDataService:GetItemCount(player, itemId) + amount > item.MaxStack then
			return false
		end
	end

	return true
end

--[[
	The largest number of whole batches the player can actually hold, up to
	`cycles`.

	THIS EXISTS TO PREVENT A DEADLOCK, and the deadlock is worth recording
	because all three ingredients were individually correct. Produce accrues
	without limit for a herd that is kept fed. The payout was all-or-nothing,
	because a part-granted payout cannot advance the clock exactly once. And a
	refused collection leaves the clock untouched, so the pending total only
	ever grew. Past a stack limit the collection could therefore never
	succeed, never shrink, and TrySlaughter - which collects first - could not
	empty the pen either. The pen was unrecoverable without demolishing the
	building, and the prompt went on advertising the eggs the whole time.

	Paying the batches that FIT keeps the grant exact, because the clock still
	advances by precisely what was paid, and the remainder simply waits for
	the next press. The atomicity argument for all-or-nothing applies to the
	ITEMS within one batch, not to the number of batches.
]]
local function cyclesThatFit(player: Player, stockId: string, cycles: number, count: number): number
	if cycles < 1 or count < 1 then
		return 0
	end

	local affordable = cycles

	-- Totalled for ONE cycle first, so two entries naming the same item are
	-- summed rather than each measured against the same headroom.
	for itemId, perCycle in Husbandry.GetProduceTotals(stockId, 1, count) do
		local item = GameConfig.GetItem(itemId)

		if not item then
			return 0
		end

		if perCycle > 0 then
			local headroom = item.MaxStack - PlayerDataService:GetItemCount(player, itemId)
			affordable = math.min(affordable, math.floor(headroom / perCycle))
		end
	end

	return math.max(affordable, 0)
end

--[[
	Clears every herd field on a pen's entry.

	One function because the paths that empty a pen had drifted: two of them
	cleared AnimalId and left five stale timestamps behind. Nothing reads them
	while AnimalId is empty, which is exactly why the drift was invisible and
	why it would stop being harmless the moment a new path trusted FedUntil
	without checking AnimalId first.
]]
local function clearHerd(entry)
	entry.AnimalId = ""
	entry.StockedAt = nil
	entry.AnimalCount = nil
	entry.FedUntil = nil
	entry.LastCollectedAt = nil
	entry.HungryChargedTo = nil
	entry.HerdHealth = nil
	entry.HerdDamagedAt = nil
end

--------------------------------------------------------------------------------
-- Projection
--------------------------------------------------------------------------------

--[[
	Rebuilds the herd visual for the current stage, keeping the Herd container
	so the herd entity's model reference and health attributes stay valid.
]]
function AnimalService:_renderHerd(pen, stockId: string, stage: string, count: number)
	local container = pen.Model:FindFirstChild(HERD_CONTAINER)

	if stage == EMPTY_STAGE or stockId == "" or count < 1 then
		if container then
			container:Destroy()
		end
		return nil
	end

	if not container then
		container = Instance.new("Model")
		container.Name = HERD_CONTAINER
		container.Parent = pen.Model
	end

	--[[
		The animals are rebuilt, the CONTAINER is not: it is the herd entity's
		model reference and carries the health attributes, so destroying it
		would leave the damageable registry pointing at nothing.

		PrimaryPart is cleared with them, because it points at one of the
		animals and leaving it pointing at a destroyed one survives every
		check that asks whether the MODEL is still parented.
	]]
	for _, child in container:GetChildren() do
		child:Destroy()
	end

	container.PrimaryPart = nil

	local structure = GameConfig.GetStructure(pen.StructureId)
	local animal = GameConfig.GetAnimal(stockId)

	if not structure or not animal or not pen.Model.PrimaryPart then
		return container
	end

	local size = GameConfig.GetAnimalSize(animal.AnimalSize)
	local centre = pen.Model.PrimaryPart.Position + Vector3.new(0, structure.Size.Y / 2, 0)

	local slots = AnimalFactory.GetSlotPositions(
		GameConfig.GetPenCapacity(pen.StructureId, stockId),
		centre,
		structure.Size.X * ANIMAL_SPAN_FRACTION,
		structure.Size.Z * ANIMAL_SPAN_FRACTION
	)

	for index = 1, math.min(count, #slots) do
		local model = AnimalFactory.Create(stockId, stage, slots[index], if size then size.VisualScale else 1)

		if model then
			model.Name = `{stockId}{index}`
			model.Parent = container

			--[[
				The container needs a PrimaryPart, and this is the only place
				it can get one. Without it the herd has no position - so the
				client draws no health bar over it, and a raider has nothing
				to aim at.
			]]
			if not container.PrimaryPart then
				container.PrimaryPart = model.PrimaryPart
			end
		end
	end

	return container
end

function AnimalService:_projectHerd(player: Player, pen, entry, now: number)
	local stage = Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)
	local count = herdCount(entry)

	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalId, entry.AnimalId)
	pen.Model:SetAttribute(ANIMAL_ATTR.StockedAt, entry.StockedAt)
	pen.Model:SetAttribute(ANIMAL_ATTR.GrownAt, Husbandry.GetGrownAt(entry.AnimalId, entry.StockedAt))
	pen.Model:SetAttribute(ANIMAL_ATTR.Stage, stage)
	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalCount, count)
	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalCapacity, GameConfig.GetPenCapacity(pen.StructureId, entry.AnimalId))
	pen.Model:SetAttribute(ANIMAL_ATTR.FedUntil, tonumber(entry.FedUntil) or 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.LastCollectedAt, tonumber(entry.LastCollectedAt) or entry.StockedAt)

	local container = self:_renderHerd(pen, entry.AnimalId, stage, count)

	--[[
		The herd is its own damageable entity, separate from the pen it lives
		in: it regenerates and cannot be repaired, whereas the pen must be
		repaired with resources and never heals itself.

		ONE entity for the whole herd, as a farm square has one crop entity
		for its whole stack. Density therefore concentrates risk - a raider
		that reaches a full coop takes the flock - which is the same trade the
		farm makes, and is why the archetype's health is per PEN rather than
		per animal.
	]]
	--[[
		No container means there is nothing for the herd entity to point at,
		so it must not stay registered. Only reachable by removing an animal
		from the config mid-session, but a registry entry whose model has been
		destroyed reports a live herd forever.
	]]
	if not container and pen.HerdEntityId then
		AttackService:Unregister(pen.HerdEntityId)
		DamageableService:Unregister(pen.HerdEntityId)
		pen.HerdEntityId = nil
	end

	if container and not pen.HerdEntityId then
		local animal = GameConfig.GetAnimal(entry.AnimalId)

		pen.HerdEntityId = DamageableService:Register({
			ArchetypeId = if animal then animal.ArchetypeId else nil,
			Model = container,
			OwnerUserId = player.UserId,
			State = if entry.HerdHealth then { Health = entry.HerdHealth, DamagedAt = entry.HerdDamagedAt } else nil,
		})

		--[[
			Declines for anything without an attack, which is every animal
			there is - so this costs nothing today and is the reason a guard
			animal would later be an archetype plus an attack profile rather
			than a new system. Exactly how the Watch Tower got its behaviour.
		]]
		if pen.HerdEntityId then
			AttackService:Register(pen.HerdEntityId)
		end
	end

	if pen.HerdEntityId then
		AttackService:SetSuspended(pen.HerdEntityId, not Husbandry.IsGrown(stage))
	end

	self:_refreshPrompts(player, pen)
end

function AnimalService:_projectEmpty(player: Player, pen)
	if pen.HerdEntityId then
		AttackService:Unregister(pen.HerdEntityId)
		DamageableService:Unregister(pen.HerdEntityId)
		pen.HerdEntityId = nil
	end

	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalId, "")
	pen.Model:SetAttribute(ANIMAL_ATTR.StockedAt, 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.GrownAt, 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.Stage, EMPTY_STAGE)
	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalCount, 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.AnimalCapacity, 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.FedUntil, 0)
	pen.Model:SetAttribute(ANIMAL_ATTR.LastCollectedAt, 0)

	self:_renderHerd(pen, "", EMPTY_STAGE, 0)
	self:_refreshPrompts(player, pen)
end

--------------------------------------------------------------------------------
-- What the pen says about itself
--------------------------------------------------------------------------------

--[[
	Puts the herd's state on the pen's name plate.

	Reported from play as "the animals only get hungry and fed once, after
	that there is no starvation, but the feed button still appears". The
	mechanic was working - a test runs three hunger/feed cycles and checks
	each one announces itself and costs health - but there was no way to SEE
	it, and a rule nobody can see is a rule nobody believes.

	The plate survived the move to the selection panel because it answers a
	question the panel cannot: "which of my six pens needs me?", from across
	the base, without selecting anything. Quantised to whole minutes, since
	this text replicates.
]]
function AnimalService:_refreshLabel(pen, entry, now: number)
	local body = pen.Model.PrimaryPart
	local billboard = if body then body:FindFirstChild(StructureBuilder.LabelName) else nil
	local title = if billboard then billboard:FindFirstChild(StructureBuilder.TitleName) else nil

	if not title then
		return
	end

	local structure = GameConfig.GetStructure(pen.StructureId)
	local text = if structure then structure.Name else pen.StructureId

	if entry and entry.AnimalId and entry.AnimalId ~= "" then
		if Husbandry.IsFed(entry.FedUntil, now) then
			local minutes = math.max(math.ceil(Husbandry.GetFeedRemaining(entry.FedUntil, now) / 60), 1)
			text = `{text} - fed {minutes}m`
		else
			text = `{text} - HUNGRY`
		end
	end

	if title.Text ~= text then
		title.Text = text
	end
end

--[[
	Refreshes the name plate and the pen's single prompt.

	The prompt no longer DOES anything - it opens the panel - so its text is
	a glanceable summary rather than an offer. What used to live here was the
	contextual logic that decided between stock, feed and collect, plus a
	second prompt on a second key for slaughtering, plus the pixel offset that
	stopped the two drawing on top of each other. All of it is now the panel's
	job, and the panel can show four actions at once instead of guessing which
	one you meant.
]]
function AnimalService:_refreshPrompts(player: Player, pen)
	local entry = self:_getEntry(player, pen.InstanceId)
	local now = os.time()

	self:_refreshLabel(pen, entry, now)

	local body = pen.Model.PrimaryPart
	local prompt = body and body:FindFirstChild(GameConfig.Selection.PromptName)

	if not prompt then
		return
	end

	local structure = GameConfig.GetStructure(pen.StructureId)
	local text = if structure then structure.Name else pen.StructureId

	if entry and entry.AnimalId and entry.AnimalId ~= "" then
		local animal = GameConfig.GetAnimal(entry.AnimalId)
		local count = herdCount(entry)
		local name = if animal then animal.Name else entry.AnimalId

		if not Husbandry.IsFed(entry.FedUntil, now) then
			text = `{name} x{count} - HUNGRY`
		elseif Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
			text = `{name} x{count} - grown`
		else
			text = `{name} x{count} - growing`
		end
	else
		text = `{text} - empty`
	end

	-- Only written when it changes: the tick walks every pen of every player,
	-- and a prompt property write replicates.
	if prompt.ObjectText ~= text then
		prompt.ObjectText = text
	end
end

function AnimalService:_refreshAll(player: Player)
	for _, pen in self:_getPens(player) do
		self:_refreshPrompts(player, pen)
	end
end

--------------------------------------------------------------------------------
-- Livestock selection
--------------------------------------------------------------------------------

--[[
	Which animal a stock action will use for a pen of `structureId`: the
	explicit selection when it is valid, housed HERE and in stock, otherwise
	the cheapest eligible animal owned.

	Iterates the animal directory rather than the inventory, so the result
	never depends on inventory key order - and filters on the PEN, so pressing
	E on a coop can never try to put a cow in it.
]]
function AnimalService:_resolveStockId(player: Player, structureId: string, chosenStockId: string?): string?
	local level = PlayerDataService:GetLevel(player)

	--[[
		An explicit choice outranks the stored selection, held to the same
		three conditions: housed in THIS pen, past the level gate, and owned.
	]]
	local chosen = GameConfig.GetAnimal(chosenStockId)

	if
		chosen
		and chosen.HousedIn == structureId
		and level >= chosen.RequiredLevel
		and PlayerDataService:HasItem(player, chosen.StockId, 1)
	then
		return chosen.StockId
	end

	local selected = player:GetAttribute(GameConfig.Attributes.SelectedStock)
	local selectedAnimal = GameConfig.GetAnimal(selected)

	if
		selectedAnimal
		and selectedAnimal.HousedIn == structureId
		and level >= selectedAnimal.RequiredLevel
		and PlayerDataService:HasItem(player, selectedAnimal.StockId, 1)
	then
		return selectedAnimal.StockId
	end

	local bestId, bestPrice = nil, nil

	for _, animal in GameConfig.GetAvailableAnimals(level) do
		if animal.HousedIn == structureId and PlayerDataService:HasItem(player, animal.StockId, 1) then
			local price = GameConfig.Items[animal.StockId].BuyPrice or 0
			local isBetter = bestPrice == nil or price < bestPrice or (price == bestPrice and animal.StockId < bestId)

			if isBetter then
				bestId, bestPrice = animal.StockId, price
			end
		end
	end

	return bestId
end

--------------------------------------------------------------------------------
-- The four actions
--------------------------------------------------------------------------------

--[[
	Puts a herd in an empty pen.

	Fills the pen in ONE action and then commits, exactly as planting a square
	does, and for the same reason: topping up a growing herd would mean either
	keeping StockedAt (stock one chick, wait until it is nearly grown, add
	five more and slaughter six fully-grown chickens) or resetting it (adding
	a sixth chick throws away five nearly-grown ones). The first is a
	duplication exploit and the second reads as a bug.

	The herd ARRIVES FED, for Husbandry.StockingGrace. That is a deliberate
	gift to the opening: a pen that began starving the instant it was stocked
	would punish a player for not already knowing the mechanic.

	A full FEED WINDOW of grace was the first attempt, and it quietly disabled
	the feature. A pig's FeedDuration is longer than its MatureTime, so the
	grace covered the whole raise and a barn could be taken to slaughter
	having never been fed once - the exact outcome starvation exists to
	prevent. The grace is now a short fixed span, asserted in config to be
	shorter than the fastest animal's MatureTime.
]]
--- `chosenStockId` is the selection panel's explicit pick. Nil means "decide
--- for me", which is what the prompt used to do.
function AnimalService:TryStock(player: Player, instanceId: string, chosenStockId: string?): boolean
	local entry = self:_getEntry(player, instanceId)
	local pen = self:GetPen(player, instanceId)

	if not entry or not pen then
		return false
	end

	if entry.AnimalId and entry.AnimalId ~= "" then
		return self:_refuse(player, instanceId, "Occupied")
	end

	-- An explicit pick is still validated here; "the panel offered it" is not
	-- a validation, and it takes the same path as a resolved one.
	local stockId = self:_resolveStockId(player, pen.StructureId, chosenStockId)
	if not stockId then
		return self:_refuse(player, instanceId, "NoLivestock")
	end

	local animal = GameConfig.GetAnimal(stockId)
	if not animal or PlayerDataService:GetLevel(player) < animal.RequiredLevel then
		return self:_refuse(player, instanceId, "LevelTooLow")
	end

	local capacity = GameConfig.GetPenCapacity(pen.StructureId, stockId)
	if capacity < 1 then
		return self:_refuse(player, instanceId, "WrongPen")
	end

	-- As many as fit, or as many as are held. Stocking a part-full pen is
	-- allowed rather than refused; it just cannot be topped up later.
	local count = math.min(capacity, PlayerDataService:GetItemCount(player, stockId))

	if count < 1 then
		return self:_refuse(player, instanceId, "NoLivestock")
	end

	-- Atomic: the livestock is consumed before the herd exists, so a spammed
	-- prompt cannot stock two pens from one batch.
	if not PlayerDataService:RemoveItem(player, stockId, count) then
		return self:_refuse(player, instanceId, "NoLivestock")
	end

	local now = os.time()

	entry.AnimalId = stockId
	entry.StockedAt = now
	entry.AnimalCount = count
	entry.FedUntil = now + GameConfig.Husbandry.StockingGrace
	entry.LastCollectedAt = now
	entry.HungryChargedTo = nil
	entry.HerdHealth = nil
	entry.HerdDamagedAt = nil

	PlayerDataService:IncrementStat(player, "TotalAnimalsRaised", count)

	pen.HungryNoticed = false

	self:_projectHerd(player, pen, entry, now)
	self.Stocked:Fire(player, instanceId, stockId, count)

	return true
end

--[[
	Feeds the herd, extending the fed clock by one window.

	Extends rather than resets, so feeding early is never a waste, and is
	capped at MaxFedWindows so it cannot be stacked indefinitely - that cap is
	what bounds offline production.
]]
function AnimalService:TryFeed(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local pen = self:GetPen(player, instanceId)

	if not entry or not pen or not entry.AnimalId or entry.AnimalId == "" then
		return false
	end

	local animal = GameConfig.GetAnimal(entry.AnimalId)
	if not animal then
		return false
	end

	local now = os.time()

	--[[
		Settle whatever they have already gone hungry for, before anything
		else. It is time that passed whether or not this feeding succeeds, and
		charging it here rather than afterwards is what stops a feeding from
		retroactively paying for the gap.

		It can also kill them - a herd left long enough does not get to be
		rescued - in which case there is nothing left to feed.
	]]
	self:_settleHunger(player, pen, entry, now)

	if not entry.AnimalId or entry.AnimalId == "" then
		return false
	end

	local fedUntil = tonumber(entry.FedUntil) or 0
	local count = herdCount(entry)

	if Husbandry.GetFeedRemaining(fedUntil, now) > animal.FeedDuration * (GameConfig.Husbandry.MaxFedWindows - 1) then
		return self:_refuse(player, instanceId, "FeedFull")
	end

	local cost = Husbandry.GetFeedCost(entry.AnimalId, count)

	-- Atomic, and before any timestamp moves: a refused feed must leave the
	-- pen exactly as it was.
	if not PlayerDataService:RemoveItem(player, animal.Feed.ItemId, cost) then
		return self:_refuse(player, instanceId, "NotEnoughFeed")
	end

	--[[
		Push the produce clock past the hungry stretch, BEFORE extending the
		feed window.

		This is the one moment it is needed. While the herd was hungry the
		window ended at the old FedUntil, so the gap paid nothing on its own -
		but extending FedUntil past `now` makes the whole span productive
		again, gap included, which is a feed-once-a-day exploit.

		Pushed from the EFFECTIVE window start rather than the raw
		LastCollectedAt, because the two differ whenever maturity is the later
		of the pair, and pushing the raw value would be absorbed by that clamp
		and credit the gap after all.
	]]
	local starved = math.max(now - fedUntil, 0)

	if starved > 0 then
		local clock = Husbandry.GetWindowStart(entry.AnimalId, entry.StockedAt, entry.LastCollectedAt)
		entry.LastCollectedAt = math.min(clock + starved, now)
	end

	entry.FedUntil = math.min(
		math.max(now, fedUntil) + animal.FeedDuration,
		Husbandry.GetFeedCeiling(entry.AnimalId, now)
	)

	-- The hungry spell is over, so the next one is worth announcing again.
	pen.HungryNoticed = false
	entry.HungryChargedTo = nil

	self:_projectHerd(player, pen, entry, now)
	self.Fed:Fire(player, instanceId, entry.AnimalId, entry.FedUntil)

	return true
end

--[[
	Collects every whole batch of produce the herd has earned.

	The produce clock is advanced by the batches PAID rather than set to now,
	so collecting early does not throw away a part-finished cycle, and so the
	grant is consumed exactly once. Produce is the one thing here that is a
	GRANT rather than a fact, and a grant derived from a timestamp pays twice
	unless the timestamp moves - which is why maturity can be re-derived
	freely and this cannot.
]]
function AnimalService:TryCollect(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local pen = self:GetPen(player, instanceId)

	if not entry or not pen or not entry.AnimalId or entry.AnimalId == "" then
		return false
	end

	local animal = GameConfig.GetAnimal(entry.AnimalId)

	if not animal then
		-- The animal left the config; free the pen rather than trapping it.
		clearHerd(entry)
		self:_projectEmpty(player, pen)
		return false
	end

	if not GameConfig.HasProduce(entry.AnimalId) then
		return self:_refuse(player, instanceId, "NoProduce")
	end

	local now = os.time()
	local count = herdCount(entry)

	-- Recomputed from the timestamps, not read from an attribute, which is
	-- only as fresh as the last tick.
	local cycles =
		Husbandry.GetReadyCycles(entry.AnimalId, entry.StockedAt, entry.LastCollectedAt, entry.FedUntil, count, now)

	if cycles < 1 then
		--[[
			Three different nothings, and the player can act on exactly one of
			them, so they are reported apart: a juvenile herd needs time, a
			hungry one needs feed, and a fed grown one just needs waiting.
		]]
		if not Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
			self.ActionFailed:Fire(player, instanceId, "NotGrown")
		elseif not Husbandry.IsFed(entry.FedUntil, now) then
			self.ActionFailed:Fire(player, instanceId, "Hungry")
		else
			self.ActionFailed:Fire(player, instanceId, "NothingReady")
		end

		return false
	end

	--[[
		As many batches as will fit, rather than all or nothing. See
		cyclesThatFit: all-or-nothing plus an unbounded accumulator meant a
		pen could reach a state where collecting was refused forever.
	]]
	local payable = cyclesThatFit(player, entry.AnimalId, cycles, count)

	if payable < 1 then
		return self:_refuse(player, instanceId, "InventoryFull")
	end

	local totals = Husbandry.GetProduceTotals(entry.AnimalId, payable, count)

	-- Granted before the clock moves, so a grant that somehow fails leaves
	-- the produce on the clock rather than destroying it.
	for itemId, amount in totals do
		PlayerDataService:AddItem(player, itemId, amount)
	end

	entry.LastCollectedAt = Husbandry.AdvanceClock(entry.AnimalId, entry.StockedAt, entry.LastCollectedAt, payable)

	PlayerDataService:AddXP(player, animal.ProduceXP * payable * count)
	PlayerDataService:IncrementStat(player, "TotalProduceCollected", payable * count)

	self:_projectHerd(player, pen, entry, now)
	self.Collected:Fire(player, instanceId, entry.AnimalId, totals, payable)

	return true
end

--[[
	Slaughters the whole herd, emptying the pen.

	The WHOLE herd, not one animal, for the same reason the pen is stocked in
	one action: a part-slaughtered herd would need either a second count or a
	second timestamp, and "this pen holds a stack of one thing with one age"
	is the shape every other timed thing in this project has.

	Grown only, and held rather than tapped. It is the irreversible action on
	a building whose other actions are repeatable.
]]
function AnimalService:TrySlaughter(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local pen = self:GetPen(player, instanceId)

	if not entry or not pen or not entry.AnimalId or entry.AnimalId == "" then
		return false
	end

	local animal = GameConfig.GetAnimal(entry.AnimalId)
	if not animal or #animal.Slaughter < 1 then
		return self:_refuse(player, instanceId, "NotSlaughterable")
	end

	local now = os.time()

	if not Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
		return self:_refuse(player, instanceId, "NotGrown")
	end

	local stockId = entry.AnimalId
	local count = herdCount(entry)
	local totals = Husbandry.GetSlaughterTotals(stockId, count)

	--[[
		Any produce already earned is paid out first, so slaughtering never
		silently destroys a batch of eggs the player had not got round to
		collecting.

		BOTH payouts are checked before EITHER is granted. Collecting first
		and then checking room for the meat was the obvious order and left a
		half-completed action: a press on "Slaughter" that delivered eggs,
		left the herd standing, and reported a full inventory. Checking the
		combined payout keeps the ordering benefit - the meat is measured
		against the inventory the eggs will have filled - without it.
	]]
	local cycles = 0

	if GameConfig.HasProduce(stockId) then
		cycles = Husbandry.GetReadyCycles(stockId, entry.StockedAt, entry.LastCollectedAt, entry.FedUntil, count, now)
	end

	local combined = Husbandry.GetProduceTotals(stockId, cycles, count)

	for itemId, amount in totals do
		combined[itemId] = (combined[itemId] or 0) + amount
	end

	if not canHoldAll(player, combined) then
		return self:_refuse(player, instanceId, "InventoryFull")
	end

	-- Guaranteed to pay every cycle, because the combined total fits.
	if cycles > 0 and not self:TryCollect(player, instanceId) then
		return false
	end

	-- Granted before the herd is cleared, so a full inventory leaves the
	-- animals alive rather than destroying them for nothing.
	for itemId, amount in totals do
		PlayerDataService:AddItem(player, itemId, amount)
	end

	PlayerDataService:AddXP(player, animal.SlaughterXP * count)
	PlayerDataService:IncrementStat(player, "TotalAnimalsSlaughtered", count)

	clearHerd(entry)

	self:_projectEmpty(player, pen)
	self.Slaughtered:Fire(player, instanceId, stockId, totals, count)

	return true
end

--------------------------------------------------------------------------------
-- Pen lifecycle, driven by the placement service
--------------------------------------------------------------------------------

function AnimalService:_attach(player: Player, instanceId: string, entry, model: Model)
	local structure = GameConfig.GetStructure(entry.StructureId)

	if not structure or not structure.HousesLivestock then
		return
	end

	local body = model.PrimaryPart
	if not body then
		return
	end

	--[[
		The pen's prompt is StructureBuilder's, because every structure has
		one. This service only writes its ObjectText.

		This building is why the panel exists: four actions against a prompt's
		one gesture meant two prompts on two keys, the destructive one held,
		drawn on top of each other until a pixel offset pulled them apart -
		and even then the pen could not offer a CHOICE of animal.
	]]
	local pen = {
		InstanceId = instanceId,
		StructureId = entry.StructureId,
		Model = model,
		Connections = {},
		HerdEntityId = nil,
		-- Whether this hungry spell has already been announced.
		HungryNoticed = false,
	}

	local pens = self._pens[player]
	if not pens then
		pens = {}
		self._pens[player] = pens
	end
	pens[instanceId] = pen

	if entry.AnimalId and entry.AnimalId ~= "" and GameConfig.GetAnimal(entry.AnimalId) then
		local now = os.time()

		self:_projectHerd(player, pen, entry, now)

		--[[
			After the projection, because settling needs the herd entity the
			projection registers - and the herd may not survive it, which is
			the point: a flock left hungry over a long logout is dead when
			its owner comes back, rather than healed by the absence.
		]]
		if self:_settleHunger(player, pen, entry, now) > 0 and entry.AnimalId ~= "" then
			-- The timestamps moved, so the projection is now stale.
			self:_projectHerd(player, pen, entry, now)
		end
	else
		clearHerd(entry)
		self:_projectEmpty(player, pen)
	end
end

function AnimalService:_detach(player: Player, instanceId: string)
	local pens = self._pens[player]
	local pen = if pens then pens[instanceId] else nil

	if not pen then
		return
	end

	for _, connection in pen.Connections do
		connection:Disconnect()
	end

	if pen.HerdEntityId then
		AttackService:Unregister(pen.HerdEntityId)
		DamageableService:Unregister(pen.HerdEntityId)
	end

	pens[instanceId] = nil
end

--------------------------------------------------------------------------------
-- The husbandry loop
--------------------------------------------------------------------------------

--[[
	Starves a hungry herd.

	A fraction of max health per second, so a chicken and a cow die on the
	same schedule without either needing its own number. Armour is ignored:
	hunger is not an attack, and a thick hide does not help.

	This is the one place in this service that does work rather than deriving
	it, and it is a genuine EVENT - damage applied at a moment - rather than
	accumulated state. The herd's health is still derived on read, from
	HealthBase and the time since DamagedAt, which is why a fed herd recovers
	with no loop of its own.
]]
function AnimalService:_starve(pen, elapsed: number)
	if not pen.HerdEntityId then
		return
	end

	local entity = DamageableService:Get(pen.HerdEntityId)
	if not entity or not entity.Archetype then
		return
	end

	local damage = entity.Archetype.MaxHealth * GameConfig.Husbandry.StarvationFractionPerSecond * elapsed

	if damage <= 0 then
		return
	end

	DamageableService:ApplyDamage(
		pen.HerdEntityId,
		damage,
		GameConfig.Husbandry.StarvationDamageType,
		nil,
		{ IgnoreArmour = true }
	)
end

--[[
	Settles a span the herd spent hungry: it ages no further, earns nothing,
	and loses health for it.

	ONE function for three callers - the tick, a rejoin, and the moment before
	a feeding - because "what does hungry time cost" must not have three
	different answers. Idempotent through `HungryChargedTo`, which records how
	far the charge has been taken, so no span is billed twice however often
	this runs.

	FREEZING THE AGE IS THE POINT, and it is the fix for a rule that was real
	for cattle and absent for poultry. Reported from play: "the chickens grow
	without feeding, and I didn't notice starvation; cows and pigs starved and
	died". Both halves were true and the arithmetic says why - a chicken
	matures in 120s and takes 133s to starve, so an unfed flock grew up with
	thirteen seconds to spare, while a pig needs 300s to mature and dies in
	120. Feeding was mandatory for livestock and optional for birds, which is
	worse than it being either.

	So the herd's age advances only while it is fed. Maturity is still derived
	from StockedAt and nothing accumulates - the hungry span is simply pushed
	into the timestamp the derivation already reads, exactly as a growth boost
	backdates PlantedAt rather than writing a stage. The produce clock moves
	with it for the same reason, which also makes the clock correct the whole
	time a herd is hungry instead of only after the next feeding.

	Offline spans go through here too. The tick only walks pens of an online
	player, but health REGENERATES from elapsed time whether or not anyone is
	watching, so without charging the absence, logging out HEALED a starving
	herd and neglect could be reset by taking a break.
]]
function AnimalService:_settleHunger(player: Player, pen, entry, now: number): number
	local fedUntil = tonumber(entry.FedUntil) or 0

	if now <= fedUntil then
		return 0
	end

	local chargedTo = math.max(fedUntil, tonumber(entry.HungryChargedTo) or 0)
	local hungry = now - chargedTo

	if hungry <= 0 then
		return 0
	end

	entry.HungryChargedTo = now

	--[[
		Hungry time does not count toward growing up - but only WHILE the herd
		is still growing.

		Once it is grown, StockedAt's remaining job is to say when that
		happened, and pushing it would drag GrownAt forward past the produce
		clock and quietly confiscate batches the herd had already earned while
		fed. A test caught exactly that: a flock that banked four batches and
		then went hungry was down to three.

		The produce clock is NOT touched here. It needs no protection from the
		gap, because the produce window already ends at `min(now, FedUntil)` -
		hungry time contributes nothing by construction. It only needs
		adjusting at the moment feeding EXTENDS that window, which is where
		TryFeed does it.
	]]
	if not Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
		entry.StockedAt = math.min((tonumber(entry.StockedAt) or now) + hungry, now)
	end

	--[[
		Said once per hungry spell, not once per tick.

		"I didn't notice starvation" was the other half of the report, and it
		is the same bug as a prompt that declines silently: the herd stops
		growing, stops laying and starts dying, and every one of those is
		invisible until the animals are gone.
	]]
	if not pen.HungryNoticed then
		pen.HungryNoticed = true
		self.HerdHungry:Fire(player, pen.InstanceId, entry.AnimalId)
	end

	self:_starve(pen, hungry)

	return hungry
end

--[[
	Advances every pen: maturity transitions, starvation, and prompt text.

	Attributes and visuals are only touched on a stage transition, and prompts
	only when their text would change, so an idle pen costs a couple of
	comparisons per tick.
]]
function AnimalService:_tick()
	local now = os.time()

	for player, pens in self._pens do
		for instanceId, pen in pens do
			local entry = self:_getEntry(player, instanceId)

			if entry and entry.AnimalId and entry.AnimalId ~= "" then
				--[[
					Hunger first, because it moves the very timestamps the
					stage is derived from - and because it can kill the herd,
					after which there is nothing left to project.
				]]
				self:_settleHunger(player, pen, entry, now)

				if not entry.AnimalId or entry.AnimalId == "" then
					continue
				end

				local stage = Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)

				if stage ~= pen.Model:GetAttribute(ANIMAL_ATTR.Stage) then
					--[[
						The full projection rather than just a re-render: a
						herd reaching maturity has to stop being suspended and
						start being slaughterable, and both live in
						_projectHerd.
					]]
					self:_projectHerd(player, pen, entry, now)
				else
					-- Cheap path: the prompt still has to notice produce
					-- arriving and feed running out.
					self:_refreshPrompts(player, pen)
				end


			elseif entry then
				--[[
					An EMPTY pen needs refreshing too, and forgetting it was a
					real bug: the Stock prompt is how a player learns they now
					have something to put in the pen, and buying a chick
					changes the inventory rather than the pen, so nothing else
					would ever update the text.
				]]
				self:_refreshPrompts(player, pen)
			end
		end
	end
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

--[[
	Why an action was refused, in words the player can act on.

	Same reasoning as the planting refusals: a prompt that declines silently
	is indistinguishable from a prompt that is broken.
]]
local ACTION_REFUSALS = {
	NoLivestock = "You have no young animals to put in there. Buy some from the shop.",
	LevelTooLow = "You are not experienced enough to raise that yet.",
	Occupied = "That pen is already stocked. Slaughter the herd to clear it.",
	WrongPen = "That animal will not fit in this building.",
	NotEnoughFeed = "You do not have enough feed for the whole herd.",
	FeedFull = "They are already fed as far ahead as they will eat.",
	NotGrown = "They are not fully grown yet.",
	Hungry = "They are hungry, and a hungry herd produces nothing. Feed them.",
	NothingReady = "Nothing to collect yet.",
	NoProduce = "That animal produces nothing. Raise it and slaughter it.",
	NotSlaughterable = "There is nothing to take from that animal.",
	InventoryFull = "Your inventory is full, so the animals stay in the pen.",
}

local HERD_HUNGRY_NOTICE = "Your herd is hungry. They stop growing and laying while unfed, and will starve if left."
local HERD_LOST_NOTICE = "Your herd has died. A hungry herd starves, and a raided one does not come back."

function AnimalService:Start()
	assert(RunService:IsServer(), "AnimalService is server-only")

	if self._started then
		return self
	end
	self._started = true

	-- Fires for both new placements and rebuilds on rejoin, so a pen restored
	-- from saved data gets its prompts and herd exactly like a fresh one.
	PlacementService.Spawned:Connect(function(player: Player, instanceId: string, entry, model: Model)
		self:_attach(player, instanceId, entry, model)
	end)

	PlacementService.Despawned:Connect(function(player: Player, instanceId: string)
		self:_detach(player, instanceId)
	end)

	Players.PlayerRemoving:Connect(function(player: Player)
		for instanceId in self:_getPens(player) do
			self:_detach(player, instanceId)
		end

		self._pens[player] = nil
		self._lastInteraction[player] = nil
	end)

	--[[
		Herd health is owned by the damageable registry but must survive a
		rejoin, so it is mirrored onto the pen's structure entry.
	]]
	DamageableService.StateChanged:Connect(function(_, state, entity)
		if not HERD_ARCHETYPES[entity.ArchetypeId] then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		if not owner then
			return
		end

		for instanceId, pen in self:_getPens(owner) do
			if pen.HerdEntityId == entity.Id then
				local entry = self:_getEntry(owner, instanceId)

				if entry then
					entry.HerdHealth = state.Health
					entry.HerdDamagedAt = state.DamagedAt
				end

				return
			end
		end
	end)

	--[[
		A herd that dies - starved, or killed in a raid - empties the pen.

		Nothing is dropped. Losing livestock has to cost something or there
		would be no reason to feed them, and a corpse that still paid out
		would make starvation a slower way of slaughtering.
	]]
	DamageableService.Destroyed:Connect(function(_, _killer, entity)
		if not HERD_ARCHETYPES[entity.ArchetypeId] then
			return
		end

		local owner = Players:GetPlayerByUserId(entity.OwnerUserId)
		if not owner then
			return
		end

		for instanceId, pen in self:_getPens(owner) do
			if pen.HerdEntityId == entity.Id then
				local entry = self:_getEntry(owner, instanceId)
				local stockId = if entry then entry.AnimalId else nil

				pen.HerdEntityId = nil

				if entry then
					clearHerd(entry)
				end

				self:_projectEmpty(owner, pen)
				self.HerdLost:Fire(owner, instanceId, stockId)

				return
			end
		end
	end)

	local notice = Remotes.GetEvent(GameConfig.RemoteNames.Notice)

	self.ActionFailed:Connect(function(player: Player, _instanceId, reason: string)
		local message = ACTION_REFUSALS[reason]

		if message then
			notice:FireClient(player, message)
		end
	end)

	--[[
		Hunger is announced, because every consequence of it is invisible:
		the herd stops growing, stops laying and starts dying, and none of
		those shows up until the animals are gone. Reported from play as "I
		didn't notice starvation", which is the same class of bug as a prompt
		that declines without saying why.
	]]
	self.HerdHungry:Connect(function(player: Player)
		notice:FireClient(player, HERD_HUNGRY_NOTICE)
	end)

	-- Losing a herd is the kind of thing a player must not have to infer from
	-- an empty pen they walk past later.
	self.HerdLost:Connect(function(player: Player)
		notice:FireClient(player, HERD_LOST_NOTICE)
	end)

	local selectAnimal = Remotes.GetEvent(GameConfig.RemoteNames.SelectAnimal)

	selectAnimal.OnServerEvent:Connect(function(player: Player, stockId: unknown)
		if not self:_consumeInteraction(player) then
			return
		end

		local animal = GameConfig.GetAnimal(stockId)
		if not animal then
			return
		end

		player:SetAttribute(GameConfig.Attributes.SelectedStock, animal.StockId)
		self:_refreshAll(player)
	end)

	task.spawn(function()
		while true do
			task.wait(GameConfig.Husbandry.TickInterval)
			self:_tick()
		end
	end)

	return self
end

return AnimalService
