--!nonstrict
--[[
	ShopService
	-----------
	Closes the economy loop: Gold -> items -> Gold, all through the treasury.

	Every transaction goes through ONE entry point:

		ProcessTransaction(actionType, itemId, amount)   -- "Buy" | "Sell"

	The service is completely category-agnostic. It never asks whether an id is
	a seed, a crop or a side of beef - it looks the id up in the master
	directory (GameConfig.Items) and reads BuyPrice / SellPrice / MaxStack from
	there. Registering a new item in the directory makes it tradeable with no
	change to this file, and an item with a nil price is simply not tradeable in
	that direction.

	TRANSACTION RULES
	-----------------
	1. The client sends intent only - an action, an item id and an amount.
	   Prices, level gates and stack limits all resolve server-side from the
	   directory. A client cannot propose a price.
	2. Capacity is checked BEFORE money moves, so the happy path never needs a
	   refund. The refund branches that remain are defence in depth.
	3. Amounts are sanitised to a positive integer and clamped to a per-request
	   cap. That bounds the arithmetic as much as the economy: unbounded amounts
	   push intermediate products past the range where doubles represent
	   integers exactly.
	4. Selling respects the treasury ceiling precisely rather than letting
	   AddResource clamp. Clamping would consume goods for less than they are
	   worth, which looks exactly like theft to the player.
	5. Market income goes to the BASE TREASURY, never the player's purse. That
	   is the rule from docs/ROADMAP.md: harvesting and selling can never fill
	   the personal purse, which is loot-only.
	5. Handlers return a result table, never an error. An erroring
	   OnServerInvoke surfaces on the client as a thrown error and advertises an
	   unhandled path.

	Failure reasons are stable codes for the UI to map to copy:
	  NoData, InvalidAction, InvalidItem, InvalidAmount, NotPurchasable,
	  NotSellable, LevelTooLow, NotEnoughGold, NotEnoughItems, StackFull,
	  TreasuryFull, NothingToSell, RateLimited, InternalError
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

local ACTIONS = GameConfig.TransactionActions

local ShopService = {}

-- Checked against GameConfig.FrameworkVersion by Server.FrameworkGuard.
ShopService.FrameworkVersion = 8

ShopService._started = false
ShopService._limiter = nil

--- (player, itemId, amount, totalCost)
ShopService.ItemBought = Signal.new()
--- (player, itemId, amount, totalEarned)
ShopService.ItemSold = Signal.new()

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function failure(reason: string)
	return { Ok = false, Reason = reason }
end

local function success(fields: { [string]: any })
	fields.Ok = true
	return fields
end

--[[
	Coerces an untrusted amount into a positive integer, clamped to `maximum`.
	Returns nil when the input could not be an amount at all.

	Rejects NaN (it fails the self-comparison) and infinity (which survives
	math.floor and would poison every later product).
]]
local function sanitizeAmount(value: unknown, maximum: number): number?
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
-- Buy
--------------------------------------------------------------------------------

function ShopService:_buy(player: Player, item, amount: unknown)
	if not GameConfig.IsBuyable(item) then
		return failure("NotPurchasable")
	end

	local quantity = sanitizeAmount(amount, GameConfig.Shop.MaxBuyAmount)
	if not quantity then
		return failure("InvalidAmount")
	end

	-- Level gating is a property of the item (via its plantable entry), not of
	-- the shop, so future gated items need no change here.
	if PlayerDataService:GetLevel(player) < GameConfig.GetRequiredLevel(item.Id) then
		return failure("LevelTooLow")
	end

	-- Capacity first: taking money for goods that cannot fit would require a
	-- refund, and a refund is a second chance to get the accounting wrong.
	local held = PlayerDataService:GetItemCount(player, item.Id)
	if held + quantity > item.MaxStack then
		return failure("StackFull")
	end

	local totalCost = item.BuyPrice * quantity

	if not PlayerDataService:TrySpendGold(player, totalCost) then
		return failure("NotEnoughGold")
	end

	local newHeld = PlayerDataService:AddItem(player, item.Id, quantity)

	if not newHeld then
		-- Unreachable given the capacity check above. If it ever fires, give
		-- the money back rather than quietly keeping it.
		PlayerDataService:AddGold(player, totalCost)
		warn(`[ShopService] Refunded {totalCost} to {player.Name}: AddItem failed after payment`)
		return failure("StackFull")
	end

	PlayerDataService:IncrementStat(player, "TotalItemsBought", quantity)
	self.ItemBought:Fire(player, item.Id, quantity, totalCost)

	return success({
		Action = ACTIONS.Buy,
		ItemId = item.Id,
		Amount = quantity,
		Spent = totalCost,
		Held = newHeld,
		Gold = PlayerDataService:GetGold(player),
	})
end

--------------------------------------------------------------------------------
-- Sell
--------------------------------------------------------------------------------

function ShopService:_sell(player: Player, item, amount: unknown)
	if not GameConfig.IsSellable(item) then
		return failure("NotSellable")
	end

	local quantity = sanitizeAmount(amount, GameConfig.Shop.MaxSellAmount)
	if not quantity then
		return failure("InvalidAmount")
	end

	local held = PlayerDataService:GetItemCount(player, item.Id)
	if held < quantity then
		return failure("NotEnoughItems")
	end

	-- Sell only as much as the treasury ceiling can actually pay for. Letting
	-- AddResource clamp instead would take the goods and silently underpay.
	local headroom = GameConfig.Economy.MaxResource - PlayerDataService:GetGold(player)
	local affordable = math.floor(headroom / item.SellPrice)

	if affordable < 1 then
		return failure("TreasuryFull")
	end

	quantity = math.min(quantity, affordable)
	local totalEarned = item.SellPrice * quantity

	if not PlayerDataService:RemoveItem(player, item.Id, quantity) then
		return failure("NotEnoughItems")
	end

	if not PlayerDataService:AddGold(player, totalEarned) then
		-- Put the goods back; never destroy something we failed to pay for.
		PlayerDataService:AddItem(player, item.Id, quantity)
		warn(`[ShopService] Returned {quantity}x {item.Id} to {player.Name}: payout failed`)
		return failure("InternalError")
	end

	PlayerDataService:IncrementStat(player, "TotalItemsSold", quantity)
	self.ItemSold:Fire(player, item.Id, quantity, totalEarned)

	return success({
		Action = ACTIONS.Sell,
		ItemId = item.Id,
		Amount = quantity,
		Earned = totalEarned,
		Held = PlayerDataService:GetItemCount(player, item.Id),
		Gold = PlayerDataService:GetGold(player),
	})
end

--------------------------------------------------------------------------------
-- Public API
--------------------------------------------------------------------------------

--[[
	The single transaction entry point.

	Safe to call directly from server code (NPCs, quest rewards, tutorials); the
	remote handler is only a thin throttled wrapper around it.
]]
function ShopService:ProcessTransaction(player: Player, actionType: unknown, itemId: unknown, amount: unknown)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	if actionType ~= ACTIONS.Buy and actionType ~= ACTIONS.Sell then
		return failure("InvalidAction")
	end

	local item = GameConfig.GetItem(itemId)
	if not item then
		return failure("InvalidItem")
	end

	if actionType == ACTIONS.Buy then
		return self:_buy(player, item, amount)
	end

	return self:_sell(player, item, amount)
end

--[[
	Sells every sellable item the player holds.

	Kept separate from ProcessTransaction because it is an aggregate operation,
	not a single-item transaction. Iteration is sorted by item id because Luau
	dictionary order is unspecified - without it, a player at the treasury ceiling
	would have an arbitrary subset of their goods sold, differing between calls.
]]
function ShopService:SellAll(player: Player)
	local data = PlayerDataService:GetData(player)
	if not data then
		return failure("NoData")
	end

	local inventory = PlayerDataService:GetInventory(player)

	local itemIds = {}
	for itemId in inventory do
		local item = GameConfig.GetItem(itemId)

		if item and GameConfig.IsSellable(item) then
			table.insert(itemIds, itemId)
		end
	end
	table.sort(itemIds)

	local totalEarned, totalSold = 0, 0
	local breakdown = {}
	local lastReason = nil

	for _, itemId in itemIds do
		local result = self:ProcessTransaction(player, ACTIONS.Sell, itemId, inventory[itemId])

		if result.Ok then
			totalEarned += result.Earned
			totalSold += result.Amount
			breakdown[itemId] = result.Amount
		else
			lastReason = result.Reason
		end
	end

	if totalSold < 1 then
		-- Surface the real blocker (TreasuryFull) rather than a generic empty
		-- result, so the UI can explain why nothing sold.
		return failure(lastReason or "NothingToSell")
	end

	return success({
		Amount = totalSold,
		Earned = totalEarned,
		Sold = breakdown,
		Gold = PlayerDataService:GetGold(player),
	})
end

--- Items this player may currently buy, for server-side callers. The client
--- derives the same list from GameConfig without a round trip.
function ShopService:GetCatalog(player: Player)
	local level = PlayerDataService:GetLevel(player)
	local catalog = {}

	for _, category in GameConfig.ItemCategories do
		for _, item in GameConfig.GetItemsByCategory(category) do
			if GameConfig.IsBuyable(item) and level >= GameConfig.GetRequiredLevel(item.Id) then
				table.insert(catalog, item)
			end
		end
	end

	return catalog
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

	local processTransaction = Remotes.GetFunction(GameConfig.RemoteNames.ProcessTransaction)
	local sellAll = Remotes.GetFunction(GameConfig.RemoteNames.SellAll)

	processTransaction.OnServerInvoke = function(
		player: Player,
		actionType: unknown,
		itemId: unknown,
		amount: unknown
	)
		return self:_handle(player, function()
			return self:ProcessTransaction(player, actionType, itemId, amount)
		end)
	end

	sellAll.OnServerInvoke = function(player: Player)
		return self:_handle(player, function()
			return self:SellAll(player)
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
