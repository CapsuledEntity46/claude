--!nonstrict
--[[
	ShopClient
	----------
	The hybrid physical shop: a ProximityPrompt on Workspace.ShopNPC opens a 2D
	menu that is populated dynamically from the master item directory.

	Lives in StarterPlayerScripts and builds its own ScreenGui named "ShopGui"
	at runtime, so the entire interface is version-controlled source rather than
	a hand-assembled instance tree. If you later want an artist to lay the panel
	out in Studio, author StarterGui.ShopGui instead and replace `buildGui()`
	with lookups into it - nothing else in this file needs to change.

	WHY THE PROMPT IS HANDLED CLIENT-SIDE
	-------------------------------------
	ProximityPrompt.Triggered fires on both sides. Opening a menu is purely
	cosmetic, so handling it locally makes the panel appear with zero latency
	and costs the server nothing. None of that is trusted: every button sends a
	transaction that ShopService validates from scratch against the directory.

	The UI never computes an outcome. It renders prices from GameConfig for
	display, sends intent, and then re-renders from whatever the server reports
	and from the replicated inventory attributes.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local player = Players.LocalPlayer
local ATTR = GameConfig.Attributes

local EXPECTED_FRAMEWORK = 9

--[[
	Startup is diagnosed, not asserted.

	The shop is one optional feature; if its dependencies are not there, say so
	in one actionable line and leave the rest of the client alone. Throwing
	produces a stack trace pointing at whichever line happened to touch the
	missing value, which is never the real cause.

	Two things can go wrong:
	  * Shared is from a different commit than this script (a partial sync).
	  * The remotes never replicated, which means the SERVER failed to start -
	    ShopService creates them in Bootstrap. The fix is in the Server output,
	    not here.
]]
if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[ShopClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this script `
			.. `expects v{EXPECTED_FRAMEWORK}, so they are from different commits. Re-sync Rojo. Shop UI disabled.`
	)
	return
end

if type(Remotes.GetFunction) ~= "function" then
	warn("[ShopClient] Shared.Remotes predates the shop remotes. Re-sync Rojo. Shop UI disabled.")
	return
end

local function acquireRemotes()
	return Remotes.GetFunction(GameConfig.RemoteNames.ProcessTransaction),
		Remotes.GetFunction(GameConfig.RemoteNames.SellAll)
end

local acquired, processTransaction, sellAllRemote = pcall(acquireRemotes)

if not acquired then
	warn(
		"[ShopClient] The shop remotes never replicated, which means the server did not finish starting. "
			.. "Check the Server output for a Bootstrap error - that is the real failure. Shop UI disabled."
	)
	return
end

-- Amount presets the player can toggle between.
local AMOUNT_OPTIONS = { 1, 10, 50 }

local COLORS = {
	Backdrop = Color3.fromRGB(0, 0, 0),
	Panel = Color3.fromRGB(28, 30, 38),
	Header = Color3.fromRGB(38, 41, 52),
	Row = Color3.fromRGB(38, 41, 52),
	Text = Color3.fromRGB(236, 238, 245),
	Muted = Color3.fromRGB(150, 156, 172),
	Buy = Color3.fromRGB(58, 142, 86),
	Sell = Color3.fromRGB(178, 112, 44),
	Disabled = Color3.fromRGB(62, 66, 78),
	Accent = Color3.fromRGB(96, 142, 226),
	Error = Color3.fromRGB(198, 84, 84),
}

--------------------------------------------------------------------------------
-- Small construction helpers
--------------------------------------------------------------------------------

local function corner(parent: Instance, radius: number)
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
	item.Parent = parent
end

local function padding(parent: Instance, amount: number)
	local item = Instance.new("UIPadding")
	item.PaddingTop = UDim.new(0, amount)
	item.PaddingBottom = UDim.new(0, amount)
	item.PaddingLeft = UDim.new(0, amount)
	item.PaddingRight = UDim.new(0, amount)
	item.Parent = parent
end

local function label(props: { [string]: any }): TextLabel
	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.Gotham
	text.TextColor3 = COLORS.Text
	text.TextSize = 14
	text.TextXAlignment = Enum.TextXAlignment.Left

	for key, value in props do
		text[key] = value
	end

	return text
end

local function button(props: { [string]: any }): TextButton
	local control = Instance.new("TextButton")
	control.AutoButtonColor = true
	control.Font = Enum.Font.GothamBold
	control.TextColor3 = COLORS.Text
	control.TextSize = 13
	control.BorderSizePixel = 0

	for key, value in props do
		control[key] = value
	end

	corner(control, 6)
	return control
end

--------------------------------------------------------------------------------
-- GUI construction
--------------------------------------------------------------------------------

local gui = {}

local function buildGui()
	local screen = Instance.new("ScreenGui")
	screen.Name = "ShopGui"
	screen.ResetOnSpawn = false
	screen.Enabled = false
	screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	local backdrop = Instance.new("Frame")
	backdrop.Name = "Backdrop"
	backdrop.Size = UDim2.fromScale(1, 1)
	backdrop.BackgroundColor3 = COLORS.Backdrop
	backdrop.BackgroundTransparency = 0.5
	backdrop.BorderSizePixel = 0
	backdrop.Parent = screen

	local panel = Instance.new("Frame")
	panel.Name = "Panel"
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.Size = UDim2.fromOffset(560, 460)
	panel.BackgroundColor3 = COLORS.Panel
	panel.BorderSizePixel = 0
	panel.Parent = screen
	corner(panel, 10)

	-- Header: title, live cash, close
	local header = Instance.new("Frame")
	header.Name = "Header"
	header.Size = UDim2.new(1, 0, 0, 48)
	header.BackgroundColor3 = COLORS.Header
	header.BorderSizePixel = 0
	header.Parent = panel
	corner(header, 10)

	local title = label({
		Name = "Title",
		Position = UDim2.fromOffset(16, 0),
		Size = UDim2.new(0.5, 0, 1, 0),
		Font = Enum.Font.GothamBold,
		TextSize = 18,
		Text = GameConfig.Shop.NpcTitle,
	})
	title.Parent = header

	local goldLabel = label({
		Name = "Gold",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -56, 0, 0),
		Size = UDim2.fromOffset(180, 48),
		TextXAlignment = Enum.TextXAlignment.Right,
		Font = Enum.Font.GothamBold,
		TextSize = 16,
	})
	goldLabel.Parent = header

	local close = button({
		Name = "Close",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.5, 0),
		Size = UDim2.fromOffset(32, 32),
		BackgroundColor3 = COLORS.Disabled,
		Text = "X",
	})
	close.Parent = header

	-- Category tabs, generated from the directory's category list
	local tabBar = Instance.new("Frame")
	tabBar.Name = "Tabs"
	tabBar.Position = UDim2.fromOffset(0, 48)
	tabBar.Size = UDim2.new(1, 0, 0, 40)
	tabBar.BackgroundTransparency = 1
	tabBar.Parent = panel
	padding(tabBar, 8)

	local tabLayout = Instance.new("UIListLayout")
	tabLayout.FillDirection = Enum.FillDirection.Horizontal
	tabLayout.Padding = UDim.new(0, 6)
	tabLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	tabLayout.Parent = tabBar

	-- Item rows
	local list = Instance.new("ScrollingFrame")
	list.Name = "Items"
	list.Position = UDim2.fromOffset(0, 88)
	list.Size = UDim2.new(1, 0, 1, -136)
	list.BackgroundTransparency = 1
	list.BorderSizePixel = 0
	list.ScrollBarThickness = 6
	list.CanvasSize = UDim2.new()
	list.AutomaticCanvasSize = Enum.AutomaticSize.Y
	list.Parent = panel
	padding(list, 8)

	local listLayout = Instance.new("UIListLayout")
	listLayout.Padding = UDim.new(0, 6)
	listLayout.SortOrder = Enum.SortOrder.LayoutOrder
	listLayout.Parent = list

	-- Footer: amount selector, sell all, status line
	local footer = Instance.new("Frame")
	footer.Name = "Footer"
	footer.AnchorPoint = Vector2.new(0, 1)
	footer.Position = UDim2.fromScale(0, 1)
	footer.Size = UDim2.new(1, 0, 0, 48)
	footer.BackgroundColor3 = COLORS.Header
	footer.BorderSizePixel = 0
	footer.Parent = panel
	corner(footer, 10)

	local amountBar = Instance.new("Frame")
	amountBar.Name = "Amounts"
	amountBar.Position = UDim2.fromOffset(12, 8)
	amountBar.Size = UDim2.fromOffset(200, 32)
	amountBar.BackgroundTransparency = 1
	amountBar.Parent = footer

	local amountLayout = Instance.new("UIListLayout")
	amountLayout.FillDirection = Enum.FillDirection.Horizontal
	amountLayout.Padding = UDim.new(0, 6)
	amountLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	amountLayout.Parent = amountBar

	local status = label({
		Name = "Status",
		Position = UDim2.fromOffset(224, 8),
		Size = UDim2.new(1, -350, 0, 32),
		TextColor3 = COLORS.Muted,
		TextSize = 13,
		Text = "",
	})
	status.Parent = footer

	local sellAll = button({
		Name = "SellAll",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.5, 0),
		Size = UDim2.fromOffset(104, 32),
		BackgroundColor3 = COLORS.Sell,
		Text = "Sell All",
	})
	sellAll.Parent = footer

	screen.Parent = player:WaitForChild("PlayerGui")

	gui = {
		Screen = screen,
		Backdrop = backdrop,
		Gold = goldLabel,
		Close = close,
		TabBar = tabBar,
		List = list,
		AmountBar = amountBar,
		Status = status,
		SellAll = sellAll,
	}
end

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

local activeCategory = GameConfig.ItemCategories[1]
local activeAmount = AMOUNT_OPTIONS[1]
local busy = false
local tabButtons = {}
local amountButtons = {}
local statusToken = 0

local function getInventoryFolder(): Instance
	return player:WaitForChild(GameConfig.InventoryFolderName)
end

local function getHeld(itemId: string): number
	return getInventoryFolder():GetAttribute(itemId) or 0
end

local function setStatus(message: string, isError: boolean?)
	statusToken += 1
	local token = statusToken

	gui.Status.Text = message
	gui.Status.TextColor3 = if isError then COLORS.Error else COLORS.Muted

	if message == "" then
		return
	end

	-- Clear the line after a moment, unless a newer message replaced it.
	task.delay(4, function()
		if statusToken == token then
			gui.Status.Text = ""
		end
	end)
end

--------------------------------------------------------------------------------
-- Rendering
--------------------------------------------------------------------------------

local renderCategory

--[[
	Sends a transaction and reports the outcome.

	`busy` debounces the buttons. The server is authoritative and rejects
	duplicates on its own, but letting a player fire ten invokes per click only
	burns their rate-limit budget.
]]
local function submit(actionType: string, itemId: string, amount: number)
	if busy then
		return
	end
	busy = true

	local ok, result = pcall(function()
		return processTransaction:InvokeServer(actionType, itemId, amount)
	end)

	busy = false

	if not ok or type(result) ~= "table" then
		setStatus("The shop is unavailable right now.", true)
		return
	end

	if result.Ok then
		local item = GameConfig.GetItem(result.ItemId)
		local name = if item then item.Name else result.ItemId

		if actionType == GameConfig.TransactionActions.Buy then
			setStatus(`Bought {result.Amount}x {name} for {result.Spent}.`)
		else
			setStatus(`Sold {result.Amount}x {name} for {result.Earned}.`)
		end
	else
		setStatus(result.Reason or "Transaction failed.", true)
	end

	renderCategory()
end

local function buildRow(item, level: number, order: number): Frame
	local held = getHeld(item.Id)
	local requiredLevel = GameConfig.GetRequiredLevel(item.Id)
	local locked = level < requiredLevel

	local row = Instance.new("Frame")
	row.Name = item.Id
	row.Size = UDim2.new(1, -6, 0, 44)
	row.BackgroundColor3 = COLORS.Row
	row.BorderSizePixel = 0
	row.LayoutOrder = order
	corner(row, 6)

	-- Colour swatch: plantables carry a colour, everything else uses rarity.
	local plantable = GameConfig.GetPlantable(item.Id)
	local swatch = Instance.new("Frame")
	swatch.Name = "Swatch"
	swatch.AnchorPoint = Vector2.new(0, 0.5)
	swatch.Position = UDim2.fromOffset(10, 22)
	swatch.Size = UDim2.fromOffset(18, 18)
	swatch.BackgroundColor3 = if plantable then plantable.Color else COLORS.Accent
	swatch.BorderSizePixel = 0
	swatch.Parent = row
	corner(swatch, 4)

	local name = label({
		Position = UDim2.fromOffset(38, 4),
		Size = UDim2.fromOffset(190, 20),
		Text = item.Name,
		Font = Enum.Font.GothamMedium,
	})
	name.Parent = row

	local detailParts = { `Owned: {held}` }

	if item.BuyPrice then
		table.insert(detailParts, `Buy {item.BuyPrice}`)
	end
	if item.SellPrice then
		table.insert(detailParts, `Sell {item.SellPrice}`)
	end
	if locked then
		table.insert(detailParts, `Needs level {requiredLevel}`)
	end

	local detail = label({
		Position = UDim2.fromOffset(38, 22),
		Size = UDim2.fromOffset(300, 18),
		Text = table.concat(detailParts, "   •   "),
		TextColor3 = COLORS.Muted,
		TextSize = 12,
	})
	detail.Parent = row

	-- Buttons appear only for directions the item actually supports, so a nil
	-- BuyPrice or SellPrice simply renders no button.
	local offset = -10

	if GameConfig.IsSellable(item) then
		local sell = button({
			Name = "Sell",
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, offset, 0.5, 0),
			Size = UDim2.fromOffset(74, 30),
			BackgroundColor3 = if held > 0 then COLORS.Sell else COLORS.Disabled,
			Text = `Sell {activeAmount}`,
		})
		sell.Parent = row
		offset -= 80

		sell.MouseButton1Click:Connect(function()
			submit(GameConfig.TransactionActions.Sell, item.Id, activeAmount)
		end)
	end

	if GameConfig.IsBuyable(item) then
		local buy = button({
			Name = "Buy",
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, offset, 0.5, 0),
			Size = UDim2.fromOffset(74, 30),
			BackgroundColor3 = if locked then COLORS.Disabled else COLORS.Buy,
			Text = `Buy {activeAmount}`,
		})
		buy.Parent = row

		buy.MouseButton1Click:Connect(function()
			if locked then
				setStatus(`{item.Name} unlocks at level {requiredLevel}.`, true)
				return
			end

			submit(GameConfig.TransactionActions.Buy, item.Id, activeAmount)
		end)
	end

	return row
end

function renderCategory()
	for _, child in gui.List:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	local level = player:GetAttribute(ATTR.Level) or 1
	local items = GameConfig.GetItemsByCategory(activeCategory)

	if #items == 0 then
		local empty = label({
			Size = UDim2.new(1, -6, 0, 40),
			Text = "Nothing here yet.",
			TextColor3 = COLORS.Muted,
		})
		empty.Parent = gui.List
		return
	end

	for order, item in items do
		buildRow(item, level, order).Parent = gui.List
	end

	for category, control in tabButtons do
		control.BackgroundColor3 = if category == activeCategory then COLORS.Accent else COLORS.Disabled
	end

	for amount, control in amountButtons do
		control.BackgroundColor3 = if amount == activeAmount then COLORS.Accent else COLORS.Disabled
	end
end

local function refreshGold()
	gui.Gold.Text = `Gold: {player:GetAttribute(GameConfig.PrimaryResource) or 0}`
end

--------------------------------------------------------------------------------
-- Wiring
--------------------------------------------------------------------------------

local function buildTabs()
	for _, category in GameConfig.ItemCategories do
		local control = button({
			Name = category,
			Size = UDim2.fromOffset(112, 26),
			BackgroundColor3 = COLORS.Disabled,
			Text = category,
			TextSize = 12,
		})
		control.Parent = gui.TabBar
		tabButtons[category] = control

		control.MouseButton1Click:Connect(function()
			activeCategory = category
			renderCategory()
		end)
	end

	for _, amount in AMOUNT_OPTIONS do
		local control = button({
			Name = `Amount{amount}`,
			Size = UDim2.fromOffset(44, 26),
			BackgroundColor3 = COLORS.Disabled,
			Text = `x{amount}`,
			TextSize = 12,
		})
		control.Parent = gui.AmountBar
		amountButtons[amount] = control

		control.MouseButton1Click:Connect(function()
			activeAmount = amount
			renderCategory()
		end)
	end
end

local function setOpen(open: boolean)
	gui.Screen.Enabled = open

	if open then
		refreshGold()
		renderCategory()
	else
		setStatus("")
	end
end

local function connectPrompt()
	local npc = Workspace:WaitForChild(GameConfig.Shop.NpcName, 60)

	if not npc then
		warn("[ShopClient] ShopNPC never replicated; the shop cannot be opened")
		return
	end

	local body = npc.PrimaryPart or npc:WaitForChild("Body", 10)
	if not body then
		warn("[ShopClient] ShopNPC has no body part to host the prompt")
		return
	end

	local prompt = body:WaitForChild("ShopPrompt", 10)
	if not prompt then
		warn("[ShopClient] ShopNPC has no ShopPrompt")
		return
	end

	prompt.Triggered:Connect(function()
		setOpen(true)
	end)

	-- Walking away closes the panel, so the player is never left with a menu
	-- open for a shop they can no longer reach.
	prompt.PromptHidden:Connect(function()
		if gui.Screen.Enabled then
			setOpen(false)
		end
	end)
end

buildGui()
buildTabs()

gui.Close.MouseButton1Click:Connect(function()
	setOpen(false)
end)

gui.SellAll.MouseButton1Click:Connect(function()
	if busy then
		return
	end
	busy = true

	local ok, result = pcall(function()
		return sellAllRemote:InvokeServer()
	end)

	busy = false

	if ok and type(result) == "table" and result.Ok then
		setStatus(`Sold {result.Amount} items for {result.Earned}.`)
	elseif ok and type(result) == "table" then
		setStatus(result.Reason or "Nothing to sell.", true)
	else
		setStatus("The shop is unavailable right now.", true)
	end

	renderCategory()
end)

-- Live updates: the panel re-renders from replicated state, never from a
-- locally predicted outcome.
player:GetAttributeChangedSignal(GameConfig.PrimaryResource):Connect(function()
	refreshGold()

	if gui.Screen.Enabled then
		renderCategory()
	end
end)

player:GetAttributeChangedSignal(ATTR.Level):Connect(function()
	if gui.Screen.Enabled then
		renderCategory()
	end
end)

getInventoryFolder().AttributeChanged:Connect(function()
	if gui.Screen.Enabled then
		renderCategory()
	end
end)

refreshGold()
connectPrompt()
