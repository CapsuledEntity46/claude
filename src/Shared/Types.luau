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

export type PlotEntry = {
	SeedId: string,
	PlantedAt: number,
}

export type PlayerStats = {
	TotalHarvested: number,
	TotalPlanted: number,
	TotalCashEarned: number,
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
	Cash: number,
	Level: number,
	XP: number,
	RevengeTokens: number,
	Inventory: Inventory,
	StarterKitGranted: boolean,
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
	Cash: number?,
}

return {}
