--[[
	EffectsClient
	-------------
	Draws shots. Tracers from attacker to target, and a flash where they land.

	WHY THIS NEEDS A REMOTE AT ALL
	------------------------------
	Everything else this game shows a player is DERIVED from replicated
	attributes: health from a baseline and a timestamp, growth from a planting
	time, a status effect countdown from its expiry. None of it costs traffic,
	and a client that joins late sees the correct picture immediately.

	A shot is different. It is an event with no state behind it - once it has
	landed, nothing on either entity records that it happened, so there is
	nothing to derive it from. Health drops, but health drops for a dozen
	reasons and working backwards from "this raider lost 21 points" to "a
	tower at that position fired a Pierce bolt" is guesswork.

	So shots are announced, fire-and-forget. A dropped one costs a missing
	tracer and nothing else, because every number that matters is already an
	attribute.

	WHAT IT DECIDES: nothing. Colour and width come from the attack's damage
	type, which the client already has in GameConfig.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 14

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[EffectsClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Combat effects disabled.`
	)
	return
end

local acquired, effectRemote = pcall(function()
	return Remotes.GetEvent(GameConfig.RemoteNames.CombatEffect)
end)

if not acquired then
	warn("[EffectsClient] The combat effect remote never replicated, so the server did not finish starting.")
	return
end

--[[
	Tracer colour per damage type, so a fight is readable at a glance: you can
	see that the Frost Lily is firing without reading a single number.
]]
local TRACER_COLOUR = {
	Pierce = Color3.fromRGB(236, 232, 198),
	Melee = Color3.fromRGB(226, 226, 226),
	Siege = Color3.fromRGB(176, 142, 96),
	Magic = Color3.fromRGB(186, 146, 236),
	Fire = Color3.fromRGB(236, 112, 48),
	Ice = Color3.fromRGB(120, 196, 236),
	Poison = Color3.fromRGB(126, 196, 76),
}

local DEFAULT_COLOUR = Color3.fromRGB(255, 255, 255)

--- Seconds a tracer takes to fade out.
local TRACER_LIFETIME = 0.18
--- Seconds an impact flash lasts. Longer, so the eye lands on where it hit.
local FLASH_LIFETIME = 0.3

--- Beyond this there is nothing to see but noise.
local VIEW_DISTANCE = 300

--[[
	A cap on effects in flight.

	A big raid with a wall of towers can produce a lot of shots at once, and
	the failure mode of unbounded VFX is a frame rate drop during exactly the
	moment the player cares about. Dropping the newest effect is the right
	sacrifice: the fight is already legible from the dozens already drawn.
]]
local MAX_LIVE_EFFECTS = 60

local folder = Instance.new("Folder")
folder.Name = "CombatEffects"
folder.Parent = Workspace

--- { Part, Until, From, Kind }
local live = {}

local function spawnTracer(attackId: string, origin: Vector3, impact: Vector3)
	if #live >= MAX_LIVE_EFFECTS then
		return
	end

	local attack = GameConfig.GetAttack(attackId)
	local colour = if attack then TRACER_COLOUR[attack.DamageType] or DEFAULT_COLOUR else DEFAULT_COLOUR

	local offset = impact - origin
	local length = offset.Magnitude

	if length < 0.5 then
		return
	end

	-- A thin box stretched between the two points, rotated to face along it.
	local beam = Instance.new("Part")
	beam.Name = "Tracer"
	beam.Size = Vector3.new(0.3, 0.3, length)
	beam.CFrame = CFrame.lookAt(origin + offset / 2, impact)
	beam.Anchored = true
	beam.CanCollide = false
	beam.CanQuery = false
	beam.CastShadow = false
	beam.Material = Enum.Material.Neon
	beam.Color = colour
	beam.Parent = folder

	table.insert(live, {
		Part = beam,
		Until = os.clock() + TRACER_LIFETIME,
		Lifetime = TRACER_LIFETIME,
		BaseSize = beam.Size,
		Shrinks = false,
	})

	--[[
		The flash, at the point of impact. Splash attacks get a bigger one,
		sized to the blast - so a player can see how much of the horde an
		Ember Bloom actually caught, and place the next one accordingly.
	]]
	local radius = if attack and attack.SplashRadius then attack.SplashRadius else 1.6

	local flash = Instance.new("Part")
	flash.Name = "Impact"
	flash.Shape = Enum.PartType.Ball
	flash.Size = Vector3.new(radius * 2, radius * 2, radius * 2)
	flash.Position = impact
	flash.Anchored = true
	flash.CanCollide = false
	flash.CanQuery = false
	flash.CastShadow = false
	flash.Material = Enum.Material.Neon
	flash.Color = colour
	flash.Transparency = 0.5
	flash.Parent = folder

	table.insert(live, {
		Part = flash,
		Until = os.clock() + FLASH_LIFETIME,
		Lifetime = FLASH_LIFETIME,
		BaseSize = flash.Size,
		Shrinks = true,
	})
end

effectRemote.OnClientEvent:Connect(function(attackId: string, origin: Vector3, impact: Vector3)
	--[[
		Everything here is server-sent, so none of it is trusted further than
		"where to draw a light". Bad types are dropped rather than coerced -
		this is cosmetic, and an error in a render path is far worse than a
		missing tracer.
	]]
	if type(attackId) ~= "string" or typeof(origin) ~= "Vector3" or typeof(impact) ~= "Vector3" then
		return
	end

	local camera = Workspace.CurrentCamera

	-- Shots are broadcast to everyone, so most of them are somebody else's
	-- fight happening a long way away.
	if camera and (camera.CFrame.Position - origin).Magnitude > VIEW_DISTANCE then
		return
	end

	spawnTracer(attackId, origin, impact)
end)

--[[
	Fades and reaps. One loop for every effect rather than a thread each: a
	raid can produce hundreds, and a coroutine per tracer is how a fight
	becomes a stutter.
]]
RunService.RenderStepped:Connect(function()
	local now = os.clock()
	local index = 1

	while index <= #live do
		local effect = live[index]
		local remaining = effect.Until - now

		if remaining <= 0 then
			effect.Part:Destroy()
			-- Swap-remove: order does not matter and this stays O(1).
			live[index] = live[#live]
			table.remove(live)
		else
			local fraction = math.clamp(remaining / effect.Lifetime, 0, 1)

			effect.Part.Transparency = 1 - fraction * 0.6

			--[[
				Scaled from the ORIGINAL size each frame rather than from the
				current one. Multiplying the live size repeatedly compounds,
				so the flash would collapse to nothing in a few frames
				regardless of its lifetime.
			]]
			if effect.Shrinks then
				effect.Part.Size = effect.BaseSize * (0.45 + fraction * 0.55)
			end

			index += 1
		end
	end
end)

-- The folder is ours; nothing else should be adding to it.
Players.LocalPlayer.AncestryChanged:Connect(function()
	if not Players.LocalPlayer.Parent then
		folder:Destroy()
	end
end)
