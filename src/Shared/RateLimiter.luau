--!nonstrict
--[[
	RateLimiter
	-----------
	Token-bucket throttle, keyed by anything (usually a Player).

	Chosen over a fixed cooldown because shop traffic is bursty by nature: a
	player clicking "buy" five times in a row is normal, a client sending five
	hundred requests a second is not. A bucket allows the former and still caps
	sustained throughput.

	Each key starts with `burst` tokens and refills at `ratePerSecond`. A
	request costs one token (or more, for expensive operations).

	Usage:
		local limiter = RateLimiter.new(8, 12)   -- 8/sec sustained, 12 burst
		if not limiter:Consume(player) then
			return -- throttled
		end

	Always call Forget() when a key goes away (player leaving), otherwise the
	bucket table keeps the key alive and grows for the life of the server.
]]

local RateLimiter = {}
RateLimiter.__index = RateLimiter

function RateLimiter.new(ratePerSecond: number, burst: number?)
	assert(type(ratePerSecond) == "number" and ratePerSecond > 0, "ratePerSecond must be positive")

	local burstSize = burst or ratePerSecond
	assert(burstSize > 0, "burst must be positive")

	return setmetatable({
		_rate = ratePerSecond,
		_burst = burstSize,
		_buckets = {},
	}, RateLimiter)
end

--- Attempts to spend `cost` tokens. Returns false when the key is throttled.
function RateLimiter:Consume(key: any, cost: number?): boolean
	local price = cost or 1
	local now = os.clock()

	local bucket = self._buckets[key]

	if not bucket then
		bucket = { tokens = self._burst, updated = now }
		self._buckets[key] = bucket
	end

	-- Lazy refill: no background loop needed, buckets only advance when used.
	local elapsed = math.max(now - bucket.updated, 0)
	bucket.tokens = math.min(self._burst, bucket.tokens + elapsed * self._rate)
	bucket.updated = now

	if bucket.tokens < price then
		return false
	end

	bucket.tokens -= price
	return true
end

--- Tokens currently available, for diagnostics.
function RateLimiter:Peek(key: any): number
	local bucket = self._buckets[key]
	if not bucket then
		return self._burst
	end

	local elapsed = math.max(os.clock() - bucket.updated, 0)
	return math.min(self._burst, bucket.tokens + elapsed * self._rate)
end

--- Drops a key's bucket. Call this on PlayerRemoving.
function RateLimiter:Forget(key: any)
	self._buckets[key] = nil
end

return RateLimiter
