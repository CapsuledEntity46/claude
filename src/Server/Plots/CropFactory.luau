--!nonstrict
--[[
	CropFactory
	-----------
	Builds the visual model for a crop at a given growth stage, driven entirely
	by the seed's GameConfig.Plantables entry (colour) and the rarity of the item
	it yields. Adding a seed to GameConfig therefore needs no changes here.

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
local function getFruitColor(plantable, stage: string): Color3
	if stage == GameConfig.Growth.MatureStage then
		return plantable.Color
	end

	local blend = if stage == "Growing" then 0.45 else 0.85
	return plantable.Color:Lerp(UNRIPE_COLOR, blend)
end

--[[
	Builds the crop model for `seedId` at `stage`, with its base resting on
	`basePosition`. Returns nil when there is nothing to show (empty plot or an
	unknown seed/stage), so callers can treat nil as "no crop".
]]
function CropFactory.Create(seedId: string, stage: string, basePosition: Vector3, scale: number?): Model?
	local plantable = GameConfig.GetPlantable(seedId)
	if not plantable then
		return nil
	end

	local yieldItem = GameConfig.GetItem(plantable.Yields)

	local stageScale = STAGE_SCALE[stage]
	if not stageScale then
		return nil
	end

	local rarityScale = RARITY_SCALE[yieldItem and yieldItem.Rarity] or 1
	local isMature = stage == GameConfig.Growth.MatureStage

	-- Density scale, from the plant's size tier: nine carrots to a square have
	-- to be smaller than the one pumpkin that would fill a third of it.
	local sizeScale = math.max(tonumber(scale) or 1, 0.05)

	local stemHeight = FULL_STEM_HEIGHT * stageScale * sizeScale
	local fruitDiameter = FULL_FRUIT_DIAMETER * stageScale * rarityScale * sizeScale

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
	fruit.Color = getFruitColor(plantable, stage)
	fruit.Material = if isMature then Enum.Material.SmoothPlastic else Enum.Material.Grass
	fruit.Anchored = true
	fruit.CanCollide = false
	fruit.TopSurface = Enum.SurfaceType.Smooth
	fruit.BottomSurface = Enum.SurfaceType.Smooth
	fruit.Parent = crop

	-- A ripe high-rarity crop glows, so a full garden reads at a glance.
	local rarity = yieldItem and yieldItem.Rarity

	if isMature and (rarity == "Epic" or rarity == "Legendary") then
		local light = Instance.new("PointLight")
		light.Name = "RarityGlow"
		light.Color = plantable.Color
		light.Brightness = 2
		light.Range = 10
		light.Shadows = false
		light.Parent = fruit
	end

	crop.PrimaryPart = stem

	return crop
end

--------------------------------------------------------------------------------
-- Stack layout
--------------------------------------------------------------------------------

--[[
	The most-square grid that holds exactly `capacity` plants, as (cols, rows).

	Exactly, not at least: a 3x3 for nine and a 3x1 for three, never a 2x2 with
	a hole in it. The grid is sized from CAPACITY rather than from how many are
	actually planted, so a half-filled square shows its empty slots - which is
	how the player learns a carrot square holds nine without being told.
]]
function CropFactory.GetLayout(capacity: number): (number, number)
	local total = math.max(math.floor(tonumber(capacity) or 1), 1)

	-- Largest divisor at or below the square root gives the squarest pair.
	for rows = math.floor(math.sqrt(total)), 1, -1 do
		if total % rows == 0 then
			return total // rows, rows
		end
	end

	return total, 1
end

--[[
	Base positions for every slot in a square, in a stable order.

	Ordered row by row so filling a square looks deliberate rather than
	scattered, and so the same plant count always occupies the same slots.
]]
function CropFactory.GetSlotPositions(capacity: number, centre: Vector3, spanX: number, spanZ: number): { Vector3 }
	local cols, rows = CropFactory.GetLayout(capacity)
	local positions = {}

	-- Cell centres: a single column sits on the middle, not against an edge.
	local stepX = if cols > 1 then spanX / cols else 0
	local stepZ = if rows > 1 then spanZ / rows else 0

	for row = 1, rows do
		for col = 1, cols do
			table.insert(
				positions,
				centre
					+ Vector3.new(
						(col - (cols + 1) / 2) * stepX,
						0,
						(row - (rows + 1) / 2) * stepZ
					)
			)
		end
	end

	return positions
end

return CropFactory
