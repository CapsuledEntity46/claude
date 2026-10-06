--!nonstrict
--[[
	FrameworkGuard
	--------------
	Detects a partially synced source tree at startup.

	WHY THIS EXISTS
	---------------
	This project spans a dozen files that evolve together. When Studio ends up
	holding modules from two different commits, the symptom is a nil-index or
	nil-iterate deep inside unrelated code, with a line number that no longer
	matches the file you are reading. For example, renaming
	GameConfig.InventoryCategories to ItemCategories turns a stale
	PlayerDataService into "attempt to iterate over a nil value" - a message
	that says nothing about the real cause, which is that two files disagree.

	Every service therefore declares the framework revision it was written
	against. Bootstrap compares them all to Shared.GameConfig before anything
	starts, so a mismatch fails immediately with a message naming the stale
	module instead of surfacing later as a mystery nil.

	BUMP GameConfig.FrameworkVersion AND EVERY SERVICE'S FrameworkVersion
	whenever a change crosses module boundaries - a renamed config field, a
	changed function signature, a reshaped table. Additive changes do not need
	a bump.

	This catches mismatches in both directions: a stale service declares an old
	number (or nil), and a stale GameConfig makes every service look wrong.
]]

local FrameworkGuard = {}

--[[
	Compares each module's declared version against `expected`.
	Returns (ok, problems) where problems is a sorted list of descriptions.
]]
function FrameworkGuard.Check(expected: unknown, modules: { [string]: any }): (boolean, { string })
	local problems = {}

	if type(expected) ~= "number" then
		table.insert(
			problems,
			`Shared.GameConfig does not declare FrameworkVersion (got {typeof(expected)}), so it predates the framework guard`
		)

		return false, problems
	end

	for name, module in modules do
		local declared = if type(module) == "table" then module.FrameworkVersion else nil

		if declared ~= expected then
			table.insert(
				problems,
				`{name} was written against framework v{tostring(declared)}, but Shared.GameConfig is v{expected}`
			)
		end
	end

	table.sort(problems)

	return #problems == 0, problems
end

--- Hard-fails with an actionable message when the tree is inconsistent.
function FrameworkGuard.Assert(expected: unknown, modules: { [string]: any })
	local ok, problems = FrameworkGuard.Check(expected, modules)

	if ok then
		return
	end

	local message = table.concat({
		"",
		"=================================================================",
		" PARTIALLY SYNCED SOURCE TREE - startup aborted",
		"=================================================================",
		"",
		table.concat(problems, "\n"),
		"",
		"These files come from different commits, so they disagree about",
		"config field names and function signatures. Nothing below this",
		"point would behave predictably.",
		"",
		"To fix:",
		"  1. Stop the Rojo server.",
		"  2. Confirm the working tree is clean and on the intended commit.",
		"  3. Delete the stale instances in Studio: ServerScriptService.Server,",
		"     ReplicatedStorage.Shared, and StarterPlayer.StarterPlayerScripts.Client.",
		"  4. Run `rojo serve` again and re-connect, or `rojo build` a fresh place.",
		"",
		"Rojo only overwrites the paths in default.project.json; instances left",
		"over from an earlier build are not removed for you.",
		"=================================================================",
		"",
	}, "\n")

	-- Level 0: the message is the point, not this file's line number.
	error(message, 0)
end

return FrameworkGuard
