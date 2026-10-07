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
	YieldAmount: number,
	GrowTime: number, -- seconds from planting to fully grown
	XPReward: number,
	RequiredLevel: number, -- gates both buying and planting
	Color: Color3, -- growing plant tint, also used by shop UI swatches
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
GameConfig.FrameworkVersion = 12

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
GameConfig.StarterKit = {
	CarrotSeed = 3,
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
		Color = Color3.fromRGB(237, 139, 48),
	},
	WheatSeed = {
		SeedId = "WheatSeed",
		Yields = "Wheat",
		YieldAmount = 2,
		GrowTime = 45,
		XPReward = 16,
		RequiredLevel = 2,
		Color = Color3.fromRGB(214, 183, 90),
	},
	TomatoSeed = {
		SeedId = "TomatoSeed",
		Yields = "Tomato",
		YieldAmount = 1,
		GrowTime = 60,
		XPReward = 22,
		RequiredLevel = 3,
		Color = Color3.fromRGB(214, 61, 56),
	},
	PumpkinSeed = {
		SeedId = "PumpkinSeed",
		Yields = "Pumpkin",
		YieldAmount = 1,
		GrowTime = 150,
		XPReward = 55,
		RequiredLevel = 8,
		Color = Color3.fromRGB(226, 132, 38),
	},
	WatermelonSeed = {
		SeedId = "WatermelonSeed",
		Yields = "Watermelon",
		YieldAmount = 1,
		GrowTime = 320,
		XPReward = 140,
		RequiredLevel = 15,
		Color = Color3.fromRGB(72, 160, 84),
	},
	GoldenAppleSeed = {
		SeedId = "GoldenAppleSeed",
		Yields = "GoldenApple",
		YieldAmount = 1,
		GrowTime = 600,
		XPReward = 420,
		RequiredLevel = 25,
		Color = Color3.fromRGB(240, 199, 62),
	},
	StarfruitSeed = {
		SeedId = "StarfruitSeed",
		Yields = "Starfruit",
		YieldAmount = 1,
		GrowTime = 1_200,
		XPReward = 1_250,
		RequiredLevel = 40,
		Color = Color3.fromRGB(126, 118, 224),
	},
} :: { [string]: PlantableDefinition }

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
GameConfig.Combat = {
	DamageTypes = { "Melee", "Pierce", "Siege", "Magic" },
	ArmourClasses = { "Unarmoured", "Light", "Heavy", "Building", "Crop" },

	-- Even a perfectly countered hit lands something. A truly immune target
	-- would make a siege unwinnable rather than merely slow.
	MinimumDamage = 1,

	Multipliers = {
		Melee = { Unarmoured = 1.00, Light = 1.00, Heavy = 0.60, Building = 0.50, Crop = 1.00 },
		Pierce = { Unarmoured = 1.25, Light = 1.00, Heavy = 0.40, Building = 0.25, Crop = 0.75 },
		Siege = { Unarmoured = 0.50, Light = 0.50, Heavy = 0.50, Building = 2.50, Crop = 1.50 },
		Magic = { Unarmoured = 1.00, Light = 1.10, Heavy = 1.10, Building = 0.75, Crop = 1.00 },
	},
}

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
	},
} :: { [string]: ArchetypeDefinition }

function GameConfig.GetArchetype(archetypeId: unknown): ArchetypeDefinition?
	if type(archetypeId) ~= "string" then
		return nil
	end

	return GameConfig.Archetypes[archetypeId]
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
		Description = "The heart of your settlement. Projects influence for everything else.",
		ArchetypeId = "TownCenter",
		RequiredAge = 1,
		Prerequisites = {},
		Cost = { Wood = 300, Stone = 100 },
		Size = Vector3.new(14, 10, 14),
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
		Size = Vector3.new(10, 8, 10),
		Color = Color3.fromRGB(150, 118, 76),
		MaxPerPlayer = 4,
		SortOrder = 30,
	},

	Farm = {
		Id = "Farm",
		Name = "Farm",
		Description = "A tilled plot for one crop. Must be built beside a Mill.",
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
		Size = Vector3.new(6, 16, 6),
		Color = Color3.fromRGB(142, 146, 152),
		MaxPerPlayer = 6,
		SortOrder = 50,
	},
} :: { [string]: StructureDefinition }

GameConfig.Placement = {
	-- Minimum gap between two structures' footprints, so bases cannot be built
	-- as a solid impenetrable block.
	MinimumGap = 2,

	-- Half-extent of the buildable world, inside the baseplate.
	WorldLimit = 240,

	-- Structures sit on the ground plane.
	GroundY = 0,

	RequestsPerSecond = 4,
	BurstSize = 6,
}

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
}

-- A single flat folder now: one attribute per item id, no category subfolders.
GameConfig.InventoryFolderName = "Inventory"
GameConfig.StructuresFolderName = "Structures"

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
	UseBoost = "UseBoost",
	SelectFarm = "SelectFarm",

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

for seedId, plantable in GameConfig.Plantables do
	assert(plantable.SeedId == seedId, `plantable {seedId} has a mismatched SeedId field`)
	assert(plantable.GrowTime > 0, `plantable {seedId} must have a positive GrowTime`)
	assert(plantable.YieldAmount > 0, `plantable {seedId} must yield a positive amount`)

	local seedItem = GameConfig.Items[seedId]
	assert(seedItem ~= nil, `plantable {seedId} has no matching item in the directory`)
	assert(seedItem.Category == "Seeds", `plantable {seedId} must reference an item in the Seeds category`)

	local yieldItem = GameConfig.Items[plantable.Yields]
	assert(yieldItem ~= nil, `plantable {seedId} yields unknown item {plantable.Yields}`)
	assert(
		GameConfig.IsSellable(yieldItem),
		`plantable {seedId} yields {plantable.Yields}, which has no SellPrice - the crop would be worthless`
	)
end

for id, structure in GameConfig.Structures do
	assert(structure.Id == id, `structure {id} has a mismatched Id field`)
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
end

table.freeze(GameConfig.Attributes)
table.freeze(GameConfig.FarmAttributes)
table.freeze(GameConfig.RemoteNames)
table.freeze(GameConfig.ItemCategories)
table.freeze(GameConfig.HealthAttributes)
table.freeze(GameConfig.StructureAttributes)
table.freeze(GameConfig.Interaction)
table.freeze(GameConfig.TransactionActions)

return GameConfig
