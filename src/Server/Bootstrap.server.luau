--!nonstrict
--[[
	Bootstrap
	---------
	The single server entry point. Services are started here in dependency
	order, so load order is explicit rather than an accident of script
	execution.

	PlayerDataService must start first: everything else reads levels, cash and
	inventory through it.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GameConfig = require(ReplicatedStorage:WaitForChild("Shared").GameConfig)

local Services = script.Parent.Services

local PlayerDataService = require(Services.PlayerDataService)
local PlotService = require(Services.PlotService)
local ShopService = require(Services.ShopService)
local MarketplaceService = require(Services.MarketplaceService)

local FrameworkGuard = require(script.Parent.FrameworkGuard)
local ShopBuilder = require(script.Parent.World.ShopBuilder)

--[[
	Fail fast on a half-synced tree. Without this, a stale module shows up much
	later as a nil-index in unrelated code, with line numbers that no longer
	match the file on disk.
]]
FrameworkGuard.Assert(GameConfig.FrameworkVersion, {
	PlayerDataService = PlayerDataService,
	PlotService = PlotService,
	ShopService = ShopService,
	MarketplaceService = MarketplaceService,
})

PlayerDataService:Start()
PlotService:Start()
ShopService:Start()

-- Started last: its receipt handlers grant through the services above.
MarketplaceService:Start()

-- The storefront the client's ProximityPrompt listener attaches to.
ShopBuilder.Build()

-- Examples of how downstream systems consume these layers. Safe to delete.
PlayerDataService.LevelChanged:Connect(function(player: Player, newLevel: number, previousLevel: number)
	print(`[Progression] {player.Name}: level {previousLevel} -> {newLevel}`)
end)

PlotService.Harvested:Connect(function(player: Player, plotIndex: number, itemId: string)
	print(`[Garden] {player.Name} harvested {itemId} from plot {plotIndex}`)
end)

-- << Register additional services here as later steps are added >>

print("[Server] Bootstrap complete")
