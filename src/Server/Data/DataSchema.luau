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

--[[
	Coerces a value to a finite number, or returns nil.

	`tonumber` is not enough on its own: tonumber(1/0) is inf, not nil, and
	math.floor/math.clamp happily propagate inf and NaN into saved data. Any
	non-finite number reaching a profile is corruption, so it is rejected here.
]]
local function toFiniteNumber(value: unknown): number?
	local number = tonumber(value)

	if number == nil or number ~= number or number == math.huge or number == -math.huge then
		return nil
	end

	return number
end

--------------------------------------------------------------------------------
-- Template
--------------------------------------------------------------------------------

DataSchema.Template = {
	SchemaVersion = DataSchema.Version,

	Cash = GameConfig.Economy.StartingCash,
	Level = 1,
	XP = 0,

	-- Granted free to new players. Because this field is added via Reconcile,
	-- anyone who saved before it existed also receives the starting amount on
	-- their next load, which is the intended behaviour for a new currency.
	RevengeTokens = GameConfig.Economy.StartingRevengeTokens,

	--[[
		PurchaseIds of Developer Product receipts this player has already been
		granted, oldest first.

		This is the idempotency ledger for MarketplaceService. ProcessReceipt is
		retried until it returns PurchaseGranted, so without a durable record of
		what was already honoured, one payment can be granted many times.
	]]
	PurchaseHistory = {},

	-- Seed/crop id -> amount. Entries are removed entirely when they hit zero
	-- so the saved table never accumulates dead keys.
	Inventory = {
		Seeds = {
			Carrot = 3,
		},
		Crops = {},
	},

	--[[
		Planted crops, keyed by STRINGIFIED plot index:
			Plots = { ["1"] = { SeedId = "Carrot", PlantedAt = 1700000000 } }

		String keys are deliberate. DataStores serialise through JSON, which
		does not round-trip sparse integer keys - a table with holes comes back
		with string keys anyway. Using strings from the start keeps the saved
		and in-memory shapes identical.

		Growth is derived from PlantedAt, so crops keep growing while offline.
	]]
	Plots = {},

	Stats = {
		TotalHarvested = 0,
		TotalPlanted = 0,
		TotalCashEarned = 0,
		JoinCount = 0,
		PlayTime = 0,
		LastSeen = 0,
		RobuxSpent = 0,
		PurchasesProcessed = 0,
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
	data.Cash = math.clamp(math.floor(toFiniteNumber(data.Cash) or 0), 0, GameConfig.Economy.MaxCash)
	data.Level = math.clamp(math.floor(toFiniteNumber(data.Level) or 1), 1, GameConfig.Progression.MaxLevel)
	data.XP = math.max(math.floor(toFiniteNumber(data.XP) or 0), 0)
	data.RevengeTokens = math.clamp(
		math.floor(toFiniteNumber(data.RevengeTokens) or GameConfig.Economy.StartingRevengeTokens),
		0,
		GameConfig.Economy.MaxRevengeTokens
	)
	data.SchemaVersion = DataSchema.Version

	--------------------------------------------------------------------------
	-- Purchase ledger
	--------------------------------------------------------------------------

	-- Must stay a dense array of strings: it is both JSON-safe that way and
	-- searched with table.find during receipt processing.
	if type(data.PurchaseHistory) ~= "table" then
		data.PurchaseHistory = {}
	end

	local history = {}

	for _, purchaseId in data.PurchaseHistory do
		if type(purchaseId) == "string" and purchaseId ~= "" then
			table.insert(history, purchaseId)
		end
	end

	-- Trim oldest first if the cap shrank between versions.
	while #history > GameConfig.Monetization.MaxPurchaseHistory do
		table.remove(history, 1)
	end

	data.PurchaseHistory = history

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
			local count = toFiniteNumber(amount)

			if type(itemId) ~= "string" or count == nil or math.floor(count) <= 0 then
				bucket[itemId] = nil
			else
				bucket[itemId] = math.min(math.floor(count), GameConfig.Inventory.MaxStack)
			end
		end
	end

	-- Drop buckets that are no longer part of the schema.
	for category in data.Inventory do
		if not GameConfig.IsValidCategory(category) then
			data.Inventory[category] = nil
		end
	end

	--------------------------------------------------------------------------
	-- Plots
	--------------------------------------------------------------------------

	if type(data.Plots) ~= "table" then
		data.Plots = {}
	end

	local now = os.time()
	local plotCount = GameConfig.Garden.PlotsPerGarden

	for key, entry in data.Plots do
		local index = toFiniteNumber(key)
		local plantedAt = if type(entry) == "table" then toFiniteNumber(entry.PlantedAt) else nil

		-- Drop anything that would not map onto a real plot, or that names a
		-- seed which no longer exists in GameConfig (removed/renamed content).
		local isUsable = type(key) == "string"
			and index ~= nil
			and index == math.floor(index)
			and index >= 1
			and index <= plotCount
			and plantedAt ~= nil
			and GameConfig.GetSeed(entry.SeedId) ~= nil

		if not isUsable then
			data.Plots[key] = nil
			continue
		end

		-- A PlantedAt in the future would stall growth forever, which is both a
		-- clock-skew symptom and an obvious tamper target.
		entry.PlantedAt = math.min(math.floor(plantedAt), now)
		entry.SeedId = GameConfig.GetSeed(entry.SeedId).Id
	end

	return data
end

return DataSchema
