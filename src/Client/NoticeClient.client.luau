--[[
	NoticeClient
	------------
	Short messages from the server, stacked in the corner and fading out.

	WHY THIS EXISTS
	---------------
	Because a refusal with no explanation is indistinguishable from a broken
	button. The rebuild prompt on a ruined Checkpoint was turning players down
	for want of resources and saying nothing at all - so it read as the prompt
	not working, and the actual problem (a rebuild priced at five times the
	build cost) stayed hidden behind it.

	Every other number in this game is derived from replicated state and needs
	no traffic. A refusal is not state: it is a thing that just happened to one
	player, and it has to be told to them.

	THE SERVER DECIDES WHAT TO SAY. This script only decides where to put it.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local GameConfig = require(Shared.GameConfig)
local Remotes = require(Shared.Remotes)

local EXPECTED_FRAMEWORK = 15

if GameConfig.FrameworkVersion ~= EXPECTED_FRAMEWORK then
	warn(
		`[NoticeClient] ReplicatedStorage.Shared is framework v{tostring(GameConfig.FrameworkVersion)} but this `
			.. `script expects v{EXPECTED_FRAMEWORK}. Re-sync Rojo. Notices disabled.`
	)
	return
end

local acquired, noticeRemote = pcall(function()
	return Remotes.GetEvent(GameConfig.RemoteNames.Notice)
end)

if not acquired then
	warn("[NoticeClient] The notice remote never replicated, so the server did not finish starting.")
	return
end

local player = Players.LocalPlayer

local COLORS = {
	Panel = Color3.fromRGB(38, 41, 52),
	Text = Color3.fromRGB(236, 238, 245),
}

--- How long a notice stays up before fading.
local LIFETIME = 5

--[[
	A cap, and the oldest goes first.

	Several systems can refuse at once - a raid can shatter an anchor while a
	harvest fails - and an unbounded stack would walk up the screen and cover
	the game.
]]
local MAX_NOTICES = 4

local screen = Instance.new("ScreenGui")
screen.Name = "NoticeGui"
screen.ResetOnSpawn = false
screen.IgnoreGuiInset = true
screen.DisplayOrder = 8

local column = Instance.new("Frame")
column.Name = "Notices"
column.AnchorPoint = Vector2.new(0.5, 1)
column.Position = UDim2.new(0.5, 0, 1, -70)
column.Size = UDim2.fromOffset(460, 160)
column.BackgroundTransparency = 1
column.Parent = screen

local layout = Instance.new("UIListLayout")
layout.FillDirection = Enum.FillDirection.Vertical
layout.VerticalAlignment = Enum.VerticalAlignment.Bottom
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
layout.Padding = UDim.new(0, 6)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = column

screen.Parent = player:WaitForChild("PlayerGui")

local order = 0
local live = {}

local function show(message: string)
	order += 1

	local frame = Instance.new("Frame")
	frame.Name = "Notice"
	frame.Size = UDim2.fromOffset(440, 34)
	frame.BackgroundColor3 = COLORS.Panel
	frame.BackgroundTransparency = 0.1
	frame.BorderSizePixel = 0
	frame.LayoutOrder = order
	frame.Parent = column

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = frame

	local text = Instance.new("TextLabel")
	text.Size = UDim2.new(1, -20, 1, 0)
	text.Position = UDim2.fromOffset(10, 0)
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.Gotham
	text.TextSize = 14
	text.TextColor3 = COLORS.Text
	text.TextXAlignment = Enum.TextXAlignment.Left
	text.TextWrapped = true
	text.Text = message
	text.Parent = frame

	table.insert(live, frame)

	-- Oldest out first, so the newest message is always the one on screen.
	while #live > MAX_NOTICES do
		local oldest = table.remove(live, 1)

		if oldest then
			oldest:Destroy()
		end
	end

	task.delay(LIFETIME, function()
		local index = table.find(live, frame)

		if index then
			table.remove(live, index)
		end

		frame:Destroy()
	end)
end

noticeRemote.OnClientEvent:Connect(function(message: unknown)
	-- Server-sent, so not trusted further than "text to draw". A bad type is
	-- dropped rather than coerced: this is cosmetic, and an error in it would
	-- be worse than a missing message.
	if type(message) ~= "string" or message == "" then
		return
	end

	show(if #message > 160 then string.sub(message, 1, 160) else message)
end)
