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
		    ├── Interact         ProximityPrompt - stock / feed / collect
		    └── Cull             ProximityPrompt - slaughter, held

	TWO PROMPTS, NOT ONE
	--------------------
	A pen has four actions and a ProximityPrompt has one gesture, so the
	contextual prompt offers whichever of stock/feed/collect is useful right
	now, and slaughtering gets its OWN prompt on a different key that must be
	HELD. That is the lesson from combat plants being uprooted by players
	mashing E down a row of farms: an irreversible action next to a repeatable
	one needs a different gesture, and here it also gets a different key.

	It is still two prompts too many. The selection panel in docs/ROADMAP.md is
	where a building's action list belongs, and this service is written so that
	panel only has to call TryStock/TryFeed/TryCollect/TrySlaughter - the
	prompts are a thin shell over four validated public methods, not the place
	the rules live.

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

local ANIMAL_ATTR = GameConfig.AnimalAttributes
local EMPTY_STAGE = GameConfig.Husbandry.EmptyStage
local PROMPT_NAME = "Interact"
local CULL_PROMPT_NAME = "Cull"
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
--- When the husbandry loop last ran, so starvation bills real elapsed time.
AnimalService._lastTickAt = nil :: number?

--- (player, instanceId, stockId, count)
AnimalService.Stocked = Signal.new()
--- (player, instanceId, stockId, fedUntil)
AnimalService.Fed = Signal.new()
--- (player, instanceId, stockId, totals, cycles)
AnimalService.Collected = Signal.new()
--- (player, instanceId, stockId, totals, count)
AnimalService.Slaughtered = Signal.new()
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

--- Re-checks reach on the server. The engine enforces prompt distance on the
--- client, which an exploiter controls.
local function isWithinReach(player: Player, part: BasePart): boolean
	local character = player.Character
	local root = character and character.PrimaryPart

	if not root then
		return false
	end

	local limit = GameConfig.Interaction.MaxActivationDistance + GameConfig.Interaction.DistanceTolerance
	return (root.Position - part.Position).Magnitude <= limit
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
-- Prompts
--------------------------------------------------------------------------------

--[[
	What the contextual prompt should say right now, as (enabled, action,
	object).

	Collecting outranks feeding, because produce waiting is the thing the
	player came over for and feed can be topped up on the way out. When
	neither is available the prompt stays visible but DISABLED with the reason
	in its text - a prompt that vanishes is indistinguishable from a building
	that has broken.
]]
function AnimalService:_describeInteract(player: Player, pen, entry, now: number): (boolean, string, string)
	if not entry or not entry.AnimalId or entry.AnimalId == "" then
		local stockId = self:_resolveStockId(player, pen.StructureId)
		local item = GameConfig.GetItem(stockId)

		local willStock = if stockId
			then math.min(
				GameConfig.GetPenCapacity(pen.StructureId, stockId),
				PlayerDataService:GetItemCount(player, stockId)
			)
			else 0

		if item and willStock > 0 then
			return true, "Stock", `{item.Name} x{willStock}`
		end

		return true, "Stock", "No livestock"
	end

	local animal = GameConfig.GetAnimal(entry.AnimalId)
	if not animal then
		return false, "Pen", "Unknown livestock"
	end

	local count = herdCount(entry)
	local cycles =
		Husbandry.GetReadyCycles(entry.AnimalId, entry.StockedAt, entry.LastCollectedAt, entry.FedUntil, count, now)

	if cycles > 0 then
		--[[
			What would ACTUALLY be collected, not what is waiting.

			The prompt must not advertise a payout the server will refuse.
			That is how the collection deadlock presented itself to a player:
			an enabled prompt naming a precise number of eggs, refusing on
			every press, with nothing to suggest the inventory was the problem.
		]]
		local payable = cyclesThatFit(player, entry.AnimalId, cycles, count)

		--[[
			Named after the produce rather than the animal, and totalled, so
			the player can see whether the walk over is worth it. A pen with
			one egg in it and a pen with thirty read differently.
		]]
		local totals = Husbandry.GetProduceTotals(entry.AnimalId, math.max(payable, 1), count)
		local parts = {}

		for _, yield in animal.Produces do
			local item = GameConfig.GetItem(yield.ItemId)
			table.insert(parts, `{if item then item.Name else yield.ItemId} x{totals[yield.ItemId] or 0}`)
		end

		if payable < 1 then
			return false, "Full", `No room for {table.concat(parts, ", ")}`
		end

		return true, "Collect", table.concat(parts, ", ")
	end

	local feedItem = GameConfig.GetItem(animal.Feed.ItemId)
	local feedName = if feedItem then feedItem.Name else animal.Feed.ItemId
	local cost = Husbandry.GetFeedCost(entry.AnimalId, count)

	-- Feed is offered whenever there is room on the clock for another window,
	-- hungry or not, so a player can stock up before logging off.
	if Husbandry.GetFeedRemaining(entry.FedUntil, now) <= animal.FeedDuration * (GameConfig.Husbandry.MaxFedWindows - 1) then
		if PlayerDataService:HasItem(player, animal.Feed.ItemId, cost) then
			return true, "Feed", `{feedName} x{cost}`
		end

		return true, "Feed", `Needs {feedName} x{cost}`
	end

	-- Fed as far ahead as allowed, so the only thing left is to wait. Say
	-- what for: growing up, or the next batch.
	if not Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
		local remaining = Husbandry.GetTimeToGrown(entry.AnimalId, entry.StockedAt, now)
		return false, "Growing", `{animal.Name} x{count} - {Growth.FormatTimeRemaining(remaining)}`
	end

	if not GameConfig.HasProduce(entry.AnimalId) then
		-- A slaughter-only animal that is grown and fed: there is nothing to
		-- tap for, and the cull prompt is the action.
		return false, "Ready", `{animal.Name} x{count}`
	end

	return false, "Fed", `{animal.Name} x{count}`
end

--[[
	Refreshes both prompts, but only writes to them when the text would
	change.

	The tick runs over every pen of every player, and a ProximityPrompt
	property write replicates. An idle pen must therefore cost a string
	comparison, not a round of replication - the same discipline as rebuilding
	a crop's visual only on a stage transition.
]]
function AnimalService:_refreshPrompts(player: Player, pen)
	local body = pen.Model.PrimaryPart
	if not body then
		return
	end

	local entry = self:_getEntry(player, pen.InstanceId)
	local now = os.time()

	local enabled, action, object = self:_describeInteract(player, pen, entry, now)
	local key = `{enabled}|{action}|{object}`

	local prompt = body:FindFirstChild(PROMPT_NAME)

	if prompt and key ~= pen.PromptKey then
		pen.PromptKey = key
		prompt.Enabled = enabled
		prompt.ActionText = action
		prompt.ObjectText = object
	end

	local cull = body:FindFirstChild(CULL_PROMPT_NAME)
	if not cull then
		return
	end

	--[[
		Slaughtering is offered only once the herd is GROWN. Culling juveniles
		would be a trap rather than a choice: the yields are not scaled down
		for a half-grown animal, so allowing it would either pay full price
		for an animal that was not raised or quietly pay less than the prompt
		said.
	]]
	local cullEnabled = false
	local cullObject = ""

	if entry and entry.AnimalId and entry.AnimalId ~= "" then
		local animal = GameConfig.GetAnimal(entry.AnimalId)
		local count = herdCount(entry)
		local grown = Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now))

		if animal and grown and #animal.Slaughter > 0 then
			local totals = Husbandry.GetSlaughterTotals(entry.AnimalId, count)
			local parts = {}

			for _, yield in animal.Slaughter do
				local item = GameConfig.GetItem(yield.ItemId)
				table.insert(parts, `{if item then item.Name else yield.ItemId} x{totals[yield.ItemId] or 0}`)
			end

			cullEnabled = true
			cullObject = table.concat(parts, ", ")
		end
	end

	local cullKey = `{cullEnabled}|{cullObject}`

	if cullKey ~= pen.CullPromptKey then
		pen.CullPromptKey = cullKey
		cull.Enabled = cullEnabled
		cull.ActionText = "Slaughter"
		cull.ObjectText = cullObject
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
function AnimalService:_resolveStockId(player: Player, structureId: string): string?
	local level = PlayerDataService:GetLevel(player)
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
function AnimalService:TryStock(player: Player, instanceId: string): boolean
	local entry = self:_getEntry(player, instanceId)
	local pen = self:GetPen(player, instanceId)

	if not entry or not pen then
		return false
	end

	if entry.AnimalId and entry.AnimalId ~= "" then
		self.ActionFailed:Fire(player, instanceId, "Occupied")
		return false
	end

	local stockId = self:_resolveStockId(player, pen.StructureId)
	if not stockId then
		self.ActionFailed:Fire(player, instanceId, "NoLivestock")
		return false
	end

	local animal = GameConfig.GetAnimal(stockId)
	if not animal or PlayerDataService:GetLevel(player) < animal.RequiredLevel then
		self.ActionFailed:Fire(player, instanceId, "LevelTooLow")
		return false
	end

	local capacity = GameConfig.GetPenCapacity(pen.StructureId, stockId)
	if capacity < 1 then
		self.ActionFailed:Fire(player, instanceId, "WrongPen")
		return false
	end

	-- As many as fit, or as many as are held. Stocking a part-full pen is
	-- allowed rather than refused; it just cannot be topped up later.
	local count = math.min(capacity, PlayerDataService:GetItemCount(player, stockId))

	if count < 1 then
		self.ActionFailed:Fire(player, instanceId, "NoLivestock")
		return false
	end

	-- Atomic: the livestock is consumed before the herd exists, so a spammed
	-- prompt cannot stock two pens from one batch.
	if not PlayerDataService:RemoveItem(player, stockId, count) then
		self.ActionFailed:Fire(player, instanceId, "NoLivestock")
		return false
	end

	local now = os.time()

	entry.AnimalId = stockId
	entry.StockedAt = now
	entry.AnimalCount = count
	entry.FedUntil = now + GameConfig.Husbandry.StockingGrace
	entry.LastCollectedAt = now
	entry.HerdHealth = nil
	entry.HerdDamagedAt = nil

	PlayerDataService:IncrementStat(player, "TotalAnimalsRaised", count)

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
	local fedUntil = tonumber(entry.FedUntil) or 0
	local count = herdCount(entry)

	if Husbandry.GetFeedRemaining(fedUntil, now) > animal.FeedDuration * (GameConfig.Husbandry.MaxFedWindows - 1) then
		self.ActionFailed:Fire(player, instanceId, "FeedFull")
		return false
	end

	local cost = Husbandry.GetFeedCost(entry.AnimalId, count)

	-- Atomic, and before any timestamp moves: a refused feed must leave the
	-- pen exactly as it was.
	if not PlayerDataService:RemoveItem(player, animal.Feed.ItemId, cost) then
		self.ActionFailed:Fire(player, instanceId, "NotEnoughFeed")
		return false
	end

	--[[
		Settle the hungry stretch before extending the clock.

		The gap between the feed running out and now produced nothing, so the
		produce clock is pushed forward by exactly its length. Resetting it to
		`now` instead would be simpler and wrong: it would also throw away
		batches the herd legitimately earned BEFORE the feed ran out. Leaving
		it alone would be worse - the new fed window would retroactively pay
		for the whole starved gap, which is a feed-once-a-day exploit.

		This is the same move as backdating PlantedAt for a growth boost:
		adjust the timestamp the state derives from, never the derived value.
	]]
	local starved = math.max(now - fedUntil, 0)

	if starved > 0 then
		--[[
			Pushed from the EFFECTIVE window start, not from the raw
			LastCollectedAt.

			Those differ whenever the herd has not finished growing, because
			the window start is clamped forward to the maturity time - and
			pushing the raw value would then be absorbed by that clamp and do
			nothing at all, crediting the whole starved gap. That was a real
			bug, found by writing the test for the gap before trusting the
			arithmetic.
		]]
		local clock = Husbandry.GetWindowStart(entry.AnimalId, entry.StockedAt, entry.LastCollectedAt)
		entry.LastCollectedAt = math.min(clock + starved, now)
	end

	entry.FedUntil = math.min(
		math.max(now, fedUntil) + animal.FeedDuration,
		Husbandry.GetFeedCeiling(entry.AnimalId, now)
	)

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
		self.ActionFailed:Fire(player, instanceId, "NoProduce")
		return false
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
		self.ActionFailed:Fire(player, instanceId, "InventoryFull")
		return false
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
		self.ActionFailed:Fire(player, instanceId, "NotSlaughterable")
		return false
	end

	local now = os.time()

	if not Husbandry.IsGrown(Husbandry.GetStage(entry.AnimalId, entry.StockedAt, now)) then
		self.ActionFailed:Fire(player, instanceId, "NotGrown")
		return false
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
		self.ActionFailed:Fire(player, instanceId, "InventoryFull")
		return false
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
-- Prompt entry points
--------------------------------------------------------------------------------

--- Validates ownership, reach and cooldown once for both prompts.
function AnimalService:_authorise(player: Player, pen): boolean
	local owner = pen.Model:GetAttribute(GameConfig.StructureAttributes.OwnerUserId)

	if owner ~= player.UserId then
		return false
	end

	local body = pen.Model.PrimaryPart
	if not body or not isWithinReach(player, body) then
		return false
	end

	return self:_consumeInteraction(player)
end

--- The contextual prompt. Mirrors _describeInteract exactly, so the action
--- taken is always the action the prompt offered.
function AnimalService:_onPromptTriggered(player: Player, pen)
	if not self:_authorise(player, pen) then
		return
	end

	local entry = self:_getEntry(player, pen.InstanceId)
	if not entry then
		return
	end

	if not entry.AnimalId or entry.AnimalId == "" then
		self:TryStock(player, pen.InstanceId)
		return
	end

	local now = os.time()
	local cycles = Husbandry.GetReadyCycles(
		entry.AnimalId,
		entry.StockedAt,
		entry.LastCollectedAt,
		entry.FedUntil,
		herdCount(entry),
		now
	)

	if cycles > 0 then
		self:TryCollect(player, pen.InstanceId)
	else
		self:TryFeed(player, pen.InstanceId)
	end
end

function AnimalService:_onCullTriggered(player: Player, pen)
	if not self:_authorise(player, pen) then
		return
	end

	self:TrySlaughter(player, pen.InstanceId)
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

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = PROMPT_NAME
	prompt.ActionText = "Stock"
	prompt.ObjectText = structure.Name
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	--[[
		A different key AND a hold. Slaughtering is irreversible and sits on a
		building the player will walk up to dozens of times to collect eggs,
		so it must not share a gesture with collecting them.
	]]
	local cull = Instance.new("ProximityPrompt")
	cull.Name = CULL_PROMPT_NAME
	cull.ActionText = "Slaughter"
	cull.ObjectText = ""
	cull.Enabled = false
	cull.HoldDuration = GameConfig.Interaction.DestructiveHoldDuration
	cull.KeyboardKeyCode = Enum.KeyCode.X
	cull.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	cull.RequiresLineOfSight = false
	cull.Parent = body

	local pen = {
		InstanceId = instanceId,
		StructureId = entry.StructureId,
		Model = model,
		Connections = {},
		HerdEntityId = nil,
		-- Deliberately nil, so the first refresh always writes.
		PromptKey = nil,
		CullPromptKey = nil,
	}

	local pens = self._pens[player]
	if not pens then
		pens = {}
		self._pens[player] = pens
	end
	pens[instanceId] = pen

	table.insert(
		pen.Connections,
		prompt.Triggered:Connect(function(triggering: Player)
			self:_onPromptTriggered(triggering, pen)
		end)
	)

	table.insert(
		pen.Connections,
		cull.Triggered:Connect(function(triggering: Player)
			self:_onCullTriggered(triggering, pen)
		end)
	)

	if entry.AnimalId and entry.AnimalId ~= "" and GameConfig.GetAnimal(entry.AnimalId) then
		local now = os.time()

		self:_projectHerd(player, pen, entry, now)

		--[[
			After the projection, because settling needs the herd entity the
			projection registers - and the herd may not survive it, which is
			the point: a flock left hungry over a long logout is dead when
			its owner comes back.
		]]
		self:_settleNeglect(pen, entry, now)
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
	Charges starvation for time that passed while nobody was here.

	The tick only walks pens belonging to an online player, but health
	REGENERATES from elapsed time whether or not anyone is watching - the
	registry derives it from HealthBase and the time since DamagedAt, both of
	which are persisted. So without this, logging out HEALED a starving herd,
	and neglect could be reset indefinitely by taking a break: the only cost
	of never feeding was forgone produce, which for a pig is nothing at all.

	Offline time has to cost what online time costs. The produce clock already
	gets this right by refusing to pay for the unfed gap; starvation was the
	one part of the mechanic treating offline time asymmetrically.

	Charged from the later of the feed running out and the damage already
	taken, so no span is ever billed twice.
]]
function AnimalService:_settleNeglect(pen, entry, now: number)
	if not pen.HerdEntityId then
		return
	end

	local fedUntil = tonumber(entry.FedUntil) or 0

	if now <= fedUntil then
		return
	end

	local chargedTo = math.max(fedUntil, tonumber(entry.HerdDamagedAt) or 0)
	local unpaid = now - chargedTo

	if unpaid > 0 then
		self:_starve(pen, unpaid)
	end
end

--[[
	Advances every pen: maturity transitions, starvation, and prompt text.

	Attributes and visuals are only touched on a stage transition, and prompts
	only when their text would change, so an idle pen costs a couple of
	comparisons per tick.
]]
function AnimalService:_tick()
	local now = os.time()

	--[[
		REAL elapsed time, not the configured interval.

		A late tick must bill what actually passed. GameConfig.StatusEffects
		states this rule in prose about exactly this arithmetic - never
		`PerSecond * TickInterval`, because a server that stutters would heal
		your enemies for free - and the asymmetry is sharper here, because
		regeneration on the same entity IS derived from real elapsed time. A
		tick late by more than about twenty seconds would be a net heal for a
		starving flock, and sustained stutter would make one immortal.
	]]
	local interval = if self._lastTickAt
		then math.max(now - self._lastTickAt, 0)
		else GameConfig.Husbandry.TickInterval

	self._lastTickAt = now

	for player, pens in self._pens do
		for instanceId, pen in pens do
			local entry = self:_getEntry(player, instanceId)

			if entry and entry.AnimalId and entry.AnimalId ~= "" then
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

				if not Husbandry.IsFed(entry.FedUntil, now) then
					-- Only the part of the interval the herd was actually
					-- hungry for, so the tick the feed lapses in is not
					-- billed in full.
					self:_starve(pen, math.min(interval, now - (tonumber(entry.FedUntil) or 0)))
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
