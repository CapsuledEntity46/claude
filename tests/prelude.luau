--[[
	Headless Roblox API stubs.

	Lets the real server modules run under the plain Luau CLI so the logic can
	be exercised without opening Studio. Nothing here ships with the game.
]]

--------------------------------------------------------------------------------
-- Assertions / reporting
--------------------------------------------------------------------------------

FAILURES = {}
PASSES = 0

function check(condition, label)
	if condition then
		PASSES += 1
	else
		table.insert(FAILURES, label)
		print(`  [FAIL] {label}`)
	end
end

function checkEqual(actual, expected, label)
	if actual == expected then
		PASSES += 1
	else
		table.insert(FAILURES, label)
		print(`  [FAIL] {label} (expected {tostring(expected)}, got {tostring(actual)})`)
	end
end

local function deepCopy(value)
	if type(value) ~= "table" then
		return value
	end

	local copy = {}
	for k, v in value do
		copy[k] = deepCopy(v)
	end
	return copy
end

--------------------------------------------------------------------------------
-- Virtual clock + cooperative scheduler (stands in for the task library)
--------------------------------------------------------------------------------

local VirtualTime = 0
local parked = {}

-- Luau's sandbox freezes library tables, so replace the global rather than
-- mutating os itself.
local realOs = os

os = {
	clock = function()
		return VirtualTime
	end,
	time = function()
		return 1_700_000_000 + math.floor(VirtualTime)
	end,
	date = realOs.date,
	difftime = realOs.difftime,
}

--[[
	Seconds since the game started, high resolution and monotonic.

	Distinct from os.time() on purpose: see AttackService for which clock a
	timestamp belongs in.
]]
function time()
	return VirtualTime
end

assert(os.clock() == 0, "virtual clock override failed")
assert(time() == 0, "time() override failed")

task = {}

function task.spawn(fn, ...)
	local co = if type(fn) == "thread" then fn else coroutine.create(fn)
	local ok, err = coroutine.resume(co, ...)

	if not ok then
		table.insert(FAILURES, `unhandled thread error: {err}`)
		print(`  [FAIL] unhandled thread error: {err}`)
	end

	return co
end

task.defer = task.spawn

function task.wait(duration)
	duration = tonumber(duration) or 0
	table.insert(parked, { thread = coroutine.running(), at = VirtualTime + duration })
	coroutine.yield()
	return duration
end

function task.delay(duration, fn, ...)
	local args = table.pack(...)
	return task.spawn(function()
		task.wait(duration)
		fn(table.unpack(args, 1, args.n))
	end)
end

--- Fast-forwards the virtual clock, resuming parked threads in time order.
function advance(seconds)
	local target = VirtualTime + seconds

	while true do
		table.sort(parked, function(a, b)
			return a.at < b.at
		end)

		local next = parked[1]
		if not next or next.at > target then
			break
		end

		table.remove(parked, 1)
		VirtualTime = math.max(VirtualTime, next.at)

		local ok, err = coroutine.resume(next.thread)
		if not ok then
			table.insert(FAILURES, `unhandled thread error: {err}`)
			print(`  [FAIL] unhandled thread error: {err}`)
		end
	end

	VirtualTime = target
end

function warn(...)
	local parts = {}
	for i = 1, select("#", ...) do
		table.insert(parts, tostring(select(i, ...)))
	end
	WARNINGS = WARNINGS or {}
	table.insert(WARNINGS, table.concat(parts, " "))
end

--------------------------------------------------------------------------------
-- Instance stub
--------------------------------------------------------------------------------

local function makeRbxSignal()
	local handlers = {}

	return {
		Connect = function(_, handler)
			table.insert(handlers, handler)
			return {
				Disconnect = function()
					local i = table.find(handlers, handler)
					if i then
						table.remove(handlers, i)
					end
				end,
			}
		end,
		Fire = function(_, ...)
			for _, handler in table.clone(handlers) do
				handler(...)
			end
		end,
	}
end

local InstanceMethods = {}

function InstanceMethods.FindFirstChild(self, name)
	return rawget(self, "_children")[name]
end

--[[
	Genuinely waits, on the virtual clock.

	This used to assert the moment the child was absent, which made it
	impossible to test any code that legitimately waits for a child arriving a
	moment later - and a character's Humanoid and PrimaryPart are exactly
	that. The assert turned a correct wait into a harness failure, which is
	the opposite of what a stub should do.

	It still asserts on TIMEOUT: in the harness a child that never appears is
	a setup mistake, and returning nil silently would hide it.
]]
function InstanceMethods.WaitForChild(self, name, timeout)
	local child = rawget(self, "_children")[name]

	if child then
		return child
	end

	local deadline = VirtualTime + (tonumber(timeout) or 10)

	while VirtualTime < deadline do
		task.wait(0.05)

		child = rawget(self, "_children")[name]

		if child then
			return child
		end
	end

	assert(child, `WaitForChild({name}) never arrived in the harness`)
	return nil
end

function InstanceMethods.FindFirstChildOfClass(self, className)
	for _, child in rawget(self, "_children") do
		if rawget(child, "ClassName") == className then
			return child
		end
	end
	return nil
end

function InstanceMethods.GetChildren(self)
	local list = {}
	for _, child in rawget(self, "_children") do
		table.insert(list, child)
	end
	return list
end

function InstanceMethods.SetAttribute(self, name, value)
	assert(type(name) == "string", "attribute name must be a string")
	-- Mirrors the engine: attribute names are restricted to word characters.
	assert(name:match("^[%a_][%w_]*$"), `invalid attribute name: {name}`)
	rawget(self, "_attributes")[name] = value
	rawget(self, "_attributeChanged"):Fire(name)
end

--[[
	Property change signals, created on demand.

	Only properties the stub routes through __newindex fire these - Health on
	a Humanoid is the one that matters, since a Humanoid emptied without Died
	firing is a real engine behaviour the defeat loop has to survive.
]]
function InstanceMethods.GetPropertyChangedSignal(self, name)
	local signals = rawget(self, "_propertySignals")

	if not signals then
		signals = {}
		rawset(self, "_propertySignals", signals)
	end

	if not signals[name] then
		signals[name] = makeRbxSignal()
	end

	return signals[name]
end

function InstanceMethods.GetAttribute(self, name)
	return rawget(self, "_attributes")[name]
end

function InstanceMethods.GetAttributes(self)
	return deepCopy(rawget(self, "_attributes"))
end

local function detach(self)
	local parent = rawget(self, "_parent")
	if parent then
		rawget(parent, "_children")[rawget(self, "_name")] = nil
	end
	rawset(self, "_parent", nil)
end

--- Crude class test. Enough for the checks the game code makes.
local CLASS_PARENTS = {
	Part = { "BasePart", "Instance" },
	Humanoid = { "Instance" },
	Model = { "PVInstance", "Instance" },
	Player = { "Instance" },
	Folder = { "Instance" },
	IntValue = { "ValueBase", "Instance" },
	ProximityPrompt = { "Instance" },
	RemoteEvent = { "Instance" },
	RemoteFunction = { "Instance" },
}

function InstanceMethods.IsA(self, className)
	local own = rawget(self, "ClassName")

	if own == className then
		return true
	end

	for _, parent in CLASS_PARENTS[own] or {} do
		if parent == className then
			return true
		end
	end

	return false
end

function InstanceMethods.Kick(self, message)
	rawset(self, "_kickReason", message)
	detach(self)
end

function InstanceMethods.Destroy(self)
	rawset(self, "_destroyed", true)
	detach(self)
end

local InstanceMT = {
	__index = function(self, key)
		local method = InstanceMethods[key]
		if method then
			return method
		end

		if key == "Name" then
			return rawget(self, "_name")
		elseif key == "Parent" then
			return rawget(self, "_parent")
		elseif key == "Value" then
			return rawget(self, "_value")
		elseif key == "AttributeChanged" then
			return rawget(self, "_attributeChanged")
		end

		return rawget(self, "_children")[key]
	end,

	__newindex = function(self, key, value)
		if key == "Name" then
			local parent = rawget(self, "_parent")
			if parent then
				parent._children[rawget(self, "_name")] = nil
			end

			rawset(self, "_name", value)

			if parent then
				parent._children[value] = self
			end
		elseif key == "Parent" then
			local old = rawget(self, "_parent")
			if old then
				rawget(old, "_children")[rawget(self, "_name")] = nil
			end

			rawset(self, "_parent", value)

			if value then
				rawget(value, "_children")[rawget(self, "_name")] = self
			end
		elseif key == "Value" then
			rawset(self, "_value", value)
		elseif key == "CFrame" then
			--[[
				The engine derives one from the other. Game code moves parts
				with whichever is natural, and a stub that kept them separate
				would silently report a part still sitting where it started -
				which is the bug this models away.
			]]
			rawset(self, "CFrame", value)
			rawset(self, "Position", Vector3.new(value.X, value.Y, value.Z))
		elseif key == "Position" then
			rawset(self, "Position", value)
			rawset(self, "CFrame", CFrame.new(value.X, value.Y, value.Z))
		else
			rawset(self, key, value)
		end

		local signals = rawget(self, "_propertySignals")
		local signal = if signals then signals[key] else nil

		if signal then
			signal:Fire()
		end
	end,
}

--[[
	The engine reports typeof(someInstance) == "Instance". Game code uses that
	to tell a Player apart from an arbitrary value, so the harness must agree or
	those guards silently take the wrong branch.
]]
--- Forward-declared so the typeof override below can close over it; the
--- metatable itself is populated further down.
local Vector3MT = {}

local realTypeof = typeof

typeof = function(value)
	if type(value) == "table" then
		local meta = getmetatable(value)

		if meta == InstanceMT then
			return "Instance"
		end

		--[[
			Vector3 is a table here and a userdata in the engine. Game code
			validating remote payloads with typeof(v) == "Vector3" has to see
			the same answer, or the harness would exercise the rejection path
			instead of the accepting one.
		]]
		if meta == Vector3MT then
			return "Vector3"
		end
	end

	return realTypeof(value)
end

Instance = {}

function Instance.new(className)
	local self = setmetatable({
		ClassName = className,
		_name = className,
		_value = 0,
		_children = {},
		_attributes = {},
		_attributeChanged = makeRbxSignal(),
		_parent = nil,
	}, InstanceMT)

	-- Class-specific members the game code relies on.
	if className == "Player" then
		-- Respawning is the engine's, so the defeat loop listens for it here.
		rawset(self, "CharacterAdded", makeRbxSignal())
		rawset(self, "CharacterRemoving", makeRbxSignal())
		rawset(self, "AncestryChanged", makeRbxSignal())
	elseif className == "ProximityPrompt" then
		rawset(self, "Triggered", makeRbxSignal())
		rawset(self, "Enabled", true)
		rawset(self, "ActionText", "")
		rawset(self, "ObjectText", "")
	elseif className == "RemoteEvent" then
		rawset(self, "OnServerEvent", makeRbxSignal())
		rawset(self, "OnClientEvent", makeRbxSignal())

		--- Server -> client broadcasts. Recorded so a test can assert a shot
		--- was announced without needing a client.
		rawset(self, "_broadcasts", {})

		rawset(self, "FireAllClients", function(selfRef, ...)
			table.insert(rawget(selfRef, "_broadcasts"), table.pack(...))
		end)

		rawset(self, "FireClient", function(selfRef, _player, ...)
			table.insert(rawget(selfRef, "_broadcasts"), table.pack(...))
		end)
	elseif className == "Part" then
		rawset(self, "Size", Vector3.new(4, 1, 2))
		rawset(self, "Position", Vector3.new(0, 0, 0))
	elseif className == "Humanoid" then
		rawset(self, "Health", 100)
		rawset(self, "MaxHealth", 100)
		rawset(self, "Died", makeRbxSignal())

		--[[
			TakeDamage, as the engine behaves: clamped at zero, and firing
			Died exactly once on the transition. Combat code relies on both -
			a second Died would resolve a defeat twice.
		]]
		rawset(self, "TakeDamage", function(selfRef, amount)
			local current = rawget(selfRef, "Health")

			if current <= 0 then
				return
			end

			local remaining = math.max(current - (tonumber(amount) or 0), 0)
			rawset(selfRef, "Health", remaining)

			local signals = rawget(selfRef, "_propertySignals")
			local healthSignal = if signals then signals.Health else nil

			if healthSignal then
				healthSignal:Fire()
			end

			if remaining <= 0 then
				rawget(selfRef, "Died"):Fire()
			end
		end)
	end

	return self
end

--------------------------------------------------------------------------------
-- DataStore stub (shared backing so two "servers" see the same keys)
--------------------------------------------------------------------------------

DataStoreBackings = {}
DataStoreFaults = { FailUpdate = false, FailGet = false }

--[[
	Real DataStores serialise through JSON, which does NOT round-trip sparse
	integer keys: a table with holes comes back with string keys. Emulating that
	here is what makes the harness able to catch key-type bugs in saved data
	instead of silently passing.
]]
local function isDenseArray(value)
	local count = 0

	for key in value do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 then
			return false
		end
		count += 1
	end

	for index = 1, count do
		if value[index] == nil then
			return false
		end
	end

	return count > 0
end

local function jsonRoundTrip(value)
	if type(value) ~= "table" then
		return value
	end

	if isDenseArray(value) then
		local array = {}
		for index, item in value do
			array[index] = jsonRoundTrip(item)
		end
		return array
	end

	local object = {}
	for key, item in value do
		object[if type(key) == "number" then tostring(key) else key] = jsonRoundTrip(item)
	end

	return object
end

local StubStore = {}
StubStore.__index = StubStore

function StubStore:GetAsync(key)
	if DataStoreFaults.FailGet then
		error("DataStore GetAsync failed (injected)")
	end
	return deepCopy(self._backing[key])
end

function StubStore:SetAsync(key, value)
	self._backing[key] = jsonRoundTrip(value)
end

function StubStore:UpdateAsync(key, transform)
	if DataStoreFaults.FailUpdate and not self._isProbe then
		error("DataStore UpdateAsync failed (injected)")
	end

	local updated = transform(deepCopy(self._backing[key]))
	if updated == nil then
		return nil
	end

	self._backing[key] = jsonRoundTrip(updated)
	return deepCopy(self._backing[key])
end

--------------------------------------------------------------------------------
-- Services
--------------------------------------------------------------------------------

local ReplicatedStorage = Instance.new("ReplicatedStorage")
ReplicatedStorage.Name = "ReplicatedStorage"

local ServerScriptService = Instance.new("ServerScriptService")
ServerScriptService.Name = "ServerScriptService"

PlayersService = Instance.new("Players")
PlayersService.Name = "Players"
PlayersService.PlayerAdded = makeRbxSignal()
PlayersService.PlayerRemoving = makeRbxSignal()
PlayersService.GetPlayers = function(self)
	local list = {}
	for _, child in rawget(self, "_children") do
		if child.ClassName == "Player" then
			table.insert(list, child)
		end
	end
	return list
end

PlayersService.GetPlayerByUserId = function(self, userId)
	for _, player in self:GetPlayers() do
		if rawget(player, "UserId") == userId then
			return player
		end
	end
	return nil
end

-- Engine MarketplaceService. ProcessReceipt is assigned by the game code; the
-- tests call it directly to simulate the engine delivering a receipt.
MarketplaceStub = {
	ProcessReceipt = nil,
	PromptedPurchases = {},
}

function MarketplaceStub:PromptProductPurchase(player, productId)
	table.insert(self.PromptedPurchases, { player = player, productId = productId })
end

WorkspaceService = Instance.new("Workspace")
WorkspaceService.Name = "Workspace"

local Services = {
	ReplicatedStorage = ReplicatedStorage,
	ServerScriptService = ServerScriptService,
	Workspace = WorkspaceService,
	Players = PlayersService,
	MarketplaceService = MarketplaceStub,
	RunService = {
		IsServer = function()
			return true
		end,
		IsStudio = function()
			return false
		end,
	},
	HttpService = {
		GenerateGUID = function()
			return "0000-harness"
		end,
	},
	DataStoreService = {
		GetDataStore = function(_, name)
			DataStoreBackings[name] = DataStoreBackings[name] or {}
			return setmetatable({
				_backing = DataStoreBackings[name],
				_isProbe = name == "__ProfileStoreProbe",
			}, StubStore)
		end,
		GetRequestBudgetForRequestType = function()
			return 500
		end,
	},
}

BoundCloseHandlers = {}

game = {
	JobId = "harness-server-A",
	PlaceId = 987654,

	GetService = function(_, name)
		local service = Services[name]
		assert(service, `harness is missing a stub for service: {name}`)
		return service
	end,

	BindToClose = function(_, handler)
		table.insert(BoundCloseHandlers, handler)
	end,
}

--- Enum members are only ever assigned and compared, so opaque strings suffice.
local function enumSet(...)
	local set = {}
	for _, name in { ... } do
		set[name] = `Enum.{name}`
	end
	return set
end

Enum = {
	DataStoreRequestType = {
		UpdateAsync = "UpdateAsync",
		SetIncrementAsync = "SetIncrementAsync",
		GetAsync = "GetAsync",
	},
	SortDirection = { Descending = "Descending" },
	ProductPurchaseDecision = {
		PurchaseGranted = "PurchaseGranted",
		NotProcessedYet = "NotProcessedYet",
	},
	Material = enumSet("Grass", "Ground", "SmoothPlastic", "Plastic", "Slate", "WoodPlanks"),
	Font = enumSet("Gotham", "GothamBold", "GothamMedium"),
	SurfaceType = enumSet("Smooth", "SmoothNoOutlines", "Studs"),
	PartType = enumSet("Ball", "Block", "Cylinder"),
	KeyCode = enumSet("E", "F", "Q"),
}

--------------------------------------------------------------------------------
-- Datatype stubs
--------------------------------------------------------------------------------

local Color3MT = {}
Color3MT.__index = function(self, key)
	if key == "Lerp" then
		return function(_, other, alpha)
			return Color3.new(
				rawget(self, "R") + (other.R - rawget(self, "R")) * alpha,
				rawget(self, "G") + (other.G - rawget(self, "G")) * alpha,
				rawget(self, "B") + (other.B - rawget(self, "B")) * alpha
			)
		end
	end
	return nil
end

Color3 = {}

function Color3.new(r, g, b)
	return setmetatable({ R = r, G = g, B = b }, Color3MT)
end

function Color3.fromRGB(r, g, b)
	return Color3.new(r / 255, g / 255, b / 255)
end

Vector3MT.__index = function(self, key)
	local x, y, z = rawget(self, "X"), rawget(self, "Y"), rawget(self, "Z")

	if key == "Magnitude" then
		return math.sqrt(x * x + y * y + z * z)
	elseif key == "Unit" then
		local magnitude = math.sqrt(x * x + y * y + z * z)

		if magnitude == 0 then
			return Vector3.new(0, 0, 0)
		end

		return Vector3.new(x / magnitude, y / magnitude, z / magnitude)
	elseif key == "Dot" then
		return function(_, other)
			return x * other.X + y * other.Y + z * other.Z
		end
	end

	return nil
end

Vector3MT.__add = function(a, b)
	return Vector3.new(a.X + b.X, a.Y + b.Y, a.Z + b.Z)
end

Vector3MT.__sub = function(a, b)
	return Vector3.new(a.X - b.X, a.Y - b.Y, a.Z - b.Z)
end

--- Scalar multiply and divide, either way round.
Vector3MT.__mul = function(a, b)
	if type(b) == "number" then
		return Vector3.new(a.X * b, a.Y * b, a.Z * b)
	end

	if type(a) == "number" then
		return Vector3.new(b.X * a, b.Y * a, b.Z * a)
	end

	return Vector3.new(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end

Vector3MT.__div = function(a, b)
	if type(b) == "number" then
		return Vector3.new(a.X / b, a.Y / b, a.Z / b)
	end

	return Vector3.new(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end

Vector3MT.__eq = function(a, b)
	return a.X == b.X and a.Y == b.Y and a.Z == b.Z
end

Vector3MT.__tostring = function(self)
	return `({self.X}, {self.Y}, {self.Z})`
end

UDim = {}

function UDim.new(scale, offset)
	return { Scale = scale or 0, Offset = offset or 0 }
end

UDim2 = {}

function UDim2.new(xScale, xOffset, yScale, yOffset)
	return { X = UDim.new(xScale, xOffset), Y = UDim.new(yScale, yOffset) }
end

function UDim2.fromScale(x, y)
	return UDim2.new(x, 0, y, 0)
end

function UDim2.fromOffset(x, y)
	return UDim2.new(0, x, 0, y)
end

Vector2 = {}

function Vector2.new(x, y)
	return { X = x or 0, Y = y or 0 }
end

CFrame = {}

local CFrameMT = {}

--- Rotation is not modelled: nothing in this project reads it back, and the
--- parts it rotates are decorative.
CFrameMT.__mul = function(a, _b)
	return a
end

CFrameMT.__index = function(self, key)
	if key == "Position" then
		return Vector3.new(rawget(self, "X"), rawget(self, "Y"), rawget(self, "Z"))
	end

	return nil
end

function CFrame.new(x, y, z)
	--- Accepts a Vector3, as the engine does.
	if type(x) == "table" and rawget(x, "X") then
		return setmetatable({ X = x.X, Y = x.Y, Z = x.Z, _cf = true }, CFrameMT)
	end

	return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0, _cf = true }, CFrameMT)
end

function CFrame.lookAt(at, _target)
	return CFrame.new(at)
end

function CFrame.Angles()
	return { _angles = true }
end

setmetatable(CFrame, { __call = function(_, ...) return CFrame.new(...) end })

Vector3 = {}

function Vector3.new(x, y, z)
	return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, Vector3MT)
end

Vector3.zero = Vector3.new(0, 0, 0)
Vector3.one = Vector3.new(1, 1, 1)

--------------------------------------------------------------------------------
-- Module tree + require
--------------------------------------------------------------------------------

local function folder(name, parent)
	local f = Instance.new("Folder")
	f.Name = name
	f.Parent = parent
	return f
end

local function moduleScript(name, path, parent)
	local m = Instance.new("ModuleScript")
	m.Name = name
	m._path = path
	m.Parent = parent
	return m
end

local Shared = folder("Shared", ReplicatedStorage)
moduleScript("GameConfig", "src/Shared/GameConfig.luau", Shared)
moduleScript("Signal", "src/Shared/Signal.luau", Shared)
moduleScript("TableUtil", "src/Shared/TableUtil.luau", Shared)
moduleScript("Types", "src/Shared/Types.luau", Shared)
moduleScript("Growth", "src/Shared/Growth.luau", Shared)
moduleScript("Remotes", "src/Shared/Remotes.luau", Shared)
moduleScript("RateLimiter", "src/Shared/RateLimiter.luau", Shared)
BuildabilityModule = moduleScript("Buildability", "src/Shared/Buildability.luau", Shared)
SpatialModule = moduleScript("Spatial", "src/Shared/Spatial.luau", Shared)
moduleScript("Combat", "src/Shared/Combat.luau", Shared)
moduleScript("StatusEffects", "src/Shared/StatusEffects.luau", Shared)

local Server = folder("Server", ServerScriptService)
local DataFolder = folder("Data", Server)
local ServicesFolder = folder("Services", Server)
local WorldFolder = folder("World", Server)
local CombatFolder = folder("Combat", Server)
local PlotsFolder = folder("Plots", Server)

FrameworkGuardModule = moduleScript("FrameworkGuard", "src/Server/FrameworkGuard.luau", Server)
moduleScript("DataSchema", "src/Server/Data/DataSchema.luau", DataFolder)
moduleScript("ProfileStore", "src/Server/Data/ProfileStore.luau", DataFolder)
CropFactoryModule = moduleScript("CropFactory", "src/Server/Plots/CropFactory.luau", PlotsFolder)
PlayerDataServiceModule = moduleScript("PlayerDataService", "src/Server/Services/PlayerDataService.luau", ServicesFolder)
FarmServiceModule = moduleScript("FarmService", "src/Server/Services/FarmService.luau", ServicesFolder)
MarketplaceServiceModule =
	moduleScript("MarketplaceService", "src/Server/Services/MarketplaceService.luau", ServicesFolder)
ShopServiceModule = moduleScript("ShopService", "src/Server/Services/ShopService.luau", ServicesFolder)
ShopBuilderModule = moduleScript("ShopBuilder", "src/Server/World/ShopBuilder.luau", WorldFolder)
moduleScript("StructureBuilder", "src/Server/World/StructureBuilder.luau", WorldFolder)
TrainingGroundModule = moduleScript("TrainingGround", "src/Server/World/TrainingGround.luau", WorldFolder)
PlacementServiceModule = moduleScript("PlacementService", "src/Server/World/PlacementService.luau", WorldFolder)
DamageableServiceModule =
	moduleScript("DamageableService", "src/Server/Combat/DamageableService.luau", CombatFolder)
StatusEffectServiceModule =
	moduleScript("StatusEffectService", "src/Server/Combat/StatusEffectService.luau", CombatFolder)
AttackServiceModule = moduleScript("AttackService", "src/Server/Combat/AttackService.luau", CombatFolder)
RaidServiceModule = moduleScript("RaidService", "src/Server/Combat/RaidService.luau", CombatFolder)
DefeatServiceModule = moduleScript("DefeatService", "src/Server/Combat/DefeatService.luau", CombatFolder)

local moduleCache = {}

--- Replaces the CLI require: resolves a ModuleScript stub to its embedded
--- source function (MODULES is emitted by build_and_run.py).
function require(target)
	local cached = moduleCache[target]
	if cached then
		return cached.value
	end

	local path = rawget(target, "_path")
	assert(path, `require() called on a non-module: {tostring(target and target.Name)}`)

	local loader = MODULES[path]
	assert(loader, `no embedded source for {path}`)

	local value = loader(target)
	moduleCache[target] = { value = value }

	return value
end

--- Drops cached modules so a module can be re-initialised as a "second
--- server" with a different JobId.
function resetModuleCache()
	moduleCache = {}
end
