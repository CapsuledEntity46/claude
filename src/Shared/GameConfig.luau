--!strict
--[[
	GameConfig
	----------
	Single source of truth for tunable game values, shared by server and client.

	Nothing here is authoritative on its own: the server always validates
	against these tables before mutating a profile. The client may read them
	freely for UI purposes (prices, stock, XP bars) without a round trip.

	FRAMEWORK SHAPE
	---------------
	The directory is split by *concern*, not by content type, so new mechanics
	bolt on without reshaping what exists:

	  Items      - the MASTER DIRECTORY. Every tradeable/storable thing in the
	               game, keyed by a globally unique item id. Carries only what
	               is true of any item: display name, category, prices, stack
	               size.
	  Plantables - gardening behaviour, keyed by SEED item id. Carries GrowTime,
	               XP, level gate, and what crop item it yields.

	Future mechanics follow the same pattern and touch nothing above:

	  Animals    - husbandry, keyed by animal id, `Produces = {"Egg", "Milk"}`
	  Recipes    - crafting, keyed by output item id, `Inputs = {...}`
	  Structures - RTS/survival building, keyed by structure id, `Cost = {...}`

	The rule that keeps this scalable: **storage is flat, categorisation is
	metadata**. Inventories are keyed by item id alone, and `Category` exists
	for grouping in UI and queries - never for addressing storage. Adding
	"AnimalDrops" therefore required no inventory change at all.
]]

export type Rarity = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary"

export type ItemCategory = "Seeds" | "Crops" | "AnimalDrops" | "Boosts"

export type ItemDefinition = {
	Id: string,
	Name: string,
	Category: ItemCategory,
	-- nil means the shop will not buy/sell it. Both may be nil (for example a
	-- Robux-only consumable, which lives in the directory for stacking and UI
	-- purposes but is not tradeable for Gold).
	BuyPrice: number?,
	SellPrice: number?,
	MaxStack: number,
	Rarity: Rarity,
}

export type PlantableDefinition = {
	SeedId: string, -- item id of the seed consumed when planting
	Yields: string, -- item id of the crop produced on harvest
	YieldAmount: number, -- per plant, so a full square yields this times its count
	GrowTime: number, -- seconds from planting to fully grown
	XPReward: number, -- per plant, scaled the same way
	RequiredLevel: number, -- gates both buying and planting
	PlantSize: string, -- key into GameConfig.PlantSizes; sets how many fit per farm
	Color: Color3, -- growing plant tint, also used by shop UI swatches
	-- Archetype the grown plant registers as. Defaults to "Crop"; a combat
	-- plant names its own, which is what gives it an attack and real health.
	ArchetypeId: string?,
	-- False for a plant that is not picked but kept, like every combat plant.
	-- Such a plant has no Yields and is uprooted rather than harvested.
	Harvestable: boolean?,
}

export type PlantSizeDefinition = {
	Id: string,
	Name: string,
	PerFarm: number, -- how many of this size fit in one farm square
	VisualScale: number, -- multiplier on the rendered plant
}

local GameConfig = {}

--[[
	Framework revision. Bump this, AND the FrameworkVersion on every service,
	whenever a change crosses module boundaries: a renamed config field, a
	changed function signature, a reshaped table. Purely additive changes do
	not need a bump.

	Server.FrameworkGuard compares the two at startup, so a half-synced Studio
	tree fails with a message naming the stale module instead of a nil-index
	deep inside unrelated code.
]]
GameConfig.FrameworkVersion = 14

--------------------------------------------------------------------------------
-- Persistence
--------------------------------------------------------------------------------

GameConfig.Data = {
	-- Bumped to 2 when the inventory was flattened from category buckets to a
	-- single item-id map. See DataSchema.Migrations.
	SchemaVersion = 4,

	-- Changing the store name starts every player from scratch. Treat it as a
	-- deliberate wipe, not a routine edit.
	StoreName = "PlayerProfiles_v1",

	AutoSaveInterval = 60,
	SessionLockExpire = 120,
	BackupInterval = 300,
}

--------------------------------------------------------------------------------
-- Economy
--------------------------------------------------------------------------------

GameConfig.Economy = {
	-- Hard ceiling keeps a single bad multiplier from pushing a value past the
	-- range where doubles stop representing integers exactly.
	MaxResource = 1_000_000_000,
	MaxInventoryGold = 1_000_000_000,

	StartingRevengeTokens = 2,
	MaxRevengeTokens = 9_999,
}

--------------------------------------------------------------------------------
-- Resources (the civilisation treasury)
--------------------------------------------------------------------------------

export type ResourceDefinition = {
	Id: string,
	Name: string,
	Color: Color3,
	SortOrder: number,
}

--[[
	The four gathered resources, spent continuously on construction, training
	and research. These are CURRENCIES, not inventory items: they have their own
	balances and HUD readouts rather than living in the item directory.

	`Gold` here is the BASE treasury. The player's personal purse is a separate
	balance (`InventoryGold`) with deliberately asymmetric flows - see
	docs/ROADMAP.md. Market sales credit the treasury; loot credits the purse;
	nothing moves from treasury to purse.
]]
GameConfig.Resources = {
	Food = { Id = "Food", Name = "Food", Color = Color3.fromRGB(196, 92, 72), SortOrder = 10 },
	Wood = { Id = "Wood", Name = "Wood", Color = Color3.fromRGB(142, 98, 56), SortOrder = 20 },
	Gold = { Id = "Gold", Name = "Gold", Color = Color3.fromRGB(240, 199, 62), SortOrder = 30 },
	Stone = { Id = "Stone", Name = "Stone", Color = Color3.fromRGB(150, 152, 158), SortOrder = 40 },
} :: { [string]: ResourceDefinition }

-- The primary currency, used by the market.
GameConfig.PrimaryResource = "Gold"

--- Granted once, on a profile's first load. Deliberately NOT in the DataSchema
--- template, for the same reason the starter items are not: Reconcile would
--- re-grant anything spent to zero.
--[[
	Sized so a fresh player can actually reach their FIRST farm, which is what
	opens the income loop:

		Town Center 300 Wood + 100 Stone
		Mill        100 Wood
		Farm         60 Wood
		           = 460 Wood + 100 Stone

	Anything less is a cold-start wall: construction costs Wood and Stone,
	while the only income before a farm exists is Gold, so a player short on
	Wood had no way to earn more. Market trading below is the sustained answer;
	this is the bootstrap.
]]
GameConfig.StartingResources = {
	Food = 200,
	Wood = 500,
	Gold = 200,
	Stone = 150,
}

function GameConfig.GetResource(resourceId: unknown): ResourceDefinition?
	if type(resourceId) ~= "string" then
		return nil
	end

	return GameConfig.Resources[resourceId]
end

--- Resource ids in display order. Stable, so HUD layout never shuffles.
function GameConfig.GetResourceIds(): { string }
	local ids = {}

	for id in GameConfig.Resources do
		table.insert(ids, id)
	end

	table.sort(ids, function(a, b)
		return GameConfig.Resources[a].SortOrder < GameConfig.Resources[b].SortOrder
	end)

	return ids
end

--------------------------------------------------------------------------------
-- Ages (civilisation progression)
--------------------------------------------------------------------------------

export type AgeDefinition = {
	Index: number,
	Name: string,
	AdvanceCost: { [string]: number },
}

--[[
	Age gates CIVILISATION capability - what can be built, trained and
	researched. Player `Level` gates PERSONAL capability - gear, spells, stats.
	Keeping those separate is what stops the MMO half and the RTS half fighting
	over the same number.

	Advancing costs resources, never XP.
]]
GameConfig.Ages = {
	{ Index = 1, Name = "Stone Age", AdvanceCost = {} },
	{ Index = 2, Name = "Feudal Age", AdvanceCost = { Food = 500 } },
	{ Index = 3, Name = "Castle Age", AdvanceCost = { Food = 800, Gold = 200 } },
	{ Index = 4, Name = "Imperial Age", AdvanceCost = { Food = 1_000, Gold = 800 } },
} :: { AgeDefinition }

GameConfig.MaxAge = #GameConfig.Ages

function GameConfig.GetAge(index: unknown): AgeDefinition?
	if type(index) ~= "number" then
		return nil
	end

	return GameConfig.Ages[index]
end

--- Cost to advance FROM `index` to `index + 1`, or nil at the final age.
function GameConfig.GetAdvanceCost(index: number): { [string]: number }?
	local next = GameConfig.Ages[index + 1]
	return if next then next.AdvanceCost else nil
end

--[[
	Items granted once, on a profile's first ever load.

	This is deliberately NOT part of the DataSchema template. Template fields
	are backfilled by Reconcile on every load, and because an inventory entry is
	deleted when it reaches zero, a starter item in the template is re-granted
	every time the player logs in having spent it - an infinite item exploit.
	Granting from here behind the StarterKitGranted flag happens exactly once.
]]
--[[
	Exactly enough to fill one farm square, so a new player's first planting
	fills it rather than leaving six visible gaps and an empty seed pouch.

	Tied to the Small tier's density on purpose: raising how many carrots fit
	in a square without raising this would silently make the opening worse.
]]
GameConfig.StarterKit = {
	CarrotSeed = 9,
}

--------------------------------------------------------------------------------
-- Progression
--------------------------------------------------------------------------------

GameConfig.Progression = {
	MaxLevel = 100,
	BaseXP = 100,
	Exponent = 1.35,
}

--- XP required to advance *from* `level` to `level + 1`.
--- Returns math.huge at MaxLevel so XP simply stops accumulating.
function GameConfig.GetXPForLevel(level: number): number
	if level >= GameConfig.Progression.MaxLevel then
		return math.huge
	end

	return math.floor(GameConfig.Progression.BaseXP * (level ^ GameConfig.Progression.Exponent))
end

--------------------------------------------------------------------------------
-- Master item directory
--------------------------------------------------------------------------------

-- Display order for category tabs in the shop UI.
GameConfig.ItemCategories = { "Seeds", "Crops", "AnimalDrops", "Boosts" }

GameConfig.Items = {
	--------------------------------------------------------------------------
	-- Seeds: purchasable, not sellable (no buy-back arbitrage)
	--------------------------------------------------------------------------
	CarrotSeed = {
		Id = "CarrotSeed",
		Name = "Carrot Seed",
		Category = "Seeds",
		BuyPrice = 10,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Common",
	},

	--------------------------------------------------------------------------
	-- Combat plant seeds
	--
	-- Priced well above food seeds and gated by level: a square given to a
	-- defence is a square not growing anything, so the cost has to reflect
	-- that it buys safety rather than income.
	--------------------------------------------------------------------------
	EmberBloomSeed = {
		Id = "EmberBloomSeed",
		Name = "Ember Bloom Seed",
		Category = "Seeds",
		BuyPrice = 120,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	FrostLilySeed = {
		Id = "FrostLilySeed",
		Name = "Frost Lily Seed",
		Category = "Seeds",
		BuyPrice = 150,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	VenomCapSeed = {
		Id = "VenomCapSeed",
		Name = "Venom Cap Seed",
		Category = "Seeds",
		BuyPrice = 180,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Rare",
	},
	BulwarkSeed = {
		Id = "BulwarkSeed",
		Name = "Bulwark Gourd Seed",
		Category = "Seeds",
		BuyPrice = 200,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Rare",
	},
	TomatoSeed = {
		Id = "TomatoSeed",
		Name = "Tomato Seed",
		Category = "Seeds",
		BuyPrice = 25,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Common",
	},
	WheatSeed = {
		Id = "WheatSeed",
		Name = "Wheat Seed",
		Category = "Seeds",
		BuyPrice = 15,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Common",
	},
	PumpkinSeed = {
		Id = "PumpkinSeed",
		Name = "Pumpkin Seed",
		Category = "Seeds",
		BuyPrice = 80,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	WatermelonSeed = {
		Id = "WatermelonSeed",
		Name = "Watermelon Seed",
		Category = "Seeds",
		BuyPrice = 240,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Rare",
	},
	GoldenAppleSeed = {
		Id = "GoldenAppleSeed",
		Name = "Golden Apple Seed",
		Category = "Seeds",
		BuyPrice = 900,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Epic",
	},
	StarfruitSeed = {
		Id = "StarfruitSeed",
		Name = "Starfruit Seed",
		Category = "Seeds",
		BuyPrice = 3_500,
		SellPrice = nil,
		MaxStack = 999,
		Rarity = "Legendary",
	},

	--------------------------------------------------------------------------
	-- Crops: harvested, sellable, never purchasable
	--------------------------------------------------------------------------
	Carrot = {
		Id = "Carrot",
		Name = "Carrot",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 25,
		MaxStack = 999,
		Rarity = "Common",
	},
	Tomato = {
		Id = "Tomato",
		Name = "Tomato",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 60,
		MaxStack = 999,
		Rarity = "Common",
	},
	Wheat = {
		Id = "Wheat",
		Name = "Wheat",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 40,
		MaxStack = 999,
		Rarity = "Common",
	},
	Pumpkin = {
		Id = "Pumpkin",
		Name = "Pumpkin",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 210,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	Watermelon = {
		Id = "Watermelon",
		Name = "Watermelon",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 660,
		MaxStack = 999,
		Rarity = "Rare",
	},
	GoldenApple = {
		Id = "GoldenApple",
		Name = "Golden Apple",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 2_600,
		MaxStack = 999,
		Rarity = "Epic",
	},
	Starfruit = {
		Id = "Starfruit",
		Name = "Starfruit",
		Category = "Crops",
		BuyPrice = nil,
		SellPrice = 11_000,
		MaxStack = 999,
		Rarity = "Legendary",
	},

	--------------------------------------------------------------------------
	-- Animal drops: produced by husbandry (mechanic not built yet), sellable.
	-- Present now so the shop, inventory and UI already handle them.
	--------------------------------------------------------------------------
	Egg = {
		Id = "Egg",
		Name = "Egg",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 30,
		MaxStack = 999,
		Rarity = "Common",
	},
	Milk = {
		Id = "Milk",
		Name = "Milk",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 45,
		MaxStack = 999,
		Rarity = "Common",
	},
	RawBeef = {
		Id = "RawBeef",
		Name = "Raw Beef",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 120,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	Leather = {
		Id = "Leather",
		Name = "Leather",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 90,
		MaxStack = 999,
		Rarity = "Uncommon",
	},

	--------------------------------------------------------------------------
	-- Boosts: Robux-only, so neither buyable nor sellable for Gold
	--------------------------------------------------------------------------
	GrowthBoost = {
		Id = "GrowthBoost",
		Name = "Instant Grow",
		Category = "Boosts",
		BuyPrice = nil,
		SellPrice = nil,
		MaxStack = 99,
		Rarity = "Epic",
	},
} :: { [string]: ItemDefinition }

--- Resolves an untrusted item id. Returns nil for anything not in the
--- directory, which every caller must treat as "reject".
function GameConfig.GetItem(itemId: unknown): ItemDefinition?
	if type(itemId) ~= "string" then
		return nil
	end

	return GameConfig.Items[itemId]
end

function GameConfig.IsValidCategory(category: unknown): boolean
	if type(category) ~= "string" then
		return false
	end

	return table.find(GameConfig.ItemCategories, category) ~= nil
end

--- Items in a category, ordered by price then id so UI layout is stable.
function GameConfig.GetItemsByCategory(category: string): { ItemDefinition }
	local items = {}

	for _, item in GameConfig.Items do
		if item.Category == category then
			table.insert(items, item)
		end
	end

	table.sort(items, function(a, b)
		local priceA = a.BuyPrice or a.SellPrice or 0
		local priceB = b.BuyPrice or b.SellPrice or 0

		if priceA == priceB then
			return a.Id < b.Id
		end
		return priceA < priceB
	end)

	return items
end

function GameConfig.IsBuyable(item: ItemDefinition): boolean
	return item.BuyPrice ~= nil
end

function GameConfig.IsSellable(item: ItemDefinition): boolean
	return item.SellPrice ~= nil
end

--------------------------------------------------------------------------------
-- Plant sizes (how densely a crop packs into one farm square)
--------------------------------------------------------------------------------

--[[
	How many plants of a kind share a farm square, and how big each one looks.

	The point is to make food cheap in SPACE. A farm square that holds one
	carrot means a player feeding themselves has no room left for anything
	else, and the interesting plants - the ones that shoot back - never get
	built. Nine carrots to a square means food is a couple of squares and the
	rest of the base can be defences.

	So density is a property of the PLANT, not of the farm: the farm is just
	tilled ground. A pumpkin takes a third of a square because it is a
	pumpkin, and a combat plant takes a whole one because it needs the room to
	work.

	`VisualScale` keeps that readable at a glance - nine small plants, three
	fat ones, or one big one - rather than making the player count.
]]
GameConfig.PlantSizes = {
	Small = {
		Id = "Small",
		Name = "Small",
		PerFarm = 9,
		VisualScale = 0.55,
	},

	Large = {
		Id = "Large",
		Name = "Large",
		PerFarm = 3,
		VisualScale = 1.0,
	},

	--[[
		One per square, reserved for the offensive and defensive plants in
		docs/ROADMAP.md. Nothing uses this tier yet; it exists so the rule is
		settled before the plants arrive, because retrofitting density onto a
		combat plant means rebalancing every wave that fights it.
	]]
	Special = {
		Id = "Special",
		Name = "Special",
		PerFarm = 1,
		VisualScale = 1.3,
	},
} :: { [string]: PlantSizeDefinition }

function GameConfig.GetPlantSize(sizeId: unknown): PlantSizeDefinition?
	if type(sizeId) ~= "string" then
		return nil
	end

	return GameConfig.PlantSizes[sizeId]
end

--- How many of `seedId` fit in one farm square. 0 for an unknown seed, so a
--- caller that forgets to validate cannot accidentally plant something.
function GameConfig.GetPlantCapacity(seedId: unknown): number
	local plantable = GameConfig.GetPlantable(seedId)

	if not plantable then
		return 0
	end

	local size = GameConfig.GetPlantSize(plantable.PlantSize)
	return if size then size.PerFarm else 0
end

--------------------------------------------------------------------------------
-- Plantables (gardening behaviour, keyed by seed item id)
--------------------------------------------------------------------------------

GameConfig.Plantables = {
	CarrotSeed = {
		SeedId = "CarrotSeed",
		Yields = "Carrot",
		YieldAmount = 1,
		GrowTime = 30,
		XPReward = 10,
		RequiredLevel = 1,
		PlantSize = "Small",
		Color = Color3.fromRGB(237, 139, 48),
	},
	WheatSeed = {
		SeedId = "WheatSeed",
		Yields = "Wheat",
		YieldAmount = 2,
		GrowTime = 45,
		XPReward = 16,
		RequiredLevel = 2,
		PlantSize = "Small",
		Color = Color3.fromRGB(214, 183, 90),
	},
	TomatoSeed = {
		SeedId = "TomatoSeed",
		Yields = "Tomato",
		YieldAmount = 1,
		GrowTime = 60,
		XPReward = 22,
		RequiredLevel = 3,
		PlantSize = "Small",
		Color = Color3.fromRGB(214, 61, 56),
	},
	PumpkinSeed = {
		SeedId = "PumpkinSeed",
		Yields = "Pumpkin",
		YieldAmount = 1,
		GrowTime = 150,
		XPReward = 55,
		RequiredLevel = 8,
		PlantSize = "Large",
		Color = Color3.fromRGB(226, 132, 38),
	},
	WatermelonSeed = {
		SeedId = "WatermelonSeed",
		Yields = "Watermelon",
		YieldAmount = 1,
		GrowTime = 320,
		XPReward = 140,
		RequiredLevel = 15,
		PlantSize = "Large",
		Color = Color3.fromRGB(72, 160, 84),
	},
	GoldenAppleSeed = {
		SeedId = "GoldenAppleSeed",
		Yields = "GoldenApple",
		YieldAmount = 1,
		GrowTime = 600,
		XPReward = 420,
		RequiredLevel = 25,
		PlantSize = "Large",
		Color = Color3.fromRGB(240, 199, 62),
	},
	--------------------------------------------------------------------------
	-- Combat plants
	--
	-- Special tier, so one per square: a defence needs the room to work, and
	-- the space it costs is the real price. None of them is harvestable - a
	-- combat plant is kept, not picked - so they have no Yields and are
	-- uprooted when the player wants the square back.
	--------------------------------------------------------------------------
	EmberBloomSeed = {
		SeedId = "EmberBloomSeed",
		GrowTime = 45,
		XPReward = 40,
		RequiredLevel = 2,
		PlantSize = "Special",
		ArchetypeId = "EmberBloom",
		Harvestable = false,
		Color = Color3.fromRGB(236, 112, 48),
	},
	FrostLilySeed = {
		SeedId = "FrostLilySeed",
		GrowTime = 50,
		XPReward = 45,
		RequiredLevel = 3,
		PlantSize = "Special",
		ArchetypeId = "FrostLily",
		Harvestable = false,
		Color = Color3.fromRGB(120, 196, 236),
	},
	VenomCapSeed = {
		SeedId = "VenomCapSeed",
		GrowTime = 60,
		XPReward = 55,
		RequiredLevel = 4,
		PlantSize = "Special",
		ArchetypeId = "VenomCap",
		Harvestable = false,
		Color = Color3.fromRGB(126, 196, 76),
	},
	BulwarkSeed = {
		SeedId = "BulwarkSeed",
		GrowTime = 75,
		XPReward = 60,
		RequiredLevel = 4,
		PlantSize = "Special",
		ArchetypeId = "Bulwark",
		Harvestable = false,
		Color = Color3.fromRGB(176, 158, 96),
	},

	StarfruitSeed = {
		SeedId = "StarfruitSeed",
		Yields = "Starfruit",
		YieldAmount = 1,
		GrowTime = 1_200,
		XPReward = 1_250,
		RequiredLevel = 40,
		PlantSize = "Large",
		Color = Color3.fromRGB(126, 118, 224),
	},
} :: { [string]: PlantableDefinition }

--- Whether a planted `seedId` is picked (a food crop) or kept (a defence).
function GameConfig.IsHarvestable(seedId: unknown): boolean
	local plantable = GameConfig.GetPlantable(seedId)
	return plantable ~= nil and plantable.Harvestable ~= false
end

--- The archetype a grown `seedId` registers as. Food crops share "Crop";
--- a combat plant names its own.
function GameConfig.GetPlantArchetypeId(seedId: unknown): string?
	local plantable = GameConfig.GetPlantable(seedId)

	if not plantable then
		return nil
	end

	return plantable.ArchetypeId or "Crop"
end

--- Resolves an untrusted seed item id to its planting behaviour.
function GameConfig.GetPlantable(seedId: unknown): PlantableDefinition?
	if type(seedId) ~= "string" then
		return nil
	end

	return GameConfig.Plantables[seedId]
end

--- Level required to buy or plant an item. Non-plantable items are ungated.
function GameConfig.GetRequiredLevel(itemId: string): number
	local plantable = GameConfig.Plantables[itemId]
	return if plantable then plantable.RequiredLevel else 0
end

--- Seeds a player of `level` may buy or plant, cheapest first (then by id).
function GameConfig.GetAvailablePlantables(level: number): { PlantableDefinition }
	local available = {}

	for _, plantable in GameConfig.Plantables do
		if level >= plantable.RequiredLevel then
			table.insert(available, plantable)
		end
	end

	table.sort(available, function(a, b)
		local priceA = GameConfig.Items[a.SeedId].BuyPrice or 0
		local priceB = GameConfig.Items[b.SeedId].BuyPrice or 0

		if priceA == priceB then
			return a.SeedId < b.SeedId
		end
		return priceA < priceB
	end)

	return available
end

--------------------------------------------------------------------------------
-- Growth
--------------------------------------------------------------------------------

export type GrowthStage = { Id: string, Threshold: number }

GameConfig.Growth = {
	EmptyStage = "Empty",
	MatureStage = "Mature",
	TickInterval = 1,

	Stages = {
		{ Id = "Seedling", Threshold = 0.0 },
		{ Id = "Growing", Threshold = 0.35 },
		{ Id = "Mature", Threshold = 1.0 },
	} :: { GrowthStage },
}

--------------------------------------------------------------------------------
-- Interaction
--------------------------------------------------------------------------------

--[[
	Shared rules for every ProximityPrompt in the game.

	These are the survivors of the retired fixed-garden config. Plots used to
	own them; now anything interactive does, because farms are placed
	structures rather than slots in a pre-built garden.
]]
GameConfig.Interaction = {
	-- Prompt reach, and the slack added before the server rejects an
	-- interaction as out of range. The engine enforces reach on the client,
	-- which an exploiter controls, so the server re-checks with tolerance for
	-- latency and movement.
	MaxActivationDistance = 14,
	DistanceTolerance = 8,

	-- Minimum seconds between accepted interactions from one player.
	Cooldown = 0.35,
}

--------------------------------------------------------------------------------
-- Combat
--------------------------------------------------------------------------------

export type ArchetypeDefinition = {
	Id: string,
	Name: string,
	MaxHealth: number,
	ArmourClass: string,
	Armour: number,
	RegenPerSecond: number, -- 0 = never self-heals
	Repairable: boolean,
	RepairCostPerHealth: { [string]: number }?,
	DestroyBehaviour: string, -- "Remove" | "Shatter"
	Rewards: { XP: number, Gold: number }?,

	-- Who it fights. See GameConfig.Factions.
	Faction: string,
	-- What KIND of thing it is, for an attacker's target priority.
	TargetTag: string,
	-- Attack profile it fires, or nil for anything that cannot fight back.
	AttackId: string?,
	-- Which tag it prefers to attack. Only read for an archetype with an
	-- AttackId.
	TargetPriority: string?,
	-- Studs per second. 0 for anything rooted, which is most things.
	MoveSpeed: number?,
}

--[[
	The rock-paper-scissors layer, as data.

	Multipliers[damageType][armourClass]. Reading a row tells you what that
	damage type is for: Siege flattens buildings and crops but is useless
	against troops; Pierce (archers) shreds the unarmoured and glances off heavy
	armour; Melee is the dependable middle.

	Adding a damage type or armour class is a config edit - no combat code
	changes.
]]
--[[
	Who fights whom.

	Player and Hostile are mutually hostile; Neutral fights nobody and nobody
	fights it, which is what makes a practice dummy safe to stand next to a
	tower.

	Player-versus-player is deliberately absent. Two players are not hostile,
	so a tower will never shoot a visitor - and when PvP arrives it needs a
	raid/truce model rather than a third faction, because "are these two at
	war" is a relationship, not a property of either one.
]]
GameConfig.Factions = {
	Player = "Player",
	Hostile = "Hostile",
	Neutral = "Neutral",
}

--[[
	What an attacker goes for, from Clash of Clans' three priorities.

	This is DATA ON THE ARCHETYPE, never a branch in the targeting code: the
	selector reads the tag and the priority and has no idea what a Mill is.
	Adding a siege unit that hunts walls is then a config edit.
]]
GameConfig.TargetPriorities = { "Any", "Defence", "Resource" }

--- What a thing is, for the priorities above to discriminate on.
GameConfig.TargetTags = { "Core", "Defence", "Resource", "Crop", "Unit" }

GameConfig.Combat = {
	DamageTypes = { "Melee", "Pierce", "Siege", "Magic", "Fire", "Ice", "Poison" },
	ArmourClasses = { "Unarmoured", "Light", "Heavy", "Building", "Crop" },

	--[[
		How often attackers look for something to shoot.

		UNLIKE STATUS EFFECTS, this interval is not just precision - it is the
		granularity of the whole fight, because an attack is a discrete event
		rather than an accruing quantity. A stalled loop must NOT let a tower
		bank up shots and fire them all at once: cadence is "has the cooldown
		elapsed", so a tower that was starved of ticks fires once and then
		resumes. Missing damage is the right failure here; a burst of stored
		arrows is not.
	]]
	AttackTickInterval = 0.25,

	--[[
		Half-width of the corridor an attacker scans for something blocking its
		path. Roughly a couple of building footprints, so a wall of defences
		reads as a wall rather than as a line of gaps.
	]]
	BlockingCorridor = 14,

	-- Even a perfectly countered hit lands something. A truly immune target
	-- would make a siege unwinnable rather than merely slow.
	MinimumDamage = 1,

	Multipliers = {
		Melee = { Unarmoured = 1.00, Light = 1.00, Heavy = 0.60, Building = 0.50, Crop = 1.00 },
		Pierce = { Unarmoured = 1.25, Light = 1.00, Heavy = 0.40, Building = 0.25, Crop = 0.75 },
		Siege = { Unarmoured = 0.50, Light = 0.50, Heavy = 0.50, Building = 2.50, Crop = 1.50 },
		Magic = { Unarmoured = 1.00, Light = 1.10, Heavy = 1.10, Building = 0.75, Crop = 1.00 },

		--[[
			The three elemental types exist to carry status effects, so their
			rows are shaped around what the effect is for rather than around
			raw output.

			Fire spreads: good against packed light troops, devastating to
			crops and thatch, poor against stone.
			Ice barely hurts anything - its payload is the Chill slow, and if
			it also hit hard it would have no weakness.
			Poison ignores the *idea* of armour, so Heavy is not discounted,
			but it is meaningless against masonry and only withers a crop.
		]]
		Fire = { Unarmoured = 1.20, Light = 1.30, Heavy = 0.70, Building = 0.60, Crop = 2.00 },
		Ice = { Unarmoured = 0.60, Light = 0.60, Heavy = 0.60, Building = 0.25, Crop = 0.50 },
		Poison = { Unarmoured = 1.40, Light = 1.20, Heavy = 1.00, Building = 0.10, Crop = 0.50 },
	},
}

--------------------------------------------------------------------------------
-- Attack profiles
--------------------------------------------------------------------------------

export type AttackDefinition = {
	Id: string,
	Name: string,
	Range: number, -- studs, measured on the ground plane
	Damage: number, -- before the counter table and armour
	DamageType: string,
	Cooldown: number, -- seconds between shots
	SplashRadius: number?, -- nil for a single-target hit
	SplashMinFraction: number?, -- damage fraction at the blast rim
	StatusEffect: string?, -- applied to everything the shot hits
}

--[[
	What a shot does, separated from what fires it.

	A tower, a combat plant and a raider's club are the same mechanism with
	different numbers, so they share one table and one code path. Giving a new
	defence an attack is then a config edit, which is the test of whether this
	is really data.

	CADENCE IS DERIVED. An attacker stores `LastAttackAt` and compares it
	against `Cooldown`; there is no timer per attacker. A thousand idle towers
	cost one subtraction each.
]]
GameConfig.Attacks = {
	--[[
		The Watch Tower. Pierce, so it shreds raiders and would be a poor
		choice against a building - a tower is not a siege engine.
	]]
	TowerBolt = {
		Id = "TowerBolt",
		Name = "Bolt",
		Range = 60,
		Damage = 22,
		DamageType = "Pierce",
		Cooldown = 1.2,
	},

	--[[
		Ember Bloom: the splash plant. Modest direct damage, but it sets
		everything near the impact alight, so its value rises with how tightly
		packed the horde is.
	]]
	EmberBurst = {
		Id = "EmberBurst",
		Name = "Ember Burst",
		Range = 34,
		Damage = 9,
		DamageType = "Fire",
		Cooldown = 2,
		SplashRadius = 12,
		SplashMinFraction = 0.4,
		StatusEffect = "Burn",
	},

	--[[
		Frost Lily: the support plant. Its damage is almost an afterthought -
		it exists to Chill, which stacks and compounds, and a slowed horde
		spends longer in everything else's range.
	]]
	FrostTouch = {
		Id = "FrostTouch",
		Name = "Frost Touch",
		Range = 30,
		Damage = 3,
		DamageType = "Ice",
		Cooldown = 1.6,
		StatusEffect = "Chill",
	},

	--[[
		Venom Cap: the attrition plant. Poison ignores the idea of armour, so
		this is the answer to anything heavy that a tower's Pierce glances off.
	]]
	VenomSpit = {
		Id = "VenomSpit",
		Name = "Venom Spit",
		Range = 38,
		Damage = 5,
		DamageType = "Poison",
		Cooldown = 2.4,
		StatusEffect = "Poison",
	},

	--[[
		A raider's club. Siege-flavoured because a raid is aimed at buildings;
		it is poor against units, which is why raiders lose to towers but win
		against an undefended base.
	]]
	RaiderClub = {
		Id = "RaiderClub",
		Name = "Club",
		Range = 9,
		Damage = 14,
		DamageType = "Siege",
		Cooldown = 1.5,
	},
} :: { [string]: AttackDefinition }

function GameConfig.GetAttack(attackId: unknown): AttackDefinition?
	if type(attackId) ~= "string" then
		return nil
	end

	return GameConfig.Attacks[attackId]
end

--[[
	Everything that can be damaged, declared in one table.

	Crops regenerate slowly and cannot be repaired. Buildings never regenerate
	and must be repaired with resources - the asymmetry is deliberate and is the
	rule from docs/ROADMAP.md.

	`DestroyBehaviour` of "Shatter" means the entity is NOT removed at zero
	health: it persists in a ruined state and can be rebuilt. That is what the
	Checkpoint needs, so a destroyed Checkpoint is a setback rather than an
	instant loss.
]]
GameConfig.Archetypes = {
	Crop = {
		Id = "Crop",
		Name = "Crop",
		MaxHealth = 100,
		ArmourClass = "Crop",
		Armour = 0,
		-- Tending (water, fertiliser, compost) will multiply this later.
		RegenPerSecond = 0.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Crop",
	},

	TownCenter = {
		Id = "TownCenter",
		Name = "Town Center",
		MaxHealth = 3_000,
		ArmourClass = "Building",
		Armour = 8,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.4, Stone = 0.2 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		-- The thing a raid is ultimately aimed at.
		TargetTag = "Core",
	},

	Farm = {
		Id = "Farm",
		Name = "Farm",
		MaxHealth = 300,
		ArmourClass = "Building",
		Armour = 0,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.2 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	Mill = {
		Id = "Mill",
		Name = "Mill",
		MaxHealth = 1_200,
		ArmourClass = "Building",
		Armour = 4,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.5 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	WatchTower = {
		Id = "WatchTower",
		Name = "Watch Tower",
		MaxHealth = 1_800,
		ArmourClass = "Building",
		Armour = 6,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.3, Stone = 0.5 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Defence",
		-- The tower stops being scenery.
		AttackId = "TowerBolt",
		TargetPriority = "Any",
	},

	Checkpoint = {
		Id = "Checkpoint",
		Name = "Checkpoint",
		MaxHealth = 2_000,
		ArmourClass = "Building",
		Armour = 6,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.4, Stone = 0.4 },
		-- Shattered, not gone: the player can still fight and rebuild.
		DestroyBehaviour = "Shatter",
		Faction = "Player",
		TargetTag = "Core",
	},

	EnemyRaider = {
		Id = "EnemyRaider",
		Name = "Raider",
		MaxHealth = 120,
		ArmourClass = "Light",
		Armour = 1,
		RegenPerSecond = 0,
		Repairable = false,
		DestroyBehaviour = "Remove",
		-- Per level. Gold here lands in the killer's PURSE, which is the only
		-- thing that fills it.
		Rewards = { XP = 12, Gold = 8 },
		Faction = "Hostile",
		TargetTag = "Unit",
		AttackId = "RaiderClub",
		--[[
			"Any" means nearest, which is what makes a tank plant work: the
			raider engages whatever it would walk into first rather than
			picking the squishiest thing on the field.
		]]
		TargetPriority = "Any",
		MoveSpeed = 7,
	},

	--[[
		A raider that goes for the economy instead of the front line. Exists to
		prove the priority is data: nothing in the targeting code mentions
		Mills, it just reads the tag.
	]]
	EnemyLooter = {
		Id = "EnemyLooter",
		Name = "Looter",
		MaxHealth = 90,
		ArmourClass = "Unarmoured",
		Armour = 0,
		RegenPerSecond = 0,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Rewards = { XP = 9, Gold = 12 },
		Faction = "Hostile",
		TargetTag = "Unit",
		AttackId = "RaiderClub",
		TargetPriority = "Resource",
		MoveSpeed = 9,
	},

	--[[
		The practice range's target.

		NEUTRAL, so a tower built nearby ignores it - a range you cannot stand
		a tower next to is not much of a range.

		AND NO REWARDS, which is a bug fix rather than a balance choice. The
		range used to use EnemyRaider, whose kill rewards paid out to whoever
		landed the blow; with a six second respawn that was an endless source
		of purse gold and XP.
	]]
	PracticeDummy = {
		Id = "PracticeDummy",
		Name = "Practice Dummy",
		MaxHealth = 120,
		ArmourClass = "Light",
		Armour = 1,
		RegenPerSecond = 0,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Neutral",
		TargetTag = "Unit",
	},

	--------------------------------------------------------------------------
	-- Combat plants
	--
	-- A combat plant is an archetype plus an attack profile, not a new
	-- system: DamageableService already gives it health, armour and death,
	-- and AttackService already makes things shoot. These are the proof that
	-- the layers underneath are actually reusable.
	--------------------------------------------------------------------------

	EmberBloom = {
		Id = "EmberBloom",
		Name = "Ember Bloom",
		MaxHealth = 140,
		ArmourClass = "Crop",
		Armour = 0,
		-- Combat plants mend themselves slowly, like crops. They are plants.
		RegenPerSecond = 0.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Defence",
		AttackId = "EmberBurst",
		TargetPriority = "Any",
	},

	FrostLily = {
		Id = "FrostLily",
		Name = "Frost Lily",
		MaxHealth = 120,
		ArmourClass = "Crop",
		Armour = 0,
		RegenPerSecond = 0.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Defence",
		AttackId = "FrostTouch",
		TargetPriority = "Any",
	},

	VenomCap = {
		Id = "VenomCap",
		Name = "Venom Cap",
		MaxHealth = 130,
		ArmourClass = "Crop",
		Armour = 0,
		RegenPerSecond = 0.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Defence",
		AttackId = "VenomSpit",
		TargetPriority = "Any",
	},

	--[[
		The tank. No attack at all - its entire job is to be the nearest thing
		a raider wants to hit, and to take a long time about dying.

		Heavy armour class, so a raider's Siege club is poor against it, and
		far more health than anything else that grows.
	]]
	Bulwark = {
		Id = "Bulwark",
		Name = "Bulwark Gourd",
		MaxHealth = 900,
		ArmourClass = "Heavy",
		Armour = 4,
		RegenPerSecond = 1.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Defence",
	},
} :: { [string]: ArchetypeDefinition }

function GameConfig.GetArchetype(archetypeId: unknown): ArchetypeDefinition?
	if type(archetypeId) ~= "string" then
		return nil
	end

	return GameConfig.Archetypes[archetypeId]
end

--------------------------------------------------------------------------------
-- Status effects
--------------------------------------------------------------------------------

export type StatusEffectDefinition = {
	Id: string,
	Name: string,
	Description: string,
	Kind: string, -- "DamageOverTime" | "HealOverTime" | "Debuff"
	DamageType: string?, -- which counter-table row the per-second damage uses
	PerSecond: number, -- damage for DoT, healing for HoT, 0 for a pure debuff
	Duration: number, -- seconds from the most recent application
	MaxStacks: number,
	SpeedMultiplier: number, -- compounds per stack; 1 = no movement effect
	Colour: Color3, -- for the client's effect pips
}

--[[
	Burn, Chill, Poison and Regeneration, declared as data.

	WHY THERE IS A TICK AT ALL
	--------------------------
	Everything else in this project derives state from timestamps and never
	ticks: crop growth, health regeneration, lock expiry. Damage over time
	cannot be purely derived, because the DEATH has to happen whether or not
	anyone is looking. A burning raider that only dies when something queries
	its health is not burning, it is Schrödinger's raider.

	So status effects do tick - but the tick only provides liveness. The AMOUNT
	is still computed from elapsed time:

		damage = PerSecond * Stacks * (now - LastTickAt)

	never `PerSecond * TickInterval`. The difference matters the moment a tick
	is late: a lag spike, a long frame, or a loop that was never scheduled.
	With elapsed time the total dealt over a five second Burn is five seconds'
	worth regardless of how many ticks actually ran; with `PerSecond *
	TickInterval` a server that stutters heals your enemies for free.

	STACKING
	--------
	Re-applying an effect refreshes its expiry and adds a stack up to
	MaxStacks. Damage scales linearly with stacks; SpeedMultiplier compounds,
	so two Chills are 0.65 * 0.65 rather than 0.30.

	NOT PERSISTED
	-------------
	Status effects are session state and are deliberately absent from the data
	schema. Logging out while poisoned cures the poison - which is a mild
	exploit, but the alternative is logging in to find you drowned in a loading
	screen, and that is worse. Revisit if effect durations ever grow past a
	minute.
]]
GameConfig.StatusEffects = {
	Burn = {
		Id = "Burn",
		Name = "Burning",
		Description = "Fierce damage that ends quickly. Ruinous to crops and thatch.",
		Kind = "DamageOverTime",
		DamageType = "Fire",
		PerSecond = 6,
		Duration = 5,
		MaxStacks = 3,
		SpeedMultiplier = 1,
		Colour = Color3.fromRGB(236, 112, 48),
	},

	Poison = {
		Id = "Poison",
		Name = "Poisoned",
		Description = "Weak but long, and armour is no defence against it.",
		Kind = "DamageOverTime",
		DamageType = "Poison",
		PerSecond = 3,
		Duration = 12,
		MaxStacks = 5,
		SpeedMultiplier = 1,
		Colour = Color3.fromRGB(126, 196, 76),
	},

	Chill = {
		Id = "Chill",
		Name = "Chilled",
		Description = "Barely harms, but slows the target to a crawl.",
		Kind = "Debuff",
		DamageType = "Ice",
		PerSecond = 0,
		Duration = 4,
		MaxStacks = 2,
		SpeedMultiplier = 0.65,
		Colour = Color3.fromRGB(120, 196, 236),
	},

	Regeneration = {
		Id = "Regeneration",
		Name = "Regenerating",
		Description = "Mends steadily. Will not revive something already destroyed.",
		Kind = "HealOverTime",
		PerSecond = 4,
		Duration = 8,
		MaxStacks = 1,
		SpeedMultiplier = 1,
		Colour = Color3.fromRGB(132, 222, 158),
	},
}

GameConfig.StatusEffectRules = {
	--[[
		How often the accrual loop runs. This sets the GRANULARITY of damage,
		not its rate - see the note above. Raising it costs accuracy of the
		moment of death and nothing else.

		Timestamps come from os.time(), which is whole seconds, matching the
		clock health and growth already use. Mixing in a higher-resolution
		clock would make `now - DamagedAt` compare two different timebases.
	]]
	TickInterval = 0.5,

	--[[
		A slow floor, for the same reason damage has a floor: a target reduced
		to zero speed is stun-locked, and a stun-lock with no counterplay is
		the movement equivalent of invulnerability.
	]]
	MinimumSpeedMultiplier = 0.25,

	--[[
		Damage over time skips FLAT armour, though it still goes through the
		counter table.

		Armour is subtracted after the multiplier, which makes it worth far
		more against many small hits than one big one. Damage over time is the
		limit case of "many small hits", so charging armour per tick would
		reduce every effect to the MinimumDamage floor and make armoured
		targets immune to fire by accident. The counter-table row is where an
		archetype's resistance to an element belongs.
	]]
	IgnoreFlatArmour = true,
}

function GameConfig.GetStatusEffect(effectId: unknown): StatusEffectDefinition?
	if type(effectId) ~= "string" then
		return nil
	end

	return GameConfig.StatusEffects[effectId]
end

--------------------------------------------------------------------------------
-- Structures (the build tree)
--------------------------------------------------------------------------------

export type StructureDefinition = {
	Id: string,
	Name: string,
	Description: string,
	ArchetypeId: string,
	RequiredAge: number,
	Prerequisites: { string },
	Cost: { [string]: number },
	Size: Vector3,
	Color: Color3,
	MaxPerPlayer: number,
	SortOrder: number,
}

--[[
	The build tree, expressed entirely as data so adding a building is a config
	edit.

	`Prerequisites` means the parent must EXIST somewhere you own - a plain
	dependency check, Town Center before Mill.

	PLACEMENT IS OTHERWISE FREE. Build anywhere, the only restriction being
	that footprints may not overlap. This matches Age of Empires, where
	proximity to a Mill or Lumber Camp is an OPTIMISATION (it shortens villager
	walking time) rather than a rule that forbids placement. An earlier
	revision enforced a radius; that was the city-builder model, not the RTS
	one.

	        TownCenter ──▶ Mill ──▶ Farm
	                   └─▶ WatchTower (Bronze Age)
	        Checkpoint (independent - the respawn anchor)
]]
GameConfig.Structures = {
	TownCenter = {
		Id = "TownCenter",
		Name = "Town Center",
		Description = "The heart of your settlement, and the root of the build tree.",
		ArchetypeId = "TownCenter",
		RequiredAge = 1,
		Prerequisites = {},
		Cost = { Wood = 300, Stone = 100 },
		Size = Vector3.new(16, 10, 16),
		Color = Color3.fromRGB(176, 148, 108),
		MaxPerPlayer = 1,
		SortOrder = 10,
	},

	Checkpoint = {
		Id = "Checkpoint",
		Name = "Checkpoint",
		Description = "Your respawn anchor. If it falls it shatters rather than ending your run.",
		ArchetypeId = "Checkpoint",
		RequiredAge = 1,
		Prerequisites = {},
		Cost = { Wood = 150, Stone = 50 },
		Size = Vector3.new(8, 12, 8),
		Color = Color3.fromRGB(120, 132, 170),
		MaxPerPlayer = 1,
		SortOrder = 20,
	},

	Mill = {
		Id = "Mill",
		Name = "Mill",
		Description = "Processes harvests. Farms must be built within its influence.",
		ArchetypeId = "Mill",
		RequiredAge = 1,
		Prerequisites = { "TownCenter" },
		Cost = { Wood = 100 },
		Size = Vector3.new(12, 8, 12),
		Color = Color3.fromRGB(150, 118, 76),
		MaxPerPlayer = 4,
		SortOrder = 30,
	},

	Farm = {
		Id = "Farm",
		Name = "Farm",
		Description = "Tilled ground. Holds a stack of one crop; requires a Mill in your settlement.",
		ArchetypeId = "Farm",
		RequiredAge = 1,
		Prerequisites = { "Mill" },
		Cost = { Wood = 60 },
		Size = Vector3.new(8, 1, 8),
		Color = Color3.fromRGB(94, 66, 45),
		MaxPerPlayer = 20,
		SortOrder = 40,
		-- The only structure that grows something, so FarmService attaches a
		-- plant/harvest prompt to farms and nothing else.
		HoldsCrop = true,
	},

	WatchTower = {
		Id = "WatchTower",
		Name = "Watch Tower",
		Description = "Defends your settlement. Requires the Bronze Age.",
		ArchetypeId = "WatchTower",
		RequiredAge = 2,
		Prerequisites = { "TownCenter" },
		Cost = { Wood = 50, Stone = 125 },
		Size = Vector3.new(8, 16, 8),
		Color = Color3.fromRGB(142, 146, 152),
		MaxPerPlayer = 6,
		SortOrder = 50,
	},
} :: { [string]: StructureDefinition }

--[[
	Raids.

	SUMMONED, NOT TIMED. Nothing spawns on a clock: a raid happens when the
	player sounds the Raid Horn. Pacing, escalation and the cost of losing
	belong to the Checkpoint and defeat loop, and a timer that attacks a player
	mid-build before any of that exists would be a worse game rather than an
	earlier one. It also means defences can be tested on demand instead of by
	waiting.
]]
GameConfig.Raids = {
	--[[
		One wave's composition. Raiders go for whatever blocks their path;
		Looters ignore defences and head for the Mills and Farms, which is
		what makes a base need depth rather than just a wall.
	]]
	Wave = {
		{ ArchetypeId = "EnemyRaider", Count = 5 },
		{ ArchetypeId = "EnemyLooter", Count = 2 },
	},

	-- How far out they appear, measured from the middle of the base. Well
	-- beyond a tower's 60 stud reach, so a wave is seen coming.
	SpawnDistance = 110,

	--[[
		How often raiders are walked. Distance is speed times ELAPSED time,
		not times this interval, so changing it alters smoothness and nothing
		about how fast a horde crosses the field.
	]]
	MoveTickInterval = 0.25,

	--[[
		How far inside its reach a raider closes before stopping, as a
		fraction. Anything less than 1 leaves a margin, and the margin is what
		stops a raider parking a hair outside its own attack range - where its
		next step is zero and it would stand there forever.
	]]
	EngageFraction = 0.85,
}

--[[
	The player in combat.

	NOT an archetype, deliberately. Everything in GameConfig.Archetypes is
	registered with DamageableService, which owns its health - and a player's
	health is owned by their Humanoid. Two authorities for one number is the
	kind of bug that shows up as health flickering between two values.

	So the engine keeps the player's health, and this supplies only what the
	counter table needs to price a hit against them. A raider's Siege club is
	poor against a person, which is why a raid is survivable in the open and
	ruinous to a base.
]]
GameConfig.PlayerCombat = {
	ArmourClass = "Light",
	Armour = 0,
	TargetTag = "Unit",
	-- Half a character's width, for surface-distance reach.
	BodyRadius = 2,
}

--[[
	Defeat.

	A Checkpoint SHATTERS rather than vanishing: losing it is a setback, not
	the end. The player keeps fighting, and may rebuild the wreck once the
	area is clear. Falling while it lies in ruins is the only thing that ends
	a run, and even that offers a way back.

	The two ways back cost different things on purpose, so the choice is real:
	a Revenge Token, or a cut of the stores. A player with tokens spends one;
	a player without pays in resources and feels the raid.
]]
GameConfig.Defeat = {
	--[[
		Hostiles within this of the wreck block the rebuild prompt.

		"Survive and secure the area" from docs/ROADMAP.md: rebuilding under
		fire would make the shattered state meaningless, because the player
		would simply tank the raid and tap the prompt.
	]]
	SecureRadius = 55,

	--[[
		Fraction of each TREASURY resource the raiders carry off on a
		surrender.

		The personal purse is untouched, and that is the same rule as
		everywhere else: the purse is filled by kills and loot alone and
		nothing reaches into it. A defeat costs you the settlement's stores,
		not what you are carrying.
	]]
	SurrenderLoss = 0.25,

	-- Tokens one "fight on" costs.
	FightOnTokenCost = 1,
}

GameConfig.Placement = {
	--[[
		The tile the world is built on, in studs.

		Age of Empires is a tile grid: every building occupies a whole number
		of tiles and lands aligned to them, which is why farms there form an
		unbroken quilt instead of a scatter with slivers between. Every
		structure's footprint here is asserted to be a whole number of tiles,
		so any two of them can sit flush.

		This is also the snap tolerance: aim within half a tile of flush and
		the structure locks to it.
	]]
	GridSize = 4,

	--[[
		Zero: structures may touch.

		A gap was the old rule, to stop bases becoming a solid block. But a
		farm quilt IS a solid block, and that is the point - AoE lets you build
		walls and farms flush. Blocking it meant every farm was ringed by a
		two-stud alley, which is exactly the look the grid is meant to remove.

		Kept as config because "bases cannot be impenetrable" may come back as
		a rule about walls and gates, which is where it actually belongs.

		PAIRED WITH THE FOOTPRINT SIZES. Every structure grew two studs when
		this went to zero, which leaves each pair's required separation exactly
		where the old gap put it. Raising this again without shrinking them
		back makes bases sprawl and will refuse layouts that used to fit.
	]]
	MinimumGap = 0,

	-- Half-extent of the buildable world, inside the baseplate.
	WorldLimit = 240,

	-- Structures sit on the ground plane.
	GroundY = 0,

	RequestsPerSecond = 4,
	BurstSize = 6,
}

--[[
	Snaps a placement centre onto the build grid.

	Snapped by the footprint's MIN CORNER rather than its centre, and the
	difference matters. A structure two tiles wide has its centre on a tile
	boundary; one three tiles wide has its centre in the middle of a tile. Snap
	centres to the grid and those two can never sit flush - the even ones end
	up half a tile out from the odd ones. Snap corners and every footprint
	tiles with every other, whatever its size.

	Lives in config, not in the placement service, because the client's ghost
	has to reach the same answer. Two implementations of this would drift and
	the preview would start lying about where the building lands.
]]
function GameConfig.SnapPlacement(structure: StructureDefinition, x: number, z: number): (number, number)
	local grid = GameConfig.Placement.GridSize

	local function snap(value: number, halfExtent: number): number
		local corner = value - halfExtent
		return math.floor(corner / grid + 0.5) * grid + halfExtent
	end

	return snap(x, structure.Size.X / 2), snap(z, structure.Size.Z / 2)
end

function GameConfig.GetStructure(structureId: unknown): StructureDefinition?
	if type(structureId) ~= "string" then
		return nil
	end

	return GameConfig.Structures[structureId]
end

--- Structures in display order, for the build menu.
function GameConfig.GetStructureList(): { StructureDefinition }
	local list = {}

	for _, structure in GameConfig.Structures do
		table.insert(list, structure)
	end

	table.sort(list, function(a, b)
		if a.SortOrder == b.SortOrder then
			return a.Id < b.Id
		end
		return a.SortOrder < b.SortOrder
	end)

	return list
end

--------------------------------------------------------------------------------
-- Shop
--------------------------------------------------------------------------------

GameConfig.Shop = {
	-- Per-request caps. These bound the arithmetic as much as the economy:
	-- without them a client could ask for 1e15 items and push intermediate
	-- products past the exact-integer range.
	MaxBuyAmount = 100,
	MaxSellAmount = 9_999,

	-- Token bucket for the transaction remote. Burst allows normal rapid
	-- clicking; the rate caps sustained throughput.
	RequestsPerSecond = 8,
	BurstSize = 12,

	--[[
		Market resource trading, Age of Empires style: Gold converts to the
		construction resources and back.

		Without this the economy is a dead end. Selling produce earns Gold, but
		building costs Wood and Stone and aging up costs Food, and none of those
		had any income source at all.

		BuyRate is deliberately higher than SellRate, so round-tripping a
		resource LOSES value and trading can never become an arbitrage loop.
		Gold is excluded - it cannot be traded for itself.
	]]
	ResourceTrade = {
		-- Gold paid per unit bought from the market.
		BuyRate = { Food = 2, Wood = 2, Stone = 3 },
		-- Gold received per unit sold to the market.
		SellRate = { Food = 1, Wood = 1, Stone = 1 },
		MaxTradeAmount = 10_000,
	},

	-- Physical storefront
	NpcName = "ShopNPC",
	NpcTitle = "General Store",
	NpcPosition = Vector3.new(0, 3, -34),
	NpcSize = Vector3.new(4, 6, 4),
	NpcColor = Color3.fromRGB(196, 164, 112),
	PromptActionText = "Browse",
	PromptMaxDistance = 12,
}

--- Valid ProcessTransaction action types.
GameConfig.TransactionActions = { Buy = "Buy", Sell = "Sell" }

--------------------------------------------------------------------------------
-- Replicated attribute names
--------------------------------------------------------------------------------

-- Centralised so server writers and client readers can never drift apart.
GameConfig.Attributes = {
	-- Base treasury, one attribute per resource id (Food/Wood/Gold/Stone).
	-- Written from GameConfig.Resources, so a new resource needs no code here.
	InventoryGold = "InventoryGold",
	Age = "Age",
	AgeName = "AgeName",
	Level = "Level",
	XP = "XP",
	XPToNextLevel = "XPToNextLevel",
	DataLoaded = "DataLoaded",
	SelectedSeed = "SelectedSeed",
	RevengeTokens = "RevengeTokens",

	--[[
		True while the player is down and has not chosen how to come back.
		Replicated rather than announced, so the panel is correct for a client
		that joins, rejoins or reconnects mid-defeat.
	]]
	Defeated = "Defeated",
	TargetFarm = "TargetFarm", -- instance id a boost purchase applies to
}

--[[
	Published on every damageable entity's model. Clients derive current health
	from these with Shared.Combat, so a health bar needs no remote and no
	per-frame updates - exactly like crop growth derives from PlantedAt.
]]
GameConfig.HealthAttributes = {
	MaxHealth = "MaxHealth",
	HealthBase = "HealthBase",
	DamagedAt = "DamagedAt",
	RegenPerSecond = "RegenPerSecond",
	ArmourClass = "ArmourClass",
	Shattered = "Shattered",
}

--[[
	Published on a Farm structure holding a crop. Clients derive the growth
	stage and countdown from these, so a farm needs no remote traffic.

	`Locked` and `UnlockLevel` are gone with the fixed garden: a farm exists
	because the player built it, so there is nothing to unlock.
]]
GameConfig.FarmAttributes = {
	SeedId = "SeedId", -- "" when fallow
	PlantedAt = "PlantedAt",
	ReadyAt = "ReadyAt",
	Stage = "Stage",
	-- How many plants are in the square, and how many would fit. Both are
	-- published so a client can draw "5/9" without consulting the plantable.
	PlantCount = "PlantCount", -- 0 when fallow
	PlantCapacity = "PlantCapacity", -- 0 when fallow
}

-- A single flat folder now: one attribute per item id, no category subfolders.
GameConfig.InventoryFolderName = "Inventory"
GameConfig.StructuresFolderName = "Structures"
GameConfig.RaidersFolderName = "Raiders"

GameConfig.StructureAttributes = {
	OwnerUserId = "OwnerUserId",
	StructureId = "StructureId",
	InstanceId = "InstanceId",
}

--[[
	A folder on the Player holding one attribute per structure id, counting how
	many that player owns.

	The build menu reads its counts from here rather than scanning Workspace.
	Scanning raced replication: a newly placed model can arrive on the client
	before its OwnerUserId attribute does, so the menu counted it as unowned and
	kept showing the next building as locked until reopened.
]]
GameConfig.StructureCountsFolderName = "StructureCounts"

GameConfig.RemoteNames = {
	SelectSeed = "SelectSeed",

	--[[
		How a defeated player answers. A function, not an event: spending a
		Revenge Token can fail (none left) and the player has to be told,
		rather than left looking at a panel that did nothing.
	]]
	ResolveDefeat = "ResolveDefeat",
	UseBoost = "UseBoost",
	SelectFarm = "SelectFarm",

	--[[
		Server -> client, fire and forget: a shot was taken, draw it.

		Combat is otherwise completely silent to look at. Health and status
		effects are derived from replicated attributes and need no traffic, but
		a shot is an EVENT with no state behind it - once it has landed there
		is nothing left on either entity that says it happened, so there is
		nothing for a client to derive it from.
	]]
	CombatEffect = "CombatEffect",

	-- Client asks to advance an age. The server owns the cost and the check.
	AdvanceAge = "AdvanceAge",

	-- RemoteFunctions
	ProcessTransaction = "ProcessTransaction",
	SellAll = "SellAll",
	TradeResource = "TradeResource",
	PlaceStructure = "PlaceStructure",
	DemolishStructure = "DemolishStructure",

	-- Client asks the server to open a Robux dialog BY PRODUCT NAME, so
	-- Developer Product ids never leave the server.
	PromptPurchase = "PromptPurchase",
}

--------------------------------------------------------------------------------
-- Monetization
--------------------------------------------------------------------------------

export type ProductDefinition = {
	Kind: string, -- handler key; several products may share one Kind
	ProductId: number, -- 0 = unconfigured, never resolves
	DisplayName: string,
	Description: string, -- shown in the store panel
	Resource: string?, -- for Kind == "Resource"
	Amount: number,
	SortOrder: number, -- store display order
	Name: string?, -- table key, filled in by GetStoreProducts
}

GameConfig.Monetization = {
	--[[
		Developer Products, Clash-of-Clans shaped: resource packs, instant
		finishes, permanent unlocks, and the revenge continue.

		REPLACE EVERY ProductId with the real id from the Creator Dashboard
		(Monetization -> Developer Products). An id of 0 never resolves, and
		MarketplaceService warns at startup listing which are unconfigured.

		Several products may share a Kind - every resource pack uses the one
		"Resource" handler and differs only in Resource and Amount. Adding a
		bigger pack is a config edit with no new code.
	]]
	Products = {
		GoldPackSmall = {
			Kind = "Resource",
			Resource = "Gold",
			ProductId = 0,
			DisplayName = "Pouch of Gold",
			Description = "2,500 Gold for the treasury.",
			Amount = 2_500,
			SortOrder = 10,
		},
		GoldPackLarge = {
			Kind = "Resource",
			Resource = "Gold",
			ProductId = 0,
			DisplayName = "Chest of Gold",
			Description = "15,000 Gold for the treasury.",
			Amount = 15_000,
			SortOrder = 20,
		},
		FoodPack = {
			Kind = "Resource",
			Resource = "Food",
			ProductId = 0,
			DisplayName = "Granary Delivery",
			Description = "3,000 Food for training and aging up.",
			Amount = 3_000,
			SortOrder = 22,
		},
		WoodPack = {
			Kind = "Resource",
			Resource = "Wood",
			ProductId = 0,
			DisplayName = "Timber Shipment",
			Description = "3,000 Wood for construction.",
			Amount = 3_000,
			SortOrder = 24,
		},
		StonePack = {
			Kind = "Resource",
			Resource = "Stone",
			ProductId = 0,
			DisplayName = "Quarry Shipment",
			Description = "2,000 Stone for walls and towers.",
			Amount = 2_000,
			SortOrder = 26,
		},
		GrowthBoost = {
			Kind = "GrowthBoost",
			ProductId = 0,
			DisplayName = "Instant Grow",
			Description = "Finishes one growing crop immediately.",
			Amount = 1,
			SortOrder = 30,
		},
		GrowthBoostBundle = {
			Kind = "GrowthBoost",
			ProductId = 0,
			DisplayName = "Instant Grow x10",
			Description = "Ten instant finishes, kept until you need them.",
			Amount = 10,
			SortOrder = 40,
		},
		RevengeToken = {
			Kind = "RevengeToken",
			ProductId = 0,
			DisplayName = "+1 Revenge Token",
			Description = "One more chance to retake your ground after a defeat.",
			Amount = 1,
			SortOrder = 60,
		},
	} :: { [string]: ProductDefinition },

	GrowthBoostItemId = "GrowthBoost",
	MaxPurchaseHistory = 100,
}

-- Kind is a handler key, not a unique name: several products deliberately
-- share one, differing only in Amount.
for name, product in GameConfig.Monetization.Products do
	assert(product.Amount > 0, `product {name} must grant a positive amount`)
	assert(product.Description ~= nil and product.Description ~= "", `product {name} needs a Description`)

	if product.Kind == "Resource" then
		assert(
			GameConfig.Resources[product.Resource] ~= nil,
			`product {name} grants unknown resource {tostring(product.Resource)}`
		)
	end
end

--- Products for the store panel, in display order. Stamps each with its table
--- key as `Name`, which is what the client sends back to request a purchase.
function GameConfig.GetStoreProducts(): { ProductDefinition }
	local products = {}

	for name, product in GameConfig.Monetization.Products do
		product.Name = name
		table.insert(products, product)
	end

	table.sort(products, function(a, b)
		if a.SortOrder == b.SortOrder then
			return a.DisplayName < b.DisplayName
		end
		return a.SortOrder < b.SortOrder
	end)

	return products
end

--- Resolves a product by its table key (not its id), for when the client asks
--- for a purchase dialog by name.
function GameConfig.GetProductByName(name: unknown): ProductDefinition?
	if type(name) ~= "string" then
		return nil
	end

	return GameConfig.Monetization.Products[name]
end

--- Resolves an untrusted ProductId from a receipt. Returns nil for unknown or
--- unconfigured (id <= 0) products, which the caller MUST treat as "do not grant".
function GameConfig.GetProductById(productId: unknown): ProductDefinition?
	if type(productId) ~= "number" then
		return nil
	end

	for _, product in GameConfig.Monetization.Products do
		if product.ProductId > 0 and product.ProductId == productId then
			return product
		end
	end

	return nil
end

--- Reports configuration problems for startup logging.
function GameConfig.ValidateProducts(): ({ string }, { string })
	local unconfigured, duplicates = {}, {}
	local seen: { [number]: string } = {}

	for name, product in GameConfig.Monetization.Products do
		if product.ProductId <= 0 then
			table.insert(unconfigured, name)
		elseif seen[product.ProductId] then
			table.insert(duplicates, `{name} and {seen[product.ProductId]} both use ProductId {product.ProductId}`)
		else
			seen[product.ProductId] = name
		end
	end

	table.sort(unconfigured)
	table.sort(duplicates)

	return unconfigured, duplicates
end

--------------------------------------------------------------------------------
-- Config self-checks (fail loudly at require time, not mid-session)
--------------------------------------------------------------------------------

do
	local stages = GameConfig.Growth.Stages
	assert(#stages > 0, "GameConfig.Growth.Stages must not be empty")
	assert(stages[1].Threshold == 0, "the first growth stage must start at 0")
	assert(stages[#stages].Threshold == 1, "the final growth stage must start at 1.0")
	assert(stages[#stages].Id == GameConfig.Growth.MatureStage, "the final growth stage must be MatureStage")

	for index = 2, #stages do
		assert(stages[index].Threshold > stages[index - 1].Threshold, "growth stage thresholds must ascend")
	end
end

for id, item in GameConfig.Items do
	assert(item.Id == id, `item {id} has a mismatched Id field`)
	-- Item ids double as attribute names for inventory replication.
	assert(id:match("^[%a_][%w_]*$") ~= nil, `item id {id} is not a legal attribute name`)
	assert(GameConfig.IsValidCategory(item.Category), `item {id} has an unknown category {item.Category}`)
	assert(item.MaxStack > 0, `item {id} must have a positive MaxStack`)
	assert(item.BuyPrice == nil or item.BuyPrice > 0, `item {id} has a non-positive BuyPrice`)
	assert(item.SellPrice == nil or item.SellPrice > 0, `item {id} has a non-positive SellPrice`)
end

for id, size in GameConfig.PlantSizes do
	assert(size.Id == id, `plant size {id} has a mismatched Id field`)
	assert(size.PerFarm >= 1, `plant size {id} must fit at least one plant per farm`)
	assert(size.VisualScale > 0, `plant size {id} must have a positive VisualScale`)

	--[[
		Capped because the count is also a LAYOUT: the farm renders its plants
		on a grid, and past about this many on an eight stud square they stop
		being distinguishable from a green smear.
	]]
	assert(size.PerFarm <= 16, `plant size {id} packs {size.PerFarm} per farm, which cannot be rendered legibly`)
end

for seedId, plantable in GameConfig.Plantables do
	assert(plantable.SeedId == seedId, `plantable {seedId} has a mismatched SeedId field`)
	assert(plantable.GrowTime > 0, `plantable {seedId} must have a positive GrowTime`)
	assert(
		GameConfig.PlantSizes[plantable.PlantSize] ~= nil,
		`plantable {seedId} has unknown PlantSize {tostring(plantable.PlantSize)}`
	)

	local seedItem = GameConfig.Items[seedId]
	assert(seedItem ~= nil, `plantable {seedId} has no matching item in the directory`)
	assert(seedItem.Category == "Seeds", `plantable {seedId} must reference an item in the Seeds category`)

	local archetypeId = GameConfig.GetPlantArchetypeId(seedId)
	assert(
		GameConfig.Archetypes[archetypeId] ~= nil,
		`plantable {seedId} grows into unknown archetype {tostring(archetypeId)}`
	)

	if plantable.Harvestable == false then
		--[[
			A kept plant - a defence - must have no yield at all. Leaving a
			Yields on one would be silently dead config: the harvest path can
			never run for it, so the yield would read as working and never
			pay out.
		]]
		assert(plantable.Yields == nil, `kept plantable {seedId} must not declare a Yields`)
		assert(plantable.YieldAmount == nil, `kept plantable {seedId} must not declare a YieldAmount`)

		--[[
			And it has to actually do something, or it is a square the player
			spent on nothing. A defence either attacks or soaks damage.
		]]
		local archetype = GameConfig.Archetypes[archetypeId]
		assert(
			archetype.AttackId ~= nil or archetype.MaxHealth >= 500,
			`kept plantable {seedId} neither attacks nor has the health to tank, so it does nothing`
		)
	else
		assert(plantable.YieldAmount > 0, `plantable {seedId} must yield a positive amount`)

		local yieldItem = GameConfig.Items[plantable.Yields]
		assert(yieldItem ~= nil, `plantable {seedId} yields unknown item {tostring(plantable.Yields)}`)
		assert(
			GameConfig.IsSellable(yieldItem),
			`plantable {seedId} yields {plantable.Yields}, which has no SellPrice - the crop would be worthless`
		)
	end
end

for id, attack in GameConfig.Attacks do
	assert(attack.Id == id, `attack {id} has a mismatched Id field`)
	assert(attack.Range > 0, `attack {id} must have a positive Range`)
	assert(attack.Damage > 0, `attack {id} must deal damage`)
	assert(attack.Cooldown > 0, `attack {id} must have a positive Cooldown, or it would fire every tick`)
	assert(
		table.find(GameConfig.Combat.DamageTypes, attack.DamageType) ~= nil,
		`attack {id} names unknown damage type {tostring(attack.DamageType)}`
	)

	if attack.StatusEffect then
		assert(
			GameConfig.StatusEffects[attack.StatusEffect] ~= nil,
			`attack {id} applies unknown status effect {attack.StatusEffect}`
		)
	end

	if attack.SplashRadius then
		assert(attack.SplashRadius > 0, `attack {id} has a non-positive SplashRadius`)
		assert(
			attack.SplashMinFraction ~= nil
				and attack.SplashMinFraction > 0
				and attack.SplashMinFraction <= 1,
			`attack {id} needs a SplashMinFraction in (0, 1] so its blast rim is not a no-op`
		)

		--[[
			A blast wider than the attack can reach would hit things the
			attacker cannot see, which reads as being shot from nowhere.
		]]
		assert(
			attack.SplashRadius <= attack.Range,
			`attack {id} splashes further ({attack.SplashRadius}) than it reaches ({attack.Range})`
		)
	end
end

for id, structure in GameConfig.Structures do
	assert(structure.Id == id, `structure {id} has a mismatched Id field`)

	--[[
		Footprints must be a whole number of tiles, or the structure cannot sit
		flush against its neighbours and the grid stops meaning anything. A
		farm quilt with slivers in it is the symptom, and it is a confusing one
		to trace back to a Size field.
	]]
	for _, axis in { "X", "Z" } do
		local extent = structure.Size[axis]
		assert(
			extent % GameConfig.Placement.GridSize == 0,
			`structure {id} is {extent} studs on {axis}, which is not a whole number of `
				.. `{GameConfig.Placement.GridSize} stud tiles`
		)
	end
	assert(GameConfig.Archetypes[structure.ArchetypeId] ~= nil, `structure {id} names unknown archetype`)
	assert(structure.MaxPerPlayer > 0, `structure {id} must allow at least one`)
	assert(structure.RequiredAge >= 1 and structure.RequiredAge <= #GameConfig.Ages, `structure {id} has a bad age`)

	for resourceId in structure.Cost do
		assert(GameConfig.Resources[resourceId] ~= nil, `structure {id} costs unknown resource {resourceId}`)
	end

	-- A prerequisite or radius parent that does not exist would make the
	-- structure permanently unbuildable, which is worse than a loud failure.
	for _, prerequisiteId in structure.Prerequisites do
		assert(GameConfig.Structures[prerequisiteId] ~= nil, `structure {id} requires unknown structure {prerequisiteId}`)
	end
end

for id, archetype in GameConfig.Archetypes do
	assert(archetype.Id == id, `archetype {id} has a mismatched Id field`)
	assert(archetype.MaxHealth > 0, `archetype {id} must have positive MaxHealth`)
	assert(
		table.find(GameConfig.Combat.ArmourClasses, archetype.ArmourClass) ~= nil,
		`archetype {id} has unknown armour class {archetype.ArmourClass}`
	)
	assert(
		archetype.DestroyBehaviour == "Remove" or archetype.DestroyBehaviour == "Shatter",
		`archetype {id} has unknown DestroyBehaviour {tostring(archetype.DestroyBehaviour)}`
	)

	assert(
		GameConfig.Factions[archetype.Faction] ~= nil,
		`archetype {id} has unknown Faction {tostring(archetype.Faction)}`
	)
	assert(
		table.find(GameConfig.TargetTags, archetype.TargetTag) ~= nil,
		`archetype {id} has unknown TargetTag {tostring(archetype.TargetTag)}`
	)

	if archetype.AttackId then
		assert(
			GameConfig.Attacks[archetype.AttackId] ~= nil,
			`archetype {id} fires unknown attack {archetype.AttackId}`
		)

		--[[
			An attacker with no priority would fall through the selector and
			pick nothing, so it would stand there holding a loaded weapon.
		]]
		assert(
			table.find(GameConfig.TargetPriorities, archetype.TargetPriority) ~= nil,
			`attacking archetype {id} has unknown TargetPriority {tostring(archetype.TargetPriority)}`
		)
	end

	if archetype.MoveSpeed then
		assert(archetype.MoveSpeed >= 0, `archetype {id} cannot have a negative MoveSpeed`)
	end

	if archetype.Repairable then
		assert(archetype.RepairCostPerHealth ~= nil, `repairable archetype {id} needs RepairCostPerHealth`)

		for resourceId in archetype.RepairCostPerHealth do
			assert(
				GameConfig.Resources[resourceId] ~= nil,
				`archetype {id} repair cost names unknown resource {resourceId}`
			)
		end
	end
end

-- Every damage type must price every armour class, or a missing pairing would
-- silently fall back to unmodified damage and quietly break the counter system.
for _, damageType in GameConfig.Combat.DamageTypes do
	local row = GameConfig.Combat.Multipliers[damageType]
	assert(row ~= nil, `damage type {damageType} has no multiplier row`)

	for _, armourClass in GameConfig.Combat.ArmourClasses do
		assert(row[armourClass] ~= nil, `damage type {damageType} is missing a multiplier for {armourClass}`)
	end
end

for id, effect in GameConfig.StatusEffects do
	assert(effect.Id == id, `status effect {id} has a mismatched Id field`)

	-- Effect ids become attribute names on the model, so the client can read
	-- them without a parser.
	assert(id:match("^[%a_][%w_]*$") ~= nil, `status effect id {id} is not a legal attribute name`)

	assert(
		effect.Kind == "DamageOverTime" or effect.Kind == "HealOverTime" or effect.Kind == "Debuff",
		`status effect {id} has unknown Kind {tostring(effect.Kind)}`
	)

	-- A zero or negative duration would expire in the same instant it was
	-- applied, which reads as "the effect does nothing" and is impossible to
	-- debug from the symptom.
	assert(effect.Duration > 0, `status effect {id} must last longer than zero seconds`)
	assert(effect.MaxStacks >= 1, `status effect {id} must allow at least one stack`)
	assert(effect.PerSecond >= 0, `status effect {id} must not have a negative rate`)

	if effect.Kind == "DamageOverTime" then
		assert(effect.PerSecond > 0, `damage-over-time effect {id} deals no damage`)
		assert(
			effect.DamageType ~= nil and table.find(GameConfig.Combat.DamageTypes, effect.DamageType) ~= nil,
			`status effect {id} names unknown damage type {tostring(effect.DamageType)}`
		)
	end

	if effect.Kind == "HealOverTime" then
		assert(effect.PerSecond > 0, `heal-over-time effect {id} heals nothing`)
	end

	assert(
		effect.SpeedMultiplier > 0 and effect.SpeedMultiplier <= 1,
		`status effect {id} must have a SpeedMultiplier in (0, 1]`
	)

	--[[
		A pure debuff that neither damages nor slows is inert, and the only way
		to notice is that the effect visibly does nothing in play.
	]]
	if effect.Kind == "Debuff" then
		assert(
			effect.SpeedMultiplier < 1,
			`debuff {id} neither damages nor slows, so it has no effect at all`
		)
	end
end

do
	local rules = GameConfig.StatusEffectRules

	assert(rules.TickInterval > 0, "StatusEffectRules.TickInterval must be positive")

	-- Two ticks per second of the shortest effect, so the moment of death is
	-- never more than a visible fraction late.
	local shortest = math.huge
	for _, effect in GameConfig.StatusEffects do
		shortest = math.min(shortest, effect.Duration)
	end
	assert(
		rules.TickInterval <= shortest / 2,
		`StatusEffectRules.TickInterval ({rules.TickInterval}) is too coarse for the shortest effect ({shortest}s)`
	)

	assert(
		rules.MinimumSpeedMultiplier > 0 and rules.MinimumSpeedMultiplier <= 1,
		"StatusEffectRules.MinimumSpeedMultiplier must be in (0, 1]"
	)
end

do
	local total = 0

	for _, entry in GameConfig.Raids.Wave do
		local archetype = GameConfig.Archetypes[entry.ArchetypeId]

		assert(archetype ~= nil, `raid wave names unknown archetype {tostring(entry.ArchetypeId)}`)
		assert(
			archetype.Faction == GameConfig.Factions.Hostile,
			`raid wave includes {entry.ArchetypeId}, which is not Hostile - it would attack nothing`
		)

		--[[
			A raider that cannot move never arrives, and one that cannot
			attack arrives and stands there. Either way the wave is a no-op
			that looks like a bug in targeting.
		]]
		assert((archetype.MoveSpeed or 0) > 0, `raid wave includes {entry.ArchetypeId}, which cannot move`)
		assert(archetype.AttackId ~= nil, `raid wave includes {entry.ArchetypeId}, which cannot attack`)

		assert(entry.Count > 0, `raid wave entry {entry.ArchetypeId} must bring at least one`)
		total += entry.Count
	end

	assert(total > 0, "the raid wave is empty")

	--[[
		Raiders must appear beyond the reach of anything that shoots, or a wave
		would spawn already under fire and the player would never see it coming.
	]]
	local longestRange = 0

	for _, attack in GameConfig.Attacks do
		longestRange = math.max(longestRange, attack.Range)
	end

	assert(
		GameConfig.Raids.EngageFraction > 0 and GameConfig.Raids.EngageFraction < 1,
		"Raids.EngageFraction must be in (0, 1): at 1 a raider can park outside its own reach"
	)

	assert(
		GameConfig.Raids.SpawnDistance > longestRange,
		`raiders spawn {GameConfig.Raids.SpawnDistance} studs out, inside the longest `
			.. `attack range ({longestRange}) - a wave would arrive already under fire`
	)
end

do
	local defeat = GameConfig.Defeat

	assert(defeat.SecureRadius > 0, "Defeat.SecureRadius must be positive")

	--[[
		A loss of zero makes surrender free, and the choice between it and a
		Revenge Token stops being a choice. A loss of one empties the
		treasury, which is the kind of punishment players quit over.
	]]
	assert(
		defeat.SurrenderLoss > 0 and defeat.SurrenderLoss < 1,
		"Defeat.SurrenderLoss must be in (0, 1): at 0 surrender is free, at 1 it is total"
	)

	assert(defeat.FightOnTokenCost >= 1, "fighting on must cost at least one token")

	assert(
		table.find(GameConfig.Combat.ArmourClasses, GameConfig.PlayerCombat.ArmourClass) ~= nil,
		`PlayerCombat has unknown armour class {tostring(GameConfig.PlayerCombat.ArmourClass)}`
	)
	assert(
		table.find(GameConfig.TargetTags, GameConfig.PlayerCombat.TargetTag) ~= nil,
		`PlayerCombat has unknown TargetTag {tostring(GameConfig.PlayerCombat.TargetTag)}`
	)

	--[[
		Something must shatter, or there is no shattered state to be caught in
		and the whole defeat loop is unreachable.
	]]
	local shatters = false

	for _, archetype in GameConfig.Archetypes do
		if archetype.DestroyBehaviour == "Shatter" then
			shatters = true
		end
	end

	assert(shatters, "no archetype shatters, so a player can never be caught without an anchor")
end

for index, age in GameConfig.Ages do
	assert(age.Index == index, `age {index} has a mismatched Index field`)

	for resourceId in age.AdvanceCost do
		assert(GameConfig.Resources[resourceId] ~= nil, `age {age.Name} costs unknown resource {resourceId}`)
	end
end

for resourceId, amount in GameConfig.StartingResources do
	assert(GameConfig.Resources[resourceId] ~= nil, `StartingResources references unknown resource {resourceId}`)
	assert(amount >= 0, `StartingResources entry {resourceId} must not be negative`)
end

for resourceId in GameConfig.Resources do
	-- Resource ids double as attribute names on the player.
	assert(resourceId:match("^[%a_][%w_]*$") ~= nil, `resource id {resourceId} is not a legal attribute name`)
end

assert(
	GameConfig.Resources[GameConfig.PrimaryResource] ~= nil,
	"GameConfig.PrimaryResource must name a real resource"
)

do
	local trade = GameConfig.Shop.ResourceTrade

	for resourceId, buyRate in trade.BuyRate do
		assert(GameConfig.Resources[resourceId] ~= nil, `trade BuyRate names unknown resource {resourceId}`)
		assert(
			resourceId ~= GameConfig.PrimaryResource,
			`{resourceId} is the primary currency and cannot be traded for itself`
		)

		local sellRate = trade.SellRate[resourceId]
		assert(sellRate ~= nil, `trade BuyRate for {resourceId} has no matching SellRate`)

		-- If selling paid as much as buying cost, a player could round-trip a
		-- resource forever at no loss, and with rounding could gain.
		assert(
			buyRate > sellRate,
			`trade rates for {resourceId} must lose value on a round trip (buy {buyRate} > sell {sellRate})`
		)
	end

	for resourceId in trade.SellRate do
		assert(trade.BuyRate[resourceId] ~= nil, `trade SellRate for {resourceId} has no matching BuyRate`)
	end

	--[[
		The cold-start guarantee: a fresh player's starting resources must cover
		their first farm. Asserted at require time so a cost or starting-amount
		edit cannot quietly reintroduce the softlock.
	]]
	local firstFarmCost = {}

	for _, structureId in { "TownCenter", "Mill", "Farm" } do
		for resourceId, amount in GameConfig.Structures[structureId].Cost do
			firstFarmCost[resourceId] = (firstFarmCost[resourceId] or 0) + amount
		end
	end

	for resourceId, needed in firstFarmCost do
		local starting = GameConfig.StartingResources[resourceId] or 0
		assert(
			starting >= needed,
			`a fresh player cannot reach their first farm: needs {needed} {resourceId}, starts with {starting}`
		)
	end
end

for itemId, amount in GameConfig.StarterKit do
	assert(GameConfig.Items[itemId] ~= nil, `StarterKit references unknown item {itemId}`)
	assert(amount > 0, `StarterKit entry {itemId} must be positive`)

	--[[
		A starting seed must arrive in square-filling quantity. Hand out fewer
		than a square holds and the player's first action plants a sparse
		square they can never top up, which looks like the farm is broken.
	]]
	local capacity = GameConfig.GetPlantCapacity(itemId)

	if capacity > 0 then
		assert(
			amount >= capacity,
			`StarterKit gives {amount} {itemId} but a square holds {capacity}, `
				.. `so the first planting cannot fill one`
		)
	end
end

table.freeze(GameConfig.Attributes)
table.freeze(GameConfig.FarmAttributes)
table.freeze(GameConfig.RemoteNames)
table.freeze(GameConfig.ItemCategories)
table.freeze(GameConfig.HealthAttributes)
table.freeze(GameConfig.StructureAttributes)
table.freeze(GameConfig.Interaction)
table.freeze(GameConfig.TransactionActions)
table.freeze(GameConfig.StatusEffectRules)
table.freeze(GameConfig.PlantSizes)
table.freeze(GameConfig.Factions)
table.freeze(GameConfig.Raids)
table.freeze(GameConfig.Defeat)
table.freeze(GameConfig.PlayerCombat)

return GameConfig

