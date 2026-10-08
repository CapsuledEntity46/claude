--!nonstrict
--[[
	StructureBuilder
	----------------
	Builds the model for a placed structure from its GameConfig definition:
	a sized block on the ground, a name label, and an influence ring for
	structures that project a radius.

	Procedural like PlotBuilder and ShopBuilder, so the game runs from source
	with no authored assets. This is the single swap point for artist models —
	replace Build() to clone a template and keep the same contract:

		Structure (Model, PrimaryPart set)
		└── <PrimaryPart>   sized from the definition, resting on GroundY

	Nothing else depends on the visual shape. PlacementService cares only about
	position and footprint; DamageableService cares only that there is a model
	to publish health attributes on.

	The name plate is the one part of it another service reads: AnimalService
	appends a pen's herd state to it, so a player can tell a hungry coop from
	a fed one without walking into prompt range. Hence LabelName and TitleName
	rather than two string literals in two files.

	THE MANAGEMENT PROMPT lives here too, because EVERY structure has a
	selection panel - they all offer at least Repair - and it was briefly
	attached by FarmService and AnimalService instead. That left the Mill, the
	Watch Tower, the Town Center and the Checkpoint selectable by mouse only,
	which is a strange gap to explain and an easy one to miss.

	The server connects nothing to it. `Triggered` fires on both sides, and
	opening a menu is a client concern - the same arrangement the shop's
	prompt has always had.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local STRUCT_ATTR = GameConfig.StructureAttributes

local StructureBuilder = {}

--- The name plate, and the text inside it. Named so a service that wants to
--- write state onto a building does not have to guess.
StructureBuilder.LabelName = "Label"
StructureBuilder.TitleName = "Title"

--- World position for a structure's centre, resting its base on the ground.
function StructureBuilder.GetCentre(structure, x: number, z: number): Vector3
	return Vector3.new(x, GameConfig.Placement.GroundY + structure.Size.Y / 2, z)
end

function StructureBuilder.Build(structure, instanceId: string, ownerUserId: number, x: number, z: number, parent: Instance): Model
	local model = Instance.new("Model")
	model.Name = `{structure.Id}_{instanceId}`

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = structure.Size
	body.Position = StructureBuilder.GetCentre(structure, x, z)
	body.Anchored = true
	body.Color = structure.Color
	body.Material = Enum.Material.WoodPlanks
	body.TopSurface = Enum.SurfaceType.Smooth
	body.BottomSurface = Enum.SurfaceType.Smooth
	body.Parent = model

	local label = Instance.new("BillboardGui")
	label.Name = StructureBuilder.LabelName
	label.Size = UDim2.fromScale(12, 2)
	label.StudsOffsetWorldSpace = Vector3.new(0, structure.Size.Y / 2 + 2, 0)
	label.AlwaysOnTop = true

	local text = Instance.new("TextLabel")
	text.Name = StructureBuilder.TitleName
	text.Size = UDim2.fromScale(1, 1)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamBold
	text.Text = structure.Name
	text.TextColor3 = Color3.fromRGB(255, 255, 255)
	text.TextStrokeTransparency = 0.4
	text.TextScaled = true
	text.Parent = label

	label.Parent = body

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = GameConfig.Selection.PromptName
	prompt.ActionText = GameConfig.Selection.PromptActionText
	prompt.ObjectText = structure.Name
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	model:SetAttribute(STRUCT_ATTR.OwnerUserId, ownerUserId)
	model:SetAttribute(STRUCT_ATTR.StructureId, structure.Id)
	model:SetAttribute(STRUCT_ATTR.InstanceId, instanceId)

	model.PrimaryPart = body
	model.Parent = parent

	return model
end

return StructureBuilder
