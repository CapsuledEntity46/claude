--[[
	CombatClient
	------------
	Health bars and status-effect pips, drawn above anything damageable.

	WHAT THE CLIENT DECIDES: nothing. Every number here is read from attributes
	the server published, and the curve between updates is DERIVED with
	Shared.Combat and Shared.StatusEffects - the same modules the server uses.

	This is why health and effects are replicated as timestamps rather than as
	current values. A regenerating crop needs zero updates while it heals: the
	three attributes already describe the whole curve, and this script
	re-derives it every frame locally. Likewise a burn publishes only its stack
	count and its expiry, so the countdown ticks down here without a single
	packet.

	Bars are hidden at full health with no effects, because a settlement of
	twenty farms wearing permanent full bars is unreadable.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Combat = require(Shared.Combat)
local GameConfig = require(Shared.GameConfig)
local StatusEffects = require(Shared.StatusEffects)

local EXPECTED_FRAMEWORK = 12

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[CombatClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Health bars disabled.`
	)
	return
end

local HEALTH_ATTR = GameConfig.HealthAttributes

local COLORS = {
	Backing = Color3.fromRGB(18, 20, 26),
	Healthy = Color3.fromRGB(86, 186, 104),
	Hurt = Color3.fromRGB(226, 184, 68),
	Critical = Color3.fromRGB(216, 78, 72),
	Shattered = Color3.fromRGB(120, 124, 134),
}

--- How far away a bar is still drawn. Past this it is pixels of noise.
local VIEW_DISTANCE = 220

--- model -> overlay
local tracked = {}

--------------------------------------------------------------------------------
-- Overlay construction
--------------------------------------------------------------------------------

local function buildOverlay(model: Instance)
	local anchor = model.PrimaryPart

	if not anchor then
		return nil
	end

	local billboard = Instance.new("BillboardGui")
	billboard.Name = "CombatOverlay"
	billboard.Size = UDim2.fromOffset(120, 34)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, anchor.Size.Y / 2 + 2.2, 0)
	billboard.AlwaysOnTop = true
	billboard.Adornee = anchor
	billboard.Parent = anchor

	local backing = Instance.new("Frame")
	backing.Name = "Backing"
	backing.Size = UDim2.new(1, 0, 0, 8)
	backing.Position = UDim2.fromOffset(0, 22)
	backing.BackgroundColor3 = COLORS.Backing
	backing.BorderSizePixel = 0
	backing.Parent = billboard

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = backing

	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.Size = UDim2.fromScale(1, 1)
	fill.BackgroundColor3 = COLORS.Healthy
	fill.BorderSizePixel = 0
	fill.Parent = backing

	local fillCorner = Instance.new("UICorner")
	fillCorner.CornerRadius = UDim.new(0, 4)
	fillCorner.Parent = fill

	--[[
		One pip per effect, created up front and hidden rather than created on
		demand. Effects come and go every few seconds, and building Instances
		in a render loop is how a smooth game starts stuttering under a raid.
	]]
	local pipRow = Instance.new("Frame")
	pipRow.Name = "Pips"
	pipRow.Size = UDim2.new(1, 0, 0, 18)
	pipRow.BackgroundTransparency = 1
	pipRow.Parent = billboard

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.VerticalAlignment = Enum.VerticalAlignment.Bottom
	layout.Padding = UDim.new(0, 3)
	layout.SortOrder = Enum.SortOrder.Name
	layout.Parent = pipRow

	local pips = {}

	for effectId in GameConfig.StatusEffects do
		local effect = GameConfig.StatusEffects[effectId]

		local pip = Instance.new("TextLabel")
		pip.Name = effectId
		pip.Size = UDim2.fromOffset(22, 16)
		pip.BackgroundColor3 = effect.Colour
		pip.BorderSizePixel = 0
		pip.Font = Enum.Font.GothamBold
		pip.TextSize = 11
		pip.TextColor3 = Color3.fromRGB(16, 18, 22)
		pip.Text = ""
		pip.Visible = false
		pip.Parent = pipRow

		local pipCorner = Instance.new("UICorner")
		pipCorner.CornerRadius = UDim.new(0, 3)
		pipCorner.Parent = pip

		pips[effectId] = pip
	end

	return {
		Model = model,
		Anchor = anchor,
		Billboard = billboard,
		Fill = fill,
		Backing = backing,
		Pips = pips,
	}
end

--------------------------------------------------------------------------------
-- Tracking
--------------------------------------------------------------------------------

local function isDamageable(instance: Instance): boolean
	return instance:IsA("Model") and instance:GetAttribute(HEALTH_ATTR.MaxHealth) ~= nil
end

local function track(model: Instance)
	if tracked[model] then
		return
	end

	local overlay = buildOverlay(model)

	if overlay then
		tracked[model] = overlay
	end
end

local function untrack(model: Instance)
	local overlay = tracked[model]

	if not overlay then
		return
	end

	tracked[model] = nil

	if overlay.Billboard then
		overlay.Billboard:Destroy()
	end
end

local function consider(instance: Instance)
	if isDamageable(instance) then
		track(instance)
		return
	end

	--[[
		The MaxHealth attribute can arrive after the model does - replication
		does not promise an order. So a Model that is not damageable YET is
		watched once, rather than written off.
	]]
	if instance:IsA("Model") then
		local connection

		connection = instance:GetAttributeChangedSignal(HEALTH_ATTR.MaxHealth):Connect(function()
			if isDamageable(instance) then
				connection:Disconnect()
				track(instance)
			end
		end)
	end
end

for _, descendant in Workspace:GetDescendants() do
	consider(descendant)
end

Workspace.DescendantAdded:Connect(consider)
Workspace.DescendantRemoving:Connect(untrack)

--------------------------------------------------------------------------------
-- Render
--------------------------------------------------------------------------------

local function updateOverlay(overlay, now: number, cameraPosition: Vector3)
	local model = overlay.Model
	local anchor = overlay.Anchor

	if not anchor.Parent then
		return false
	end

	if (anchor.Position - cameraPosition).Magnitude > VIEW_DISTANCE then
		overlay.Billboard.Enabled = false
		return true
	end

	local maxHealth = model:GetAttribute(HEALTH_ATTR.MaxHealth) or 0

	if maxHealth <= 0 then
		overlay.Billboard.Enabled = false
		return true
	end

	-- Derived locally from the published baseline, so a regenerating entity
	-- animates smoothly without the server saying anything.
	local health = Combat.DeriveHealth(
		model:GetAttribute(HEALTH_ATTR.HealthBase) or maxHealth,
		maxHealth,
		model:GetAttribute(HEALTH_ATTR.RegenPerSecond) or 0,
		model:GetAttribute(HEALTH_ATTR.DamagedAt) or now,
		now
	)

	local fraction = math.clamp(health / maxHealth, 0, 1)
	local shattered = model:GetAttribute(HEALTH_ATTR.Shattered) == true

	local anyEffect = false

	for effectId, pip in overlay.Pips do
		local stacks = model:GetAttribute(StatusEffects.StackAttribute(effectId))
		local expiresAt = model:GetAttribute(StatusEffects.ExpiryAttribute(effectId))

		if stacks and expiresAt and expiresAt > now then
			local remaining = math.max(expiresAt - now, 0)

			-- Stacks are only worth showing once there is more than one.
			pip.Text = if stacks > 1
				then `{string.sub(effectId, 1, 1)}{stacks}`
				else `{string.sub(effectId, 1, 1)} {math.ceil(remaining)}`
			pip.Visible = true
			anyEffect = true
		else
			pip.Visible = false
		end
	end

	-- Full health and nothing wrong: say nothing.
	local interesting = fraction < 1 or shattered or anyEffect
	overlay.Billboard.Enabled = interesting

	if not interesting then
		return true
	end

	overlay.Fill.Size = UDim2.fromScale(fraction, 1)

	if shattered then
		overlay.Fill.BackgroundColor3 = COLORS.Shattered
	elseif fraction > 0.6 then
		overlay.Fill.BackgroundColor3 = COLORS.Healthy
	elseif fraction > 0.3 then
		overlay.Fill.BackgroundColor3 = COLORS.Hurt
	else
		overlay.Fill.BackgroundColor3 = COLORS.Critical
	end

	return true
end

RunService.RenderStepped:Connect(function()
	local camera = Workspace.CurrentCamera

	if not camera then
		return
	end

	local now = os.time()
	local cameraPosition = camera.CFrame.Position
	local stale = nil

	for model, overlay in tracked do
		if not model.Parent or not updateOverlay(overlay, now, cameraPosition) then
			stale = stale or {}
			table.insert(stale, model)
		end
	end

	-- Removed after iterating, never during it.
	for _, model in stale or {} do
		untrack(model)
	end
end)
