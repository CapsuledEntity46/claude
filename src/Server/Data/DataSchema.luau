--!nonstrict
--[[
	DataSchema
	----------
	Declares the saved shape of a player profile and the migration path between
	schema versions.

	Rules for editing this file:

	1. ADDING a field  -> add it to Template. Existing players receive it on
	   their next load via TableUtil.Reconcile. No migration needed.
	2. RENAMING or RESHAPING a field -> bump GameConfig.Data.SchemaVersion and
	   add a migration function keyed by the version you are migrating *from*.
	3. REMOVING a field -> delete it from Template and strip it in a migration,
	   otherwise stale keys linger in saved data forever.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local TableUtil = require(Shared.TableUtil)

local DataSchema = {}

DataSchema.Version = GameConfig.Data.SchemaVersion

--------------------------------------------------------------------------------
-- Template
--------------------------------------------------------------------------------

DataSchema.Template = {
	SchemaVersion = DataSchema.Version,

	Cash = GameConfig.Economy.StartingCash,
	Level = 1,
	XP = 0,

	-- Seed/crop id -> amount. Entries are removed entirely when they hit zero
	-- so the saved table never accumulates dead keys.
	Inventory = {
		Seeds = {
			Carrot = 3,
		},
		Crops = {},
	},

	Stats = {
		TotalHarvested = 0,
		TotalPlanted = 0,
		TotalCashEarned = 0,
		JoinCount = 0,
		PlayTime = 0,
		LastSeen = 0,
	},
}

--------------------------------------------------------------------------------
-- Migrations
--------------------------------------------------------------------------------

--[[
	Each entry transforms data saved at version N into version N + 1, in place.
	Migrations run in sequence, so a player returning from version 1 to version
	4 passes through every intermediate step.

	Example of what a real migration looks like:

	[1] = function(data)
		-- v1 stored a flat inventory; v2 buckets it by category.
		local flat = data.Inventory
		data.Inventory = { Seeds = flat, Crops = {} }
	end,
]]
DataSchema.Migrations = {}

--- Brings `data` up to the current schema version, running each migration in
--- order. Returns true when the data was modified.
function DataSchema.Migrate(data: { [string]: any }): boolean
	local from = tonumber(data.SchemaVersion) or 1
	local migrated = false

	while from < DataSchema.Version do
		local migration = DataSchema.Migrations[from]

		if migration then
			local ok, err = pcall(migration, data)
			if not ok then
				-- A failed migration must not silently corrupt the profile.
				-- Abort here; the caller keeps the un-migrated data and the
				-- reconcile pass below still guarantees required fields exist.
				warn(`[DataSchema] Migration from v{from} failed: {err}`)
				break
			end
		end

		from += 1
		data.SchemaVersion = from
		migrated = true
	end

	return migrated
end

--- Full normalisation pass: migrate, then backfill anything missing, then
--- validate value types. Called on every load before gameplay sees the data.
function DataSchema.Normalize(data: { [string]: any }): { [string]: any }
	DataSchema.Migrate(data)
	TableUtil.Reconcile(data, DataSchema.Template)

	-- Defensive type coercion. Protects against hand-edited saves and against
	-- bugs in older game versions that wrote the wrong type.
	data.Cash = math.clamp(math.floor(tonumber(data.Cash) or 0), 0, GameConfig.Economy.MaxCash)
	data.Level = math.clamp(math.floor(tonumber(data.Level) or 1), 1, GameConfig.Progression.MaxLevel)
	data.XP = math.max(math.floor(tonumber(data.XP) or 0), 0)
	data.SchemaVersion = DataSchema.Version

	if type(data.Inventory) ~= "table" then
		data.Inventory = TableUtil.DeepCopy(DataSchema.Template.Inventory)
	end

	for _, category in GameConfig.InventoryCategories do
		local bucket = data.Inventory[category]

		if type(bucket) ~= "table" then
			data.Inventory[category] = {}
			continue
		end

		for itemId, amount in bucket do
			local count = math.floor(tonumber(amount) or 0)

			if type(itemId) ~= "string" or count <= 0 then
				bucket[itemId] = nil
			else
				bucket[itemId] = math.min(count, GameConfig.Inventory.MaxStack)
			end
		end
	end

	-- Drop buckets that are no longer part of the schema.
	for category in data.Inventory do
		if not GameConfig.IsValidCategory(category) then
			data.Inventory[category] = nil
		end
	end

	return data
end

return DataSchema
