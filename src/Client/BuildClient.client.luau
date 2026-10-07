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
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 10

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
local ghostRing = nil
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
-- Client-side legality guess (feedback only; the server decides)
--------------------------------------------------------------------------------

local function getOwnedStructures(): { { StructureId: string, X: number, Z: number, Radius: number } }
	local owned = {}
	local folder = Workspace:FindFirstChild(GameConfig.StructuresFolderName)

	if not folder then
		return owned
	end

	for _, model in folder:GetChildren() do
		if model:GetAttribute(STRUCT_ATTR.OwnerUserId) == player.UserId and model.PrimaryPart then
			table.insert(owned, {
				StructureId = model:GetAttribute(STRUCT_ATTR.StructureId),
				X = model.PrimaryPart.Position.X,
				Z = model.PrimaryPart.Position.Z,
				Radius = model:GetAttribute(STRUCT_ATTR.ProvidesRadius) or 0,
			})
		end
	end

	return owned
end

local function looksLegal(structure, x: number, z: number): boolean
	local limit = GameConfig.Placement.WorldLimit

	if math.abs(x) > limit or math.abs(z) > limit then
		return false
	end

	if not structure.RequiresWithinRadiusOf then
		return true
	end

	for _, owned in getOwnedStructures() do
		if owned.StructureId == structure.RequiresWithinRadiusOf and owned.Radius > 0 then
			local dx, dz = owned.X - x, owned.Z - z

			if dx * dx + dz * dz <= owned.Radius * owned.Radius then
				return true
			end
		end
	end

	return false
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

	ghostRing = nil
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

	if structure.ProvidesRadius and structure.ProvidesRadius > 0 then
		ghostRing = Instance.new("Part")
		ghostRing.Name = "Radius"
		ghostRing.Shape = Enum.PartType.Cylinder
		ghostRing.Size = Vector3.new(0.4, structure.ProvidesRadius * 2, structure.ProvidesRadius * 2)
		ghostRing.Anchored = true
		ghostRing.CanCollide = false
		ghostRing.CanQuery = false
		ghostRing.Transparency = 0.9
		ghostRing.Material = Enum.Material.Neon
		ghostRing.Color = COLORS.GhostOk
		ghostRing.Parent = ghost
	end

	ghost.PrimaryPart = body
	ghost.Parent = Workspace

	setStatus(`Placing {structure.Name} — click to confirm, Escape to cancel.`)

	renderConnection = RunService.RenderStepped:Connect(function()
		local point = getGroundPoint()

		if not point then
			return
		end

		local x = math.floor(point.X + 0.5)
		local z = math.floor(point.Z + 0.5)
		lastPosition = Vector3.new(x, GameConfig.Placement.GroundY, z)

		body.Position = Vector3.new(x, GameConfig.Placement.GroundY + structure.Size.Y / 2, z)

		local legal = looksLegal(structure, x, z)
		local tint = if legal then COLORS.GhostOk else COLORS.GhostBad
		body.Color = tint

		if ghostRing then
			ghostRing.CFrame = CFrame.new(x, GameConfig.Placement.GroundY + 0.2, z)
				* CFrame.Angles(0, 0, math.rad(90))
			ghostRing.Color = tint
		end
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

	if result.Ok then
		setStatus(`{structure.Name} built.`)
		clearGhost()
	else
		-- The server saw something the preview could not, so say what.
		setStatus(result.Reason or "Placement refused.", true)
	end
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
	local owned = getOwnedStructures()

	local counts = {}
	for _, entry in owned do
		counts[entry.StructureId] = (counts[entry.StructureId] or 0) + 1
	end

	for order, structure in GameConfig.GetStructureList() do
		-- Mirrors PlacementService:GetBuildability. Both read the same config,
		-- so the greying matches the server's reasons.
		local blockedReason = nil

		if age < structure.RequiredAge then
			local required = GameConfig.GetAge(structure.RequiredAge)
			blockedReason = `Requires the {if required then required.Name else "next age"}`
		elseif (counts[structure.Id] or 0) >= structure.MaxPerPlayer then
			blockedReason = `Limit reached ({structure.MaxPerPlayer})`
		else
			for _, prerequisiteId in structure.Prerequisites do
				if (counts[prerequisiteId] or 0) < 1 then
					local parent = GameConfig.GetStructure(prerequisiteId)
					blockedReason = `Requires a {if parent then parent.Name else prerequisiteId}`
					break
				end
			end
		end

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

toggle.MouseButton1Click:Connect(function()
	panel.Visible = not panel.Visible

	if panel.Visible then
		refreshMenu()
	else
		clearGhost()
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
player:GetAttributeChangedSignal(ATTR.Age):Connect(refreshMenu)

for _, resourceId in GameConfig.GetResourceIds() do
	player:GetAttributeChangedSignal(resourceId):Connect(refreshMenu)
end

local structuresFolder = Workspace:FindFirstChild(GameConfig.StructuresFolderName)

if structuresFolder then
	structuresFolder.ChildAdded:Connect(refreshMenu)
	structuresFolder.ChildRemoved:Connect(refreshMenu)
else
	Workspace.ChildAdded:Connect(function(child: Instance)
		if child.Name == GameConfig.StructuresFolderName then
			child.ChildAdded:Connect(refreshMenu)
			child.ChildRemoved:Connect(refreshMenu)
		end
	end)
end
