--!nonstrict
--[[
	ProfileStore
	------------
	A self-contained, ProfileService-style persistence layer.

	What it guarantees:

	* SESSION LOCKING - a profile is owned by exactly one server at a time. A
	  second server attempting to load the same key waits, and only force-steals
	  the lock once the owner has stopped refreshing it (dead-server recovery).
	  This is what prevents the classic duplication exploit where a player
	  rejoins fast enough to be live on two servers at once.

	* NO BLIND OVERWRITES - every write is an UpdateAsync transform that first
	  re-checks the lock. If this server lost ownership, the write is cancelled
	  rather than clobbering the newer session's data.

	* MIRRORED BACKUP - each profile is periodically copied to a second
	  DataStore. If the primary key becomes unreadable, the backup is used to
	  rebuild the profile instead of handing the player a fresh save file.

	* AUTO-SAVE + SHUTDOWN FLUSH - a single task loop saves due profiles, and
	  BindToClose releases everything before the server dies.

	* STUDIO FALLBACK - with API access disabled, an in-memory store is used so
	  the game stays playable without touching live data.

	This module knows nothing about players or gameplay. PlayerDataService owns
	that mapping.
]]

local DataStoreService = game:GetService("DataStoreService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Signal = require(Shared.Signal)
local TableUtil = require(Shared.TableUtil)

--------------------------------------------------------------------------------
-- Tuning
--------------------------------------------------------------------------------

local DEFAULTS = {
	AutoSaveInterval = 60, -- Seconds between saves of an active profile
	LockRefreshGrace = 10, -- Lock is refreshed on every save; expiry must exceed interval
	SessionLockExpire = 120, -- Seconds of silence before a lock is considered dead
	BackupInterval = 300, -- Seconds between mirror writes
	LoadRetryDelay = 4, -- Seconds between lock-contention retries
	RequestRetries = 4, -- Transient DataStore error retries per call
	AllowBackupRecovery = true,
}

local SAVE_SWEEP_INTERVAL = 5

-- JobId is an empty string in Studio; synthesise a stable id so lock comparison
-- logic behaves identically in both environments.
local JOB_ID = if game.JobId ~= "" then game.JobId else `studio-{HttpService:GenerateGUID(false)}`

--------------------------------------------------------------------------------
-- Low level helpers
--------------------------------------------------------------------------------

--- Retries a DataStore call with exponential backoff.
--- Returns (true, result) or (false, errorMessage).
local function request(label: string, callback: () -> any, retries: number): (boolean, any)
	local attempt = 0

	while true do
		attempt += 1

		local ok, result = pcall(callback)
		if ok then
			return true, result
		end

		if attempt > retries then
			warn(`[ProfileStore] {label} failed after {attempt} attempts: {result}`)
			return false, result
		end

		-- 1s, 2s, 4s, 8s ... gives throttled requests room to recover.
		task.wait(2 ^ (attempt - 1))
	end
end

--- Yields until there is request budget available, so bursts of joins/leaves
--- degrade into slower saves instead of hard throttle errors.
local function awaitBudget(requestType: Enum.DataStoreRequestType)
	local waited = 0

	while DataStoreService:GetRequestBudgetForRequestType(requestType) < 1 and waited < 30 do
		waited += task.wait(1)
	end
end

--------------------------------------------------------------------------------
-- MockStore: in-memory stand-in used when DataStores are unavailable
--------------------------------------------------------------------------------

local MockStore = {}
MockStore.__index = MockStore

function MockStore.new()
	return setmetatable({ _values = {} }, MockStore)
end

function MockStore:GetAsync(key: string)
	return TableUtil.DeepCopy(self._values[key])
end

function MockStore:SetAsync(key: string, value: any)
	self._values[key] = TableUtil.DeepCopy(value)
end

function MockStore:UpdateAsync(key: string, transform: (any) -> any)
	local current = TableUtil.DeepCopy(self._values[key])
	local updated = transform(current)

	if updated == nil then
		return nil -- Matches live behaviour: returning nil cancels the write.
	end

	self._values[key] = TableUtil.DeepCopy(updated)
	return TableUtil.DeepCopy(updated)
end

--- Probes whether real DataStores are reachable. In Studio with "Enable Studio
--- Access to API Services" switched off, this throws and we fall back to mocks.
local function areDataStoresAvailable(): boolean
	local ok = pcall(function()
		DataStoreService:GetDataStore("__ProfileStoreProbe"):GetAsync("probe")
	end)

	if not ok then
		warn("[ProfileStore] DataStores unavailable - running with in-memory mock store. Progress will NOT persist.")
	end

	return ok
end

--------------------------------------------------------------------------------
-- Record helpers
--------------------------------------------------------------------------------

type Record = {
	Data: { [string]: any },
	MetaData: { [string]: any },
}

--- Guarantees a usable record shape, creating a fresh one when the key is empty
--- or the stored value is unrecognisable.
local function normalizeRecord(record: any, template: { [string]: any }): (Record, boolean)
	if type(record) ~= "table" or type(record.Data) ~= "table" then
		return {
			Data = TableUtil.DeepCopy(template),
			MetaData = {
				CreatedAt = os.time(),
				LastUpdate = os.time(),
				SaveCount = 0,
			},
		},
			true -- isNew
	end

	if type(record.MetaData) ~= "table" then
		record.MetaData = {
			CreatedAt = os.time(),
			LastUpdate = os.time(),
			SaveCount = 0,
		}
	end

	return record, false
end

local function makeLock()
	return {
		JobId = JOB_ID,
		PlaceId = game.PlaceId,
		Timestamp = os.time(),
	}
end

--- True when `lock` belongs to another server that is still refreshing it.
local function isLockedByOther(lock: any, expireSeconds: number): boolean
	if type(lock) ~= "table" or lock.JobId == JOB_ID then
		return false
	end

	local age = os.time() - (tonumber(lock.Timestamp) or 0)
	return age < expireSeconds
end

--------------------------------------------------------------------------------
-- Profile
--------------------------------------------------------------------------------

local Profile = {}
Profile.__index = Profile

function Profile._new(store, key: string, record: Record, userIds: { number }?)
	local self = setmetatable({
		Key = key,
		Data = record.Data,
		MetaData = record.MetaData,
		UserIds = userIds or {},

		--- Fires when the profile stops being writable, either because we
		--- released it normally or because another server stole the lock.
		--- Signature: (reason: "Released" | "LockLost")
		Released = Signal.new(),

		_store = store,
		_active = true,
		_saving = false,
		_nextSave = os.clock() + store._options.AutoSaveInterval,
		_nextBackup = os.clock() + store._options.BackupInterval,
	}, Profile)

	return self
end

--- A profile stops being active once released or stolen. Gameplay systems must
--- check this before mutating Data, otherwise the mutation is silently lost.
function Profile:IsActive(): boolean
	return self._active
end

--- Writes the current Data to the primary store and refreshes the session lock.
--- Blocking. Returns true on success.
function Profile:Save(): boolean
	return self._store:_commit(self, false)
end

--- Final save, then hands ownership back so another server can load the key.
function Profile:Release()
	if not self._active then
		return
	end

	self._store:_commit(self, true)
	self._store:_deactivate(self, "Released")
end

function Profile:__tostring()
	return `Profile({self.Key})`
end

--------------------------------------------------------------------------------
-- ProfileStore
--------------------------------------------------------------------------------

local ProfileStore = {}
ProfileStore.__index = ProfileStore

export type Profile = typeof(Profile._new(nil :: any, "", nil :: any, nil))

--[[
	Creates a store.

	storeName  - base DataStore name. The mirror uses storeName .. "_Backup".
	template   - default data for brand new profiles (deep copied per profile).
	normalizer - optional (data) -> data run on every load, after migrations.
	options    - overrides for DEFAULTS.
]]
function ProfileStore.new(storeName: string, template: { [string]: any }, normalizer: ((any) -> any)?, options: { [string]: any }?)
	assert(RunService:IsServer(), "ProfileStore is server-only")
	assert(type(storeName) == "string" and storeName ~= "", "storeName must be a non-empty string")
	assert(type(template) == "table", "template must be a table")

	local resolved = TableUtil.DeepCopy(DEFAULTS)
	for key, value in options or {} do
		resolved[key] = value
	end

	-- The lock must outlive the worst-case gap between refreshes, or a healthy
	-- server would look dead to its peers and have its profiles taken over.
	-- Worst case is one auto-save interval plus one sweep period.
	local minimumExpire = resolved.AutoSaveInterval + SAVE_SWEEP_INTERVAL + resolved.LockRefreshGrace
	if resolved.SessionLockExpire < minimumExpire then
		resolved.SessionLockExpire = minimumExpire
	end

	local useMocks = not areDataStoresAvailable()

	local self = setmetatable({
		Name = storeName,
		IsMock = useMocks,

		_template = template,
		_normalizer = normalizer,
		_options = resolved,
		_activeProfiles = {},
		_loading = {},
		_closing = false,

		_primary = if useMocks then MockStore.new() else DataStoreService:GetDataStore(storeName),
		_backup = if useMocks then MockStore.new() else DataStoreService:GetDataStore(`{storeName}_Backup`),
	}, ProfileStore)

	self:_startAutoSave()
	self:_bindToClose()

	return self
end

--------------------------------------------------------------------------------
-- Loading
--------------------------------------------------------------------------------

--[[
	Loads and locks a profile.

	Returns (profile, nil) on success, or (nil, reason) where reason is one of:
		"AlreadyActive"    - this server already holds the key
		"SessionLocked"    - another server is alive and actively refreshing the
		                     lock; it was NOT stolen
		"DataStoreFailure" - primary unreadable and no usable backup existed

	A lock is never force-stolen from a living server. Because every save
	refreshes the lock timestamp, a crashed server simply stops refreshing and
	its lock ages out after SessionLockExpire, at which point the normal path
	takes ownership. Waiting is bounded: once the retry deadline passes we give
	up with "SessionLocked" rather than risk two servers writing one profile.

	On DataStoreFailure the caller MUST NOT substitute default data: doing so is
	exactly how a transient outage turns into a permanent wipe. Kick instead.
]]
function ProfileStore:LoadProfileAsync(key: string, userIds: { number }?): (Profile?, string?)
	assert(type(key) == "string" and key ~= "", "key must be a non-empty string")

	if self._activeProfiles[key] or self._loading[key] then
		return nil, "AlreadyActive"
	end

	self._loading[key] = true

	local options = self._options
	local profile, failureReason = nil, nil

	-- Wait at most one full expiry window plus a little slack: long enough for
	-- a dead owner's lock to age out, short enough to fail fast against a live
	-- one.
	local deadline = os.clock() + options.SessionLockExpire + options.LoadRetryDelay * 2

	while true do
		local blockedByLock = false

		awaitBudget(Enum.DataStoreRequestType.UpdateAsync)

		local ok, record = request(`LoadProfile({key})`, function()
			return self._primary:UpdateAsync(key, function(current)
				local normalized, isNew = normalizeRecord(current, self._template)
				local existingLock = normalized.MetaData.SessionLock

				if isLockedByOther(existingLock, options.SessionLockExpire) then
					blockedByLock = true
					return nil -- Cancel: leave the other server's data untouched.
				end

				if type(existingLock) == "table" and existingLock.JobId ~= JOB_ID then
					warn(
						`[ProfileStore] Claiming expired session lock for {key} (previous owner {existingLock.JobId} stopped responding)`
					)
				end

				normalized.MetaData.SessionLock = makeLock()
				normalized.MetaData.LastUpdate = os.time()

				if isNew then
					normalized.MetaData.IsNewProfile = true
				end

				if self._normalizer then
					normalized.Data = self._normalizer(normalized.Data)
				end

				return normalized, userIds
			end)
		end, options.RequestRetries)

		if ok and type(record) == "table" then
			profile = Profile._new(self, key, record, userIds)
			break
		end

		if blockedByLock then
			-- Another server is live on this key. Wait for it to release, or for
			-- its lock to age out if it has crashed.
			if os.clock() >= deadline then
				failureReason = "SessionLocked"
				break
			end

			task.wait(options.LoadRetryDelay)
			continue
		end

		-- Hard failure: the primary key could not be read or written.
		failureReason = "DataStoreFailure"
		break
	end

	if not profile and failureReason == "DataStoreFailure" and self._options.AllowBackupRecovery then
		profile = self:_loadFromBackup(key, userIds)
	end

	self._loading[key] = nil

	if not profile then
		return nil, failureReason or "SessionLocked"
	end

	self._activeProfiles[key] = profile
	return profile, nil
end

--- Rebuilds a profile from the mirror store when the primary is unreadable.
--- The result is flagged so the next save re-seeds the primary, and so callers
--- can surface "your save was restored from a backup" messaging.
function ProfileStore:_loadFromBackup(key: string, userIds: { number }?): Profile?
	local ok, value = request(`LoadBackup({key})`, function()
		return self._backup:GetAsync(key)
	end, 2)

	if not ok or type(value) ~= "table" or type(value.Data) ~= "table" then
		return nil
	end

	warn(`[ProfileStore] Primary store unreadable for {key}; recovered from backup written at {value.MetaData and value.MetaData.LastUpdate or "unknown"}`)

	local record = {
		Data = value.Data,
		MetaData = if type(value.MetaData) == "table" then value.MetaData else {},
	}

	record.MetaData.RecoveredFromBackup = true
	record.MetaData.SessionLock = makeLock()

	if self._normalizer then
		record.Data = self._normalizer(record.Data)
	end

	local profile = Profile._new(self, key, record, userIds)
	profile.IsRecovered = true

	return profile
end

--------------------------------------------------------------------------------
-- Saving
--------------------------------------------------------------------------------

--- Core write path. Every save re-validates the session lock inside the
--- transform, so a stolen key can never be overwritten by the stale server.
function ProfileStore:_commit(profile, releaseSession: boolean): boolean
	if not profile._active then
		return false
	end

	if profile._saving then
		-- Another save for this profile is already in flight; skipping keeps us
		-- from queueing redundant writes against the same key.
		return false
	end

	profile._saving = true

	-- Snapshot before yielding so the written data is internally consistent
	-- even if gameplay mutates Data mid-save.
	local snapshot = TableUtil.DeepCopy(profile.Data)
	local lockLost = false

	awaitBudget(Enum.DataStoreRequestType.UpdateAsync)

	local ok, record = request(`SaveProfile({profile.Key})`, function()
		return self._primary:UpdateAsync(profile.Key, function(current)
			local normalized = normalizeRecord(current, self._template)
			local lock = normalized.MetaData.SessionLock

			-- Recovered profiles intentionally bypass this check: the primary
			-- lock state is unknown/unreadable, which is why we are here.
			if not profile.IsRecovered and type(lock) == "table" and lock.JobId ~= JOB_ID then
				if isLockedByOther(lock, self._options.SessionLockExpire) then
					lockLost = true
					return nil -- Cancel: the newer session owns this data now.
				end
			end

			normalized.Data = snapshot
			normalized.MetaData.LastUpdate = os.time()
			normalized.MetaData.SaveCount = (tonumber(normalized.MetaData.SaveCount) or 0) + 1
			normalized.MetaData.IsNewProfile = nil
			normalized.MetaData.SessionLock = if releaseSession then nil else makeLock()

			return normalized, profile.UserIds
		end)
	end, self._options.RequestRetries)

	profile._saving = false
	profile._nextSave = os.clock() + self._options.AutoSaveInterval

	if lockLost then
		warn(`[ProfileStore] Session lock lost for {profile.Key}; discarding this server's unsaved changes`)
		self:_deactivate(profile, "LockLost")
		return false
	end

	if not ok or type(record) ~= "table" then
		return false
	end

	-- A successful primary write clears the recovery flag: the primary is
	-- authoritative again from this point on.
	profile.IsRecovered = false

	if releaseSession or os.clock() >= profile._nextBackup then
		profile._nextBackup = os.clock() + self._options.BackupInterval
		self:_writeBackup(profile.Key, record, profile.UserIds)
	end

	return true
end

--- Mirror write. Fire-and-forget: a failed backup must never block gameplay or
--- fail a successful primary save.
function ProfileStore:_writeBackup(key: string, record: Record, userIds: { number }?)
	task.spawn(function()
		awaitBudget(Enum.DataStoreRequestType.SetIncrementAsync)

		request(`WriteBackup({key})`, function()
			self._backup:SetAsync(key, {
				Data = record.Data,
				MetaData = {
					CreatedAt = record.MetaData.CreatedAt,
					LastUpdate = record.MetaData.LastUpdate,
					SaveCount = record.MetaData.SaveCount,
				},
				BackedUpAt = os.time(),
			}, userIds)
		end, 2)
	end)
end

function ProfileStore:_deactivate(profile, reason: string)
	if not profile._active then
		return
	end

	profile._active = false
	self._activeProfiles[profile.Key] = nil
	profile.Released:Fire(reason)
end

--------------------------------------------------------------------------------
-- Auto-save and shutdown
--------------------------------------------------------------------------------

function ProfileStore:_startAutoSave()
	task.spawn(function()
		while not self._closing do
			task.wait(SAVE_SWEEP_INTERVAL)

			local now = os.clock()

			for _, profile in self:GetActiveProfiles() do
				if profile._active and not profile._saving and now >= profile._nextSave then
					-- Each save gets its own thread so one slow key cannot
					-- delay every other player's save.
					task.spawn(function()
						self:_commit(profile, false)
					end)
				end
			end
		end
	end)
end

function ProfileStore:_bindToClose()
	game:BindToClose(function()
		self._closing = true

		local profiles = self:GetActiveProfiles()
		if #profiles == 0 then
			return
		end

		local remaining = #profiles

		for _, profile in profiles do
			task.spawn(function()
				profile:Release()
				remaining -= 1
			end)
		end

		-- Roblox grants roughly 30s during shutdown. Wait for the flush, but
		-- never past that budget.
		local deadline = os.clock() + 25
		while remaining > 0 and os.clock() < deadline do
			task.wait(0.1)
		end
	end)
end

--------------------------------------------------------------------------------
-- Utilities
--------------------------------------------------------------------------------

function ProfileStore:GetActiveProfiles(): { Profile }
	local profiles = {}

	for _, profile in self._activeProfiles do
		table.insert(profiles, profile)
	end

	return profiles
end

function ProfileStore:GetProfile(key: string): Profile?
	return self._activeProfiles[key]
end

--[[
	Lists historical versions of a key from the primary store, newest first.
	DataStore versioning retains 30 days of writes, which makes this the
	strongest recovery tool available for "please restore my save" tickets.
	Admin/manual use only; it is not part of the normal load path.
]]
function ProfileStore:ListVersionsAsync(key: string, limit: number?): { { Version: string, CreatedTime: number } }
	if self.IsMock then
		return {}
	end

	local results = {}

	local ok, pages = request(`ListVersions({key})`, function()
		return self._primary:ListVersionsAsync(key, Enum.SortDirection.Descending)
	end, 2)

	if not ok or not pages then
		return results
	end

	while true do
		for _, item in pages:GetCurrentPage() do
			table.insert(results, { Version = item.Version, CreatedTime = item.CreatedTime })

			if limit and #results >= limit then
				return results
			end
		end

		if pages.IsFinished then
			break
		end

		pages:AdvanceToNextPageAsync()
	end

	return results
end

--- Reads a specific historical version without mutating live data. Pair with
--- ListVersionsAsync to inspect before restoring.
function ProfileStore:GetVersionAsync(key: string, version: string): { [string]: any }?
	if self.IsMock then
		return nil
	end

	local ok, value = request(`GetVersion({key})`, function()
		return self._primary:GetVersionAsync(key, version)
	end, 2)

	if ok and type(value) == "table" then
		return value.Data
	end

	return nil
end

return ProfileStore
