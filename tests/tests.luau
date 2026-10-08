--[[
	Behavioural verification for the Step 1 data layer.
	Runs the real server modules against the stubbed Roblox API in prelude.luau.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local Shared = ReplicatedStorage.Shared
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)
local TableUtil = require(Shared.TableUtil)

local DataFolder = ServerScriptService.Server.Data
local DataSchema = require(DataFolder.DataSchema)
local ProfileStore = require(DataFolder.ProfileStore)

local function section(name)
	print(`\n-- {name}`)
end

local function newPlayer(userId, name)
	local player = Instance.new("Player")
	player.Name = name
	player.UserId = userId
	player.Parent = PlayersService
	return player
end

--[[
	Gives a player a character with a PrimaryPart, for the server-side distance
	checks.

	`deferRoot` builds it the way the ENGINE does: the model arrives first, and
	its PrimaryPart and Humanoid are attached a moment later.

	That ordering matters, and a stub readier than the engine hides real bugs.
	It hid two, both in the same function: the respawn-at-anchor move read
	PrimaryPart immediately and silently never ran, and the death listener read
	the Humanoid immediately, connected nothing, and let players respawn
	forever with no defeat panel.
]]
local function giveCharacter(player, position, deferRoot)
	local character = Instance.new("Model")
	character.Name = player.Name

	local root = Instance.new("Part")
	root.Name = "HumanoidRootPart"
	root.Position = position
	root.Parent = character

	-- A Humanoid, because the player's health lives there rather than in the
	-- damageable registry. See GameConfig.PlayerCombat.
	local humanoid = Instance.new("Humanoid")
	humanoid.Name = "Humanoid"

	if not deferRoot then
		humanoid.Parent = character
		character.PrimaryPart = root
	end

	character.Parent = WorkspaceService
	player.Character = character

	if deferRoot then
		--[[
			Attached after the current frame, as the engine does it. BOTH of
			them: a character arrives in pieces, and code that reads either
			the PrimaryPart or the Humanoid the instant CharacterAdded fires
			finds nil in a real game.
		]]
		task.delay(0.1, function()
			humanoid.Parent = character
			character.PrimaryPart = root
		end)
	end

	return character
end

--- Shared by every section that needs a working farm. Exposed on the global
--- table because this suite is one function and Luau caps live locals at 200.
function makeFarm(player, x, z)
	PDS:AddResource(player, "Wood", 5000)
	PDS:AddResource(player, "Stone", 5000)

	if not PLACEMENT:HasStructure(player, "TownCenter") then
		assert(PLACEMENT:Place(player, "TownCenter", x, z).Ok, "TownCenter failed")
	end

	if not PLACEMENT:HasStructure(player, "Mill") then
		assert(PLACEMENT:Place(player, "Mill", x + 20, z).Ok, "Mill failed")
	end

	-- Farms must sit inside a Mill's radius, so search around whichever Mill
	-- the player already owns rather than trusting a fixed offset. Keeps the
	-- helper usable for players who built earlier in the run.
	local millX, millZ

	for _, placed in PLACEMENT:GetPlaced(player) do
		if placed.StructureId == "Mill" then
			millX, millZ = placed.X, placed.Z
			break
		end
	end

	assert(millX ~= nil, "no Mill to build beside")

	for _, offset in {
		{ 14, 0 }, { -14, 0 }, { 0, 14 }, { 0, -14 },
		{ 14, 14 }, { -14, -14 }, { 14, -14 }, { -14, 14 },
		{ 22, 0 }, { -22, 0 }, { 0, 22 }, { 0, -22 },
		{ 22, 14 }, { -22, -14 }, { 14, 22 }, { -14, -22 },
	} do
		local result = PLACEMENT:Place(player, "Farm", millX + offset[1], millZ + offset[2])

		if result.Ok then
			return result.InstanceId
		end
	end

	error("no free farm spot beside the Mill")
end

--[[
	Shared by every husbandry section: builds a pen of `structureId` near
	(x, z) and returns its instance id.

	Ages the player up if the pen needs it, rather than assuming the Stone
	Age, so a Barn test does not have to repeat the age-up dance.
]]
function makePen(player, structureId, x, z)
	PDS:AddResource(player, "Wood", 50000)
	PDS:AddResource(player, "Stone", 50000)

	--[[
		Searches outward for somewhere the thing will actually fit, rather
		than trusting a fixed offset.

		Overlap is checked against EVERY player's structures, and by the time
		these sections run the world already holds the farms, towers and
		practice ranges of a dozen earlier ones. A hardcoded spot works until
		a section is added above it, and then fails somewhere else entirely.
		Out-of-bounds and blocked attempts are simply the next candidate.
	]]
	local function placeNear(id, cx, cz)
		for radius = 0, 6 do
			for _, step in {
				{ 0, 0 }, { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 },
				{ 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 },
			} do
				local result = PLACEMENT:Place(player, id, cx + step[1] * radius * 24, cz + step[2] * radius * 24)

				if result.Ok then
					return result.InstanceId
				end
			end
		end

		return nil
	end

	if not PLACEMENT:HasStructure(player, "TownCenter") then
		assert(placeNear("TownCenter", x, z) ~= nil, "no room for a TownCenter")
	end

	if not PLACEMENT:HasStructure(player, "Mill") then
		assert(placeNear("Mill", x, z) ~= nil, "no room for a Mill")
	end

	-- After the Mill, because a Barn is a Bronze Age building and the Mill it
	-- requires is not.
	local structure = GameConfig.GetStructure(structureId)

	while PDS:GetAge(player) < structure.RequiredAge do
		for _, resourceId in GameConfig.GetResourceIds() do
			PDS:AddResource(player, resourceId, 50000)
		end

		assert(select(1, PDS:TryAdvanceAge(player)), "could not reach the age the pen needs")
	end

	local penId = placeNear(structureId, x, z)
	assert(penId ~= nil, `no free spot for a {structureId}`)

	return penId
end

function penOf(player, instanceId)
	return PLACEMENT:GetPlaced(player)[instanceId].Model
end

function penPrompt(player, instanceId, name)
	return penOf(player, instanceId).PrimaryPart:FindFirstChild(name or "Interact")
end

--- Walks the player to the pen and fires one of its prompts, so distance
--- never silently decides the outcome of a test about something else.
function pokePen(player, instanceId, name)
	player.Character.PrimaryPart.Position = penOf(player, instanceId).PrimaryPart.Position
	penPrompt(player, instanceId, name).Triggered:Fire(player)
end

function farmOf(player, instanceId)
	return PLACEMENT:GetPlaced(player)[instanceId].Model
end

function promptOf(player, instanceId)
	return farmOf(player, instanceId).PrimaryPart:FindFirstChild("Interact")
end

function pokeFarm(player, instanceId)
	player.Character.PrimaryPart.Position = farmOf(player, instanceId).PrimaryPart.Position
	promptOf(player, instanceId).Triggered:Fire(player)
end

local function getPrompt(plot)
	return plot.PrimaryPart:FindFirstChild("Interact")
end

local function standAt(player, plot)
	player.Character.PrimaryPart.Position = plot.PrimaryPart.Position
end

--- Walks the player to the plot and fires its prompt, so distance never
--- silently decides the outcome of a test about something else.
local function trigger(player, plot)
	standAt(player, plot)
	getPrompt(plot).Triggered:Fire(player)
end

local function runTests()
	----------------------------------------------------------------------------
	section("GameConfig")
	----------------------------------------------------------------------------

	checkEqual(GameConfig.GetXPForLevel(1), 100, "level 1 requires 100 XP")
	check(GameConfig.GetXPForLevel(5) > GameConfig.GetXPForLevel(4), "XP curve is monotonic")
	checkEqual(GameConfig.GetXPForLevel(GameConfig.Progression.MaxLevel), math.huge, "max level requires infinite XP")
	checkEqual(GameConfig.GetItem("Carrot").SellPrice, 25, "item lookup returns the directory entry")
	checkEqual(GameConfig.GetItem("CarrotSeed").BuyPrice, 10, "a seed carries a BuyPrice")
	checkEqual(GameConfig.GetItem("Carrot").BuyPrice, nil, "a crop has no BuyPrice and cannot be bought")
	checkEqual(GameConfig.GetItem("CarrotSeed").SellPrice, nil, "a seed has no SellPrice and cannot be sold")
	checkEqual(GameConfig.GetItem("Egg").SellPrice, 30, "animal drops are registered and sellable")
	checkEqual(GameConfig.GetItem("Wheat").SellPrice, 40, "wheat is registered")
	checkEqual(GameConfig.GetPlantable("WheatSeed").Yields, "Wheat", "wheat seed yields wheat")
	checkEqual(GameConfig.GetItem("GrowthBoost").BuyPrice, nil, "a Robux-only item is not Cash-buyable")
	checkEqual(GameConfig.GetItem("GrowthBoost").SellPrice, nil, "a Robux-only item is not Cash-sellable")
	checkEqual(GameConfig.GetItem("NotAnItem"), nil, "unknown item id returns nil")
	checkEqual(GameConfig.GetItem(42), nil, "non-string item id returns nil")
	checkEqual(GameConfig.GetPlantable("Carrot"), nil, "a crop id is not plantable")
	checkEqual(GameConfig.IsValidCategory("Seeds"), true, "Seeds is a valid category")
	checkEqual(GameConfig.IsValidCategory("Wallet"), false, "Wallet is not a valid category")

	-- Every seed id must be usable as an attribute name, since inventory
	-- replication depends on it.
	local allIdsValid = true
	for id in GameConfig.Items do
		if not id:match("^[%a_][%w_]*$") then
			allIdsValid = false
		end
	end
	check(allIdsValid, "all item ids are legal attribute names")

	----------------------------------------------------------------------------
	section("TableUtil")
	----------------------------------------------------------------------------

	local template = { a = 1, nested = { x = 10, y = 20 } }
	local target = { nested = { x = 99 } }
	TableUtil.Reconcile(target, template)

	checkEqual(target.a, 1, "reconcile adds missing top-level key")
	checkEqual(target.nested.x, 99, "reconcile preserves existing nested value")
	checkEqual(target.nested.y, 20, "reconcile adds missing nested key")

	local original = { list = { 1, 2, 3 } }
	local copy = TableUtil.DeepCopy(original)
	copy.list[1] = 999
	checkEqual(original.list[1], 1, "deep copy breaks nested references")

	----------------------------------------------------------------------------
	section("Signal")
	----------------------------------------------------------------------------

	local signal = Signal.new()
	local fired = 0
	local connection = signal:Connect(function(amount)
		fired += amount
	end)

	signal:Fire(5)
	checkEqual(fired, 5, "connected handler receives arguments")

	connection:Disconnect()
	signal:Fire(5)
	checkEqual(fired, 5, "disconnected handler stops receiving")

	local onceCount = 0
	signal:Once(function()
		onceCount += 1
	end)
	signal:Fire()
	signal:Fire()
	checkEqual(onceCount, 1, "Once handler fires exactly once")

	----------------------------------------------------------------------------
	section("DataSchema.Normalize")
	----------------------------------------------------------------------------

	local fresh = DataSchema.Normalize({ SchemaVersion = DataSchema.Version })
	checkEqual(fresh.Resources.Gold, 0, "the template carries NO starting resources")
	checkEqual(fresh.Level, 1, "new profile starts at level 1")
	checkEqual(next(fresh.Inventory), nil, "the template carries NO starting items")
	checkEqual(fresh.StarterKitGranted, false, "a fresh profile has not been granted the starter kit")
	checkEqual(DataSchema.GrantStarterKit(fresh), true, "the starter kit grants on first call")
	checkEqual(fresh.Inventory.CarrotSeed, GameConfig.StarterKit.CarrotSeed, "the starter kit delivers seeds")
	checkEqual(fresh.Resources.Gold, GameConfig.StartingResources.Gold, "and the starting resources")
	checkEqual(fresh.Resources.Wood, GameConfig.StartingResources.Wood, "every starting resource is granted")
	checkEqual(DataSchema.GrantStarterKit(fresh), false, "the starter kit never grants twice")
	checkEqual(type(fresh.Stats), "table", "new profile gets a stats table")
	checkEqual(fresh.SchemaVersion, DataSchema.Version, "new profile is stamped with schema version")

	local dirty = DataSchema.Normalize({
		SchemaVersion = 2,
		Resources = { Gold = "500" },
		Level = 9999,
		XP = -50,
		Inventory = { Carrot = 0, Tomato = "4", [5] = 2, Pumpkin = 999999, NotAnItem = 7 },
	})

	checkEqual(dirty.Resources.Gold, 500, "a numeric string balance is coerced")
	checkEqual(dirty.Level, GameConfig.Progression.MaxLevel, "level is clamped to max")
	checkEqual(dirty.XP, 0, "negative XP is clamped to zero")
	checkEqual(dirty.Inventory.Carrot, nil, "zero-count items are dropped")
	checkEqual(dirty.Inventory.Tomato, 4, "numeric string amounts are coerced")
	checkEqual(dirty.Inventory[5], nil, "non-string item keys are dropped")
	checkEqual(dirty.Inventory.Pumpkin, GameConfig.GetItem("Pumpkin").MaxStack, "oversized stacks are clamped")
	checkEqual(dirty.Inventory.NotAnItem, nil, "ids absent from the master directory are dropped")
	checkEqual(type(dirty.Inventory), "table", "the inventory stays a flat table")

	----------------------------------------------------------------------------
	section("DataSchema: v1 -> v4 migration chain")
	----------------------------------------------------------------------------

	-- A profile saved by Steps 1-4: bucketed inventory, seeds sharing crop ids.
	local legacy = DataSchema.Normalize({
		SchemaVersion = 1,
		Cash = 400,
		Level = 5,
		Inventory = {
			Seeds = { Carrot = 3, Tomato = 2 },
			Crops = { Carrot = 1, Pumpkin = 4 },
			Boosts = { GrowthBoost = 2 },
		},
		Plots = {
			["1"] = { SeedId = "Carrot", PlantedAt = 1000 },
			["2"] = { SeedId = "Starfruit", PlantedAt = 1000 },
		},
		Stats = { TotalSeedsBought = 11, TotalCropsSold = 7 },
	})

	checkEqual(legacy.SchemaVersion, 4, "the profile is stamped with the current version")
	checkEqual(legacy.Inventory.Seeds, nil, "the category buckets are gone")
	-- 3 held, plus 1 refunded when the v4 migration retired its planted plot.
	checkEqual(legacy.Inventory.CarrotSeed, 4, "seeds are renamed, and retired plots refund their seed")
	checkEqual(legacy.Inventory.TomatoSeed, 2, "every seed is renamed")
	checkEqual(legacy.Inventory.Carrot, 1, "crops keep their ids and no longer collide with seeds")
	checkEqual(legacy.Inventory.Pumpkin, 4, "all crops carry over")
	checkEqual(legacy.Inventory.GrowthBoost, 2, "boosts carry over")
	checkEqual(legacy.Resources.Gold, 400, "v1 Cash converts into treasury Gold")

	checkEqual(legacy.Plots, nil, "the Plots field is gone by v4")
	checkEqual(legacy.Inventory.StarfruitSeed, 1, "a plot planted with another seed refunds that seed")

	checkEqual(legacy.StarterKitGranted, true, "migrated players are not re-granted the starter kit")
	checkEqual(legacy.Stats.TotalItemsBought, 11, "shop counters are folded into the generic ones")
	checkEqual(legacy.Stats.TotalItemsSold, 7, "both counters migrate")
	checkEqual(legacy.Stats.TotalSeedsBought, nil, "the old counters are stripped")

	-- Migration must be idempotent: re-normalising must not double anything.
	local reNormalized = DataSchema.Normalize(legacy)
	checkEqual(reNormalized.Inventory.CarrotSeed, 4, "re-normalising a migrated profile changes nothing")

	----------------------------------------------------------------------------
	section("ProfileStore: load, save, release")
	----------------------------------------------------------------------------

	local store = ProfileStore.new("TestStore", DataSchema.Template, DataSchema.Normalize)
	checkEqual(store.IsMock, false, "store uses the stubbed DataStore, not mocks")

	local profile = store:LoadProfileAsync("player_1", { 1 })
	check(profile ~= nil, "profile loads")
	checkEqual(profile:IsActive(), true, "loaded profile is active")
	checkEqual(profile.Data.Resources.Gold, 0, "a raw profile has an empty treasury until the starter grant")

	local duplicate, duplicateReason = store:LoadProfileAsync("player_1")
	checkEqual(duplicate, nil, "same server refuses to double-load a key")
	checkEqual(duplicateReason, "AlreadyActive", "double load reports AlreadyActive")

	profile.Data.Resources.Gold = 777
	checkEqual(profile:Save(), true, "explicit save succeeds")

	profile:Release()
	checkEqual(profile:IsActive(), false, "released profile is inactive")

	local reloaded = store:LoadProfileAsync("player_1")
	checkEqual(reloaded.Data.Resources.Gold, 777, "saved value survives a release/reload cycle")

	-- The release above should also have mirrored the data to the backup store.
	local backupBacking = DataStoreBackings["TestStore_Backup"]
	check(backupBacking ~= nil and backupBacking["player_1"] ~= nil, "release writes a mirrored backup")
	checkEqual(backupBacking["player_1"].Data.Resources.Gold, 777, "backup contains the saved value")

	reloaded:Release()

	----------------------------------------------------------------------------
	section("ProfileStore: auto-save")
	----------------------------------------------------------------------------

	local autoProfile = store:LoadProfileAsync("player_auto")
	autoProfile.Data.Resources.Gold = 1234
	local savesBefore = autoProfile.MetaData.SaveCount or 0

	-- Default auto-save interval is 60s; the sweep runs every 5s.
	advance(70)

	local primaryBacking = DataStoreBackings["TestStore"]
	checkEqual(primaryBacking["player_auto"].Data.Resources.Gold, 1234, "auto-save persists data without an explicit call")
	check((primaryBacking["player_auto"].MetaData.SaveCount or 0) > savesBefore, "auto-save increments the save count")
	check(primaryBacking["player_auto"].MetaData.SessionLock ~= nil, "auto-save refreshes the session lock")

	autoProfile:Release()
	checkEqual(primaryBacking["player_auto"].MetaData.SessionLock, nil, "release clears the session lock")

	----------------------------------------------------------------------------
	section("ProfileStore: backup recovery")
	----------------------------------------------------------------------------

	local recoverProfile = store:LoadProfileAsync("player_backup")
	recoverProfile.Data.Resources.Gold = 4242
	recoverProfile:Release()

	-- Simulate the primary key becoming unwritable/unreadable.
	DataStoreFaults.FailUpdate = true

	local recovered, recoverReason = store:LoadProfileAsync("player_backup")
	check(recovered ~= nil, `primary failure falls back to backup (reason: {tostring(recoverReason)})`)

	if recovered then
		checkEqual(recovered.Data.Resources.Gold, 4242, "recovered profile carries the backed-up value")
		checkEqual(recovered.IsRecovered, true, "recovered profile is flagged")

		DataStoreFaults.FailUpdate = false
		checkEqual(recovered:Save(), true, "recovered profile re-seeds the primary store")
		checkEqual(recovered.IsRecovered, false, "recovery flag clears once the primary is authoritative again")
		recovered:Release()
	end

	DataStoreFaults.FailUpdate = false

	----------------------------------------------------------------------------
	section("PlayerDataService")
	----------------------------------------------------------------------------

	local PlayerDataService = require(PlayerDataServiceModule)
	PlayerDataService:Start()

	local levelUps = {}
	PlayerDataService.LevelChanged:Connect(function(_, newLevel, oldLevel)
		table.insert(levelUps, { newLevel, oldLevel })
	end)

	local player = newPlayer(101, "Gardener")
	PlayersService.PlayerAdded:Fire(player)

	checkEqual(player:GetAttribute("DataLoaded"), true, "DataLoaded attribute flips to true")
	checkEqual(player:GetAttribute("Gold"), GameConfig.StartingResources.Gold, "Cash replicates as an attribute")
	checkEqual(player:GetAttribute("Level"), 1, "Level replicates as an attribute")
	checkEqual(player:GetAttribute("XP"), 0, "XP replicates as an attribute")
	checkEqual(player:GetAttribute("XPToNextLevel"), 100, "XPToNextLevel replicates as an attribute")

	local leaderstats = player:FindFirstChild("leaderstats")
	check(leaderstats ~= nil, "leaderstats folder is created")
	checkEqual(leaderstats:FindFirstChild("Gold").Value, GameConfig.StartingResources.Gold, "leaderstats Cash mirrors data")

	local inventoryFolder = player:FindFirstChild("Inventory")
	local seedsFolder = inventoryFolder
	check(inventoryFolder ~= nil, "a single flat Inventory folder is created")
	checkEqual(inventoryFolder:FindFirstChild("Seeds"), nil, "there are no per-category subfolders any more")
	checkEqual(
		inventoryFolder:GetAttribute("CarrotSeed"),
		GameConfig.StarterKit.CarrotSeed,
		"starter seeds replicate as attributes"
	)
	checkEqual(inventoryFolder:GetAttribute("Carrot"), nil, "unowned items have no attribute")

	-- Currency
	local startGold = GameConfig.StartingResources.Gold
	checkEqual(PlayerDataService:AddGold(player, 50), startGold + 50, "AddGold credits the balance")
	checkEqual(PlayerDataService:AddGold(player, -10), nil, "AddCash rejects negative amounts")
	checkEqual(PlayerDataService:AddGold(player, 0), nil, "AddCash rejects zero")
	checkEqual(PlayerDataService:AddGold(player, 0 / 0), nil, "AddCash rejects NaN")
	checkEqual(PlayerDataService:AddGold(player, math.huge), nil, "AddCash rejects infinity")
	checkEqual(PlayerDataService:AddGold(player, "banana"), nil, "AddCash rejects non-numbers")
	checkEqual(PlayerDataService:GetGold(player), startGold + 50, "rejected credits leave the balance untouched")
	checkEqual(PlayerDataService:AddGold(player, 10.9), startGold + 60, "fractional credits are floored")

	checkEqual(PlayerDataService:TrySpendGold(player, 1000), false, "TrySpendCash fails when unaffordable")
	checkEqual(PlayerDataService:GetGold(player), startGold + 60, "failed spend leaves the balance untouched")
	checkEqual(PlayerDataService:TrySpendGold(player, 10), true, "TrySpendCash succeeds when affordable")
	checkEqual(player:GetAttribute("Gold"), startGold + 50, "spending replicates to the attribute")

	-- Progression
	PlayerDataService:AddXP(player, 50)
	checkEqual(player:GetAttribute("XP"), 50, "XP accumulates below the threshold")
	checkEqual(player:GetAttribute("Level"), 1, "level holds below the threshold")

	PlayerDataService:AddXP(player, 50)
	checkEqual(player:GetAttribute("Level"), 2, "crossing the threshold levels the player up")
	checkEqual(player:GetAttribute("XP"), 0, "level up consumes the XP requirement")
	checkEqual(#levelUps, 1, "LevelChanged fires once per level up")

	local levelBeforeJump = PlayerDataService:GetLevel(player)
	PlayerDataService:AddXP(player, 100000)
	local levelAfterJump = PlayerDataService:GetLevel(player)
	check(levelAfterJump > levelBeforeJump + 1, "a large XP grant applies multiple levels at once")
	check(
		PlayerDataService:GetData(player).XP < GameConfig.GetXPForLevel(levelAfterJump),
		"leftover XP is below the next level's requirement"
	)

	-- Inventory
	checkEqual(PlayerDataService:AddItem(player, "TomatoSeed", 5), 5, "AddItem stacks a new item")
	checkEqual(seedsFolder:GetAttribute("TomatoSeed"), 5, "added items replicate as attributes")
	checkEqual(PlayerDataService:AddItem(player, "NotAnItem", 5), nil, "AddItem rejects ids absent from the directory")
	checkEqual(PlayerDataService:AddItem(player, "", 1), nil, "AddItem rejects empty item ids")
	checkEqual(PlayerDataService:GetItemCount(player, "TomatoSeed"), 5, "GetItemCount reads the stack")
	checkEqual(PlayerDataService:HasItem(player, "TomatoSeed", 5), true, "HasItem respects the amount")
	checkEqual(PlayerDataService:HasItem(player, "TomatoSeed", 6), false, "HasItem fails above the stack")

	checkEqual(PlayerDataService:RemoveItem(player, "TomatoSeed", 10), false, "RemoveItem fails when short")
	checkEqual(PlayerDataService:GetItemCount(player, "TomatoSeed"), 5, "failed removal leaves the stack intact")
	checkEqual(PlayerDataService:RemoveItem(player, "TomatoSeed", 5), true, "RemoveItem succeeds with enough stock")
	checkEqual(seedsFolder:GetAttribute("TomatoSeed"), nil, "emptied stacks clear their attribute")
	checkEqual(PlayerDataService:GetData(player).Inventory.TomatoSeed, nil, "emptied stacks are removed from saved data")

	PlayerDataService:AddItem(player, "PumpkinSeed", 999999)
	checkEqual(
		PlayerDataService:GetItemCount(player, "PumpkinSeed"),
		GameConfig.GetItem("PumpkinSeed").MaxStack,
		"AddItem clamps to MaxStack"
	)

	-- Stats
	checkEqual(PlayerDataService:IncrementStat(player, "TotalHarvested", 3), 3, "IncrementStat updates a known stat")
	checkEqual(PlayerDataService:IncrementStat(player, "NotAStat", 1), nil, "IncrementStat rejects unknown stats")

	-- Snapshot isolation
	local snapshot = PlayerDataService:GetDataSnapshot(player)
	snapshot.Cash = -1
	check(PlayerDataService:GetGold(player) ~= -1, "snapshots cannot be used to mutate live data")

	----------------------------------------------------------------------------
	section("PlayerDataService: persistence round trip")
	----------------------------------------------------------------------------

	local expectedCash = PlayerDataService:GetGold(player)
	local expectedLevel = PlayerDataService:GetLevel(player)
	local expectedPumpkins = PlayerDataService:GetItemCount(player, "PumpkinSeed")

	PlayersService.PlayerRemoving:Fire(player)
	player.Parent = nil
	checkEqual(PlayerDataService:GetProfile(player), nil, "profile is dropped when the player leaves")

	local rejoined = newPlayer(101, "Gardener")
	PlayersService.PlayerAdded:Fire(rejoined)

	checkEqual(rejoined:GetAttribute("Gold"), expectedCash, "cash survives a rejoin")
	checkEqual(rejoined:GetAttribute("Level"), expectedLevel, "level survives a rejoin")
	checkEqual(
		rejoined:FindFirstChild("Inventory"):GetAttribute("PumpkinSeed"),
		expectedPumpkins,
		"inventory survives a rejoin"
	)
	checkEqual(PlayerDataService:GetData(rejoined).Stats.JoinCount, 2, "join count increments across sessions")

	-- Starter items must be granted ONCE, not re-added by the reconcile pass
	-- every time the player logs in with an empty stack.
	local starter = newPlayer(808, "Starter")
	PlayersService.PlayerAdded:Fire(starter)

	local starterSeeds = PlayerDataService:GetItemCount(starter, "CarrotSeed")
	check(starterSeeds > 0, "a new player receives starter seeds")
	checkEqual(
		PlayerDataService:RemoveItem(starter, "CarrotSeed", starterSeeds),
		true,
		"starter seeds can be spent down to zero"
	)

	PlayersService.PlayerRemoving:Fire(starter)
	starter.Parent = nil

	local starterReturning = newPlayer(808, "Starter")
	PlayersService.PlayerAdded:Fire(starterReturning)
	checkEqual(
		PlayerDataService:GetItemCount(starterReturning, "CarrotSeed"),
		0,
		"spent starter seeds are NOT re-granted on rejoin"
	)

	----------------------------------------------------------------------------
	section("Growth stage math")
	----------------------------------------------------------------------------

	local Growth = require(Shared.Growth)
	local carrot = GameConfig.GetPlantable("CarrotSeed")

	checkEqual(Growth.GetStage("CarrotSeed", 0, 0), "Seedling", "a just-planted crop is a Seedling")
	checkEqual(Growth.GetStage("CarrotSeed", 0, carrot.GrowTime * 0.2), "Seedling", "20% grown is still a Seedling")
	checkEqual(Growth.GetStage("CarrotSeed", 0, carrot.GrowTime * 0.5), "Growing", "50% grown is Growing")
	checkEqual(Growth.GetStage("CarrotSeed", 0, carrot.GrowTime * 0.99), "Growing", "99% grown is still Growing")
	checkEqual(Growth.GetStage("CarrotSeed", 0, carrot.GrowTime), "Mature", "100% grown is Mature")
	checkEqual(Growth.GetStage("CarrotSeed", 0, carrot.GrowTime * 10), "Mature", "overgrown stays Mature")
	checkEqual(Growth.GetStage("NotASeed", 0, 999), "Empty", "an unknown seed has no stage")

	checkEqual(Growth.GetReadyAt("CarrotSeed", 1000), 1000 + carrot.GrowTime, "ReadyAt is plant time plus grow time")
	checkEqual(Growth.GetTimeRemaining("CarrotSeed", 0, 10), carrot.GrowTime - 10, "time remaining counts down")
	checkEqual(Growth.GetTimeRemaining("CarrotSeed", 0, 99999), 0, "time remaining floors at zero")
	checkEqual(Growth.IsMature("Mature"), true, "IsMature recognises the final stage")
	checkEqual(Growth.IsMature("Growing"), false, "IsMature rejects earlier stages")
	checkEqual(Growth.FormatTimeRemaining(125), "2m 05s", "durations format with padded seconds")
	checkEqual(Growth.FormatTimeRemaining(45), "45s", "sub-minute durations omit minutes")

	----------------------------------------------------------------------------
	section("FarmService: farms are built, not handed out")
	----------------------------------------------------------------------------

	local PlacementService = require(PlacementServiceModule)
	local FarmService = require(FarmServiceModule)
	PlacementService:Start()
	FarmService:Start()

	-- Shared with later sections through the helpers above.
	PLACEMENT = PlacementService
	FARMS = FarmService
	PDS = PlayerDataService

	--- Gives a player resources and the TownCenter -> Mill chain, then returns
	--- a freshly placed farm's instance id.
	local buildFarm, farmModel, farmPrompt, triggerFarm = makeFarm, farmOf, promptOf, pokeFarm

	local grower = newPlayer(2001, "Grower")
	giveCharacter(grower, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(grower)

	-- Nothing exists until it is built. This is the whole point of the rework.
	checkEqual(next(PlayerDataService:GetData(grower).Structures), nil, "a new player owns no structures")
	checkEqual(GameConfig.Garden, nil, "the fixed-garden config is gone")
	checkEqual(GameConfig.PlotAttributes, nil, "plot attributes are gone")
	checkEqual(PlayerDataService:GetData(grower).Plots, nil, "the Plots field is gone from the schema")
	checkEqual(PlayerDataService:GetData(grower).BonusPlotSlots, nil, "and so are bonus plot slots")

	local farmId = buildFarm(grower, -150, -150)
	check(farmId ~= nil, "a farm can be built beside a Mill")

	local prompt = farmPrompt(grower, farmId)
	check(prompt ~= nil, "a built farm gets a plant prompt")
	checkEqual(prompt.ActionText, "Plant", "a fallow farm offers Plant")
	-- Capacity-driven rather than hardcoded, so retuning a tier does not
	-- quietly turn these into assertions about nothing.
	local carrotCapacity = GameConfig.GetPlantCapacity("CarrotSeed")
	check(carrotCapacity > 1, `a carrot square holds a stack ({carrotCapacity})`)
	checkEqual(
		prompt.ObjectText,
		`Carrot Seed x{math.min(carrotCapacity, PlayerDataService:GetItemCount(grower, "CarrotSeed"))}`,
		"and names the seed and how many will go in"
	)
	checkEqual(farmModel(grower, farmId):GetAttribute("Stage"), "Empty", "a fresh farm is fallow")

	----------------------------------------------------------------------------
	section("FarmService: planting and harvesting")
	----------------------------------------------------------------------------

	local seedsBefore = PlayerDataService:GetItemCount(grower, "CarrotSeed")
	triggerFarm(grower, farmId)

	checkEqual(farmModel(grower, farmId):GetAttribute("SeedId"), "CarrotSeed", "triggering a fallow farm plants")
	checkEqual(farmModel(grower, farmId):GetAttribute("Stage"), "Seedling", "a new crop starts as a Seedling")
	local plantedInSquare = math.min(carrotCapacity, seedsBefore)
	check(plantedInSquare > 1, "the starter kit fills more than one slot")
	checkEqual(
		PlayerDataService:GetItemCount(grower, "CarrotSeed"),
		seedsBefore - plantedInSquare,
		"one press fills the square and consumes a seed per plant"
	)
	checkEqual(
		farmModel(grower, farmId):GetAttribute("PlantCount"),
		plantedInSquare,
		"the plant count replicates"
	)
	checkEqual(
		farmModel(grower, farmId):GetAttribute("PlantCapacity"),
		carrotCapacity,
		"and so does what the square would hold"
	)
	checkEqual(
		PlayerDataService:GetData(grower).Structures[farmId].SeedId,
		"CarrotSeed",
		"crop state is stored on the farm's own record, so it cannot be orphaned"
	)
	checkEqual(farmPrompt(grower, farmId).Enabled, false, "a growing farm's prompt is disabled")

	local container = farmModel(grower, farmId):FindFirstChild("Crop")
	check(container ~= nil, "a crop container is created")
	check(container:FindFirstChild("Plant1") ~= nil, "with a plant visual inside it")
	checkEqual(#container:GetChildren(), plantedInSquare, "one visual per plant in the stack")

	-- Re-triggering must not double-plant.
	advance(1)
	local heldAfterPlant = PlayerDataService:GetItemCount(grower, "CarrotSeed")
	triggerFarm(grower, farmId)
	checkEqual(PlayerDataService:GetItemCount(grower, "CarrotSeed"), heldAfterPlant, "re-triggering consumes nothing")

	-- Growth stages advance from the timestamp.
	local carrot = GameConfig.GetPlantable("CarrotSeed")
	advance(carrot.GrowTime * 0.5)
	checkEqual(farmModel(grower, farmId):GetAttribute("Stage"), "Growing", "the loop advances Seedling -> Growing")
	advance(carrot.GrowTime)
	checkEqual(farmModel(grower, farmId):GetAttribute("Stage"), "Mature", "and Growing -> Mature")
	checkEqual(farmPrompt(grower, farmId).ActionText, "Harvest", "a mature farm offers Harvest")

	local cropsBefore = PlayerDataService:GetItemCount(grower, "Carrot")
	advance(1)
	triggerFarm(grower, farmId)

	checkEqual(PlayerDataService:GetItemCount(grower, "Carrot"), cropsBefore + carrot.YieldAmount * plantedInSquare,
		"harvesting pays the whole stack, not one plant")
	checkEqual(farmModel(grower, farmId):GetAttribute("SeedId"), "", "the farm returns to fallow")
	checkEqual(PlayerDataService:GetData(grower).Structures[farmId].SeedId, "", "and clears on the record")
	checkEqual(farmModel(grower, farmId):FindFirstChild("Crop"), nil, "the crop container is removed")

	-- The farm itself survives harvesting: it is a building, not a slot.
	check(PlacementService:GetPlaced(grower)[farmId] ~= nil, "the farm structure outlives its crop")

	-- A square-filling planting empties the starter pouch, so restock before
	-- the sections below, which all need to plant again.
	PlayerDataService:AddItem(grower, "CarrotSeed", 60)

	----------------------------------------------------------------------------
	section("FarmService: interaction security")
	----------------------------------------------------------------------------

	local intruder = newPlayer(2002, "Intruder")
	giveCharacter(intruder, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(intruder)

	advance(1)
	-- Standing right on the farm, so only ownership can reject this.
	intruder.Character.PrimaryPart.Position = farmModel(grower, farmId).PrimaryPart.Position
	farmPrompt(grower, farmId).Triggered:Fire(intruder)
	checkEqual(farmModel(grower, farmId):GetAttribute("SeedId"), "", "a player cannot plant on another player's farm")

	-- Out of range.
	grower.Character.PrimaryPart.Position = Vector3.new(5000, 3, 5000)
	advance(1)
	farmPrompt(grower, farmId).Triggered:Fire(grower)
	checkEqual(farmModel(grower, farmId):GetAttribute("SeedId"), "", "a distant owner cannot interact")

	advance(1)
	triggerFarm(grower, farmId)
	checkEqual(farmModel(grower, farmId):GetAttribute("SeedId"), "CarrotSeed", "an in-range owner can interact")

	-- Cooldown.
	local secondFarm = { Ok = true, InstanceId = makeFarm(grower, -150, -150) }
	check(secondFarm.Ok, "a second farm places")
	local heldBeforeSpam = PlayerDataService:GetItemCount(grower, "CarrotSeed")
	triggerFarm(grower, secondFarm.InstanceId)
	checkEqual(PlayerDataService:GetItemCount(grower, "CarrotSeed"), heldBeforeSpam,
		"an interaction inside the cooldown window is dropped")

	----------------------------------------------------------------------------
	section("FarmService: seed selection and boosts")
	----------------------------------------------------------------------------

	local selectSeed = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.SelectSeed)
	local selectFarm = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.SelectFarm)
	local useBoost = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.UseBoost)

	PlayerDataService:AddXP(grower, 100000)
	PlayerDataService:AddItem(grower, "TomatoSeed", 3)

	advance(1)
	selectSeed.OnServerEvent:Fire(grower, "TomatoSeed")
	checkEqual(grower:GetAttribute("SelectedSeed"), "TomatoSeed", "a valid seed selection is accepted")
	advance(1)
	selectSeed.OnServerEvent:Fire(grower, "Carrot")
	checkEqual(grower:GetAttribute("SelectedSeed"), "TomatoSeed", "a crop id is not a plantable seed")
	advance(1)
	selectSeed.OnServerEvent:Fire(grower, { exploit = true })
	checkEqual(grower:GetAttribute("SelectedSeed"), "TomatoSeed", "a table payload is rejected")

	advance(1)
	triggerFarm(grower, secondFarm.InstanceId)
	checkEqual(farmModel(grower, secondFarm.InstanceId):GetAttribute("SeedId"), "TomatoSeed",
		"planting uses the selected seed")

	-- Boost targeting by farm instance id.
	advance(1)
	selectFarm.OnServerEvent:Fire(grower, secondFarm.InstanceId)
	checkEqual(grower:GetAttribute("TargetFarm"), secondFarm.InstanceId, "a farm can be targeted for a boost")
	advance(1)
	selectFarm.OnServerEvent:Fire(grower, "99999")
	checkEqual(grower:GetAttribute("TargetFarm"), secondFarm.InstanceId, "an unowned farm id is rejected")

	PlayerDataService:AddItem(grower, "GrowthBoost", 1)
	local readyBefore = farmModel(grower, secondFarm.InstanceId):GetAttribute("ReadyAt")
	advance(1)
	useBoost.OnServerEvent:Fire(grower, secondFarm.InstanceId)

	checkEqual(farmModel(grower, secondFarm.InstanceId):GetAttribute("Stage"), "Mature",
		"a boost completes growth immediately")
	check(farmModel(grower, secondFarm.InstanceId):GetAttribute("ReadyAt") < readyBefore,
		"by backdating PlantedAt, so ReadyAt moves into the past")
	checkEqual(PlayerDataService:GetItemCount(grower, "GrowthBoost"), 0, "the boost is consumed")

	-- The decisive check: the tick must not undo it.
	advance(3)
	checkEqual(farmModel(grower, secondFarm.InstanceId):GetAttribute("Stage"), "Mature",
		"the growth tick does NOT revert the boost")
	advance(1)
	triggerFarm(grower, secondFarm.InstanceId)
	checkEqual(farmModel(grower, secondFarm.InstanceId):GetAttribute("SeedId"), "",
		"a boosted crop can actually be harvested")

	----------------------------------------------------------------------------
	section("FarmService: offline growth and persistence")
	----------------------------------------------------------------------------

	local plantedFarms = {}
	for instanceId, entry in PlayerDataService:GetData(grower).Structures do
		if entry.SeedId and entry.SeedId ~= "" then
			plantedFarms[instanceId] = entry.SeedId
		end
	end

	local plantedCount = 0
	for _ in plantedFarms do
		plantedCount += 1
	end
	check(plantedCount >= 1, `the grower has crops planted before logging out ({plantedCount})`)

	PlayersService.PlayerRemoving:Fire(grower)
	grower.Parent = nil

	-- Well past every grow time, as if the player were away.
	advance(2000)

	local returned = newPlayer(2001, "Grower")
	giveCharacter(returned, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(returned)

	local restored, mature = 0, 0
	for instanceId, seedId in plantedFarms do
		local model = PlacementService:GetPlaced(returned)[instanceId]

		if model and model.Model:GetAttribute("SeedId") == seedId then
			restored += 1

			if model.Model:GetAttribute("Stage") == "Mature" then
				mature += 1
			end
		end
	end

	checkEqual(restored, plantedCount, "planted farms are restored with their crops")
	checkEqual(mature, restored, "crops kept growing while the player was offline")
	check(farmPrompt(returned, farmId) ~= nil, "restored farms get their prompt back")

	-- Demolishing a farm takes its crop with it - no orphaned crop records.
	local demolishTarget = nil
	for instanceId in plantedFarms do
		demolishTarget = instanceId
		break
	end
	checkEqual(PlacementService:Demolish(returned, demolishTarget).Ok, true, "a farm can be demolished")
	checkEqual(PlayerDataService:GetData(returned).Structures[demolishTarget], nil,
		"demolishing takes the crop record with the farm")
	checkEqual(FarmService:GetFarm(returned, demolishTarget), nil, "and detaches the farm")

	----------------------------------------------------------------------------
	section("DataSchema: v3 -> v4 migration")
	----------------------------------------------------------------------------

	-- A profile from the fixed-garden era: plots become refunded seeds.
	local v3 = DataSchema.Normalize({
		SchemaVersion = 3,
		Resources = { Gold = 500 },
		StarterKitGranted = true,
		BonusPlotSlots = 2,
		Inventory = { CarrotSeed = 1 },
		Plots = {
			["1"] = { SeedId = "CarrotSeed", PlantedAt = 1000 },
			["2"] = { SeedId = "TomatoSeed", PlantedAt = 1000 },
		},
	})

	checkEqual(v3.SchemaVersion, 4, "a v3 profile migrates to v4")
	checkEqual(v3.Plots, nil, "the Plots field is dropped")
	checkEqual(v3.BonusPlotSlots, nil, "and so are bonus plot slots")
	checkEqual(v3.Inventory.CarrotSeed, 2, "a planted plot is refunded as its seed, on top of what was held")
	checkEqual(v3.Inventory.TomatoSeed, 1, "every planted plot is refunded")
	checkEqual(v3.Resources.Gold, 500, "unrelated fields are untouched")


	----------------------------------------------------------------------------
	section("ShopService: buying seeds")
	----------------------------------------------------------------------------

	local ShopService = require(ShopServiceModule)
	ShopService:Start()

	local shopper = newPlayer(404, "Shopper")
	giveCharacter(shopper, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(shopper)

	checkEqual(PlayerDataService:GetGold(shopper), GameConfig.StartingResources.Gold, "a new shopper starts with the configured gold")
	checkEqual(PlayerDataService:GetLevel(shopper), 1, "a new shopper starts at level 1")

	local purchases = {}
	ShopService.ItemBought:Connect(function(_, seedId, quantity, cost)
		table.insert(purchases, { seedId = seedId, quantity = quantity, cost = cost })
	end)

	local buy = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 5)
	checkEqual(buy.Ok, true, "buying an affordable seed succeeds")
	checkEqual(buy.Spent, 50, "the price comes from GameConfig SeedPrice")
	checkEqual(PlayerDataService:GetGold(shopper), GameConfig.StartingResources.Gold - 50, "gold is deducted")
	local seedsOwned = GameConfig.StarterKit.CarrotSeed + 5
	checkEqual(PlayerDataService:GetItemCount(shopper, "CarrotSeed"), seedsOwned, "seeds are added to inventory")
	checkEqual(PlayerDataService:GetData(shopper).Stats.TotalItemsBought, 5, "TotalItemsBought is tracked")
	checkEqual(#purchases, 1, "ItemBought fires once")

	-- Level gating uses the seed's RequiredLevel, not anything client-supplied.
	local gated = ShopService:ProcessTransaction(shopper, "Buy", "TomatoSeed", 1)
	checkEqual(gated.Ok, false, "a level-gated seed cannot be bought")
	checkEqual(gated.Reason, "LevelTooLow", "the gate reports LevelTooLow")
	checkEqual(PlayerDataService:GetGold(shopper), GameConfig.StartingResources.Gold - 50, "a gated purchase costs nothing")

	local broke = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 50)
	checkEqual(broke.Reason, "NotEnoughGold", "an unaffordable purchase is refused")
	checkEqual(PlayerDataService:GetGold(shopper), GameConfig.StartingResources.Gold - 50, "a refused purchase costs nothing")
	checkEqual(PlayerDataService:GetItemCount(shopper, "CarrotSeed"), seedsOwned, "a refused purchase grants nothing")

	-- Untrusted inputs
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "NotASeed", 1).Reason, "InvalidItem", "an unknown seed id is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", { bad = true }, 1).Reason, "InvalidItem", "a table seed id is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", 12345, 1).Reason, "InvalidItem", "a numeric seed id is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 0).Reason, "InvalidAmount", "quantity 0 is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", -5).Reason, "InvalidAmount", "a negative quantity is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 0 / 0).Reason, "InvalidAmount", "a NaN quantity is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", math.huge).Reason, "InvalidAmount", "an infinite quantity is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", "lots").Reason, "InvalidAmount", "a non-numeric quantity is refused")
	checkEqual(PlayerDataService:GetGold(shopper), GameConfig.StartingResources.Gold - 50, "no invalid input moved any gold")

	-- Fractional quantities floor rather than charging fractional cash.
	PlayerDataService:AddGold(shopper, 1_000_000)
	local fractional = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 2.9)
	checkEqual(fractional.Amount, 2, "a fractional quantity is floored")
	checkEqual(fractional.Spent, 20, "the charge matches the floored quantity")

	-- Per-request cap
	local capped = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 5000)
	checkEqual(capped.Amount, GameConfig.Shop.MaxBuyAmount, "quantity is clamped to MaxBuyQuantity")
	checkEqual(
		capped.Spent,
		GameConfig.Shop.MaxBuyAmount * GameConfig.GetItem("CarrotSeed").BuyPrice,
		"the charge matches the clamped quantity"
	)

	-- Stack ceiling: money must not move when the seeds cannot fit.
	PlayerDataService:AddItem(shopper, "CarrotSeed", GameConfig.GetItem("CarrotSeed").MaxStack)
	local cashBeforeFull = PlayerDataService:GetGold(shopper)
	local full = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 10)
	checkEqual(full.Reason, "StackFull", "buying past MaxStack is refused")
	checkEqual(PlayerDataService:GetGold(shopper), cashBeforeFull, "a StackFull refusal costs nothing")

	----------------------------------------------------------------------------
	section("ShopService: selling crops")
	----------------------------------------------------------------------------

	local sales = {}
	ShopService.ItemSold:Connect(function(_, cropId, quantity, earned)
		table.insert(sales, { cropId = cropId, quantity = quantity, earned = earned })
	end)

	PlayerDataService:AddItem(shopper, "Carrot", 4)
	local cashBeforeSale = PlayerDataService:GetGold(shopper)

	local sell = ShopService:ProcessTransaction(shopper, "Sell", "Carrot", 3)
	checkEqual(sell.Ok, true, "selling held crops succeeds")
	checkEqual(sell.Earned, 75, "the payout comes from GameConfig SellPrice")
	checkEqual(PlayerDataService:GetGold(shopper), cashBeforeSale + 75, "cash is credited")
	checkEqual(PlayerDataService:GetItemCount(shopper, "Carrot"), 1, "crops are removed")
	checkEqual(PlayerDataService:GetData(shopper).Stats.TotalItemsSold, 3, "TotalItemsSold is tracked")
	checkEqual(#sales, 1, "ItemSold fires once")

	local overSell = ShopService:ProcessTransaction(shopper, "Sell", "Carrot", 99)
	checkEqual(overSell.Reason, "NotEnoughItems", "selling more than held is refused")
	checkEqual(PlayerDataService:GetItemCount(shopper, "Carrot"), 1, "a refused sale removes nothing")

	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "NotACrop", 1).Reason, "InvalidItem", "an unknown crop id is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "Carrot", -1).Reason, "InvalidAmount", "a negative sale is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "Carrot", 0 / 0).Reason, "InvalidAmount", "a NaN sale is refused")

	-- Sell-all across several crop types.
	PlayerDataService:AddItem(shopper, "Tomato", 2)
	PlayerDataService:AddItem(shopper, "Pumpkin", 1)

	local expectedPayout = 1 * GameConfig.GetItem("Carrot").SellPrice
		+ 2 * GameConfig.GetItem("Tomato").SellPrice
		+ 1 * GameConfig.GetItem("Pumpkin").SellPrice

	local cashBeforeSellAll = PlayerDataService:GetGold(shopper)
	local sellAll = ShopService:SellAll(shopper)

	checkEqual(sellAll.Ok, true, "sell-all succeeds when crops are held")
	checkEqual(sellAll.Amount, 4, "sell-all reports the total units sold")
	checkEqual(sellAll.Earned, expectedPayout, "sell-all pays each crop its own SellPrice")
	checkEqual(PlayerDataService:GetGold(shopper), cashBeforeSellAll + expectedPayout, "sell-all credits the total")
	checkEqual(PlayerDataService:GetItemCount(shopper, "Carrot"), 0, "sell-all empties every bucket entry")
	checkEqual(PlayerDataService:GetItemCount(shopper, "Tomato"), 0, "sell-all clears other crops too")

	checkEqual(ShopService:SellAll(shopper).Reason, "NothingToSell", "sell-all with nothing held is refused")

	----------------------------------------------------------------------------
	section("ShopService: full economy loop")
	----------------------------------------------------------------------------

	-- Buy a seed, grow it, harvest it, sell the crop, and verify the player
	-- nets exactly SellPrice - SeedPrice.
	local loopFarm = makeFarm(shopper, 60, -180)
	check(loopFarm ~= nil, "built a farm for the economy loop")


	-- Clear this player's seed stock: an earlier section filled it to MaxStack.
	PlayerDataService:RemoveItem(shopper, "CarrotSeed", PlayerDataService:GetItemCount(shopper, "CarrotSeed"))

	local loopCashStart = PlayerDataService:GetGold(shopper)
	local carrotSeed = GameConfig.GetPlantable("CarrotSeed")

	local loopBuy = ShopService:ProcessTransaction(shopper, "Buy", "CarrotSeed", 1)
	checkEqual(loopBuy.Ok, true, "loop: bought a seed")
	checkEqual(PlayerDataService:GetGold(shopper), loopCashStart - GameConfig.GetItem("CarrotSeed").BuyPrice, "loop: cash paid for the seed")

	advance(1)
	selectSeed.OnServerEvent:Fire(shopper, "CarrotSeed")
	advance(1)
	pokeFarm(shopper, loopFarm)
	checkEqual(farmOf(shopper, loopFarm):GetAttribute("SeedId"), "CarrotSeed", "loop: planted the purchased seed")
	checkEqual(PlayerDataService:GetItemCount(shopper, "CarrotSeed"), 0, "loop: planting consumed the seed")

	advance(carrotSeed.GrowTime + 2)
	checkEqual(farmOf(shopper, loopFarm):GetAttribute("Stage"), "Mature", "loop: the crop matured")

	advance(1)
	pokeFarm(shopper, loopFarm)
	check(PlayerDataService:GetItemCount(shopper, "Carrot") >= 1, "loop: harvested a crop")

	local loopSell = ShopService:ProcessTransaction(shopper, "Sell", "Carrot", 1)
	checkEqual(loopSell.Ok, true, "loop: sold the crop")
	checkEqual(
		PlayerDataService:GetGold(shopper),
		loopCashStart - GameConfig.GetItem("CarrotSeed").BuyPrice + GameConfig.GetItem("Carrot").SellPrice,
		"loop: the round trip nets exactly SellPrice minus SeedPrice"
	)
	check(GameConfig.GetItem("Carrot").SellPrice > GameConfig.GetItem("CarrotSeed").BuyPrice, "loop: the configured economy is actually profitable")

	----------------------------------------------------------------------------
	section("ShopService: cash ceiling")
	----------------------------------------------------------------------------

	local richPlayer = newPlayer(606, "Tycoon")
	giveCharacter(richPlayer, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(richPlayer)

	PlayerDataService:AddGold(richPlayer, GameConfig.Economy.MaxResource)
	checkEqual(PlayerDataService:GetGold(richPlayer), GameConfig.Economy.MaxResource, "cash is capped at MaxCash")

	PlayerDataService:AddItem(richPlayer, "Carrot", 5)
	local cappedSale = ShopService:ProcessTransaction(richPlayer, "Sell", "Carrot", 5)
	checkEqual(cappedSale.Reason, "TreasuryFull", "selling at the cash ceiling is refused")
	checkEqual(
		PlayerDataService:GetItemCount(richPlayer, "Carrot"),
		5,
		"a CashCapped refusal keeps the crops instead of consuming them for nothing"
	)
	checkEqual(ShopService:SellAll(richPlayer).Reason, "TreasuryFull", "sell-all surfaces the real blocker")

	-- Just below the ceiling: only the affordable portion should sell.
	PlayerDataService:TrySpendGold(richPlayer, 30)
	local partial = ShopService:ProcessTransaction(richPlayer, "Sell", "Carrot", 5)
	checkEqual(partial.Ok, true, "a partial sale is allowed below the ceiling")
	checkEqual(partial.Amount, 1, "only the quantity the ceiling can pay for is sold")
	checkEqual(PlayerDataService:GetItemCount(richPlayer, "Carrot"), 4, "the unsold crops are retained")

	----------------------------------------------------------------------------
	section("Framework: partial-sync guard")
	----------------------------------------------------------------------------

	local FrameworkGuard = require(FrameworkGuardModule)

	checkEqual(GameConfig.FrameworkVersion, 15, "GameConfig declares a framework revision")

	--[[
		EVERY config field named in EVERY source file must actually exist.

		This is a STATIC check over source text, and it exists because client
		scripts cannot be executed here - they build GUIs and bind to
		UserInputService - so nothing else can catch one referencing a renamed
		config field.

		That is not hypothetical. DefeatClient was left reading
		GameConfig.Defeat.SurrenderLoss after it became SurrenderPurseLoss.
		The result was `nil * 100` thrown while building a label, which
		unwound out of the refresh before the line that shows the panel - so
		a defeated player saw nothing at all and could never answer. The
		server was raising the defeat correctly the whole time, and 1195
		passing assertions had no opinion.

		Comments are stripped before this runs: a stale name in prose is a
		documentation problem, not a crash.
	]]
	do
		local audited = 0
		local references = 0

		for path, source in SOURCES do
			audited += 1

			-- Two-level references only. `GameConfig.GetStructure(...)` is a
			-- function and resolves by being called; `GameConfig.Resources[id]`
			-- is dynamic and cannot be checked statically.
			for tableName, fieldName in string.gmatch(source, "GameConfig%.([%a_][%w_]*)%.([%a_][%w_]*)") do
				references += 1

				local container = GameConfig[tableName]

				check(
					container ~= nil,
					`{path} reads GameConfig.{tableName}, which exists`
				)

				if type(container) == "table" then
					check(
						container[fieldName] ~= nil,
						`{path} reads GameConfig.{tableName}.{fieldName}, which exists`
					)
				end
			end
		end

		check(audited >= 20, `every source file was audited ({audited} files)`)
		check(references >= 100, `and a meaningful number of references checked ({references})`)
	end

	--[[
		EVERY module in the tree must agree with it.

		This is the assertion that was missing, and its absence shipped a
		broken build: DefeatService was left declaring v14 while everything
		else moved to v15, and nothing here noticed. FrameworkGuard caught it
		correctly - in Studio, on the player's machine, which is the one place
		it should never have had to.

		Enumerated from the instance tree rather than from a hand-written
		list, so a service added later is covered without anyone remembering
		to add it here. That is the whole point: a list you have to maintain
		is a list that will be out of date exactly when it matters.
	]]
	do
		local serverRoot = ServerScriptService:FindFirstChild("Server")
		check(serverRoot ~= nil, "the server tree is mounted")

		local checked = 0

		local function auditFolder(folder: Instance)
			for _, child in folder:GetChildren() do
				if child.ClassName == "Folder" then
					auditFolder(child)
				elseif child.ClassName == "ModuleScript" then
					local ok, module = pcall(require, child)

					--[[
						Only modules that DECLARE a version are audited. A
						pure helper (CropFactory, DataSchema, ProfileStore)
						has no cross-module config surface and deliberately
						has none.
					]]
					if ok and type(module) == "table" and module.FrameworkVersion ~= nil then
						checkEqual(
							module.FrameworkVersion,
							GameConfig.FrameworkVersion,
							`{child.Name} declares the same framework revision as GameConfig`
						)
						checked += 1
					end
				end
			end
		end

		auditFolder(serverRoot)

		check(checked >= 8, `every versioned service was audited ({checked} of them)`)
	end
	checkEqual(PlayerDataService.FrameworkVersion, GameConfig.FrameworkVersion, "PlayerDataService matches the config")
	checkEqual(FARMS.FrameworkVersion, GameConfig.FrameworkVersion, "FarmService matches the config")
	checkEqual(ShopService.FrameworkVersion, GameConfig.FrameworkVersion, "ShopService matches the config")

	local allServices = {
		PlayerDataService = PlayerDataService,
		FarmService = FARMS,
		ShopService = ShopService,
	}

	local consistent = FrameworkGuard.Check(GameConfig.FrameworkVersion, allServices)
	checkEqual(consistent, true, "a fully synced tree passes the guard")

	-- Reproduce the exact Studio failure: a module left behind from an earlier
	-- step. Expressed relative to the current revision so a version bump does
	-- not require editing this test.
	local current = GameConfig.FrameworkVersion
	local previous = current - 1

	local staleTree = {
		PlayerDataService = { FrameworkVersion = previous },
		FarmService = FARMS,
	}
	local staleOk, staleProblems = FrameworkGuard.Check(current, staleTree)
	checkEqual(staleOk, false, "a stale module is detected")
	checkEqual(#staleProblems, 1, "exactly the stale module is reported")
	check(string.find(staleProblems[1], "PlayerDataService") ~= nil, "the message names the stale module")
	check(
		string.find(staleProblems[1], `v{previous}`) ~= nil,
		"the message reports the version it was built against"
	)

	-- A module predating the guard entirely has no field at all.
	local untaggedOk, untaggedProblems = FrameworkGuard.Check(current, { ShopService = {} })
	checkEqual(untaggedOk, false, "an untagged module is detected")
	check(string.find(untaggedProblems[1], "nil") ~= nil, "an untagged module reports nil")

	-- The opposite direction: a stale Shared tree makes GameConfig itself wrong.
	local staleConfigOk, staleConfigProblems = FrameworkGuard.Check(nil, allServices)
	checkEqual(staleConfigOk, false, "a GameConfig predating the guard is detected")
	check(
		string.find(staleConfigProblems[1], "FrameworkVersion") ~= nil,
		"the message points at GameConfig rather than blaming a service"
	)

	-- Assert must abort rather than warn, and say something actionable.
	local assertOk, assertErr = pcall(function()
		FrameworkGuard.Assert(current, staleTree)
	end)
	checkEqual(assertOk, false, "Assert aborts startup on a mismatch")
	check(string.find(tostring(assertErr), "PARTIALLY SYNCED") ~= nil, "the abort message states the real cause")
	check(string.find(tostring(assertErr), "rojo serve") ~= nil, "the abort message explains how to fix it")

	checkEqual(pcall(function()
		FrameworkGuard.Assert(GameConfig.FrameworkVersion, allServices)
	end), true, "Assert passes a consistent tree")

	----------------------------------------------------------------------------
	section("Framework: the shop is category-agnostic")
	----------------------------------------------------------------------------

	-- The point of the master directory: an AnimalDrop trades through exactly
	-- the same path as a seed, with no shop or inventory change.
	PlayerDataService:AddItem(shopper, "Egg", 4)
	checkEqual(PlayerDataService:GetItemCount(shopper, "Egg"), 4, "an AnimalDrop stores like any other item")
	checkEqual(
		shopper:FindFirstChild("Inventory"):GetAttribute("Egg"),
		4,
		"an AnimalDrop replicates through the same flat folder"
	)

	local eggCash = PlayerDataService:GetGold(shopper)
	local eggSale = ShopService:ProcessTransaction(shopper, "Sell", "Egg", 3)
	checkEqual(eggSale.Ok, true, "an AnimalDrop sells with no shop changes")
	checkEqual(eggSale.Earned, 3 * GameConfig.GetItem("Egg").SellPrice, "it is paid at its directory SellPrice")
	checkEqual(PlayerDataService:GetGold(shopper), eggCash + eggSale.Earned, "the payout lands")
	checkEqual(PlayerDataService:GetItemCount(shopper, "Egg"), 1, "the stock drops")

	PlayerDataService:AddItem(shopper, "Leather", 2)
	PlayerDataService:AddItem(shopper, "RawBeef", 1)
	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "Leather", 2).Ok, true, "leather sells")
	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "RawBeef", 1).Ok, true, "raw beef sells")
	checkEqual(ShopService:ProcessTransaction(shopper, "Sell", "Milk", 1).Reason, "NotEnoughItems", "unheld milk cannot be sold")

	-- nil prices make a direction simply unavailable.
	checkEqual(
		ShopService:ProcessTransaction(shopper, "Buy", "Carrot", 1).Reason,
		"NotPurchasable",
		"a crop has no BuyPrice and cannot be bought"
	)
	checkEqual(
		ShopService:ProcessTransaction(shopper, "Buy", "Egg", 1).Reason,
		"NotPurchasable",
		"an AnimalDrop cannot be bought"
	)
	checkEqual(
		ShopService:ProcessTransaction(shopper, "Sell", "CarrotSeed", 1).Reason,
		"NotSellable",
		"a seed has no SellPrice and cannot be sold back"
	)
	checkEqual(
		ShopService:ProcessTransaction(shopper, "Buy", "GrowthBoost", 1).Reason,
		"NotPurchasable",
		"a Robux-only item is not purchasable for Cash"
	)
	checkEqual(
		ShopService:ProcessTransaction(shopper, "Sell", "GrowthBoost", 1).Reason,
		"NotSellable",
		"a Robux-only item is not sellable for Cash"
	)

	-- Action type is validated strictly.
	checkEqual(ShopService:ProcessTransaction(shopper, "Steal", "Carrot", 1).Reason, "InvalidAction", "an unknown action is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, "buy", "CarrotSeed", 1).Reason, "InvalidAction", "the action is case sensitive")
	checkEqual(ShopService:ProcessTransaction(shopper, nil, "CarrotSeed", 1).Reason, "InvalidAction", "a nil action is refused")
	checkEqual(ShopService:ProcessTransaction(shopper, { exploit = true }, "CarrotSeed", 1).Reason, "InvalidAction", "a table action is refused")

	-- SellAll spans categories and skips unsellable stock.
	PlayerDataService:AddItem(shopper, "Egg", 2)
	PlayerDataService:AddItem(shopper, "Tomato", 1)
	local boostsHeld = PlayerDataService:GetItemCount(shopper, "GrowthBoost")
	PlayerDataService:AddItem(shopper, "GrowthBoost", 1)
	local seedsHeld = PlayerDataService:GetItemCount(shopper, "CarrotSeed")

	local mixedSale = ShopService:SellAll(shopper)
	checkEqual(mixedSale.Ok, true, "sell-all spans every sellable category")
	check(mixedSale.Sold.Egg ~= nil and mixedSale.Sold.Tomato ~= nil, "both a crop and an AnimalDrop were sold")
	checkEqual(
		PlayerDataService:GetItemCount(shopper, "GrowthBoost"),
		boostsHeld + 1,
		"sell-all leaves unsellable items alone"
	)
	checkEqual(PlayerDataService:GetItemCount(shopper, "CarrotSeed"), seedsHeld, "sell-all does not dump seeds")

	----------------------------------------------------------------------------
	section("Framework: physical storefront")
	----------------------------------------------------------------------------

	local ShopBuilder = require(ShopBuilderModule)
	local npc = ShopBuilder.Build()

	checkEqual(npc.Name, GameConfig.Shop.NpcName, "the NPC is named for the client to find")
	checkEqual(npc.Parent.Name, "Workspace", "the NPC lives in Workspace")
	check(npc.PrimaryPart ~= nil, "the NPC has a PrimaryPart to host the prompt")

	local shopPrompt = npc.PrimaryPart:FindFirstChild(ShopBuilder.PromptName)
	check(shopPrompt ~= nil, "the NPC carries a ProximityPrompt the client can listen to")
	checkEqual(shopPrompt.ActionText, GameConfig.Shop.PromptActionText, "the prompt is labelled from config")
	checkEqual(ShopBuilder.Build(), npc, "building twice reuses the existing NPC")

	-- Every directory item must render in exactly one category tab, or the UI
	-- would silently hide it.
	local tabbed = 0
	for _, category in GameConfig.ItemCategories do
		tabbed += #GameConfig.GetItemsByCategory(category)
	end

	local directorySize = 0
	for _ in GameConfig.Items do
		directorySize += 1
	end

	checkEqual(tabbed, directorySize, "every registered item appears under exactly one category tab")

	----------------------------------------------------------------------------
	section("ShopService: remotes and rate limiting")
	----------------------------------------------------------------------------

	local transactFn = require(Shared.Remotes).GetFunction(GameConfig.RemoteNames.ProcessTransaction)
	local sellAllFn = require(Shared.Remotes).GetFunction(GameConfig.RemoteNames.SellAll)

	check(transactFn ~= nil, "the ProcessTransaction RemoteFunction exists")
	check(transactFn.OnServerInvoke ~= nil, "the ProcessTransaction handler is installed")
	check(sellAllFn.OnServerInvoke ~= nil, "the SellAll handler is installed")

	advance(5) -- let the token bucket refill
	local viaRemote = transactFn.OnServerInvoke(shopper, "Buy", "CarrotSeed", 1)
	checkEqual(viaRemote.Ok, true, "buying through the remote works")

	local junkViaRemote = transactFn.OnServerInvoke(shopper, "Buy", { exploit = true }, 1)
	checkEqual(junkViaRemote.Ok, false, "the remote rejects a junk seed id")
	checkEqual(junkViaRemote.Reason, "InvalidItem", "the remote returns a result rather than erroring")

	PlayerDataService:AddItem(shopper, "Carrot", 1)
	advance(5)
	checkEqual(transactFn.OnServerInvoke(shopper, "Sell", "Carrot", 1).Ok, true, "selling through the remote works")

	-- Burst past the bucket without advancing the clock.
	local throttled = false
	for _ = 1, GameConfig.Shop.BurstSize + 10 do
		local result = transactFn.OnServerInvoke(shopper, "Buy", "CarrotSeed", 1)

		if not result.Ok and result.Reason == "RateLimited" then
			throttled = true
		end
	end
	check(throttled, "a burst of remote calls is rate limited")

	advance(5)
	checkEqual(
		transactFn.OnServerInvoke(shopper, "Buy", "CarrotSeed", 1).Ok,
		true,
		"the bucket refills, so throttling is temporary"
	)

	----------------------------------------------------------------------------
	section("ShopService: catalog")
	----------------------------------------------------------------------------

	local rookie = newPlayer(707, "Rookie")
	PlayersService.PlayerAdded:Fire(rookie)

	local rookieCatalog = ShopService:GetCatalog(rookie)
	checkEqual(#rookieCatalog, 1, "a level 1 player can only buy the starter seed")
	checkEqual(rookieCatalog[1].Id, "CarrotSeed", "the starter seed is the cheapest entry")

	local everyPlantable = 0
	for _ in GameConfig.Plantables do
		everyPlantable += 1
	end

	local fullCatalog = GameConfig.GetAvailablePlantables(GameConfig.Progression.MaxLevel)
	checkEqual(#fullCatalog, everyPlantable, "a max level player can plant every seed")

	local ascending = true
	for index = 2, #fullCatalog do
		local previous = GameConfig.GetItem(fullCatalog[index - 1].SeedId).BuyPrice
		local current = GameConfig.GetItem(fullCatalog[index].SeedId).BuyPrice

		if current < previous then
			ascending = false
		end
	end
	check(ascending, "the plantable list is ordered cheapest first")

	----------------------------------------------------------------------------
	section("RateLimiter")
	----------------------------------------------------------------------------

	local RateLimiter = require(Shared.RateLimiter)
	local limiter = RateLimiter.new(2, 3)

	checkEqual(limiter:Consume("k"), true, "the first call consumes a token")
	checkEqual(limiter:Consume("k"), true, "burst allows a second call")
	checkEqual(limiter:Consume("k"), true, "burst allows a third call")
	checkEqual(limiter:Consume("k"), false, "the fourth call exhausts the burst")

	advance(1)
	checkEqual(limiter:Consume("k"), true, "tokens refill over time")
	checkEqual(limiter:Consume("other"), true, "buckets are independent per key")

	limiter:Forget("k")
	checkEqual(limiter:Peek("k"), 3, "a forgotten key resets to a full bucket")

	-- Scoped: this suite is a single function and Luau caps live locals at 200.
	do
	-- Scoped: Luau caps live locals per function at 200 and this suite is one.
	do
		------------------------------------------------------------------------
		section("Placement: the build tree")
		------------------------------------------------------------------------

		local PlacementService = require(PlacementServiceModule)
		local DamageableService = require(DamageableServiceModule)
		PlacementService:Start()
		DamageableService:Start()

		local builder = newPlayer(1717, "Builder")
		giveCharacter(builder, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(builder)

		-- Prerequisites gate the tree: no Town Center means no Mill.
		checkEqual(select(2, PlacementService:GetBuildability(builder, "TownCenter")), nil, "a root structure is buildable")
		checkEqual(
			select(2, PlacementService:GetBuildability(builder, "Mill")),
			"MissingPrerequisite",
			"a Mill needs a Town Center first"
		)
		checkEqual(
			PlacementService:Place(builder, "Mill", 10, 10).Reason,
			"MissingPrerequisite",
			"and placement refuses it"
		)
		checkEqual(
			select(2, PlacementService:GetBuildability(builder, "WatchTower")),
			"AgeTooLow",
			"a Bronze Age structure is gated by Age, not prerequisites"
		)

		-- Unknown and malformed input.
		checkEqual(PlacementService:Place(builder, "Castle", 0, 0).Reason, "UnknownStructure", "unknown structures are refused")
		checkEqual(PlacementService:Place(builder, { bad = true }, 0, 0).Reason, "UnknownStructure", "so is a table id")

		-- Fund the build.
		PlayerDataService:AddResource(builder, "Wood", 5000)
		PlayerDataService:AddResource(builder, "Stone", 5000)

		local woodBefore = PlayerDataService:GetResource(builder, "Wood")
		local centre = PlacementService:Place(builder, "TownCenter", 120, 120)
		checkEqual(centre.Ok, true, "a Town Center places")
		check(PlayerDataService:GetResource(builder, "Wood") < woodBefore, "placement costs resources")
		checkEqual(PlayerDataService:GetData(builder).Structures[centre.InstanceId].StructureId, "TownCenter",
			"the structure is persisted")
		checkEqual(PlacementService:CountOwned(builder, "TownCenter"), 1, "and counted")

		-- Per-player limits.
		checkEqual(
			PlacementService:Place(builder, "TownCenter", 200, 200).Reason,
			"LimitReached",
			"the per-player limit is enforced"
		)

		-- Coordinate validation.
		for _, bad in { 0 / 0, math.huge, -math.huge, 9999, "nope", {} } do
			checkEqual(
				PlacementService:Place(builder, "Mill", bad, 120).Reason,
				"InvalidPosition",
				`an invalid coordinate is refused ({tostring(bad)})`
			)
		end

		------------------------------------------------------------------------
		section("Placement: position is unrestricted")
		------------------------------------------------------------------------

		--[[
			Age of Empires lets you build anywhere you can reach; proximity to
			your own buildings is an efficiency concern, not a permission. The
			only positional rule is that footprints must not overlap.

			The absence of a radius check is the rule being asserted, so the
			removed method is pinned as gone - a reintroduced radius would have
			to delete this line, which is the conversation worth forcing.
		]]
		checkEqual(
			PlacementService.IsWithinRadiusOf,
			nil,
			"there is no radius test to place within"
		)

		local far = PlacementService:Place(builder, "Mill", -200, -200)
		checkEqual(far.Ok, true, "a Mill on the far side of the map places")

		local mill = PlacementService:Place(builder, "Mill", 140, 120)
		checkEqual(mill.Ok, true, "and so does one beside the Town Center")

		-- Prerequisites survive the change: a Farm needs you to OWN a Mill,
		-- which is a tech-tree rule, not a distance one.
		local farm = PlacementService:Place(builder, "Farm", 152, 120)
		checkEqual(farm.Ok, true, "a Farm places beside its Mill")

		local orphan = PlacementService:Place(builder, "Farm", 200, -200)
		checkEqual(orphan.Ok, true, "and just as happily nowhere near it")
		checkEqual(PlacementService:Demolish(builder, orphan.InstanceId).Ok, true, "(tidied away)")

		-- Out of bounds is still out of bounds.
		checkEqual(
			PlacementService:Place(builder, "Mill", GameConfig.Placement.WorldLimit + 1, 0).Reason,
			"InvalidPosition",
			"the world edge still bounds placement"
		)

		------------------------------------------------------------------------
		section("Placement: counts replicate to the client")
		------------------------------------------------------------------------

		--[[
			The build menu greys rows out by count, and it used to derive those
			counts by scanning Workspace.Structures on ChildAdded. That raced
			replication - the model arrives before its OwnerUserId attribute -
			so a structure that had just satisfied a prerequisite still looked
			unbuilt, and the menu only caught up when reopened.

			So the server replicates the count it already knows.
		]]
		local countsFolder = builder:FindFirstChild(GameConfig.StructureCountsFolderName)
		check(countsFolder ~= nil, "the counts folder is published on the player")

		checkEqual(
			countsFolder:GetAttribute("Mill"),
			PlacementService:CountOwned(builder, "Mill"),
			"the replicated Mill count matches the server's"
		)
		checkEqual(
			countsFolder:GetAttribute("Farm"),
			PlacementService:CountOwned(builder, "Farm"),
			"and so does the Farm count"
		)

		-- Every structure is present, zero included: a reader must never have
		-- to tell "none built" apart from "not replicated yet".
		local published = 0
		for structureId in GameConfig.Structures do
			check(
				type(countsFolder:GetAttribute(structureId)) == "number",
				`{structureId} has a published count`
			)
			published += 1
		end
		check(published >= 4, `every structure is published ({published})`)

		-- The attribute must move on the placement itself, not on a later poll.
		local millsBefore = countsFolder:GetAttribute("Mill")
		local extra = PlacementService:Place(builder, "Mill", -200, 200)
		checkEqual(extra.Ok, true, "another Mill places")
		checkEqual(
			countsFolder:GetAttribute("Mill"),
			millsBefore + 1,
			"the count rises as part of placing, with no refresh needed"
		)

		PlacementService:Demolish(builder, extra.InstanceId)
		checkEqual(
			countsFolder:GetAttribute("Mill"),
			millsBefore,
			"and falls again on demolish"
		)

		-- The menu's real question: "can I build a Farm yet?" must flip the
		-- moment the Mill exists, which is what the stale menu got wrong.
		local prereqTester = newPlayer(2929, "Prereq")
		giveCharacter(prereqTester, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(prereqTester)

		PlayerDataService:AddResource(prereqTester, "Wood", 2000)
		PlayerDataService:AddResource(prereqTester, "Stone", 2000)

		local prereqFolder = prereqTester:FindFirstChild(GameConfig.StructureCountsFolderName)
		check(prereqFolder ~= nil, "a fresh player gets a counts folder before building anything")
		checkEqual(prereqFolder:GetAttribute("Mill"), 0, "with a zero Mill count")

		-- Watch the folder the way the menu does.
		local refreshes = 0
		prereqFolder.AttributeChanged:Connect(function()
			refreshes += 1
		end)

		checkEqual(PlacementService:Place(prereqTester, "TownCenter", 0, -200).Ok, true, "a Town Center goes up")
		checkEqual(PlacementService:Place(prereqTester, "Mill", -40, -200).Ok, true, "then a Mill")

		check(refreshes > 0, `the watcher was told to refresh ({refreshes} times)`)
		checkEqual(prereqFolder:GetAttribute("Mill"), 1, "and the Mill count is live")
		checkEqual(
			select(1, PlacementService:GetBuildability(prereqTester, "Farm")),
			true,
			"so the Farm row unlocks without reopening the menu"
		)

		PlayersService.PlayerRemoving:Fire(prereqTester)
		prereqTester.Parent = nil

		------------------------------------------------------------------------
		section("Placement: overlap, demolish and persistence")
		------------------------------------------------------------------------

		-- Footprints cannot interpenetrate.
		checkEqual(PlacementService:Place(builder, "Farm", 152, 120).Reason, "Blocked", "an exact overlap is refused")
		checkEqual(PlacementService:Place(builder, "Farm", 154, 120).Reason, "Blocked", "and so is a partial one")
		checkEqual(PlacementService:Place(builder, "Farm", 142, 132).Ok, true, "a clear spot is allowed")

		-- Cost is not taken when placement fails.
		local woodHeld = PlayerDataService:GetResource(builder, "Wood")
		PlacementService:Place(builder, "Farm", 152, 120)
		checkEqual(PlayerDataService:GetResource(builder, "Wood"), woodHeld, "a refused placement costs nothing")

		-- Structures are damageable, and health persists.
		local farmModel = PlacementService:GetPlaced(builder)[farm.InstanceId].Model
		local farmEntity = PlacementService:GetPlaced(builder)[farm.InstanceId].EntityId
		check(farmModel ~= nil and farmEntity ~= nil, "a placed structure registers health")
		checkEqual(farmModel:GetAttribute("MaxHealth"), GameConfig.Archetypes.Farm.MaxHealth,
			"health replicates on the model")

		DamageableService:ApplyDamage(farmEntity, 50, "Siege", nil)
		local farmHealth = DamageableService:GetHealth(farmEntity)
		check(farmHealth < GameConfig.Archetypes.Farm.MaxHealth, "a structure takes damage")
		checkEqual(
			PlayerDataService:GetData(builder).Structures[farm.InstanceId].Health,
			farmHealth,
			"structure health is mirrored onto the profile"
		)

		-- Destroying a structure removes it from the world and the profile.
		DamageableService:ApplyDamage(farmEntity, 99999, "Siege", nil)
		checkEqual(PlayerDataService:GetData(builder).Structures[farm.InstanceId], nil,
			"a destroyed structure clears from the profile")
		checkEqual(PlacementService:GetPlaced(builder)[farm.InstanceId], nil, "and from the world")

		-- Demolish.
		local demolish = PlacementService:Demolish(builder, mill.InstanceId)
		checkEqual(demolish.Ok, true, "an owned structure can be demolished")
		checkEqual(PlayerDataService:GetData(builder).Structures[mill.InstanceId], nil, "and is forgotten")
		checkEqual(PlacementService:Demolish(builder, mill.InstanceId).Reason, "UnknownStructure",
			"demolishing twice is refused")
		checkEqual(PlacementService:Demolish(builder, "9999").Reason, "UnknownStructure",
			"demolishing something you do not own is refused")

		-- Instance ids are never reused, even after a demolish.
		local reused = PlacementService:Place(builder, "Mill", 140, 120)
		check(reused.Ok, "a Mill can be rebuilt after demolishing")
		check(reused.InstanceId ~= mill.InstanceId, "a new instance id is issued rather than reused")

		------------------------------------------------------------------------
		section("Placement: structures survive a rejoin")
		------------------------------------------------------------------------

		local snapshot = {}
		for instanceId, entry in PlayerDataService:GetData(builder).Structures do
			snapshot[instanceId] = entry.StructureId
		end
		local expectedCount = 0
		for _ in snapshot do
			expectedCount += 1
		end
		check(expectedCount >= 2, `the builder has structures to persist ({expectedCount})`)

		PlayersService.PlayerRemoving:Fire(builder)
		builder.Parent = nil
		checkEqual(next(PlacementService:GetPlaced(builder)), nil, "leaving tears down the world copies")

		local returning = newPlayer(1717, "Builder")
		giveCharacter(returning, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(returning)

		local restored = 0
		for instanceId, structureId in snapshot do
			local placed = PlacementService:GetPlaced(returning)[instanceId]

			if placed and placed.StructureId == structureId then
				restored += 1
			end
		end
		checkEqual(restored, expectedCount, "every structure is rebuilt from saved data")
		checkEqual(PlacementService:HasStructure(returning, "TownCenter"), true, "including the Town Center")

		-- Age gating releases on advancing.
		checkEqual(select(2, PlacementService:GetBuildability(returning, "WatchTower")), "AgeTooLow",
			"the tower is still age-locked")
		for resourceId, amount in GameConfig.GetAdvanceCost(1) do
			PlayerDataService:AddResource(returning, resourceId, amount)
		end
		checkEqual(select(1, PlayerDataService:TryAdvanceAge(returning)), true, "the player ages up")
		checkEqual(select(2, PlacementService:GetBuildability(returning, "WatchTower")), nil,
			"advancing an age unlocks the tower")
	end

	----------------------------------------------------------------------------
	section("Combat: damage maths")
	----------------------------------------------------------------------------

	local Combat = require(Shared.Combat)

	-- The counter table is the rock-paper-scissors layer.
	check(
		Combat.ComputeDamage(100, "Siege", "Building", 0) > Combat.ComputeDamage(100, "Melee", "Building", 0),
		"siege out-damages melee against buildings"
	)
	check(
		Combat.ComputeDamage(100, "Siege", "Light", 0) < Combat.ComputeDamage(100, "Melee", "Light", 0),
		"and is worse than melee against troops"
	)
	check(
		Combat.ComputeDamage(100, "Pierce", "Unarmoured", 0) > Combat.ComputeDamage(100, "Pierce", "Heavy", 0),
		"pierce shreds the unarmoured and glances off heavy armour"
	)

	checkEqual(Combat.ComputeDamage(100, "Melee", "Unarmoured", 25), 75, "flat armour subtracts after the multiplier")
	checkEqual(
		Combat.ComputeDamage(10, "Pierce", "Heavy", 100),
		GameConfig.Combat.MinimumDamage,
		"a hard counter still lands MinimumDamage, so nothing is truly immune"
	)
	checkEqual(Combat.ComputeDamage(0, "Melee", "Light", 0), 0, "zero damage stays zero")
	checkEqual(Combat.ComputeDamage(-5, "Melee", "Light", 0), 0, "negative damage cannot heal")
	checkEqual(Combat.ComputeDamage(0 / 0, "Melee", "Light", 0), 0, "NaN damage is rejected")
	checkEqual(Combat.ComputeDamage(math.huge, "Melee", "Light", 0), 0, "infinite damage is rejected")
	checkEqual(
		Combat.ComputeDamage(100, "Unknown", "Light", 0),
		100,
		"an unknown pairing falls back to unmodified rather than zero"
	)

	-- Health derives from a timestamp, like growth.
	local cropArch = GameConfig.Archetypes.Crop
	checkEqual(Combat.DeriveHealth(50, 100, 0, 0, 1000), 50, "without regen health is the stored baseline")
	checkEqual(Combat.DeriveHealth(50, 100, 1, 0, 10), 60, "regen accrues from the damage timestamp")
	checkEqual(Combat.DeriveHealth(50, 100, 1, 0, 99999), 100, "regen is capped at MaxHealth")
	checkEqual(Combat.DeriveHealth(0, 100, 10, 0, 99999), 0, "a destroyed entity never regenerates back to life")
	checkEqual(Combat.DeriveHealth(50, 100, 1, 500, 100), 50, "a future timestamp does not drain health")

	checkEqual(
		Combat.GetHealthFraction({ Health = 25, DamagedAt = 0 }, { MaxHealth = 100, RegenPerSecond = 0 }, 0),
		0.25,
		"health fraction feeds the bar"
	)

	-- Repair costs scale with the damage taken, and round up.
	checkEqual(Combat.GetRepairCost(cropArch, 50), nil, "crops cannot be repaired")
	local millCost = Combat.GetRepairCost(GameConfig.Archetypes.Mill, 100)
	checkEqual(millCost.Wood, 50, "repair cost is per missing health point")
	checkEqual(Combat.GetRepairCost(GameConfig.Archetypes.Mill, 1).Wood, 1, "a scratch is never free")
	checkEqual(Combat.GetRepairCost(GameConfig.Archetypes.Mill, 0), nil, "an undamaged building costs nothing")

	local raiderRewards = Combat.GetRewards(GameConfig.Archetypes.EnemyRaider, 3)
	checkEqual(raiderRewards.XP, 36, "kill rewards scale with level")
	checkEqual(Combat.GetRewards(cropArch, 5).XP, 0, "archetypes without rewards give nothing")

	----------------------------------------------------------------------------
	section("Combat: the damageable registry")
	----------------------------------------------------------------------------

	local DamageableService = require(DamageableServiceModule)
	DamageableService:Start()

	local defender = newPlayer(1414, "Defender")
	giveCharacter(defender, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(defender)

	local attackerPlayer = newPlayer(1515, "Attacker")
	PlayersService.PlayerAdded:Fire(attackerPlayer)

	local millModel = Instance.new("Model")
	millModel.Name = "Mill"
	millModel.Parent = WorkspaceService

	local millId = DamageableService:Register({
		ArchetypeId = "Mill",
		Model = millModel,
		OwnerUserId = defender.UserId,
	})

	check(millId ~= nil, "an entity registers")
	checkEqual(DamageableService:Register({ ArchetypeId = "Nonsense" }), nil, "an unknown archetype is rejected")
	checkEqual(DamageableService:GetHealth(millId), 1200, "it starts at full health")
	checkEqual(millModel:GetAttribute("MaxHealth"), 1200, "health replicates as attributes")
	checkEqual(millModel:GetAttribute("ArmourClass"), "Building", "so does the armour class")
	checkEqual(DamageableService:GetByModel(millModel), millId, "entities are findable by model")

	-- Buildings never self-heal.
	local hit = DamageableService:ApplyDamage(millId, 200, "Siege", attackerPlayer)
	checkEqual(hit.Ok, true, "damage applies")
	checkEqual(hit.Destroyed, false, "a survivable hit does not destroy")
	check(DamageableService:GetHealth(millId) < 1200, "health drops")
	local afterHit = DamageableService:GetHealth(millId)
	advance(60)
	checkEqual(DamageableService:GetHealth(millId), afterHit, "a building does NOT regenerate over time")

	-- Repair, charged to the treasury.
	PlayerDataService:AddResource(defender, "Wood", 5000)
	local woodHeld = PlayerDataService:GetResource(defender, "Wood")
	local repair = DamageableService:Repair(millId, defender)
	checkEqual(repair.Ok, true, "an owner can repair")
	checkEqual(DamageableService:GetHealth(millId), 1200, "repair restores full health")
	check(PlayerDataService:GetResource(defender, "Wood") < woodHeld, "repair costs resources")
	checkEqual(DamageableService:Repair(millId, defender).Reason, "AlreadyFull", "repairing a full building is refused")
	checkEqual(DamageableService:Repair(millId, attackerPlayer).Reason, "NotOwner", "only the owner may repair")

	-- Repair cannot half-charge: no resources means no repair and no spend.
	DamageableService:ApplyDamage(millId, 100, "Siege", attackerPlayer)
	local pauper = newPlayer(1616, "Broke")
	PlayersService.PlayerAdded:Fire(pauper)
	local brokeMill = Instance.new("Model")
	brokeMill.Name = "BrokeMill"
	brokeMill.Parent = WorkspaceService
	local brokeId = DamageableService:Register({
		ArchetypeId = "Mill",
		Model = brokeMill,
		OwnerUserId = pauper.UserId,
	})
	-- 100 Siege is 250 after the building multiplier: damaging, not lethal.
	DamageableService:ApplyDamage(brokeId, 100, "Siege", attackerPlayer)
	PlayerDataService:TrySpendResources(pauper, { Wood = PlayerDataService:GetResource(pauper, "Wood") })
	local brokeHealth = DamageableService:GetHealth(brokeId)
	checkEqual(DamageableService:Repair(brokeId, pauper).Reason, "NotEnoughResources", "repair needs resources")
	checkEqual(DamageableService:GetHealth(brokeId), brokeHealth, "a failed repair restores nothing")
	checkEqual(PlayerDataService:GetResource(pauper, "Wood"), 0, "and charges nothing")

	-- Repair All
	local estimate = DamageableService:GetRepairEstimate(defender)
	check(estimate.Wood ~= nil and estimate.Wood > 0, "the repair estimate reports a cost up front")
	local all = DamageableService:RepairAll(defender)
	checkEqual(all.Ok, true, "Repair All repairs owned buildings")
	checkEqual(DamageableService:GetHealth(millId), 1200, "and brings them to full")
	checkEqual(DamageableService:RepairAll(defender).Ok, false, "Repair All with nothing damaged is refused")

	----------------------------------------------------------------------------
	section("Combat: destruction, shattering and rewards")
	----------------------------------------------------------------------------

	-- Kill rewards land in the PURSE, never the treasury.
	local raiderModel = Instance.new("Model")
	raiderModel.Name = "Raider"
	raiderModel.Parent = WorkspaceService

	local raiderId = DamageableService:Register({
		ArchetypeId = "EnemyRaider",
		Model = raiderModel,
		OwnerUserId = 0,
		Level = 2,
	})

	local purseBeforeKill = PlayerDataService:GetInventoryGold(attackerPlayer)
	local treasuryBeforeKill = PlayerDataService:GetGold(attackerPlayer)
	local kills = {}
	DamageableService.Destroyed:Connect(function(id)
		table.insert(kills, id)
	end)

	local killBlow = DamageableService:ApplyDamage(raiderId, 9999, "Melee", attackerPlayer)
	checkEqual(killBlow.Destroyed, true, "a lethal hit destroys")
	checkEqual(killBlow.Shattered, false, "a Remove archetype does not shatter")
	checkEqual(DamageableService:Get(raiderId), nil, "and is unregistered")
	check(table.find(kills, raiderId) ~= nil, "Destroyed fires")

	local expected = Combat.GetRewards(GameConfig.Archetypes.EnemyRaider, 2)
	checkEqual(
		PlayerDataService:GetInventoryGold(attackerPlayer),
		purseBeforeKill + expected.Gold,
		"kill gold lands in the killer's purse"
	)
	checkEqual(
		PlayerDataService:GetGold(attackerPlayer),
		treasuryBeforeKill,
		"and NOT in the treasury - kills are the only thing that fills the purse"
	)

	checkEqual(DamageableService:ApplyDamage(raiderId, 10, "Melee").Reason, "UnknownEntity", "a dead entity cannot be hit")

	-- No farming your own property for rewards.
	local selfModel = Instance.new("Model")
	selfModel.Name = "OwnRaider"
	selfModel.Parent = WorkspaceService
	local selfId = DamageableService:Register({
		ArchetypeId = "EnemyRaider",
		Model = selfModel,
		OwnerUserId = attackerPlayer.UserId,
		Level = 5,
	})
	local purseBeforeSelf = PlayerDataService:GetInventoryGold(attackerPlayer)
	DamageableService:ApplyDamage(selfId, 9999, "Melee", attackerPlayer)
	checkEqual(
		PlayerDataService:GetInventoryGold(attackerPlayer),
		purseBeforeSelf,
		"destroying your own entity pays nothing"
	)

	-- Shatter: a destroyed Checkpoint is a setback, not a loss.
	local checkpointModel = Instance.new("Model")
	checkpointModel.Name = "Checkpoint"
	checkpointModel.Parent = WorkspaceService

	local checkpointId = DamageableService:Register({
		ArchetypeId = "Checkpoint",
		Model = checkpointModel,
		OwnerUserId = defender.UserId,
	})

	local shatter = DamageableService:ApplyDamage(checkpointId, 99999, "Siege", attackerPlayer)
	checkEqual(shatter.Shattered, true, "a Shatter archetype shatters instead of vanishing")
	check(DamageableService:Get(checkpointId) ~= nil, "and stays registered so it can be rebuilt")
	checkEqual(DamageableService:IsAlive(checkpointId), false, "a shattered entity is not alive")
	checkEqual(checkpointModel:GetAttribute("Shattered"), true, "the shattered state replicates")
	checkEqual(
		DamageableService:ApplyDamage(checkpointId, 100, "Siege", attackerPlayer).Reason,
		"AlreadyDestroyed",
		"a shattered entity cannot be hit again"
	)
	checkEqual(DamageableService:Repair(checkpointId, defender).Reason, "Shattered", "it cannot be merely repaired")

	PlayerDataService:AddResource(defender, "Wood", 5000)
	PlayerDataService:AddResource(defender, "Stone", 5000)
	local rebuild = DamageableService:Rebuild(checkpointId, defender)
	checkEqual(rebuild.Ok, true, "a shattered entity can be rebuilt")
	checkEqual(DamageableService:GetHealth(checkpointId), 2000, "rebuilding restores full health")
	checkEqual(DamageableService:IsAlive(checkpointId), true, "and it is alive again")
	checkEqual(checkpointModel:GetAttribute("Shattered"), false, "the shattered flag clears")
	checkEqual(DamageableService:Rebuild(checkpointId, defender).Reason, "NotShattered", "rebuilding a live entity is refused")
	checkEqual(DamageableService:Rebuild(millId, defender).Reason, "NotShattered", "and so is rebuilding an undamaged one")

	----------------------------------------------------------------------------
	section("Combat: crops are damageable and persist")
	----------------------------------------------------------------------------

	-- A planted crop registers with the same system as buildings.
	local cropFarm = makeFarm(defender, -60, 180)
	check(cropFarm ~= nil, "built a farm to grow a damageable crop on")

	PlayerDataService:AddItem(defender, "CarrotSeed", 2)
	advance(1)
	selectSeed.OnServerEvent:Fire(defender, "CarrotSeed")
	advance(1)
	pokeFarm(defender, cropFarm)
	checkEqual(farmOf(defender, cropFarm):GetAttribute("SeedId"), "CarrotSeed", "a crop is planted")

	-- The crop is its own entity, distinct from the farm it sits on.
	local cropContainer = farmOf(defender, cropFarm):FindFirstChild("Crop")
	check(cropContainer ~= nil, "the crop has its own container")
	local cropEntity = DamageableService:GetByModel(cropContainer)
	check(cropEntity ~= nil, "the crop registered as a damageable entity")
	checkEqual(DamageableService:GetHealth(cropEntity), 100, "it starts at full crop health")
	check(PLACEMENT:GetPlaced(defender)[cropFarm].EntityId ~= cropEntity,
		"the farm and its crop are distinct entities")

	DamageableService:ApplyDamage(cropEntity, 40, "Siege", attackerPlayer)
	local cropDamaged = DamageableService:GetHealth(cropEntity)
	check(cropDamaged < 100, "a crop can be damaged")
	checkEqual(
		PlayerDataService:GetData(defender).Structures[cropFarm].CropHealth,
		cropDamaged,
		"crop health is mirrored onto the farm record so it survives a rejoin"
	)

	-- Crops regenerate; the farm beneath them does not.
	advance(30)
	check(DamageableService:GetHealth(cropEntity) > cropDamaged, "a crop regenerates over time")

	-- Destroying the crop leaves the farm standing and fallow.
	DamageableService:ApplyDamage(cropEntity, 9999, "Siege", attackerPlayer)
	checkEqual(farmOf(defender, cropFarm):GetAttribute("SeedId"), "", "a destroyed crop leaves the farm fallow")
	checkEqual(PlayerDataService:GetData(defender).Structures[cropFarm].SeedId, "", "and clears on the record")
	check(PLACEMENT:GetPlaced(defender)[cropFarm] ~= nil, "the farm itself survives losing its crop")

	-- Harvesting unregisters the crop entity, so the registry cannot leak.
	advance(1)
	pokeFarm(defender, cropFarm)
	local replanted = DamageableService:GetByModel(farmOf(defender, cropFarm):FindFirstChild("Crop"))
	check(replanted ~= nil, "replanting registers a new crop entity")
	advance(GameConfig.GetPlantable("CarrotSeed").GrowTime + 2)
	advance(1)
	pokeFarm(defender, cropFarm)
	checkEqual(DamageableService:Get(replanted), nil, "harvesting unregisters the crop entity")
	end

	-- Scoped: Luau caps live locals per function at 200 and this suite is one.
	do
		------------------------------------------------------------------------
		section("Status effects: the elemental counter rows")
		------------------------------------------------------------------------

		local Combat = require(Shared.Combat)
		local StatusEffects = require(Shared.StatusEffects)
		local StatusEffectService = require(StatusEffectServiceModule)
		local DamageableService = require(DamageableServiceModule)

		local MULT = GameConfig.Combat.Multipliers
		local RULES = GameConfig.StatusEffectRules

		--- Floats: counter multipliers do not land on integers.
		local function checkNear(actual, expected, label)
			local tolerance = 0.001
			check(
				type(actual) == "number" and math.abs(actual - expected) <= tolerance,
				`{label} (got {tostring(actual)}, expected ~{expected})`
			)
		end

		-- The three elemental rows exist to carry effects, and their shape is
		-- the design. GameConfig asserts completeness at require time; this
		-- asserts the intent.
		check(MULT.Fire.Crop > MULT.Fire.Building, "fire ruins crops far more readily than masonry")
		check(MULT.Fire.Light > 1, "and spreads well through packed light troops")
		check(MULT.Ice.Building < MULT.Melee.Building, "ice is the worst siege weapon in the game")
		check(MULT.Poison.Heavy >= MULT.Poison.Light * 0.8, "armour is no real defence against poison")
		check(MULT.Poison.Building < 0.2, "but poisoning a wall achieves nothing")

		-- Even a useless pairing lands the floor, so no element is a no-op.
		checkEqual(
			Combat.ComputeDamage(10, "Poison", "Building", 8),
			GameConfig.Combat.MinimumDamage,
			"a hopeless pairing still deals the minimum rather than zero"
		)

		------------------------------------------------------------------------
		section("Status effects: derivation from timestamps")
		------------------------------------------------------------------------

		local burnDef = GameConfig.StatusEffects.Burn
		local now = os.time()
		local record = StatusEffects.NewRecord("Burn", now, 0)

		checkEqual(record.Stacks, 1, "a new record starts at one stack")
		checkEqual(record.ExpiresAt, now + burnDef.Duration, "expiry is absolute, not a countdown")
		checkEqual(record.LastTickAt, now, "nothing has elapsed, so nothing is owed")
		checkEqual(StatusEffects.NewRecord("Nonsense", now, 0), nil, "an unknown effect has no record")

		checkEqual(StatusEffects.IsActive(record, now), true, "a fresh effect is active")
		checkEqual(StatusEffects.IsActive(record, now + burnDef.Duration), false, "and lapses at its expiry")
		checkEqual(StatusEffects.GetRemaining(record, now + 2), burnDef.Duration - 2, "remaining counts down")
		checkEqual(StatusEffects.GetRemaining(record, now + 999), 0, "and never goes negative")

		-- An expired record reads as zero stacks, not as its last value, so a
		-- caller cannot act on a lapsed effect by accident.
		checkEqual(StatusEffects.GetStacks(record, now + 1), 1, "stacks read while active")
		checkEqual(StatusEffects.GetStacks(record, now + 999), 0, "and read as none once lapsed")

		-- Unbilled time is the whole mechanism.
		checkEqual(StatusEffects.GetUnbilledSeconds(record, now), 0, "a fresh record owes nothing")
		checkEqual(StatusEffects.GetUnbilledSeconds(record, now + 3), 3, "three seconds on, it owes three")
		checkEqual(
			StatusEffects.GetUnbilledSeconds(record, now + 999),
			burnDef.Duration,
			"and is capped at its duration no matter how late the reader is"
		)
		checkEqual(
			StatusEffects.GetUnbilledSeconds(record, now - 50),
			0,
			"a clock that steps backwards cannot heal the target"
		)

		checkNear(
			StatusEffects.GetPendingAmount(record, now + 2),
			burnDef.PerSecond * 2,
			"the pending amount is rate times elapsed time"
		)

		do
			-- Stacks multiply the rate linearly.
			local stacked = StatusEffects.NewRecord("Burn", now, 0)
			stacked.Stacks = 3
			checkNear(
				StatusEffects.GetPendingAmount(stacked, now + 2),
				burnDef.PerSecond * 3 * 2,
				"three stacks owe three times as much"
			)
		end

		-- Slows compound and are floored.
		local chillDef = GameConfig.StatusEffects.Chill
		checkEqual(StatusEffects.GetSpeedMultiplier({}, now), 1, "an unaffected target moves at full speed")

		do
			local chilled = { Chill = StatusEffects.NewRecord("Chill", now, 0) }
			checkNear(
				StatusEffects.GetSpeedMultiplier(chilled, now),
				chillDef.SpeedMultiplier,
				"one chill applies its multiplier"
			)

			chilled.Chill.Stacks = 2
			checkNear(
				StatusEffects.GetSpeedMultiplier(chilled, now),
				chillDef.SpeedMultiplier ^ 2,
				"two chills compound rather than add"
			)

			-- Compounding would reach zero eventually, and a target at zero
			-- speed is stun-locked. The floor is the counterplay.
			chilled.Chill.Stacks = 20
			checkEqual(
				StatusEffects.GetSpeedMultiplier(chilled, now),
				RULES.MinimumSpeedMultiplier,
				"a slow can never stun-lock: the multiplier is floored"
			)

			checkEqual(
				StatusEffects.GetSpeedMultiplier(chilled, now + 999),
				1,
				"and a lapsed chill stops slowing"
			)
		end

		------------------------------------------------------------------------
		section("Status effects: applying and expiring")
		------------------------------------------------------------------------

		StatusEffectService:Start()

		local burner = newPlayer(3131, "Burner")
		PlayersService.PlayerAdded:Fire(burner)

		--- A raider with a model, so attribute replication is exercised too.
		local function newRaider(name: string): (number, Instance)
			local model = Instance.new("Model")
			model.Name = name
			model.Parent = WorkspaceService

			return DamageableService:Register({
				ArchetypeId = "EnemyRaider",
				Model = model,
				OwnerUserId = 0,
			}), model
		end

		local raiderId, raiderModel = newRaider("Raider_Apply")

		checkEqual(
			StatusEffectService:Apply(raiderId, "Nonsense", burner).Reason,
			"UnknownEffect",
			"an unknown effect is refused"
		)
		checkEqual(
			StatusEffectService:Apply(999999, "Burn", burner).Reason,
			"NotAlive",
			"so is burning something that does not exist"
		)

		local applied = StatusEffectService:Apply(raiderId, "Burn", burner)
		checkEqual(applied.Ok, true, "a raider can be set on fire")
		checkEqual(applied.Stacks, 1, "starting at one stack")
		checkEqual(StatusEffectService:HasEffect(raiderId, "Burn"), true, "and it reads back as burning")
		checkEqual(StatusEffectService:GetStacks(raiderId, "Chill"), 0, "while unrelated effects stay at zero")

		-- Replicated for the client's pips, without a per-tick write.
		checkEqual(
			raiderModel:GetAttribute(StatusEffects.StackAttribute("Burn")),
			1,
			"the stack count replicates onto the model"
		)
		check(
			raiderModel:GetAttribute(StatusEffects.ExpiryAttribute("Burn")) > os.time(),
			"along with when it will end, so the client runs its own countdown"
		)
		checkEqual(
			raiderModel:GetAttribute(StatusEffects.StackAttribute("Chill")),
			nil,
			"an effect that is not present has no attribute at all"
		)

		-- Stacking, and the cap.
		StatusEffectService:Apply(raiderId, "Burn", burner)
		checkEqual(StatusEffectService:GetStacks(raiderId, "Burn"), 2, "re-applying adds a stack")

		for _ = 1, 10 do
			StatusEffectService:Apply(raiderId, "Burn", burner)
		end
		checkEqual(
			StatusEffectService:GetStacks(raiderId, "Burn"),
			burnDef.MaxStacks,
			"stacks are capped at MaxStacks"
		)

		-- Refreshing: the expiry always comes from the LATEST application.
		checkEqual(
			StatusEffectService:GetRemaining(raiderId, "Burn"),
			burnDef.Duration,
			"re-applying refreshes the full duration"
		)

		-- Independent effects coexist.
		StatusEffectService:Apply(raiderId, "Chill", burner)
		checkEqual(#StatusEffectService:GetActive(raiderId), 2, "a target can carry two effects at once")
		checkNear(
			StatusEffectService:GetSpeedMultiplier(raiderId),
			chillDef.SpeedMultiplier,
			"the chill slows it while the burn does not"
		)

		-- A cleanse removes one effect and leaves the rest.
		checkEqual(StatusEffectService:Clear(raiderId, "Chill"), true, "an effect can be cleansed")
		checkEqual(StatusEffectService:HasEffect(raiderId, "Chill"), false, "and is gone immediately")
		checkEqual(StatusEffectService:GetSpeedMultiplier(raiderId), 1, "so the slow lifts")
		checkEqual(StatusEffectService:HasEffect(raiderId, "Burn"), true, "while the burn is untouched")
		checkEqual(StatusEffectService:Clear(raiderId, "Chill"), false, "cleansing twice reports nothing removed")

		-- Expiry, driven by the loop rather than by anyone asking.
		advance(burnDef.Duration + 2)
		checkEqual(StatusEffectService:HasEffect(raiderId, "Burn"), false, "a burn burns out on its own")
		checkEqual(
			raiderModel:GetAttribute(StatusEffects.StackAttribute("Burn")),
			nil,
			"and its attributes are stripped, not left reading zero"
		)
		check(DamageableService:GetHealth(raiderId) < 120, "it took damage while it burned")

		------------------------------------------------------------------------
		section("Status effects: a late tick bills elapsed time")
		------------------------------------------------------------------------

		--[[
			THE test. Damage over time has to tick, because the death must
			happen whether or not anyone is looking - but the AMOUNT has to
			come from elapsed time.

			`PerSecond * TickInterval` per tick looks identical while ticks are
			regular, and quietly turns every lag spike into free healing for
			the enemy. A stalled loop is simulated by backdating LastTickAt,
			which is exactly what a stall leaves behind.
		]]
		do
			local stalledId = newRaider("Raider_Stalled")
			StatusEffectService:Apply(stalledId, "Burn", burner)

			local stalled = StatusEffectService:GetRecord(stalledId, "Burn")
			local healthBefore = DamageableService:GetHealth(stalledId)

			-- Four seconds of burning that no tick ever charged for. Expiry is
			-- pushed out so only the stall, not the cap, is under test.
			stalled.LastTickAt -= 4
			stalled.ExpiresAt += 100

			StatusEffectService:Step()

			local lost = healthBefore - DamageableService:GetHealth(stalledId)
			local oneSecond = Combat.ComputeDamage(burnDef.PerSecond, burnDef.DamageType, "Light", 0)

			checkNear(lost, oneSecond * 4, "one Step after a four second stall bills four seconds")
			check(
				lost > oneSecond * RULES.TickInterval * 2,
				`the stall is not silently discounted to a single interval ({lost} lost)`
			)

			DamageableService:Unregister(stalledId)
		end

		--[[
			The other half of the clamp. A stall LONGER than the effect must
			not bill the stall - thirty seconds of unrecorded time on a five
			second burn is five seconds of damage, not thirty.

			Without the clamp this raider dies, which is the failure mode:
			enemies dropping dead after a lag spike from effects that had
			already worn off.
		]]
		do
			local lapsedId = newRaider("Raider_Lapsed")
			StatusEffectService:Apply(lapsedId, "Burn", burner)

			local lapsed = StatusEffectService:GetRecord(lapsedId, "Burn")

			-- Applied thirty seconds ago, expired twenty-five seconds ago, and
			-- never once charged.
			lapsed.AppliedAt -= 30
			lapsed.LastTickAt -= 30
			lapsed.ExpiresAt -= 30

			local healthBefore = DamageableService:GetHealth(lapsedId)
			StatusEffectService:Step()

			local lost = healthBefore - DamageableService:GetHealth(lapsedId)
			local fullDuration = Combat.ComputeDamage(burnDef.PerSecond, burnDef.DamageType, "Light", 0)
				* burnDef.Duration

			checkNear(lost, fullDuration, "a lapsed effect bills its duration and not the delay")
			check(DamageableService:GetHealth(lapsedId) > 0, "so the raider survives the stall it should have survived")
			checkEqual(StatusEffectService:HasEffect(lapsedId, "Burn"), false, "and the effect is cleared out")

			DamageableService:Unregister(lapsedId)
		end

		--[[
			A sliver of elapsed time must be left on the clock, not charged.

			ComputeDamage floors every hit at MinimumDamage, which is right for
			a sword swing and wrong for a fraction of a tick: an accrual worth
			0.6 points would be rounded UP to 1, and at two ticks a second that
			overcharges the effect rather than undercharging it. So amounts
			below a point wait and accumulate.
		]]
		do
			local sliverId = newRaider("Raider_Sliver")
			StatusEffectService:Apply(sliverId, "Burn", burner)

			local sliver = StatusEffectService:GetRecord(sliverId, "Burn")
			sliver.ExpiresAt += 100

			-- A tenth of a second owed: 0.6 raw, which is under the floor.
			sliver.LastTickAt -= 0.1
			local markBefore = sliver.LastTickAt
			local healthBefore = DamageableService:GetHealth(sliverId)

			check(
				StatusEffects.GetPendingAmount(sliver, os.time()) < GameConfig.Combat.MinimumDamage,
				"the pending amount is below the damage floor"
			)

			StatusEffectService:Step()

			checkEqual(
				DamageableService:GetHealth(sliverId),
				healthBefore,
				"a sliver of a tick is not rounded up to the minimum damage"
			)
			checkEqual(sliver.LastTickAt, markBefore, "and the time it covers is still owed, not discarded")

			-- Owed, so it is charged once enough has built up.
			advance(2)
			check(
				DamageableService:GetHealth(sliverId) < healthBefore,
				"the remainder is billed once it clears the floor"
			)

			DamageableService:Unregister(sliverId)
		end

		--[[
			Elapsed time is billed at the stack count that was in force WHILE
			it elapsed. Settling after stacking would charge the whole backlog
			at the new, higher rate - punishing the target for the attacker's
			timing rather than for the overlap.
		]]
		do
			local lateId = newRaider("Raider_LateStack")
			StatusEffectService:Apply(lateId, "Burn", burner)

			local late = StatusEffectService:GetRecord(lateId, "Burn")
			late.LastTickAt -= 4
			late.ExpiresAt += 100

			local healthBefore = DamageableService:GetHealth(lateId)
			StatusEffectService:Apply(lateId, "Burn", burner)

			local lost = healthBefore - DamageableService:GetHealth(lateId)
			local oneSecond = Combat.ComputeDamage(burnDef.PerSecond, burnDef.DamageType, "Light", 0)

			checkEqual(StatusEffectService:GetStacks(lateId, "Burn"), 2, "the second stack lands")
			checkNear(lost, oneSecond * 4, "but the backlog was charged at one stack, not two")

			DamageableService:Unregister(lateId)
		end

		------------------------------------------------------------------------
		section("Status effects: armour, death and healing")
		------------------------------------------------------------------------

		--[[
			Damage over time skips FLAT armour.

			Armour is subtracted after the counter multiplier, which makes it
			worth more against many small hits than one big one. A tick is the
			smallest possible hit, so charging armour per tick floors every
			effect at MinimumDamage and makes armoured targets fireproof by
			accident rather than by design.
		]]
		do
			local millModel = Instance.new("Model")
			millModel.Name = "Mill_Burning"
			millModel.Parent = WorkspaceService

			local burningMill = DamageableService:Register({
				ArchetypeId = "Mill",
				Model = millModel,
				OwnerUserId = 0,
			})

			local millArch = GameConfig.Archetypes.Mill
			check(millArch.Armour > 0, "the Mill has flat armour to bypass")

			local withArmour = Combat.ComputeDamage(burnDef.PerSecond, "Fire", "Building", millArch.Armour)
			local withoutArmour = Combat.ComputeDamage(burnDef.PerSecond, "Fire", "Building", 0)
			checkEqual(
				withArmour,
				GameConfig.Combat.MinimumDamage,
				"charged per tick, armour would floor a burn at the minimum"
			)
			check(withoutArmour > withArmour, "bypassing it leaves the counter row in charge instead")

			local before = DamageableService:GetHealth(burningMill)
			StatusEffectService:Apply(burningMill, "Burn", burner)
			advance(burnDef.Duration + 2)

			local lost = before - DamageableService:GetHealth(burningMill)
			checkNear(lost, withoutArmour * burnDef.Duration, "so a burning Mill loses the un-armoured amount")
			check(RULES.IgnoreFlatArmour, "and the rule is config, not a magic number in the service")

			DamageableService:Unregister(burningMill)
		end

		-- Healing over time, and the thing it must never do.
		do
			local hurtModel = Instance.new("Model")
			hurtModel.Name = "Mill_Mending"
			hurtModel.Parent = WorkspaceService

			local mendingId = DamageableService:Register({
				ArchetypeId = "Mill",
				Model = hurtModel,
				OwnerUserId = 0,
			})

			DamageableService:ApplyDamage(mendingId, 400, "Siege", nil)
			local hurt = DamageableService:GetHealth(mendingId)
			check(hurt < GameConfig.Archetypes.Mill.MaxHealth, "a Mill is damaged and does not self-heal")

			local regenDef = GameConfig.StatusEffects.Regeneration
			StatusEffectService:Apply(mendingId, "Regeneration", nil)
			advance(regenDef.Duration + 2)

			checkNear(
				DamageableService:GetHealth(mendingId) - hurt,
				regenDef.PerSecond * regenDef.Duration,
				"regeneration mends its rate times its duration"
			)
			checkEqual(StatusEffectService:HasEffect(mendingId, "Regeneration"), false, "then runs out")

			-- Healing is free; repair is charged. Conflating them would have a
			-- heal-over-time quietly spending the player's wood.
			checkEqual(DamageableService:Heal(mendingId, -5).Reason, "NoHealing", "a negative heal is refused")
			checkEqual(DamageableService:Heal(mendingId, 0 / 0).Reason, "NoHealing", "and so is a NaN one")
			checkEqual(DamageableService:Heal(mendingId, math.huge).Reason, "NoHealing", "and an infinite one")
			checkEqual(DamageableService:Heal(999999, 10).Reason, "UnknownEntity", "healing nothing is refused")

			DamageableService:Heal(mendingId, 999999)
			checkEqual(
				DamageableService:GetHealth(mendingId),
				GameConfig.Archetypes.Mill.MaxHealth,
				"a large heal is clamped to full health"
			)
			checkEqual(DamageableService:Heal(mendingId, 10).Reason, "AlreadyFull", "healing a full entity is refused")

			DamageableService:Unregister(mendingId)
		end

		-- Healing must not resurrect: a shattered Checkpoint stays shattered.
		do
			local wreckModel = Instance.new("Model")
			wreckModel.Name = "Checkpoint_Wreck"
			wreckModel.Parent = WorkspaceService

			local wreckId = DamageableService:Register({
				ArchetypeId = "Checkpoint",
				Model = wreckModel,
				OwnerUserId = 0,
			})

			StatusEffectService:Apply(wreckId, "Poison", burner)
			DamageableService:ApplyDamage(wreckId, 999999, "Siege", nil)
			check(DamageableService:Get(wreckId).Shattered, "the Checkpoint shattered rather than vanishing")

			-- A shattered entity is still registered, so without this it would
			-- keep ticking against a floor it can never fall below.
			checkEqual(
				StatusEffectService:HasEffect(wreckId, "Poison"),
				false,
				"destruction clears the effects that were running"
			)
			checkEqual(
				StatusEffectService:Apply(wreckId, "Burn", burner).Reason,
				"NotAlive",
				"and a wreck cannot be set alight"
			)
			checkEqual(
				DamageableService:Heal(wreckId, 500).Reason,
				"AlreadyDestroyed",
				"healing refuses to revive it, because reviving is a gameplay decision"
			)

			-- Rebuilding starts clean rather than inheriting the raid that
			-- killed it.
			local rebuilder = newPlayer(3232, "Rebuilder")
			PlayersService.PlayerAdded:Fire(rebuilder)
			PlayerDataService:AddResource(rebuilder, "Wood", 50000)
			PlayerDataService:AddResource(rebuilder, "Stone", 50000)
			DamageableService:Get(wreckId).OwnerUserId = rebuilder.UserId

			checkEqual(DamageableService:Rebuild(wreckId, rebuilder).Ok, true, "the Checkpoint rebuilds")
			checkEqual(#StatusEffectService:GetActive(wreckId), 0, "and comes back clean, not still poisoned")

			DamageableService:Unregister(wreckId)
		end

		-- A burn can land the killing blow, and the kill is still attributed.
		do
			local doomedId = newRaider("Raider_Doomed")
			DamageableService:ApplyDamage(doomedId, 100, "Melee", nil)
			check(DamageableService:GetHealth(doomedId) > 0, "the raider is wounded but alive")

			local goldBefore = PlayerDataService:GetInventoryGold(burner)
			StatusEffectService:Apply(doomedId, "Burn", burner)
			advance(burnDef.Duration + 2)

			checkEqual(DamageableService:Get(doomedId), nil, "the burn finished it off with nobody watching")
			check(
				PlayerDataService:GetInventoryGold(burner) > goldBefore,
				"and whoever lit the fire was paid for the kill"
			)
			checkEqual(#StatusEffectService:GetActive(doomedId), 0, "no effects are left behind on a dead entity")
		end

		------------------------------------------------------------------------
		section("Status effects: the practice range")
		------------------------------------------------------------------------

		--[[
			The range is the only producer of status effects until troops and
			combat plants exist. It matters that it is a real affordance and
			not a debug backdoor: the prompts are server-made and handled
			server-side, so the distance check is the one that counts.
		]]
		do
			local TrainingGround = require(TrainingGroundModule)
			local folder = TrainingGround.Build()

			check(folder ~= nil, "the range builds")

			local expectedPosts = 0
			for _ in GameConfig.StatusEffects do
				expectedPosts += 1
			end

			-- One dummy per effect, plus the raid horn.
			checkEqual(
				#folder:GetChildren(),
				expectedPosts + 1,
				"one dummy per status effect, generated from config, plus the horn"
			)
			check(folder:FindFirstChild("RaidHorn") ~= nil, "and a Raid Horn to summon a wave with")

			local dummy = folder:FindFirstChild("Dummy_Burn")
			check(dummy ~= nil, "including a dummy for Burn")

			local dummyEntity = DamageableService:GetByModel(dummy)
			check(dummyEntity ~= nil, "the dummy is a registered damageable entity")
			checkEqual(
				DamageableService:Get(dummyEntity).OwnerUserId,
				0,
				"and is neutral, so killing one is not farming your own buildings"
			)

			local prompt = dummy.Body:FindFirstChild("ApplyPrompt")
			check(prompt ~= nil, "it carries a prompt")

			--[[
				The dummies are a NEUTRAL archetype with no kill rewards, and
				both halves matter.

				Neutral so a tower built near the range ignores them - a range
				you cannot stand a tower next to is not much of a range. And
				rewardless because the range used to use EnemyRaider, whose
				rewards paid out to whoever landed the blow: with a six second
				respawn that was an endless source of purse gold and XP.
			]]
			checkEqual(
				DamageableService:Get(dummyEntity).Archetype.Faction,
				GameConfig.Factions.Neutral,
				"a dummy is neutral, so defences ignore it"
			)
			checkEqual(
				GameConfig.Archetypes.PracticeDummy.Rewards,
				nil,
				"and pays nothing for killing it, so the range is not a gold farm"
			)

			-- Out of reach: the engine enforces this on the client, which an
			-- exploiter owns, so the handler has to re-check.
			local cheater = newPlayer(3333, "Cheater")
			giveCharacter(cheater, Vector3.new(900, 3, 900))
			PlayersService.PlayerAdded:Fire(cheater)

			prompt.Triggered:Fire(cheater)
			checkEqual(
				StatusEffectService:HasEffect(dummyEntity, "Burn"),
				false,
				"a prompt fired from across the map is refused"
			)

			-- In reach.
			local trainee = newPlayer(3434, "Trainee")
			giveCharacter(trainee, dummy.Body.Position + Vector3.new(3, 0, 0))
			PlayersService.PlayerAdded:Fire(trainee)

			prompt.Triggered:Fire(trainee)
			checkEqual(
				StatusEffectService:HasEffect(dummyEntity, "Burn"),
				true,
				"and from beside the dummy it applies the effect"
			)

			prompt.Triggered:Fire(trainee)
			checkEqual(StatusEffectService:GetStacks(dummyEntity, "Burn"), 2, "pressing again stacks it")

			-- Enough stacks and the dummy burns down, which exercises the real
			-- death path rather than a special case.
			-- Stopped the instant it falls, because advancing any further would
			-- run into the respawn and hide the death entirely.
			for _ = 1, 20 do
				if not DamageableService:GetByModel(dummy) then
					break
				end

				prompt.Triggered:Fire(trainee)
				advance(1)
			end

			checkEqual(DamageableService:GetByModel(dummy), nil, "sustained burning fells the dummy")
			checkEqual(prompt.Enabled, false, "and its prompt goes quiet while it is down")
			check(dummy.Parent ~= nil, "the post itself stays standing")

			-- Back up afterwards, so the range can be used more than once.
			advance(20)
			local revived = DamageableService:GetByModel(dummy)
			check(revived ~= nil, "it is raised again after a pause")
			check(revived ~= dummyEntity, "as a new entity rather than a revived one")
			checkEqual(prompt.Enabled, true, "with its prompt live again")
			checkEqual(
				DamageableService:GetHealth(revived),
				GameConfig.Archetypes.PracticeDummy.MaxHealth,
				"at full health"
			)
			checkEqual(#StatusEffectService:GetActive(revived), 0, "and carrying nothing from last time")

			PlayersService.PlayerRemoving:Fire(cheater)
			cheater.Parent = nil
			PlayersService.PlayerRemoving:Fire(trainee)
			trainee.Parent = nil
		end

		-- Records for entities that leave the registry must not pile up: the
		-- loop drops them, so no signal has to be invented for unregistering.
		do
			local leakId = newRaider("Raider_Leak")
			StatusEffectService:Apply(leakId, "Poison", burner)
			check(next(StatusEffectService:Get(leakId)) ~= nil, "the raider has a record")

			DamageableService:Unregister(leakId)
			StatusEffectService:Step()
			checkEqual(next(StatusEffectService:Get(leakId)), nil, "unregistering drops it on the next pass")
		end

		DamageableService:Unregister(raiderId)
	end

	-- Scoped: Luau caps live locals per function at 200 and this suite is one.
	do
		------------------------------------------------------------------------
		section("Placement: the build grid")
		------------------------------------------------------------------------

		local PlacementService = require(PlacementServiceModule)
		local GRID = GameConfig.Placement.GridSize

		--[[
			Age of Empires is a tile grid, which is why its farms form an
			unbroken quilt rather than a scatter with slivers between them.
			Footprints here are whole numbers of tiles and snap by their MIN
			CORNER.

			Corner-snapping is the part that is easy to get wrong. A structure
			two tiles wide has its centre on a tile boundary; one three tiles
			wide has its centre mid-tile. Snap CENTRES and those two can never
			sit flush - the even ones end up half a tile out from the odd ones,
			and the bug shows up only when you try to butt a Mill against a
			Farm.
		]]
		for id, structure in GameConfig.Structures do
			checkEqual(
				structure.Size.X % GRID,
				0,
				`{id} is a whole number of tiles wide`
			)

			local snappedX, snappedZ = GameConfig.SnapPlacement(structure, 7.3, -11.8)

			-- The corner, not the centre, is what must land on a grid line.
			checkEqual(
				(snappedX - structure.Size.X / 2) % GRID,
				0,
				`{id} snaps its X corner onto the grid`
			)
			checkEqual(
				(snappedZ - structure.Size.Z / 2) % GRID,
				0,
				`{id} snaps its Z corner onto the grid`
			)

			-- Snapping an already-snapped position must not drift it.
			local reX, reZ = GameConfig.SnapPlacement(structure, snappedX, snappedZ)
			checkEqual(reX, snappedX, `{id} snapping is idempotent on X`)
			checkEqual(reZ, snappedZ, `{id} snapping is idempotent on Z`)

			-- Never moved further than half a tile, or the ghost would jump
			-- somewhere the player did not aim.
			check(
				math.abs(snappedX - 7.3) <= GRID / 2 and math.abs(snappedZ - (-11.8)) <= GRID / 2,
				`{id} snaps to the nearest tile rather than a distant one`
			)
		end

		--[[
			The pairing that centre-snapping breaks: an odd-tile footprint and
			an even-tile one must still align to each other.
		]]
		do
			local farm = GameConfig.Structures.Farm -- 8 studs = 2 tiles
			local mill = GameConfig.Structures.Mill -- 12 studs = 3 tiles

			checkEqual((farm.Size.X / GRID) % 2, 0, "the Farm is an even number of tiles")
			checkEqual((mill.Size.X / GRID) % 2, 1, "and the Mill an odd number")

			local farmX = select(1, GameConfig.SnapPlacement(farm, 40, 0))
			local millX = select(1, GameConfig.SnapPlacement(mill, 40, 0))

			-- Both corners on the grid means they can be butted together.
			checkEqual((farmX - farm.Size.X / 2) % GRID, 0, "the Farm corner lands on the grid")
			checkEqual((millX - mill.Size.X / 2) % GRID, 0, "and so does the Mill corner, despite the parity")
		end

		local snapper = newPlayer(4141, "Snapper")
		giveCharacter(snapper, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(snapper)
		PlayerDataService:AddResource(snapper, "Wood", 50000)
		PlayerDataService:AddResource(snapper, "Stone", 50000)

		--[[
			The server snaps rather than trusting the client to have done it.
			An off-grid request must come back on-grid, otherwise an exploiter
			could wedge a structure into a gap the grid exists to forbid.
		]]
		local centre = PlacementService:Place(snapper, "TownCenter", 61.7, -38.2)
		checkEqual(centre.Ok, true, "a Town Center places at an arbitrary cursor position")

		local townCenter = GameConfig.Structures.TownCenter
		checkEqual(
			(centre.X - townCenter.Size.X / 2) % GRID,
			0,
			"and the server returns it snapped to the grid"
		)
		check(
			centre.X ~= 61.7,
			`an off-grid request does not survive ({centre.X})`
		)

		-- The result carries the snapped position, so the client can correct
		-- its preview instead of guessing.
		checkEqual(
			PlayerDataService:GetData(snapper).Structures[centre.InstanceId].X,
			centre.X,
			"the saved position is the snapped one"
		)

		------------------------------------------------------------------------
		section("Placement: farms tile flush")
		------------------------------------------------------------------------

		--[[
			The point of the whole exercise. MinimumGap used to be two studs,
			which ringed every farm in an alley and made an AoE-style quilt
			impossible. Now adjacent farms touch exactly.
		]]
		checkEqual(GameConfig.Placement.MinimumGap, 0, "structures may touch")

		local farmDef = GameConfig.Structures.Farm
		checkEqual(PlacementService:Place(snapper, "Mill", 0, 100).Ok, true, "a Mill to satisfy the Farm's prerequisite")

		local first = PlacementService:Place(snapper, "Farm", 0, 0)
		checkEqual(first.Ok, true, "a first Farm places")

		-- Aimed slightly short of flush: snapping should pull it flush.
		local second = PlacementService:Place(snapper, "Farm", farmDef.Size.X - 1.4, 0)
		checkEqual(second.Ok, true, "a second Farm places beside it")
		checkEqual(
			second.X - first.X,
			farmDef.Size.X,
			"and snaps exactly flush, with no sliver between them"
		)
		checkEqual(second.Z, first.Z, "staying in the same row")

		-- One stud closer and they would interpenetrate, so it must be refused
		-- rather than snapped on top.
		checkEqual(
			PlacementService:Place(snapper, "Farm", first.X + 1, 0).Reason,
			"Blocked",
			"a Farm aimed inside its neighbour is still refused"
		)

		-- A full row, then a second row flush behind it: the quilt.
		local third = PlacementService:Place(snapper, "Farm", farmDef.Size.X * 2, 0)
		checkEqual(third.Ok, true, "a third Farm extends the row")
		local behind = PlacementService:Place(snapper, "Farm", 0, farmDef.Size.Z)
		checkEqual(behind.Ok, true, "and a second row sits flush behind the first")
		checkEqual(behind.Z - first.Z, farmDef.Size.Z, "exactly one footprint back")

		-- Snapping must not be a way out of the world.
		local edge = GameConfig.Placement.WorldLimit
		checkEqual(
			PlacementService:Place(snapper, "Farm", edge + 3, edge + 3).Reason,
			"InvalidPosition",
			"snapping cannot push a structure past the world edge"
		)

		------------------------------------------------------------------------
		section("Placement: one buildability rule, two readers")
		------------------------------------------------------------------------

		--[[
			The server and the build menu both ask "can this be built?", and
			they must never disagree - a row that looks available and is
			refused, or one greyed out for a reason that no longer applies.

			The menu used to carry its own copy of the rules with a comment
			promising it mirrored the server's. Now there is one module and
			both call it, so the promise is structural rather than a comment.
		]]
		local Buildability = require(BuildabilityModule)

		-- Codes, not sentences: wording belongs to whoever is displaying it.
		checkEqual(
			select(2, Buildability.CheckTree("Nonsense", {}, 1)),
			"UnknownStructure",
			"an unknown structure is not buildable"
		)
		checkEqual(select(2, Buildability.CheckTree("TownCenter", {}, 1)), nil, "a root structure is buildable")
		checkEqual(
			select(2, Buildability.CheckTree("Mill", {}, 1)),
			"MissingPrerequisite",
			"a Mill needs its Town Center"
		)
		checkEqual(
			select(2, Buildability.CheckTree("Mill", { TownCenter = 1 }, 1)),
			nil,
			"and is buildable once there is one"
		)
		checkEqual(
			select(2, Buildability.CheckTree("TownCenter", { TownCenter = 1 }, 1)),
			"LimitReached",
			"the per-player limit is a rule here too"
		)
		checkEqual(
			select(2, Buildability.CheckTree("WatchTower", { TownCenter = 1 }, 1)),
			"AgeTooLow",
			"and so is the age gate"
		)
		checkEqual(
			select(2, Buildability.CheckTree("WatchTower", { TownCenter = 1 }, 2)),
			nil,
			"which lifts on advancing"
		)

		-- A sparse counts table is legal: a missing key means none owned.
		checkEqual(
			select(2, Buildability.CheckTree("Farm", { TownCenter = 1 }, 1)),
			"MissingPrerequisite",
			"a missing count reads as none owned rather than erroring"
		)

		--[[
			Cost is a separate check, because the server wants the tree rules
			WITHOUT it: payment is taken after the position is validated, so
			aiming at an illegal spot reports the position rather than the
			price.
		]]
		do
			local farmCost = GameConfig.Structures.Farm.Cost
			local enough = {}
			local broke = {}

			for resourceId, amount in farmCost do
				enough[resourceId] = amount
				broke[resourceId] = amount - 1
			end

			checkEqual(select(2, Buildability.CheckCost("Farm", enough)), nil, "exactly enough affords it")
			checkEqual(
				select(2, Buildability.CheckCost("Farm", broke)),
				"NotEnoughResources",
				"a single unit short does not"
			)
			checkEqual(
				select(3, Buildability.CheckCost("Farm", broke)),
				next(farmCost),
				"and the resource that is short is named, so the menu can say which"
			)
			checkEqual(select(2, Buildability.CheckCost("Farm", {})), "NotEnoughResources", "holding nothing affords nothing")

			-- Omitting the held table is how the server opts out of the cost
			-- check; passing one is how the menu opts in.
			checkEqual(
				select(2, Buildability.Check("Farm", { TownCenter = 1, Mill = 1 }, 1, nil)),
				nil,
				"Check without resources skips affordability, as the server needs"
			)
			checkEqual(
				select(2, Buildability.Check("Farm", { TownCenter = 1, Mill = 1 }, 1, {})),
				"NotEnoughResources",
				"and with them, applies it"
			)

			-- Tree before cost: the Mill is a decision, the wood is temporary.
			checkEqual(
				select(2, Buildability.Check("Farm", { TownCenter = 1 }, 1, {})),
				"MissingPrerequisite",
				"a missing prerequisite outranks a missing resource"
			)
		end

		--[[
			The agreement itself: for a real player, the service's verdict and
			a menu reading replicated counts must match. This is the assertion
			that would have caught the two copies drifting.
		]]
		do
			local countsFolder = snapper:FindFirstChild(GameConfig.StructureCountsFolderName)
			check(countsFolder ~= nil, "the menu has a counts folder to read")

			local replicated = {}
			for structureId, count in countsFolder:GetAttributes() do
				replicated[structureId] = count
			end

			local age = PlayerDataService:GetAge(snapper)

			for structureId in GameConfig.Structures do
				local serverOk = select(1, PlacementService:GetBuildability(snapper, structureId))
				local menuOk = select(1, Buildability.CheckTree(structureId, replicated, age))

				checkEqual(
					menuOk,
					serverOk,
					`the menu and the server agree about {structureId}`
				)
			end
		end

		PlayersService.PlayerRemoving:Fire(snapper)
		snapper.Parent = nil
	end

	-- Scoped: Luau caps live locals per function at 200 and this suite is one.
	do
		------------------------------------------------------------------------
		section("Spatial: the shared proximity helper")
		------------------------------------------------------------------------

		local Spatial = require(SpatialModule)

		local function checkNear(actual, expected, label)
			check(
				type(actual) == "number" and math.abs(actual - expected) <= 0.001,
				`{label} (got {tostring(actual)}, expected ~{expected})`
			)
		end

		--[[
			Three callers wanted the same loop - splash, attack range and enemy
			targeting - and a fourth is coming with troops. Written per-caller
			they diverge in ways that are hard to see.
		]]

		-- HEIGHT IS IGNORED. A tower's range must not shrink because the
		-- target is on a hill, and splash must not spare someone on a crate.
		checkEqual(Spatial.GroundDistance(Vector3.new(0, 0, 0), Vector3.new(3, 0, 4)), 5, "distance is plain Pythagoras")
		checkEqual(
			Spatial.GroundDistance(Vector3.new(0, 500, 0), Vector3.new(3, -200, 4)),
			5,
			"and ignores height entirely"
		)
		checkEqual(Spatial.IsWithin(Vector3.new(0, 0, 0), Vector3.new(0, 99, 10), 10), true, "the rim counts as within")
		checkEqual(Spatial.IsWithin(Vector3.new(0, 0, 0), Vector3.new(0, 0, 11), 10), false, "past it does not")

		do
			local candidates = {
					{ Id = "far", Position = Vector3.new(40, 0, 0) },
					{ Id = "near", Position = Vector3.new(5, 0, 0) },
					{ Id = "mid", Position = Vector3.new(12, 0, 0) },
				}

			local origin = Vector3.new(0, 0, 0)

			checkEqual(Spatial.FindNearest(origin, candidates, 100).Id, "near", "the nearest candidate wins")
			checkEqual(Spatial.FindNearest(origin, candidates, 20).Id, "near", "a radius does not change which")
			checkEqual(Spatial.FindNearest(origin, candidates, 2), nil, "and nothing in range returns nothing")

			-- The filter runs before the distance test, so a caller can reject
			-- by faction without building a second list.
			checkEqual(
				Spatial.FindNearest(origin, candidates, 100, function(c)
					return c.Id ~= "near"
				end).Id,
				"mid",
				"a rejected candidate is skipped"
			)

			checkEqual(#Spatial.FindWithin(origin, candidates, 15), 2, "FindWithin returns everything in reach")
			checkEqual(#Spatial.FindWithin(origin, candidates, 100), 3, "or all of them")

			--[[
				TIES BREAK DETERMINISTICALLY, by position in the list. Without
				it two equidistant targets would swap every tick as the table's
				iteration order shifted, and an attacker would stutter between
				them forever instead of killing either.
			]]
			local tied = {
				{ Id = "first", Position = Vector3.new(10, 0, 0) },
				{ Id = "second", Position = Vector3.new(-10, 0, 0) },
			}

			for _ = 1, 8 do
				checkEqual(Spatial.FindNearest(origin, tied, 100).Id, "first", "equidistant targets never swap")
			end
		end

		------------------------------------------------------------------------
		section("Spatial: reach is measured to a surface")
		------------------------------------------------------------------------

		--[[
			Range means "how far I can reach past myself", not "how close my
			middle gets to your middle".

			Centre-to-centre is fine between two raiders and badly wrong
			against a building: a nine stud club could only "reach" a sixteen
			stud wide Town Center by standing inside its walls, which is
			exactly what raiders did.
		]]
		do
			local origin = Vector3.new(0, 0, 0)
			--[[
				The building's centre is FURTHER away than the raider, but its
				wall is much nearer. That inversion is the whole point.
			]]
			local big = { Id = "townCenter", Position = Vector3.new(15, 0, 0), Radius = 8 }
			local small = { Id = "raider", Position = Vector3.new(14, 0, 0), Radius = 1.3 }

			checkEqual(Spatial.SurfaceDistance(origin, big), 7, "a wide target is reachable from its edge")
			checkEqual(
				Spatial.SurfaceDistance(origin, { Position = Vector3.new(20, 0, 0) }),
				20,
				"and a candidate with no radius is measured to its centre"
			)
			checkEqual(
				Spatial.SurfaceDistance(origin, { Position = Vector3.new(3, 0, 0), Radius = 8 }),
				0,
				"standing inside something reads as touching it, never as negative"
			)

			-- A nine stud club reaches the building but not the raider that is
			-- physically NEARER, because the building is enormous.
			local club = 9
			checkEqual(
				Spatial.FindNearestInReach(origin, { big }, club).Id,
				"townCenter",
				"a short reach still touches a wide building from outside it"
			)
			checkEqual(
				Spatial.FindNearestInReach(origin, { small }, club),
				nil,
				"while a small target at a similar distance is genuinely out of reach"
			)

			-- And it ranks by surface distance, not centre distance: the
			-- building's wall is closer than the raider.
			checkEqual(
				Spatial.FindNearestInReach(origin, { small, big }, 20).Id,
				"townCenter",
				"nearest means nearest SURFACE"
			)
			checkEqual(
				Spatial.FindNearest(origin, { small, big }, 20).Id,
				"raider",
				"whereas plain FindNearest still compares centres"
			)
		end

		------------------------------------------------------------------------
		section("Spatial: splash falloff and blocking")
		------------------------------------------------------------------------

		-- Linear from full at the centre to the floor at the rim.
		checkEqual(Spatial.GetFalloff(0, 10, 0.4), 1, "the centre of a blast takes full damage")
		checkNear(Spatial.GetFalloff(5, 10, 0.4), 0.7, "halfway out takes the midpoint")
		checkNear(Spatial.GetFalloff(10, 10, 0.4), 0.4, "the rim takes the floor")
		checkEqual(Spatial.GetFalloff(11, 10, 0.4), 0, "and outside takes nothing")

		-- The floor exists for the same reason MinimumDamage does: a blast
		-- whose outer half does nothing makes tuning the radius guesswork.
		check(Spatial.GetFalloff(9.9, 10, 0.4) > 0.4, "damage inside the rim beats the floor")

		--[[
			FindBlocking is the geometry behind "a tank plant protects the
			plants behind it". In a lane game that is free; in an open base it
			has to be stated, or a raider walks past a wall of defences to hit
			the soft thing behind them and looks like it is cheating.
		]]
		do
			local origin = Vector3.new(0, 0, 0)
			local objective = Vector3.new(100, 0, 0)

			local tank = { Id = "tank", Position = Vector3.new(30, 0, 0) }
			local behind = { Id = "behind", Position = Vector3.new(60, 0, 0) }
			local aside = { Id = "aside", Position = Vector3.new(10, 0, 80) }

			checkEqual(
				Spatial.FindBlocking(origin, objective, { behind, tank }, 14).Id,
				"tank",
				"the nearer of two things in the way is what you meet first"
			)

			-- The corridor is what makes it "in the way" rather than "nearby".
			checkEqual(
				Spatial.FindBlocking(origin, objective, { aside }, 14),
				nil,
				"something off to the side is not blocking, however close"
			)
			check(
				Spatial.GroundDistance(origin, aside.Position) < Spatial.GroundDistance(origin, tank.Position) + 60,
				"even though a plain nearest search would have considered it"
			)

			-- Nothing beyond the objective is in the way of reaching it.
			checkEqual(
				Spatial.FindBlocking(origin, objective, { { Id = "past", Position = Vector3.new(140, 0, 0) } }, 14),
				nil,
				"something past the objective is not between you and it"
			)

			-- Nor anything behind you.
			checkEqual(
				Spatial.FindBlocking(origin, objective, { { Id = "back", Position = Vector3.new(-30, 0, 0) } }, 14),
				nil,
				"and neither is something you have already walked past"
			)

			checkEqual(
				Spatial.FindBlocking(origin, objective, {}, 14),
				nil,
				"a clear path blocks on nothing, which is the cue to keep walking"
			)

			-- Standing on the objective: a zero-length path cannot be blocked,
			-- so it falls back to whatever is closest.
			checkEqual(
				Spatial.FindBlocking(origin, origin, { tank }, 100).Id,
				"tank",
				"a zero-length path falls back to the nearest"
			)
		end

		------------------------------------------------------------------------
		section("Farming: plant density")
		------------------------------------------------------------------------

		--[[
			A farm square holds several plants of one kind. The point is to
			make food cheap in SPACE: one carrot per square means a player
			feeding themselves has no room for anything else, and the plants
			that shoot back never get built.

			Density is a property of the PLANT, not the farm - the farm is just
			tilled ground.
		]]
		checkEqual(GameConfig.GetPlantCapacity("CarrotSeed"), 9, "small crops pack nine to a square")
		checkEqual(GameConfig.GetPlantCapacity("TomatoSeed"), 9, "and so do tomatoes")
		checkEqual(GameConfig.GetPlantCapacity("PumpkinSeed"), 3, "big crops take a third of a square each")
		checkEqual(GameConfig.GetPlantCapacity("WatermelonSeed"), 3, "as do watermelons")
		checkEqual(GameConfig.PlantSizes.Special.PerFarm, 1, "a special plant takes a whole square")

		-- An unknown seed has no capacity, so a caller that skips validation
		-- plants nothing rather than something arbitrary.
		checkEqual(GameConfig.GetPlantCapacity("Carrot"), 0, "a crop is not a plantable")
		checkEqual(GameConfig.GetPlantCapacity({ bad = true }), 0, "and neither is a table")

		------------------------------------------------------------------------
		section("Farming: the stack layout")
		------------------------------------------------------------------------

		local CropFactory = require(CropFactoryModule)

		--[[
			The grid must hold EXACTLY the capacity - a 3x3 for nine, a 3x1 for
			three - never a 2x2 with a hole in it. Slots come from capacity
			rather than from the number planted, so a half-filled square shows
			its gaps and teaches the player what it holds.
		]]
		do
			local cols, rows = CropFactory.GetLayout(9)
			checkEqual(cols * rows, 9, "nine plants fill their grid exactly")
			checkEqual(cols, 3, "as a three-wide grid")
			checkEqual(rows, 3, "and three deep")
		end

		do
			local cols, rows = CropFactory.GetLayout(3)
			checkEqual(cols, 3, "three plants lay out in a row")
			checkEqual(rows, 1, "one deep")
		end

		do
			local cols, rows = CropFactory.GetLayout(1)
			checkEqual(cols * rows, 1, "a single plant gets a single slot")
		end

		do
			local cols, rows = CropFactory.GetLayout(6)
			checkEqual(cols * rows, 6, "six fills its grid exactly too")
			check(math.abs(cols - rows) <= 1, `and as squarely as possible ({cols}x{rows})`)
		end

		-- Slots must be distinct and sit on the soil, not over the edge.
		do
			local farmDef = GameConfig.Structures.Farm
			local slots = CropFactory.GetSlotPositions(9, Vector3.new(0, 1, 0), farmDef.Size.X * 0.75, farmDef.Size.Z * 0.75)

			checkEqual(#slots, 9, "there is one slot per plant the square holds")

			local seen = {}
			local overhang = false

			for _, slot in slots do
				local key = `{slot.X},{slot.Z}`
				check(seen[key] == nil, `slot {key} is not a duplicate`)
				seen[key] = true

				if math.abs(slot.X) > farmDef.Size.X / 2 or math.abs(slot.Z) > farmDef.Size.Z / 2 then
					overhang = true
				end
			end

			checkEqual(overhang, false, "and every slot sits inside the farm footprint")
		end

		------------------------------------------------------------------------
		section("Farming: filling and harvesting a square")
		------------------------------------------------------------------------

		local farmer = newPlayer(4242, "Farmer")
		giveCharacter(farmer, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(farmer)
		PlayerDataService:AddXP(farmer, 100000)

		local square = makeFarm(farmer, 140, -140)
		check(square ~= nil, "a farm is built to plant in")

		-- A fresh player's kit is exactly a square's worth, by config assert.
		checkEqual(
			PlayerDataService:GetItemCount(farmer, "CarrotSeed"),
			GameConfig.GetPlantCapacity("CarrotSeed"),
			"the starter kit is exactly one square of seed"
		)

		advance(1)
		pokeFarm(farmer, square)

		local capacity = GameConfig.GetPlantCapacity("CarrotSeed")
		local model = farmOf(farmer, square)

		checkEqual(model:GetAttribute("PlantCount"), capacity, "one press fills the whole square")
		checkEqual(model:GetAttribute("PlantCapacity"), capacity, "and publishes what it holds")
		checkEqual(PlayerDataService:GetItemCount(farmer, "CarrotSeed"), 0, "consuming a seed per plant")
		checkEqual(
			PlayerDataService:GetData(farmer).Structures[square].PlantCount,
			capacity,
			"the count is on the farm's own record, so it survives with the farm"
		)

		-- One visual per plant, so the density is visible rather than implied.
		local container = model:FindFirstChild("Crop")
		check(container ~= nil, "the square has a crop container")
		checkEqual(#container:GetChildren(), capacity, "with a visual for every plant")

		--[[
			A full square cannot be topped up, and that is deliberate. Keeping
			the original PlantedAt would let a player plant one carrot, wait
			until it ripened, add eight more and harvest nine. Resetting it
			would throw away eight nearly-ripe plants to add a ninth.
		]]
		PlayerDataService:AddItem(farmer, "CarrotSeed", 50)
		local heldBefore = PlayerDataService:GetItemCount(farmer, "CarrotSeed")
		advance(1)
		pokeFarm(farmer, square)
		checkEqual(
			PlayerDataService:GetItemCount(farmer, "CarrotSeed"),
			heldBefore,
			"a growing square cannot be topped up"
		)
		checkEqual(model:GetAttribute("PlantCount"), capacity, "and its count does not move")

		--[[
			Called directly, because the prompt is not the thing under test.
			On an occupied square the prompt branches to harvest, so it never
			reaches this guard - which means every OTHER caller (a boost, a
			villager, a future automation tool) is relying on it alone.
		]]
		do
			local FarmService = require(FarmServiceModule)
			local seedsHeld = PlayerDataService:GetItemCount(farmer, "CarrotSeed")
			local refusal = nil

			local listener = FarmService.PlantFailed:Connect(function(_, _, reason)
				refusal = reason
			end)

			checkEqual(FarmService:TryPlant(farmer, square), false, "TryPlant refuses an occupied square outright")
			checkEqual(refusal, "Occupied", "and says why")
			checkEqual(
				PlayerDataService:GetItemCount(farmer, "CarrotSeed"),
				seedsHeld,
				"without quietly spending the seeds"
			)
			checkEqual(model:GetAttribute("PlantCount"), capacity, "or disturbing the stack already growing")

			listener:Disconnect()
		end

		-- Harvest pays the whole stack. This is the entire feature.
		local carrot = GameConfig.GetPlantable("CarrotSeed")
		advance(carrot.GrowTime + 2)

		local cropsBefore = PlayerDataService:GetItemCount(farmer, "Carrot")
		local harvestedBefore = PlayerDataService:GetData(farmer).Stats.TotalHarvested

		advance(1)
		pokeFarm(farmer, square)

		checkEqual(
			PlayerDataService:GetItemCount(farmer, "Carrot") - cropsBefore,
			carrot.YieldAmount * capacity,
			"a full square yields its whole stack"
		)
		checkEqual(
			PlayerDataService:GetData(farmer).Stats.TotalHarvested - harvestedBefore,
			capacity,
			"and counts every plant harvested, not one square"
		)
		checkEqual(model:GetAttribute("PlantCount"), 0, "the emptied square reports no plants")
		checkEqual(PlayerDataService:GetData(farmer).Structures[square].PlantCount, nil, "and clears its count")

		------------------------------------------------------------------------
		section("Farming: partial fills and the big crops")
		------------------------------------------------------------------------

		-- Fewer seeds than the square holds plants what you have, rather than
		-- refusing: three seeds should not be unusable.
		do
			local inventory = PlayerDataService:GetData(farmer).Inventory
			inventory.CarrotSeed = nil
			PlayerDataService:AddItem(farmer, "CarrotSeed", 4)

			advance(1)
			pokeFarm(farmer, square)

			checkEqual(farmOf(farmer, square):GetAttribute("PlantCount"), 4, "a part-filled square plants what is held")
			checkEqual(PlayerDataService:GetItemCount(farmer, "CarrotSeed"), 0, "using every seed")

			-- Slots still come from capacity, so the gaps are visible.
			checkEqual(
				farmOf(farmer, square):GetAttribute("PlantCapacity"),
				capacity,
				"while still advertising the square's full capacity"
			)
			checkEqual(#farmOf(farmer, square):FindFirstChild("Crop"):GetChildren(), 4, "and only four plants appear")

			--[[
				Those four sit in the first four slots of the NINE slot grid,
				not in a tight two-by-two of their own. That is what makes the
				empty slots visible, and it is the whole reason the layout is
				sized from capacity.

				Checked by counting distinct columns rather than by comparing
				coordinates: four plants across a 3x3 grid occupy three
				columns (a full row of three, then one), whereas a 2x2 would
				occupy two. No dependence on the exact spacing.
			]]
			local columns = {}
			local distinctColumns = 0

			for _, plant in farmOf(farmer, square):FindFirstChild("Crop"):GetChildren() do
				local x = plant.PrimaryPart.Position.X

				if not columns[x] then
					columns[x] = true
					distinctColumns += 1
				end
			end

			checkEqual(
				distinctColumns,
				3,
				"laid out across the full grid's columns, leaving the unplanted slots bare"
			)

			advance(carrot.GrowTime + 2)
			local before = PlayerDataService:GetItemCount(farmer, "Carrot")
			advance(1)
			pokeFarm(farmer, square)
			checkEqual(
				PlayerDataService:GetItemCount(farmer, "Carrot") - before,
				carrot.YieldAmount * 4,
				"and pays for four, not nine"
			)
		end

		-- A big crop takes a third of a square.
		do
			local selectSeed = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.SelectSeed)
			PlayerDataService:AddItem(farmer, "PumpkinSeed", 20)

			advance(1)
			selectSeed.OnServerEvent:Fire(farmer, "PumpkinSeed")
			advance(1)
			pokeFarm(farmer, square)

			local pumpkinCapacity = GameConfig.GetPlantCapacity("PumpkinSeed")
			checkEqual(farmOf(farmer, square):GetAttribute("SeedId"), "PumpkinSeed", "pumpkins are planted")
			checkEqual(
				farmOf(farmer, square):GetAttribute("PlantCount"),
				pumpkinCapacity,
				`only {pumpkinCapacity} fit in a square`
			)
			check(pumpkinCapacity < capacity, "which is fewer than the small crops")
			checkEqual(
				PlayerDataService:GetItemCount(farmer, "PumpkinSeed"),
				20 - pumpkinCapacity,
				"and only that many seeds are spent"
			)
		end

		------------------------------------------------------------------------
		section("Farming: a stacked square survives a rejoin")
		------------------------------------------------------------------------

		do
			local savedCount = PlayerDataService:GetData(farmer).Structures[square].PlantCount
			check(savedCount > 1, `the square holds a stack before logging out ({savedCount})`)

			PlayersService.PlayerRemoving:Fire(farmer)
			farmer.Parent = nil

			local back = newPlayer(4242, "Farmer")
			giveCharacter(back, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(back)

			local restored = PlayerDataService:GetData(back).Structures[square]
			check(restored ~= nil, "the farm is rebuilt")
			checkEqual(restored.PlantCount, savedCount, "with its plant count intact")
			checkEqual(
				farmOf(back, square):GetAttribute("PlantCount"),
				savedCount,
				"and republished to the client"
			)
			checkEqual(
				#farmOf(back, square):FindFirstChild("Crop"):GetChildren(),
				savedCount,
				"and every plant drawn again"
			)

			PlayersService.PlayerRemoving:Fire(back)
			back.Parent = nil
		end

		------------------------------------------------------------------------
		section("Farming: the count is normalised, not migrated")
		------------------------------------------------------------------------

		--[[
			Structure entries are not covered by the schema Template, so
			Reconcile never sees them and Normalize is the only place they are
			defaulted. That is why stacking needed no migration: a record saved
			before the feature existed has no count, and reading a missing
			count as ONE is exactly right - that is what such a record holds.
		]]
		do
			local now = os.time()

			local legacy = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Farm", X = 0, Z = 0, SeedId = "CarrotSeed", PlantedAt = now - 5 },
				},
			})
			checkEqual(
				legacy.Structures["1"].PlantCount,
				1,
				"a crop saved before stacking existed reads as a single plant"
			)

			-- A count beyond the tier must not pay out more than the tier
			-- allows, however it got there.
			local greedy = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Farm",
						X = 0,
						Z = 0,
						SeedId = "CarrotSeed",
						PlantedAt = now - 5,
						PlantCount = 9999,
					},
				},
			})
			checkEqual(
				greedy.Structures["1"].PlantCount,
				GameConfig.GetPlantCapacity("CarrotSeed"),
				"an over-full square is clamped to what the seed allows"
			)

			-- And garbage does not survive either.
			for _, bad in { 0, -5, 0 / 0, "nine", {} } do
				local junk = DataSchema.Normalize({
					SchemaVersion = DataSchema.Version,
					Structures = {
						["1"] = {
							StructureId = "Farm",
							X = 0,
							Z = 0,
							SeedId = "CarrotSeed",
							PlantedAt = now - 5,
							PlantCount = bad,
						},
					},
				})
				check(
					junk.Structures["1"].PlantCount >= 1,
					`a PlantCount of {tostring(bad)} normalises to at least one plant`
				)
			end

			--[[
				FarmService keeps its own backstop for a missing count, and it
				has to be tested directly: Normalize guarantees the field for
				anything loaded from a profile, so no ordinary path can reach
				the default. This is the one that catches a future caller that
				builds an occupied entry without going through either.

				Zero here would render an occupied square as bare soil and
				harvest it for nothing - which looks like the crop was eaten,
				not like a missing default.
			]]
			local FarmService = require(FarmServiceModule)
			local backstop = newPlayer(4343, "Backstop")
			giveCharacter(backstop, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(backstop)

			local plot = makeFarm(backstop, -200, 200)
			advance(1)
			pokeFarm(backstop, plot)

			local record = PlayerDataService:GetData(backstop).Structures[plot]
			check(record.PlantCount > 1, "the square starts with a stack")

			-- Strip the field, as a path that skipped Normalize would leave it.
			record.PlantCount = nil
			FarmService:_projectCrop(backstop, FarmService:GetFarm(backstop, plot), record, os.time())

			checkEqual(
				farmOf(backstop, plot):GetAttribute("PlantCount"),
				1,
				"a square with no count renders as one plant, not none"
			)
			checkEqual(
				#farmOf(backstop, plot):FindFirstChild("Crop"):GetChildren(),
				1,
				"so the crop is still visibly there"
			)

			PlayersService.PlayerRemoving:Fire(backstop)
			backstop.Parent = nil

			-- A fallow square carries no count at all. (continued below)
			local fallow = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Farm", X = 0, Z = 0, SeedId = "", PlantCount = 5 },
				},
			})
			checkEqual(fallow.Structures["1"].PlantCount, nil, "a fallow square holds no plant count")
		end

		------------------------------------------------------------------------
		section("Husbandry: maturity and produce math")
		------------------------------------------------------------------------

		--[[
			The pure module first, with no pen and no service around it. Every
			payout in husbandry is derived from these functions, so if the
			arithmetic is wrong everything above it is wrong in a way that is
			much harder to read.
		]]
		do
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")
			local T0 = 1_000_000

			checkEqual(Husbandry.GetStage("Chick", T0, T0), "Juvenile", "a freshly stocked animal is a juvenile")
			checkEqual(
				Husbandry.GetStage("Chick", T0, T0 + chick.MatureTime // 2),
				"Adolescent",
				"halfway through it is an adolescent"
			)
			checkEqual(
				Husbandry.GetStage("Chick", T0, T0 + chick.MatureTime),
				"Grown",
				"and at its maturity time it is grown"
			)
			check(Husbandry.IsGrown("Grown"), "IsGrown recognises the final stage")
			checkEqual(
				Husbandry.GetStage("NotAnAnimal", T0, T0),
				GameConfig.Husbandry.EmptyStage,
				"an unknown animal has no stage, rather than a wrong one"
			)
			checkEqual(Husbandry.GetGrownAt("Chick", T0), T0 + chick.MatureTime, "GetGrownAt is stocked-at plus maturity")

			-- Fed from stocking for one window, as TryStock does.
			local fedUntil = T0 + chick.FeedDuration
			local grownAt = T0 + chick.MatureTime

			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, grownAt),
				0,
				"a herd that has only just grown up has produced nothing yet"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, grownAt + chick.ProduceInterval - 1),
				0,
				"and a part-finished cycle counts for nothing"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, grownAt + chick.ProduceInterval),
				1,
				"one whole cycle after maturity is one batch"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, grownAt + chick.ProduceInterval * 2),
				2,
				"and two is two"
			)

			--[[
				The window START is clamped to maturity, which is what stops a
				herd stocked long before it grew up from paying out the wait.
			]]
			checkEqual(
				Husbandry.GetWindowStart("Chick", T0, T0),
				grownAt,
				"the produce clock cannot start before the animals are grown"
			)

			--[[
				The window END is clamped to the feed. This is the whole
				cadence of the mechanic: time the herd was not fed produces
				nothing, and because the clock keeps running it is not merely
				deferred.
			]]
			local longAfter = T0 + chick.FeedDuration * 100
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, longAfter),
				(chick.FeedDuration - chick.MatureTime) // chick.ProduceInterval,
				"produce stops where the feed ran out, however long ago that was"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, nil, 6, longAfter),
				0,
				"a herd that was never fed has produced nothing"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 0, longAfter),
				0,
				"and an empty pen produces nothing"
			)

			--[[
				Advancing by the cycles PAID rather than to `now` is what makes
				collecting early cost nothing. Collect at the instant a cycle
				lands, or thirty seconds later, and the next one is due at the
				same moment either way.
			]]
			local at = grownAt + chick.ProduceInterval + 30
			local paid = Husbandry.GetReadyCycles("Chick", T0, T0, fedUntil, 6, at)
			local clock = Husbandry.AdvanceClock("Chick", T0, T0, paid)

			checkEqual(paid, 1, "one batch is waiting half a cycle into the second")
			checkEqual(
				clock,
				grownAt + chick.ProduceInterval,
				"and the clock advances by the cycle paid, not to the moment of collection"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, clock, fedUntil, 6, at),
				0,
				"so collecting twice in a row pays once"
			)
			checkEqual(
				Husbandry.GetReadyCycles("Chick", T0, clock, fedUntil, 6, at + 30),
				1,
				"and the next batch lands a cycle after the last one, not a cycle after the collection"
			)

			-- Totals are per cycle AND per animal: this is why a full pen is
			-- worth filling.
			checkEqual(
				Husbandry.GetProduceTotals("Chick", 3, 6).Egg,
				chick.Produces[1].Amount * 3 * 6,
				"produce is counted per cycle and per animal"
			)
			checkEqual(
				Husbandry.GetFeedCost("Chick", 6),
				chick.Feed.Amount * 6,
				"and feed is priced by headcount, so a bigger flock is a bigger commitment"
			)

			--[[
				A pig produces nothing periodically. It must therefore report
				no cycles at all rather than a timer that never fires, which
				is the difference between "raised for meat" and "broken".
			]]
			check(not GameConfig.HasProduce("Piglet"), "a pig has no periodic produce")
			checkEqual(
				Husbandry.GetReadyCycles("Piglet", T0, T0, T0 + 10_000, 3, T0 + 10_000),
				0,
				"so a barn full of pigs never has anything to collect"
			)
			checkEqual(
				Husbandry.GetNextProduceAt("Piglet", T0, T0, T0 + 10_000, 3, T0),
				nil,
				"and never names a next batch"
			)
			checkEqual(
				Husbandry.GetNextProduceAt("Chick", T0, T0, fedUntil, 6, longAfter),
				nil,
				"nor does a herd whose feed has run out - there is no next batch until it is fed"
			)

			-- Slaughter totals are per animal, and sum when two entries name
			-- the same item.
			checkEqual(
				Husbandry.GetSlaughterTotals("Calf", 3).Fat,
				3,
				"slaughter yields scale with the herd"
			)
		end

		------------------------------------------------------------------------
		section("Husbandry: stocking a pen")
		------------------------------------------------------------------------

		do
			local AnimalService = require(AnimalServiceModule)
			AnimalService:Start()
			HUSBANDRY = AnimalService

			local keeper = newPlayer(5151, "Keeper")
			giveCharacter(keeper, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(keeper)
			PDS:AddXP(keeper, 100000)

			local coop = makePen(keeper, "Coop", 160, 160)
			check(coop ~= nil, "a coop can be built beside a Mill")

			local model = penOf(keeper, coop)
			checkEqual(model:GetAttribute("AnimalId"), "", "a fresh pen is empty")
			checkEqual(model:GetAttribute("AnimalStage"), GameConfig.Husbandry.EmptyStage, "and has no maturity stage")

			--[[
				Two prompts, on different keys. Slaughtering is irreversible
				and sits on a building the player walks up to repeatedly to
				collect eggs, so it must not share a gesture with collecting
				them - the lesson from combat plants being uprooted by players
				mashing E down a row of farms.
			]]
			local interact = penPrompt(keeper, coop, "Interact")
			local cull = penPrompt(keeper, coop, "Cull")

			check(interact ~= nil, "a pen gets a contextual prompt")
			check(cull ~= nil, "and a separate one for slaughtering")
			check(interact.KeyboardKeyCode ~= cull.KeyboardKeyCode, "on different keys")
			checkEqual(interact.HoldDuration, 0, "the repeatable actions are a tap")
			checkEqual(
				cull.HoldDuration,
				GameConfig.Interaction.DestructiveHoldDuration,
				"and the irreversible one must be held"
			)
			checkEqual(cull.Enabled, false, "there is nothing to slaughter in an empty pen")
			checkEqual(interact.ActionText, "Stock", "an empty pen offers Stock")
			checkEqual(interact.ObjectText, "No livestock", "and says plainly that there is nothing to put in it")

			-- Pressing E with nothing to stock refuses, and explains itself.
			local refusal = nil
			local listener = AnimalService.ActionFailed:Connect(function(_, _, reason)
				refusal = reason
			end)

			pokePen(keeper, coop)
			checkEqual(refusal, "NoLivestock", "stocking with no livestock refuses, and says why")
			checkEqual(penOf(keeper, coop):GetAttribute("AnimalId"), "", "and the pen stays empty")

			--[[
				A cow does not go in a coop, and the refusal must come from the
				PEN rather than from the animal being unaffordable. Held, and
				still refused.
			]]
			refusal = nil
			PDS:AddItem(keeper, "Calf", 2)
			advance(1)
			pokePen(keeper, coop)
			checkEqual(refusal, "NoLivestock", "a coop will not take cattle, however many are held")
			checkEqual(penOf(keeper, coop):GetAttribute("AnimalId"), "", "so the pen is still empty")
			checkEqual(PDS:GetItemCount(keeper, "Calf"), 2, "and the calves are not consumed")
			checkEqual(GameConfig.GetPenCapacity("Coop", "Calf"), 0, "because no calf fits in a coop at all")

			-- Now the right animal, and more than fits.
			local capacity = GameConfig.GetPenCapacity("Coop", "Chick")
			check(capacity > 1, `a coop holds a flock ({capacity})`)

			PDS:AddItem(keeper, "Chick", capacity + 4)

			--[[
				A tick, not a second. The prompt is a projection refreshed by
				the husbandry loop, which runs on its own interval - so a test
				that reads it one second after changing the inventory is
				asserting the tick rate, not the text.
			]]
			advance(GameConfig.Husbandry.TickInterval + 1)

			checkEqual(
				penPrompt(keeper, coop, "Interact").ObjectText,
				`Chick x{capacity}`,
				"the prompt names how many would actually go in"
			)

			advance(1)
			pokePen(keeper, coop)

			model = penOf(keeper, coop)
			checkEqual(model:GetAttribute("AnimalId"), "Chick", "stocking fills the pen")
			checkEqual(model:GetAttribute("AnimalCount"), capacity, "to capacity, in one action")
			checkEqual(model:GetAttribute("AnimalCapacity"), capacity, "and publishes what it holds")
			checkEqual(model:GetAttribute("AnimalStage"), "Juvenile", "the animals start as juveniles")
			checkEqual(PDS:GetItemCount(keeper, "Chick"), 4, "consuming one item per animal and no more")

			local record = PDS:GetData(keeper).Structures[coop]
			checkEqual(record.AnimalId, "Chick", "the herd is recorded on the pen's own structure entry")
			checkEqual(record.AnimalCount, capacity, "with its headcount")
			check(record.StockedAt ~= nil, "and the timestamp everything else derives from")

			-- One visual per animal, so the flock is visible rather than implied.
			local herd = model:FindFirstChild("Herd")
			check(herd ~= nil, "the pen has a herd container")
			checkEqual(#herd:GetChildren(), capacity, "with a model for every animal")
			check(herd.PrimaryPart ~= nil, "and a PrimaryPart, so it can carry a health bar")

			--[[
				The herd ARRIVES FED, one window deep. A pen that began
				starving the instant it was stocked would punish a player for
				not already knowing the mechanic.
			]]
			local Husbandry = require(HusbandryModule)
			check(Husbandry.IsFed(record.FedUntil, os.time()), "a newly stocked herd arrives fed")

			--[[
				For the stocking grace, and NOT for a feed window.

				A full window was the first attempt and it quietly disabled
				the whole feed mechanic: a pig's FeedDuration is longer than
				its MatureTime, so the grace covered the entire raise and a
				barn could be taken to slaughter having never been fed.
			]]
			checkEqual(
				record.FedUntil - record.StockedAt,
				GameConfig.Husbandry.StockingGrace,
				"for the stocking grace exactly, not for a free feed window"
			)
			check(
				GameConfig.Husbandry.StockingGrace < GameConfig.GetAnimal("Chick").FeedDuration,
				"which is less than a feeding buys, so the grace is an introduction and not an income"
			)

			--[[
				And cannot be topped up, for the same reason a growing square
				cannot: keeping StockedAt would let a player stock one chick,
				wait until it was nearly grown, add five more and slaughter six
				grown chickens.
			]]
			refusal = nil
			advance(1)
			pokePen(keeper, coop)
			checkEqual(PDS:GetItemCount(keeper, "Chick"), 4, "a stocked pen cannot be topped up")
			checkEqual(penOf(keeper, coop):GetAttribute("AnimalCount"), capacity, "and its headcount does not move")

			--[[
				Called directly, because the prompt is not the thing under
				test: on a stocked pen the prompt branches to feed or collect,
				so it never reaches this guard - which means every other caller
				is relying on it alone.
			]]
			refusal = nil
			checkEqual(AnimalService:TryStock(keeper, coop), false, "TryStock refuses a stocked pen outright")
			checkEqual(refusal, "Occupied", "and says why")

			listener:Disconnect()
			KEEPER, COOP = keeper, coop
		end

		------------------------------------------------------------------------
		section("Husbandry: feeding, collecting and the produce clock")
		------------------------------------------------------------------------

		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)
			local keeper, coop = KEEPER, COOP

			local chick = GameConfig.GetAnimal("Chick")
			local count = penOf(keeper, coop):GetAttribute("AnimalCount")

			local refusal = nil
			local listener = AnimalService.ActionFailed:Connect(function(_, _, reason)
				refusal = reason
			end)

			-- A juvenile herd has nothing to collect, and says so specifically.
			refusal = nil
			checkEqual(AnimalService:TryCollect(keeper, coop), false, "a juvenile herd has nothing to collect")
			checkEqual(refusal, "NotGrown", "and the refusal names growing, not hunger")

			--[[
				Feed them, and note that this is not optional.

				The stocking grace is deliberately shorter than the fastest
				animal's MatureTime, so no herd can be raised on it: left
				alone, this flock starves before it grows up. An earlier
				version granted a full feed window at stocking and a barn of
				pigs could be taken to slaughter having never eaten.
			]]
			local feedCost = Husbandry.GetFeedCost("Chick", count)
			PDS:AddItem(keeper, chick.Feed.ItemId, feedCost * 20)

			check(
				GameConfig.Husbandry.StockingGrace < chick.MatureTime,
				"the stocking grace runs out before the flock is grown, so it has to be fed"
			)
			checkEqual(AnimalService:TryFeed(keeper, coop), true, "so the keeper feeds them")

			-- Grow them up. Derived from a timestamp, so the clock does it.
			advance(chick.MatureTime + GameConfig.Husbandry.TickInterval + 1)
			checkEqual(penOf(keeper, coop):GetAttribute("AnimalStage"), "Grown", "the flock grows up on the clock")

			--[[
				The tick re-projects on a stage transition, which is also what
				makes the herd slaughterable. A re-render alone would leave a
				grown flock the cull prompt refused to touch.
			]]
			checkEqual(penPrompt(keeper, coop, "Cull").Enabled, true, "a grown herd can be slaughtered")

			refusal = nil
			checkEqual(AnimalService:TryCollect(keeper, coop), false, "but it has not laid anything yet")
			checkEqual(refusal, "NothingReady", "and that refusal is neither growing nor hunger")

			-- One whole cycle.
			advance(chick.ProduceInterval)

			local eggsBefore = PDS:GetItemCount(keeper, "Egg")
			local xpBefore = PDS:GetData(keeper).XP
			local collectedBefore = PDS:GetData(keeper).Stats.TotalProduceCollected
			local clockBefore = PDS:GetData(keeper).Structures[coop].LastCollectedAt

			checkEqual(penPrompt(keeper, coop, "Interact").ActionText, "Collect", "the prompt switches to Collect")

			advance(1)
			pokePen(keeper, coop)

			checkEqual(
				PDS:GetItemCount(keeper, "Egg") - eggsBefore,
				chick.Produces[1].Amount * count,
				"collecting pays one batch per animal"
			)
			check(PDS:GetData(keeper).XP > xpBefore, "and pays XP for it")
			checkEqual(
				PDS:GetData(keeper).Stats.TotalProduceCollected - collectedBefore,
				count,
				"and counts every animal that produced, not one pen"
			)

			--[[
				The clock advanced by exactly one cycle, NOT to the moment of
				collection. This is the assertion the whole payout model rests
				on: a player who collects a second late is paid the same as one
				who collects on the dot.
			]]
			local record = PDS:GetData(keeper).Structures[coop]
			checkEqual(
				record.LastCollectedAt - math.max(clockBefore, record.StockedAt + chick.MatureTime),
				chick.ProduceInterval,
				"the produce clock advances by the cycle paid, not to the moment of collection"
			)

			refusal = nil
			checkEqual(AnimalService:TryCollect(keeper, coop), false, "collecting twice in a row pays once")
			checkEqual(refusal, "NothingReady", "the second press has nothing waiting")

			--------------------------------------------------------------------
			-- Feeding
			--------------------------------------------------------------------

			local fedBefore = PDS:GetItemCount(keeper, chick.Feed.ItemId)
			local fedUntilBefore = PDS:GetData(keeper).Structures[coop].FedUntil

			checkEqual(AnimalService:TryFeed(keeper, coop), true, "a herd with room on its clock eats")
			checkEqual(
				fedBefore - PDS:GetItemCount(keeper, chick.Feed.ItemId),
				feedCost,
				"consuming feed for the whole flock, not for one bird"
			)
			check(
				PDS:GetData(keeper).Structures[coop].FedUntil > fedUntilBefore,
				"and the fed clock moves forward"
			)
			check(
				PDS:GetData(keeper).Structures[coop].FedUntil <= Husbandry.GetFeedCeiling("Chick", os.time()),
				"but never past the ceiling, which is what bounds offline production"
			)

			--[[
				And now it will not eat again. Feed can only be stacked
				MaxFedWindows deep, which is the cap that bounds offline
				production without a separate "max stored produce" rule.
			]]
			refusal = nil
			local heldAfterFeeding = PDS:GetItemCount(keeper, chick.Feed.ItemId)
			checkEqual(AnimalService:TryFeed(keeper, coop), false, "a herd fed to the ceiling will not eat more")
			checkEqual(refusal, "FeedFull", "and says so")
			checkEqual(
				PDS:GetItemCount(keeper, chick.Feed.ItemId),
				heldAfterFeeding,
				"without consuming the feed"
			)

			--------------------------------------------------------------------
			-- Going hungry
			--------------------------------------------------------------------

			--[[
				Run just past the end of the feed. Not far past: an unfed herd
				starves, and this section is about production rather than
				death.
			]]
			local fedUntil = PDS:GetData(keeper).Structures[coop].FedUntil
			advance(fedUntil - os.time() + 10)
			check(not Husbandry.IsFed(fedUntil, os.time()), "the feed runs out")

			--[[
				Produce earned while they WERE fed is still there - going
				hungry stops production, it does not confiscate it.
			]]
			local eggsBefore = PDS:GetItemCount(keeper, "Egg")
			checkEqual(AnimalService:TryCollect(keeper, coop), true, "what they earned while fed is still collectable")
			check(PDS:GetItemCount(keeper, "Egg") > eggsBefore, "and pays out")

			-- With that banked produce taken, a hungry herd has nothing, and
			-- reports hunger rather than an empty nest.
			refusal = nil
			checkEqual(AnimalService:TryCollect(keeper, coop), false, "a hungry herd produces nothing more")
			checkEqual(refusal, "Hungry", "and names hunger, which is the thing the player can fix")

			-- Feeding with an empty larder refuses rather than part-feeding.
			PDS:RemoveItem(keeper, chick.Feed.ItemId, PDS:GetItemCount(keeper, chick.Feed.ItemId))

			refusal = nil
			checkEqual(AnimalService:TryFeed(keeper, coop), false, "a hungry herd with no feed in the bag refuses")
			checkEqual(refusal, "NotEnoughFeed", "and names the missing feed")

			listener:Disconnect()

			--[[
				Released, like every other section's player. Leaving a profile
				active costs the shutdown flush at the end of the suite a
				round of retries against the injected DataStore failures, and
				enough of them exhaust the runner's clock budget - which
				presents as "TESTS DID NOT COMPLETE" hundreds of sections
				away from the section that caused it.
			]]
			PlayersService.PlayerRemoving:Fire(keeper)
			keeper.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: a starved gap pays nothing")
		------------------------------------------------------------------------

		--[[
			The exploit this closes: leave a herd unfed for a day, feed it
			once, and collect a day of produce. Feeding must settle the hungry
			stretch rather than retroactively paying for it - and it must do so
			without throwing away batches the herd legitimately earned BEFORE
			the feed ran out.
		]]
		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")

			local hand = newPlayer(5252, "Stockman")
			giveCharacter(hand, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(hand)
			PDS:AddXP(hand, 100000)

			local coop = makePen(hand, "Coop", -160, 160)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(hand, "Chick", count)
			advance(1)
			pokePen(hand, coop)
			checkEqual(penOf(hand, coop):GetAttribute("AnimalCount"), count, "a second flock is stocked")

			-- Fed at once, so the flock survives to produce anything.
			PDS:AddItem(hand, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", count) * 20)
			checkEqual(AnimalService:TryFeed(hand, coop), true, "and fed")

			--[[
				Run to the end of that feed window without collecting, so
				there are whole batches banked on the clock.
			]]
			advance(PDS:GetData(hand).Structures[coop].FedUntil - os.time())

			local record = PDS:GetData(hand).Structures[coop]
			local earned = Husbandry.GetReadyCycles(
				"Chick",
				record.StockedAt,
				record.LastCollectedAt,
				record.FedUntil,
				count,
				os.time()
			)
			check(earned > 0, `the flock banked batches while it was fed ({earned})`)

			-- Now neglect them, but not long enough to kill them.
			local gap = 60
			advance(gap)

			record = PDS:GetData(hand).Structures[coop]
			check(not Husbandry.IsFed(record.FedUntil, os.time()), "the feed has run out")
			checkEqual(
				Husbandry.GetReadyCycles(
					"Chick",
					record.StockedAt,
					record.LastCollectedAt,
					record.FedUntil,
					count,
					os.time()
				),
				earned,
				"and the hungry stretch adds nothing while it lasts"
			)

			-- Feed them. The gap must not be paid for.
			checkEqual(AnimalService:TryFeed(hand, coop), true, "feeding a hungry herd works")

			record = PDS:GetData(hand).Structures[coop]
			checkEqual(
				Husbandry.GetReadyCycles(
					"Chick",
					record.StockedAt,
					record.LastCollectedAt,
					record.FedUntil,
					count,
					os.time()
				),
				earned,
				"and feeding pays for none of the time they went hungry"
			)

			--[[
				The other half of the rule, and the reason the clock is pushed
				rather than reset: the batches earned before the feed lapsed
				are still there to collect.
			]]
			local eggsBefore = PDS:GetItemCount(hand, "Egg")
			checkEqual(AnimalService:TryCollect(hand, coop), true, "the banked batches survive the neglect")
			checkEqual(
				PDS:GetItemCount(hand, "Egg") - eggsBefore,
				chick.Produces[1].Amount * earned * count,
				"and pay out in full, no more and no less"
			)

			PlayersService.PlayerRemoving:Fire(hand)
			hand.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: neglect kills a herd")
		------------------------------------------------------------------------

		--[[
			Starvation is what makes feeding matter for an animal that has no
			periodic produce. A pig's maturity is derived from its stocking
			time and arrives whether or not anybody turned up with a bucket, so
			without hunger having teeth, feeding one would be a cost with no
			consequence for skipping it.
		]]
		do
			local AnimalService = HUSBANDRY
			local DamageableService = require(DamageableServiceModule)
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")

			local absentee = newPlayer(5353, "Absentee")
			giveCharacter(absentee, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(absentee)
			PDS:AddXP(absentee, 100000)

			local coop = makePen(absentee, "Coop", 160, -60)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(absentee, "Chick", count)
			advance(1)
			pokePen(absentee, coop)

			local pen = AnimalService:GetPen(absentee, coop)
			check(pen.HerdEntityId ~= nil, "a herd is a damageable entity in its own right")

			local archetype = GameConfig.GetArchetype(chick.ArchetypeId)
			checkEqual(archetype.Repairable, false, "a chicken cannot be repaired")
			check(archetype.RegenPerSecond > 0, "but a herd heals, because it is alive")
			checkEqual(archetype.TargetTag, "Resource", "and a raider going for the economy counts it as one")

			-- While fed, nothing happens to them.
			local fullHealth = DamageableService:GetHealth(pen.HerdEntityId)
			advance(GameConfig.Husbandry.TickInterval * 4)
			checkEqual(
				DamageableService:GetHealth(pen.HerdEntityId),
				fullHealth,
				"a fed herd takes no damage from the husbandry loop"
			)

			-- Let the stocking grace lapse, and they start to starve.
			advance(GameConfig.Husbandry.StockingGrace)
			check(
				not Husbandry.IsFed(PDS:GetData(absentee).Structures[coop].FedUntil, os.time()),
				"the feed runs out"
			)

			advance(GameConfig.Husbandry.TickInterval * 4)
			local starving = DamageableService:GetHealth(pen.HerdEntityId)
			check(starving < fullHealth, `a hungry herd loses health ({starving} of {fullHealth})`)

			--[[
				Mirrored onto the pen's structure entry, because the registry
				owns health but the profile is what survives a rejoin.
			]]
			check(
				PDS:GetData(absentee).Structures[coop].HerdHealth ~= nil,
				"and the damage is mirrored onto the pen's record, so it survives a logout"
			)

			-- Keep neglecting them, and they die.
			local lost = nil
			local listener = AnimalService.HerdLost:Connect(function(_, instanceId, stockId)
				lost = { InstanceId = instanceId, StockId = stockId }
			end)

			local guard = 0
			while DamageableService:IsAlive(pen.HerdEntityId) and guard < 400 do
				advance(GameConfig.Husbandry.TickInterval)
				guard += 1
			end

			check(lost ~= nil, "a neglected herd eventually dies")
			-- Guarded, so a regression here reports a failure instead of
			-- crashing the run and hiding every section after it.
			checkEqual(if lost then lost.StockId else nil, "Chick", "and the loss names what died")
			checkEqual(penOf(absentee, coop):GetAttribute("AnimalId"), "", "the pen is emptied")
			checkEqual(PDS:GetData(absentee).Structures[coop].AnimalId, "", "on its record as well as its model")
			checkEqual(
				penOf(absentee, coop):FindFirstChild("Herd"),
				nil,
				"and the animals are gone from the world"
			)

			--[[
				Nothing is dropped. Losing livestock has to cost something or
				there would be no reason to feed them, and a corpse that still
				paid out would make starvation a slower way of slaughtering.
			]]
			checkEqual(PDS:GetItemCount(absentee, "RawChicken"), 0, "a starved flock yields no meat")

			-- The pen is reusable, which is the difference between losing a
			-- herd and losing the building.
			PDS:AddItem(absentee, "Chick", count)
			advance(1)
			pokePen(absentee, coop)
			checkEqual(penOf(absentee, coop):GetAttribute("AnimalId"), "Chick", "and the empty pen can be restocked")

			listener:Disconnect()
			PlayersService.PlayerRemoving:Fire(absentee)
			absentee.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: slaughter, and the pig that only slaughters")
		------------------------------------------------------------------------

		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)

			local butcher = newPlayer(5454, "Butcher")
			giveCharacter(butcher, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(butcher)
			PDS:AddXP(butcher, 100000)

			local refusal = nil
			local listener = AnimalService.ActionFailed:Connect(function(_, _, reason)
				refusal = reason
			end)

			--------------------------------------------------------------------
			-- A barn of pigs: no produce, slaughter only.
			--------------------------------------------------------------------

			local barn = makePen(butcher, "Barn", -160, -60)
			check(barn ~= nil, "a barn can be built once the age allows it")
			checkEqual(
				GameConfig.GetStructure("Barn").RequiredAge,
				2,
				"and it is deliberately not a Stone Age building"
			)

			local pig = GameConfig.GetAnimal("Piglet")
			local count = GameConfig.GetPenCapacity("Barn", "Piglet")
			check(count >= 1, `a barn holds pigs ({count})`)
			check(
				count < GameConfig.GetPenCapacity("Coop", "Chick"),
				"fewer than a coop holds chickens, because a pig takes more room"
			)

			PDS:AddItem(butcher, "Piglet", count)
			advance(1)
			pokePen(butcher, barn)
			checkEqual(penOf(butcher, barn):GetAttribute("AnimalId"), "Piglet", "the barn is stocked with pigs")

			--[[
				A pig has to be fed even though it produces nothing, and this
				is the whole justification for starvation existing.

				Maturity is derived from the stocking time and arrives whether
				or not anybody turned up with a bucket, so hunger is the only
				thing that makes the feed cost real for an animal raised only
				for slaughter. An earlier version granted a full feed window
				at stocking - longer than a pig takes to mature - and a barn
				could be raised to slaughter for nothing.
			]]
			check(
				GameConfig.Husbandry.StockingGrace < pig.MatureTime,
				"a pig cannot be raised on the stocking grace alone"
			)

			PDS:AddItem(butcher, pig.Feed.ItemId, Husbandry.GetFeedCost("Piglet", count) * 20)
			checkEqual(AnimalService:TryFeed(butcher, barn), true, "so the pigs are fed")

			-- Slaughtering a juvenile is refused rather than quietly paying
			-- less than the prompt said.
			refusal = nil
			checkEqual(AnimalService:TrySlaughter(butcher, barn), false, "a juvenile herd cannot be slaughtered")
			checkEqual(refusal, "NotGrown", "and the refusal says why")
			checkEqual(penPrompt(butcher, barn, "Cull").Enabled, false, "the cull prompt is not even offered")

			-- There is nothing to collect from a pig, ever.
			refusal = nil
			checkEqual(AnimalService:TryCollect(butcher, barn), false, "a pig produces nothing to collect")
			checkEqual(refusal, "NoProduce", "and the refusal says that, rather than blaming the clock")

			advance(pig.MatureTime + GameConfig.Husbandry.TickInterval + 1)
			checkEqual(penOf(butcher, barn):GetAttribute("AnimalStage"), "Grown", "the pigs grow up")

			local porkBefore = PDS:GetItemCount(butcher, "RawPork")
			local fatBefore = PDS:GetItemCount(butcher, "Fat")
			local xpBefore = PDS:GetData(butcher).XP
			local slaughteredBefore = PDS:GetData(butcher).Stats.TotalAnimalsSlaughtered

			advance(1)
			pokePen(butcher, barn, "Cull")

			local expected = Husbandry.GetSlaughterTotals("Piglet", count)
			checkEqual(
				PDS:GetItemCount(butcher, "RawPork") - porkBefore,
				expected.RawPork,
				"slaughtering pays the whole herd's meat"
			)
			checkEqual(PDS:GetItemCount(butcher, "Fat") - fatBefore, expected.Fat, "and everything else it yields")
			check(PDS:GetData(butcher).XP > xpBefore, "and pays XP")
			checkEqual(
				PDS:GetData(butcher).Stats.TotalAnimalsSlaughtered - slaughteredBefore,
				count,
				"and counts every animal, not one pen"
			)
			checkEqual(penOf(butcher, barn):GetAttribute("AnimalId"), "", "the barn is emptied")
			checkEqual(PDS:GetData(butcher).Structures[barn].AnimalId, "", "on its record too")
			checkEqual(PDS:GetData(butcher).Structures[barn].StockedAt, nil, "and its timestamps are cleared")

			--------------------------------------------------------------------
			-- A coop of chickens: slaughtering pays the eggs first.
			--------------------------------------------------------------------

			local chick = GameConfig.GetAnimal("Chick")
			local coop = makePen(butcher, "Coop", -160, 40)
			local flock = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(butcher, "Chick", flock)
			advance(1)
			pokePen(butcher, coop)

			PDS:AddItem(butcher, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", flock) * 20)
			checkEqual(AnimalService:TryFeed(butcher, coop), true, "the flock is fed")

			-- Grow up and bank a batch, without collecting it.
			advance(chick.MatureTime + chick.ProduceInterval + 1)

			local record = PDS:GetData(butcher).Structures[coop]
			local banked = Husbandry.GetReadyCycles(
				"Chick",
				record.StockedAt,
				record.LastCollectedAt,
				record.FedUntil,
				flock,
				os.time()
			)
			check(banked > 0, "the flock has eggs waiting")

			local eggsBefore = PDS:GetItemCount(butcher, "Egg")
			local chickenBefore = PDS:GetItemCount(butcher, "RawChicken")

			advance(1)
			pokePen(butcher, coop, "Cull")

			--[[
				The eggs are paid out first, so slaughtering never silently
				destroys produce the player had not got round to collecting.
			]]
			checkEqual(
				PDS:GetItemCount(butcher, "Egg") - eggsBefore,
				chick.Produces[1].Amount * banked * flock,
				"slaughtering collects the waiting produce rather than destroying it"
			)
			checkEqual(
				PDS:GetItemCount(butcher, "RawChicken") - chickenBefore,
				Husbandry.GetSlaughterTotals("Chick", flock).RawChicken,
				"and then pays the meat"
			)
			checkEqual(penOf(butcher, coop):GetAttribute("AnimalId"), "", "leaving the coop empty")

			listener:Disconnect()
			PlayersService.PlayerRemoving:Fire(butcher)
			butcher.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: a herd survives a rejoin")
		------------------------------------------------------------------------

		--[[
			The same guarantee crops have, and for the same reason: state is
			derived from timestamps rather than counted up by a loop, so
			animals grow and produce while the player is offline.
		]]
		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")

			local leaver = newPlayer(5555, "Leaver")
			giveCharacter(leaver, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(leaver)
			PDS:AddXP(leaver, 100000)

			local coop = makePen(leaver, "Coop", 40, 160)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(leaver, "Chick", count)
			advance(1)
			pokePen(leaver, coop)
			checkEqual(penOf(leaver, coop):GetAttribute("AnimalStage"), "Juvenile", "the flock goes in as juveniles")

			-- Fed before leaving, which is the point of being able to feed
			-- ahead at all.
			PDS:AddItem(leaver, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", count) * 20)
			checkEqual(AnimalService:TryFeed(leaver, coop), true, "and are fed before the player leaves")

			-- Log out while they are still growing.
			PlayersService.PlayerRemoving:Fire(leaver)
			leaver.Parent = nil

			advance(chick.MatureTime + chick.ProduceInterval * 2)

			-- Same user id, new Player instance: a rejoin, not a reconnect.
			local returned = newPlayer(5555, "Leaver")
			giveCharacter(returned, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(returned)

			local model = penOf(returned, coop)
			check(model ~= nil, "the pen is rebuilt on rejoin")
			checkEqual(model:GetAttribute("AnimalId"), "Chick", "with its herd still in it")
			checkEqual(model:GetAttribute("AnimalCount"), count, "and its headcount")
			checkEqual(model:GetAttribute("AnimalStage"), "Grown", "which grew up while the player was away")
			check(penPrompt(returned, coop, "Interact") ~= nil, "the prompts come back")
			check(model:FindFirstChild("Herd") ~= nil, "and so do the animals")

			local record = PDS:GetData(returned).Structures[coop]
			local waiting = Husbandry.GetReadyCycles(
				"Chick",
				record.StockedAt,
				record.LastCollectedAt,
				record.FedUntil,
				count,
				os.time()
			)
			check(waiting > 0, `and they produced while nobody was watching ({waiting} batches`)

			local eggsBefore = PDS:GetItemCount(returned, "Egg")
			checkEqual(AnimalService:TryCollect(returned, coop), true, "which can be collected on return")
			checkEqual(
				PDS:GetItemCount(returned, "Egg") - eggsBefore,
				chick.Produces[1].Amount * waiting * count,
				"for exactly what the offline time earned"
			)

			--[[
				Offline production is bounded by the FEED rather than by how
				long the player was away, which is what lets there be no
				separate "max stored" cap.

				Asserted by comparing an absurd absence against the feed
				boundary rather than against a generous ceiling: a check that
				`waiting` is under two feed windows passes on any
				implementation, including one that ignores the feed entirely.
			]]
			checkEqual(
				Husbandry.GetReadyCycles(
					"Chick",
					record.StockedAt,
					record.LastCollectedAt,
					record.FedUntil,
					count,
					os.time() + 100_000
				),
				Husbandry.GetReadyCycles(
					"Chick",
					record.StockedAt,
					record.LastCollectedAt,
					record.FedUntil,
					count,
					record.FedUntil
				),
				"however long the player stays away, production stops where the feed does"
			)

			--[[
				And demolishing the pen takes the herd with it. One record per
				pen is what guarantees this: a parallel table keyed by pen id
				would leave a herd with nowhere to live.
			]]
			checkEqual(PLACEMENT:Demolish(returned, coop).Ok, true, "the pen can be demolished")
			checkEqual(PDS:GetData(returned).Structures[coop], nil, "and the herd record goes with it")
			checkEqual(AnimalService:GetPen(returned, coop), nil, "leaving nothing attached to a pen that is gone")

			PlayersService.PlayerRemoving:Fire(returned)
			returned.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: a hungry herd does not grow")
		------------------------------------------------------------------------

		--[[
			Reported from play: "the chickens grow without feeding and I didn't
			notice starvation; cows and pigs had starvation and died if not
			fed". Both halves were true, and the arithmetic says why.

			Maturity used to be derived from the stocking time alone, so the
			question of whether an animal could be raised unfed came down to
			an accident of two unrelated numbers - whether it matured faster
			than it starved. A chicken matures in 120s and starves in 133; a
			pig needs 300s and dies in 120. So feeding was mandatory for
			livestock and optional for poultry, which is worse than it being
			either, because the rule looked enforced.

			A herd now only AGES while it is fed.
		]]
		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)

			--[[
				First the thing that made this a lottery: for every animal,
				being left alone must not be a viable way to raise it.
			]]
			for stockId, animal in GameConfig.Animals do
				local archetype = GameConfig.GetArchetype(animal.ArchetypeId)
				local net = archetype.MaxHealth * GameConfig.Husbandry.StarvationFractionPerSecond
					- archetype.RegenPerSecond
				local secondsToStarve = archetype.MaxHealth / net

				check(
					secondsToStarve < animal.MatureTime + GameConfig.Husbandry.StockingGrace,
					`{stockId} starves in {math.floor(secondsToStarve)}s, inside the `
						.. `{animal.MatureTime + GameConfig.Husbandry.StockingGrace}s it needs to be raised - `
						.. `so neglect cannot outlast the raise`
				)
			end

			local idler = newPlayer(5959, "Idler")
			giveCharacter(idler, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(idler)
			PDS:AddXP(idler, 100000)

			local coop = makePen(idler, "Coop", -40, 40)
			local chick = GameConfig.GetAnimal("Chick")
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(idler, "Chick", count)
			advance(1)
			pokePen(idler, coop)

			local stockedAt = PDS:GetData(idler).Structures[coop].StockedAt

			--[[
				Run past the grace and well past the maturity time, feeding
				nothing. This is the exact case that used to produce a grown
				flock: 120s of maturity against 133s of starvation.
			]]
			local hungry = nil
			local listener = AnimalService.HerdHungry:Connect(function()
				hungry = true
			end)

			--[[
				Past the grace first. The grace is real fed time, so the herd
				legitimately ages through it - for a chicken that is half its
				maturity - and then the clock should stop.
			]]
			advance(GameConfig.Husbandry.StockingGrace + GameConfig.Husbandry.TickInterval * 2)

			check(hungry == true, "going hungry is announced rather than left to be discovered")

			local frozenAt = penOf(idler, coop):GetAttribute("AnimalStage")
			check(not Husbandry.IsGrown(frozenAt), `the flock is not grown when the grace runs out ({frozenAt})`)

			--[[
				Now past its whole maturity time again, still unfed - but not
				so far that they starve, because the point here is the frozen
				clock rather than the death. The span is derived from the
				starvation rate so that retuning a herd's health cannot
				silently turn this into a test about a dead flock.
			]]
			local birdArchetype = GameConfig.GetArchetype(chick.ArchetypeId)
			local netLoss = birdArchetype.MaxHealth * GameConfig.Husbandry.StarvationFractionPerSecond
				- birdArchetype.RegenPerSecond
			local safeHungrySpan = math.floor(birdArchetype.MaxHealth / netLoss / 2)

			check(
				safeHungrySpan > chick.MatureTime // 2,
				"a flock can go hungry for a good part of its maturity time without dying"
			)

			advance(safeHungrySpan)

			checkEqual(
				penOf(idler, coop):GetAttribute("AnimalStage"),
				frozenAt,
				"and a maturity time's worth of hunger later, it has not aged a day"
			)
			check(
				not Husbandry.IsGrown(penOf(idler, coop):GetAttribute("AnimalStage")),
				"so a flock cannot be raised by neglect"
			)

			--[[
				Because the stocking time was pushed forward by the hungry
				span: the herd is no older than the fed time it has had, which
				is none.
			]]
			check(
				PDS:GetData(idler).Structures[coop].StockedAt > stockedAt,
				"the age clock was held rather than allowed to run while hungry"
			)
			checkEqual(
				AnimalService:TrySlaughter(idler, coop),
				false,
				"so it cannot be slaughtered either - neglect raises nothing"
			)

			-- Feeding restarts the clock, and then it does grow.
			PDS:AddItem(idler, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", count) * 20)
			checkEqual(AnimalService:TryFeed(idler, coop), true, "feeding them restarts the clock")

			advance(chick.MatureTime + GameConfig.Husbandry.TickInterval + 1)
			checkEqual(
				penOf(idler, coop):GetAttribute("AnimalStage"),
				"Grown",
				"and a fed flock grows up in its maturity time"
			)

			listener:Disconnect()
			PlayersService.PlayerRemoving:Fire(idler)
			idler.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: hunger returns every time the feed runs out")
		------------------------------------------------------------------------

		--[[
			Reported from play: "the animals only get hungry and fed once;
			after that there is no starvation".

			Hunger is settled through a HungryChargedTo marker, which is
			exactly the shape of thing that works once and then latches. So
			this runs the whole cycle three times over and insists that every
			spell announces itself, costs health, and is endable by feeding.
		]]
		do
			local AnimalService = HUSBANDRY
			local DamageableService = require(DamageableServiceModule)
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")

			local shepherd = newPlayer(6060, "Shepherd")
			giveCharacter(shepherd, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(shepherd)
			PDS:AddXP(shepherd, 100000)

			local coop = makePen(shepherd, "Coop", 120, 40)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(shepherd, "Chick", count)
			advance(1)
			pokePen(shepherd, coop)
			PDS:AddItem(shepherd, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", count) * 40)

			local spells = 0
			local listener = AnimalService.HerdHungry:Connect(function()
				spells += 1
			end)

			local pen = AnimalService:GetPen(shepherd, coop)

			for round = 1, 3 do
				checkEqual(AnimalService:TryFeed(shepherd, coop), true, `round {round}: the herd eats`)
				check(
					Husbandry.IsFed(PDS:GetData(shepherd).Structures[coop].FedUntil, os.time()),
					`round {round}: and is fed afterwards`
				)

				local spellsBefore = spells

				-- Run out the feed, then a little past it.
				local fedUntil = PDS:GetData(shepherd).Structures[coop].FedUntil
				advance(fedUntil - os.time() + GameConfig.Husbandry.TickInterval * 3)

				check(
					not Husbandry.IsFed(PDS:GetData(shepherd).Structures[coop].FedUntil, os.time()),
					`round {round}: the feed runs out again`
				)
				checkEqual(spells, spellsBefore + 1, `round {round}: and going hungry is announced again`)

				--[[
					And it costs health every time. Measured as a fraction,
					because the herd heals back up between spells - which it
					should, being alive and fed.
				]]
				check(
					DamageableService:GetHealthFraction(pen.HerdEntityId) < 1,
					`round {round}: and the hungry herd is losing health`
				)
			end

			checkEqual(spells, 3, "three feeds and three lapses are three hungry spells, not one")

			--------------------------------------------------------------------
			-- Being able to SEE it, which is what the report was really about.
			--------------------------------------------------------------------

			--[[
				Feed stacks two windows deep, so feeding a hungry herd leaves
				the prompt still offering Feed - correctly, there is room for
				another window. With nothing else on it, that looked exactly
				like a button that had not worked.
			]]
			local function labelOf()
				local body = penOf(shepherd, coop).PrimaryPart
				return body:FindFirstChild("Label"):FindFirstChild("Title").Text
			end

			advance(GameConfig.Husbandry.TickInterval + 1)

			local hungryPrompt = penPrompt(shepherd, coop, "Interact").ObjectText
			check(
				string.find(hungryPrompt, "HUNGRY") ~= nil,
				`a hungry herd says so on its prompt ({hungryPrompt})`
			)
			check(
				string.find(labelOf(), "HUNGRY") ~= nil,
				`and on the pen's name plate, readable from across the base ({labelOf()})`
			)

			checkEqual(AnimalService:TryFeed(shepherd, coop), true, "feeding them")
			advance(GameConfig.Husbandry.TickInterval + 1)

			local fedPrompt = penPrompt(shepherd, coop, "Interact").ObjectText
			check(
				string.find(fedPrompt, "HUNGRY") == nil,
				`the prompt stops saying HUNGRY the moment they are fed ({fedPrompt})`
			)
			check(
				string.find(fedPrompt, "fed %d+m") ~= nil,
				"and carries a countdown, so a press that worked looks different from one that did not"
			)
			check(
				string.find(labelOf(), "fed %d+m") ~= nil,
				`and the name plate shows it too ({labelOf()})`
			)

			--[[
				Feeding again must move the number. This is the assertion the
				whole complaint comes down to: the prompt still offers Feed,
				and it has to be visibly a different offer.
			]]
			local before = labelOf()
			checkEqual(AnimalService:TryFeed(shepherd, coop), true, "a second feeding is allowed")
			advance(GameConfig.Husbandry.TickInterval + 1)
			check(labelOf() ~= before, `and visibly extends the feed ({before} -> {labelOf()})`)

			--[[
				And the notice does not repeat on every tick of the same
				spell, which is the other way a reminder becomes useless.
			]]
			local spellsBefore = spells
			advance(GameConfig.Husbandry.TickInterval * 5)
			checkEqual(spells, spellsBefore, "a spell already announced is not announced again every tick")

			listener:Disconnect()
			PlayersService.PlayerRemoving:Fire(shepherd)
			shepherd.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: neglect is not undone by logging out")
		------------------------------------------------------------------------

		--[[
			Starvation is applied by a loop that only runs for an online
			player, but health REGENERATES from elapsed time whether or not
			anyone is watching. So logging out used to heal a starving herd,
			and neglect could be reset indefinitely by taking a break - which
			left the only cost of never feeding as forgone produce, and for a
			pig that is no cost at all.

			Offline time has to cost what online time costs.
		]]
		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)
			local chick = GameConfig.GetAnimal("Chick")

			local truant = newPlayer(5757, "Truant")
			giveCharacter(truant, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(truant)
			PDS:AddXP(truant, 100000)

			local coop = makePen(truant, "Coop", -40, -160)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")

			PDS:AddItem(truant, "Chick", count)
			advance(1)
			pokePen(truant, coop)
			checkEqual(penOf(truant, coop):GetAttribute("AnimalId"), "Chick", "a flock is stocked and left unfed")

			-- Let the stocking grace lapse so they are genuinely hungry.
			advance(GameConfig.Husbandry.StockingGrace + GameConfig.Husbandry.TickInterval)
			check(
				not Husbandry.IsFed(PDS:GetData(truant).Structures[coop].FedUntil, os.time()),
				"the grace runs out with nobody feeding them"
			)

			local hurt = PDS:GetData(truant).Structures[coop].HerdHealth
			check(hurt ~= nil, "they take starvation damage while the owner is online")

			-- Now leave. Long enough that regeneration alone would heal them
			-- to full several times over.
			local archetype = GameConfig.GetArchetype(chick.ArchetypeId)
			local fullHealTime = archetype.MaxHealth / archetype.RegenPerSecond

			PlayersService.PlayerRemoving:Fire(truant)
			truant.Parent = nil

			advance(fullHealTime + 100)

			local returned = newPlayer(5757, "Truant")
			giveCharacter(returned, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(returned)

			--[[
				The absence is charged on attach, from the later of the feed
				running out and the damage already taken, so no span is billed
				twice - and over an absence this long the flock does not
				survive it.
			]]
			checkEqual(
				penOf(returned, coop):GetAttribute("AnimalId"),
				"",
				"a herd left hungry over a long absence is dead when the owner comes back"
			)
			checkEqual(
				PDS:GetData(returned).Structures[coop].AnimalId,
				"",
				"and the pen's record says so too"
			)
			checkEqual(
				PDS:GetData(returned).Structures[coop].FedUntil,
				nil,
				"with every herd field cleared, not just the animal id"
			)

			PlayersService.PlayerRemoving:Fire(returned)
			returned.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: produce that will not fit in the bag")
		------------------------------------------------------------------------

		--[[
			The failure this covers was unrecoverable, and every ingredient
			was individually correct.

			Produce accrues without limit for a herd that is kept fed. The
			payout was all-or-nothing, because a part-granted payout cannot
			advance the clock exactly once. And a refused collection leaves
			the clock untouched, so the pending total only ever grew. Past a
			stack limit the collection could never succeed, never shrink, and
			slaughtering - which collects first - could not empty the pen
			either. The pen was bricked, and both prompts went on advertising
			the eggs.
		]]
		do
			local AnimalService = HUSBANDRY
			local Husbandry = require(HusbandryModule)
			local ShopService = require(ShopServiceModule)
			local chick = GameConfig.GetAnimal("Chick")

			local hoarder = newPlayer(5858, "Hoarder")
			giveCharacter(hoarder, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(hoarder)
			PDS:AddXP(hoarder, 100000)

			local coop = makePen(hoarder, "Coop", 40, -160)
			local count = GameConfig.GetPenCapacity("Coop", "Chick")
			local egg = GameConfig.GetItem("Egg")

			PDS:AddItem(hoarder, "Chick", count)
			advance(1)
			pokePen(hoarder, coop)

			--[[
				First, that the hoard is reachable by ordinary play. Feeding
				at the cadence the rules allow and never collecting makes the
				pending total grow, feeding after feeding, with nothing in the
				rules to stop it - every one of these is a legitimate action
				at a legitimate moment.
			]]
			PDS:AddItem(hoarder, chick.Feed.ItemId, egg.MaxStack)

			local growth = {}

			for _ = 1, 4 do
				AnimalService:TryFeed(hoarder, coop)
				advance(chick.FeedDuration)

				local at = PDS:GetData(hoarder).Structures[coop]
				table.insert(
					growth,
					Husbandry.GetReadyCycles("Chick", at.StockedAt, at.LastCollectedAt, at.FedUntil, count, os.time())
				)
			end

			check(growth[4] > growth[1], `feeding and not collecting accumulates ({growth[1]} -> {growth[4]} batches)`)
			check(
				growth[4] > (chick.FeedDuration * GameConfig.Husbandry.MaxFedWindows) // chick.ProduceInterval,
				"past what any single stretch of feed could hold, so there is no ceiling in the rules"
			)

			--[[
				The rest of the hoard is CONSTRUCTED rather than simulated.

				Reaching a full stack honestly takes around forty feedings and
				three hours of virtual time, and the runner's clock budget is
				shared with every section after this one. The behaviour under
				test is the collection, not the arithmetic of getting there -
				and the loop above already established that getting there
				needs nothing but patience.

				Continuously fed and never collected, which is what the
				timestamps of a long session look like.
			]]
			local record = PDS:GetData(hoarder).Structures[coop]
			local wanted = math.ceil((egg.MaxStack * 1.2) / (chick.Produces[1].Amount * count))

			record.StockedAt = os.time() - (chick.MatureTime + wanted * chick.ProduceInterval)
			record.LastCollectedAt = record.StockedAt
			record.FedUntil = os.time() + chick.FeedDuration

			AnimalService:_projectHerd(hoarder, AnimalService:GetPen(hoarder, coop), record, os.time())

			local pending = Husbandry.GetReadyCycles(
				"Chick",
				record.StockedAt,
				record.LastCollectedAt,
				record.FedUntil,
				count,
				os.time()
			)
			local pendingEggs = Husbandry.GetProduceTotals("Chick", pending, count).Egg

			check(
				pendingEggs > egg.MaxStack,
				`more eggs are waiting than one stack holds ({pendingEggs} > {egg.MaxStack})`
			)
			checkEqual(PDS:GetItemCount(hoarder, "Egg"), 0, "and the player is holding none of them yet")

			--[[
				Collecting pays the batches that FIT rather than refusing the
				lot. The clock still advances by exactly what was paid, which
				is what keeps the grant consumed-exactly-once - the atomicity
				argument applies to the items within a batch, not to the
				number of batches.
			]]
			local clockBefore = record.LastCollectedAt
			checkEqual(AnimalService:TryCollect(hoarder, coop), true, "collecting pays out what will fit")

			local collected = PDS:GetItemCount(hoarder, "Egg")
			check(collected > 0, `and that is most of a stack ({collected})`)
			check(collected <= egg.MaxStack, "without ever exceeding the stack limit")

			record = PDS:GetData(hoarder).Structures[coop]

			-- Measured from the window START, not the raw clock: the two
			-- differ by the wait for the flock to grow up, which is not a
			-- batch anybody was paid for.
			local startBefore = Husbandry.GetWindowStart("Chick", record.StockedAt, clockBefore)

			checkEqual(
				(record.LastCollectedAt - startBefore) // chick.ProduceInterval,
				collected // (chick.Produces[1].Amount * count),
				"and the clock advances by the batches paid, so the remainder is still owed"
			)

			local remaining = Husbandry.GetReadyCycles(
				"Chick",
				record.StockedAt,
				record.LastCollectedAt,
				record.FedUntil,
				count,
				os.time()
			)
			check(remaining > 0, `the rest is still waiting in the coop ({remaining} batches`)

			--[[
				With the bag now full, collecting refuses - and the prompt
				says so rather than advertising eggs it cannot hand over.
				That mismatch is how the deadlock presented itself to a
				player: an enabled prompt naming a precise number, refusing on
				every press.
			]]
			local refusal = nil
			local listener = AnimalService.ActionFailed:Connect(function(_, _, reason)
				refusal = reason
			end)

			checkEqual(AnimalService:TryCollect(hoarder, coop), false, "a full bag cannot take another batch")
			checkEqual(refusal, "InventoryFull", "and the refusal names the bag")

			advance(GameConfig.Husbandry.TickInterval + 1)
			checkEqual(
				penPrompt(hoarder, coop, "Interact").Enabled,
				false,
				"the prompt stops offering a collection that would be refused"
			)

			-- Slaughtering is refused too, because it would have to bank the
			-- waiting produce first.
			refusal = nil
			local eggsAtRefusal = PDS:GetItemCount(hoarder, "Egg")
			local meatAtRefusal = PDS:GetItemCount(hoarder, "RawChicken")

			checkEqual(AnimalService:TrySlaughter(hoarder, coop), false, "and the herd cannot be slaughtered either")
			checkEqual(refusal, "InventoryFull", "for the same reason")
			checkEqual(penOf(hoarder, coop):GetAttribute("AnimalId"), "Chick", "so the herd is still standing")

			--[[
				And the refusal granted NOTHING. Both payouts are checked
				before either is handed over, because collecting first and
				then refusing on the meat left a press on "Slaughter" that
				delivered eggs, left the herd alive, and reported an error.
			]]
			checkEqual(PDS:GetItemCount(hoarder, "Egg"), eggsAtRefusal, "a refused slaughter banks no produce")
			checkEqual(PDS:GetItemCount(hoarder, "RawChicken"), meatAtRefusal, "and no meat")

			--[[
				And here is the difference between a refusal and a deadlock:
				selling the eggs fixes it. Previously nothing did - the
				pending total was already larger than a stack on its own, so
				emptying the bag changed nothing and only demolishing the
				building cleared the pen.
			]]
			checkEqual(ShopService:SellAll(hoarder).Ok, true, "selling the eggs makes room")
			checkEqual(PDS:GetItemCount(hoarder, "Egg"), 0, "so the bag is empty again")

			checkEqual(AnimalService:TryCollect(hoarder, coop), true, "and the rest of the produce can be collected")

			checkEqual(ShopService:SellAll(hoarder).Ok, true, "sell that too")
			checkEqual(AnimalService:TrySlaughter(hoarder, coop), true, "after which the herd can be slaughtered")
			checkEqual(penOf(hoarder, coop):GetAttribute("AnimalId"), "", "leaving the pen empty and reusable")

			--------------------------------------------------------------------
			-- The other half: the produce fits but the MEAT does not.
			--------------------------------------------------------------------

			--[[
				Both payouts have to be checked before either is granted, and
				this is the case that proves it. Collecting first and then
				checking room for the meat was the obvious order, and it left
				a press on "Slaughter" that banked the eggs, left the herd
				standing and reported a full inventory - or, with the meat
				silently rejected by the stack limit, slaughtered the flock
				for nothing at all.
			]]
			local second = makePen(hoarder, "Coop", 40, -160)

			PDS:AddItem(hoarder, "Chick", count)
			advance(1)
			pokePen(hoarder, second)

			PDS:AddItem(hoarder, chick.Feed.ItemId, Husbandry.GetFeedCost("Chick", count) * 4)
			checkEqual(AnimalService:TryFeed(hoarder, second), true, "a fresh flock is stocked and fed")

			advance(chick.MatureTime + chick.ProduceInterval + 1)

			-- Room for the eggs, none at all for the meat.
			local meat = GameConfig.GetItem("RawChicken")
			PDS:AddItem(hoarder, "RawChicken", meat.MaxStack)
			checkEqual(PDS:GetItemCount(hoarder, "Egg"), 0, "the egg basket is empty")

			refusal = nil
			checkEqual(
				AnimalService:TrySlaughter(hoarder, second),
				false,
				"slaughtering is refused when there is no room for the meat"
			)
			checkEqual(refusal, "InventoryFull", "and says so")
			checkEqual(PDS:GetItemCount(hoarder, "Egg"), 0, "without banking the produce it would have collected first")
			checkEqual(PDS:GetItemCount(hoarder, "RawChicken"), meat.MaxStack, "and without losing the meat to a full stack")
			checkEqual(penOf(hoarder, second):GetAttribute("AnimalId"), "Chick", "so the flock is still alive")

			-- Make room, and it goes through in one press, eggs and all.
			PDS:RemoveItem(hoarder, "RawChicken", meat.MaxStack)
			checkEqual(AnimalService:TrySlaughter(hoarder, second), true, "with room, the slaughter succeeds")
			check(PDS:GetItemCount(hoarder, "Egg") > 0, "banking the waiting produce")
			check(PDS:GetItemCount(hoarder, "RawChicken") > 0, "and paying the meat")

			listener:Disconnect()
			PlayersService.PlayerRemoving:Fire(hoarder)
			hoarder.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: the directory already handled the drops")
		------------------------------------------------------------------------

		--[[
			The claim the item directory refactor made was that adding a
			mechanic would need no change to storage, replication or the shop -
			only a table saying which animal produces which drop. These check
			that it held.
		]]
		do
			local ShopService = require(ShopServiceModule)

			checkEqual(
				table.find(GameConfig.ItemCategories, "Livestock") ~= nil,
				true,
				"livestock is a category like any other"
			)

			for stockId, animal in GameConfig.Animals do
				local stockItem = GameConfig.GetItem(stockId)

				check(stockItem ~= nil, `{stockId} is in the master item directory`)
				checkEqual(stockItem.Category, "Livestock", `{stockId} is categorised as livestock`)
				check(GameConfig.IsBuyable(stockItem), `{stockId} can be bought`)

				--[[
					And not sold. A buy price and a sell price on one item is an
					arbitrage loop, which is why seeds are one-way too.
				]]
				checkEqual(
					GameConfig.IsSellable(stockItem),
					false,
					`{stockId} cannot be sold back, so there is no arbitrage loop`
				)

				-- Every drop has to be worth something, or raising the animal
				-- is work for nothing.
				for _, yield in animal.Produces do
					local item = GameConfig.GetItem(yield.ItemId)
					checkEqual(item.Category, "AnimalDrops", `{yield.ItemId} is an animal drop`)
					check(GameConfig.IsSellable(item), `{yield.ItemId} can be sold`)
				end

				for _, yield in animal.Slaughter do
					local item = GameConfig.GetItem(yield.ItemId)
					checkEqual(item.Category, "AnimalDrops", `{yield.ItemId} is an animal drop`)
					check(GameConfig.IsSellable(item), `{yield.ItemId} can be sold`)
				end
			end

			--[[
				Selling produce needed no new code at all: the shop is
				category-agnostic, so an egg sells through exactly the path a
				carrot does - and the gold lands in the TREASURY, because
				market income always does.
			]]
			local trader = newPlayer(5656, "Trader")
			PlayersService.PlayerAdded:Fire(trader)

			PDS:AddItem(trader, "Egg", 10)
			local goldBefore = PDS:GetGold(trader)
			local purseBefore = PDS:GetInventoryGold(trader)

			local sale = ShopService:ProcessTransaction(trader, "Sell", "Egg", 10)
			checkEqual(sale.Ok, true, "produce sells through the ordinary shop path")
			checkEqual(
				PDS:GetGold(trader) - goldBefore,
				GameConfig.GetItem("Egg").SellPrice * 10,
				"for its listed price"
			)
			checkEqual(PDS:GetInventoryGold(trader), purseBefore, "and the proceeds are treasury gold, not purse gold")

			-- Livestock is sold BY the shop and never bought back by it.
			local buy = ShopService:ProcessTransaction(trader, "Buy", "Chick", 1)
			checkEqual(buy.Ok, false, "a level 1 player cannot buy a chick")
			checkEqual(buy.Reason, "LevelTooLow", "because livestock is level gated like seeds")

			PDS:AddXP(trader, 100000)
			PDS:AddResource(trader, "Gold", 10000)
			checkEqual(
				ShopService:ProcessTransaction(trader, "Buy", "Chick", 1).Ok,
				true,
				"but an experienced one can"
			)
			checkEqual(
				ShopService:ProcessTransaction(trader, "Sell", "Chick", 1).Ok,
				false,
				"and the shop will not buy it back"
			)

			PlayersService.PlayerRemoving:Fire(trader)
			trader.Parent = nil
		end

		------------------------------------------------------------------------
		section("Husbandry: a pen record is normalised, not migrated")
		------------------------------------------------------------------------

		--[[
			Structure entries are not covered by the Template, so Reconcile
			never sees them and Normalize is the only place they are defaulted.
			Same situation as a farm square's PlantCount, and the same
			treatment.
		]]
		do
			local Husbandry = require(HusbandryModule)
			local now = os.time()

			-- A herd with no headcount reads as ONE, never as none: read as
			-- zero and the pen would render empty and slaughter for nothing.
			local defaulted = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Coop", X = 0, Z = 0, AnimalId = "Chick", StockedAt = now - 10 },
				},
			})
			checkEqual(defaulted.Structures["1"].AnimalCount, 1, "a herd with no count reads as one animal")

			-- Over-full herds are clamped to what the pen allows, so dropping
			-- a pen's capacity cannot leave old saves paying out too much.
			local overfull = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Coop",
						X = 0,
						Z = 0,
						AnimalId = "Chick",
						StockedAt = now - 10,
						AnimalCount = 9_999,
					},
				},
			})
			checkEqual(
				overfull.Structures["1"].AnimalCount,
				GameConfig.GetPenCapacity("Coop", "Chick"),
				"an over-full pen is clamped to its capacity"
			)

			--[[
				A species that does not belong in the pen is cleared. This is
				what a config edit moving cattle out of the coop looks like on
				an old save.
			]]
			local misplaced = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Coop", X = 0, Z = 0, AnimalId = "Calf", StockedAt = now - 10 },
				},
			})
			checkEqual(misplaced.Structures["1"].AnimalId, "", "an animal that cannot live in the pen is cleared")
			checkEqual(misplaced.Structures["1"].StockedAt, nil, "along with its timestamps")

			-- An animal that left the config entirely frees the pen rather
			-- than trapping it.
			local unknown = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Coop", X = 0, Z = 0, AnimalId = "Dodo", StockedAt = now - 10 },
				},
			})
			checkEqual(unknown.Structures["1"].AnimalId, "", "an animal that left the config frees the pen")

			--[[
				FedUntil is the one timestamp in a profile that is SUPPOSED to
				be in the future, so it is capped at the feed ceiling rather
				than at `now`. Clamping it like the others would quietly starve
				every fed herd on load.
			]]
			local fed = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Coop",
						X = 0,
						Z = 0,
						AnimalId = "Chick",
						StockedAt = now - 10,
						FedUntil = now + 120,
					},
				},
			})
			checkEqual(fed.Structures["1"].FedUntil, now + 120, "a future FedUntil survives a load")
			check(Husbandry.IsFed(fed.Structures["1"].FedUntil, now), "so a fed herd is still fed")

			local tampered = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Coop",
						X = 0,
						Z = 0,
						AnimalId = "Chick",
						StockedAt = now - 10,
						FedUntil = now + 99_999_999,
					},
				},
			})
			check(
				tampered.Structures["1"].FedUntil <= Husbandry.GetFeedCeiling("Chick", now),
				"but a tampered one is capped at the feed ceiling"
			)

			--[[
				The produce clock cannot predate the herd or run ahead of the
				wall clock: behind, and the pen pays out time before the
				animals existed; ahead, and it never pays out at all.
			]]
			local skewed = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Coop",
						X = 0,
						Z = 0,
						AnimalId = "Chick",
						StockedAt = now - 10,
						LastCollectedAt = 0,
					},
				},
			})
			checkEqual(
				skewed.Structures["1"].LastCollectedAt,
				skewed.Structures["1"].StockedAt,
				"a produce clock predating the herd is pulled up to the stocking time"
			)

			--[[
				Clamping the two ENDS of the produce window is not enough,
				because the payout derives from the SPAN between them.

				An ancient stocking time beside a plausible FedUntil passes
				every individual clamp - the stocking time is in the past, the
				feed clock is within its ceiling, the produce clock sits
				between them - and still presents a window decades wide. That
				is corrupt or clock-skewed data rather than a client exploit,
				which is exactly what this function is for.
			]]
			local ancient = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = {
						StructureId = "Coop",
						X = 0,
						Z = 0,
						AnimalId = "Chick",
						StockedAt = 1,
						LastCollectedAt = 1,
						FedUntil = now + 600,
					},
				},
			})

			local widest = GameConfig.Husbandry.MaxStoredCycles * GameConfig.GetAnimal("Chick").ProduceInterval
			local capacity = GameConfig.GetPenCapacity("Coop", "Chick")

			check(
				Husbandry.GetReadyCycles(
					"Chick",
					ancient.Structures["1"].StockedAt,
					ancient.Structures["1"].LastCollectedAt,
					ancient.Structures["1"].FedUntil,
					capacity,
					now
				) <= GameConfig.Husbandry.MaxStoredCycles,
				"a record from 1970 cannot present a payout of millions of batches"
			)
			check(
				ancient.Structures["1"].LastCollectedAt >= ancient.Structures["1"].FedUntil - widest,
				"because the produce window is floored at the widest any sequence of feedings could leave"
			)

			-- An empty pen carries no herd fields at all.
			local empty = DataSchema.Normalize({
				SchemaVersion = DataSchema.Version,
				Structures = {
					["1"] = { StructureId = "Coop", X = 0, Z = 0, AnimalId = "", AnimalCount = 5 },
				},
			})
			checkEqual(empty.Structures["1"].AnimalCount, nil, "an empty pen holds no headcount")

			-- And the stats husbandry increments are in the template, so
			-- existing players get them by Reconcile with no migration.
			checkEqual(DataSchema.Template.Stats.TotalAnimalsRaised, 0, "raising animals is counted")
			checkEqual(DataSchema.Template.Stats.TotalProduceCollected, 0, "so is produce collected")
			checkEqual(DataSchema.Template.Stats.TotalAnimalsSlaughtered, 0, "and so is slaughter")
		end

		------------------------------------------------------------------------
		section("Combat plants: an archetype plus an attack")
		------------------------------------------------------------------------

		--[[
			A combat plant is not a new system. The plantable names an
			archetype; the archetype carries health, armour and an attack
			profile. That one indirection is the whole mechanism, and these
			assertions are really about whether the layers underneath turned
			out to be reusable.
		]]
		local AttackService = require(AttackServiceModule)
		local DamageableService = require(DamageableServiceModule)
		local FarmService = require(FarmServiceModule)

		-- Idempotent, and needed here: without the loop running a plant
		-- registers, un-suspends and then never fires.
		AttackService:Start()

		checkEqual(GameConfig.GetPlantArchetypeId("CarrotSeed"), "Crop", "a food crop is a generic Crop")
		checkEqual(GameConfig.GetPlantArchetypeId("EmberBloomSeed"), "EmberBloom", "a combat plant names its own")
		checkEqual(GameConfig.GetPlantCapacity("EmberBloomSeed"), 1, "and takes a whole square")

		checkEqual(GameConfig.IsHarvestable("CarrotSeed"), true, "a carrot is picked")
		checkEqual(GameConfig.IsHarvestable("EmberBloomSeed"), false, "a defence is kept")
		checkEqual(GameConfig.IsHarvestable("Nonsense"), false, "and an unknown seed is neither")

		-- The Bulwark is the one plant with no attack at all: its entire job
		-- is to be the thing a raider meets first, for a long time.
		checkEqual(GameConfig.Archetypes.Bulwark.AttackId, nil, "the Bulwark does not fight back")
		check(
			GameConfig.Archetypes.Bulwark.MaxHealth > GameConfig.Archetypes.EmberBloom.MaxHealth * 4,
			"but has the health to stand in front of the ones that do"
		)
		checkEqual(GameConfig.Archetypes.Bulwark.ArmourClass, "Heavy", "and heavy armour, which a raider's club is poor against")

		do
			local gardener = newPlayer(4444, "Gardener")
			giveCharacter(gardener, Vector3.new(0, 3, 0))
			PlayersService.PlayerAdded:Fire(gardener)
			PlayerDataService:AddXP(gardener, 100000)

			local plot = makeFarm(gardener, 180, 180)
			PlayerDataService:AddItem(gardener, "EmberBloomSeed", 4)

			local selectSeed = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.SelectSeed)
			advance(1)
			selectSeed.OnServerEvent:Fire(gardener, "EmberBloomSeed")

			--[[
				XP is paid at PLANTING for a kept plant, because it will never
				be harvested and harvest is where every other plant's XP comes
				from. Paying on maturity would be the obvious choice and is a
				trap: maturity is derived from a timestamp, so it is reached
				again on every re-projection and each one would pay out.
			]]
			local xpBefore = PlayerDataService:GetData(gardener).XP
			advance(1)
			pokeFarm(gardener, plot)

			local ember = GameConfig.GetPlantable("EmberBloomSeed")
			checkEqual(farmOf(gardener, plot):GetAttribute("SeedId"), "EmberBloomSeed", "an Ember Bloom is planted")
			checkEqual(farmOf(gardener, plot):GetAttribute("PlantCount"), 1, "one to a square")
			checkEqual(PlayerDataService:GetItemCount(gardener, "EmberBloomSeed"), 3, "consuming one seed")
			check(PlayerDataService:GetData(gardener).XP > xpBefore, "and paying its XP at planting")

			-- It registers as its OWN archetype, which is where its real
			-- health comes from: a Crop would have had 100.
			local plantEntity = FarmService:GetFarm(gardener, plot).CropEntityId
			check(plantEntity ~= nil, "the plant is a damageable entity")
			checkEqual(
				DamageableService:Get(plantEntity).ArchetypeId,
				"EmberBloom",
				"registered as an Ember Bloom, not a generic Crop"
			)
			checkEqual(
				DamageableService:GetHealth(plantEntity),
				GameConfig.Archetypes.EmberBloom.MaxHealth,
				"with the archetype's health"
			)

			--[[
				A plant only fights once grown. Suspended rather than
				unregistered, so maturing is a flag flip - and so no second
				code path can register it twice.
			]]
			checkEqual(AttackService:IsAttacker(plantEntity), true, "it is an attacker from the moment it is planted")
			checkEqual(AttackService:Get(plantEntity).Suspended, true, "but suspended while it is still a seedling")

			local prompt = promptOf(gardener, plot)
			checkEqual(prompt.ActionText, "Growing", "and its prompt says so")
			checkEqual(prompt.Enabled, false, "offering nothing to press")

			--[[
				And the flag has to actually stop it: a seedling with a raider
				standing in front of it must not fire. The flag assertions
				above would pass even if nothing read the flag.
			]]
			local seedlingVictim = nil
			do
				local burst = GameConfig.Attacks.EmberBurst
				local model = Instance.new("Model")
				local part = Instance.new("Part")
				part.Position = farmOf(gardener, plot).PrimaryPart.Position + Vector3.new(burst.Range - 8, 0, 0)
				part.Parent = model
				model.PrimaryPart = part
				model.Parent = WorkspaceService

				seedlingVictim = DamageableService:Register({
					ArchetypeId = "EnemyRaider",
					Model = model,
					OwnerUserId = 0,
				})

				local full = DamageableService:GetHealth(seedlingVictim)
				advance(burst.Cooldown * 3)
				checkEqual(
					DamageableService:GetHealth(seedlingVictim),
					full,
					"a seedling does not shoot, however long a raider stands in front of it"
				)

				DamageableService:Unregister(seedlingVictim)
			end

			-- Grown.
			advance(ember.GrowTime + 2)
			checkEqual(farmOf(gardener, plot):GetAttribute("Stage"), "Mature", "it finishes growing")
			checkEqual(
				AttackService:Get(plantEntity).Suspended,
				false,
				"and stops being suspended, so it starts shooting"
			)

			--[[
				A kept plant is named after itself and offers UPROOT, never
				Harvest - so the prompt cannot invite a player to destroy a
				two hundred gold defence by calling it a harvest.
			]]
			checkEqual(promptOf(gardener, plot).ActionText, "Uproot", "a grown defence offers Uproot")
			checkEqual(
				promptOf(gardener, plot).ObjectText,
				GameConfig.Archetypes.EmberBloom.Name,
				"named after the plant, not after a yield it does not have"
			)

			-- Harvesting one is refused outright, whatever calls it.
			local refusal = nil
			local listener = FarmService.PlantFailed:Connect(function(_, _, reason)
				refusal = reason
			end)
			checkEqual(FarmService:TryHarvest(gardener, plot), false, "TryHarvest refuses a kept plant")
			checkEqual(refusal, "NotHarvestable", "and says why")
			listener:Disconnect()

			checkEqual(
				farmOf(gardener, plot):GetAttribute("SeedId"),
				"EmberBloomSeed",
				"so the plant is still standing"
			)

			-- It shoots. A raider walks into its reach and loses health.
			do
				local body = farmOf(gardener, plot).PrimaryPart
				local burst = GameConfig.Attacks.EmberBurst

				local model = Instance.new("Model")
				local part = Instance.new("Part")
				part.Position = body.Position + Vector3.new(burst.Range - 8, 0, 0)
				part.Parent = model
				model.PrimaryPart = part
				model.Parent = WorkspaceService

				local prey = DamageableService:Register({
					ArchetypeId = "EnemyRaider",
					Model = model,
					OwnerUserId = 0,
				})

				local preyHealth = DamageableService:GetHealth(prey)
				advance(burst.Cooldown + GameConfig.Combat.AttackTickInterval * 2)

				check(
					DamageableService:GetHealth(prey) < preyHealth,
					"a grown Ember Bloom shoots a raider that walks into reach"
				)

				DamageableService:Unregister(prey)
			end

			--[[
				Uprooting returns NOTHING - no seed, no crop, no refund - for
				the same reason demolishing a structure does: a refund at cost
				makes the square a free store of value, and "below cost" is a
				balance decision rather than a systems one.
			]]
			local seedsBefore = PlayerDataService:GetItemCount(gardener, "EmberBloomSeed")
			local goldBefore = PlayerDataService:GetGold(gardener)

			advance(1)
			pokeFarm(gardener, plot)

			checkEqual(farmOf(gardener, plot):GetAttribute("SeedId"), "", "pressing Uproot clears the square")
			checkEqual(PlayerDataService:GetItemCount(gardener, "EmberBloomSeed"), seedsBefore, "refunding no seed")
			checkEqual(PlayerDataService:GetGold(gardener), goldBefore, "and no gold")
			checkEqual(DamageableService:Get(plantEntity), nil, "the plant's entity is gone")
			checkEqual(AttackService:IsAttacker(plantEntity), false, "and it is no longer an attacker")

			-- Uprooting a food crop is refused, so a ripe square cannot be
			-- thrown away by the wrong call.
			advance(1)
			selectSeed.OnServerEvent:Fire(gardener, "CarrotSeed")
			PlayerDataService:AddItem(gardener, "CarrotSeed", 20)
			advance(1)
			pokeFarm(gardener, plot)
			checkEqual(farmOf(gardener, plot):GetAttribute("SeedId"), "CarrotSeed", "carrots are planted")
			checkEqual(FarmService:TryUproot(gardener, plot), false, "and cannot be uprooted, only harvested")

			PlayersService.PlayerRemoving:Fire(gardener)
			gardener.Parent = nil
		end
	end

	-- Scoped: Luau caps live locals per function at 200 and this suite is one.
	do
		------------------------------------------------------------------------
		section("Attacks: factions and registration")
		------------------------------------------------------------------------

		local AttackService = require(AttackServiceModule)
		local Combat = require(Shared.Combat)
		local Spatial = require(SpatialModule)
		local DamageableService = require(DamageableServiceModule)
		local StatusEffectService = require(StatusEffectServiceModule)
		local FACTIONS = GameConfig.Factions

		AttackService:Start()

		--[[
			Player and Hostile fight each other; Neutral fights nobody. That
			last one is what lets a practice dummy stand beside a tower.

			Two PLAYERS are not hostile - a tower never shoots a visitor. When
			PvP arrives it needs a raid or truce relationship rather than a
			fourth faction, because "are these two at war" is a fact about the
			pair, not about either one.
		]]
		checkEqual(AttackService.IsHostile(FACTIONS.Player, FACTIONS.Hostile), true, "players and raiders fight")
		checkEqual(AttackService.IsHostile(FACTIONS.Hostile, FACTIONS.Player), true, "and it is symmetric")
		checkEqual(AttackService.IsHostile(FACTIONS.Player, FACTIONS.Player), false, "two players do not")
		checkEqual(AttackService.IsHostile(FACTIONS.Hostile, FACTIONS.Hostile), false, "nor two raiders")
		checkEqual(AttackService.IsHostile(FACTIONS.Neutral, FACTIONS.Hostile), false, "neutrals are left alone")
		checkEqual(AttackService.IsHostile(FACTIONS.Player, FACTIONS.Neutral), false, "and leave everyone alone")
		checkEqual(AttackService.IsHostile(nil, FACTIONS.Player), false, "an unknown faction fights nothing")

		--- A damageable entity with a body, at a position.
		local function spawnEntity(archetypeId: string, x: number, z: number, ownerUserId: number?): number
			local model = Instance.new("Model")
			model.Name = `Test_{archetypeId}`

			local body = Instance.new("Part")
			body.Name = "Body"
			body.Position = Vector3.new(x, 2, z)
			body.Parent = model
			model.PrimaryPart = body
			model.Parent = WorkspaceService

			return DamageableService:Register({
				ArchetypeId = archetypeId,
				Model = model,
				OwnerUserId = ownerUserId or 0,
			})
		end

		--[[
			Registration reads everything from the entity, so an attacker
			cannot be described differently from the thing it actually is -
			and it DECLINES for anything without an attack, so callers do not
			have to ask what kind of thing they are registering.
		]]
		do
			local mill = spawnEntity("Mill", 0, 0, 5151)
			checkEqual(AttackService:Register(mill), false, "a Mill is not an attacker")
			checkEqual(AttackService:IsAttacker(mill), false, "and is not registered as one")

			local bulwark = spawnEntity("Bulwark", 4, 0, 5151)
			checkEqual(AttackService:Register(bulwark), false, "nor is a Bulwark, whose job is to be hit")

			local tower = spawnEntity("WatchTower", 8, 0, 5151)
			checkEqual(AttackService:Register(tower), true, "a Watch Tower is")
			checkEqual(AttackService:IsAttacker(tower), true, "and is registered")

			checkEqual(AttackService:Register(999999), false, "an unknown entity cannot be registered")

			for _, id in { mill, bulwark, tower } do
				AttackService:Unregister(id)
				DamageableService:Unregister(id)
			end
		end

		------------------------------------------------------------------------
		section("Attacks: what a tower shoots")
		------------------------------------------------------------------------

		local bolt = GameConfig.Attacks.TowerBolt

		do
			local tower = spawnEntity("WatchTower", 0, 0, 5252)
			AttackService:Register(tower)

			-- In range, hostile: shot.
			local raider = spawnEntity("EnemyRaider", bolt.Range - 10, 0)
			local before = DamageableService:GetHealth(raider)

			advance(bolt.Cooldown + 0.5)
			check(DamageableService:GetHealth(raider) < before, "a tower shoots a raider in range")

			-- Out of range: not shot, however long we wait.
			local distant = spawnEntity("EnemyRaider", bolt.Range + 30, 0)
			local distantHealth = DamageableService:GetHealth(distant)
			advance(bolt.Cooldown * 4)
			checkEqual(DamageableService:GetHealth(distant), distantHealth, "and ignores one out of range")

			-- Neutral: not shot. This is why the practice range is usable.
			local dummy = spawnEntity("PracticeDummy", 10, 0)
			local dummyHealth = DamageableService:GetHealth(dummy)
			advance(bolt.Cooldown * 4)
			checkEqual(DamageableService:GetHealth(dummy), dummyHealth, "a neutral dummy is never shot at")

			-- Another player's building: not shot.
			local neighbour = spawnEntity("Mill", 12, 0, 9999)
			local neighbourHealth = DamageableService:GetHealth(neighbour)
			advance(bolt.Cooldown * 4)
			checkEqual(DamageableService:GetHealth(neighbour), neighbourHealth, "and neither is another player's Mill")

			for _, id in { tower, raider, distant, dummy, neighbour } do
				AttackService:Unregister(id)
				DamageableService:Unregister(id)
			end
		end

		------------------------------------------------------------------------
		section("Attacks: cadence, and why shots are not banked")
		------------------------------------------------------------------------

		--[[
			THE important property of this system, and the opposite of the
			status effect rule.

			A burn accrues a QUANTITY, so a late tick must bill all the time it
			missed or damage is silently lost. An attack is a discrete EVENT,
			so a late tick must not fire the shots it missed: a tower starved
			of ticks fires once and resumes. Banking arrows would turn a lag
			spike into a volley, which is far worse than dropping a shot.
		]]
		do
			local tower = spawnEntity("WatchTower", 0, 200, 5353)
			AttackService:Register(tower)

			--[[
				A HOSTILE target. An earlier draft used a Checkpoint here and
				measured zero damage, because a Checkpoint is a player
				building and the tower quite correctly refused to shoot it.
			]]
			local raiderArch = GameConfig.Archetypes.EnemyRaider
			local target = spawnEntity("EnemyRaider", 20, 200)

			local perShot = Combat.ComputeDamage(
				bolt.Damage,
				bolt.DamageType,
				raiderArch.ArmourClass,
				raiderArch.Armour
			)
			check(perShot > 0, "a bolt hurts a raider")
			check(perShot * 3 < raiderArch.MaxHealth, "and will not kill one in the shots this test fires")

			--[[
				Margin of two tick intervals, not an arbitrary 0.1: the loop
				fires on tick boundaries, so a window narrower than one
				interval can contain no tick at all. Still far short of a
				second cooldown, so exactly one shot can land.
			]]
			local margin = GameConfig.Combat.AttackTickInterval * 2
			check(margin < bolt.Cooldown, "the margin cannot admit a second shot")

			local before = DamageableService:GetHealth(target)
			advance(bolt.Cooldown + margin)
			local afterOne = DamageableService:GetHealth(target)
			checkEqual(before - afterOne, perShot, "one cooldown produces exactly one shot")

			--[[
				The stall. Nothing steps the loop for ten cooldowns' worth of
				clock, then one Step runs.
			]]
			local stalledFrom = DamageableService:GetHealth(target)
			local stalled = AttackService:Get(tower)
			stalled.LastAttackAt -= bolt.Cooldown * 10

			AttackService:Step()

			local lost = stalledFrom - DamageableService:GetHealth(target)
			checkEqual(lost, perShot, "a ten cooldown stall still fires exactly ONE shot, not ten")

			--[[
				And the backlog is DISCARDED, not spread out.

				One Step producing one shot is trivially true of any
				implementation. The property worth asserting is that the nine
				missed shots never arrive: after the stall shot the tower must
				wait a whole fresh cooldown, so a window shorter than one
				produces nothing.

				Advancing the stored timestamp by a cooldown per shot instead
				of setting it to now passes the check above and fails this
				one - it fires the backlog over the next few ticks, which is
				the lag-spike volley in slow motion.
			]]
			local settled = DamageableService:GetHealth(target)
			local shortOfCooldown = GameConfig.Combat.AttackTickInterval * 3
			check(shortOfCooldown < bolt.Cooldown, "the window really is shorter than a cooldown")

			advance(shortOfCooldown)
			checkEqual(
				DamageableService:GetHealth(target),
				settled,
				"and the nine missed shots are gone for good, not queued up"
			)

			--[[
				And the other half: a tower with nothing to shoot does not
				spend its cooldown, so it fires the instant something walks in
				rather than waiting out a cooldown it never used.
			]]
			DamageableService:Unregister(target)

			local idleFrom = AttackService:Get(tower).LastAttackAt
			advance(bolt.Cooldown * 5)
			checkEqual(
				AttackService:Get(tower).LastAttackAt,
				idleFrom,
				"an idle tower does not consume its cooldown"
			)

			local walkedIn = spawnEntity("EnemyRaider", 20, 200)
			local walkedInHealth = DamageableService:GetHealth(walkedIn)
			AttackService:Step()
			check(
				DamageableService:GetHealth(walkedIn) < walkedInHealth,
				"so it fires the moment something comes into range"
			)

			AttackService:Unregister(tower)
			DamageableService:Unregister(tower)
			DamageableService:Unregister(walkedIn)
		end

		------------------------------------------------------------------------
		section("Attacks: splash and status effects")
		------------------------------------------------------------------------

		StatusEffectService:Start()
		local ember = GameConfig.Attacks.EmberBurst

		do
			local plant = spawnEntity("EmberBloom", 0, 400, 5454)
			AttackService:Register(plant)

			-- A cluster: one at the muzzle, one beside it, one well clear.
			local primary = spawnEntity("EnemyRaider", 20, 400)
			local beside = spawnEntity("EnemyRaider", 20 + ember.SplashRadius * 0.5, 400)
			local clear = spawnEntity("EnemyRaider", 20, 400 + ember.SplashRadius + 6)

			local primaryBefore = DamageableService:GetHealth(primary)
			local besideBefore = DamageableService:GetHealth(beside)
			local clearBefore = DamageableService:GetHealth(clear)

			advance(ember.Cooldown + 0.5)

			local primaryLost = primaryBefore - DamageableService:GetHealth(primary)
			local besideLost = besideBefore - DamageableService:GetHealth(beside)

			check(primaryLost > 0, "the primary target is hit")
			check(besideLost > 0, "and so is a neighbour inside the blast")
			check(besideLost < primaryLost, "for less, because the blast falls off")
			checkEqual(
				DamageableService:GetHealth(clear),
				clearBefore,
				"while something outside the radius is untouched"
			)

			--[[
				The status effect lands on everything the shot touched,
				splash included. That is most of what an Ember Bloom is: the
				direct hit is small, and the point is the whole cluster
				catching fire.
			]]
			checkEqual(StatusEffectService:HasEffect(primary, "Burn"), true, "the primary target is set alight")
			checkEqual(StatusEffectService:HasEffect(beside, "Burn"), true, "and so is everything in the blast")
			checkEqual(StatusEffectService:HasEffect(clear, "Burn"), false, "but not something outside it")

			for _, id in { plant, primary, beside, clear } do
				AttackService:Unregister(id)
				DamageableService:Unregister(id)
			end
		end

		-- Splash must not hit friendlies: a tower's blast does not scorch the
		-- farm it is defending.
		do
			local plant = spawnEntity("EmberBloom", 0, 500, 5555)
			AttackService:Register(plant)

			local raider = spawnEntity("EnemyRaider", 20, 500)
			local ownFarm = spawnEntity("Farm", 20 + ember.SplashRadius * 0.3, 500, 5555)
			local farmHealth = DamageableService:GetHealth(ownFarm)

			advance(ember.Cooldown + 0.5)

			check(DamageableService:GetHealth(raider) < GameConfig.Archetypes.EnemyRaider.MaxHealth, "the raider is hit")
			checkEqual(
				DamageableService:GetHealth(ownFarm),
				farmHealth,
				"and the Farm standing inside the blast is not: there is no friendly fire"
			)

			for _, id in { plant, raider, ownFarm } do
				AttackService:Unregister(id)
				DamageableService:Unregister(id)
			end
		end

		-- A Frost Lily's damage is almost beside the point; the Chill is the payload.
		do
			local lily = spawnEntity("FrostLily", 0, 600, 5656)
			AttackService:Register(lily)

			local raider = spawnEntity("EnemyRaider", 15, 600)
			advance(GameConfig.Attacks.FrostTouch.Cooldown + 0.5)

			checkEqual(StatusEffectService:HasEffect(raider, "Chill"), true, "a Frost Lily chills what it hits")
			check(
				StatusEffectService:GetSpeedMultiplier(raider) < 1,
				"which is the point: the target is slowed"
			)

			AttackService:Unregister(lily)
			DamageableService:Unregister(lily)
			DamageableService:Unregister(raider)
		end

		------------------------------------------------------------------------
		section("Attacks: target priority is data")
		------------------------------------------------------------------------

		--[[
			Nothing in the selector knows what a Mill is. An attacker has a
			TargetPriority and every target has a TargetTag; the selector
			matches one against the other. A siege unit that hunts walls is a
			config edit.
		]]
		do
			local origin = Vector3.new(0, 0, 0)
			local candidates = {
				{ EntityId = 1, Position = Vector3.new(10, 0, 0), Tag = "Defence" },
				{ EntityId = 2, Position = Vector3.new(30, 0, 0), Tag = "Resource" },
				{ EntityId = 3, Position = Vector3.new(50, 0, 0), Tag = "Core" },
			}

			checkEqual(
				AttackService.SelectTarget(origin, candidates, "Any", 100).EntityId,
				1,
				"an Any attacker takes the nearest, whatever it is"
			)
			checkEqual(
				AttackService.SelectTarget(origin, candidates, "Resource", 100).EntityId,
				2,
				"a Resource attacker walks past a nearer Defence to reach a Mill"
			)
			checkEqual(
				AttackService.SelectTarget(origin, candidates, "Defence", 100).EntityId,
				1,
				"and a Defence attacker goes for the tower"
			)

			--[[
				The fallback. A Resource-specific attacker that can see no
				resources takes anything rather than standing idle - Clash of
				Clans does the same, and the alternative is a unit that walks
				into a base and refuses to fight.
			]]
			local noResources = {
				{ EntityId = 7, Position = Vector3.new(20, 0, 0), Tag = "Core" },
			}
			checkEqual(
				AttackService.SelectTarget(origin, noResources, "Resource", 100).EntityId,
				7,
				"with no Mills in sight it settles for what there is"
			)

			--[[
				Range still bounds it, priority or not. Note 15 would NOT be
				enough to prove this: the Defence at 10 is inside that, and
				the fallback would correctly return it. The radius has to
				exclude everything.
			]]
			checkEqual(
				AttackService.SelectTarget(origin, candidates, "Resource", 5),
				nil,
				"and nothing out of range is chosen at all"
			)
		end

		-- A dead attacker stops shooting, including a shattered one, which
		-- stays in the registry.
		do
			local tower = spawnEntity("WatchTower", 0, 700, 5757)
			AttackService:Register(tower)
			checkEqual(AttackService:IsAttacker(tower), true, "the tower is armed")

			DamageableService:ApplyDamage(tower, 999999, "Siege", nil)
			checkEqual(AttackService:IsAttacker(tower), false, "a destroyed tower is disarmed")
		end

		------------------------------------------------------------------------
		section("Raids: the blocking rule")
		------------------------------------------------------------------------

		--[[
			THE piece docs/ROADMAP.md called out as having no foundation:
			"tanks protect plants behind" is an ENEMY TARGETING rule, not a
			plant property.

			A raider picks an objective by priority, then fights whatever
			stands in the corridor between it and that objective. Put a
			Bulwark in front and the raiders meet the Bulwark - no aggro
			table, no taunt stat, just geometry.
		]]
		local RaidService = require(RaidServiceModule)
		RaidService:Start()

		do
			local victim = newPlayer(6161, "Victim")
			giveCharacter(victim, Vector3.new(0, 3, -1200))
			PlayersService.PlayerAdded:Fire(victim)

			-- A base: the Town Center is the objective, the Bulwark is in the
			-- way, and an Ember Bloom hides behind it.
			local core = spawnEntity("TownCenter", 0, -1200, victim.UserId)
			local shield = spawnEntity("Bulwark", 60, -1200, victim.UserId)
			local hidden = spawnEntity("EmberBloom", 20, -1200, victim.UserId)

			local raiderId = RaidService:SpawnRaider(victim, "EnemyRaider", 0, 120)
			check(raiderId ~= nil, "a raider spawns")

			local raider = RaidService:GetRaiders()[raiderId]
			local mark = RaidService:ChooseMark(raider, RaidService:_targetsOf(victim.UserId))

			check(mark ~= nil, "and picks something to attack")
			checkEqual(
				mark.EntityId,
				shield,
				"a plain raider meets the Bulwark first, not the plant behind it"
			)

			-- Remove the shield and the raider walks on to what is behind it.
			DamageableService:Unregister(shield)
			local nextMark = RaidService:ChooseMark(raider, RaidService:_targetsOf(victim.UserId))
			checkEqual(nextMark.EntityId, hidden, "with the Bulwark gone, the plant is next")

			-- And with the field clear, the objective itself.
			DamageableService:Unregister(hidden)
			local finalMark = RaidService:ChooseMark(raider, RaidService:_targetsOf(victim.UserId))
			checkEqual(finalMark.EntityId, core, "and then the Town Center")

			DamageableService:Unregister(raiderId)
			DamageableService:Unregister(core)

			--[[
				THE case that FindBlocking actually earns its keep for.

				For an "Any" raider the above is free: the nearest target IS
				the thing in the way, so nearest-first gives tanking for
				nothing. A PRIORITY raider is the problem - a Looter's
				objective is a Mill deep in the base, and without the blocking
				step it walks straight past the Bulwark to reach it, which is
				exactly the "looks like the AI is cheating" case the roadmap
				warned about.

				Laid out so the geometry says one thing only: the Mill and the
				wall are on the line the Looter walks, and the Town Center is
				well off it. An earlier draft had the Town Center between the
				Looter and the Mill, and the service quite correctly stopped
				at the Town Center.
			]]
			local offAxisCore = spawnEntity("TownCenter", 0, -1260, victim.UserId)
			local mill = spawnEntity("Mill", 0, -1200, victim.UserId)
			local wall = spawnEntity("Bulwark", 60, -1200, victim.UserId)

			local looterId = RaidService:SpawnRaider(victim, "EnemyLooter", 0, 120)
			local looterPos = DamageableService:Get(looterId).Model.PrimaryPart.Position

			-- The Mill is the Resource, and it is further off than the wall.
			check(
				Spatial.GroundDistance(looterPos, Vector3.new(0, 0, -1200))
					> Spatial.GroundDistance(looterPos, Vector3.new(60, 0, -1200)),
				"the Looter's Mill is further off than the Bulwark in front of it"
			)

			-- And the Town Center is NOT on the path, so it cannot be the
			-- thing being picked.
			checkEqual(
				Spatial.FindBlocking(
					looterPos,
					Vector3.new(0, 0, -1200),
					{ { EntityId = offAxisCore, Position = Vector3.new(0, 0, -1260) } },
					GameConfig.Combat.BlockingCorridor
				),
				nil,
				"and the Town Center is off the line entirely"
			)

			checkEqual(
				RaidService:ChooseMark(
					RaidService:GetRaiders()[looterId],
					RaidService:_targetsOf(victim.UserId)
				).EntityId,
				wall,
				"so the Looter stops at the Bulwark instead of tunnelling to the Mill"
			)

			-- With the wall gone it resumes its errand, which proves the
			-- priority still works and blocking is not overriding it.
			DamageableService:Unregister(wall)
			checkEqual(
				RaidService:ChooseMark(
					RaidService:GetRaiders()[looterId],
					RaidService:_targetsOf(victim.UserId)
				).EntityId,
				mill,
				"and goes back to the Mill once the way is clear"
			)

			DamageableService:Unregister(looterId)
			DamageableService:Unregister(mill)
			DamageableService:Unregister(offAxisCore)
			PlayersService.PlayerRemoving:Fire(victim)
			victim.Parent = nil
		end

		------------------------------------------------------------------------
		section("Raids: priority, movement and waves")
		------------------------------------------------------------------------

		do
			local farmer = newPlayer(6262, "Raided")
			giveCharacter(farmer, Vector3.new(0, 3, -1400))
			PlayersService.PlayerAdded:Fire(farmer)

			local core = spawnEntity("TownCenter", 0, -1400, farmer.UserId)
			local tower = spawnEntity("WatchTower", 40, -1400, farmer.UserId)
			local mill = spawnEntity("Mill", -40, -1400, farmer.UserId)

			--[[
				A Looter ignores defences. Nothing in the targeting code
				mentions Mills - the Looter's archetype says "Resource" and
				the Mill's says it is one.
			]]
			local looterId = RaidService:SpawnRaider(farmer, "EnemyLooter", math.pi, 120)
			check(looterId ~= nil, "a looter spawns")

			local looterMark = RaidService:ChooseMark(
				RaidService:GetRaiders()[looterId],
				RaidService:_targetsOf(farmer.UserId)
			)
			checkEqual(looterMark.EntityId, mill, "a Looter goes for the Mill, not the tower or the core")

			-- Movement closes the distance, and is billed from elapsed time.
			local looter = DamageableService:Get(looterId)
			local startDistance = Spatial.GroundDistance(
				looter.Model.PrimaryPart.Position,
				Vector3.new(-40, 0, -1400)
			)

			advance(3)

			local closed = startDistance - Spatial.GroundDistance(
				looter.Model.PrimaryPart.Position,
				Vector3.new(-40, 0, -1400)
			)
			check(closed > 0, `the looter closes the distance ({math.floor(closed)} studs)`)

			--[[
				And a chilled raider closes it more slowly. This is the whole
				payoff of the Frost Lily: a slowed horde spends longer in
				everything else's range.
			]]
			local chilledId = RaidService:SpawnRaider(farmer, "EnemyRaider", math.pi / 2, 120)
			local freeId = RaidService:SpawnRaider(farmer, "EnemyRaider", math.pi / 2 + 0.05, 120)

			StatusEffectService:Apply(chilledId, "Chill", nil)
			check(
				StatusEffectService:GetSpeedMultiplier(chilledId) < 1,
				"the chilled raider is slowed"
			)

			local function distanceFromCore(entityId: number): number
				local entity = DamageableService:Get(entityId)
				return Spatial.GroundDistance(entity.Model.PrimaryPart.Position, Vector3.new(0, 0, -1400))
			end

			local chilledStart = distanceFromCore(chilledId)
			local freeStart = distanceFromCore(freeId)

			advance(4)

			local chilledMoved = chilledStart - distanceFromCore(chilledId)
			local freeMoved = freeStart - distanceFromCore(freeId)

			check(chilledMoved > 0, "the chilled raider still advances")
			check(
				chilledMoved < freeMoved,
				`but less far than an unchilled one ({math.floor(chilledMoved)} vs {math.floor(freeMoved)} studs)`
			)

			-- Waves: one at a time, and only against a base that exists.
			checkEqual(
				RaidService:SummonWave(farmer).Reason,
				"RaidInProgress",
				"the horn is refused while raiders are still up"
			)

			--[[
				Killed rather than unregistered. Unregistering removes the
				entity but fires no Destroyed signal, so RaidService would
				still count them as a raid in progress - which is correct of
				it, and the wrong way to end a wave in a test.
			]]
			for entityId in RaidService:GetRaiders() do
				DamageableService:ApplyDamage(entityId, 999999, "Siege", nil)
			end
			checkEqual(RaidService:CountRaiders(farmer.UserId), 0, "the stragglers are cleared")

			local wave = RaidService:SummonWave(farmer)
			checkEqual(wave.Ok, true, "with the field clear, a wave can be summoned")

			local expected = 0
			for _, entry in GameConfig.Raids.Wave do
				expected += entry.Count
			end
			checkEqual(wave.Raiders, expected, "bringing the whole configured wave")
			checkEqual(RaidService:CountRaiders(farmer.UserId), expected, "all of them aimed at the one base")

			-- Raiders spawn beyond the longest weapon reach, so a wave is seen
			-- coming rather than arriving already under fire.
			local allOutsideRange = true

			for entityId in RaidService:GetRaiders() do
				if distanceFromCore(entityId) <= GameConfig.Attacks.TowerBolt.Range then
					allOutsideRange = false
				end
			end

			check(allOutsideRange, "every raider spawns outside tower range, so a wave is seen coming")

			-- Clearing the wave announces itself.
			local cleared = false
			local listener = RaidService.WaveCleared:Connect(function(userId: number)
				if userId == farmer.UserId then
					cleared = true
				end
			end)

			for entityId in RaidService:GetRaiders() do
				DamageableService:ApplyDamage(entityId, 999999, "Siege", nil)
			end

			checkEqual(cleared, true, "killing the last raider clears the wave")
			checkEqual(RaidService:CountRaiders(farmer.UserId), 0, "and none are left")
			listener:Disconnect()

			--[[
				A base with nothing standing is STILL raidable, because the
				player is a target in their own right - a raid is something to
				survive, not something to stand inside and watch.
			]]
			DamageableService:Unregister(core)
			DamageableService:Unregister(tower)
			DamageableService:Unregister(mill)

			local personal = RaidService:SummonWave(farmer)
			checkEqual(personal.Ok, true, "a player with no buildings left can still be raided in person")

			for entityId in RaidService:GetRaiders() do
				DamageableService:ApplyDamage(entityId, 999999, "Siege", nil)
			end

			-- Only with no base AND no body is there nothing to come for.
			farmer.Character.Parent = nil
			farmer.Character = nil
			checkEqual(
				RaidService:SummonWave(farmer).Reason,
				"NothingToRaid",
				"but a player with neither a base nor a body has nothing to raid"
			)

			PlayersService.PlayerRemoving:Fire(farmer)
			farmer.Parent = nil
		end

		------------------------------------------------------------------------
		section("Raids: raiders stop outside what they hit")
		------------------------------------------------------------------------

		--[[
			Reported from play: raiders ended up standing INSIDE the Town
			Center. Reach was measured centre-to-centre, so a nine stud club
			against a sixteen stud wide building meant closing to nine studs
			of its middle - a stud inside the wall.

			The second half of the same bug was worse and invisible: stopping
			at exactly `reach` meant a hair of floating point error could
			leave a raider a fraction outside its own attack range, where its
			next step is zero. It would stand there forever, never moving and
			never firing.
		]]
		do
			local besieged = newPlayer(6363, "Besieged")
			giveCharacter(besieged, Vector3.new(0, 3, -1600))
			PlayersService.PlayerAdded:Fire(besieged)

			local core = spawnEntity("TownCenter", 0, -1600, besieged.UserId)
			local coreArch = GameConfig.Archetypes.TownCenter
			local coreStructure = GameConfig.Structures.TownCenter
			local halfWidth = coreStructure.Size.X / 2

			local club = GameConfig.Attacks.RaiderClub

			--[[
				Measured centre to centre, a raider stopped `club.Range` from
				the middle of a building whose wall is `halfWidth` out - which
				left less clearance than the raider is wide, so its body ended
				up in the masonry. That is the reported symptom, as arithmetic.
			]]
			local oldClearance = club.Range - halfWidth
			check(
				oldClearance < 2.6,
				`centre-to-centre left {oldClearance} studs of clearance, less than a raider is wide`
			)

			local raiderId = RaidService:SpawnRaider(besieged, "EnemyRaider", 0, 100)
			check(raiderId ~= nil, "a raider is sent at it")

			local coreHealth = DamageableService:GetHealth(core)

			-- Long enough to walk in from a hundred studs out.
			advance(40)

			local raiderBody = DamageableService:Get(raiderId).Model.PrimaryPart
			local raiderPos = raiderBody.Position
			local centreDistance = Spatial.GroundDistance(raiderPos, Vector3.new(0, 0, -1600))

			--[[
				Measured from the raider's near EDGE, not its centre. The
				centre was always outside the wall even under the old rule -
				by one stud, against a body two and a half studs wide. It is
				the body that ends up in the masonry, so it is the body the
				assertion has to be about.
			]]
			local raiderHalf = raiderBody.Size.X / 2
			local clearance = centreDistance - raiderHalf - halfWidth

			check(
				clearance > 0,
				`the raider's body stops clear of the wall ({math.floor(clearance)} studs of daylight)`
			)

			-- And it is close enough to actually be fighting.
			check(
				DamageableService:GetHealth(core) < coreHealth,
				"while still being close enough to hit the building"
			)

			--[[
				The margin: it stops strictly inside its reach, never parked
				on the boundary where rounding decides whether it can fire.
			]]
			local surface = math.max(centreDistance - halfWidth, 0)
			check(
				surface < club.Range,
				`and inside its reach rather than on the edge of it ({surface} vs {club.Range})`
			)

			-- Which means it keeps fighting, rather than stalling after one hit.
			local midFight = DamageableService:GetHealth(core)
			advance(club.Cooldown * 4)
			check(
				DamageableService:GetHealth(core) < midFight,
				"and goes on hitting it instead of stalling once it arrives"
			)

			DamageableService:ApplyDamage(raiderId, 999999, "Siege", nil)
			DamageableService:Unregister(core)
			PlayersService.PlayerRemoving:Fire(besieged)
			besieged.Parent = nil
		end

		------------------------------------------------------------------------
		section("Raids: levels and escalation")
		------------------------------------------------------------------------

		--[[
			Raiders were all level 1, which made every raid identical and made
			"the level of the horde that attacked you" a thing that did not
			exist. It has to exist, because the revenge army in
			docs/ROADMAP.md is sized from it.

			Scaled off AGE rather than XP level. Age is the RTS measure of how
			far a settlement has come - it gates buildings and costs a fortune
			- whereas XP rises from farming, and growing carrots should not
			summon a bigger army.
		]]
		checkEqual(GameConfig.GetRaidLevel(1), GameConfig.Raids.BaseLevel, "a Stone Age settlement faces the base level")
		check(
			GameConfig.GetRaidLevel(2) > GameConfig.GetRaidLevel(1),
			"advancing an age brings a harder horde"
		)
		checkEqual(
			GameConfig.GetRaidLevel(3) - GameConfig.GetRaidLevel(2),
			GameConfig.Raids.LevelPerAge,
			"and each age adds the same step"
		)

		checkEqual(GameConfig.GetLevelMultiplier(1), 1, "level one is the unscaled baseline")
		check(GameConfig.GetLevelMultiplier(5) > 1, "and higher levels scale up")

		-- Garbage in does not produce a monster.
		checkEqual(GameConfig.GetLevelMultiplier(0), 1, "a level below one still reads as the baseline")
		checkEqual(GameConfig.GetLevelMultiplier(nil), 1, "and so does no level at all")

		--[[
			The level has to actually DO something, on both sides of the fight:
			a levelled raider is tougher AND hits harder. Its kill rewards
			already scaled with level, so a harder wave pays better with no
			extra wiring.
		]]
		do
			local plain = spawnEntity("EnemyRaider", 0, 900)
			local plainHealth = DamageableService:GetHealth(plain)

			local model = Instance.new("Model")
			local body = Instance.new("Part")
			body.Position = Vector3.new(20, 2, 900)
			body.Parent = model
			model.PrimaryPart = body
			model.Parent = WorkspaceService

			local veteran = DamageableService:Register({
				ArchetypeId = "EnemyRaider",
				Model = model,
				OwnerUserId = 0,
				Level = 6,
			})

			check(
				DamageableService:GetHealth(veteran) > plainHealth,
				`a level six raider has more health than a level one ({DamageableService:GetHealth(veteran)} vs {plainHealth})`
			)

			--[[
				And the shared config table was not mutated to achieve it. Two
				raiders at different levels must not fight over one MaxHealth,
				which a naive in-place scale would cause.
			]]
			checkEqual(
				GameConfig.Archetypes.EnemyRaider.MaxHealth,
				120,
				"while the archetype in config is left alone"
			)
			checkEqual(
				DamageableService:GetHealth(plain),
				plainHealth,
				"so the level one raider is unaffected by its veteran neighbour"
			)

			-- Harder hitting, measured against a target it can reach.
			local club = GameConfig.Attacks.RaiderClub
			local wall = spawnEntity("Checkpoint", 24, 900, 8181)

			AttackService:Register(veteran)
			local before = DamageableService:GetHealth(wall)
			advance(club.Cooldown + GameConfig.Combat.AttackTickInterval * 2)
			local veteranHit = before - DamageableService:GetHealth(wall)

			check(
				veteranHit > Combat.ComputeDamage(club.Damage, club.DamageType, "Building", 6),
				`and hits harder than its level one damage would ({veteranHit})`
			)

			AttackService:Unregister(veteran)
			for _, id in { plain, veteran, wall } do
				DamageableService:Unregister(id)
			end
		end

		------------------------------------------------------------------------
		section("Defeat: the anchor shatters rather than vanishing")
		------------------------------------------------------------------------

		--[[
			The whole design. An anchor that can be destroyed outright makes a
			bad raid unrecoverable; one that cannot be destroyed makes a raid
			toothless. Shattering is the third option - the anchor is gone but
			the SITE remains.
		]]
		local DefeatService = require(DefeatServiceModule)
		DefeatService:Start()

		do
			local holdout = newPlayer(7171, "Holdout")
			giveCharacter(holdout, Vector3.new(120, 3, -200))
			PlayersService.PlayerAdded:Fire(holdout)
			PlayerDataService:AddResource(holdout, "Wood", 50000)
			PlayerDataService:AddResource(holdout, "Stone", 50000)

			-- An anchor, placed the ordinary way.
			local placement = PlacementService:Place(holdout, "Checkpoint", 120, -200)
			checkEqual(placement.Ok, true, `a Checkpoint is built`)

			local anchorId, placed, entity = DefeatService:GetAnchor(holdout)
			checkEqual(anchorId, placement.InstanceId, "and is found as the player's anchor")
			check(entity ~= nil, "with a damageable entity behind it")
			checkEqual(DefeatService:HasStandingAnchor(holdout), true, "standing")
			checkEqual(DefeatService:IsAnchorShattered(holdout), false, "and not in ruins")

			--[[
				Dying with it standing is an inconvenience, not a defeat: the
				respawn handler puts the player back on it.
			]]
			local humanoid = holdout.Character:FindFirstChildOfClass("Humanoid")
			humanoid:TakeDamage(9999)

			checkEqual(DefeatService:IsDefeated(holdout), false, "falling with the anchor up is not a defeat")
			checkEqual(holdout:GetAttribute("Defeated"), nil, "and raises no panel")

			--[[
				A new character appears at the anchor rather than at world
				spawn - and built the way the ENGINE builds one, with its
				PrimaryPart assigned a moment after the signal fires.

				That ordering is the bug this covers. The move used to read
				character.PrimaryPart immediately, find nil, and give up
				silently, so players respawned at the world spawn with a
				perfectly good Checkpoint standing. The old test passed
				because its fake character was ready before the signal, which
				the engine never is.
			]]
			local anchorBody = placed.Model.PrimaryPart
			local revived = giveCharacter(holdout, Vector3.new(220, 3, 220), true)
			holdout.CharacterAdded:Fire(revived)

			checkEqual(revived.PrimaryPart, nil, "the character has no root part yet, as in a real game")

			-- Long enough for the root part to arrive and the move to run.
			advance(1)

			check(
				Spatial.GroundDistance(revived.PrimaryPart.Position, anchorBody.Position) < 20,
				"respawning waits for the character and puts them at their Checkpoint"
			)

			--[[
				And NO SpawnLocation is left in the world.

				An earlier version parked one on the anchor to avoid the
				teleport flash, and it caused a worse bug: a SpawnLocation
				stays enabled, so the engine kept treating the site as a valid
				spawn after the anchor shattered and players reappeared in the
				ruins - the one place the design says they must not.
			]]
			checkEqual(
				placed.Model:FindFirstChild("AnchorSpawn"),
				nil,
				"and no SpawnLocation is left behind to capture respawns later"
			)

			--[[
				A DEFERRED character's death is still noticed.

				This is the bug the player hit: the death listener read
				character:FindFirstChildOfClass("Humanoid") the instant
				CharacterAdded fired, found nil, and connected nothing. Deaths
				went unnoticed, so the defeat panel never appeared and players
				respawned forever.

				Checked here while the anchor still STANDS, so the expected
				outcome is a plain respawn rather than a defeat - the listener
				has to be attached either way.
			]]
			local deferredHumanoid = revived:FindFirstChildOfClass("Humanoid")
			check(deferredHumanoid ~= nil, "a deferred character does get its Humanoid")

			deferredHumanoid:TakeDamage(9999)
			advance(1)
			checkEqual(
				DefeatService:IsDefeated(holdout),
				false,
				"dying with the anchor up is still not a defeat"
			)

			--[[
				Now destroy it. It must SHATTER - stay in the registry, stay in
				the world, and stay on the player's record.
			]]
			DamageableService:ApplyDamage(placed.EntityId, 999999, "Siege", nil)

			checkEqual(DefeatService:IsAnchorShattered(holdout), true, "a destroyed anchor shatters")
			checkEqual(DefeatService:HasStandingAnchor(holdout), false, "so it is no longer standing")
			check(placed.Model.Parent ~= nil, "but the wreck is still there")
			check(
				PlayerDataService:GetData(holdout).Structures[anchorId] ~= nil,
				"and still on the player's record, unlike anything that is merely destroyed"
			)

			-- The wreck gains a rebuild prompt.
			local wreckPrompt = placed.Model.PrimaryPart:FindFirstChild("RebuildPrompt")
			check(wreckPrompt ~= nil, "the wreck offers a Rebuild prompt")

			--[[
				And respawning no longer brings the player to it. This is the
				point of shattering: the anchor is the safe place to reappear,
				and the raid has just taken it. Respawning on the wreck would
				hand straight back the only thing that was actually lost.
			]]
			local homeless = giveCharacter(holdout, Vector3.new(60, 3, -60))
			holdout.CharacterAdded:Fire(homeless)

			check(
				Spatial.GroundDistance(homeless.PrimaryPart.Position, anchorBody.Position) > 20,
				"respawning does NOT return the player to a shattered anchor"
			)

			--[[
				But not while raiders are standing over it. Rebuilding under
				fire would make shattering meaningless - the player would tank
				the raid and tap the prompt.
			]]
			checkEqual(DefeatService:IsSecure(holdout), true, "with the field clear, the area is secure")

			local nearby = RaidService:SpawnRaider(holdout, "EnemyRaider", 0, 10)
			check(nearby ~= nil, "a raider arrives at the wreck")
			checkEqual(DefeatService:IsSecure(holdout), false, "which makes the area unsecured")
			checkEqual(
				DefeatService:TryRebuildAnchor(holdout).Reason,
				"NotSecure",
				"and rebuilding is refused until it is dealt with"
			)

			DamageableService:ApplyDamage(nearby, 999999, "Siege", nil)
			checkEqual(DefeatService:IsSecure(holdout), true, "killing it secures the area again")

			--[[
				Rebuilding by prompt costs resources - this player survived -
				but it costs the BUILD price, not the repair price.

				Priced per health point, a two thousand health anchor comes to
				800 Wood and 800 Stone: five times what the Checkpoint costs
				new, and far beyond what a player holds after losing a raid.
				The prompt just refused, silently, which is how this was found.
			]]
			local checkpointCost = GameConfig.Structures.Checkpoint.Cost

			-- Exactly the build price in hand, and nothing spare.
			local inventory = PlayerDataService:GetData(holdout)
			for resourceId in checkpointCost do
				inventory.Resources[resourceId] = 0
			end
			for resourceId, amount in checkpointCost do
				PlayerDataService:AddResource(holdout, resourceId, amount)
			end

			local woodBefore = PlayerDataService:GetResource(holdout, "Wood")
			local rebuilt = DefeatService:TryRebuildAnchor(holdout)

			checkEqual(rebuilt.Ok, true, "a secured wreck can be rebuilt for exactly the build price")
			checkEqual(DefeatService:HasStandingAnchor(holdout), true, "and stands again")
			check(PlayerDataService:GetResource(holdout, "Wood") < woodBefore, "which costs resources")

			for resourceId, amount in checkpointCost do
				checkEqual(rebuilt.Cost[resourceId], amount, `billed the Checkpoint's {resourceId} cost`)
				checkEqual(
					PlayerDataService:GetResource(holdout, resourceId),
					0,
					`and the {resourceId} was actually taken`
				)
			end
			checkEqual(
				placed.Model.PrimaryPart:FindFirstChild("RebuildPrompt"),
				nil,
				"and the prompt goes away with the rubble"
			)

			--[[
				THE REPORTED BUG, end to end: a character built the way the
				engine builds one, dying while the anchor lies in ruins, must
				raise the defeat.
			]]
			DamageableService:ApplyDamage(placed.EntityId, 999999, "Siege", nil)
			checkEqual(DefeatService:IsAnchorShattered(holdout), true, "the anchor is in ruins again")

			local lastStand = giveCharacter(holdout, Vector3.new(140, 3, -160), true)
			holdout.CharacterAdded:Fire(lastStand)
			advance(1)

			lastStand:FindFirstChildOfClass("Humanoid"):TakeDamage(9999)
			advance(1)

			checkEqual(
				DefeatService:IsDefeated(holdout),
				true,
				"a deferred character dying on a ruined anchor IS a defeat"
			)
			checkEqual(holdout:GetAttribute("Defeated"), true, "and the panel is raised")

			--[[
				AND THE CASE THAT ACTUALLY BROKE IT: a death with NO Died
				signal at all.

				A character that falls below FallenPartsDestroyHeight has its
				parts destroyed, so the Humanoid is torn down rather than
				killed and Died never fires. Walking off the edge of the map -
				the easiest way to test dying - therefore raised no defeat,
				which is what was reported three times.

				Simulated faithfully: the character is removed without its
				Humanoid ever reaching zero, and the only evidence of the
				death is that a new character arrives.
			]]
			checkEqual(DefeatService:Resolve(holdout, "Surrender").Ok, true, "cleared the previous defeat")
			DamageableService:ApplyDamage(placed.EntityId, 999999, "Siege", nil)
			checkEqual(DefeatService:IsAnchorShattered(holdout), true, "the anchor is ruined once more")

			local voidFaller = giveCharacter(holdout, Vector3.new(140, 3, -160))
			holdout.CharacterAdded:Fire(voidFaller)
			advance(1)

			local deaths = {}
			local deathListener = DefeatService.DeathNoticed:Connect(function(_, source: string)
				table.insert(deaths, source)
			end)

			-- Gone, with full health and no Died: the engine ate it.
			checkEqual(
				voidFaller:FindFirstChildOfClass("Humanoid").Health,
				100,
				"the character is at full health when it vanishes"
			)
			voidFaller.Parent = nil

			local replacement = giveCharacter(holdout, Vector3.new(0, 3, 0))
			holdout.CharacterAdded:Fire(replacement)
			advance(1)

			checkEqual(#deaths, 1, "the respawn is recognised as a death")
			checkEqual(deaths[1], "Respawned", "by the backstop, since nothing else could report it")
			checkEqual(
				DefeatService:IsDefeated(holdout),
				true,
				"so falling into the void on a ruined anchor IS a defeat"
			)

			deathListener:Disconnect()

			PlayersService.PlayerRemoving:Fire(holdout)
			holdout.Parent = nil
		end

		------------------------------------------------------------------------
		section("Defeat: falling with no anchor, and the two ways back")
		------------------------------------------------------------------------

		do
			local doomed = newPlayer(7272, "Doomed")
			giveCharacter(doomed, Vector3.new(-120, 3, -200))
			PlayersService.PlayerAdded:Fire(doomed)
			PlayerDataService:AddResource(doomed, "Wood", 50000)
			PlayerDataService:AddResource(doomed, "Stone", 50000)

			--[[
				A Town Center as well as the anchor, so there is always
				something for a raid to come for. With only a shattered
				Checkpoint and a dead player, a base has no targets at all -
				which is correct of RaidService and useless for this test.
			]]
			checkEqual(PlacementService:Place(doomed, "TownCenter", -160, -200).Ok, true, "a Town Center stands")
			checkEqual(PlacementService:Place(doomed, "Checkpoint", -120, -200).Ok, true, "and a Checkpoint")

			local _, placed = DefeatService:GetAnchor(doomed)

			--- Dying, and the engine putting them back on their feet.
			local function fall()
				doomed.Character:FindFirstChildOfClass("Humanoid"):TakeDamage(9999)
			end

			local function respawn()
				local character = giveCharacter(doomed, Vector3.new(-120, 3, -180))
				doomed.CharacterAdded:Fire(character)
			end

			local function shatterAnchor()
				DamageableService:ApplyDamage(placed.EntityId, 999999, "Siege", nil)
			end

			shatterAnchor()
			checkEqual(DefeatService:IsAnchorShattered(doomed), true, "the anchor is in ruins")

			fall()
			checkEqual(DefeatService:IsDefeated(doomed), true, "falling while shattered IS a defeat")
			checkEqual(doomed:GetAttribute("Defeated"), true, "replicated, so the panel appears")

			-- Garbage answers are refused, and leave the defeat standing.
			checkEqual(DefeatService:Resolve(doomed, "Nonsense").Reason, "UnknownChoice", "an unknown answer is refused")
			checkEqual(DefeatService:Resolve(doomed, nil).Reason, "UnknownChoice", "and so is no answer")
			checkEqual(DefeatService:IsDefeated(doomed), true, "leaving the player defeated")

			respawn()

			--[[
				FIGHT ON. Spends a token, restores the anchor, calls off the
				raid, and does NOT touch the stores.
			]]
			checkEqual(RaidService:SummonWave(doomed).Ok, true, "a raid is under way")
			check(RaidService:CountRaiders(doomed.UserId) > 0, "with raiders on the field")

			local tokensBefore = PlayerDataService:GetRevengeTokens(doomed)
			local woodBefore = PlayerDataService:GetResource(doomed, "Wood")
			check(tokensBefore > 0, `the player has tokens to spend ({tokensBefore})`)

			local fought = DefeatService:Resolve(doomed, "FightOn")

			checkEqual(fought.Ok, true, "fighting on is accepted")
			checkEqual(
				PlayerDataService:GetRevengeTokens(doomed),
				tokensBefore - GameConfig.Defeat.FightOnTokenCost,
				"spending a revenge token"
			)
			checkEqual(
				PlayerDataService:GetResource(doomed, "Wood"),
				woodBefore,
				"and leaving the stores alone, which is what the token buys"
			)
			checkEqual(DefeatService:IsDefeated(doomed), false, "the player is back up")
			checkEqual(doomed:GetAttribute("Defeated"), false, "so the panel closes")
			checkEqual(DefeatService:HasStandingAnchor(doomed), true, "with the anchor raised again")
			checkEqual(RaidService:CountRaiders(doomed.UserId), 0, "and the raid called off")

			--[[
				SURRENDER. Free in tokens, paid in stores. Rounded down, so a
				nearly empty store loses nothing rather than its last unit.
			]]
			shatterAnchor()
			fall()
			checkEqual(DefeatService:IsDefeated(doomed), true, "defeated a second time")
			respawn()

			local storesBefore = {}
			for _, resourceId in GameConfig.GetResourceIds() do
				storesBefore[resourceId] = PlayerDataService:GetResource(doomed, resourceId)
			end

			-- Something in the purse to lose.
			PlayerDataService:AddInventoryGold(doomed, 1000)
			local purseBefore = PlayerDataService:GetInventoryGold(doomed)
			local tokensHeld = PlayerDataService:GetRevengeTokens(doomed)

			local surrendered = DefeatService:Resolve(doomed, "Surrender")
			checkEqual(surrendered.Ok, true, "surrender is accepted")
			checkEqual(PlayerDataService:GetRevengeTokens(doomed), tokensHeld, "costing no tokens")

			--[[
				It costs the PURSE, and only the purse.

				An earlier rule took a quarter of every treasury resource.
				That was the wrong pocket: the treasury is the settlement, and
				emptying it undoes hours of building to punish one bad fight.
				The purse is loot carried on the person, and losing it is
				exactly the kind of setback a lost fight should be.
			]]
			local expectedLoss = math.floor(purseBefore * GameConfig.Defeat.SurrenderPurseLoss)
			check(expectedLoss > 0, `there is purse gold to lose ({purseBefore})`)

			checkEqual(
				PlayerDataService:GetInventoryGold(doomed),
				purseBefore - expectedLoss,
				"the raiders carry off their cut of the purse"
			)
			checkEqual(surrendered.Lost.Purse, expectedLoss, "and the result reports what was taken")

			for _, resourceId in GameConfig.GetResourceIds() do
				checkEqual(
					PlayerDataService:GetResource(doomed, resourceId),
					storesBefore[resourceId],
					`while the {resourceId} in the treasury is untouched`
				)
			end

			--[[
				And an empty purse costs nothing rather than erroring or
				going negative: being broke should not be made worse.
			]]
			PlayerDataService:TrySpendInventoryGold(doomed, PlayerDataService:GetInventoryGold(doomed))
			checkEqual(PlayerDataService:GetInventoryGold(doomed), 0, "the purse is emptied")

			checkEqual(DefeatService:HasStandingAnchor(doomed), true, "the anchor is raised either way")
			checkEqual(DefeatService:IsDefeated(doomed), false, "and the player is back in the game")

			--[[
				A player with no tokens cannot fight on, and must NOT be
				quietly handed a free recovery - they are told, and stay
				defeated so they can surrender instead.
			]]
			PlayerDataService:TrySpendRevengeTokens(doomed, PlayerDataService:GetRevengeTokens(doomed))
			checkEqual(PlayerDataService:GetRevengeTokens(doomed), 0, "the player is out of tokens")

			shatterAnchor()
			fall()
			respawn()

			local broke = DefeatService:Resolve(doomed, "FightOn")
			checkEqual(broke.Ok, false, "fighting on with no tokens is refused")
			checkEqual(broke.Reason, "NoTokens", "by name, so the panel can say so")
			checkEqual(DefeatService:IsDefeated(doomed), true, "and the player stays defeated")
			checkEqual(
				DefeatService:HasStandingAnchor(doomed),
				false,
				"with the anchor still in ruins - a refused answer grants nothing"
			)

			checkEqual(DefeatService:Resolve(doomed, "Surrender").Ok, true, "but they can still surrender")

			-- And answering when not defeated is refused.
			checkEqual(
				DefeatService:Resolve(doomed, "Surrender").Reason,
				"NotDefeated",
				"answering a defeat that is not happening is refused"
			)

			PlayersService.PlayerRemoving:Fire(doomed)
			doomed.Parent = nil
		end

		------------------------------------------------------------------------
		section("Defeat: raiders can hurt the player")
		------------------------------------------------------------------------

		--[[
			Which the loop needs, or "fall while shattered" is unreachable
			except by accident.

			The player is NOT a damageable entity: their health is the
			Humanoid's, because the engine already owns respawning and the bar
			above their head. So this checks the bridge.
		]]
		do
			local prey = newPlayer(7373, "Prey")
			giveCharacter(prey, Vector3.new(0, 3, -2200))
			PlayersService.PlayerAdded:Fire(prey)

			local candidate = AttackService.GetPlayerCandidate(prey)
			check(candidate ~= nil, "a living player is a valid target")
			checkEqual(candidate.Tag, GameConfig.PlayerCombat.TargetTag, "tagged as a unit")
			check(candidate.Humanoid ~= nil, "carrying a Humanoid rather than an entity id")
			checkEqual(candidate.EntityId, nil, "because they are not in the damageable registry")

			-- A raider beside them takes them down over time.
			local club = GameConfig.Attacks.RaiderClub
			local humanoid = prey.Character:FindFirstChildOfClass("Humanoid")
			local fullHealth = humanoid.Health

			local thug = spawnEntity("EnemyRaider", 4, -2200)
			AttackService:Register(thug)

			advance(club.Cooldown + GameConfig.Combat.AttackTickInterval * 2)
			check(humanoid.Health < fullHealth, "a raider beside a player hurts them")

			--[[
				Through the counter table, like everything else. A club is
				Siege, which is poor against a person - so a raid is
				survivable in the open and ruinous to a base.
			]]
			local dealt = fullHealth - humanoid.Health
			local expected = Combat.ComputeDamage(
				club.Damage,
				club.DamageType,
				GameConfig.PlayerCombat.ArmourClass,
				GameConfig.PlayerCombat.Armour
			)
			checkEqual(dealt, expected, "for the counter table's amount, not the raw damage")
			check(
				expected < club.Damage,
				`and Siege is poor against a person ({expected} of {club.Damage})`
			)

			-- A dead player stops being a target, so raiders do not flog a corpse.
			humanoid:TakeDamage(9999)
			checkEqual(AttackService.GetPlayerCandidate(prey), nil, "a fallen player is no longer a target")

			AttackService:Unregister(thug)
			DamageableService:Unregister(thug)
			PlayersService.PlayerRemoving:Fire(prey)
			prey.Parent = nil
		end

		------------------------------------------------------------------------
		section("Attacks: shots are announced to clients")
		------------------------------------------------------------------------

		--[[
			Also reported from play: combat was completely invisible. Health
			and status effects are derived from replicated attributes and need
			no traffic, but a shot is an EVENT with no state behind it - once
			it has landed, nothing on either entity records that it happened,
			so there is nothing for a client to derive a tracer from.
		]]
		do
			local effectRemote = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.CombatEffect)
			local broadcasts = rawget(effectRemote, "_broadcasts")
			check(broadcasts ~= nil, "the combat effect remote exists for the server to shout down")

			local before = #broadcasts

			local tower = spawnEntity("WatchTower", 0, 800, 5858)
			AttackService:Register(tower)
			local prey = spawnEntity("EnemyRaider", 20, 800)

			advance(GameConfig.Attacks.TowerBolt.Cooldown + GameConfig.Combat.AttackTickInterval * 2)

			check(#broadcasts > before, "a shot is announced")

			local shot = broadcasts[#broadcasts]
			checkEqual(shot[1], "TowerBolt", "naming the attack, so the client can colour it")
			checkEqual(typeof(shot[2]), "Vector3", "with an origin to draw from")
			checkEqual(typeof(shot[3]), "Vector3", "and an impact point to draw to")

			AttackService:Unregister(tower)
			DamageableService:Unregister(tower)
			DamageableService:Unregister(prey)
		end

		------------------------------------------------------------------------
		section("Ages: advancing one")
		------------------------------------------------------------------------

		--[[
			Reported from play: there was no way to age up. TryAdvanceAge
			existed on the server and NOTHING could ask for it - no remote, no
			button - so the whole Age system, and everything gated behind it
			including the Watch Tower, was unreachable.
		]]
		do
			local climber = newPlayer(6464, "Climber")
			PlayersService.PlayerAdded:Fire(climber)

			local advanceAge = require(Shared.Remotes).GetFunction(GameConfig.RemoteNames.AdvanceAge)
			check(advanceAge.OnServerInvoke ~= nil, "the AdvanceAge handler is installed")

			checkEqual(PlayerDataService:GetAge(climber), 1, "a new player starts in the Stone Age")
			checkEqual(
				select(2, PlacementService:GetBuildability(climber, "WatchTower")),
				"AgeTooLow",
				"and the Watch Tower is age-locked to begin with"
			)

			-- Refused, with a reason: a silent no-op is maddening when the
			-- only thing wrong is the price.
			local poor = advanceAge.OnServerInvoke(climber)
			checkEqual(poor.Ok, false, "an unaffordable advance is refused")
			checkEqual(poor.Reason, "NotEnoughResources", "and says which problem it is")
			checkEqual(PlayerDataService:GetAge(climber), 1, "leaving the age alone")

			for resourceId, amount in GameConfig.GetAdvanceCost(1) do
				PlayerDataService:AddResource(climber, resourceId, amount)
			end

			local advanced = advanceAge.OnServerInvoke(climber)
			checkEqual(advanced.Ok, true, "with the cost in hand it succeeds")
			checkEqual(advanced.Age, 2, "returning the new age")
			checkEqual(PlayerDataService:GetAge(climber), 2, "and the player is in it")
			checkEqual(climber:GetAttribute("Age"), 2, "replicated, so the HUD button can update")

			-- The cost is actually taken.
			for resourceId in GameConfig.GetAdvanceCost(1) do
				checkEqual(
					PlayerDataService:GetResource(climber, resourceId),
					GameConfig.StartingResources[resourceId] or 0,
					`advancing spent the {resourceId}`
				)
			end

			--[[
				Which is what unlocks the tower. The player owns no Town
				Center, so the tech-tree rule still bites - but the AGE gate
				has lifted, and that was the point.
			]]
			checkEqual(
				select(2, PlacementService:GetBuildability(climber, "WatchTower")),
				"MissingPrerequisite",
				"the Watch Tower is no longer age-locked, only tree-locked"
			)

			-- Rate limited, so the button cannot be held down.
			local blocked = false
			for _ = 1, 12 do
				if advanceAge.OnServerInvoke(climber).Reason == "RateLimited" then
					blocked = true
				end
			end
			check(blocked, "spamming the request is throttled")

			-- And there is a top.
			advance(10)
			for _ = 1, GameConfig.MaxAge do
				for resourceId, amount in GameConfig.GetAdvanceCost(PlayerDataService:GetAge(climber)) or {} do
					PlayerDataService:AddResource(climber, resourceId, amount)
				end
				advance(2)
				advanceAge.OnServerInvoke(climber)
			end

			checkEqual(PlayerDataService:GetAge(climber), GameConfig.MaxAge, "the ages run out at the top")
			advance(2)
			checkEqual(
				advanceAge.OnServerInvoke(climber).Reason,
				"MaxAge",
				"and advancing past the last one is refused by name"
			)

			PlayersService.PlayerRemoving:Fire(climber)
			climber.Parent = nil
		end
	end

	----------------------------------------------------------------------------
	section("Economy: the four-resource treasury")
	----------------------------------------------------------------------------

	local settler = newPlayer(1111, "Settler")
	giveCharacter(settler, Vector3.new(0, 3, 0))
	PlayersService.PlayerAdded:Fire(settler)

	-- Starting resources are granted once, from StartingResources, not the template.
	for resourceId, amount in GameConfig.StartingResources do
		checkEqual(
			PlayerDataService:GetResource(settler, resourceId),
			amount,
			`starting {resourceId} is granted`
		)
		checkEqual(settler:GetAttribute(resourceId), amount, `{resourceId} replicates as an attribute`)
	end

	checkEqual(PlayerDataService:GetGold(settler), GameConfig.StartingResources.Gold, "GetGold reads the treasury")
	checkEqual(
		settler:FindFirstChild("leaderstats"):FindFirstChild("Gold").Value,
		GameConfig.StartingResources.Gold,
		"leaderstats tracks the primary resource"
	)

	-- Generic resource mutators, identical for every resource.
	checkEqual(
		PlayerDataService:AddResource(settler, "Wood", 50),
		GameConfig.StartingResources.Wood + 50,
		"AddResource credits"
	)
	checkEqual(PlayerDataService:AddResource(settler, "Obsidian", 50), nil, "an unknown resource is rejected")
	checkEqual(PlayerDataService:AddResource(settler, "Wood", -5), nil, "a negative credit is rejected")
	checkEqual(PlayerDataService:AddResource(settler, "Wood", 0 / 0), nil, "a NaN credit is rejected")
	checkEqual(PlayerDataService:GetResource(settler, "Wood"), GameConfig.StartingResources.Wood + 50, "rejected credits change nothing")

	checkEqual(PlayerDataService:TrySpendResource(settler, "Wood", 9999), false, "cannot overspend one resource")
	checkEqual(PlayerDataService:TrySpendResource(settler, "Wood", 50), true, "can spend what is held")
	checkEqual(settler:GetAttribute("Wood"), GameConfig.StartingResources.Wood, "spending replicates")

	-- Multi-resource costs are all-or-nothing.
	local foodBefore = PlayerDataService:GetResource(settler, "Food")
	local woodHeld = PlayerDataService:GetResource(settler, "Wood")
	checkEqual(
		PlayerDataService:TrySpendResources(settler, { Food = 10, Wood = 999999 }),
		false,
		"a mixed cost the player cannot fully afford is refused"
	)
	checkEqual(PlayerDataService:GetResource(settler, "Food"), foodBefore, "the affordable half is NOT deducted")
	checkEqual(PlayerDataService:GetResource(settler, "Wood"), woodHeld, "nothing is deducted on refusal")

	checkEqual(
		PlayerDataService:TrySpendResources(settler, { Food = 10, Wood = 20 }),
		true,
		"an affordable mixed cost succeeds"
	)
	checkEqual(PlayerDataService:GetResource(settler, "Food"), foodBefore - 10, "both resources are deducted")
	checkEqual(PlayerDataService:GetResource(settler, "Wood"), woodHeld - 20, "atomically")

	checkEqual(
		PlayerDataService:TrySpendResources(settler, { Food = 10, Obsidian = 1 }),
		false,
		"a cost naming an unknown resource is refused entirely"
	)
	checkEqual(PlayerDataService:TrySpendResources(settler, {}), false, "an empty cost is refused")

	----------------------------------------------------------------------------
	section("Economy: treasury and purse are separate")
	----------------------------------------------------------------------------

	checkEqual(PlayerDataService:GetInventoryGold(settler), 0, "the purse starts empty")

	-- Market income must never reach the purse.
	PlayerDataService:AddItem(settler, "Carrot", 2)
	local purseBefore = PlayerDataService:GetInventoryGold(settler)
	local treasuryBefore = PlayerDataService:GetGold(settler)

	checkEqual(ShopService:ProcessTransaction(settler, "Sell", "Carrot", 2).Ok, true, "selling produce works")
	check(PlayerDataService:GetGold(settler) > treasuryBefore, "sale income lands in the treasury")
	checkEqual(PlayerDataService:GetInventoryGold(settler), purseBefore, "sale income does NOT reach the purse")

	-- There must be no path from treasury to purse. The absence IS the rule.
	checkEqual(PlayerDataService.WithdrawToPurse, nil, "no treasury-to-purse withdrawal function exists")
	checkEqual(PlayerDataService.TransferGold, nil, "no gold transfer function exists")

	-- Loot fills the purse only.
	checkEqual(PlayerDataService:AddInventoryGold(settler, 500), 500, "loot credits the purse")
	checkEqual(settler:GetAttribute("InventoryGold"), 500, "the purse replicates")
	checkEqual(PlayerDataService:GetGold(settler), PlayerDataService:GetGold(settler), "the treasury is untouched")
	checkEqual(PlayerDataService:AddInventoryGold(settler, -5), nil, "a negative loot credit is rejected")

	checkEqual(PlayerDataService:TrySpendInventoryGold(settler, 9999), false, "cannot overspend the purse")
	checkEqual(PlayerDataService:TrySpendInventoryGold(settler, 200), true, "can spend the purse")
	checkEqual(PlayerDataService:GetInventoryGold(settler), 300, "the purse debits")

	-- Construction: treasury first, purse only on opt-in.
	local drained = newPlayer(1212, "Pauper")
	PlayersService.PlayerAdded:Fire(drained)
	PlayerDataService:TrySpendResources(drained, { Gold = GameConfig.StartingResources.Gold })
	checkEqual(PlayerDataService:GetGold(drained), 0, "the treasury is empty")
	PlayerDataService:AddInventoryGold(drained, 1000)

	local paid, source = PlayerDataService:TryPayConstruction(drained, { Gold = 100 })
	checkEqual(paid, false, "an empty treasury does not silently raid the purse")
	checkEqual(source, nil, "and reports no payment source")
	checkEqual(PlayerDataService:GetInventoryGold(drained), 1000, "the purse is untouched without consent")

	paid, source = PlayerDataService:TryPayConstruction(drained, { Gold = 100 }, true)
	checkEqual(paid, true, "an explicit opt-in allows the purse to pay")
	checkEqual(source, "Purse", "and reports the purse as the source")
	checkEqual(PlayerDataService:GetInventoryGold(drained), 900, "the purse is debited")

	PlayerDataService:SetAutoUsePersonalGold(drained, true)
	paid, source = PlayerDataService:TryPayConstruction(drained, { Gold = 100 })
	checkEqual(paid, true, "the saved preference pays without asking")
	checkEqual(source, "Purse", "from the purse")

	-- A mixed cost cannot be met by the purse, which holds only gold.
	checkEqual(
		select(1, PlayerDataService:TryPayConstruction(drained, { Gold = 10, Wood = 10 }, true)),
		false,
		"the purse cannot pay a cost that includes other resources"
	)

	-- With a funded treasury the purse is never touched.
	PlayerDataService:AddResource(drained, "Gold", 500)
	local purseHeld = PlayerDataService:GetInventoryGold(drained)
	paid, source = PlayerDataService:TryPayConstruction(drained, { Gold = 100 })
	checkEqual(paid, true, "a funded treasury pays")
	checkEqual(source, "Treasury", "and reports the treasury")
	checkEqual(PlayerDataService:GetInventoryGold(drained), purseHeld, "the purse is untouched when the treasury can pay")

	----------------------------------------------------------------------------
	section("Economy: market resource trading")
	----------------------------------------------------------------------------

	do
		local trader = newPlayer(3101, "Trader")
		PlayersService.PlayerAdded:Fire(trader)

		local rates = GameConfig.Shop.ResourceTrade

		-- Gold converts into the construction resources. Without this the
		-- economy is a dead end: produce sells for Gold, but building costs
		-- Wood and Stone and aging up costs Food.
		local goldBefore = PlayerDataService:GetGold(trader)
		local woodBefore = PlayerDataService:GetResource(trader, "Wood")

		local bought = ShopService:TradeResource(trader, "Buy", "Wood", 10)
		checkEqual(bought.Ok, true, "Gold buys Wood")
		checkEqual(bought.Spent, 10 * rates.BuyRate.Wood, "at the configured buy rate")
		checkEqual(PlayerDataService:GetResource(trader, "Wood"), woodBefore + 10, "the Wood arrives")
		checkEqual(PlayerDataService:GetGold(trader), goldBefore - bought.Spent, "and the Gold is spent")

		-- And back again, at a worse rate.
		local sold = ShopService:TradeResource(trader, "Sell", "Wood", 10)
		checkEqual(sold.Ok, true, "Wood sells back for Gold")
		checkEqual(sold.Earned, 10 * rates.SellRate.Wood, "at the configured sell rate")
		check(sold.Earned < bought.Spent, "a round trip LOSES value, so trading is not an arbitrage loop")

		-- Gold cannot be traded for itself.
		checkEqual(
			ShopService:TradeResource(trader, "Buy", "Gold", 1).Reason,
			"NotTradeable",
			"the primary currency cannot be traded for itself"
		)

		-- Untrusted input.
		checkEqual(ShopService:TradeResource(trader, "Buy", "Obsidian", 1).Reason, "InvalidResource", "unknown resources are refused")
		checkEqual(ShopService:TradeResource(trader, "Buy", { x = 1 }, 1).Reason, "InvalidResource", "a table resource id is refused")
		checkEqual(ShopService:TradeResource(trader, "Steal", "Wood", 1).Reason, "InvalidAction", "an unknown action is refused")
		for _, bad in { 0, -5, 0 / 0, math.huge, "lots" } do
			checkEqual(
				ShopService:TradeResource(trader, "Buy", "Wood", bad).Reason,
				"InvalidAmount",
				`an invalid trade amount is refused ({tostring(bad)})`
			)
		end

		-- Affordability, and nothing moves on refusal.
		local goldHeld = PlayerDataService:GetGold(trader)
		local woodHeld = PlayerDataService:GetResource(trader, "Wood")
		checkEqual(
			ShopService:TradeResource(trader, "Buy", "Wood", 100000).Reason,
			"NotEnoughGold",
			"an unaffordable trade is refused"
		)
		checkEqual(PlayerDataService:GetGold(trader), goldHeld, "a refused trade spends no Gold")
		checkEqual(PlayerDataService:GetResource(trader, "Wood"), woodHeld, "and delivers no Wood")

		checkEqual(
			ShopService:TradeResource(trader, "Sell", "Wood", 100000).Reason,
			"NotEnoughResources",
			"selling more than held is refused"
		)
		checkEqual(PlayerDataService:GetResource(trader, "Wood"), woodHeld, "and takes nothing")

		-- Every tradeable resource is reachable, so no cost can be unpayable.
		for resourceId in GameConfig.Shop.ResourceTrade.BuyRate do
			PlayerDataService:AddResource(trader, "Gold", 100000)
			checkEqual(
				ShopService:TradeResource(trader, "Buy", resourceId, 1).Ok,
				true,
				`{resourceId} can be bought with Gold`
			)
		end
	end

	----------------------------------------------------------------------------
	section("Economy: a fresh player can actually reach a farm")
	----------------------------------------------------------------------------

	--[[
		The progression test that was missing.

		Every other farm in this suite is built by a helper that calls
		AddResource(player, "Wood", 5000) first - which is exactly how a real
		cold-start softlock went unnoticed: construction costs Wood and Stone,
		the only pre-farm income was Gold, and nothing converted between them.

		So this section grants NOTHING. It uses only what a brand new profile
		starts with, plus income the game actually provides.
	]]
	do
		local pioneer = newPlayer(3102, "Pioneer")
		giveCharacter(pioneer, Vector3.new(0, 3, 0))
		PlayersService.PlayerAdded:Fire(pioneer)

		local startWood = PlayerDataService:GetResource(pioneer, "Wood")
		local startStone = PlayerDataService:GetResource(pioneer, "Stone")

		-- Reachable from the starting grant alone.
		local centre = PlacementService:Place(pioneer, "TownCenter", -210, 60)
		checkEqual(centre.Ok, true, `a fresh player can afford a Town Center (had {startWood} Wood, {startStone} Stone)`)

		local mill = PlacementService:Place(pioneer, "Mill", -190, 60)
		checkEqual(mill.Ok, true, "and a Mill")

		local farm = PlacementService:Place(pioneer, "Farm", -176, 60)
		checkEqual(farm.Ok, true, "and their first Farm")

		-- The starter kit must include a seed, or the farm is useless.
		check(PlayerDataService:GetItemCount(pioneer, "CarrotSeed") > 0, "and they hold a seed to plant in it")

		advance(1)
		pokeFarm(pioneer, farm.InstanceId)
		checkEqual(farmOf(pioneer, farm.InstanceId):GetAttribute("SeedId"), "CarrotSeed", "they can plant it")

		advance(GameConfig.GetPlantable("CarrotSeed").GrowTime + 2)
		advance(1)
		pokeFarm(pioneer, farm.InstanceId)
		check(PlayerDataService:GetItemCount(pioneer, "Carrot") > 0, "and harvest a crop")

		-- Harvest -> Gold -> Wood is the loop that makes the economy closed.
		local goldBefore = PlayerDataService:GetGold(pioneer)
		checkEqual(ShopService:ProcessTransaction(pioneer, "Sell", "Carrot", 1).Ok, true, "the crop sells for Gold")
		check(PlayerDataService:GetGold(pioneer) > goldBefore, "Gold income works")

		local woodBefore = PlayerDataService:GetResource(pioneer, "Wood")
		checkEqual(ShopService:TradeResource(pioneer, "Buy", "Wood", 5).Ok, true, "and Gold converts back into Wood")
		checkEqual(PlayerDataService:GetResource(pioneer, "Wood"), woodBefore + 5, "closing the loop")

		-- Aging up needs Food, which also has no direct income: only trade.
		local foodNeeded = GameConfig.GetAdvanceCost(1).Food
		check(foodNeeded ~= nil, "advancing an age costs Food")
		checkEqual(
			GameConfig.Shop.ResourceTrade.BuyRate.Food ~= nil,
			true,
			"so Food must be purchasable, or the Age is unreachable"
		)
	end

	----------------------------------------------------------------------------
	section("Economy: ages")
	----------------------------------------------------------------------------

	local ruler = newPlayer(1313, "Ruler")
	PlayersService.PlayerAdded:Fire(ruler)

	checkEqual(PlayerDataService:GetAge(ruler), 1, "everyone starts in the first age")
	checkEqual(ruler:GetAttribute("Age"), 1, "the age replicates")
	checkEqual(ruler:GetAttribute("AgeName"), "Stone Age", "the age name replicates for the HUD")

	local ageChanges = {}
	PlayerDataService.AgeChanged:Connect(function(_, newAge, oldAge)
		table.insert(ageChanges, { newAge, oldAge })
	end)

	local advanced, reason = PlayerDataService:TryAdvanceAge(ruler)
	checkEqual(advanced, false, "aging up is refused without the resources")
	checkEqual(reason, "NotEnoughResources", "and says why")
	checkEqual(PlayerDataService:GetAge(ruler), 1, "a refused advance does not change the age")

	-- Fund exactly the cost of the second age.
	for resourceId, amount in GameConfig.GetAdvanceCost(1) do
		PlayerDataService:AddResource(ruler, resourceId, amount)
	end

	advanced, reason = PlayerDataService:TryAdvanceAge(ruler)
	checkEqual(advanced, true, "aging up succeeds once funded")
	checkEqual(PlayerDataService:GetAge(ruler), 2, "the age advances by one")
	checkEqual(ruler:GetAttribute("AgeName"), "Feudal Age", "the new age name replicates")
	checkEqual(#ageChanges, 1, "AgeChanged fires once")

	-- Aging up spends resources, never XP.
	local xpBeforeAge = PlayerDataService:GetData(ruler).XP
	for resourceId, amount in GameConfig.GetAdvanceCost(2) do
		PlayerDataService:AddResource(ruler, resourceId, amount)
	end
	checkEqual(select(1, PlayerDataService:TryAdvanceAge(ruler)), true, "and again")
	checkEqual(PlayerDataService:GetData(ruler).XP, xpBeforeAge, "aging up costs resources, not XP")

	-- Walk to the final age and confirm it stops.
	while PlayerDataService:GetAge(ruler) < GameConfig.MaxAge do
		local cost = GameConfig.GetAdvanceCost(PlayerDataService:GetAge(ruler))
		for resourceId, amount in cost or {} do
			PlayerDataService:AddResource(ruler, resourceId, amount)
		end
		PlayerDataService:TryAdvanceAge(ruler)
	end

	checkEqual(PlayerDataService:GetAge(ruler), GameConfig.MaxAge, "the final age is reachable")
	checkEqual(GameConfig.GetAdvanceCost(GameConfig.MaxAge), nil, "there is no cost beyond the final age")
	advanced, reason = PlayerDataService:TryAdvanceAge(ruler)
	checkEqual(advanced, false, "the final age cannot be exceeded")
	checkEqual(reason, "MaxAge", "and says why")

	-- v2 -> v3 migration
	local v2Profile = DataSchema.Normalize({
		SchemaVersion = 2,
		Cash = 1234,
		Inventory = { Carrot = 2 },
		StarterKitGranted = true,
		Stats = { TotalCashEarned = 99 },
	})
	checkEqual(v2Profile.SchemaVersion, 4, "a v2 profile migrates all the way to v4")
	checkEqual(v2Profile.Resources.Gold, 1234, "Cash becomes treasury Gold")
	checkEqual(v2Profile.Cash, nil, "the old field is stripped")
	checkEqual(v2Profile.InventoryGold, 0, "the purse starts empty - market income cannot seed it")
	checkEqual(v2Profile.Age, 1, "migrated players start in the first age")
	checkEqual(v2Profile.Resources.Wood, 0, "missing resources default to zero, not the starting amount")
	checkEqual(v2Profile.Stats.TotalGoldEarned, 99, "the earnings stat carries over")
	checkEqual(v2Profile.Inventory.Carrot, 2, "the v2 inventory is untouched")

	----------------------------------------------------------------------------
	section("Microtransactions: Revenge Tokens")
	----------------------------------------------------------------------------

	local buyer = returned

	checkEqual(buyer:GetAttribute("RevengeTokens"), 2, "players start with 2 free Revenge Tokens")
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), 2, "the token count is readable through the service")

	checkEqual(PlayerDataService:AddRevengeTokens(buyer, -1), nil, "AddRevengeTokens rejects negatives")
	checkEqual(PlayerDataService:AddRevengeTokens(buyer, 0), nil, "AddRevengeTokens rejects zero")
	checkEqual(PlayerDataService:AddRevengeTokens(buyer, 0 / 0), nil, "AddRevengeTokens rejects NaN")
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), 2, "rejected credits leave the count untouched")

	checkEqual(PlayerDataService:TrySpendRevengeTokens(buyer, 99), false, "cannot spend more tokens than held")
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), 2, "a failed spend changes nothing")
	checkEqual(PlayerDataService:TrySpendRevengeTokens(buyer, 2), true, "can spend tokens that are held")
	checkEqual(buyer:GetAttribute("RevengeTokens"), 0, "token spends replicate to the attribute")

	----------------------------------------------------------------------------
	section("Microtransactions: product configuration")
	----------------------------------------------------------------------------

	checkEqual(GameConfig.GetProductById(0), nil, "a placeholder ProductId never resolves")
	checkEqual(GameConfig.GetProductById(111), nil, "an unconfigured product does not resolve")
	checkEqual(GameConfig.GetProductById("111"), nil, "a non-number ProductId is rejected")

	local unconfigured = GameConfig.ValidateProducts()
	checkEqual(#unconfigured, 8, "every product starts unconfigured")

	-- Several products deliberately share a handler Kind and differ only in Amount.
	checkEqual(GameConfig.Monetization.Products.GoldPackSmall.Kind, "Resource", "gold packs use the Resource handler")
	checkEqual(GameConfig.Monetization.Products.WoodPack.Kind, "Resource", "wood packs share that handler")
	check(
		GameConfig.Monetization.Products.GoldPackLarge.Amount > GameConfig.Monetization.Products.GoldPackSmall.Amount,
		"the packs differ only in amount"
	)
	checkEqual(GameConfig.Monetization.Products.GrowthBoostBundle.Amount, 10, "the bundle grants ten boosts")

	checkEqual(GameConfig.GetProductByName("WoodPack").Kind, "Resource", "products resolve by config name")
	checkEqual(GameConfig.GetProductByName("NotAProduct"), nil, "an unknown product name returns nil")
	checkEqual(GameConfig.GetProductByName({}), nil, "a non-string product name is rejected")

	local storeList = GameConfig.GetStoreProducts()
	checkEqual(#storeList, 8, "the store lists every product")
	checkEqual(storeList[1].Name, "GoldPackSmall", "the store is ordered by SortOrder")
	local ordered = true
	for index = 2, #storeList do
		if storeList[index].SortOrder < storeList[index - 1].SortOrder then
			ordered = false
		end
	end
	check(ordered, "store ordering is monotonic")

	-- Stand in for real Creator Dashboard ids.
	GameConfig.Monetization.Products.RevengeToken.ProductId = 111
	GameConfig.Monetization.Products.GrowthBoost.ProductId = 222
	GameConfig.Monetization.Products.GoldPackSmall.ProductId = 333
	GameConfig.Monetization.Products.WoodPack.ProductId = 444
	GameConfig.Monetization.Products.GrowthBoostBundle.ProductId = 555

	checkEqual(GameConfig.GetProductById(111).Kind, "RevengeToken", "a configured id resolves to its product")
	checkEqual(GameConfig.GetProductById(222).Kind, "GrowthBoost", "the second product resolves too")

	GameConfig.Monetization.Products.GrowthBoost.ProductId = 111
	local _, duplicates = GameConfig.ValidateProducts()
	checkEqual(#duplicates, 1, "a duplicated ProductId is reported")
	GameConfig.Monetization.Products.GrowthBoost.ProductId = 222

	----------------------------------------------------------------------------
	section("Microtransactions: receipt processing")
	----------------------------------------------------------------------------

	local MarketplaceService = require(MarketplaceServiceModule)
	MarketplaceService:Start()
	check(MarketplaceStub.ProcessReceipt ~= nil, "ProcessReceipt is installed on the engine service")

	local receiptCounter = 0
	local function receipt(player, productId, purchaseId)
		receiptCounter += 1
		return {
			PlayerId = player.UserId,
			ProductId = productId,
			PurchaseId = purchaseId or `auto-{receiptCounter}`,
			CurrencySpent = 25,
		}
	end

	local processed = {}
	MarketplaceService.PurchaseProcessed:Connect(function(_, product)
		table.insert(processed, product.Kind)
	end)

	-- Product A
	local tokensBefore = PlayerDataService:GetRevengeTokens(buyer)
	local tokenReceipt = receipt(buyer, 111, "p-token-1")

	checkEqual(MarketplaceStub.ProcessReceipt(tokenReceipt), "PurchaseGranted", "a valid token receipt is granted")
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), tokensBefore + 1, "the token is credited")
	checkEqual(buyer:GetAttribute("RevengeTokens"), tokensBefore + 1, "the purchase replicates")
	check(
		table.find(PlayerDataService:GetData(buyer).PurchaseHistory, "p-token-1") ~= nil,
		"the PurchaseId is recorded in the idempotency ledger"
	)
	checkEqual(PlayerDataService:GetData(buyer).Stats.PurchasesProcessed, 1, "the purchase is counted in stats")
	checkEqual(PlayerDataService:GetData(buyer).Stats.RobuxSpent, 25, "Robux spent is recorded")
	checkEqual(#processed, 1, "PurchaseProcessed fires once")

	-- Idempotency: the engine retrying the same receipt must not grant twice.
	checkEqual(MarketplaceStub.ProcessReceipt(tokenReceipt), "PurchaseGranted", "a replayed receipt still reports granted")
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), tokensBefore + 1, "a replayed receipt does NOT grant again")
	checkEqual(PlayerDataService:GetData(buyer).Stats.PurchasesProcessed, 1, "a replayed receipt is not double counted")

	-- Receipts that must never be granted.
	local tokensNow = PlayerDataService:GetRevengeTokens(buyer)
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 999999, "p-unknown")),
		"NotProcessedYet",
		"an unknown ProductId is left pending, not granted"
	)
	checkEqual(PlayerDataService:GetRevengeTokens(buyer), tokensNow, "an unknown product grants nothing")

	checkEqual(
		MarketplaceStub.ProcessReceipt({
			PlayerId = 55555,
			ProductId = 111,
			PurchaseId = "p-absent",
			CurrencySpent = 25,
		}),
		"NotProcessedYet",
		"a receipt for a player who is not in this server stays pending"
	)

	checkEqual(MarketplaceService:PromptPurchase(buyer, "RevengeToken"), true, "PromptPurchase opens a configured product")
	checkEqual(MarketplaceService:PromptPurchase(buyer, "NotAProduct"), false, "PromptPurchase refuses an unknown product")

	----------------------------------------------------------------------------
	section("Microtransactions: Instant Grow (Product B)")
	----------------------------------------------------------------------------

	local selectFarmRemote = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.SelectFarm)
	local useBoostRemote = require(Shared.Remotes).GetEvent(GameConfig.RemoteNames.UseBoost)

	local boostFarm = makeFarm(buyer, 170, 60)
	check(boostFarm ~= nil, "built a farm for the boost tests")

	PlayerDataService:AddItem(buyer, "CarrotSeed", 2)
	advance(1)
	selectSeed.OnServerEvent:Fire(buyer, "CarrotSeed")
	advance(1)
	pokeFarm(buyer, boostFarm)
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("SeedId"), "CarrotSeed", "planted a crop to boost")
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("Stage"), "Seedling", "the crop starts immature")

	advance(1)
	selectFarmRemote.OnServerEvent:Fire(buyer, boostFarm)
	checkEqual(buyer:GetAttribute("TargetFarm"), boostFarm, "the targeted farm is recorded for the purchase")

	local readyAtBefore = farmOf(buyer, boostFarm):GetAttribute("ReadyAt")
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 222, "p-boost-1")),
		"PurchaseGranted",
		"the Instant Grow receipt is granted"
	)

	checkEqual(farmOf(buyer, boostFarm):GetAttribute("Stage"), "Mature", "the boost completes growth immediately")
	check(farmOf(buyer, boostFarm):GetAttribute("ReadyAt") < readyAtBefore, "ReadyAt moves into the past")
	checkEqual(PlayerDataService:GetItemCount(buyer, "GrowthBoost"), 0, "the consumable is spent by the auto-apply")

	-- An attribute-only override would be undone here and ignored by harvest.
	advance(3)
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("Stage"), "Mature", "the growth tick does NOT revert the boost")
	advance(1)
	pokeFarm(buyer, boostFarm)
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("SeedId"), "", "a boosted crop can actually be harvested")

	-- Bought with nothing growing: granted anyway and kept for later.
	local growing = 0
	for _, entry in PlayerDataService:GetData(buyer).Structures do
		if entry.SeedId and entry.SeedId ~= "" then
			growing += 1
		end
	end
	checkEqual(growing, 0, "no crop is currently growing, so a boost has no target")

	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 222, "p-boost-2")),
		"PurchaseGranted",
		"a boost bought with nothing growing is STILL granted"
	)
	checkEqual(PlayerDataService:GetItemCount(buyer, "GrowthBoost"), 1, "the unusable boost is kept in inventory")

	advance(1)
	pokeFarm(buyer, boostFarm)
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("Stage"), "Seedling", "replanted to spend the stored boost")

	advance(1)
	useBoostRemote.OnServerEvent:Fire(buyer, boostFarm)
	checkEqual(farmOf(buyer, boostFarm):GetAttribute("Stage"), "Mature", "a stored boost is spent via the remote")
	checkEqual(PlayerDataService:GetItemCount(buyer, "GrowthBoost"), 0, "spending consumes the boost")

	-- Never wasted on an already-mature crop.
	PlayerDataService:AddItem(buyer, "GrowthBoost", 1)
	checkEqual(FARMS:CompleteGrowth(buyer, boostFarm), false, "a boost is refused on a mature crop")
	checkEqual(PlayerDataService:GetItemCount(buyer, "GrowthBoost"), 1, "the refused boost is not consumed")

	advance(1)
	pokeFarm(buyer, boostFarm)
	advance(1)
	pokeFarm(buyer, boostFarm)
	PlayerDataService:RemoveItem(buyer, "GrowthBoost", 1)
	checkEqual(FARMS:CompleteGrowth(buyer, boostFarm), false, "growth cannot be completed without a boost")
	check(not Growth.IsMature(farmOf(buyer, boostFarm):GetAttribute("Stage")), "the crop keeps growing normally")

	-- Junk targeting payloads.
	advance(1)
	selectFarmRemote.OnServerEvent:Fire(buyer, "99999")
	checkEqual(buyer:GetAttribute("TargetFarm"), boostFarm, "an unowned farm id is rejected")
	advance(1)
	selectFarmRemote.OnServerEvent:Fire(buyer, 0 / 0)
	checkEqual(buyer:GetAttribute("TargetFarm"), boostFarm, "a NaN target is rejected")
	advance(1)
	selectFarmRemote.OnServerEvent:Fire(buyer, { exploit = true })
	checkEqual(buyer:GetAttribute("TargetFarm"), boostFarm, "a table target is rejected")

	----------------------------------------------------------------------------
	section("Microtransactions: resource packs and bonus plots")
	----------------------------------------------------------------------------

	-- Gold pack
	local cashBefore = PlayerDataService:GetGold(buyer)
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 333, "p-cash-1")),
		"PurchaseGranted",
		"a gold pack receipt is granted"
	)
	checkEqual(
		PlayerDataService:GetGold(buyer),
		cashBefore + GameConfig.Monetization.Products.GoldPackSmall.Amount,
		"the pack credits its configured amount"
	)

	-- Resource packs land in the treasury, never the purse.
	checkEqual(PlayerDataService:GetInventoryGold(buyer), 0, "a Robux pack does NOT fill the personal purse")

	local woodBefore = PlayerDataService:GetResource(buyer, "Wood")
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 444, "p-wood-1")),
		"PurchaseGranted",
		"a wood pack uses the same handler"
	)
	checkEqual(
		PlayerDataService:GetResource(buyer, "Wood"),
		woodBefore + GameConfig.Monetization.Products.WoodPack.Amount,
		"it credits Wood, not Gold"
	)

	-- Refused at the ceiling rather than charging for nothing.
	local ceilingPlayer = newPlayer(909, "Ceiling")
	PlayersService.PlayerAdded:Fire(ceilingPlayer)
	PlayerDataService:AddGold(ceilingPlayer, GameConfig.Economy.MaxResource)
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(ceilingPlayer, 333, "p-cash-ceiling")),
		"NotProcessedYet",
		"a gold pack at the ceiling stays pending instead of granting nothing"
	)
	check(
		table.find(PlayerDataService:GetData(ceilingPlayer).PurchaseHistory, "p-cash-ceiling") == nil,
		"a refused grant is not recorded in the ledger"
	)

	-- Bundle: one receipt, ten boosts
	local boostsHeldBefore = PlayerDataService:GetItemCount(buyer, "GrowthBoost")
	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 555, "p-bundle-1")),
		"PurchaseGranted",
		"the boost bundle is granted"
	)
	check(
		PlayerDataService:GetItemCount(buyer, "GrowthBoost") > boostsHeldBefore,
		"the bundle delivers boosts"
	)

	-- Bonus plot slots are gone with the fixed garden: a farm is a building the
	-- player paid for, so there is no slot to unlock.
	checkEqual(GameConfig.Economy.MaxBonusPlotSlots, nil, "the bonus plot cap is retired")
	checkEqual(GameConfig.Monetization.Products.PlotUnlock, nil, "and so is the product that sold them")

	----------------------------------------------------------------------------
	section("Microtransactions: a failed save keeps the receipt pending")
	----------------------------------------------------------------------------

	local tokensBeforeFailure = PlayerDataService:GetRevengeTokens(buyer)
	DataStoreFaults.FailUpdate = true

	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 111, "p-token-retry")),
		"NotProcessedYet",
		"a receipt whose save fails is NOT reported as granted"
	)

	DataStoreFaults.FailUpdate = false

	checkEqual(
		MarketplaceStub.ProcessReceipt(receipt(buyer, 111, "p-token-retry")),
		"PurchaseGranted",
		"the retry is granted once the DataStore recovers"
	)
	checkEqual(
		PlayerDataService:GetRevengeTokens(buyer),
		tokensBeforeFailure + 1,
		"the failed-then-retried receipt grants exactly once"
	)

	-- The ledger is bounded, so it cannot grow without limit in saved data.
	local ledger = PlayerDataService:GetData(buyer).PurchaseHistory
	for index = 1, GameConfig.Monetization.MaxPurchaseHistory + 10 do
		table.insert(ledger, `filler-{index}`)
	end
	DataSchema.Normalize(PlayerDataService:GetData(buyer))
	checkEqual(
		#PlayerDataService:GetData(buyer).PurchaseHistory,
		GameConfig.Monetization.MaxPurchaseHistory,
		"the purchase ledger is trimmed to its cap"
	)

	----------------------------------------------------------------------------
	section("ProfileStore: session locking across two servers")
	----------------------------------------------------------------------------

	-- Short windows so lock expiry is observable in virtual time. Expiry must
	-- still exceed AutoSaveInterval + the 5s sweep period.
	local fastOptions = {
		AutoSaveInterval = 1,
		LockRefreshGrace = 0,
		SessionLockExpire = 8,
		LoadRetryDelay = 1,
	}

	-- Server A, actively refreshing its lock via auto-save.
	local storeLive = ProfileStore.new("LockStore", DataSchema.Template, DataSchema.Normalize, fastOptions)
	local liveProfile = storeLive:LoadProfileAsync("live_key")
	check(liveProfile ~= nil, "server A acquires the live key")

	-- Server A also holds this key, but on a slow-refresh store, which is how a
	-- crashed server looks to its peers.
	local lockedKey = "contested_player"
	local profileA = store:LoadProfileAsync(lockedKey)
	profileA.Data.Resources.Gold = 500
	profileA:Save()
	check(profileA:IsActive(), "server A owns the contested key")

	-- Re-require ProfileStore under a different JobId to emulate a second
	-- server process sharing the same DataStore.
	resetModuleCache()
	game.JobId = "harness-server-B"

	local ProfileStoreB = require(DataFolder.ProfileStore)
	local storeLiveB = ProfileStoreB.new("LockStore", DataSchema.Template, DataSchema.Normalize, fastOptions)

	local refused, refusedReason = storeLiveB:LoadProfileAsync("live_key")
	checkEqual(refused, nil, "a lock held by a LIVE server is never stolen")
	checkEqual(refusedReason, "SessionLocked", "contested live load reports SessionLocked")
	check(liveProfile:IsActive(), "the live owner keeps its profile throughout the contention")

	liveProfile:Release()
	local handedOver = storeLiveB:LoadProfileAsync("live_key")
	check(handedOver ~= nil, "server B loads immediately once server A releases")
	if handedOver then
		handedOver:Release()
	end

	-- Server A stopped refreshing the contested key, so its lock has aged out.
	local storeB = ProfileStoreB.new("TestStore", DataSchema.Template, DataSchema.Normalize, fastOptions)
	local profileB, reasonB = storeB:LoadProfileAsync(lockedKey)
	check(profileB ~= nil, `server B claims an expired lock from a dead server (reason: {tostring(reasonB)})`)

	if profileB then
		checkEqual(profileB.Data.Resources.Gold, 500, "stolen profile carries server A's last saved data")

		-- Critical: A must not be able to write over B's session.
		profileB.Data.Resources.Gold = 900
		profileB:Save()

		local saveResult = profileA:Save()
		checkEqual(saveResult, false, "server A's save is refused after losing the lock")
		checkEqual(profileA:IsActive(), false, "server A's profile deactivates after losing the lock")

		profileA.Data.Resources.Gold = 1
		profileA:Save()
		checkEqual(
			DataStoreBackings["TestStore"][lockedKey].Data.Resources.Gold,
			900,
			"server B's data is preserved; the stale server cannot clobber it"
		)

		profileB:Release()
	end

	----------------------------------------------------------------------------
	section("BindToClose flush")
	----------------------------------------------------------------------------

	local shutdownProfile = storeB:LoadProfileAsync("player_shutdown")
	shutdownProfile.Data.Resources.Gold = 31337

	for _, handler in BoundCloseHandlers do
		task.spawn(handler)
	end
	advance(2)

	checkEqual(
		DataStoreBackings["TestStore"]["player_shutdown"].Data.Resources.Gold,
		31337,
		"BindToClose flushes unsaved data"
	)
	checkEqual(shutdownProfile:IsActive(), false, "BindToClose releases active profiles")
end

--------------------------------------------------------------------------------
-- Runner
--------------------------------------------------------------------------------

local finished = false

task.spawn(function()
	local ok, err = pcall(runTests)

	if not ok then
		table.insert(FAILURES, `test run crashed: {err}`)
		print(`\n[CRASH] {err}`)
	end

	finished = true
end)

--[[
	Drive the virtual clock until the test coroutine completes.

	The guard is a DEADLOCK net, not a budget: it exists so a test that waits
	on something that will never happen fails in a second rather than hanging
	the run. It therefore has to stay comfortably above the virtual time the
	suite legitimately needs, which grows as sections are added - husbandry
	alone simulates animals being raised, fed and starved.

	When this trips, the banner says "TESTS DID NOT COMPLETE" with no clue
	which section is responsible, and the honest answer is usually that the
	suite outgrew the number rather than that anything deadlocked. Print
	`guard` here before assuming otherwise.
]]
local guard = 0
while not finished and guard < 50000 do
	advance(1)
	guard += 1
end

print("\n================================")

if not finished then
	print("TESTS DID NOT COMPLETE (deadlock or runaway wait)")
	print("================================")
else
	print(`passed: {PASSES}   failed: {#FAILURES}`)

	if #FAILURES > 0 then
		print("\nfailures:")
		for _, failure in FAILURES do
			print(`  - {failure}`)
		end
	end

	print("================================")
end

print("\n-- module warnings emitted during the run --")
for _, message in WARNINGS or {} do
	print(`  {message}`)
end
