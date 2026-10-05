--!nonstrict
--[[
	Bootstrap
	---------
	The single server entry point. Services are started here in dependency
	order, so load order is explicit rather than an accident of script
	execution.

	Step 1 of the build: data and stats only. Later steps (plots, growth,
	shop, selling) register below the marker and should depend on
	PlayerDataService rather than touching DataStores themselves.
]]

local PlayerDataService = require(script.Parent.Services.PlayerDataService)

PlayerDataService:Start()

-- Example of how downstream systems consume the data layer. Safe to delete.
PlayerDataService.LevelChanged:Connect(function(player: Player, newLevel: number, previousLevel: number)
	print(`[Progression] {player.Name}: level {previousLevel} -> {newLevel}`)
end)

-- << Register additional services here as later steps are added >>

print("[Server] Bootstrap complete")
