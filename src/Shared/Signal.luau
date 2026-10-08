--!nonstrict
--[[
	Signal
	------
	A lightweight, pure-Luau event implementation.

	Preferred over BindableEvent for server-internal communication because it
	does not serialise arguments (tables keep their identity, metatables and
	non-string keys survive) and it has no cross-boundary cost.

	Handlers are dispatched with task.spawn, so a single erroring handler can
	never prevent the remaining handlers from running.

	Usage:
		local changed = Signal.new()
		local conn = changed:Connect(function(player, amount) ... end)
		changed:Fire(player, 50)
		conn:Disconnect()
]]

local Connection = {}
Connection.__index = Connection

function Connection.new(signal, handler)
	return setmetatable({
		Connected = true,
		_signal = signal,
		_handler = handler,
	}, Connection)
end

function Connection:Disconnect()
	if not self.Connected then
		return
	end

	self.Connected = false

	local handlers = self._signal._handlers
	local index = table.find(handlers, self)
	if index then
		table.remove(handlers, index)
	end

	self._signal = nil
	self._handler = nil
end

local Signal = {}
Signal.__index = Signal

export type Connection = typeof(Connection.new(nil :: any, nil :: any))

function Signal.new()
	return setmetatable({
		_handlers = {},
	}, Signal)
end

function Signal:Connect(handler: (...any) -> ()): Connection
	assert(type(handler) == "function", "Signal:Connect expects a function")

	local connection = Connection.new(self, handler)
	table.insert(self._handlers, connection)

	return connection
end

--- Connects a handler that automatically disconnects after the first fire.
function Signal:Once(handler: (...any) -> ()): Connection
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		handler(...)
	end)

	return connection
end

function Signal:Fire(...: any)
	-- Iterate a snapshot: handlers may connect/disconnect during dispatch.
	local handlers = table.clone(self._handlers)

	for _, connection in handlers do
		if connection.Connected then
			task.spawn(connection._handler, ...)
		end
	end
end

--- Yields the calling thread until the next fire and returns its arguments.
function Signal:Wait(): ...any
	local thread = coroutine.running()

	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		task.spawn(thread, ...)
	end)

	return coroutine.yield()
end

function Signal:DisconnectAll()
	for _, connection in table.clone(self._handlers) do
		connection:Disconnect()
	end

	table.clear(self._handlers)
end

function Signal:Destroy()
	self:DisconnectAll()
end

return Signal
