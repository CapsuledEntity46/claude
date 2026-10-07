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

	--[[
		The civilisation treasury: resource id -> amount, for Food/Wood/Gold/Stone.

		Left EMPTY here on purpose. Reconcile backfills template keys on every
		load, so a starting balance in the template would be re-granted to any
		player who spent a resource to zero. Starting amounts come from
		GameConfig.StartingResources, granted once behind StarterKitGranted.
	]]
	Resources = {},

	--[[
		The player's personal purse, kept entirely separate from the treasury.

		Earned only from kills and loot; spent only on personal equipment, or
		willingly on construction. NOTHING in this codebase moves value from
		Resources.Gold into InventoryGold - the absence of that path is the rule.
	]]
	InventoryGold = 0,

	-- Civilisation progression. Gates what can be built and researched, and is
	-- bought with resources, never XP.
	Age = 1,

	Level = 1,
	XP = 0,
	RevengeTokens = GameConfig.Economy.StartingRevengeTokens,

	--[[
		The level of the worst raid this player has faced. Sizes the revenge
		army, which is chosen after the raid is over - so the number has to
		outlive the raiders.

		Additive, so Reconcile backfills it and no migration is needed.
	]]
	LastRaidLevel = 1,

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

	-- PurchaseIds already granted, oldest first: the receipt idempotency ledger.
	PurchaseHistory = {},

	-- Player preference: pay for construction from the personal purse without
	-- being asked each time, once the treasury runs short.
	AutoUsePersonalGold = false,

	Stats = {
		TotalHarvested = 0,
		TotalPlanted = 0,
		TotalGoldEarned = 0,
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
		v3 -> v4: the fixed six-plot garden is retired. Farms are now placed
		structures, so `Plots` has nowhere to map onto.

		Anything growing is refunded as its SEED rather than silently deleted.
		The crop in the ground is lost - there is no farm to move it to - but
		the player is not out of pocket, and a refund is far easier to explain
		than a disappearance.

		`BonusPlotSlots` goes with the plots it used to unlock.
	]]
	[3] = function(data)
		if type(data.Inventory) ~= "table" then
			data.Inventory = {}
		end

		if type(data.Plots) == "table" then
			for _, entry in data.Plots do
				local seedId = if type(entry) == "table" then entry.SeedId else nil

				if type(seedId) == "string" then
					data.Inventory[seedId] = (tonumber(data.Inventory[seedId]) or 0) + 1
				end
			end
		end

		data.Plots = nil
		data.BonusPlotSlots = nil
	end,
	--[[
		v2 -> v3: a single `Cash` balance becomes the four-resource treasury.

		Cash was earned by selling produce, which is exactly what Base Gold is,
		so it converts straight across. The personal purse starts empty: it can
		only ever be filled by kills and loot, so seeding it from Cash would
		break the rule that market income cannot reach it.
	]]
	[2] = function(data)
		local carried = tonumber(data.Cash) or 0

		if type(data.Resources) ~= "table" then
			data.Resources = {}
		end

		data.Resources.Gold = (tonumber(data.Resources.Gold) or 0) + carried
		data.Cash = nil

		data.InventoryGold = tonumber(data.InventoryGold) or 0
		data.Age = tonumber(data.Age) or 1

		if type(data.Stats) == "table" then
			data.Stats.TotalGoldEarned = tonumber(data.Stats.TotalCashEarned) or 0
			data.Stats.TotalCashEarned = nil
		end
	end,
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
	data.Level = math.clamp(math.floor(toFiniteNumber(data.Level) or 1), 1, GameConfig.Progression.MaxLevel)
	data.XP = math.max(math.floor(toFiniteNumber(data.XP) or 0), 0)
	data.LastRaidLevel = math.max(math.floor(toFiniteNumber(data.LastRaidLevel) or 1), 1)

	data.RevengeTokens = math.clamp(
		math.floor(toFiniteNumber(data.RevengeTokens) or GameConfig.Economy.StartingRevengeTokens),
		0,
		GameConfig.Economy.MaxRevengeTokens
	)
	data.StarterKitGranted = data.StarterKitGranted == true
	data.AutoUsePersonalGold = data.AutoUsePersonalGold == true
	data.InventoryGold = math.clamp(
		math.floor(toFiniteNumber(data.InventoryGold) or 0),
		0,
		GameConfig.Economy.MaxInventoryGold
	)
	data.Age = math.clamp(math.floor(toFiniteNumber(data.Age) or 1), 1, GameConfig.MaxAge)

	--------------------------------------------------------------------------
	-- Treasury
	--------------------------------------------------------------------------

	if type(data.Resources) ~= "table" then
		data.Resources = {}
	end

	-- Every resource always has an explicit balance, so a key is never absent
	-- and Reconcile can never re-grant a starting amount.
	for resourceId in GameConfig.Resources do
		data.Resources[resourceId] =
			math.clamp(math.floor(toFiniteNumber(data.Resources[resourceId]) or 0), 0, GameConfig.Economy.MaxResource)
	end

	-- Drop balances for resources that no longer exist.
	for resourceId in data.Resources do
		if GameConfig.GetResource(resourceId) == nil then
			data.Resources[resourceId] = nil
		end
	end
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
	-- Structures
	--------------------------------------------------------------------------

	-- Shared by the structure and crop timestamp clamps below. A future
	-- timestamp would stall growth and healing forever, which is both a
	-- clock-skew symptom and an obvious tamper target.
	local now = os.time()

	if type(data.Structures) ~= "table" then
		data.Structures = {}
	end

	data.NextStructureId = math.max(math.floor(toFiniteNumber(data.NextStructureId) or 0), 0)

	local highestId = 0

	for key, entry in data.Structures do
		local numericKey = toFiniteNumber(key)
		local structure = if type(entry) == "table" then GameConfig.GetStructure(entry.StructureId) else nil
		local x = if type(entry) == "table" then toFiniteNumber(entry.X) else nil
		local z = if type(entry) == "table" then toFiniteNumber(entry.Z) else nil

		-- Drop anything that cannot map onto a real structure, or that names a
		-- structure removed from the directory.
		local usable = type(key) == "string"
			and numericKey ~= nil
			and numericKey >= 1
			and structure ~= nil
			and x ~= nil
			and z ~= nil

		if not usable then
			data.Structures[key] = nil
			continue
		end

		local limit = GameConfig.Placement.WorldLimit
		entry.X = math.clamp(math.floor(x), -limit, limit)
		entry.Z = math.clamp(math.floor(z), -limit, limit)
		entry.Shattered = entry.Shattered == true

		local archetype = GameConfig.Archetypes[structure.ArchetypeId]
		local health = toFiniteNumber(entry.Health)

		if health == nil then
			entry.Health = nil
			entry.DamagedAt = nil
		else
			entry.Health = math.clamp(math.floor(health), 0, archetype.MaxHealth)
			entry.DamagedAt = math.min(math.floor(toFiniteNumber(entry.DamagedAt) or now), now)
		end

		--[[
			A Farm carries its crop on the same record as the structure, so
			demolishing a farm takes the crop with it. A parallel table keyed by
			farm id would let a crop outlive the farm it grew on.
		]]
		if structure.HoldsCrop then
			local plantedAt = toFiniteNumber(entry.PlantedAt)

			if type(entry.SeedId) ~= "string" or GameConfig.GetPlantable(entry.SeedId) == nil or plantedAt == nil then
				entry.SeedId = ""
				entry.PlantedAt = nil
				entry.PlantCount = nil
				entry.CropHealth = nil
				entry.CropDamagedAt = nil
			else
				entry.PlantedAt = math.min(math.floor(plantedAt), now)

				--[[
					How many plants are in the square, clamped to what the seed
					allows.

					No schema migration accompanies this field, deliberately.
					Structure entries are not covered by the Template, so
					Reconcile never sees them and this block is the only place
					they are defaulted - which means a record saved before
					stacking existed is handled here, by reading a missing
					count as ONE. That is exactly what such a record holds: a
					single plant. A migration would do the same work in a
					place that only runs once.

					The clamp also matters after a config edit: dropping a
					crop's capacity must not leave old squares over-full and
					paying out more than the tier allows.
				]]
				local capacity = GameConfig.GetPlantCapacity(entry.SeedId)
				local count = math.floor(toFiniteNumber(entry.PlantCount) or 1)
				entry.PlantCount = math.clamp(count, 1, math.max(capacity, 1))

				local cropMax = GameConfig.Archetypes.Crop.MaxHealth
				local cropHealth = toFiniteNumber(entry.CropHealth)

				if cropHealth == nil then
					entry.CropHealth = nil
					entry.CropDamagedAt = nil
				else
					entry.CropHealth = math.clamp(math.floor(cropHealth), 0, cropMax)
					entry.CropDamagedAt = math.min(math.floor(toFiniteNumber(entry.CropDamagedAt) or now), now)
				end
			end
		end

		highestId = math.max(highestId, numericKey)
	end

	-- Never hand out an id that is already in use, even if the counter was lost.
	data.NextStructureId = math.max(data.NextStructureId, highestId)

	return data
end

--------------------------------------------------------------------------------
-- Starter kit
--------------------------------------------------------------------------------

--[[
	Grants GameConfig.StarterKit and GameConfig.StartingResources exactly once
	per profile, and marks it granted.
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

	for resourceId, amount in GameConfig.StartingResources do
		if GameConfig.GetResource(resourceId) then
			data.Resources[resourceId] = math.min(
				(data.Resources[resourceId] or 0) + amount,
				GameConfig.Economy.MaxResource
			)
		end
	end

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
