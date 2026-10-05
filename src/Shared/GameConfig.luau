--!strict
--[[
	GameConfig
	----------
	Single source of truth for tunable game values, shared by server and client.

	Nothing in here is authoritative on its own: the server always validates
	against these tables before mutating a profile. The client may read them
	freely for UI purposes (prices, icons, XP bars) without a round trip.
]]

export type Rarity = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary"

export type SeedDefinition = {
	Id: string,
	DisplayName: string,
	Rarity: Rarity,
	SeedPrice: number, -- Cash cost to buy one seed
	SellPrice: number, -- Cash earned per harvested crop
	GrowTime: number, -- Seconds from planting to fully grown
	XPReward: number, -- XP granted on harvest
	RequiredLevel: number, -- Level gate for purchasing/planting
	Color: Color3, -- Used by crop models and UI chips
}

local GameConfig = {}

--------------------------------------------------------------------------------
-- Persistence
--------------------------------------------------------------------------------

GameConfig.Data = {
	-- Bump this whenever the saved layout changes in a way that needs a
	-- migration step in DataSchema.Migrations.
	SchemaVersion = 1,

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

	local base = GameConfig.Progression.BaseXP
	local exponent = GameConfig.Progression.Exponent

	return math.floor(base * (level ^ exponent))
end

--------------------------------------------------------------------------------
-- Inventory
--------------------------------------------------------------------------------

-- Inventory is bucketed so that seeds, harvested crops and future item classes
-- never collide on an id. Each bucket replicates to the owning client as its
-- own attribute container.
GameConfig.InventoryCategories = { "Seeds", "Crops" }

GameConfig.Inventory = {
	MaxStack = 9_999,
}

--------------------------------------------------------------------------------
-- Seeds
--------------------------------------------------------------------------------

GameConfig.Seeds = {
	Carrot = {
		Id = "Carrot",
		DisplayName = "Carrot",
		Rarity = "Common",
		SeedPrice = 10,
		SellPrice = 25,
		GrowTime = 30,
		XPReward = 10,
		RequiredLevel = 1,
		Color = Color3.fromRGB(237, 139, 48),
	},
	Tomato = {
		Id = "Tomato",
		DisplayName = "Tomato",
		Rarity = "Common",
		SeedPrice = 25,
		SellPrice = 60,
		GrowTime = 60,
		XPReward = 22,
		RequiredLevel = 3,
		Color = Color3.fromRGB(214, 61, 56),
	},
	Pumpkin = {
		Id = "Pumpkin",
		DisplayName = "Pumpkin",
		Rarity = "Uncommon",
		SeedPrice = 80,
		SellPrice = 210,
		GrowTime = 150,
		XPReward = 55,
		RequiredLevel = 8,
		Color = Color3.fromRGB(226, 132, 38),
	},
	Watermelon = {
		Id = "Watermelon",
		DisplayName = "Watermelon",
		Rarity = "Rare",
		SeedPrice = 240,
		SellPrice = 660,
		GrowTime = 320,
		XPReward = 140,
		RequiredLevel = 15,
		Color = Color3.fromRGB(72, 160, 84),
	},
	GoldenApple = {
		Id = "GoldenApple",
		DisplayName = "Golden Apple",
		Rarity = "Epic",
		SeedPrice = 900,
		SellPrice = 2_600,
		GrowTime = 600,
		XPReward = 420,
		RequiredLevel = 25,
		Color = Color3.fromRGB(240, 199, 62),
	},
	Starfruit = {
		Id = "Starfruit",
		DisplayName = "Starfruit",
		Rarity = "Legendary",
		SeedPrice = 3_500,
		SellPrice = 11_000,
		GrowTime = 1_200,
		XPReward = 1_250,
		RequiredLevel = 40,
		Color = Color3.fromRGB(126, 118, 224),
	},
} :: { [string]: SeedDefinition }

--- Returns the seed definition for `seedId`, or nil when the id is unknown.
--- Always use this instead of indexing GameConfig.Seeds with client input.
function GameConfig.GetSeed(seedId: unknown): SeedDefinition?
	if type(seedId) ~= "string" then
		return nil
	end

	return GameConfig.Seeds[seedId]
end

function GameConfig.IsValidCategory(category: unknown): boolean
	if type(category) ~= "string" then
		return false
	end

	return table.find(GameConfig.InventoryCategories, category) ~= nil
end

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
}

GameConfig.InventoryFolderName = "Inventory"

table.freeze(GameConfig.Attributes)
table.freeze(GameConfig.InventoryCategories)

return GameConfig
