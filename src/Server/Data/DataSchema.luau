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

	NEVER put a consumable starting item in Template. Reconcile backfills
	template keys on every load, and inventory entries are deleted at zero, so a
	starter item in Template is re-granted every time a player logs in having
	spent it. Starting items belong in GameConfig.StarterKit, which is granted
	once behind the StarterKitGranted flag.
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
	RevengeTokens = GameConfig.Economy.StartingRevengeTokens,

	--[[
		Flat inventory: item id -> amount, for EVERY category.

		Nothing here knows whether an id is a seed, a crop or a side of beef;
		that lives on the item definition in GameConfig.Items. Adding a new
		category needs no change to storage, replication or this schema.

		Entries are deleted when they reach zero so saved data stays compact -
		which is exactly why starting items must not live in this template.
	]]
	Inventory = {},

	-- Set the first time a profile loads, so the starter kit is granted once.
	StarterKitGranted = false,

	--[[
		Planted crops, keyed by STRINGIFIED plot index:
			Plots = { ["1"] = { SeedId = "CarrotSeed", PlantedAt = 1700000000 } }

		String keys are deliberate. DataStores serialise through JSON, which
		does not round-trip sparse integer keys. Growth is derived from
		PlantedAt, so crops keep growing while offline.
	]]
	Plots = {},

	-- PurchaseIds already granted, oldest first: the receipt idempotency ledger.
	PurchaseHistory = {},

	Stats = {
		TotalHarvested = 0,
		TotalPlanted = 0,
		TotalCashEarned = 0,
		JoinCount = 0,
		PlayTime = 0,
		LastSeen = 0,
		RobuxSpent = 0,
		PurchasesProcessed = 0,
		TotalItemsBought = 0,
		TotalItemsSold = 0,
	},
}

--------------------------------------------------------------------------------
-- Migrations
--------------------------------------------------------------------------------

--[[
	v1 stored seeds and crops under the same id, separated by inventory bucket
	(Inventory.Seeds.Carrot vs Inventory.Crops.Carrot). A flat namespace cannot
	represent that, so seeds gained an explicit "...Seed" id.
]]
local V1_SEED_RENAMES = {
	Carrot = "CarrotSeed",
	Tomato = "TomatoSeed",
	Pumpkin = "PumpkinSeed",
	Watermelon = "WatermelonSeed",
	GoldenApple = "GoldenAppleSeed",
	Starfruit = "StarfruitSeed",
}

DataSchema.Migrations = {
	--[[
		v1 -> v2: flatten the bucketed inventory into a single item-id map.

		  Inventory = { Seeds = {Carrot=3}, Crops = {Carrot=1}, Boosts = {...} }
		    becomes
		  Inventory = { CarrotSeed = 3, Carrot = 1, GrowthBoost = ... }

		Seed ids are renamed so they no longer collide with the crop they yield,
		and planted plots are re-pointed at the new seed ids. Crop and boost ids
		are unchanged.
	]]
	[1] = function(data)
		local old = data.Inventory

		if type(old) == "table" then
			local flat = {}

			local function absorb(bucketName: string, rename: boolean)
				local bucket = old[bucketName]
				if type(bucket) ~= "table" then
					return
				end

				for itemId, amount in bucket do
					if type(itemId) ~= "string" then
						continue
					end

					local count = tonumber(amount)
					if count == nil then
						continue
					end

					local newId = if rename then V1_SEED_RENAMES[itemId] or itemId else itemId
					flat[newId] = (flat[newId] or 0) + count
				end
			end

			absorb("Seeds", true)
			absorb("Crops", false)
			absorb("Boosts", false)

			data.Inventory = flat
		else
			data.Inventory = {}
		end

		-- Planted plots referenced seeds by the old id.
		if type(data.Plots) == "table" then
			for _, entry in data.Plots do
				if type(entry) == "table" and type(entry.SeedId) == "string" then
					entry.SeedId = V1_SEED_RENAMES[entry.SeedId] or entry.SeedId
				end
			end
		end

		-- v1 players already own their starter seeds; granting again would be a
		-- windfall on the first v2 load.
		data.StarterKitGranted = true

		-- Shop counters became category-agnostic.
		if type(data.Stats) == "table" then
			data.Stats.TotalItemsBought = tonumber(data.Stats.TotalSeedsBought) or 0
			data.Stats.TotalItemsSold = tonumber(data.Stats.TotalCropsSold) or 0
			data.Stats.TotalSeedsBought = nil
			data.Stats.TotalCropsSold = nil
		end
	end,
}

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
	data.StarterKitGranted = data.StarterKitGranted == true
	data.SchemaVersion = DataSchema.Version

	--------------------------------------------------------------------------
	-- Inventory
	--------------------------------------------------------------------------

	if type(data.Inventory) ~= "table" then
		data.Inventory = {}
	end

	for itemId, amount in data.Inventory do
		local item = GameConfig.GetItem(itemId)
		local count = toFiniteNumber(amount)

		-- Unknown ids are dropped: the master directory is the authority on
		-- what can exist, so removed or renamed content cannot linger.
		if item == nil or count == nil or math.floor(count) <= 0 then
			data.Inventory[itemId] = nil
		else
			data.Inventory[itemId] = math.min(math.floor(count), item.MaxStack)
		end
	end

	--------------------------------------------------------------------------
	-- Purchase ledger
	--------------------------------------------------------------------------

	-- Must stay a dense array of strings: JSON-safe that way, and searched with
	-- table.find during receipt processing.
	if type(data.PurchaseHistory) ~= "table" then
		data.PurchaseHistory = {}
	end

	local history = {}

	for _, purchaseId in data.PurchaseHistory do
		if type(purchaseId) == "string" and purchaseId ~= "" then
			table.insert(history, purchaseId)
		end
	end

	while #history > GameConfig.Monetization.MaxPurchaseHistory do
		table.remove(history, 1)
	end

	data.PurchaseHistory = history

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
		-- seed which no longer exists in GameConfig.
		local isUsable = type(key) == "string"
			and index ~= nil
			and index == math.floor(index)
			and index >= 1
			and index <= plotCount
			and plantedAt ~= nil
			and GameConfig.GetPlantable(entry.SeedId) ~= nil

		if not isUsable then
			data.Plots[key] = nil
			continue
		end

		-- A PlantedAt in the future would stall growth forever, which is both a
		-- clock-skew symptom and an obvious tamper target.
		entry.PlantedAt = math.min(math.floor(plantedAt), now)
	end

	return data
end

--------------------------------------------------------------------------------
-- Starter kit
--------------------------------------------------------------------------------

--[[
	Grants GameConfig.StarterKit exactly once per profile and marks it granted.
	Returns true if anything was granted.

	Writes straight into the data table rather than going through
	PlayerDataService's mutators, because it runs before the profile is
	published and before any replication or signals exist for it.
]]
function DataSchema.GrantStarterKit(data: { [string]: any }): boolean
	if data.StarterKitGranted then
		return false
	end

	data.StarterKitGranted = true

	for itemId, amount in GameConfig.StarterKit do
		local item = GameConfig.GetItem(itemId)

		if item then
			local current = data.Inventory[itemId] or 0
			data.Inventory[itemId] = math.min(current + amount, item.MaxStack)
		end
	end

	return true
end

return DataSchema
