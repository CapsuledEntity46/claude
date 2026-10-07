--!nonstrict
--[[
	HudClient
	---------
	The always-on HUD: the four resources, the personal purse, Age, Level, an XP
	bar and Revenge Tokens, plus Inventory and Robux Store panels.

	Everything on screen is read from REPLICATED STATE, never computed locally:

	  Food / Wood / Gold / Stone                 -> Player attributes
	  InventoryGold / Age / AgeName              -> Player attributes
	  Level / XP / XPToNextLevel / RevengeTokens -> Player attributes
	  Inventory                                         -> Player.Inventory attributes
	  Item names, prices, categories                    -> Shared.GameConfig
	  Store products                                    -> Shared.GameConfig

	So there is nothing to poll and nothing to keep in sync. The server writes
	an attribute, the HUD redraws.

	The store never sees a Developer Product id. It sends the product's config
	NAME to the server, which validates it and opens the Robux dialog. That
	keeps ids server-side and stops a client prompting for arbitrary products.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 10

local player = Players.LocalPlayer
local ATTR = GameConfig.Attributes

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[HudClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this script `
			.. `expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. HUD disabled.`
	)
	return
end

local COLORS = {
	Panel = Color3.fromRGB(28, 30, 38),
	Header = Color3.fromRGB(38, 41, 52),
	Row = Color3.fromRGB(38, 41, 52),
	Text = Color3.fromRGB(236, 238, 245),
	Muted = Color3.fromRGB(150, 156, 172),
	Accent = Color3.fromRGB(96, 142, 226),
	Purse = Color3.fromRGB(240, 199, 62),
	XP = Color3.fromRGB(126, 196, 112),
	Token = Color3.fromRGB(198, 108, 196),
	Buy = Color3.fromRGB(58, 142, 86),
	Disabled = Color3.fromRGB(62, 66, 78),
}

--------------------------------------------------------------------------------
-- Construction helpers
--------------------------------------------------------------------------------

local function corner(parent: Instance, radius: number)
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
	item.Parent = parent
end

local function label(props: { [string]: any }): TextLabel
	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamMedium
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

--- Thousands separators, so 15000 reads as 15,000.
local function comma(value: number): string
	local text = tostring(math.floor(value))
	local out = text:reverse():gsub("(%d%d%d)", "%1,"):reverse()
	return (out:gsub("^,", ""))
end

local function listPanel(title: string, size: UDim2): (Frame, ScrollingFrame)
	local panel = Instance.new("Frame")
	panel.Name = title
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.Size = size
	panel.BackgroundColor3 = COLORS.Panel
	panel.BorderSizePixel = 0
	panel.Visible = false
	corner(panel, 10)

	local header = Instance.new("Frame")
	header.Size = UDim2.new(1, 0, 0, 44)
	header.BackgroundColor3 = COLORS.Header
	header.BorderSizePixel = 0
	header.Parent = panel
	corner(header, 10)

	local heading = label({
		Position = UDim2.fromOffset(16, 0),
		Size = UDim2.new(1, -60, 1, 0),
		Font = Enum.Font.GothamBold,
		TextSize = 17,
		Text = title,
	})
	heading.Parent = header

	local close = button({
		Name = "Close",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.5, 0),
		Size = UDim2.fromOffset(30, 30),
		BackgroundColor3 = COLORS.Disabled,
		Text = "X",
	})
	close.Parent = header

	local list = Instance.new("ScrollingFrame")
	list.Name = "List"
	list.Position = UDim2.fromOffset(8, 52)
	list.Size = UDim2.new(1, -16, 1, -60)
	list.BackgroundTransparency = 1
	list.BorderSizePixel = 0
	list.ScrollBarThickness = 6
	list.CanvasSize = UDim2.new()
	list.AutomaticCanvasSize = Enum.AutomaticSize.Y
	list.Parent = panel

	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0, 6)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = list

	close.MouseButton1Click:Connect(function()
		panel.Visible = false
	end)

	return panel, list
end

--------------------------------------------------------------------------------
-- Build the HUD
--------------------------------------------------------------------------------

local screen = Instance.new("ScreenGui")
screen.Name = "HudGui"
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

-- Stat strip, top-left
local strip = Instance.new("Frame")
strip.Name = "Stats"
strip.Position = UDim2.fromOffset(12, 12)
strip.Size = UDim2.fromOffset(238, 164)
strip.BackgroundColor3 = COLORS.Panel
strip.BackgroundTransparency = 0.15
strip.BorderSizePixel = 0
strip.Parent = screen
corner(strip, 8)

--[[
	One row per resource, generated from GameConfig.Resources in its declared
	order. Adding a fifth resource needs no change here.
]]
local resourceLabels = {}

for index, resourceId in GameConfig.GetResourceIds() do
	local definition = GameConfig.Resources[resourceId]

	local row = label({
		Position = UDim2.fromOffset(12, -6 + index * 20),
		Size = UDim2.fromOffset(206, 18),
		Font = Enum.Font.GothamBold,
		TextSize = 14,
		TextColor3 = definition.Color,
	})
	row.Parent = strip

	resourceLabels[resourceId] = row
end

local purseLabel = label({
	Position = UDim2.fromOffset(12, 94),
	Size = UDim2.fromOffset(206, 18),
	TextSize = 13,
	TextColor3 = COLORS.Purse,
})
purseLabel.Parent = strip

local levelLabel = label({
	Position = UDim2.fromOffset(12, 114),
	Size = UDim2.fromOffset(120, 18),
	TextSize = 13,
})
levelLabel.Parent = strip

local tokenLabel = label({
	Position = UDim2.fromOffset(132, 114),
	Size = UDim2.fromOffset(90, 18),
	TextSize = 13,
	TextXAlignment = Enum.TextXAlignment.Right,
	TextColor3 = COLORS.Token,
})
tokenLabel.Parent = strip

-- XP bar
local xpTrack = Instance.new("Frame")
xpTrack.Position = UDim2.fromOffset(12, 136)
xpTrack.Size = UDim2.fromOffset(206, 10)
xpTrack.BackgroundColor3 = COLORS.Disabled
xpTrack.BorderSizePixel = 0
xpTrack.Parent = strip
corner(xpTrack, 5)

local xpFill = Instance.new("Frame")
xpFill.Size = UDim2.fromScale(0, 1)
xpFill.BackgroundColor3 = COLORS.XP
xpFill.BorderSizePixel = 0
xpFill.Parent = xpTrack
corner(xpFill, 5)

local xpLabel = label({
	Position = UDim2.fromOffset(12, 148),
	Size = UDim2.fromOffset(206, 16),
	TextSize = 11,
	TextColor3 = COLORS.Muted,
})
xpLabel.Parent = strip

-- Buttons, bottom-left
local bar = Instance.new("Frame")
bar.Name = "Buttons"
bar.AnchorPoint = Vector2.new(0, 1)
bar.Position = UDim2.new(0, 12, 1, -12)
bar.Size = UDim2.fromOffset(230, 34)
bar.BackgroundTransparency = 1
bar.Parent = screen

local barLayout = Instance.new("UIListLayout")
barLayout.FillDirection = Enum.FillDirection.Horizontal
barLayout.Padding = UDim.new(0, 8)
barLayout.Parent = bar

local inventoryButton = button({
	Name = "InventoryButton",
	Size = UDim2.fromOffset(104, 34),
	BackgroundColor3 = COLORS.Accent,
	Text = "Inventory",
})
inventoryButton.Parent = bar

local storeButton = button({
	Name = "StoreButton",
	Size = UDim2.fromOffset(104, 34),
	BackgroundColor3 = COLORS.Buy,
	Text = "Store",
})
storeButton.Parent = bar

local inventoryPanel, inventoryList = listPanel("Inventory", UDim2.fromOffset(460, 420))
inventoryPanel.Parent = screen

local storePanel, storeList = listPanel("Store", UDim2.fromOffset(460, 420))
storePanel.Parent = screen

screen.Parent = player:WaitForChild("PlayerGui")

--------------------------------------------------------------------------------
-- Stats
--------------------------------------------------------------------------------

local function refreshStats()
	for resourceId, control in resourceLabels do
		local definition = GameConfig.Resources[resourceId]
		control.Text = `{definition.Name}  {comma(player:GetAttribute(resourceId) or 0)}`
	end

	local ageName = player:GetAttribute(ATTR.AgeName) or "Dark Age"
	purseLabel.Text = `Purse {comma(player:GetAttribute(ATTR.InventoryGold) or 0)}   •   {ageName}`

	local level = player:GetAttribute(ATTR.Level) or 1
	local xp = player:GetAttribute(ATTR.XP) or 0
	local needed = player:GetAttribute(ATTR.XPToNextLevel) or -1
	local tokens = player:GetAttribute(ATTR.RevengeTokens) or 0

	levelLabel.Text = `Level {level}`
	tokenLabel.Text = `{tokens} revenge`

	-- The server publishes -1 for XPToNextLevel at max level, because an
	-- attribute cannot hold math.huge.
	if needed <= 0 then
		xpFill.Size = UDim2.fromScale(1, 1)
		xpLabel.Text = "Max level"
	else
		xpFill.Size = UDim2.fromScale(math.clamp(xp / needed, 0, 1), 1)
		xpLabel.Text = `{comma(xp)} / {comma(needed)} XP`
	end
end

--------------------------------------------------------------------------------
-- Inventory panel
--------------------------------------------------------------------------------

local function getInventoryFolder(): Instance
	return player:WaitForChild(GameConfig.InventoryFolderName)
end

local function refreshInventory()
	if not inventoryPanel.Visible then
		return
	end

	for _, child in inventoryList:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	local owned = getInventoryFolder():GetAttributes()
	local order = 0
	local anything = false

	-- Grouped by the directory's category order, so the panel reads the same
	-- way every time regardless of attribute iteration order.
	for _, category in GameConfig.ItemCategories do
		local rows = {}

		for _, item in GameConfig.GetItemsByCategory(category) do
			local amount = owned[item.Id]

			if amount and amount > 0 then
				table.insert(rows, { item = item, amount = amount })
			end
		end

		if #rows > 0 then
			anything = true
			order += 1

			local heading = label({
				Size = UDim2.new(1, -6, 0, 22),
				LayoutOrder = order,
				Text = category,
				Font = Enum.Font.GothamBold,
				TextColor3 = COLORS.Muted,
				TextSize = 12,
			})
			-- A TextLabel is not a Frame, so wrap it to keep the layout simple.
			local wrapper = Instance.new("Frame")
			wrapper.Size = UDim2.new(1, -6, 0, 22)
			wrapper.BackgroundTransparency = 1
			wrapper.LayoutOrder = order
			heading.Parent = wrapper
			wrapper.Parent = inventoryList

			for _, entry in rows do
				order += 1

				local row = Instance.new("Frame")
				row.Size = UDim2.new(1, -6, 0, 34)
				row.BackgroundColor3 = COLORS.Row
				row.BorderSizePixel = 0
				row.LayoutOrder = order
				corner(row, 6)

				local plantable = GameConfig.GetPlantable(entry.item.Id)
				local swatch = Instance.new("Frame")
				swatch.AnchorPoint = Vector2.new(0, 0.5)
				swatch.Position = UDim2.fromOffset(10, 17)
				swatch.Size = UDim2.fromOffset(14, 14)
				swatch.BackgroundColor3 = if plantable then plantable.Color else COLORS.Accent
				swatch.BorderSizePixel = 0
				swatch.Parent = row
				corner(swatch, 3)

				local name = label({
					Position = UDim2.fromOffset(34, 0),
					Size = UDim2.new(1, -140, 1, 0),
					Text = entry.item.Name,
				})
				name.Parent = row

				local worth = if entry.item.SellPrice
					then `x{comma(entry.amount)}   •   {comma(entry.item.SellPrice)} ea`
					else `x{comma(entry.amount)}`

				local count = label({
					AnchorPoint = Vector2.new(1, 0),
					Position = UDim2.new(1, -12, 0, 0),
					Size = UDim2.fromOffset(150, 34),
					TextXAlignment = Enum.TextXAlignment.Right,
					TextColor3 = COLORS.Muted,
					TextSize = 12,
					Text = worth,
				})
				count.Parent = row

				row.Parent = inventoryList
			end
		end
	end

	if not anything then
		local empty = Instance.new("Frame")
		empty.Size = UDim2.new(1, -6, 0, 40)
		empty.BackgroundTransparency = 1

		local text = label({
			Size = UDim2.fromScale(1, 1),
			Text = "Nothing yet. Plant something and harvest it.",
			TextColor3 = COLORS.Muted,
		})
		text.Parent = empty
		empty.Parent = inventoryList
	end
end

--------------------------------------------------------------------------------
-- Store panel
--------------------------------------------------------------------------------

local promptPurchase = Remotes.GetEvent(GameConfig.RemoteNames.PromptPurchase)
local MarketplaceService = game:GetService("MarketplaceService")

--[[
	Robux prices live on the Creator Dashboard, not in config, so they are
	fetched per product. Unconfigured products (ProductId 0) cannot be queried,
	so they show as unavailable rather than failing.
]]
local priceCache = {}

local function fetchPrice(product): string
	if product.ProductId <= 0 then
		return "unavailable"
	end

	if priceCache[product.ProductId] then
		return priceCache[product.ProductId]
	end

	local ok, info = pcall(function()
		return MarketplaceService:GetProductInfo(product.ProductId, Enum.InfoType.Product)
	end)

	local text = if ok and type(info) == "table" and info.PriceInRobux
		then `R$ {info.PriceInRobux}`
		else "unavailable"

	priceCache[product.ProductId] = text
	return text
end

local function refreshStore()
	if not storePanel.Visible then
		return
	end

	for _, child in storeList:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	for order, product in GameConfig.GetStoreProducts() do
		local configured = product.ProductId > 0

		local row = Instance.new("Frame")
		row.Size = UDim2.new(1, -6, 0, 58)
		row.BackgroundColor3 = COLORS.Row
		row.BorderSizePixel = 0
		row.LayoutOrder = order
		corner(row, 6)

		local name = label({
			Position = UDim2.fromOffset(12, 6),
			Size = UDim2.new(1, -140, 0, 20),
			Font = Enum.Font.GothamBold,
			Text = product.DisplayName,
		})
		name.Parent = row

		local description = label({
			Position = UDim2.fromOffset(12, 26),
			Size = UDim2.new(1, -140, 0, 28),
			TextSize = 12,
			TextColor3 = COLORS.Muted,
			TextWrapped = true,
			Text = product.Description,
		})
		description.Parent = row

		local buy = button({
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -12, 0.5, 0),
			Size = UDim2.fromOffset(104, 32),
			BackgroundColor3 = if configured then COLORS.Buy else COLORS.Disabled,
			Text = fetchPrice(product),
			TextSize = 12,
			Active = configured,
		})
		buy.Parent = row

		buy.MouseButton1Click:Connect(function()
			if not configured then
				return
			end

			-- Send the config NAME; the server owns the id.
			promptPurchase:FireServer(product.Name)
		end)

		row.Parent = storeList
	end
end

--------------------------------------------------------------------------------
-- Wiring
--------------------------------------------------------------------------------

inventoryButton.MouseButton1Click:Connect(function()
	storePanel.Visible = false
	inventoryPanel.Visible = not inventoryPanel.Visible
	refreshInventory()
end)

storeButton.MouseButton1Click:Connect(function()
	inventoryPanel.Visible = false
	storePanel.Visible = not storePanel.Visible
	refreshStore()
end)

local watched = { ATTR.Level, ATTR.XP, ATTR.XPToNextLevel, ATTR.RevengeTokens, ATTR.InventoryGold, ATTR.AgeName }

for resourceId in GameConfig.Resources do
	table.insert(watched, resourceId)
end

for _, attribute in watched do
	player:GetAttributeChangedSignal(attribute):Connect(refreshStats)
end

getInventoryFolder().AttributeChanged:Connect(refreshInventory)

refreshStats()
