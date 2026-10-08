--!strict
--[[
	Types
	-----
	Shared type definitions for persisted data. Importing these keeps gameplay
	systems honest about the shape of a profile instead of passing loose tables
	around.
]]

--- Flat inventory: item id -> amount, for every category.
export type Inventory = { [string]: number }

--- The civilisation treasury: resource id -> amount (Food/Wood/Gold/Stone).
export type Resources = { [string]: number }

export type PlotEntry = {
	SeedId: string,
	PlantedAt: number,
}

export type PlayerStats = {
	TotalHarvested: number,
	TotalPlanted: number,
	TotalGoldEarned: number,
	JoinCount: number,
	PlayTime: number,
	LastSeen: number,
	RobuxSpent: number,
	PurchasesProcessed: number,
	TotalItemsBought: number,
	TotalItemsSold: number,
}

export type PlayerData = {
	SchemaVersion: number,

	-- Civilisation
	Resources: Resources,
	Age: number,

	--[[
		The player's personal purse, deliberately separate from Resources.Gold.
		Filled only by kills and loot; never by market income. No code path
		moves value from the treasury into it.
	]]
	InventoryGold: number,
	AutoUsePersonalGold: boolean,

	-- Character
	Level: number,
	XP: number,
	RevengeTokens: number,

	Inventory: Inventory,
	StarterKitGranted: boolean,
	BonusPlotSlots: number,
	Plots: { [string]: PlotEntry },
	PurchaseHistory: { string },
	Stats: PlayerStats,
}

export type ProfileMetaData = {
	CreatedAt: number,
	LastUpdate: number,
	SaveCount: number,
	SessionLock: { JobId: string, PlaceId: number, Timestamp: number }?,
	RecoveredFromBackup: boolean?,
}

export type TransactionResult = {
	Ok: boolean,
	Reason: string?,
	ItemId: string?,
	Amount: number?,
	Spent: number?,
	Earned: number?,
	Held: number?,
	Gold: number?,
}

return {}
