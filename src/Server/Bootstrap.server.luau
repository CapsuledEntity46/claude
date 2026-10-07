--!nonstrict
--[[
	Bootstrap
	---------
	The single server entry point. Services are started here in dependency
	order, so load order is explicit rather than an accident of script
	execution.

	PlayerDataService must start first: everything else reads levels, cash and
	inventory through it.

	DEPENDENCY RESOLUTION
	---------------------
	Nothing here calls require() on a value that might be nil. `require(nil)`
	reports "Attempted to call require with invalid argument(s)" against the
	Bootstrap line number, which tells you nothing about WHICH module is
	absent - and a half-synced Studio tree is the common cause.

	So every dependency is resolved with FindFirstChild first, misses are
	collected, and a single error names every missing path at once.

	FrameworkGuard is deliberately OPTIONAL. It is a diagnostic, not a runtime
	dependency, and hard-requiring it meant a missing guard crashed the very
	startup it was supposed to explain.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local serverRoot = script.Parent
local missing: { string } = {}

--- Walks a dotted path with FindFirstChild. Returns nil if any segment is absent.
local function resolve(root: Instance?, path: string): Instance?
	local current = root

	for segment in string.gmatch(path, "[^%.]+") do
		if not current then
			return nil
		end

		current = current:FindFirstChild(segment)
	end

	return current
end

--- Requires a module under Server by dotted path, or records it as missing.
--- Never calls require on nil.
local function requireServer(path: string): any?
	local instance = resolve(serverRoot, path)

	if not instance then
		table.insert(missing, `ServerScriptService.Server.{path}`)
		return nil
	end

	return require(instance)
end

--------------------------------------------------------------------------------
-- Resolve everything before starting anything
--------------------------------------------------------------------------------

local sharedFolder = ReplicatedStorage:WaitForChild("Shared", 15)
local gameConfigModule = resolve(sharedFolder, "GameConfig")
local GameConfig = if gameConfigModule then require(gameConfigModule) else nil

if not GameConfig then
	table.insert(missing, "ReplicatedStorage.Shared.GameConfig")
end

local DamageableService = requireServer("Combat.DamageableService")
local StatusEffectService = requireServer("Combat.StatusEffectService")
local PlayerDataService = requireServer("Services.PlayerDataService")
local FarmService = requireServer("Services.FarmService")
local ShopService = requireServer("Services.ShopService")
local MarketplaceService = requireServer("Services.MarketplaceService")
local PlacementService = requireServer("World.PlacementService")
local ShopBuilder = requireServer("World.ShopBuilder")

if #missing > 0 then
	error(
		table.concat({
			"",
			"=================================================================",
			" MISSING MODULES - server startup aborted",
			"=================================================================",
			"",
			"  " .. table.concat(missing, "\n  "),
			"",
			"These exist in the repository but not in this place, so the tree",
			"is only partly synced.",
			"",
			"To fix:",
			"  1. Stop the Rojo server and confirm `git status` is clean.",
			"  2. In Studio delete ServerScriptService.Server,",
			"     ReplicatedStorage.Shared and",
			"     StarterPlayer.StarterPlayerScripts.Client.",
			"  3. Run `rojo serve` and re-connect, or `rojo build -o game.rbxl`",
			"     and open the fresh place.",
			"",
			"Rojo only overwrites the paths in default.project.json, and its file",
			"watcher can miss files added while a sync session is already running.",
			"=================================================================",
			"",
		}, "\n"),
		0
	)
end

--------------------------------------------------------------------------------
-- Optional consistency check
--------------------------------------------------------------------------------

-- Absence must never stop the server booting: this only improves the error
-- message when modules disagree about shared config.
local guardModule = resolve(serverRoot, "FrameworkGuard")

if guardModule then
	require(guardModule).Assert(GameConfig.FrameworkVersion, {
		DamageableService = DamageableService,
		StatusEffectService = StatusEffectService,
		PlayerDataService = PlayerDataService,
		FarmService = FarmService,
		PlacementService = PlacementService,
		ShopService = ShopService,
		MarketplaceService = MarketplaceService,
	})
else
	warn(
		"[Bootstrap] ServerScriptService.Server.FrameworkGuard is missing, so the module "
			.. "consistency check was skipped. Re-sync Rojo to restore it."
	)
end

--------------------------------------------------------------------------------
-- Start up
--------------------------------------------------------------------------------

PlayerDataService:Start()
DamageableService:Start()

-- After the registry it hooks, so no Destroyed signal fires before it listens.
StatusEffectService:Start()

FarmService:Start()
PlacementService:Start()
ShopService:Start()

-- Started last: its receipt handlers grant through the services above.
MarketplaceService:Start()

-- The storefront the client's ProximityPrompt listener attaches to.
ShopBuilder.Build()

-- Examples of how downstream systems consume these layers. Safe to delete.
PlayerDataService.LevelChanged:Connect(function(player: Player, newLevel: number, previousLevel: number)
	print(`[Progression] {player.Name}: level {previousLevel} -> {newLevel}`)
end)

FarmService.Harvested:Connect(function(player: Player, instanceId: string, itemId: string, amount: number)
	print(`[Farm] {player.Name} harvested {amount}x {itemId} from farm {instanceId}`)
end)

-- << Register additional services here as later steps are added >>

print(`[Server] Bootstrap complete (framework v{GameConfig.FrameworkVersion})`)
