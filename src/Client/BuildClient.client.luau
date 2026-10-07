--!nonstrict
--[[
	BuildClient
	-----------
	The build menu and placement preview.

	Flow: open the menu, pick a structure, a translucent ghost follows the
	mouse on the ground, click to place, Escape or right-click to cancel.

	WHAT THE CLIENT DECIDES: nothing that matters. It picks a position and
	renders a guess at whether that position is legal, purely so the player
	gets instant feedback instead of a round trip per mouse move. The server
	re-derives every rule from GameConfig and can reject a placement the ghost
	showed as green — in which case the failure reason is displayed.

	Both sides read the same `GameConfig.Structures`, so the preview and the
	authority agree by construction rather than by two copies of the rules.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Buildability = require(Shared.Buildability)
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 15

local player = Players.LocalPlayer
local ATTR = GameConfig.Attributes
local STRUCT_ATTR = GameConfig.StructureAttributes

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[BuildClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Build menu disabled.`
	)
	return
end

local acquired, placeRemote = pcall(function()
	return Remotes.GetFunction(GameConfig.RemoteNames.PlaceStructure)
end)

if not acquired then
	warn("[BuildClient] The placement remote never replicated, so the server did not finish starting. Build menu disabled.")
	return
end

local COLORS = {
	Panel = Color3.fromRGB(28, 30, 38),
	Header = Color3.fromRGB(38, 41, 52),
	Row = Color3.fromRGB(38, 41, 52),
	Text = Color3.fromRGB(236, 238, 245),
	Muted = Color3.fromRGB(150, 156, 172),
	Accent = Color3.fromRGB(96, 142, 226),
	Build = Color3.fromRGB(58, 142, 86),
	Disabled = Color3.fromRGB(62, 66, 78),
	Error = Color3.fromRGB(198, 84, 84),
	GhostOk = Color3.fromRGB(96, 206, 128),
	GhostBad = Color3.fromRGB(206, 96, 96),
}

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function corner(parent: Instance, radius: number)
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
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

local function describeCost(cost: { [string]: number }): string
	local parts = {}

	-- Resource order from the directory, so the cost always reads the same way.
	for _, resourceId in GameConfig.GetResourceIds() do
		if cost[resourceId] then
			table.insert(parts, `{cost[resourceId]} {resourceId}`)
		end
	end

	return table.concat(parts, "   ")
end

--------------------------------------------------------------------------------
-- GUI
--------------------------------------------------------------------------------

local screen = Instance.new("ScreenGui")
screen.Name = "BuildGui"
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

local toggle = button({
	Name = "BuildButton",
	AnchorPoint = Vector2.new(0, 1),
	Position = UDim2.new(0, 250, 1, -12),
	Size = UDim2.fromOffset(104, 34),
	BackgroundColor3 = COLORS.Accent,
	Text = "Build",
})
toggle.Parent = screen

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0, 1)
panel.Position = UDim2.new(0, 12, 1, -56)
panel.Size = UDim2.fromOffset(400, 330)
panel.BackgroundColor3 = COLORS.Panel
panel.BorderSizePixel = 0
panel.Visible = false
panel.Parent = screen
corner(panel, 10)

local header = Instance.new("Frame")
header.Size = UDim2.new(1, 0, 0, 40)
header.BackgroundColor3 = COLORS.Header
header.BorderSizePixel = 0
header.Parent = panel
corner(header, 10)

local heading = label({
	Position = UDim2.fromOffset(14, 0),
	Size = UDim2.new(1, -28, 1, 0),
	Font = Enum.Font.GothamBold,
	TextSize = 16,
	Text = "Build",
})
heading.Parent = header

local list = Instance.new("ScrollingFrame")
list.Position = UDim2.fromOffset(8, 46)
list.Size = UDim2.new(1, -16, 1, -84)
list.BackgroundTransparency = 1
list.BorderSizePixel = 0
list.ScrollBarThickness = 6
list.CanvasSize = UDim2.new()
list.AutomaticCanvasSize = Enum.AutomaticSize.Y
list.Parent = panel

local listLayout = Instance.new("UIListLayout")
listLayout.Padding = UDim.new(0, 6)
listLayout.SortOrder = Enum.SortOrder.LayoutOrder
listLayout.Parent = list

local status = label({
	AnchorPoint = Vector2.new(0, 1),
	Position = UDim2.new(0, 14, 1, -8),
	Size = UDim2.new(1, -28, 0, 24),
	TextSize = 12,
	TextColor3 = COLORS.Muted,
	Text = "",
})
status.Parent = panel

screen.Parent = player:WaitForChild("PlayerGui")

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

local selected = nil
local ghost = nil
local lastPosition = nil
local busy = false
local statusToken = 0
local renderConnection = nil

local function setStatus(message: string, isError: boolean?)
	statusToken += 1
	local token = statusToken

	status.Text = message
	status.TextColor3 = if isError then COLORS.Error else COLORS.Muted

	if message == "" then
		return
	end

	task.delay(4, function()
		if statusToken == token then
			status.Text = ""
		end
	end)
end

--------------------------------------------------------------------------------
-- Buildability (feedback only; the server decides)
--------------------------------------------------------------------------------

--[[
	How many of each structure the player owns, as replicated by the server.

	Read from the counts folder rather than counted from Workspace. The folder
	is written in one go by the server after the model exists, so a prerequisite
	that was just satisfied is visible immediately - whereas counting models
	raced their own attributes and left the menu a build behind.
]]
local function getCounts(): { [string]: number }
	local counts = {}
	local folder = player:FindFirstChild(GameConfig.StructureCountsFolderName)

	if not folder then
		return counts
	end

	for structureId, count in folder:GetAttributes() do
		counts[structureId] = count
	end

	return counts
end

--- What the player is holding, for the affordability check.
local function getResources(): { [string]: number }
	local held = {}

	for _, resourceId in GameConfig.GetResourceIds() do
		held[resourceId] = player:GetAttribute(resourceId) or 0
	end

	return held
end

--[[
	Why `structure` cannot be built right now, as a sentence, or nil.

	The RULE comes from Shared.Buildability, which the server uses too, so the
	greying cannot drift from what placement actually allows. Only the WORDING
	is here, because wording is this menu's business.

	Answers two questions that must never disagree: which rows are greyed out,
	and whether placement mode can continue after a build.
]]
local function blockedFor(structure, counts: { [string]: number }, age: number): string?
	local ok, code, resourceId = Buildability.Check(structure.Id, counts, age, getResources())

	if ok then
		return nil
	end

	if code == "AgeTooLow" then
		local required = GameConfig.GetAge(structure.RequiredAge)
		return `Requires the {if required then required.Name else "next age"}`
	end

	if code == "LimitReached" then
		return `Limit reached ({structure.MaxPerPlayer})`
	end

	if code == "MissingPrerequisite" then
		-- Named rather than listed: the first unmet one is the next thing to
		-- go and build, and listing all of them is noise in a 58px row.
		for _, prerequisiteId in structure.Prerequisites do
			if (counts[prerequisiteId] or 0) < 1 then
				local parent = GameConfig.GetStructure(prerequisiteId)
				return `Requires a {if parent then parent.Name else prerequisiteId}`
			end
		end

		return "Requires another building"
	end

	if code == "NotEnoughResources" then
		local resource = if resourceId then GameConfig.Resources[resourceId] else nil
		return `Not enough {if resource then resource.Name else resourceId or "resources"}`
	end

	return "Cannot build this"
end

--------------------------------------------------------------------------------
-- Client-side legality guess (feedback only; the server decides)
--------------------------------------------------------------------------------

--- Half-extents plus the gap, matching PlacementService.footprint exactly.
local function footprint(structure): (number, number)
	local gap = GameConfig.Placement.MinimumGap
	return structure.Size.X / 2 + gap / 2, structure.Size.Z / 2 + gap / 2
end

--[[
	Every structure standing in the world, whoever owns it. Overlap is the only
	placement restriction, and it applies against all players - so unlike the
	menu's count, this deliberately does not filter by owner.
]]
local function occupied(): { { X: number, Z: number, HalfX: number, HalfZ: number } }
	local result = {}
	local folder = Workspace:FindFirstChild(GameConfig.StructuresFolderName)

	if not folder then
		return result
	end

	for _, model in folder:GetChildren() do
		local structure = GameConfig.GetStructure(model:GetAttribute(STRUCT_ATTR.StructureId))

		-- A model mid-replication has no PrimaryPart yet. Skipping it only
		-- costs a frame of preview accuracy; the server still rejects overlap.
		if structure and model.PrimaryPart then
			local halfX, halfZ = footprint(structure)

			table.insert(result, {
				X = model.PrimaryPart.Position.X,
				Z = model.PrimaryPart.Position.Z,
				HalfX = halfX,
				HalfZ = halfZ,
			})
		end
	end

	return result
end

--[[
	Anywhere inside the world bounds that is not already built on. Position
	carries no other rule: picking the spot is the player's call.
]]
local function looksLegal(structure, x: number, z: number): boolean
	local limit = GameConfig.Placement.WorldLimit

	if math.abs(x) > limit or math.abs(z) > limit then
		return false
	end

	local halfX, halfZ = footprint(structure)

	for _, other in occupied() do
		if
			math.abs(other.X - x) < halfX + other.HalfX
			and math.abs(other.Z - z) < halfZ + other.HalfZ
		then
			return false
		end
	end

	return true
end

--------------------------------------------------------------------------------
-- Ghost
--------------------------------------------------------------------------------

local function clearGhost()
	if renderConnection then
		renderConnection:Disconnect()
		renderConnection = nil
	end

	if ghost then
		ghost:Destroy()
		ghost = nil
	end

	selected = nil
	lastPosition = nil
end

--- Where the mouse points on the ground plane, via a camera ray.
local function getGroundPoint(): Vector3?
	local camera = Workspace.CurrentCamera
	if not camera then
		return nil
	end

	local mouse = UserInputService:GetMouseLocation()
	local ray = camera:ViewportPointToRay(mouse.X, mouse.Y)

	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	-- The ghost must not block its own ray, and neither should the character.
	params.FilterDescendantsInstances = { ghost, player.Character }

	local hit = Workspace:Raycast(ray.Origin, ray.Direction * 2000, params)

	if hit then
		return hit.Position
	end

	-- No geometry under the cursor: fall back to the ground plane analytically,
	-- so placement still works when aiming past the baseplate edge.
	if ray.Direction.Y >= 0 then
		return nil
	end

	local distance = (GameConfig.Placement.GroundY - ray.Origin.Y) / ray.Direction.Y
	return ray.Origin + ray.Direction * distance
end

local function beginPlacing(structure)
	clearGhost()
	selected = structure

	ghost = Instance.new("Model")
	ghost.Name = "BuildGhost"

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = structure.Size
	body.Anchored = true
	body.CanCollide = false
	body.CanQuery = false
	body.Transparency = 0.5
	body.Material = Enum.Material.Neon
	body.Color = COLORS.GhostOk
	body.Parent = ghost

	ghost.PrimaryPart = body
	ghost.Parent = Workspace

	setStatus(`Placing {structure.Name} — click to place, right-click or Escape to stop.`)

	renderConnection = RunService.RenderStepped:Connect(function()
		local point = getGroundPoint()

		if not point then
			return
		end

		-- The same config function the server uses, so the ghost sits exactly
		-- where the building will land rather than approximately there.
		local x, z = GameConfig.SnapPlacement(structure, point.X, point.Z)
		lastPosition = Vector3.new(x, GameConfig.Placement.GroundY, z)

		body.Position = Vector3.new(x, GameConfig.Placement.GroundY + structure.Size.Y / 2, z)

		local legal = looksLegal(structure, x, z)
		body.Color = if legal then COLORS.GhostOk else COLORS.GhostBad
	end)
end

local function confirmPlacement()
	if not selected or not lastPosition or busy then
		return
	end

	busy = true
	local structure = selected

	local ok, result = pcall(function()
		return placeRemote:InvokeServer(structure.Id, lastPosition.X, lastPosition.Z)
	end)

	busy = false

	if not ok or type(result) ~= "table" then
		setStatus("The build request failed.", true)
		return
	end

	if not result.Ok then
		-- The server saw something the preview could not, so say what.
		setStatus(result.Reason or "Placement refused.", true)
		return
	end

	--[[
		THE GHOST STAYS UP.

		Placing a row of farms used to mean reopening the menu between every
		one, which is a lot of clicks to lay out a base. So the selection
		survives a successful placement, and only ends on right-click, Escape,
		picking something else, or running out of road.

		Deliberately NOT checked here: whether another one could be placed.
		The count and the resources both change on the server and replicate
		when they replicate, so reading them now is a race. `reviewSelection`
		runs when the new values actually arrive and ends placement mode then
		- which also covers the cases this never sees, like a second player
		taking the last of something.
	]]
	setStatus(`{structure.Name} built. Click to place another, right-click to stop.`)
end

--------------------------------------------------------------------------------
-- Menu
--------------------------------------------------------------------------------

local function refreshMenu()
	if not panel.Visible then
		return
	end

	for _, child in list:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	local age = player:GetAttribute(ATTR.Age) or 1
	local counts = getCounts()

	for order, structure in GameConfig.GetStructureList() do
		local blockedReason = blockedFor(structure, counts, age)

		local row = Instance.new("Frame")
		row.Size = UDim2.new(1, -6, 0, 58)
		row.BackgroundColor3 = COLORS.Row
		row.BorderSizePixel = 0
		row.LayoutOrder = order
		corner(row, 6)

		local name = label({
			Position = UDim2.fromOffset(12, 5),
			Size = UDim2.new(1, -120, 0, 20),
			Font = Enum.Font.GothamBold,
			Text = `{structure.Name}  ({counts[structure.Id] or 0}/{structure.MaxPerPlayer})`,
		})
		name.Parent = row

		local detail = label({
			Position = UDim2.fromOffset(12, 25),
			Size = UDim2.new(1, -120, 0, 28),
			TextSize = 12,
			TextColor3 = if blockedReason then COLORS.Error else COLORS.Muted,
			TextWrapped = true,
			Text = blockedReason or describeCost(structure.Cost),
		})
		detail.Parent = row

		local place = button({
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -12, 0.5, 0),
			Size = UDim2.fromOffset(92, 32),
			BackgroundColor3 = if blockedReason then COLORS.Disabled else COLORS.Build,
			Text = if blockedReason then "Locked" else "Place",
			Active = blockedReason == nil,
		})
		place.Parent = row

		place.MouseButton1Click:Connect(function()
			if blockedReason then
				setStatus(blockedReason, true)
				return
			end

			beginPlacing(structure)
		end)

		row.Parent = list
	end
end

--------------------------------------------------------------------------------
-- Wiring
--------------------------------------------------------------------------------

--[[
	Ends placement mode once the held structure stops being placeable.

	Run from the same signals that refresh the menu, rather than immediately
	after a build, because the count and the resource totals change on the
	SERVER and replicate when they replicate. Checking at the moment of
	placement would be a race; checking when the new values arrive is not, and
	it also catches changes this client did not cause - another player taking
	the last of something, or an age-up from elsewhere.

	Without this, spending the last of your wood would leave a ghost under the
	cursor that can only ever be refused.
]]
local function reviewSelection()
	if not selected then
		return
	end

	local reason = blockedFor(selected, getCounts(), player:GetAttribute(ATTR.Age) or 1)

	if reason then
		local name = selected.Name
		clearGhost()
		setStatus(`{reason}. Stopped placing {name}.`, true)
	end
end

--- Everything that can change what is buildable has to do both.
local function onBuildabilityChanged()
	refreshMenu()
	reviewSelection()
end

--[[
	The panel is a picker, not a mode: closing it does NOT cancel placement.

	Laying out a row of farms is easier with the menu out of the way, and
	having it cancel the selection on the way out would undo the point of
	keeping the selection at all. Right-click and Escape are the ways to stop,
	and the status line says so.
]]
toggle.MouseButton1Click:Connect(function()
	panel.Visible = not panel.Visible

	if panel.Visible then
		refreshMenu()
	end
end)

UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
	if input.KeyCode == Enum.KeyCode.Escape then
		if selected then
			clearGhost()
			setStatus("Placement cancelled.")
		end
		return
	end

	-- `processed` means the UI already consumed the click, so clicking a menu
	-- button must not also drop a building behind the panel.
	if processed or not selected then
		return
	end

	if input.UserInputType == Enum.UserInputType.MouseButton1 then
		confirmPlacement()
	elseif input.UserInputType == Enum.UserInputType.MouseButton2 then
		clearGhost()
		setStatus("Placement cancelled.")
	end
end)

-- Aging up and spending resources both change what is buildable.
player:GetAttributeChangedSignal(ATTR.Age):Connect(onBuildabilityChanged)

for _, resourceId in GameConfig.GetResourceIds() do
	player:GetAttributeChangedSignal(resourceId):Connect(onBuildabilityChanged)
end

--[[
	Building or demolishing changes limits and prerequisites, so the open menu
	has to follow the counts folder. The folder arrives with the profile, which
	can be after this script runs, hence the ChildAdded fallback.
]]
local function watchCounts(folder: Instance)
	folder.AttributeChanged:Connect(onBuildabilityChanged)
	refreshMenu()
end

local countsFolder = player:FindFirstChild(GameConfig.StructureCountsFolderName)

if countsFolder then
	watchCounts(countsFolder)
else
	player.ChildAdded:Connect(function(child: Instance)
		if child.Name == GameConfig.StructureCountsFolderName then
			watchCounts(child)
		end
	end)
end
