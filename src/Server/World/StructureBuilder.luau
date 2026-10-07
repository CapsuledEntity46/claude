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
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local STRUCT_ATTR = GameConfig.StructureAttributes

local StructureBuilder = {}

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
	label.Name = "Label"
	label.Size = UDim2.fromScale(12, 2)
	label.StudsOffsetWorldSpace = Vector3.new(0, structure.Size.Y / 2 + 2, 0)
	label.AlwaysOnTop = true

	local text = Instance.new("TextLabel")
	text.Size = UDim2.fromScale(1, 1)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.GothamBold
	text.Text = structure.Name
	text.TextColor3 = Color3.fromRGB(255, 255, 255)
	text.TextStrokeTransparency = 0.4
	text.TextScaled = true
	text.Parent = label

	label.Parent = body

	model:SetAttribute(STRUCT_ATTR.OwnerUserId, ownerUserId)
	model:SetAttribute(STRUCT_ATTR.StructureId, structure.Id)
	model:SetAttribute(STRUCT_ATTR.InstanceId, instanceId)

	model.PrimaryPart = body
	model.Parent = parent

	return model
end

return StructureBuilder
