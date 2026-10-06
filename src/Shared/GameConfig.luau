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
	-- purposes but is not tradeable for Cash).
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

--------------------------------------------------------------------------------
-- Persistence
--------------------------------------------------------------------------------

GameConfig.Data = {
	-- Bumped to 2 when the inventory was flattened from category buckets to a
	-- single item-id map. See DataSchema.Migrations.
	SchemaVersion = 2,

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
	StartingCash = 150,
	-- Hard ceiling keeps a single bad multiplier from pushing a value past the
	-- range where doubles stop representing integers exactly.
	MaxCash = 1_000_000_000,

	StartingRevengeTokens = 2,
	MaxRevengeTokens = 9_999,
}

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
	-- Boosts: Robux-only, so neither buyable nor sellable for Cash
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
-- Gardens and plots
--------------------------------------------------------------------------------

GameConfig.Garden = {
	Origin = Vector3.new(0, 0.5, 0),
	SlotSpacing = Vector3.new(80, 0, 80),
	SlotsPerRow = 5,

	PlotsPerGarden = 6,
	PlotsPerRow = 3,

	SoilSize = Vector3.new(8, 1, 8),
	SoilSpacing = 10,
	SoilColor = Color3.fromRGB(94, 66, 45),
	LockedSoilColor = Color3.fromRGB(72, 72, 72),
	BaseColor = Color3.fromRGB(106, 142, 74),
	BasePadding = 6,

	PlotUnlockLevels = { 1, 1, 3, 8, 15, 25 },

	MaxActivationDistance = 14,
	DistanceTolerance = 8,
	InteractionCooldown = 0.35,
}

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
	Cash = "Cash",
	Level = "Level",
	XP = "XP",
	XPToNextLevel = "XPToNextLevel",
	DataLoaded = "DataLoaded",
	SelectedSeed = "SelectedSeed",
	RevengeTokens = "RevengeTokens",
	TargetPlot = "TargetPlot",
}

GameConfig.PlotAttributes = {
	OwnerUserId = "OwnerUserId",
	PlotIndex = "PlotIndex",
	SeedId = "SeedId",
	PlantedAt = "PlantedAt",
	ReadyAt = "ReadyAt",
	Stage = "Stage",
	Locked = "Locked",
	UnlockLevel = "UnlockLevel",
}

-- A single flat folder now: one attribute per item id, no category subfolders.
GameConfig.InventoryFolderName = "Inventory"
GameConfig.GardensFolderName = "Gardens"

GameConfig.RemoteNames = {
	SelectSeed = "SelectSeed",
	SelectPlot = "SelectPlot",
	UseBoost = "UseBoost",

	-- RemoteFunctions
	ProcessTransaction = "ProcessTransaction",
	SellAll = "SellAll",
}

--------------------------------------------------------------------------------
-- Monetization
--------------------------------------------------------------------------------

export type ProductDefinition = {
	Kind: string,
	ProductId: number,
	DisplayName: string,
	Amount: number,
}

GameConfig.Monetization = {
	Products = {
		RevengeToken = {
			Kind = "RevengeToken",
			ProductId = 0,
			DisplayName = "+1 Revenge Token",
			Amount = 1,
		},
		GrowthBoost = {
			Kind = "GrowthBoost",
			ProductId = 0,
			DisplayName = "Instant Grow",
			Amount = 1,
		},
	} :: { [string]: ProductDefinition },

	GrowthBoostItemId = "GrowthBoost",
	MaxPurchaseHistory = 100,
}

for name, product in GameConfig.Monetization.Products do
	assert(product.Kind == name, `product {name} has a mismatched Kind field`)
	assert(product.Amount > 0, `product {name} must grant a positive amount`)
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

assert(
	#GameConfig.Garden.PlotUnlockLevels == GameConfig.Garden.PlotsPerGarden,
	"GameConfig.Garden.PlotUnlockLevels must have one entry per plot"
)

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

for itemId, amount in GameConfig.StarterKit do
	assert(GameConfig.Items[itemId] ~= nil, `StarterKit references unknown item {itemId}`)
	assert(amount > 0, `StarterKit entry {itemId} must be positive`)
end

table.freeze(GameConfig.Attributes)
table.freeze(GameConfig.PlotAttributes)
table.freeze(GameConfig.RemoteNames)
table.freeze(GameConfig.ItemCategories)
table.freeze(GameConfig.TransactionActions)

return GameConfig
