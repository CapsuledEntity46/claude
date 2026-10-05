--!nonstrict
--[[
	CropFactory
	-----------
	Builds the visual model for a crop at a given growth stage, driven entirely
	by the seed's GameConfig definition (colour, rarity). Adding a seventh seed
	to GameConfig therefore needs no changes here.

	Crops are built on the server so every player sees the same garden state and
	the visuals cannot be faked by a client. Models are small (two parts) and
	are only rebuilt on a stage *transition*, not per tick.

	Like PlotBuilder, this is the single swap point for authored art: replace
	Create() to clone ReplicatedStorage assets keyed by seed id and stage, and
	keep returning a Model whose base sits at `basePosition`.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local CropFactory = {}

CropFactory.ModelName = "Crop"

-- Fraction of full size at each stage.
local STAGE_SCALE = {
	Seedling = 0.3,
	Growing = 0.65,
	Mature = 1.0,
}

-- Rarer crops read as visually bigger at full growth.
local RARITY_SCALE = {
	Common = 1.0,
	Uncommon = 1.1,
	Rare = 1.2,
	Epic = 1.35,
	Legendary = 1.55,
}

local STEM_COLOR = Color3.fromRGB(78, 122, 54)
local UNRIPE_COLOR = Color3.fromRGB(122, 168, 84)

local FULL_STEM_HEIGHT = 2.6
local FULL_FRUIT_DIAMETER = 2.2

--- Unripe crops are tinted toward green and ripen into the seed's own colour.
local function getFruitColor(seed, stage: string): Color3
	if stage == GameConfig.Growth.MatureStage then
		return seed.Color
	end

	local blend = if stage == "Growing" then 0.45 else 0.85
	return seed.Color:Lerp(UNRIPE_COLOR, blend)
end

--[[
	Builds the crop model for `seedId` at `stage`, with its base resting on
	`basePosition`. Returns nil when there is nothing to show (empty plot or an
	unknown seed/stage), so callers can treat nil as "no crop".
]]
function CropFactory.Create(seedId: string, stage: string, basePosition: Vector3): Model?
	local seed = GameConfig.GetSeed(seedId)
	if not seed then
		return nil
	end

	local stageScale = STAGE_SCALE[stage]
	if not stageScale then
		return nil
	end

	local rarityScale = RARITY_SCALE[seed.Rarity] or 1
	local isMature = stage == GameConfig.Growth.MatureStage

	local stemHeight = FULL_STEM_HEIGHT * stageScale
	local fruitDiameter = FULL_FRUIT_DIAMETER * stageScale * rarityScale

	local crop = Instance.new("Model")
	crop.Name = CropFactory.ModelName

	local stem = Instance.new("Part")
	stem.Name = "Stem"
	stem.Size = Vector3.new(0.35, stemHeight, 0.35)
	stem.Position = basePosition + Vector3.new(0, stemHeight / 2, 0)
	stem.Color = STEM_COLOR
	stem.Material = Enum.Material.Grass
	stem.Anchored = true
	stem.CanCollide = false
	stem.CastShadow = false
	stem.TopSurface = Enum.SurfaceType.Smooth
	stem.BottomSurface = Enum.SurfaceType.Smooth
	stem.Parent = crop

	local fruit = Instance.new("Part")
	fruit.Name = "Fruit"
	fruit.Shape = Enum.PartType.Ball
	fruit.Size = Vector3.new(fruitDiameter, fruitDiameter, fruitDiameter)
	fruit.Position = basePosition + Vector3.new(0, stemHeight + fruitDiameter * 0.35, 0)
	fruit.Color = getFruitColor(seed, stage)
	fruit.Material = if isMature then Enum.Material.SmoothPlastic else Enum.Material.Grass
	fruit.Anchored = true
	fruit.CanCollide = false
	fruit.TopSurface = Enum.SurfaceType.Smooth
	fruit.BottomSurface = Enum.SurfaceType.Smooth
	fruit.Parent = crop

	-- A ripe high-rarity crop glows, so a full garden reads at a glance.
	if isMature and (seed.Rarity == "Epic" or seed.Rarity == "Legendary") then
		local light = Instance.new("PointLight")
		light.Name = "RarityGlow"
		light.Color = seed.Color
		light.Brightness = 2
		light.Range = 10
		light.Shadows = false
		light.Parent = fruit
	end

	crop.PrimaryPart = stem

	return crop
end

return CropFactory
