--!nonstrict
--[[
	Bootstrap
	---------
	The single server entry point. Services are started here in dependency
	order, so load order is explicit rather than an accident of script
	execution.

	PlayerDataService must start first: PlotService listens to its
	ProfileLoaded signal and reads levels/inventory through it.
]]

local Services = script.Parent.Services

local PlayerDataService = require(Services.PlayerDataService)
local PlotService = require(Services.PlotService)
local ShopService = require(Services.ShopService)
local MarketplaceService = require(Services.MarketplaceService)

PlayerDataService:Start()
PlotService:Start()
ShopService:Start()

-- Started last: its receipt handlers grant through the services above.
MarketplaceService:Start()

-- Examples of how downstream systems consume these layers. Safe to delete.
PlayerDataService.LevelChanged:Connect(function(player: Player, newLevel: number, previousLevel: number)
	print(`[Progression] {player.Name}: level {previousLevel} -> {newLevel}`)
end)

PlotService.Harvested:Connect(function(player: Player, plotIndex: number, seedId: string)
	print(`[Garden] {player.Name} harvested {seedId} from plot {plotIndex}`)
end)

-- << Register additional services here as later steps are added >>

print("[Server] Bootstrap complete")
