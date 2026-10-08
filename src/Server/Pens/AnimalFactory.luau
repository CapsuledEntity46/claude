--!nonstrict
--[[
	AnimalFactory
	-------------
	Builds the visual model for one animal at a given maturity stage, driven
	entirely by its GameConfig.Animals entry. Adding an animal to the config
	therefore needs no changes here.

	The counterpart of CropFactory, and deliberately the same shape: built on
	the server so every player sees the same herd and a client cannot fake it,
	small (three parts), and only rebuilt on a stage TRANSITION rather than
	per tick.

	Like CropFactory this is the single swap point for authored art: replace
	Create() to clone ReplicatedStorage assets keyed by animal id and stage,
	and keep returning a Model whose feet rest on `basePosition`.

	Animals are static props, not pathfinding units. The roadmap's "herdable
	units" are a later step - giving them movement now would mean writing it
	twice, once against a pen and again against the unit command system.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local AnimalFactory = {}

AnimalFactory.ModelName = "Herd"

-- Fraction of full size at each maturity stage. A juvenile is visibly a
-- juvenile, so "not ready yet" is readable without opening a panel.
local STAGE_SCALE = {
	Juvenile = 0.45,
	Adolescent = 0.7,
	Grown = 1.0,
}

local FULL_BODY_LENGTH = 2.4
local FULL_BODY_HEIGHT = 1.4
local LEG_HEIGHT = 0.7

local LEG_COLOR = Color3.fromRGB(94, 78, 64)

--[[
	Builds the model for one animal at `stage`, standing on `basePosition`.
	Returns nil when there is nothing to show - an unknown animal or an
	unknown stage - so callers can treat nil as "no animal".
]]
function AnimalFactory.Create(stockId: string, stage: string, basePosition: Vector3, scale: number?): Model?
	local animal = GameConfig.GetAnimal(stockId)
	if not animal then
		return nil
	end

	local stageScale = STAGE_SCALE[stage]
	if not stageScale then
		return nil
	end

	-- Density scale, from the animal's size tier: six birds in a coop have to
	-- be smaller than the three cattle that would fill a barn.
	local sizeScale = math.max(tonumber(scale) or 1, 0.05)

	local bodyLength = FULL_BODY_LENGTH * stageScale * sizeScale
	local bodyHeight = FULL_BODY_HEIGHT * stageScale * sizeScale
	local legHeight = LEG_HEIGHT * stageScale * sizeScale

	local model = Instance.new("Model")
	model.Name = stockId

	local legs = Instance.new("Part")
	legs.Name = "Legs"
	legs.Size = Vector3.new(bodyLength * 0.7, legHeight, bodyLength * 0.45)
	legs.Position = basePosition + Vector3.new(0, legHeight / 2, 0)
	legs.Color = LEG_COLOR
	legs.Material = Enum.Material.SmoothPlastic
	legs.Anchored = true
	legs.CanCollide = false
	legs.CastShadow = false
	legs.TopSurface = Enum.SurfaceType.Smooth
	legs.BottomSurface = Enum.SurfaceType.Smooth
	legs.Parent = model

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = Vector3.new(bodyLength, bodyHeight, bodyLength * 0.6)
	body.Position = basePosition + Vector3.new(0, legHeight + bodyHeight / 2, 0)
	body.Color = animal.Color
	body.Material = Enum.Material.SmoothPlastic
	body.Anchored = true
	body.CanCollide = false
	body.TopSurface = Enum.SurfaceType.Smooth
	body.BottomSurface = Enum.SurfaceType.Smooth
	body.Parent = model

	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(bodyHeight * 0.6, bodyHeight * 0.6, bodyHeight * 0.6)
	head.Position = basePosition
		+ Vector3.new(bodyLength / 2, legHeight + bodyHeight * 0.9, 0)
	head.Color = animal.Color
	head.Material = Enum.Material.SmoothPlastic
	head.Anchored = true
	head.CanCollide = false
	head.TopSurface = Enum.SurfaceType.Smooth
	head.BottomSurface = Enum.SurfaceType.Smooth
	head.Parent = model

	--[[
		PrimaryPart is the BODY, not the legs: it is what the herd container
		borrows for its own PrimaryPart, which is where a health bar is drawn
		and where a raider aims. Pointing it at the legs would put both on the
		floor.
	]]
	model.PrimaryPart = body

	return model
end

--------------------------------------------------------------------------------
-- Herd layout
--------------------------------------------------------------------------------

--[[
	The most-square grid that holds exactly `capacity` animals, as (cols, rows).

	Identical reasoning to CropFactory.GetLayout, and deliberately not shared
	with it: the two will diverge the moment animals get authored models with
	a facing direction, and a layout helper serving both would then have to
	know which it was laying out.
]]
function AnimalFactory.GetLayout(capacity: number): (number, number)
	local total = math.max(math.floor(tonumber(capacity) or 1), 1)

	for rows = math.floor(math.sqrt(total)), 1, -1 do
		if total % rows == 0 then
			return total // rows, rows
		end
	end

	return total, 1
end

--[[
	Standing positions for every slot in a pen, in a stable order.

	Sized from CAPACITY rather than headcount, so a part-full pen shows its
	empty space - which is how a player learns a coop holds six without being
	told - and so the same headcount always stands in the same places.
]]
function AnimalFactory.GetSlotPositions(capacity: number, centre: Vector3, spanX: number, spanZ: number): { Vector3 }
	local cols, rows = AnimalFactory.GetLayout(capacity)
	local positions = {}

	-- Cell centres: a single column stands on the middle, not against a wall.
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

return AnimalFactory
