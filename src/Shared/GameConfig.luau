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
	  Animals    - husbandry behaviour, keyed by LIVESTOCK item id. Carries
	               MatureTime, feed, what it produces and what it yields when
	               slaughtered.

	Plantables and Animals are the same shape on purpose: a seed and a chick
	are both an item you buy, consume into a structure, and wait on. Keying
	husbandry by the livestock item rather than by a separate "animal id" is
	what let the shop, the inventory and the level gate carry over unchanged.

	Future mechanics follow the same pattern and touch nothing above:

	  Recipes    - crafting, keyed by output item id, `Inputs = {...}`
	  Structures - RTS/survival building, keyed by structure id, `Cost = {...}`

	The rule that keeps this scalable: **storage is flat, categorisation is
	metadata**. Inventories are keyed by item id alone, and `Category` exists
	for grouping in UI and queries - never for addressing storage. Adding
	"AnimalDrops" therefore required no inventory change at all.
]]

export type Rarity = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary"

export type ItemCategory = "Seeds" | "Livestock" | "Crops" | "AnimalDrops" | "Boosts"

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
GameConfig.FrameworkVersion = 15

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

--[[
	Display order for category tabs in the shop UI.

	Livestock sits next to Seeds because they are the two things you BUY to
	put into a structure, and the two categories the shop sells rather than
	buys. The clients build their tabs by iterating this list, so adding a
	category needed no client change.
]]
GameConfig.ItemCategories = { "Seeds", "Livestock", "Crops", "AnimalDrops", "Boosts" }

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
	-- Livestock: bought young, consumed into a pen, not sellable.
	--
	-- Not sellable for the same reason seeds are not: a buy price and a sell
	-- price on one item is an arbitrage loop. The way to get value back out
	-- of an animal is to raise it.
	--------------------------------------------------------------------------
	Chick = {
		Id = "Chick",
		Name = "Chick",
		Category = "Livestock",
		BuyPrice = 120,
		SellPrice = nil,
		MaxStack = 99,
		Rarity = "Common",
	},
	Piglet = {
		Id = "Piglet",
		Name = "Piglet",
		Category = "Livestock",
		BuyPrice = 150,
		SellPrice = nil,
		MaxStack = 99,
		Rarity = "Uncommon",
	},
	Calf = {
		Id = "Calf",
		Name = "Calf",
		Category = "Livestock",
		BuyPrice = 650,
		SellPrice = nil,
		MaxStack = 99,
		Rarity = "Rare",
	},

	--------------------------------------------------------------------------
	-- Animal drops: produced by husbandry, sellable.
	--
	-- Egg, Milk, RawBeef and Leather predate the mechanic - they were added
	-- when the directory was refactored, to prove a new category needed no
	-- inventory change. Raising the animals that produce them added only
	-- RawChicken, RawPork and Fat, and nothing else in this file moved.
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
	RawChicken = {
		Id = "RawChicken",
		Name = "Raw Chicken",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 65,
		MaxStack = 999,
		Rarity = "Common",
	},
	RawPork = {
		Id = "RawPork",
		Name = "Raw Pork",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 140,
		MaxStack = 999,
		Rarity = "Uncommon",
	},
	Fat = {
		Id = "Fat",
		Name = "Tallow",
		Category = "AnimalDrops",
		BuyPrice = nil,
		SellPrice = 40,
		MaxStack = 999,
		Rarity = "Common",
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

--[[
	Level required to buy or use an item. Items with no behaviour behind them
	-- crops, produce, boosts -- are ungated.

	One function for both mechanics, because the shop catalogue, the build of
	the store panel and the stock/plant resolvers all consult it: a cow gated
	in the shop but not at the pen, or the reverse, is the kind of split that
	only shows up as a player buying something they cannot use.
]]
function GameConfig.GetRequiredLevel(itemId: string): number
	local plantable = GameConfig.Plantables[itemId]
	if plantable then
		return plantable.RequiredLevel
	end

	local animal = GameConfig.Animals[itemId]
	return if animal then animal.RequiredLevel else 0
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
-- Husbandry (livestock behaviour, keyed by LIVESTOCK item id)
--------------------------------------------------------------------------------

--- One item id and a quantity. Used for feed, produce and slaughter yields,
--- which are all "this many of that item".
export type AnimalYield = { ItemId: string, Amount: number }

--- A named point on a [0, 1] progress curve. Crop growth and animal maturity
--- are the same shape - a threshold you have either passed or not - so they
--- share one type and one piece of stage math.
export type GrowthStage = { Id: string, Threshold: number }

export type AnimalSizeDefinition = {
	Id: string,
	Name: string,
	Space: number, -- units of pen space one animal occupies
	VisualScale: number,
}

export type AnimalDefinition = {
	StockId: string, -- the Livestock item consumed to stock one animal
	Name: string, -- the grown animal, which is not the item's name
	ArchetypeId: string,
	HousedIn: string, -- the structure id that accepts it
	AnimalSize: string,
	MatureTime: number,
	RequiredLevel: number,

	-- Per animal, per feeding. A pen of six eats six times this.
	Feed: AnimalYield,
	FeedDuration: number,

	-- Periodic produce. Empty for an animal raised only for slaughter, in
	-- which case ProduceInterval and ProduceXP are nil.
	Produces: { AnimalYield },
	ProduceInterval: number?,
	ProduceXP: number?,

	Slaughter: { AnimalYield },
	SlaughterXP: number,

	Color: Color3,
}

--[[
	How much pen space one animal takes, and how big it looks.

	Capacity is expressed as a per-ANIMAL cost against a per-PEN allowance,
	rather than as "this pen holds four things". The difference matters the
	moment a pen can hold more than one species: a count would have to be
	re-decided for every pen/species pair, whereas a space cost is decided
	once per animal and every pen prices it automatically.

	Same reasoning as PlantSizes, and the same visual trick - six small birds
	or three big cattle, so the pen's contents read at a glance.
]]
GameConfig.AnimalSizes = {
	Small = {
		Id = "Small",
		Name = "Small",
		Space = 1,
		VisualScale = 0.55,
	},

	Large = {
		Id = "Large",
		Name = "Large",
		Space = 3,
		VisualScale = 1.0,
	},
} :: { [string]: AnimalSizeDefinition }

--[[
	The husbandry loop.

	STOCK -> GROW -> FEED -> COLLECT -> (eventually) SLAUGHTER

	Every one of those is derived from a timestamp on the pen's structure
	entry, exactly as a crop's stage is derived from PlantedAt. Nothing
	accumulates, so animals grow and produce while the player is offline and a
	restart cannot lose progress.

	WHY FEED IS THE THROTTLE
	------------------------
	Produce accrues only over time the herd was FED, and feeding can be
	stacked at most `MaxFedWindows` deep. That one rule does three jobs:

	  * it bounds offline production without a separate "max stored" cap,
	  * it makes husbandry cost crops, so farming has a customer other than
	    the market,
	  * and it gives the mechanic an attention cadence - a flock left alone
	    stops paying.

	WHY NEGLECT HAS TEETH
	---------------------
	An unfed herd STARVES: it loses health every tick through the ordinary
	damageable registry, and dies if ignored long enough. Without that,
	feeding a slaughter-only animal like a pig would be pointless, because
	maturity is derived from the stocking time and arrives whether or not
	anybody turned up with a bucket.

	Starvation is a fraction of max health per second rather than a flat
	number, so it bites a chicken and a cow on the same schedule instead of
	needing a per-species figure that would drift out of step with their
	health.
]]
GameConfig.Husbandry = {
	EmptyStage = "Empty",
	GrownStage = "Grown",

	--[[
		Slower than the growth loop, because nothing here is per-second:
		maturity is minutes away and the shortest produce interval is a
		minute. The loop exists for liveness - to notice a stage change, a
		produce batch or a lapsed feed - and correctness comes from the
		timestamps, so ticking faster would buy nothing but work.
	]]
	TickInterval = 5,

	-- How many feed windows can be stacked ahead. Two lets a player feed
	-- before logging off and still be paid for the gap; a hundred would make
	-- the cadence meaningless.
	MaxFedWindows = 2,

	--[[
		How long a newly stocked herd arrives fed for.

		A pen that began starving the instant it was stocked would punish a
		player for not already knowing the mechanic, so there is a grace - but
		it is a SHORT fixed grace rather than a full feed window.

		A full window was the first attempt and it quietly disabled the
		feature: a pig's FeedDuration is longer than its MatureTime, so the
		grace covered the entire raise and a barn could be taken to slaughter
		having never been fed once. Asserted below to be shorter than the
		fastest animal's MatureTime, so no animal can ever be raised on the
		grace alone.
	]]
	StockingGrace = 60,

	--[[
		The most batches ONE collection pays out.

		Not a limit on how much a pen may accumulate - a player who keeps
		feeding is paying for every batch and is entitled to all of them. It
		loses nothing, because collecting advances the clock by the batches
		PAID, so a capped collection leaves the remainder on the clock for the
		next press.

		It exists to bound the arithmetic. A corrupt or clock-skewed profile
		can otherwise present a window decades wide, and "tens of millions of
		cycles" is a number that should never reach a payout calculation
		however it got there.
	]]
	MaxStoredCycles = 2_000,

	-- Fraction of the herd's max health lost per second while unfed.
	-- Asserted below to outpace every herd's regeneration, or a hungry herd
	-- would heal faster than it starved and the rule would be decorative.
	StarvationFractionPerSecond = 0.01,
	StarvationDamageType = "Starvation",

	Stages = {
		{ Id = "Juvenile", Threshold = 0.0 },
		{ Id = "Adolescent", Threshold = 0.5 },
		{ Id = "Grown", Threshold = 1.0 },
	} :: { GrowthStage },
}

--[[
	The animals, keyed by the livestock item that becomes one.

	Chickens are the entry point: cheap, quick, and productive on a short
	cadence, so husbandry can be learned in a couple of minutes. Cattle are
	the opposite end - expensive, slow, and worth more per visit. Pigs are
	neither: they produce NOTHING periodically and exist to be fattened and
	slaughtered, which is a different play pattern (set it and forget it,
	modulo feeding) rather than a worse version of the same one.
]]
GameConfig.Animals = {
	Chick = {
		StockId = "Chick",
		Name = "Chicken",
		ArchetypeId = "Chicken",
		HousedIn = "Coop",
		AnimalSize = "Small",
		MatureTime = 120,
		RequiredLevel = 2,
		Feed = { ItemId = "Wheat", Amount = 1 },
		FeedDuration = 300,
		Produces = { { ItemId = "Egg", Amount = 1 } },
		ProduceInterval = 60,
		ProduceXP = 4,
		Slaughter = { { ItemId = "RawChicken", Amount = 1 } },
		SlaughterXP = 12,
		Color = Color3.fromRGB(236, 230, 214),
	},

	Piglet = {
		StockId = "Piglet",
		Name = "Pig",
		ArchetypeId = "Pig",
		HousedIn = "Barn",
		AnimalSize = "Large",
		MatureTime = 300,
		RequiredLevel = 6,
		Feed = { ItemId = "Carrot", Amount = 2 },
		FeedDuration = 360,
		-- Raised for meat, so there is nothing to collect in the meantime.
		Produces = {},
		ProduceInterval = nil,
		ProduceXP = nil,
		Slaughter = {
			{ ItemId = "RawPork", Amount = 2 },
			{ ItemId = "Fat", Amount = 1 },
		},
		SlaughterXP = 90,
		Color = Color3.fromRGB(226, 166, 170),
	},

	Calf = {
		StockId = "Calf",
		Name = "Cow",
		ArchetypeId = "Cow",
		HousedIn = "Barn",
		AnimalSize = "Large",
		MatureTime = 600,
		RequiredLevel = 10,
		Feed = { ItemId = "Wheat", Amount = 2 },
		FeedDuration = 600,
		Produces = { { ItemId = "Milk", Amount = 2 } },
		ProduceInterval = 120,
		ProduceXP = 18,
		Slaughter = {
			{ ItemId = "RawBeef", Amount = 1 },
			{ ItemId = "Leather", Amount = 1 },
			{ ItemId = "Fat", Amount = 1 },
		},
		SlaughterXP = 140,
		Color = Color3.fromRGB(96, 82, 74),
	},
} :: { [string]: AnimalDefinition }

--- Resolves an untrusted livestock item id to its husbandry behaviour.
function GameConfig.GetAnimal(stockId: unknown): AnimalDefinition?
	if type(stockId) ~= "string" then
		return nil
	end

	return GameConfig.Animals[stockId]
end

function GameConfig.GetAnimalSize(sizeId: unknown): AnimalSizeDefinition?
	if type(sizeId) ~= "string" then
		return nil
	end

	return GameConfig.AnimalSizes[sizeId]
end

--- Whether `stockId` produces anything between stocking and slaughter.
function GameConfig.HasProduce(stockId: unknown): boolean
	local animal = GameConfig.GetAnimal(stockId)
	return animal ~= nil and #animal.Produces > 0 and (animal.ProduceInterval or 0) > 0
end

--[[
	How many of `stockId` fit in a pen of `structureId`. 0 when the pen is not
	housing, when the animal is unknown, or when that pen does not take that
	species - so a caller that forgets to validate cannot stock anything.
]]
function GameConfig.GetPenCapacity(structureId: unknown, stockId: unknown): number
	local structure = GameConfig.GetStructure(structureId)
	local animal = GameConfig.GetAnimal(stockId)

	if not structure or not animal or not structure.HousesLivestock then
		return 0
	end

	if animal.HousedIn ~= structure.Id then
		return 0
	end

	local size = GameConfig.GetAnimalSize(animal.AnimalSize)
	if not size then
		return 0
	end

	return math.floor((structure.LivestockSpace or 0) / size.Space)
end

--- Animals a player of `level` may stock, cheapest first so the UI and the
--- server's fallback pick agree on what "the obvious one" is.
function GameConfig.GetAvailableAnimals(level: number): { AnimalDefinition }
	local available = {}

	for _, animal in GameConfig.Animals do
		if level >= animal.RequiredLevel then
			table.insert(available, animal)
		end
	end

	table.sort(available, function(a, b)
		local priceA = GameConfig.Items[a.StockId].BuyPrice or 0
		local priceB = GameConfig.Items[b.StockId].BuyPrice or 0

		if priceA == priceB then
			return a.StockId < b.StockId
		end
		return priceA < priceB
	end)

	return available
end

--------------------------------------------------------------------------------
-- Growth
--------------------------------------------------------------------------------

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

	--[[
		How long an IRREVERSIBLE prompt must be held.

		Only the Checkpoint rebuild still uses this. Owned buildings moved to
		the selection panel, where an irreversible action is guarded by a
		confirmation step (Selection.ConfirmWindow) rather than a long press -
		a panel can ask "are you sure" and a prompt cannot.

		There was briefly a PromptStackOffset here too, to stop a pen's two
		prompts drawing on top of each other. The panel removed the second
		prompt, so it removed the reason for the offset.
	]]
	DestructiveHoldDuration = 1.2,
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
	DamageTypes = { "Melee", "Pierce", "Siege", "Magic", "Fire", "Ice", "Poison", "Starvation" },
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

		--[[
			Hunger, which is not an attack and has no attacker.

			Flat across every armour class because that is what starving
			means: a thicker hide does not help. It is applied only to
			livestock, by the husbandry loop, and no attack profile uses it -
			the row is uniform so that if something else ever starves, the
			answer is already here rather than being invented at the call
			site.
		]]
		Starvation = { Unarmoured = 1.00, Light = 1.00, Heavy = 1.00, Building = 1.00, Crop = 1.00 },
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

--[[
	The level of a raid sent at a settlement of `age`.

	Deliberately a function rather than a table: a per-age table would need a
	new row every time an age is added, and the relationship is linear.
]]
function GameConfig.GetRaidLevel(age: number): number
	local raids = GameConfig.Raids
	local advanced = math.max((tonumber(age) or 1) - 1, 0)

	return raids.BaseLevel + advanced * raids.LevelPerAge
end

--- Health and damage multiplier for something at `level`.
function GameConfig.GetLevelMultiplier(level: number): number
	local above = math.max((tonumber(level) or 1) - 1, 0)
	return 1 + above * GameConfig.Raids.LevelScaling
end

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

	Coop = {
		Id = "Coop",
		Name = "Chicken Coop",
		MaxHealth = 400,
		ArmourClass = "Building",
		Armour = 0,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.25 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	Barn = {
		Id = "Barn",
		Name = "Barn",
		MaxHealth = 1_000,
		ArmourClass = "Building",
		Armour = 4,
		RegenPerSecond = 0,
		Repairable = true,
		RepairCostPerHealth = { Wood = 0.5, Stone = 0.2 },
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	--[[
		The HERDS.

		One archetype per species, and one ENTITY per pen rather than per
		animal: the herd in a pen shares a health pool exactly as the stack of
		plants in a farm square shares a crop entity. Density therefore
		concentrates risk here too - a raider that reaches a full coop takes
		the whole flock - which is the same trade the farm makes and worth
		having rather than a bug to fix.

		Tagged "Resource", so a Looter heading for the Mills and Farms goes
		for the livestock as well. Nothing in the targeting code was told
		about animals; it reads the tag.

		They regenerate, because a herd is alive and a fed one should recover
		from a raid without the player spending resources on it. Repairable is
		false for the same reason: you cannot repair a chicken.
	]]
	Chicken = {
		Id = "Chicken",
		Name = "Chickens",
		MaxHealth = 120,
		ArmourClass = "Light",
		Armour = 0,
		RegenPerSecond = 0.3,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	Pig = {
		Id = "Pig",
		Name = "Pigs",
		MaxHealth = 300,
		ArmourClass = "Light",
		Armour = 0,
		RegenPerSecond = 0.5,
		Repairable = false,
		DestroyBehaviour = "Remove",
		Faction = "Player",
		TargetTag = "Resource",
	},

	Cow = {
		Id = "Cow",
		Name = "Cattle",
		MaxHealth = 500,
		ArmourClass = "Light",
		Armour = 0,
		RegenPerSecond = 0.8,
		Repairable = false,
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

	--[[
		Per-building behaviour flags.

		A service filters on the flag rather than on the structure id, which is
		what keeps per-building behaviour out of the placement system: farms
		are the only thing FarmService attaches to, pens the only thing
		AnimalService attaches to, and neither service names the other's
		buildings.
	]]
	HoldsCrop: boolean?,
	HousesLivestock: boolean?,
	LivestockSpace: number?, -- pen space available to animals, see AnimalSizes

	--[[
		What the selection panel offers on this building, and which state bars
		it draws. Both are ids into BuildingActions and PanelBars below.

		A building's action list is DATA, which is the whole point of the
		panel: adding "Train Troop" to a Barracks is a config edit plus one
		server handler, not a new prompt, a new key and a new offset.
	]]
	Actions: { string }?,
	Bars: { string }?,
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
		--[[
			Repair only. Every other building also offers Demolish, but the
			Town Center is the root of the build tree - tearing it down would
			orphan everything that required it - so selecting one gets a panel
			with a single button, which is still better than no panel.
		]]
		Actions = { "Repair" },
		Bars = { "Health" },
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
		Actions = { "Repair", "Demolish" },
		Bars = { "Health" },
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
		Actions = { "Repair", "Demolish" },
		Bars = { "Health" },
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
		-- The only structure that grows something, so FarmService attaches
		-- its behaviour to farms and nothing else.
		HoldsCrop = true,
		Actions = { "Plant", "Harvest", "Uproot", "Repair", "Demolish" },
		Bars = { "Health", "Growth" },
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
		Actions = { "Repair", "Demolish" },
		Bars = { "Health" },
	},

	--[[
		The pens.

		Both require a Mill, for the reason the Farm does: husbandry is the
		other half of the Mill's job, and the dependency is EXISTENCE rather
		than proximity - the radius model was tried and removed. A herd near
		its Mill may one day eat less or produce faster, but it will not be
		forbidden from standing elsewhere.

		A Coop is Stone Age and cheap, so chickens are reachable about as
		early as a second farm. The Barn is Bronze Age and expensive, which is
		what keeps cattle a goal rather than an alternative opening.
	]]
	Coop = {
		Id = "Coop",
		Name = "Chicken Coop",
		Description = "Houses a flock of chickens. Feed them, collect the eggs; requires a Mill.",
		ArchetypeId = "Coop",
		RequiredAge = 1,
		Prerequisites = { "Mill" },
		Cost = { Wood = 80 },
		Size = Vector3.new(8, 6, 8),
		Color = Color3.fromRGB(168, 132, 92),
		MaxPerPlayer = 8,
		SortOrder = 60,
		Actions = { "Stock", "Feed", "Collect", "Slaughter", "Repair", "Demolish" },
		Bars = { "Health", "Maturity", "Feed" },
		HousesLivestock = true,
		-- Six Small animals, or two Large ones if a small species is ever
		-- housed here. See AnimalSizes for why this is space, not a count.
		LivestockSpace = 6,
	},

	Barn = {
		Id = "Barn",
		Name = "Barn",
		Description = "Houses pigs and cattle. Requires a Mill, and the Bronze Age.",
		ArchetypeId = "Barn",
		RequiredAge = 2,
		Prerequisites = { "Mill" },
		Cost = { Wood = 220, Stone = 60 },
		Size = Vector3.new(16, 10, 12),
		Color = Color3.fromRGB(142, 76, 62),
		MaxPerPlayer = 4,
		SortOrder = 70,
		HousesLivestock = true,
		LivestockSpace = 9,
		Actions = { "Stock", "Feed", "Collect", "Slaughter", "Repair", "Demolish" },
		Bars = { "Health", "Maturity", "Feed" },
	},
} :: { [string]: StructureDefinition }

--------------------------------------------------------------------------------
-- The selection panel
--------------------------------------------------------------------------------

export type ActionDefinition = {
	Id: string,
	Name: string, -- the button label
	Description: string, -- the line under it, so a button explains itself
	Kind: string, -- "Primary" | "Secondary" | "Destructive"

	--[[
		An item CATEGORY the action picks from, or nil for an action with no
		choice to make.

		This is how the panel gets a seed picker without knowing what a seed
		is: "Plant" chooses from Seeds, "Stock" from Livestock, and the panel
		lists whatever the player holds in that category.
	]]
	Choice: string?,
}

--[[
	Every action a building can offer, declared once.

	WHY THIS EXISTS
	---------------
	Owned buildings used to be operated through ProximityPrompts, and prompts
	do not scale. A farm had one prompt that guessed which of plant, harvest
	and uproot you meant. A pen needed FOUR actions, so it ended up with two
	prompts on two keys, one of them held, separated by a pixel offset because
	Roblox draws both in the same place - and it still had no way to let the
	player CHOOSE which seed to plant or which animal to stock, which is why
	`SelectedSeed` was an attribute that nothing ever set.

	A building's actions are now a list of ids, and the panel generates itself
	from them. Adding "Train Troop" to a Barracks is an entry here, an id in
	that structure's Actions, and one server handler.

	DESTRUCTIVE ACTIONS
	-------------------
	`Kind = "Destructive"` is the panel's replacement for the hold gesture. An
	irreversible action next to a repeatable one needs a different gesture, and
	in a panel that gesture is a confirmation step rather than a long press.
]]
GameConfig.ActionKinds = { "Primary", "Secondary", "Destructive" }

GameConfig.BuildingActions = {
	--------------------------------------------------------------------------
	-- Farming
	--------------------------------------------------------------------------
	Plant = {
		Id = "Plant",
		Name = "Plant",
		Description = "Fill the square with a crop of your choosing.",
		Kind = "Primary",
		Choice = "Seeds",
	},
	Harvest = {
		Id = "Harvest",
		Name = "Harvest",
		Description = "Pick a ripe crop. Pays the whole stack.",
		Kind = "Primary",
	},
	Uproot = {
		Id = "Uproot",
		Name = "Uproot",
		Description = "Clear a kept plant. Returns nothing.",
		Kind = "Destructive",
	},

	--------------------------------------------------------------------------
	-- Husbandry
	--------------------------------------------------------------------------
	Stock = {
		Id = "Stock",
		Name = "Stock",
		Description = "Put young animals in. Fills the pen in one action.",
		Kind = "Primary",
		Choice = "Livestock",
	},
	Feed = {
		Id = "Feed",
		Name = "Feed",
		Description = "A hungry herd stops growing, stops producing, and starves.",
		Kind = "Primary",
	},
	Collect = {
		Id = "Collect",
		Name = "Collect",
		Description = "Take what the herd has produced.",
		Kind = "Primary",
	},
	Slaughter = {
		Id = "Slaughter",
		Name = "Slaughter",
		Description = "Take the meat. Ends the herd.",
		Kind = "Destructive",
	},

	--------------------------------------------------------------------------
	-- Every building
	--------------------------------------------------------------------------
	Repair = {
		Id = "Repair",
		Name = "Repair",
		Description = "Spend resources to mend the building.",
		Kind = "Secondary",
	},
	Demolish = {
		Id = "Demolish",
		Name = "Demolish",
		Description = "Tear it down. Refunds nothing, and takes its contents.",
		Kind = "Destructive",
	},
} :: { [string]: ActionDefinition }

function GameConfig.GetAction(actionId: unknown): ActionDefinition?
	if type(actionId) ~= "string" then
		return nil
	end

	return GameConfig.BuildingActions[actionId]
end

--[[
	The state bars a panel can draw.

	`Kind` says where the value comes from, so the client has one function per
	KIND rather than one per building. Nothing here carries a value: a bar is
	a question ("how grown is this crop?"), and the answer is derived from the
	replicated attributes every time it is drawn. Storing numbers in config
	would be storing state in the one place guaranteed to go stale.
]]
--- The readings a bar can take. A Kind with no reader is a bar that is
--- declared, drawn and never updated, with no error anywhere.
GameConfig.BarKinds = { "Health", "Growth", "Maturity", "Feed" }

GameConfig.PanelBars = {
	Health = {
		Id = "Health",
		Name = "Condition",
		Kind = "Health",
		Colour = Color3.fromRGB(206, 92, 86),
	},
	Growth = {
		Id = "Growth",
		Name = "Growth",
		Kind = "Growth",
		Colour = Color3.fromRGB(126, 196, 112),
	},
	Maturity = {
		Id = "Maturity",
		Name = "Maturity",
		Kind = "Maturity",
		Colour = Color3.fromRGB(126, 196, 112),
	},
	Feed = {
		Id = "Feed",
		Name = "Feed",
		Kind = "Feed",
		Colour = Color3.fromRGB(214, 183, 90),
	},
}

GameConfig.Selection = {
	--[[
		The single prompt an owned building carries now, and the only thing it
		does: tell the CLIENT to open the panel.

		Shared so the server that creates it and the client that listens for
		it cannot drift. The prompt is not wired to anything on the server -
		opening a menu is a client concern, exactly as the shop's prompt
		already works.
	]]
	PromptName = "Manage",
	PromptActionText = "Manage",

	-- How far a click may reach to select a building. Generous, because
	-- selecting a building across your base is the point of a panel.
	MaxSelectDistance = 300,

	--[[
		The build menu's placement ghost, named here so two clients cannot
		drift apart over it.

		Both the build menu and the selection panel act on an unprocessed
		left click, and neither knows about the other, so confirming a
		placement would also run the selection path. The ghost's presence in
		Workspace is what tells the panel to stay out of the way.
	]]
	GhostName = "BuildGhost",

	-- Token bucket for the action remote. Burst covers honest double-clicks.
	RequestsPerSecond = 6,
	BurstSize = 10,

	--[[
		How long a destructive button stays armed after the first press.

		The panel's answer to the hold gesture: press Slaughter and it becomes
		"Confirm?" for this long. Short enough that it cannot be forgotten and
		pressed by accident later.
	]]
	ConfirmWindow = 4,

	-- How often the open panel recomputes its bars and button states. The
	-- countdowns are the only thing that moves without an attribute changing.
	RefreshInterval = 0.2,
}

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
		A wave's LEVEL, and what it scales.

		Raiders were all level 1, which made every raid identical and made
		"the level of the horde that attacked you" a thing that did not
		exist. It has to exist: the revenge army in docs/ROADMAP.md is sized
		from it.

		Scaled off the player's AGE rather than their XP level. Age is the RTS
		measure of how far along a settlement is - it gates buildings and
		costs a fortune - so a player who has advanced has visibly better
		defences and should face something worth defending against. XP level
		rises from farming, which should not summon a bigger army.

		Level multiplies health and damage, and it already multiplied kill
		rewards, so a harder wave pays better without any extra wiring.
	]]
	LevelPerAge = 2,
	BaseLevel = 1,

	--- Health and damage multiplier per level above the first.
	LevelScaling = 0.35,

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
		What surrendering to a HORDE costs: a cut of the personal purse, and
		nothing else.

		This replaces an earlier rule that took a quarter of every treasury
		resource. That was the wrong pocket. The treasury is the settlement -
		its stores are what the player's farms and mills exist to fill, and
		emptying them undoes hours of building to punish one bad fight. The
		purse is loot: gold won from kills, carried on the person, and losing
		it is exactly the kind of setback a lost fight should be.

		So a raid can cost you what you were carrying. It cannot cost you what
		you built.
	]]
	SurrenderPurseLoss = 0.4,

	-- Tokens one "fight on" costs.
	FightOnTokenCost = 1,

	--[[
		Rebuilding the wreck costs what the Checkpoint cost to BUILD, not what
		its repair table says.

		Repair is priced per health point, which for a two thousand health
		anchor comes to 800 Wood and 800 Stone - five times the build cost,
		and far beyond what a player who has just lost a raid is holding. The
		prompt simply refused, silently, which is how this was found.

		A ruin costing what a new one costs is also easier to reason about
		than a number derived from a health total.
	]]
	RebuildCostsBuildPrice = true,

	--[[
		DEFEAT BY ANOTHER PLAYER - agreed, and not yet reachable.

		Nothing can attack another player's base, so none of this runs. It is
		recorded here rather than in a document because this is where whoever
		builds player raids will look, and because the numbers are a decision
		that has already been made:

		  * the victor takes PurseStolen of the loser's purse into their own,
		  * and TreasuryStolen of each of the loser's treasury resources into
		    their base,
		  * and the loser's treasury is then RESET to StartingResources
		    rather than left at whatever remained.

		The reset is the part worth flagging. It is a floor as much as a
		penalty: a player who loses everything restarts with a working
		economy instead of a ruin they cannot rebuild from.
	]]
	PlayerVictory = {
		PurseStolen = 0.4,
		TreasuryStolen = 0.6,
		ResetTreasuryToStarting = true,
	},
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

	-- Which livestock a stock action will use, the counterpart of
	-- SelectedSeed. Server-written, from a validated remote.
	SelectedStock = "SelectedStock",
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

--[[
	Published on a pen holding a herd.

	Every field is a TIMESTAMP or a count, never a derived quantity: there is
	no "eggs waiting" attribute, because the client computes that from
	LastCollectedAt, FedUntil and the config with Shared.Husbandry - the same
	function the server validates with. A pen that is producing therefore
	costs no replication traffic at all between collections, exactly like a
	growing crop.
]]
GameConfig.AnimalAttributes = {
	AnimalId = "AnimalId", -- the livestock item id; "" when the pen is empty
	StockedAt = "StockedAt",
	GrownAt = "GrownAt",
	-- Named apart from the farm's "Stage" so the two are never confused in a
	-- client reading both, even though no model carries both.
	Stage = "AnimalStage",
	AnimalCount = "AnimalCount", -- 0 when empty
	AnimalCapacity = "AnimalCapacity", -- 0 when empty
	-- A FUTURE timestamp while the herd is fed, which is the one place in
	-- this project where that is normal rather than a tamper signal.
	FedUntil = "FedUntil",
	LastCollectedAt = "LastCollectedAt",
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
		Which livestock to stock a pen with, the counterpart of SelectSeed.

		Like SelectSeed it has no client caller yet - the server falls back to
		the cheapest animal owned, so the mechanic is complete without it -
		and both get wired up together by the selection panel in
		docs/ROADMAP.md, which is where choosing what to put in a building
		belongs.
	]]
	SelectAnimal = "SelectAnimal",

	--[[
		How a defeated player answers. A function, not an event: spending a
		Revenge Token can fail (none left) and the player has to be told,
		rather than left looking at a panel that did nothing.
	]]
	ResolveDefeat = "ResolveDefeat",

	--[[
		Server -> one client: a short message to show the player.

		Added because a refusal with no explanation is indistinguishable from
		a broken button. The rebuild prompt was refusing for want of resources
		and saying nothing, so it looked like the prompt did not work.
	]]
	Notice = "Notice",
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

	--[[
		Every action the selection panel offers, on one remote.

		A function rather than an event because the panel genuinely needs the
		answer: "not grown yet" and "your bag is full" are different captions,
		and a request/response pair is clearer than an event plus a notice the
		caller has to correlate.

		ONE remote for all of them, dispatched by action id, because the
		alternative is a remote per verb and every one of them is an attack
		surface to validate separately. The shape is
		`(instanceId, actionId, choice?)`.
	]]
	BuildingAction = "BuildingAction",

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

do
	local stages = GameConfig.Husbandry.Stages
	assert(#stages > 0, "GameConfig.Husbandry.Stages must not be empty")
	assert(stages[1].Threshold == 0, "the first maturity stage must start at 0")
	assert(stages[#stages].Threshold == 1, "the final maturity stage must start at 1.0")
	assert(stages[#stages].Id == GameConfig.Husbandry.GrownStage, "the final maturity stage must be GrownStage")

	for index = 2, #stages do
		assert(stages[index].Threshold > stages[index - 1].Threshold, "maturity stage thresholds must ascend")
	end

	assert(GameConfig.Husbandry.MaxFedWindows >= 1, "a pen must be feedable at least one window ahead")
	assert(GameConfig.Husbandry.MaxStoredCycles >= 1, "a collection must be able to pay at least one batch")

	-- Zero would busy-loop the husbandry thread AND zero out every starvation
	-- charge, which is a lot of damage for one absent number. Same assert as
	-- StatusEffectRules.TickInterval, for the same reason.
	assert(GameConfig.Husbandry.TickInterval > 0, "GameConfig.Husbandry.TickInterval must be positive")

	assert(
		GameConfig.Husbandry.StarvationFractionPerSecond > 0,
		"starvation must cost something, or feeding a slaughter-only animal would be pointless"
	)
	assert(
		table.find(GameConfig.Combat.DamageTypes, GameConfig.Husbandry.StarvationDamageType) ~= nil,
		`husbandry starves livestock with unknown damage type {GameConfig.Husbandry.StarvationDamageType}`
	)
	assert(GameConfig.Husbandry.StockingGrace > 0, "a newly stocked herd must arrive fed for some time")
end

for id, size in GameConfig.AnimalSizes do
	assert(size.Id == id, `animal size {id} has a mismatched Id field`)
	assert(size.Space >= 1, `animal size {id} must occupy at least one unit of pen space`)
	assert(size.VisualScale > 0, `animal size {id} must have a positive VisualScale`)
end

--- Shared by the produce and slaughter checks below: both are lists of
--- "this many of that item", and both are worthless if the item cannot be sold.
local function assertYields(label: string, yields)
	for index, yield in yields do
		assert(yield.Amount > 0, `{label} entry {index} must be a positive amount`)

		local item = GameConfig.Items[yield.ItemId]
		assert(item ~= nil, `{label} entry {index} names unknown item {tostring(yield.ItemId)}`)
		assert(
			item.Category == "AnimalDrops",
			`{label} entry {index} yields {yield.ItemId}, which is not an AnimalDrop`
		)
		assert(
			GameConfig.IsSellable(item),
			`{label} entry {index} yields {yield.ItemId}, which has no SellPrice - the animal would be worthless`
		)
	end
end

for stockId, animal in GameConfig.Animals do
	assert(animal.StockId == stockId, `animal {stockId} has a mismatched StockId field`)
	assert(animal.MatureTime > 0, `animal {stockId} must have a positive MatureTime`)
	assert(
		GameConfig.AnimalSizes[animal.AnimalSize] ~= nil,
		`animal {stockId} has unknown AnimalSize {tostring(animal.AnimalSize)}`
	)
	local herdArchetype = GameConfig.Archetypes[animal.ArchetypeId]
	assert(herdArchetype ~= nil, `animal {stockId} grows into unknown archetype {tostring(animal.ArchetypeId)}`)

	--[[
		Starvation has to outpace regeneration, or a hungry herd heals faster
		than it starves and never dies. That would disable the rule the whole
		feed mechanic rests on, silently, from two numbers in a different
		table - so the relationship is asserted rather than left to whoever
		next tunes a herd's health.
	]]
	assert(
		herdArchetype.MaxHealth * GameConfig.Husbandry.StarvationFractionPerSecond > herdArchetype.RegenPerSecond,
		`animal {stockId} regenerates at {herdArchetype.RegenPerSecond}/s, which is faster than it starves - `
			.. `a hungry herd would be immortal`
	)

	--[[
		And no animal may be raised on the stocking grace alone. If the grace
		outlasts the raise, the animal reaches slaughter without ever being
		fed, which is exactly what starvation exists to prevent.
	]]
	assert(
		animal.MatureTime > GameConfig.Husbandry.StockingGrace,
		`animal {stockId} matures in {animal.MatureTime}s, within its stocking grace of `
			.. `{GameConfig.Husbandry.StockingGrace}s - it could be raised without ever being fed`
	)

	-- The livestock item is what the player buys and the pen consumes, so it
	-- has to be in the directory and in the category the shop sells.
	local stockItem = GameConfig.Items[stockId]
	assert(stockItem ~= nil, `animal {stockId} has no matching item in the directory`)
	assert(stockItem.Category == "Livestock", `animal {stockId} must reference an item in the Livestock category`)

	--[[
		The pen has to exist, house livestock, and have room for at least one.
		A space cost larger than any pen's allowance is silently dead config:
		the animal would be buyable and never stockable anywhere.
	]]
	local pen = GameConfig.Structures[animal.HousedIn]
	assert(pen ~= nil, `animal {stockId} is housed in unknown structure {tostring(animal.HousedIn)}`)
	assert(pen.HousesLivestock == true, `animal {stockId} is housed in {animal.HousedIn}, which is not a pen`)
	assert(
		GameConfig.GetPenCapacity(animal.HousedIn, stockId) >= 1,
		`animal {stockId} does not fit in a {animal.HousedIn} even once`
	)

	-- Feed is what gives neglect a cost and gives farming a customer.
	assert(GameConfig.Items[animal.Feed.ItemId] ~= nil, `animal {stockId} eats unknown item {animal.Feed.ItemId}`)
	assert(animal.Feed.Amount > 0, `animal {stockId} must eat a positive amount`)
	assert(animal.FeedDuration > 0, `animal {stockId} must have a positive FeedDuration`)

	--[[
		An animal must be worth raising ONE of the two ways, and must be
		configured consistently for whichever it is.

		A periodic producer with no interval would never pay out, and an
		interval with nothing to produce is an empty timer - both read as
		working and silently do nothing, which is the failure mode these
		checks exist for.
	]]
	assert(
		#animal.Produces > 0 or #animal.Slaughter > 0,
		`animal {stockId} neither produces nor yields anything when slaughtered, so raising it does nothing`
	)

	if #animal.Produces > 0 then
		assert(
			(animal.ProduceInterval or 0) > 0,
			`animal {stockId} produces {#animal.Produces} thing(s) but has no ProduceInterval`
		)
		assert((animal.ProduceXP or 0) > 0, `animal {stockId} produces but pays no ProduceXP`)
		assertYields(`animal {stockId} Produces`, animal.Produces)
	else
		assert(animal.ProduceInterval == nil, `animal {stockId} produces nothing, so it must not name a ProduceInterval`)
		assert(animal.ProduceXP == nil, `animal {stockId} produces nothing, so it must not name a ProduceXP`)
	end

	if #animal.Slaughter > 0 then
		assert(animal.SlaughterXP > 0, `animal {stockId} can be slaughtered but pays no SlaughterXP`)
		assertYields(`animal {stockId} Slaughter`, animal.Slaughter)
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

	--[[
		A pen has to have room, and something to put in it. A pen no animal
		names as its home is a building the player can pay for and never use,
		which is a balance-looking bug with a config cause.
	]]
	if structure.HousesLivestock then
		assert((structure.LivestockSpace or 0) >= 1, `pen {id} has no LivestockSpace, so nothing can live in it`)

		local housesSomething = false

		for _, animal in GameConfig.Animals do
			if animal.HousedIn == id then
				housesSomething = true
				break
			end
		end

		assert(housesSomething, `pen {id} is a pen no animal is housed in`)
	else
		assert(structure.LivestockSpace == nil, `structure {id} has LivestockSpace but does not house livestock`)
	end
	assert(structure.RequiredAge >= 1 and structure.RequiredAge <= #GameConfig.Ages, `structure {id} has a bad age`)

	for resourceId in structure.Cost do
		assert(GameConfig.Resources[resourceId] ~= nil, `structure {id} costs unknown resource {resourceId}`)
	end

	-- A prerequisite or radius parent that does not exist would make the
	-- structure permanently unbuildable, which is worse than a loud failure.
	for _, prerequisiteId in structure.Prerequisites do
		assert(GameConfig.Structures[prerequisiteId] ~= nil, `structure {id} requires unknown structure {prerequisiteId}`)
	end

	--[[
		The selection panel generates itself from these, so a typo here is a
		button that never appears or a panel that cannot be opened - both of
		which look like the UI is broken rather than like a config error.

		Every selectable building must offer SOMETHING, or selecting it opens
		an empty panel.
	]]
	assert(structure.Actions ~= nil, `structure {id} declares no Actions, so its panel would be empty`)
	assert(#structure.Actions > 0, `structure {id} has an empty Actions list`)

	local seenActions = {}

	for _, actionId in structure.Actions do
		assert(GameConfig.BuildingActions[actionId] ~= nil, `structure {id} offers unknown action {actionId}`)
		assert(not seenActions[actionId], `structure {id} offers action {actionId} twice`)
		seenActions[actionId] = true
	end

	assert(structure.Bars ~= nil, `structure {id} declares no Bars`)

	for _, barId in structure.Bars do
		assert(GameConfig.PanelBars[barId] ~= nil, `structure {id} draws unknown bar {barId}`)
	end

	--[[
		A building that grows or houses something must offer the actions that
		operate it. Shipping a Coop whose Actions list forgot "Feed" would be
		a herd nobody could save, discoverable only by letting one starve.
	]]
	local seenBars = {}

	for _, barId in structure.Bars do
		seenBars[barId] = true
	end

	if structure.HoldsCrop then
		for _, required in { "Plant", "Harvest" } do
			assert(seenActions[required], `structure {id} holds a crop but does not offer {required}`)
		end

		assert(seenBars.Growth, `structure {id} holds a crop but draws no Growth bar`)
	end

	--[[
		A pen must show its feed. "A rule nobody can see is a rule nobody
		believes" was learned the hard way on husbandry - starvation was real
		and invisible for two rounds of playtesting - so the readout that
		makes it visible is asserted rather than remembered.
	]]
	if structure.HousesLivestock then
		for _, required in { "Stock", "Feed" } do
			assert(seenActions[required], `structure {id} houses livestock but does not offer {required}`)
		end

		for _, required in { "Maturity", "Feed" } do
			assert(seenBars[required], `structure {id} houses livestock but draws no {required} bar`)
		end
	end

	--[[
		Offering Repair on a building the registry will not repair is a
		permanently dead button whose only answer is "NotRepairable".
	]]
	if seenActions.Repair then
		assert(
			GameConfig.Archetypes[structure.ArchetypeId].Repairable,
			`structure {id} offers Repair but its archetype is not repairable`
		)
	end
end

for id, action in GameConfig.BuildingActions do
	assert(action.Id == id, `action {id} has a mismatched Id field`)
	assert(table.find(GameConfig.ActionKinds, action.Kind) ~= nil, `action {id} has unknown Kind {action.Kind}`)
	assert(action.Description ~= "", `action {id} needs a description - the panel shows it`)

	if action.Choice ~= nil then
		assert(GameConfig.IsValidCategory(action.Choice), `action {id} chooses from unknown category {action.Choice}`)
	end

	--[[
		Every action must be offered by at least one building. An action
		nothing offers is dead config that reads as a feature.
	]]
	local offered = false

	for _, structure in GameConfig.Structures do
		if structure.Actions and table.find(structure.Actions, id) then
			offered = true
			break
		end
	end

	assert(offered, `action {id} is offered by no building`)
end

for id, bar in GameConfig.PanelBars do
	assert(bar.Id == id, `panel bar {id} has a mismatched Id field`)
	assert(bar.Name ~= "", `panel bar {id} needs a name`)
	assert(table.find(GameConfig.BarKinds, bar.Kind) ~= nil, `panel bar {id} has unknown Kind {tostring(bar.Kind)}`)

	-- The mirror of the action rule: a bar no building draws is dead config
	-- that reads as a feature.
	local drawn = false

	for _, structure in GameConfig.Structures do
		if structure.Bars and table.find(structure.Bars, id) then
			drawn = true
			break
		end
	end

	assert(drawn, `panel bar {id} is drawn by no building`)
end

do
	local selection = GameConfig.Selection

	assert(selection.MaxSelectDistance > 0, "a click must be able to reach something")
	assert(selection.ConfirmWindow > 0, "a destructive action must stay armed long enough to confirm")
	assert(selection.RefreshInterval > 0, "the panel must refresh")
	assert(selection.PromptName ~= "", "the management prompt needs a name")
	assert(selection.PromptActionText ~= "", "and a label")
	assert(selection.GhostName ~= "", "the build ghost needs a name the panel can look for")

	-- Checked here rather than left to fail inside RateLimiter.new at
	-- startup, which reports the symptom a long way from the cause.
	assert(selection.RequestsPerSecond > 0, "the action remote needs a positive rate")
	assert(selection.BurstSize >= selection.RequestsPerSecond, "a burst smaller than the rate would throttle normal use")
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

	assert(GameConfig.Raids.BaseLevel >= 1, "Raids.BaseLevel must be at least 1")
	assert(GameConfig.Raids.LevelPerAge >= 0, "Raids.LevelPerAge cannot be negative")
	assert(GameConfig.Raids.LevelScaling > 0, "Raids.LevelScaling must be positive, or levels mean nothing")

	--[[
		A raid at the final age must be meaningfully harder than the first, or
		the whole escalation is decoration.
	]]
	do
		local first = GameConfig.GetLevelMultiplier(GameConfig.GetRaidLevel(1))
		local last = GameConfig.GetLevelMultiplier(GameConfig.GetRaidLevel(GameConfig.MaxAge))

		assert(
			last >= first * 2,
			`raids barely escalate: age 1 scales {first} and age {GameConfig.MaxAge} only {last}`
		)
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
		defeat.SurrenderPurseLoss > 0 and defeat.SurrenderPurseLoss < 1,
		"Defeat.SurrenderPurseLoss must be in (0, 1): at 0 surrender is free, at 1 it is total"
	)

	for _, key in { "PurseStolen", "TreasuryStolen" } do
		local fraction = defeat.PlayerVictory[key]
		assert(
			fraction > 0 and fraction <= 1,
			`Defeat.PlayerVictory.{key} must be in (0, 1]`
		)
	end

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

