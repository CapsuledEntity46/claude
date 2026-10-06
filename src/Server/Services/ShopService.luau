--!nonstrict
--[[
	ShopService
	-----------
	Closes the economy loop: Cash -> seeds -> crops -> Cash.

	Buying uses GameConfig SeedPrice, selling uses SellPrice. Both go through
	PlayerDataService's atomic mutators, so money and items can never diverge.

	TRANSACTION RULES
	-----------------
	1. The client sends intent only - a seed id and a quantity. Prices, level
	   gates and stack limits all come from GameConfig on the server. A client
	   cannot propose a price.
	2. Capacity is checked BEFORE money moves, so the happy path never needs a
	   refund. The refund branches that remain are defence in depth, not the
	   expected flow.
	3. Every quantity is sanitised to a positive integer and clamped to a
	   per-request cap. That bounds the arithmetic as much as the economy:
	   unbounded quantities push intermediate products past the range where
	   doubles represent integers exactly.
	4. Selling respects the Cash ceiling precisely rather than letting AddCash
	   clamp. Clamping would consume crops for less than they are worth, which
	   looks exactly like theft to the player.
	5. Handlers return a result table, never an error. An erroring
	   OnServerInvoke surfaces on the client as a thrown error and advertises an
	   unhandled path.

	Failure reasons are stable codes for the UI to map to copy:
	  NoData, InvalidSeed, InvalidCrop, InvalidQuantity, LevelTooLow,
	  NotEnoughCash, NotEnoughCrops, StackFull, CashCapped, NothingToSell,
	  RateLimited, InternalError
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local RateLimiter = require(Shared.RateLimiter)
local Remotes = require(Shared.Remotes)
local Signal = require(Shared.Signal)

local PlayerDataService = require(script.Parent.PlayerDataService)

local ShopService = {}

ShopService._started = false
ShopService._limiter = nil

--- (player, seedId, quantity, totalCost)
ShopService.SeedPurchased = Signal.new()
--- (player, cropId, quantity, totalEarned)
ShopService.CropSold = Signal.new()

--------------------------------------------------------------------------------
-- Result helpers
--------------------------------------------------------------------------------

local function failure(reason: string)
	return { Ok = false, Reason = reason }
end

local function success(fields: { [string]: any })
	fields.Ok = true
	return fields
end

--[[
	Coerces an untrusted quantity into a positive integer, clamped to `maximum`.
	Returns nil when the input could not be a quantity at all.

	Rejects NaN (it fails the self-comparison inside the finite check) and
	infinity (which survives math.floor and would poison every later product).
]]
local function sanitizeQuantity(value: unknown, maximum: number): number?
	local number = tonumber(value)

	if number == nil or number ~= number or number == math.huge or number == -math.huge then
		return nil
	end

	number = math.floor(number)

	if number < 1 then
		return nil
	end

	return math.min(number, maximum)
end

--------------------------------------------------------------------------------
-- Buying
--------------------------------------------------------------------------------

--[[
	Buys `quantity` of `seedId`, charging SeedPrice each.

	Safe to call directly from server code (NPCs, quest rewards, tutorials);
	the remote handler is only a thin validated wrapper around it.
]]
function ShopService:BuySeed(player: Player, seedId: unknown, quantity: unknown)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	local seed = GameConfig.GetSeed(seedId)
	if not seed then
		return failure("InvalidSeed")
	end

	local amount = sanitizeQuantity(quantity, GameConfig.Shop.MaxBuyQuantity)
	if not amount then
		return failure("InvalidQuantity")
	end

	if PlayerDataService:GetLevel(player) < seed.RequiredLevel then
		return failure("LevelTooLow")
	end

	-- Capacity first: taking money for seeds that cannot fit would require a
	-- refund, and a refund is a second chance to get the accounting wrong.
	local held = PlayerDataService:GetItemCount(player, "Seeds", seed.Id)
	if held + amount > GameConfig.Inventory.MaxStack then
		return failure("StackFull")
	end

	local totalCost = seed.SeedPrice * amount

	if not PlayerDataService:TrySpendCash(player, totalCost) then
		return failure("NotEnoughCash")
	end

	local newHeld = PlayerDataService:AddItem(player, "Seeds", seed.Id, amount)

	if not newHeld then
		-- Unreachable given the capacity check above. If it ever fires, give
		-- the money back rather than quietly keeping it.
		PlayerDataService:AddCash(player, totalCost)
		warn(`[ShopService] Refunded {totalCost} to {player.Name}: AddItem failed after payment`)
		return failure("StackFull")
	end

	PlayerDataService:IncrementStat(player, "TotalSeedsBought", amount)
	self.SeedPurchased:Fire(player, seed.Id, amount, totalCost)

	return success({
		SeedId = seed.Id,
		Quantity = amount,
		Spent = totalCost,
		Held = newHeld,
		Cash = PlayerDataService:GetCash(player),
	})
end

--------------------------------------------------------------------------------
-- Selling
--------------------------------------------------------------------------------

--[[
	Sells `quantity` harvested crops of `cropId` at SellPrice each.

	Crops are keyed by the same ids as seeds, so GameConfig.GetSeed is the
	validator for both.
]]
function ShopService:SellCrop(player: Player, cropId: unknown, quantity: unknown)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	local seed = GameConfig.GetSeed(cropId)
	if not seed then
		return failure("InvalidCrop")
	end

	local amount = sanitizeQuantity(quantity, GameConfig.Shop.MaxSellQuantity)
	if not amount then
		return failure("InvalidQuantity")
	end

	local held = PlayerDataService:GetItemCount(player, "Crops", seed.Id)
	if held < amount then
		return failure("NotEnoughCrops")
	end

	-- Sell only as much as the Cash ceiling can actually pay for. Letting
	-- AddCash clamp instead would take the crops and silently underpay.
	local headroom = GameConfig.Economy.MaxCash - PlayerDataService:GetCash(player)
	local affordable = math.floor(headroom / seed.SellPrice)

	if affordable < 1 then
		return failure("CashCapped")
	end

	amount = math.min(amount, affordable)
	local totalEarned = seed.SellPrice * amount

	if not PlayerDataService:RemoveItem(player, "Crops", seed.Id, amount) then
		return failure("NotEnoughCrops")
	end

	if not PlayerDataService:AddCash(player, totalEarned) then
		-- Put the crops back; never destroy goods we failed to pay for.
		PlayerDataService:AddItem(player, "Crops", seed.Id, amount)
		warn(`[ShopService] Returned {amount}x {seed.Id} to {player.Name}: payout failed`)
		return failure("InternalError")
	end

	PlayerDataService:IncrementStat(player, "TotalCropsSold", amount)
	self.CropSold:Fire(player, seed.Id, amount, totalEarned)

	return success({
		CropId = seed.Id,
		Quantity = amount,
		Earned = totalEarned,
		Held = PlayerDataService:GetItemCount(player, "Crops", seed.Id),
		Cash = PlayerDataService:GetCash(player),
	})
end

--[[
	Sells every harvested crop the player holds.

	Iteration is sorted by crop id because Luau dictionary order is unspecified
	- without it, a player at the Cash ceiling would have an arbitrary subset of
	their crops sold, differing between calls.
]]
function ShopService:SellAllCrops(player: Player)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	local inventory = PlayerDataService:GetInventory(player, "Crops")

	local cropIds = {}
	for cropId in inventory do
		table.insert(cropIds, cropId)
	end
	table.sort(cropIds)

	local totalEarned, totalSold = 0, 0
	local breakdown = {}
	local lastReason = nil

	for _, cropId in cropIds do
		local result = self:SellCrop(player, cropId, inventory[cropId])

		if result.Ok then
			totalEarned += result.Earned
			totalSold += result.Quantity
			breakdown[cropId] = result.Quantity
		else
			lastReason = result.Reason
		end
	end

	if totalSold < 1 then
		-- Surface the real blocker (CashCapped) rather than a generic empty
		-- result, so the UI can explain why nothing sold.
		return failure(lastReason or "NothingToSell")
	end

	return success({
		Quantity = totalSold,
		Earned = totalEarned,
		Sold = breakdown,
		Cash = PlayerDataService:GetCash(player),
	})
end

--------------------------------------------------------------------------------
-- Catalog
--------------------------------------------------------------------------------

--- Seeds this player can currently buy, cheapest first. The client can derive
--- the same list from GameConfig; this exists for server-side callers.
function ShopService:GetCatalog(player: Player)
	return GameConfig.GetPurchasableSeeds(PlayerDataService:GetLevel(player))
end

--------------------------------------------------------------------------------
-- Remote plumbing
--------------------------------------------------------------------------------

--[[
	Wraps every remote-facing transaction: throttle, run, never throw.

	The pcall is not decoration. A RemoteFunction handler that errors reports
	that error to the caller, which both breaks the UI and tells an attacker
	which inputs reach an unhandled path.
]]
function ShopService:_handle(player: Player, operation: () -> any)
	if not self._limiter:Consume(player) then
		return failure("RateLimited")
	end

	local ok, result = pcall(operation)

	if not ok then
		warn(`[ShopService] Transaction errored for {player.Name}: {result}`)
		return failure("InternalError")
	end

	return result
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function ShopService:Start()
	assert(RunService:IsServer(), "ShopService is server-only")

	if self._started then
		return self
	end
	self._started = true

	self._limiter = RateLimiter.new(GameConfig.Shop.RequestsPerSecond, GameConfig.Shop.BurstSize)

	local buySeed = Remotes.GetFunction(GameConfig.RemoteNames.BuySeed)
	local sellCrop = Remotes.GetFunction(GameConfig.RemoteNames.SellCrop)
	local sellAllCrops = Remotes.GetFunction(GameConfig.RemoteNames.SellAllCrops)

	buySeed.OnServerInvoke = function(player: Player, seedId: unknown, quantity: unknown)
		return self:_handle(player, function()
			return self:BuySeed(player, seedId, quantity)
		end)
	end

	sellCrop.OnServerInvoke = function(player: Player, cropId: unknown, quantity: unknown)
		return self:_handle(player, function()
			return self:SellCrop(player, cropId, quantity)
		end)
	end

	sellAllCrops.OnServerInvoke = function(player: Player)
		return self:_handle(player, function()
			return self:SellAllCrops(player)
		end)
	end

	-- Buckets are keyed by Player, so they must be dropped or the table keeps
	-- every player who ever joined alive for the life of the server.
	Players.PlayerRemoving:Connect(function(player: Player)
		self._limiter:Forget(player)
	end)

	return self
end

return ShopService
