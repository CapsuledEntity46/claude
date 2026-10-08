--!nonstrict
--[[
	TableUtil
	---------
	Minimal table helpers used by the persistence layer.

	DeepCopy  - breaks every shared reference, so cached DataStore values can
	            never be mutated by gameplay code (and vice versa).
	Reconcile - fills missing keys from a template without touching existing
	            player values. This is how new fields are safely rolled out to
	            players who saved before the field existed.
]]

local TableUtil = {}

function TableUtil.DeepCopy<T>(source: T): T
	if type(source) ~= "table" then
		return source
	end

	local copy = {}
	for key, value in source :: any do
		copy[key] = if type(value) == "table" then TableUtil.DeepCopy(value) else value
	end

	return copy :: any
end

--- Recursively adds any keys present in `template` but missing from `target`.
--- Existing values are never overwritten. Returns the number of keys added.
function TableUtil.Reconcile(target: { [any]: any }, template: { [any]: any }): number
	local added = 0

	for key, templateValue in template do
		local currentValue = target[key]

		if currentValue == nil then
			target[key] = if type(templateValue) == "table"
				then TableUtil.DeepCopy(templateValue)
				else templateValue
			added += 1
		elseif type(templateValue) == "table" and type(currentValue) == "table" then
			added += TableUtil.Reconcile(currentValue, templateValue)
		end
	end

	return added
end

--- Counts entries in a dictionary-style table.
function TableUtil.Count(source: { [any]: any }): number
	local count = 0
	for _ in source do
		count += 1
	end

	return count
end

return TableUtil
