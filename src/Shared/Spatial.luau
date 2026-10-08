--!nonstrict
--[[
	Spatial
	-------
	Distance and proximity queries, as pure functions over plain tables. No
	instances, no state, no yielding.

	WHY THIS EXISTS
	---------------
	Three callers wanted the same loop: splash damage, attack range, and enemy
	target selection. A fourth is coming with troops. Written per-caller they
	diverge in exactly the ways that are hard to see - one includes height, one
	uses a squared radius and forgets to square the input, one breaks ties by
	hash order and so picks a different target every tick.

	THE GROUND PLANE
	----------------
	Every distance here ignores Y. A tower's range should not shrink because
	the target is on a hill, and splash should not spare someone standing on a
	crate. This is the same decision the old placement radius made, for the
	same reason.

	Callers pass candidate tables carrying a `Position` and whatever else they
	like; nothing here cares what the rest of the table is.
]]

local Spatial = {}

export type Candidate = { Position: Vector3 }

--------------------------------------------------------------------------------
-- Distance
--------------------------------------------------------------------------------

--- Distance on the XZ plane, ignoring height.
function Spatial.GroundDistance(a: Vector3, b: Vector3): number
	local dx = a.X - b.X
	local dz = a.Z - b.Z
	return math.sqrt(dx * dx + dz * dz)
end

--- Squared ground distance, for comparisons that do not need the root.
function Spatial.GroundDistanceSquared(a: Vector3, b: Vector3): number
	local dx = a.X - b.X
	local dz = a.Z - b.Z
	return dx * dx + dz * dz
end

function Spatial.IsWithin(a: Vector3, b: Vector3, radius: number): boolean
	return Spatial.GroundDistanceSquared(a, b) <= radius * radius
end

--------------------------------------------------------------------------------
-- Selection
--------------------------------------------------------------------------------

--[[
	The nearest candidate within `radius`, and its distance.

	`accept` is an optional filter, applied before the distance test so a
	caller can reject by faction or state without building a second list.

	TIES ARE BROKEN DETERMINISTICALLY by earlier position in the list. Without
	that, two equidistant targets would swap every tick as the table's
	iteration order shifted, and an attacker would stutter between them
	forever instead of killing either.
]]
function Spatial.FindNearest(
	origin: Vector3,
	candidates: { Candidate },
	radius: number,
	accept: ((Candidate) -> boolean)?
): (Candidate?, number)
	local best = nil
	local bestDistance = math.huge
	local limit = radius * radius

	for _, candidate in candidates do
		if candidate.Position and (accept == nil or accept(candidate)) then
			local distance = Spatial.GroundDistanceSquared(origin, candidate.Position)

			-- Strictly less than, so the first of equals wins.
			if distance <= limit and distance < bestDistance then
				best = candidate
				bestDistance = distance
			end
		end
	end

	if not best then
		return nil, math.huge
	end

	return best, math.sqrt(bestDistance)
end

--[[
	Distance from `origin` to a candidate's SURFACE rather than its centre.

	A candidate may carry a `Radius` - half its footprint. Without it, a nine
	stud club could not reach a sixteen stud wide building at all without the
	attacker standing inside the walls, because centre-to-centre distance to
	anything large is dominated by the thing's own size. Range means "how far
	I can reach past myself", not "how close my middle gets to your middle".

	Clamped at zero, so standing inside something reads as touching it.
]]
function Spatial.SurfaceDistance(origin: Vector3, candidate: Candidate): number
	local radius = tonumber((candidate :: any).Radius) or 0
	return math.max(Spatial.GroundDistance(origin, candidate.Position) - radius, 0)
end

--[[
	The nearest candidate whose SURFACE is within `reach`, by surface distance.

	The separate function rather than a flag on FindNearest: the two answer
	different questions, and a caller that wants one and gets the other is a
	bug that only shows up against large targets.
]]
function Spatial.FindNearestInReach(
	origin: Vector3,
	candidates: { Candidate },
	reach: number,
	accept: ((Candidate) -> boolean)?
): (Candidate?, number)
	local best = nil
	local bestDistance = math.huge

	for _, candidate in candidates do
		if candidate.Position and (accept == nil or accept(candidate)) then
			local distance = Spatial.SurfaceDistance(origin, candidate)

			-- Strictly less than, so the first of equals wins; see FindNearest.
			if distance <= reach and distance < bestDistance then
				best = candidate
				bestDistance = distance
			end
		end
	end

	if not best then
		return nil, math.huge
	end

	return best, bestDistance
end

--- Every candidate within `radius`, in list order.
function Spatial.FindWithin(
	origin: Vector3,
	candidates: { Candidate },
	radius: number,
	accept: ((Candidate) -> boolean)?
): { Candidate }
	local found = {}
	local limit = radius * radius

	for _, candidate in candidates do
		if candidate.Position and (accept == nil or accept(candidate)) then
			if Spatial.GroundDistanceSquared(origin, candidate.Position) <= limit then
				table.insert(found, candidate)
			end
		end
	end

	return found
end

--------------------------------------------------------------------------------
-- Blocking
--------------------------------------------------------------------------------

--[[
	The nearest candidate standing BETWEEN `origin` and `objective`.

	This is the geometry behind "a tank plant protects the plants behind it".
	In a lane game that falls out of the layout for free; in an open 3D base it
	has to be stated, because the nearest thing to a raider is often off to one
	side and walking past a wall of defences to hit the squishy thing behind
	them looks like the AI cheating.

	A candidate blocks when it is both:

	  * AHEAD - its projection onto the line toward the objective is positive
	    and STRICTLY nearer than the objective itself. Something standing at
	    the objective's own distance is beside it, not in front of it, and
	    treating it as a blocker means two things in the same place fight over
	    which one is "in the way" by iteration order, and
	  * IN THE CORRIDOR - its perpendicular offset from that line is within
	    `corridorWidth`.

	Of those, the nearest to the origin wins: that is the one you would walk
	into first. Returns nil when the path is clear, which is the caller's cue
	to keep heading for the objective.
]]
function Spatial.FindBlocking(
	origin: Vector3,
	objective: Vector3,
	candidates: { Candidate },
	corridorWidth: number
): (Candidate?, number)
	-- Scalars rather than vector arithmetic: this is two dot products and a
	-- Pythagoras, and spelling it out is both clearer and free of any
	-- assumption about which operators Vector3 supports.
	local pathX = objective.X - origin.X
	local pathZ = objective.Z - origin.Z
	local objectiveDistance = math.sqrt(pathX * pathX + pathZ * pathZ)

	-- Standing on the objective: nothing can be in the way of a zero-length
	-- path, so fall back to whatever is closest.
	if objectiveDistance < 1e-4 then
		return Spatial.FindNearest(origin, candidates, corridorWidth)
	end

	local dirX = pathX / objectiveDistance
	local dirZ = pathZ / objectiveDistance

	local best = nil
	local bestDistance = math.huge

	for _, candidate in candidates do
		if candidate.Position then
			local offsetX = candidate.Position.X - origin.X
			local offsetZ = candidate.Position.Z - origin.Z

			-- How far along the path it sits...
			local along = offsetX * dirX + offsetZ * dirZ

			-- ...and how far off to the side of it.
			local sideX = offsetX - dirX * along
			local sideZ = offsetZ - dirZ * along
			local sideways = math.sqrt(sideX * sideX + sideZ * sideZ)

			if along >= 0 and along < objectiveDistance and sideways <= corridorWidth then
				if along < bestDistance then
					best = candidate
					bestDistance = along
				end
			end
		end
	end

	if not best then
		return nil, math.huge
	end

	return best, Spatial.GroundDistance(origin, best.Position)
end

--------------------------------------------------------------------------------
-- Splash
--------------------------------------------------------------------------------

--[[
	Damage fraction at `distance` from a blast of `radius`.

	Linear from 1 at the centre down to `minFraction` at the edge, and 0
	outside. The floor exists for the same reason MinimumDamage does: a blast
	that deals an unmeasurable sliver at its rim reads as a bug, and tuning
	radius becomes guesswork when the outer half of it does nothing.
]]
function Spatial.GetFalloff(distance: number, radius: number, minFraction: number): number
	if radius <= 0 then
		return if distance <= 0 then 1 else 0
	end

	if distance >= radius then
		-- The rim itself still counts; past it, nothing.
		return if distance > radius then 0 else minFraction
	end

	local travelled = math.clamp(distance / radius, 0, 1)
	return 1 - travelled * (1 - minFraction)
end

return Spatial
