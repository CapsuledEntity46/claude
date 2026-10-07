--[[
	DefeatClient
	------------
	The panel a defeated player answers.

	DRIVEN BY AN ATTRIBUTE, NOT AN EVENT. The server sets `Defeated` on the
	player and this watches it. That matters more than it sounds: a player who
	disconnects and rejoins mid-defeat, or whose client reconnects after a
	blip, gets the panel back - whereas a one-shot event would have been
	missed and they would be standing in a ruined base with no way to answer.

	It is the same reasoning as health and growth being derived from
	replicated state rather than pushed: the correct picture is reconstructible
	at any moment, from scratch.

	WHAT THE CLIENT DECIDES: nothing. Both buttons send a word to the server,
	which owns the token spend, the resource loss and the rebuild. The costs
	shown here come from GameConfig, which both sides read.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 14

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[DefeatClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Defeat panel disabled.`
	)
	return
end

local player = Players.LocalPlayer
local ATTR = GameConfig.Attributes

local COLORS = {
	Shade = Color3.fromRGB(10, 10, 14),
	Panel = Color3.fromRGB(28, 30, 38),
	Text = Color3.fromRGB(236, 238, 245),
	Muted = Color3.fromRGB(150, 156, 172),
	FightOn = Color3.fromRGB(168, 78, 182),
	Surrender = Color3.fromRGB(142, 84, 70),
	Disabled = Color3.fromRGB(62, 66, 78),
}

--------------------------------------------------------------------------------
-- Panel
--------------------------------------------------------------------------------

local screen = Instance.new("ScreenGui")
screen.Name = "DefeatGui"
screen.ResetOnSpawn = false
screen.IgnoreGuiInset = true
screen.DisplayOrder = 10
screen.Enabled = false

-- A full-screen shade, so the choice cannot be mistaken for scenery.
local shade = Instance.new("Frame")
shade.Size = UDim2.fromScale(1, 1)
shade.BackgroundColor3 = COLORS.Shade
shade.BackgroundTransparency = 0.35
shade.BorderSizePixel = 0
shade.Parent = screen

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.fromScale(0.5, 0.5)
panel.Size = UDim2.fromOffset(520, 290)
panel.BackgroundColor3 = COLORS.Panel
panel.BorderSizePixel = 0
panel.Parent = shade

local panelCorner = Instance.new("UICorner")
panelCorner.CornerRadius = UDim.new(0, 10)
panelCorner.Parent = panel

local function label(properties)
	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.Gotham
	text.TextColor3 = COLORS.Text
	text.TextSize = 15
	text.TextXAlignment = Enum.TextXAlignment.Center
	text.TextWrapped = true

	for key, value in properties do
		text[key] = value
	end

	text.Parent = panel
	return text
end

label({
	Position = UDim2.fromOffset(24, 26),
	Size = UDim2.new(1, -48, 0, 30),
	Font = Enum.Font.GothamBold,
	TextSize = 24,
	Text = "Your Checkpoint lies in ruins",
})

label({
	Position = UDim2.fromOffset(24, 62),
	Size = UDim2.new(1, -48, 0, 44),
	TextColor3 = COLORS.Muted,
	Text = "You fell with no anchor standing. Choose how you come back — both call off the raid and raise the Checkpoint again.",
})

local function actionButton(properties)
	local button = Instance.new("TextButton")
	button.AutoButtonColor = true
	button.BorderSizePixel = 0
	button.Font = Enum.Font.GothamBold
	button.TextColor3 = COLORS.Text
	button.TextSize = 16
	button.Size = UDim2.new(1, -48, 0, 46)

	for key, value in properties do
		button[key] = value
	end

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 8)
	corner.Parent = button

	button.Parent = panel
	return button
end

local fightOnButton = actionButton({
	Name = "FightOn",
	Position = UDim2.fromOffset(24, 120),
	BackgroundColor3 = COLORS.FightOn,
	Text = "Fight On",
})

local fightOnNote = label({
	Position = UDim2.fromOffset(24, 168),
	Size = UDim2.new(1, -48, 0, 18),
	TextSize = 13,
	TextColor3 = COLORS.Muted,
	Text = "",
})

local surrenderButton = actionButton({
	Name = "Surrender",
	Position = UDim2.fromOffset(24, 194),
	BackgroundColor3 = COLORS.Surrender,
	Text = "Surrender",
})

local surrenderNote = label({
	Position = UDim2.fromOffset(24, 242),
	Size = UDim2.new(1, -48, 0, 32),
	TextSize = 13,
	TextColor3 = COLORS.Muted,
	Text = "",
})

screen.Parent = player:WaitForChild("PlayerGui")

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

local busy = false

local function refresh()
	local tokens = player:GetAttribute(ATTR.RevengeTokens) or 0
	local cost = GameConfig.Defeat.FightOnTokenCost
	local affordable = tokens >= cost

	fightOnButton.BackgroundColor3 = if affordable then COLORS.FightOn else COLORS.Disabled
	fightOnButton.Active = affordable

	fightOnNote.Text = if affordable
		then `Spends {cost} revenge token — you hold {tokens}. Your stores are untouched.`
		else `You have no revenge tokens. Buy more in the Store, or surrender.`

	-- The percentage comes from config, so this cannot drift from what the
	-- server actually takes.
	local percent = math.floor(GameConfig.Defeat.SurrenderLoss * 100 + 0.5)
	surrenderNote.Text =
		`The raiders carry off {percent}% of your Food, Wood, Gold and Stone. Your purse is safe.`
end

local function send(choice: string)
	if busy then
		return
	end

	busy = true
	local ok, result = pcall(function()
		return Remotes.GetFunction(GameConfig.RemoteNames.ResolveDefeat):InvokeServer(choice)
	end)
	busy = false

	if not ok or type(result) ~= "table" then
		fightOnNote.Text = "The request failed. Try again."
		return
	end

	if not result.Ok then
		--[[
			The panel stays up. A refused answer must not look like it
			worked - "you have no tokens left" is exactly the case where a
			player needs to be able to pick the other option instead.
		]]
		if result.Reason == "NoTokens" then
			refresh()
		else
			fightOnNote.Text = tostring(result.Reason)
		end
		return
	end

	-- The server clears the Defeated attribute, which hides the panel.
end

fightOnButton.MouseButton1Click:Connect(function()
	if fightOnButton.Active then
		send("FightOn")
	end
end)

surrenderButton.MouseButton1Click:Connect(function()
	send("Surrender")
end)

local function syncVisibility()
	local defeated = player:GetAttribute(ATTR.Defeated) == true

	if defeated then
		refresh()
	end

	screen.Enabled = defeated
end

player:GetAttributeChangedSignal(ATTR.Defeated):Connect(syncVisibility)
player:GetAttributeChangedSignal(ATTR.RevengeTokens):Connect(function()
	if screen.Enabled then
		refresh()
	end
end)

-- The attribute may already be set: this client might be rejoining into a
-- defeat it never saw begin.
syncVisibility()
