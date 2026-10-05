--!strict
--[[
	Types
	-----
	Shared type definitions for persisted data. Importing these keeps gameplay
	systems honest about the shape of a profile instead of passing loose tables
	around.
]]

export type ItemMap = { [string]: number }

export type Inventory = {
	Seeds: ItemMap,
	Crops: ItemMap,
}

export type PlayerStats = {
	TotalHarvested: number,
	TotalPlanted: number,
	TotalCashEarned: number,
	JoinCount: number,
	PlayTime: number,
	LastSeen: number,
}

export type PlayerData = {
	SchemaVersion: number,
	Cash: number,
	Level: number,
	XP: number,
	Inventory: Inventory,
	Stats: PlayerStats,
}

export type ProfileMetaData = {
	CreatedAt: number,
	LastUpdate: number,
	SaveCount: number,
	SessionLock: { JobId: string, PlaceId: number, Timestamp: number }?,
	RecoveredFromBackup: boolean?,
}

return {}
