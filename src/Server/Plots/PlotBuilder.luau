--!nonstrict
--[[
	PlotBuilder
	-----------
	Procedurally builds a garden: a grass base, a grid of soil plots, and a
	ProximityPrompt per plot.

	Gardens are generated at runtime rather than authored in a place file, so
	the game builds and runs from source alone with no manual Studio setup.

	SWAPPING IN AUTHORED MODELS
	---------------------------
	This module is the single place that knows what a garden looks like.
	To use artist-made models instead, replace CreateGarden so it clones your
	template and returns the same contract:

		Garden (Model, PrimaryPart set)
		└── Plots (Folder)
		    ├── Plot_1 (Model, PrimaryPart = its Soil part)
		    │   └── Soil (Part)
		    │       └── Interact (ProximityPrompt)
		    └── Plot_2 ...

	Each Plot model must carry the attributes listed in
	GameConfig.PlotAttributes. PlotService depends on nothing else.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local PlotBuilder = {}

local PLOT_ATTR = GameConfig.PlotAttributes

--- Centre of garden slot `slotIndex` (1-based), tiled outward from the origin.
function PlotBuilder.GetSlotOrigin(slotIndex: number): Vector3
	local config = GameConfig.Garden

	local zeroBased = slotIndex - 1
	local column = zeroBased % config.SlotsPerRow
	local row = math.floor(zeroBased / config.SlotsPerRow)

	return config.Origin + Vector3.new(column * config.SlotSpacing.X, 0, row * config.SlotSpacing.Z)
end

--- Local offset of plot `index` within its garden, on the soil's top plane.
local function getPlotOffset(index: number): Vector3
	local config = GameConfig.Garden

	local columns = config.PlotsPerRow
	local rows = math.ceil(config.PlotsPerGarden / columns)

	local zeroBased = index - 1
	local column = zeroBased % columns
	local row = math.floor(zeroBased / columns)

	local spanX = (columns - 1) * config.SoilSpacing
	local spanZ = (rows - 1) * config.SoilSpacing

	return Vector3.new(column * config.SoilSpacing - spanX / 2, 0, row * config.SoilSpacing - spanZ / 2)
end

local function createBase(origin: Vector3): Part
	local config = GameConfig.Garden

	local columns = config.PlotsPerRow
	local rows = math.ceil(config.PlotsPerGarden / columns)

	local width = (columns - 1) * config.SoilSpacing + config.SoilSize.X + config.BasePadding * 2
	local depth = (rows - 1) * config.SoilSpacing + config.SoilSize.Z + config.BasePadding * 2

	local base = Instance.new("Part")
	base.Name = "Base"
	base.Size = Vector3.new(width, 1, depth)
	-- Base top sits exactly at the origin's Y, so soil rests on it.
	base.Position = origin - Vector3.new(0, 0.5, 0)
	base.Anchored = true
	base.Color = config.BaseColor
	base.Material = Enum.Material.Grass
	base.TopSurface = Enum.SurfaceType.Smooth
	base.BottomSurface = Enum.SurfaceType.Smooth

	return base
end

local function createSoil(origin: Vector3, index: number): Part
	local config = GameConfig.Garden

	local soil = Instance.new("Part")
	soil.Name = "Soil"
	soil.Size = config.SoilSize
	soil.Position = origin + getPlotOffset(index) + Vector3.new(0, config.SoilSize.Y / 2, 0)
	soil.Anchored = true
	soil.Color = config.SoilColor
	soil.Material = Enum.Material.Ground
	soil.TopSurface = Enum.SurfaceType.Smooth
	soil.BottomSurface = Enum.SurfaceType.Smooth

	return soil
end

local function createPrompt(): ProximityPrompt
	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = "Interact"
	prompt.ActionText = "Plant"
	prompt.ObjectText = "Plot"
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Garden.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	-- Disabled until PlotService assigns an owner and evaluates the plot state.
	prompt.Enabled = false

	return prompt
end

--- Top-centre world position of a plot's soil: where crops are planted.
function PlotBuilder.GetPlantPosition(plot: Model): Vector3
	local soil = plot.PrimaryPart or plot:FindFirstChild("Soil")
	return soil.Position + Vector3.new(0, soil.Size.Y / 2, 0)
end

--[[
	Builds one garden and parents it to `parent`.

	The returned model is inert: every plot is unowned, empty and locked until
	PlotService assigns it. That keeps construction free of gameplay rules.
]]
function PlotBuilder.CreateGarden(slotIndex: number, parent: Instance): Model
	local config = GameConfig.Garden
	local origin = PlotBuilder.GetSlotOrigin(slotIndex)

	local garden = Instance.new("Model")
	garden.Name = `Garden_{slotIndex}`

	local base = createBase(origin)
	base.Parent = garden

	local plotsFolder = Instance.new("Folder")
	plotsFolder.Name = "Plots"

	for index = 1, config.PlotsPerGarden do
		local plot = Instance.new("Model")
		plot.Name = `Plot_{index}`

		local soil = createSoil(origin, index)
		soil.Parent = plot
		plot.PrimaryPart = soil

		local prompt = createPrompt()
		prompt.Parent = soil

		plot:SetAttribute(PLOT_ATTR.PlotIndex, index)
		plot:SetAttribute(PLOT_ATTR.OwnerUserId, 0)
		plot:SetAttribute(PLOT_ATTR.SeedId, "")
		plot:SetAttribute(PLOT_ATTR.PlantedAt, 0)
		plot:SetAttribute(PLOT_ATTR.ReadyAt, 0)
		plot:SetAttribute(PLOT_ATTR.Stage, GameConfig.Growth.EmptyStage)
		plot:SetAttribute(PLOT_ATTR.Locked, true)
		plot:SetAttribute(PLOT_ATTR.UnlockLevel, config.PlotUnlockLevels[index])

		plot.Parent = plotsFolder
	end

	plotsFolder.Parent = garden
	garden.PrimaryPart = base
	garden.Parent = parent

	return garden
end

return PlotBuilder
