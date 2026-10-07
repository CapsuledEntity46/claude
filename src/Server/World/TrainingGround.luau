--[[
	TrainingGround
	--------------
	One practice dummy per status effect, with a ProximityPrompt that applies
	it.

	WHY THIS EXISTS
	---------------
	Status effects are a system with no producer yet: the things that will
	actually set a raider alight - combat plants, troops, tower volleys - are
	later steps. Without somewhere to trigger one, the whole layer is only
	observable from the test harness, which is no use for judging how it FEELS.

	So this is a range to practise on. It is a real, server-authoritative
	affordance rather than a debug backdoor:

	  * the prompts are created on the server, and Triggered is handled on the
	    server, so no remote exists for a client to forge,
	  * the engine enforces prompt reach, and the handler re-checks distance
	    anyway, because reach is enforced on the machine the exploiter owns,
	  * dummies are neutral entities going through the same DamageableService
	    path as everything else, so a dummy dying exercises the real death and
	    reward code.

	Generated from GameConfig.StatusEffects, so adding an effect adds a post
	without touching this file.

	Deleting this module and its Build() call removes the range and nothing
	else.
]]

local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)

local DamageableService = require(script.Parent.Parent.Combat.DamageableService)
local RaidService = require(script.Parent.Parent.Combat.RaidService)
local StatusEffectService = require(script.Parent.Parent.Combat.StatusEffectService)

local TrainingGround = {}

TrainingGround.FrameworkVersion = 13

local FOLDER_NAME = "TrainingGround"
--[[
	A dedicated NEUTRAL archetype, not EnemyRaider.

	Two reasons. A tower built near the range would otherwise shoot the
	dummies, and a range you cannot stand a tower next to is not much of a
	range. And EnemyRaider carries kill rewards: with a six second respawn,
	the range was an endless source of purse gold and XP.
]]
local DUMMY_ARCHETYPE = "PracticeDummy"

--- Seconds before a destroyed dummy is back on its feet.
local RESPAWN_DELAY = 6

--[[
	Tucked in behind the spawn pad, alongside the shop, rather than out in the
	open ground.

	Placement does not know about world props - IsBlocked only consults
	structures players have built - so a range in the middle of the build area
	would let someone put a Farm inside a dummy. Keeping the amenities in one
	row behind spawn avoids that without inventing a second obstacle system.
]]
local ORIGIN = Vector3.new(18, 0, -34)
local SPACING = 10

--- entityId -> post, so the Destroyed handler can find what to put back up.
local posts = {}

local function label(parent: Instance, text: string, offsetY: number, size: number)
	local billboard = Instance.new("BillboardGui")
	billboard.Name = "Label"
	billboard.Size = UDim2.fromOffset(190, 28)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, offsetY, 0)
	billboard.AlwaysOnTop = true
	billboard.Parent = parent

	local gui = Instance.new("TextLabel")
	gui.Size = UDim2.fromScale(1, 1)
	gui.BackgroundTransparency = 1
	gui.Font = Enum.Font.GothamBold
	gui.TextSize = size
	gui.Text = text
	gui.TextColor3 = Color3.fromRGB(255, 255, 255)
	gui.TextStrokeTransparency = 0.35
	gui.Parent = billboard

	return gui
end

--- Registers (or re-registers) the dummy behind a post at full health.
local function raise(post)
	local entityId = DamageableService:Register({
		ArchetypeId = DUMMY_ARCHETYPE,
		Model = post.Model,
		-- Neutral: nobody owns a training dummy, so killing one cannot be
		-- mistaken for farming your own buildings.
		OwnerUserId = 0,
	})

	if not entityId then
		return
	end

	post.EntityId = entityId
	posts[entityId] = post

	post.Body.Transparency = 0
	post.Body.Color = post.Colour
	post.Prompt.Enabled = true
end

local function build(effect, index: number, folder: Instance)
	local model = Instance.new("Model")
	model.Name = `Dummy_{effect.Id}`

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = Vector3.new(3, 7, 3)
	body.Anchored = true
	body.CanCollide = true
	body.Color = effect.Colour
	body.Material = Enum.Material.WoodPlanks
	body.Position = ORIGIN + Vector3.new((index - 1) * SPACING, 3.5, 0)
	body.Parent = model

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = "ApplyPrompt"
	prompt.ActionText = effect.Name
	prompt.ObjectText = "Practice Dummy"
	prompt.HoldDuration = 0
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	label(body, effect.Name, 5.2, 15)

	model.PrimaryPart = body
	model.Parent = folder

	local post = {
		EffectId = effect.Id,
		Model = model,
		Body = body,
		Prompt = prompt,
		Colour = effect.Colour,
		EntityId = nil,
	}

	prompt.Triggered:Connect(function(player: Player)
		--[[
			Reach is enforced by the engine on the CLIENT, which an exploiter
			controls, so it is re-checked here with slack for latency - the
			same rule FarmService applies to planting.
		]]
		local character = player.Character
		local root = if character then character.PrimaryPart else nil

		if not root then
			return
		end

		local reach = GameConfig.Interaction.MaxActivationDistance + GameConfig.Interaction.DistanceTolerance

		if (root.Position - body.Position).Magnitude > reach then
			return
		end

		if not post.EntityId then
			return
		end

		StatusEffectService:Apply(post.EntityId, post.EffectId, player)
	end)

	raise(post)

	return post
end

--------------------------------------------------------------------------------
-- The raid horn
--------------------------------------------------------------------------------

local function buildHorn(folder: Instance, index: number)
	local model = Instance.new("Model")
	model.Name = "RaidHorn"

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = Vector3.new(4, 8, 4)
	body.Position = ORIGIN + Vector3.new((index - 1) * SPACING + 4, 4, 0)
	body.Anchored = true
	body.CanCollide = true
	body.Color = Color3.fromRGB(96, 58, 58)
	body.Material = Enum.Material.Rock
	body.Parent = model

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = "SummonPrompt"
	prompt.ActionText = "Sound the Horn"
	prompt.ObjectText = "Raid Horn"
	prompt.HoldDuration = 0.5
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.MaxActivationDistance = GameConfig.Interaction.MaxActivationDistance
	prompt.RequiresLineOfSight = false
	prompt.Parent = body

	label(body, "Raid Horn", 6, 16)

	model.PrimaryPart = body
	model.Parent = folder

	prompt.Triggered:Connect(function(player: Player)
		-- Reach is enforced on the client, which an exploiter owns.
		local character = player.Character
		local root = if character then character.PrimaryPart else nil

		if not root then
			return
		end

		local reach = GameConfig.Interaction.MaxActivationDistance + GameConfig.Interaction.DistanceTolerance

		if (root.Position - body.Position).Magnitude > reach then
			return
		end

		RaidService:SummonWave(player)
	end)

	return model
end

--------------------------------------------------------------------------------
-- Entry point
--------------------------------------------------------------------------------

function TrainingGround.Build()
	local existing = Workspace:FindFirstChild(FOLDER_NAME)

	if existing then
		existing:Destroy()
	end

	local folder = Instance.new("Folder")
	folder.Name = FOLDER_NAME
	folder.Parent = Workspace

	-- Sorted so the posts are laid out in the same order every boot rather
	-- than in hash order.
	local effectIds = {}
	for effectId in GameConfig.StatusEffects do
		table.insert(effectIds, effectId)
	end
	table.sort(effectIds)

	for index, effectId in effectIds do
		build(GameConfig.StatusEffects[effectId], index, folder)
	end

	--[[
		THE RAID HORN.

		Waves are summoned rather than timed, so this is how a raid starts.
		It sits with the practice range because it serves the same purpose:
		letting the player find out whether their defences work, when they
		choose to, instead of being told while they are mid-build.
	]]
	buildHorn(folder, #effectIds + 1)

	--[[
		A felled dummy goes back up after a pause, so the range can be used
		more than once. The model is kept and only the entity is re-registered:
		destroying and rebuilding the model would invalidate the prompt
		connection made above.
	]]
	DamageableService.Destroyed:Connect(function(entityId: number)
		local post = posts[entityId]

		if not post then
			return
		end

		posts[entityId] = nil
		post.EntityId = nil
		post.Body.Transparency = 0.6
		post.Body.Color = Color3.fromRGB(70, 70, 70)
		post.Prompt.Enabled = false

		task.delay(RESPAWN_DELAY, function()
			-- The range may have been rebuilt underneath us.
			if post.Model.Parent then
				raise(post)
			end
		end)
	end)

	return folder
end

return TrainingGround
