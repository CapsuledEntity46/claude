--!nonstrict
--[[
	ShopBuilder
	-----------
	Builds the physical storefront: a `ShopNPC` part in Workspace carrying a
	ProximityPrompt and a floating title.

	Built procedurally, like the gardens, so the game runs from source with no
	manual Studio setup. Replace this module to swap in an authored NPC model;
	the only contract the client depends on is:

		Workspace/ShopNPC  (Model, PrimaryPart set)
		└── <PrimaryPart>
		    └── ShopPrompt (ProximityPrompt)

	The prompt is intentionally NOT handled on the server. Opening a menu is
	cosmetic, so the client listens to Triggered locally and shows the UI with
	zero latency. Nothing is trusted from that interaction: the transactions it
	sends are validated independently by ShopService.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local ShopBuilder = {}

ShopBuilder.PromptName = "ShopPrompt"

function ShopBuilder.Build(): Model
	local config = GameConfig.Shop

	local existing = Workspace:FindFirstChild(config.NpcName)
	if existing then
		return existing
	end

	local npc = Instance.new("Model")
	npc.Name = config.NpcName

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = config.NpcSize
	body.Position = config.NpcPosition
	body.Anchored = true
	body.Color = config.NpcColor
	body.Material = Enum.Material.WoodPlanks
	body.TopSurface = Enum.SurfaceType.Smooth
	body.BottomSurface = Enum.SurfaceType.Smooth
	body.Parent = npc

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = ShopBuilder.PromptName
	prompt.ActionText = config.PromptActionText
	prompt.ObjectText = config.NpcTitle
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = config.PromptMaxDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	local billboard = Instance.new("BillboardGui")
	billboard.Name = "Title"
	billboard.Size = UDim2.fromScale(10, 2)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, config.NpcSize.Y / 2 + 1.5, 0)
	billboard.AlwaysOnTop = true

	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamBold
	label.Text = config.NpcTitle
	label.TextColor3 = Color3.fromRGB(255, 255, 255)
	label.TextStrokeTransparency = 0.4
	label.TextScaled = true
	label.Parent = billboard

	billboard.Parent = body

	npc.PrimaryPart = body
	npc.Parent = Workspace

	return npc
end

return ShopBuilder
