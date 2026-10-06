--!nonstrict
--[[
	MarketplaceService
	------------------
	Developer Product receipt processing.

	NAMING: this module deliberately shares a name with the engine service, as
	requested. Inside the file the engine service is aliased `Marketplace` to
	keep the two apart. If this ever causes confusion at a call site, renaming
	the file to `PurchaseService` is a drop-in change - only Bootstrap requires it.

	WHY ProcessReceipt IS DIFFERENT FROM EVERY OTHER HANDLER
	--------------------------------------------------------
	Roblox calls ProcessReceipt repeatedly for the same purchase until the
	server returns PurchaseGranted. Once granted, it is never called again and
	the player's Robux are spent. That produces two failure modes that ordinary
	gameplay code never faces:

	  1. Granting without persisting -> the server dies, the grant is gone, but
	     Roblox considers the receipt settled. The player paid for nothing.
	  2. Granting without deduplicating -> a retry grants the same purchase
	     twice (or ten times). One payment, many items.

	This module closes both:

	  * Every grant is recorded in `data.PurchaseHistory` (the idempotency
	    ledger) and the profile is force-saved BEFORE returning PurchaseGranted.
	    If the save fails we return NotProcessedYet, so Roblox retries.
	  * A retry for an already-recorded PurchaseId re-saves and grants without
	    re-applying the effect.

	Anything unexpected returns NotProcessedYet rather than granting: an unknown
	product id, a missing handler, a thrown error, a player who left mid-flight.
	NotProcessedYet is always safe - the worst case is a delayed grant, whereas
	a wrong PurchaseGranted is unrecoverable for the player.

	ADDING A PRODUCT
	----------------
	Add it to GameConfig.Monetization.Products with its real ProductId, then
	register a handler for its `Kind` below. Handlers return true on success and
	must be safe to abandon: nothing is settled until the save succeeds.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Marketplace = game:GetService("MarketplaceService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Signal = require(Shared.Signal)

local PlayerDataService = require(script.Parent.PlayerDataService)
local PlotService = require(script.Parent.PlotService)

local GRANTED = Enum.ProductPurchaseDecision.PurchaseGranted
local NOT_PROCESSED = Enum.ProductPurchaseDecision.NotProcessedYet

local MarketplaceService = {}

MarketplaceService._started = false
MarketplaceService._handlers = {}

--- (player, product, receiptInfo) - fired only after a grant is durably saved.
MarketplaceService.PurchaseProcessed = Signal.new()

--------------------------------------------------------------------------------
-- Product handlers
--------------------------------------------------------------------------------

--[[
	Product A: +1 Revenge Token.

	A plain counter increment, so it always succeeds once data is loaded.
]]
function MarketplaceService._grantRevengeToken(player: Player, product): boolean
	return PlayerDataService:AddRevengeTokens(player, product.Amount) ~= nil
end

--[[
	Product B: Instant Grow.

	Granted as a consumable item FIRST, then auto-applied to the player's
	targeted plot. That ordering matters: a receipt handler must never be able
	to fail because of world state.

	If the player bought this with nothing growing - or every crop already
	mature, or their garden not yet built - applying it would fail, and
	returning NotProcessedYet would leave them stuck in a retry loop having
	already paid. Instead the boost lands in their Boosts inventory and
	`CompleteGrowth` spends it when a valid target exists, either immediately
	here or later via the UseBoost remote.
]]
function MarketplaceService._grantGrowthBoost(player: Player, product): boolean
	local itemId = GameConfig.Monetization.GrowthBoostItemId

	if not PlayerDataService:AddItem(player, itemId, product.Amount) then
		return false
	end

	-- Best-effort instant gratification. Failure is fine: the player keeps the
	-- consumable, so the purchase is never lost.
	for _ = 1, product.Amount do
		if not PlotService:CompleteGrowth(player, nil) then
			break
		end
	end

	return true
end

--------------------------------------------------------------------------------
-- Receipt processing
--------------------------------------------------------------------------------

--- Appends a PurchaseId to the ledger, trimming the oldest entries past the cap.
local function recordPurchase(data, purchaseId: string)
	table.insert(data.PurchaseHistory, purchaseId)

	while #data.PurchaseHistory > GameConfig.Monetization.MaxPurchaseHistory do
		table.remove(data.PurchaseHistory, 1)
	end
end

function MarketplaceService:_processReceipt(receiptInfo): Enum.ProductPurchaseDecision
	local player = Players:GetPlayerByUserId(receiptInfo.PlayerId)

	-- The buyer left (or is on another server). Roblox will retry when they
	-- are next in a server we can grant on.
	if not player or not player.Parent then
		return NOT_PROCESSED
	end

	local data = PlayerDataService:GetData(player)

	-- Data not loaded, or the session lock was lost. Granting into a profile we
	-- cannot save would lose the purchase.
	if not data then
		return NOT_PROCESSED
	end

	local purchaseId = tostring(receiptInfo.PurchaseId)

	-- Idempotency: this receipt was already applied on an earlier attempt, so
	-- re-apply nothing and just confirm it is persisted.
	if table.find(data.PurchaseHistory, purchaseId) then
		return if PlayerDataService:SaveNow(player) then GRANTED else NOT_PROCESSED
	end

	local product = GameConfig.GetProductById(receiptInfo.ProductId)

	if not product then
		-- Config drift: a live product the server does not know about. Stay
		-- pending so a config fix can honour the receipt on a later retry
		-- instead of taking the money for nothing.
		warn(
			`[MarketplaceService] Unknown ProductId {tostring(receiptInfo.ProductId)} from {player.Name}; leaving receipt pending`
		)
		return NOT_PROCESSED
	end

	local handler = self._handlers[product.Kind]

	if not handler then
		warn(`[MarketplaceService] No handler registered for product kind {product.Kind}; leaving receipt pending`)
		return NOT_PROCESSED
	end

	-- A handler error must not surface to the engine as a failed callback.
	local ok, granted = pcall(handler, player, product, receiptInfo)

	if not ok then
		warn(`[MarketplaceService] Handler for {product.Kind} errored for {player.Name}: {granted}`)
		return NOT_PROCESSED
	end

	if not granted then
		warn(`[MarketplaceService] Handler for {product.Kind} declined the grant for {player.Name}`)
		return NOT_PROCESSED
	end

	recordPurchase(data, purchaseId)
	data.Stats.PurchasesProcessed += 1
	data.Stats.RobuxSpent += math.max(math.floor(tonumber(receiptInfo.CurrencySpent) or 0), 0)

	-- The grant is only real once it is on disk. Until this returns true the
	-- receipt stays pending, and the ledger entry above makes the retry safe.
	if not PlayerDataService:SaveNow(player) then
		warn(`[MarketplaceService] Could not persist purchase {purchaseId} for {player.Name}; will retry`)
		return NOT_PROCESSED
	end

	self.PurchaseProcessed:Fire(player, product, receiptInfo)

	return GRANTED
end

--------------------------------------------------------------------------------
-- Public API
--------------------------------------------------------------------------------

--- Registers a handler for a product Kind. Handlers return true on success.
function MarketplaceService:RegisterHandler(kind: string, handler: (Player, any, any) -> boolean)
	assert(type(kind) == "string" and kind ~= "", "product kind must be a non-empty string")
	assert(type(handler) == "function", "handler must be a function")
	assert(self._handlers[kind] == nil, `a handler is already registered for kind {kind}`)

	self._handlers[kind] = handler
end

--- Opens the Robux purchase dialog for a product. Server-initiated so the
--- client never needs to know (or be trusted with) product ids.
function MarketplaceService:PromptPurchase(player: Player, productName: string): boolean
	local product = GameConfig.Monetization.Products[productName]

	if not product or product.ProductId <= 0 then
		warn(`[MarketplaceService] Cannot prompt purchase for unconfigured product {tostring(productName)}`)
		return false
	end

	local ok, err = pcall(function()
		Marketplace:PromptProductPurchase(player, product.ProductId)
	end)

	if not ok then
		warn(`[MarketplaceService] PromptProductPurchase failed: {err}`)
		return false
	end

	return true
end

--------------------------------------------------------------------------------
-- Startup
--------------------------------------------------------------------------------

function MarketplaceService:Start()
	assert(RunService:IsServer(), "MarketplaceService is server-only")

	-- ProcessReceipt is a single callback for the whole server. Assigning it
	-- twice silently discards the first, so this must happen exactly once.
	assert(not self._started, "MarketplaceService:Start() must only be called once")
	self._started = true

	self:RegisterHandler("RevengeToken", MarketplaceService._grantRevengeToken)
	self:RegisterHandler("GrowthBoost", MarketplaceService._grantGrowthBoost)

	local unconfigured, duplicates = GameConfig.ValidateProducts()

	if #unconfigured > 0 then
		warn(
			`[MarketplaceService] These products still have placeholder ProductIds and cannot be sold: {table.concat(unconfigured, ", ")}. Set them from the Creator Dashboard.`
		)
	end

	for _, conflict in duplicates do
		warn(`[MarketplaceService] Product id conflict: {conflict}`)
	end

	Marketplace.ProcessReceipt = function(receiptInfo)
		-- Last-resort guard: an error escaping this callback is treated by the
		-- engine as a failure to process, but an explicit NotProcessedYet is
		-- clearer and keeps the retry semantics obvious.
		local ok, decision = pcall(function()
			return self:_processReceipt(receiptInfo)
		end)

		if not ok then
			warn(`[MarketplaceService] ProcessReceipt errored: {decision}`)
			return NOT_PROCESSED
		end

		return decision
	end

	return self
end

return MarketplaceService
