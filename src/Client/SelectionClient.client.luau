--!nonstrict
--[[
	SelectionClient
	---------------
	Click a building you own, or press E on it, and a panel opens with the
	actions that building actually has.

	WHY THIS EXISTS
	---------------
	Owned buildings were operated through ProximityPrompts, and prompts do not
	scale past about one action. A farm had a single prompt that GUESSED
	whether you meant plant, harvest or uproot from the square's state - so
	mashing E down a row of farms uprooted combat plants by accident, and there
	was no way to choose which seed to sow. A pen needed four actions, so it
	grew a second prompt on a second key, held rather than tapped, and the two
	drew on top of each other until a pixel offset pulled them apart.

	Roblox gives a free mouse cursor. So: click a building, see its actions,
	press the one you want.

	WHAT IS CLIENT-SIDE AND WHAT IS NOT
	-----------------------------------
	Selection is entirely client-side - it is a mouse and some buttons, and
	nothing about it is trustworthy. Every action it offers goes through the
	single validated `BuildingAction` remote, and every verdict it renders is
	recomputed on the server before anything is granted.

	The greying-out is not security, it is manners: `Shared.BuildingActions`
	decides whether a button is available, and the SERVER runs the same
	function on the same attributes, so a forced button fails with the reason
	its own caption was already showing. Exactly the arrangement
	`Shared.Buildability` already has with the build menu.

	EVERYTHING ON SCREEN IS DERIVED
	-------------------------------
	No state is cached here and nothing is pushed by the server. The panel
	reads the selected model's replicated attributes - health, crop stage,
	herd timestamps - and recomputes its bars and buttons from them, which is
	why a crop's countdown ticks without a single remote call.
]]

local Players = game:GetService("Players")
local ProximityPromptService = game:GetService("ProximityPromptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local BuildingActions = require(Shared.BuildingActions)
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 15

local player = Players.LocalPlayer

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[SelectionClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Building panel disabled.`
	)
	return
end

local STRUCT_ATTR = GameConfig.StructureAttributes
local SELECTION = GameConfig.Selection

local COLORS = {
	Panel = Color3.fromRGB(28, 30, 38),
	Header = Color3.fromRGB(38, 41, 52),
	Row = Color3.fromRGB(38, 41, 52),
	Track = Color3.fromRGB(22, 24, 30),
	Text = Color3.fromRGB(236, 238, 245),
	Muted = Color3.fromRGB(150, 156, 172),
	Accent = Color3.fromRGB(96, 142, 226),
	Primary = Color3.fromRGB(58, 142, 86),
	Secondary = Color3.fromRGB(72, 78, 94),
	Destructive = Color3.fromRGB(158, 66, 62),
	Confirm = Color3.fromRGB(206, 92, 86),
	Disabled = Color3.fromRGB(62, 66, 78),
	Chosen = Color3.fromRGB(96, 142, 226),
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

--------------------------------------------------------------------------------
-- The panel
--------------------------------------------------------------------------------

local screen = Instance.new("ScreenGui")
screen.Name = "SelectionGui"

--[[
	GUI LAYER 4, the opened-panel layer, alongside the shop and build menus.

	ScreenGuis with equal DisplayOrder stack in an undefined order, which is
	how the build menu once ended up behind the resource strip. Every GUI in
	this project states its layer: 1 readouts, 4 opened panels, 8 notices,
	10 modal.
]]
screen.DisplayOrder = 4
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 1)
panel.Position = UDim2.new(0.5, 0, 1, -84)
panel.Size = UDim2.fromOffset(392, 332)
panel.BackgroundColor3 = COLORS.Panel
panel.BackgroundTransparency = 0.06
panel.BorderSizePixel = 0
panel.Visible = false
--[[
	`Active` makes the frame SINK input, which is the difference between a
	panel you can click and a panel that closes when you click it.

	The world-click handler below tells GUI clicks from world clicks by the
	`processed` flag, and a plain Frame does not set it - so a click on the
	header, on a bar, or in the gap between two buttons went through to the
	world and deselected the building the player was aiming at.
]]
panel.Active = true
panel.Parent = screen
corner(panel, 10)

local header = Instance.new("Frame")
header.Name = "Header"
header.Size = UDim2.new(1, 0, 0, 42)
header.BackgroundColor3 = COLORS.Header
header.BorderSizePixel = 0
header.Parent = panel
corner(header, 10)

local heading = label({
	Name = "Heading",
	Position = UDim2.fromOffset(14, 0),
	Size = UDim2.new(1, -56, 1, 0),
	Font = Enum.Font.GothamBold,
	TextSize = 17,
	Text = "",
})
heading.Parent = header

--[[
	`Modal` is the documented way to free a locked mouse.

	A player in shift-lock or first person has no usable cursor, and a panel
	full of buttons they cannot click is worse than no panel. One modal button
	on screen releases the lock for as long as it is visible, which is exactly
	the lifetime of this panel - so the close button carries it and the
	behaviour cannot leak past the panel being shut.
]]
local close = button({
	Name = "Close",
	AnchorPoint = Vector2.new(1, 0.5),
	Position = UDim2.new(1, -10, 0.5, 0),
	Size = UDim2.fromOffset(28, 28),
	BackgroundColor3 = COLORS.Disabled,
	Text = "X",
	Modal = true,
})
close.Parent = header

--[[
	A ScrollingFrame, not a Frame.

	A Farm's rows come to about 284px and a Coop's to 320, against a body that
	was 228 - and with ClipsDescendants off the overflow rendered over the
	screen below the panel rather than being cut off. Scrolling means the next
	building to gain an action cannot reintroduce that.
]]
local body = Instance.new("ScrollingFrame")
body.Name = "Body"
body.Position = UDim2.fromOffset(12, 50)
body.Size = UDim2.new(1, -24, 1, -62)
body.BackgroundTransparency = 1
body.BorderSizePixel = 0
body.ScrollBarThickness = 6
body.CanvasSize = UDim2.new()
body.AutomaticCanvasSize = Enum.AutomaticSize.Y
body.Active = true
body.Parent = panel

local bodyLayout = Instance.new("UIListLayout")
bodyLayout.Padding = UDim.new(0, 8)
bodyLayout.SortOrder = Enum.SortOrder.LayoutOrder
bodyLayout.Parent = body

--- The state bars, rebuilt when the selection changes and re-read every
--- refresh. One frame per bar, kept and updated rather than recreated.
local barsFrame = Instance.new("Frame")
barsFrame.Name = "Bars"
barsFrame.Size = UDim2.new(1, 0, 0, 0)
barsFrame.AutomaticSize = Enum.AutomaticSize.Y
barsFrame.BackgroundTransparency = 1
barsFrame.LayoutOrder = 1
barsFrame.Parent = body

local barsLayout = Instance.new("UIListLayout")
barsLayout.Padding = UDim.new(0, 6)
barsLayout.SortOrder = Enum.SortOrder.LayoutOrder
barsLayout.Parent = barsFrame

--- The choice strip: which seed, which animal. Hidden for actions that have
--- nothing to choose.
local choiceFrame = Instance.new("Frame")
choiceFrame.Name = "Choices"
choiceFrame.Size = UDim2.new(1, 0, 0, 0)
choiceFrame.AutomaticSize = Enum.AutomaticSize.Y
choiceFrame.BackgroundTransparency = 1
choiceFrame.Visible = false
choiceFrame.LayoutOrder = 2
choiceFrame.Parent = body

--[[
	A GRID, because there are eleven plantable seeds and a horizontal list of
	them was four wide and seven off the edge of the panel.
]]
local choiceLayout = Instance.new("UIGridLayout")
choiceLayout.CellSize = UDim2.fromOffset(84, 26)
choiceLayout.CellPadding = UDim2.fromOffset(6, 6)
choiceLayout.SortOrder = Enum.SortOrder.LayoutOrder
choiceLayout.Parent = choiceFrame

local actionsFrame = Instance.new("Frame")
actionsFrame.Name = "Actions"
actionsFrame.Size = UDim2.new(1, 0, 0, 0)
actionsFrame.AutomaticSize = Enum.AutomaticSize.Y
actionsFrame.BackgroundTransparency = 1
actionsFrame.LayoutOrder = 3
actionsFrame.Parent = body

local actionsLayout = Instance.new("UIGridLayout")
actionsLayout.CellSize = UDim2.fromOffset(176, 44)
actionsLayout.CellPadding = UDim2.fromOffset(8, 8)
actionsLayout.SortOrder = Enum.SortOrder.LayoutOrder
actionsLayout.Parent = actionsFrame

local status = label({
	Name = "Status",
	Size = UDim2.new(1, 0, 0, 16),
	TextColor3 = COLORS.Muted,
	TextSize = 12,
	Text = "",
	LayoutOrder = 4,
})
status.Parent = body

screen.Parent = player:WaitForChild("PlayerGui")

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

local perform = Remotes.GetFunction(GameConfig.RemoteNames.BuildingAction)

local selected: Model? = nil
local selectedInstanceId: string? = nil

--- actionId -> { Button, Caption }
local actionRows: { [string]: any } = {}
--- barId -> { Fill, Caption }
local barRows: { [string]: any } = {}

--- The item id a choosing action will use, and which action owns the strip.
local chosen: string? = nil
local chooserAction: string? = nil
local choiceButtons: { TextButton } = {}

--- Destructive actions arm on first press and fire on the second.
local armed: string? = nil
local armedUntil = 0

local mouse = player:GetMouse()

--[[
	The cursor state to put back on close.

	Captured only when the panel goes from CLOSED to open. Re-capturing on
	every selection would save the value this script had just forced, so
	selecting a second building while the panel was open would leak the
	forced cursor on for good.
]]
local mouseIconWasEnabled = UserInputService.MouseIconEnabled

local function inventory(): { [string]: number }
	local folder = player:FindFirstChild(GameConfig.InventoryFolderName)

	if not folder then
		return {}
	end

	return folder:GetAttributes()
end

local function level(): number
	return player:GetAttribute(GameConfig.Attributes.Level) or 1
end

--[[
	What the player has to spend, from replicated state only.

	The same two tables the server gathers from the profile: items from the
	Inventory folder, resources from the player's own attributes. Three of the
	availability rules price something, and they have to price it the same way
	on both sides or the panel is greener than the server.
]]
local function holdings(): { [string]: any }
	local resources = {}

	for _, resourceId in GameConfig.GetResourceIds() do
		resources[resourceId] = player:GetAttribute(resourceId) or 0
	end

	return { Items = inventory(), Resources = resources }
end

--------------------------------------------------------------------------------
-- Drawing
--------------------------------------------------------------------------------

local function makeBar(bar, order: number)
	local row = Instance.new("Frame")
	row.Name = bar.Id
	row.Size = UDim2.new(1, 0, 0, 30)
	row.BackgroundTransparency = 1
	row.LayoutOrder = order
	row.Parent = barsFrame

	local caption = label({
		Name = "Caption",
		Size = UDim2.new(1, 0, 0, 14),
		TextColor3 = COLORS.Muted,
		TextSize = 12,
		Text = bar.Name,
	})
	caption.Parent = row

	local track = Instance.new("Frame")
	track.Name = "Track"
	track.Position = UDim2.fromOffset(0, 18)
	track.Size = UDim2.new(1, 0, 0, 8)
	track.BackgroundColor3 = COLORS.Track
	track.BorderSizePixel = 0
	track.Parent = row
	corner(track, 4)

	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.Size = UDim2.fromScale(0, 1)
	fill.BackgroundColor3 = bar.Colour
	fill.BorderSizePixel = 0
	fill.Parent = track
	corner(fill, 4)

	return { Frame = row, Fill = fill, Caption = caption }
end

local function clearChoices()
	for _, control in choiceButtons do
		control:Destroy()
	end

	choiceButtons = {}
	choiceFrame.Visible = false
	chooserAction = nil
end

local function paintChoices()
	for _, control in choiceButtons do
		local isChosen = control.Name == chosen
		control.BackgroundColor3 = if isChosen then COLORS.Chosen else COLORS.Secondary
	end
end

--[[
	Builds the choice strip for the first action that has a Choice.

	A building has at most one choosing action in practice - a farm plants,
	a pen stocks - so one strip serves it. If a building ever has two, this
	picks the first and the second simply has no picker, which is a visible
	gap rather than a silent wrong choice.
]]
local function buildChoices(structureId: string)
	--[[
		The player's pick is REMEMBERED across a rebuild.

		This runs on every inventory change, and resetting to the first choice
		each time meant buying a seed while the panel was open silently moved
		the selection off whatever the player had chosen.
	]]
	local previous = chosen

	clearChoices()

	local held = inventory()
	local playerLevel = level()

	for _, actionId in BuildingActions.GetActions(structureId) do
		local action = GameConfig.GetAction(actionId)

		if not action or not action.Choice then
			continue
		end

		local choices = BuildingActions.GetChoices(structureId, actionId, held, playerLevel)

		if #choices < 1 then
			continue
		end

		chooserAction = actionId
		chosen = if previous and table.find(choices, previous) then previous else choices[1]

		for index, itemId in choices do
			local item = GameConfig.GetItem(itemId)

			local control = button({
				Name = itemId,
				Size = UDim2.fromOffset(92, 26),
				BackgroundColor3 = COLORS.Secondary,
				TextSize = 12,
				Text = `{if item then item.Name else itemId} {held[itemId] or 0}`,
				LayoutOrder = index,
			})

			control.MouseButton1Click:Connect(function()
				chosen = itemId
				paintChoices()
			end)

			control.Parent = choiceFrame
			table.insert(choiceButtons, control)
		end

		choiceFrame.Visible = true
		paintChoices()
		break
	end
end

--[[
	Whether `actionId` would be accepted, by the same function the server runs.

	Shared by the refresh loop (which paints the button) and the click handler
	(which decides whether to arm a confirmation), so what a button looks like
	and what pressing it does cannot drift apart.
]]
local function availabilityOf(actionId: string, context, have): (boolean, string?)
	if not context then
		return false, "NoBuilding"
	end

	local action = GameConfig.GetAction(actionId)
	local choices = {}

	if action and action.Choice then
		choices = BuildingActions.GetChoices(context.StructureId, actionId, have.Items, level())
	end

	return BuildingActions.IsAvailable(actionId, context, choices, have)
end

local function send(actionId: string)
	if not selectedInstanceId then
		return
	end

	--[[
		The choice is only sent for the action that owns the strip. Sending it
		on, say, Harvest would be meaningless input the server would have to
		reject, and the server does reject it - but not sending nonsense is
		cheaper than validating it.
	]]
	local choice = if actionId == chooserAction then chosen else nil

	local ok, result = pcall(function()
		return perform:InvokeServer(selectedInstanceId, actionId, choice)
	end)

	if not ok then
		status.Text = "The server did not answer."
		return
	end

	if result and result.Ok then
		status.Text = ""
	elseif result then
		--[[
			The reason code is shown as-is only when there is no sentence for
			it. The services already fire readable refusals through the Notice
			remote, so this is a backstop rather than the main channel - but a
			press that says nothing is indistinguishable from a broken button.
		]]
		status.Text = `Refused: {result.Reason}`
	end
end

local function clearPanel()
	for _, row in actionRows do
		row.Button:Destroy()
	end

	for _, row in barRows do
		row.Frame:Destroy()
	end

	actionRows = {}
	barRows = {}
	armed = nil
	clearChoices()
	status.Text = ""
end

--[[
	Rebuilds the panel for a newly selected building.

	Everything here comes from config: which buttons exist, what they are
	called, what colour they are and which bars sit above them. A Barracks
	with `Actions = { "TrainTroop", "Upgrade", "Rally" }` gets three buttons
	and no code.
]]
local function buildPanel(structureId: string)
	clearPanel()

	local structure = GameConfig.GetStructure(structureId)
	heading.Text = if structure then structure.Name else structureId

	--[[
		A row per DECLARED bar, hidden until it has a reading.

		GetBars deliberately omits a bar whose reading is nil - an empty pen
		has nothing to say about feed - so building rows straight from the
		config list drew a blank bar, and a bar that stopped reading (the herd
		slaughtered) froze at its last value instead of going away.
	]]
	for order, barId in (if structure then structure.Bars or {} else {}) do
		local bar = GameConfig.PanelBars[barId]

		if bar then
			local row = makeBar(bar, order)
			row.Frame.Visible = false
			barRows[barId] = row
		end
	end

	buildChoices(structureId)

	for order, actionId in BuildingActions.GetActions(structureId) do
		local action = GameConfig.GetAction(actionId)

		if not action then
			continue
		end

		local control = button({
			Name = actionId,
			BackgroundColor3 = COLORS.Secondary,
			Text = action.Name,
			TextSize = 14,
			LayoutOrder = order,
		})

		local caption = label({
			Name = "Caption",
			AnchorPoint = Vector2.new(0.5, 1),
			Position = UDim2.new(0.5, 0, 1, -4),
			Size = UDim2.new(1, -10, 0, 12),
			TextColor3 = COLORS.Text,
			TextTransparency = 0.35,
			TextSize = 11,
			TextXAlignment = Enum.TextXAlignment.Center,
			Text = "",
		})
		caption.Parent = control

		control.MouseButton1Click:Connect(function()
			--[[
				A destructive action arms on the first press and fires on the
				second, within ConfirmWindow. This is the panel's replacement
				for the hold gesture: the reason uprooting needed a long press
				was that it sat beside a repeatable action, and a panel can
				simply ask.
			]]
			--[[
				The window is checked HERE as well as in the refresh loop,
				because the loop runs only every RefreshInterval and a confirm
				could otherwise land a fifth of a second past its deadline.
			]]
			local stillArmed = armed == actionId and os.clock() <= armedUntil

			if action.Kind == "Destructive" and not stillArmed then
				--[[
					Unless it would be refused anyway. Arming a greyed-out
					button shows "Confirm?" where the player needed the reason
					it is not going to work.
				]]
				local context = BuildingActions.ReadContext(selected, os.time())

				if not select(1, availabilityOf(actionId, context, holdings())) then
					send(actionId)
					return
				end

				armed = actionId
				armedUntil = os.clock() + SELECTION.ConfirmWindow
				return
			end

			armed = nil
			send(actionId)
		end)

		control.Parent = actionsFrame
		actionRows[actionId] = { Button = control, Caption = caption }
	end
end

--[[
	Re-reads the selected building and repaints.

	Called on a timer rather than only on attribute changes, because two of
	the things on screen move with the clock and nothing else: a crop's
	countdown and a herd's feed timer. Everything it reads is replicated
	state, so this costs no traffic at all.
]]
local function refresh()
	if not selected or not selected.Parent then
		return false
	end

	local context = BuildingActions.ReadContext(selected, os.time())

	if not context then
		return false
	end

	local reading = {}

	for _, bar in BuildingActions.GetBars(context) do
		local row = barRows[bar.Id]
		reading[bar.Id] = true

		if row then
			row.Frame.Visible = true
			row.Fill.Size = UDim2.fromScale(bar.Fraction, 1)
			row.Caption.Text = `{bar.Name} - {bar.Caption}`
		end
	end

	-- A bar with nothing to say is hidden rather than left showing the last
	-- thing it said.
	for barId, row in barRows do
		if not reading[barId] then
			row.Frame.Visible = false
		end
	end

	local have = holdings()
	local now = os.clock()

	if armed and now > armedUntil then
		armed = nil
	end

	for actionId, row in actionRows do
		local action = GameConfig.GetAction(actionId)

		local available, reason = availabilityOf(actionId, context, have)

		if not available then
			row.Button.BackgroundColor3 = COLORS.Disabled
			row.Button.Text = action.Name
			row.Caption.Text = reason or ""
		elseif armed == actionId then
			row.Button.BackgroundColor3 = COLORS.Confirm
			row.Button.Text = "Confirm?"
			row.Caption.Text = "press again"
		else
			row.Button.BackgroundColor3 = if action.Kind == "Destructive"
				then COLORS.Destructive
				elseif action.Kind == "Primary" then COLORS.Primary
				else COLORS.Secondary
			row.Button.Text = action.Name
			row.Caption.Text = ""
		end

		--[[
			Disabled in LOOK but still clickable, so a press explains itself
			through the server's refusal instead of doing nothing. A button
			that cannot be pressed and does not say why is the problem this
			whole panel exists to fix.
		]]
		row.Button.AutoButtonColor = available
	end

	return true
end

--------------------------------------------------------------------------------
-- Selecting
--------------------------------------------------------------------------------

local function deselect()
	--[[
		The cursor is only put back if this script took it. deselect() runs on
		every click at the ground, including when no panel was ever open, and
		writing a saved value it never captured would stamp on whatever the
		player or another script had set.
	]]
	if panel.Visible then
		UserInputService.MouseIconEnabled = mouseIconWasEnabled
	end

	selected = nil
	selectedInstanceId = nil
	chosen = nil
	panel.Visible = false
	clearPanel()
end

--- Walks up from a hit part to the structure model that owns it, if any.
local function structureFrom(instance: Instance?): Model?
	local current = instance

	while current and current ~= workspace do
		if current:IsA("Model") and current:GetAttribute(STRUCT_ATTR.InstanceId) ~= nil then
			return current
		end

		current = current.Parent
	end

	return nil
end

local function select(model: Model?)
	if not model then
		return
	end

	--[[
		Re-selecting what is already selected does nothing. Without this,
		clicking the open panel's own building destroyed and rebuilt every
		button, dropping an armed confirmation and the player's seed pick.
	]]
	if model == selected then
		return
	end

	--[[
		Out of reach is not selectable. `mouse.Target` reaches as far as the
		engine's ray, which is a lot further than a base - and a configured
		distance that nothing enforced was exactly the dead config the asserts
		are supposed to catch.
	]]
	local character = player.Character
	local root = character and character.PrimaryPart

	if root and model.PrimaryPart then
		local reach = (root.Position - model.PrimaryPart.Position).Magnitude

		if reach > SELECTION.MaxSelectDistance then
			return
		end
	end

	--[[
		Only your own buildings. The server enforces this too - it reads
		ownership from the profile rather than from this attribute - so this
		is about not offering a panel that could only ever refuse.
	]]
	if model:GetAttribute(STRUCT_ATTR.OwnerUserId) ~= player.UserId then
		return
	end

	local instanceId = model:GetAttribute(STRUCT_ATTR.InstanceId)
	local structureId = model:GetAttribute(STRUCT_ATTR.StructureId)

	if type(instanceId) ~= "string" or not GameConfig.GetStructure(structureId) then
		return
	end

	selected = model
	selectedInstanceId = instanceId

	buildPanel(structureId)

	if not refresh() then
		deselect()
		return
	end

	-- A cursor the player can actually aim with, restored on close.
	if not panel.Visible then
		mouseIconWasEnabled = UserInputService.MouseIconEnabled
		UserInputService.MouseIconEnabled = true
	end

	panel.Visible = true
end

close.MouseButton1Click:Connect(deselect)

--[[
	SOURCE ONE: the building's own prompt.

	The prompt is a pure client affordance now - the server creates it and
	connects nothing - so this needs no remote and no round trip. Listening on
	the service rather than on each instance is what makes it work for
	buildings that did not exist when this script started.
]]
ProximityPromptService.PromptTriggered:Connect(function(prompt: ProximityPrompt, triggering: Player)
	if triggering ~= player or prompt.Name ~= SELECTION.PromptName then
		return
	end

	select(structureFrom(prompt.Parent))
end)

--[[
	SOURCE TWO: clicking it, which is what an RTS wants.

	Clicks that land on the GUI are not selection clicks, and Roblox tells us
	so directly: the `processed` flag is true for input the interface has
	already consumed, so a press on one of this panel's own buttons cannot
	also deselect the building it belongs to.
]]
UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
	if processed or input.UserInputType ~= Enum.UserInputType.MouseButton1 then
		return
	end

	--[[
		While the build menu is placing something, this click belongs to it.

		Both scripts act on an unprocessed left click and neither knows about
		the other, and the ghost sets CanQuery = false so the click looks like
		a click on the ground - meaning confirming a placement also closed
		whatever panel was open.
	]]
	if workspace:FindFirstChild(SELECTION.GhostName) then
		return
	end

	local target = mouse.Target
	local model = structureFrom(target)

	if model then
		select(model)
	else
		-- Clicking the ground is how you put a building down, in every RTS
		-- there has ever been.
		deselect()
	end
end)

--------------------------------------------------------------------------------
-- Keeping it honest
--------------------------------------------------------------------------------

local sinceRefresh = 0

RunService.Heartbeat:Connect(function(delta: number)
	if not panel.Visible then
		return
	end

	sinceRefresh += delta

	if sinceRefresh < SELECTION.RefreshInterval then
		return
	end

	sinceRefresh = 0

	--[[
		A selected building can be demolished, destroyed in a raid, or simply
		stop existing while its panel is open. Closing on a failed read is the
		difference between a stale panel and a panel that lies.
	]]
	if not refresh() then
		deselect()
	end
end)

--[[
	The inventory decides which seeds and animals the picker offers, so it has
	to be rebuilt when the inventory changes - buying a seed with the panel
	open should put it in the strip.
]]
local inventoryFolder = player:WaitForChild(GameConfig.InventoryFolderName, 30)

if inventoryFolder then
	inventoryFolder.AttributeChanged:Connect(function()
		if panel.Visible and selected then
			local structureId = selected:GetAttribute(STRUCT_ATTR.StructureId)

			if GameConfig.GetStructure(structureId) then
				buildChoices(structureId)
			end
		end
	end)
end
