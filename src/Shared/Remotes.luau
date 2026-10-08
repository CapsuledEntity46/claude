--!nonstrict
--[[
	Remotes
	-------
	Lazily creates (server) or waits for (client) the shared remote instances,
	so neither side needs to know where they live in the tree.

	Keep this list small on purpose. Every remote is an attack surface: state
	flows to clients through replicated attributes, and remotes exist only for
	genuine client *intent* that the server then validates.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local FOLDER_NAME = "Remotes"
local WAIT_TIMEOUT = 30

local Remotes = {}

local function getFolder(): Instance
	if RunService:IsServer() then
		local existing = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
		if existing then
			return existing
		end

		local folder = Instance.new("Folder")
		folder.Name = FOLDER_NAME
		folder.Parent = ReplicatedStorage

		return folder
	end

	local folder = ReplicatedStorage:WaitForChild(FOLDER_NAME, WAIT_TIMEOUT)
	assert(folder, `Remotes folder never replicated (waited {WAIT_TIMEOUT}s)`)

	return folder
end

--- Returns the named RemoteEvent, creating it on the server and waiting for it
--- on the client.
function Remotes.GetEvent(name: string): RemoteEvent
	assert(type(name) == "string" and name ~= "", "remote name must be a non-empty string")

	local folder = getFolder()
	local existing = folder:FindFirstChild(name)

	if existing then
		return existing
	end

	if RunService:IsServer() then
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = folder

		return remote
	end

	local remote = folder:WaitForChild(name, WAIT_TIMEOUT)
	assert(remote, `RemoteEvent {name} never replicated (waited {WAIT_TIMEOUT}s)`)

	return remote
end

--[[
	Returns the named RemoteFunction, creating it on the server and waiting for
	it on the client.

	RemoteFunctions are used for shop transactions because the client genuinely
	needs a result to render ("not enough cash" vs "stack full"), and a
	request/response pair is clearer than two one-way events the caller has to
	correlate.

	Server rule for every OnServerInvoke in this project: validate, act, return
	promptly, and never let an error escape. An erroring invoke surfaces on the
	client as a thrown error and tells an attacker they found an unhandled path,
	so handlers wrap their work and return a failure result instead.
]]
function Remotes.GetFunction(name: string): RemoteFunction
	assert(type(name) == "string" and name ~= "", "remote name must be a non-empty string")

	local folder = getFolder()
	local existing = folder:FindFirstChild(name)

	if existing then
		return existing
	end

	if RunService:IsServer() then
		local remote = Instance.new("RemoteFunction")
		remote.Name = name
		remote.Parent = folder

		return remote
	end

	local remote = folder:WaitForChild(name, WAIT_TIMEOUT)
	assert(remote, `RemoteFunction {name} never replicated (waited {WAIT_TIMEOUT}s)`)

	return remote
end

return Remotes
