#!/usr/bin/env python3
"""Runs Bootstrap against deliberately broken instance trees.

Bootstrap is a Script with top-level side effects, so it cannot live in the
main suite (which already starts every service). This builds a separate bundle
to verify two things:

  A. A tree missing a REQUIRED module aborts with a named, actionable error
     rather than "Attempted to call require with invalid argument(s)".
  B. A tree missing only the OPTIONAL FrameworkGuard still boots - this is the
     exact state the reported Studio crash came from.
"""

import os
import pathlib
import shutil
import subprocess
import sys

TESTS = pathlib.Path(__file__).parent
REPO = TESTS.parent

#: The Luau CLI. Not vendored - it is a 3 MB binary per platform. Set LUAU to
#: point at it, drop it next to this script, or put it on PATH.
LUAU = os.environ.get("LUAU") or shutil.which("luau") or str(TESTS / "luau")

if not pathlib.Path(LUAU).exists():
    sys.exit(
        "Could not find the Luau CLI.\n"
        "Download it from https://github.com/luau-lang/luau/releases, then either\n"
        "  put `luau` on your PATH, or\n"
        "  set LUAU=/path/to/luau, or\n"
        f"  drop the binary at {TESTS / 'luau'}"
    )

MODULE_PATHS = [
    "src/Shared/GameConfig.luau",
    "src/Shared/Signal.luau",
    "src/Shared/TableUtil.luau",
    "src/Shared/Types.luau",
    "src/Shared/Growth.luau",
    "src/Shared/Remotes.luau",
    "src/Shared/RateLimiter.luau",
    "src/Shared/Buildability.luau",
    "src/Shared/Spatial.luau",
    "src/Shared/Combat.luau",
    "src/Shared/StatusEffects.luau",
    "src/Server/FrameworkGuard.luau",
    "src/Server/Data/DataSchema.luau",
    "src/Server/Data/ProfileStore.luau",
    "src/Server/Plots/CropFactory.luau",
    "src/Server/World/ShopBuilder.luau",
    "src/Server/World/StructureBuilder.luau",
    "src/Server/World/TrainingGround.luau",
    "src/Server/World/PlacementService.luau",
    "src/Server/Combat/DamageableService.luau",
    "src/Server/Combat/StatusEffectService.luau",
    "src/Server/Combat/AttackService.luau",
    "src/Server/Combat/RaidService.luau",
    "src/Server/Combat/DefeatService.luau",
    "src/Server/Services/PlayerDataService.luau",
    "src/Server/Services/FarmService.luau",
    "src/Server/Services/ShopService.luau",
    "src/Server/Services/MarketplaceService.luau",
    "src/Server/Bootstrap.server.luau",
]

PROBE = r"""
local ServerScriptService = game:GetService("ServerScriptService")
local Server = ServerScriptService:FindFirstChild("Server")

local bootstrapPath = "src/Server/Bootstrap.server.luau"

local bootstrapScript = Instance.new("Script")
bootstrapScript.Name = "Bootstrap"
bootstrapScript.Parent = Server

local function runBootstrap()
    return pcall(function()
        MODULES[bootstrapPath](bootstrapScript)
    end)
end

----------------------------------------------------------------------
-- Case A: a REQUIRED module is missing
----------------------------------------------------------------------
local services = Server:FindFirstChild("Services")
local shopService = services:FindFirstChild("ShopService")
shopService.Parent = nil

local okA, errA = runBootstrap()

checkEqual(okA, false, "a missing required module aborts startup")
check(
    string.find(tostring(errA), "MISSING MODULES") ~= nil,
    "the abort names the real problem instead of a require error"
)
check(
    string.find(tostring(errA), "Services.ShopService", 1, true) ~= nil,
    "the abort names the exact missing module"
)
check(
    string.find(tostring(errA), "invalid argument") == nil,
    "require is never called on nil, so no 'invalid argument' error appears"
)
check(string.find(tostring(errA), "rojo serve", 1, true) ~= nil, "the abort explains how to fix it")

shopService.Parent = services

----------------------------------------------------------------------
-- Case B: only the OPTIONAL FrameworkGuard is missing
-- (the exact state that produced the reported Bootstrap:23 crash)
----------------------------------------------------------------------
local guard = Server:FindFirstChild("FrameworkGuard")
guard.Parent = nil

WARNINGS = {}
local okB, errB = runBootstrap()

check(okB, `the server still boots without FrameworkGuard (error: {tostring(errB)})`)

local warnedAboutGuard = false
for _, message in WARNINGS or {} do
    if string.find(message, "FrameworkGuard", 1, true) then
        warnedAboutGuard = true
    end
end
check(warnedAboutGuard, "a missing guard warns rather than crashing")

guard.Parent = Server

----------------------------------------------------------------------
-- Case C: the tree is complete but INCONSISTENT
--
-- The guard exists to turn a half-synced tree into a named, actionable
-- failure instead of a mystery nil-index deep in unrelated code. This
-- checks it actually does that - a mismatch shipped once because the
-- suite verified the version numbers and never the guard's reaction.
----------------------------------------------------------------------
local staleModule = Server:FindFirstChild("Combat"):FindFirstChild("DefeatService")
local stale = require(staleModule)
local realVersion = stale.FrameworkVersion

stale.FrameworkVersion = realVersion - 1

local okC, errC = runBootstrap()

checkEqual(okC, false, "a tree whose modules disagree aborts startup")
check(
    string.find(tostring(errC), "PARTIALLY SYNCED", 1, true) ~= nil,
    "naming the real problem rather than surfacing a nil later"
)
check(
    string.find(tostring(errC), "DefeatService", 1, true) ~= nil,
    "and naming the module that is out of step"
)
check(
    string.find(tostring(errC), "rojo", 1, true) ~= nil,
    "with instructions for fixing it"
)

stale.FrameworkVersion = realVersion

print("\n================================")
print(`passed: {PASSES}   failed: {#FAILURES}`)
if #FAILURES > 0 then
    for _, failure in FAILURES do
        print(`  - {failure}`)
    end
end
print("================================")
"""

parts = [(TESTS / "prelude.luau").read_text(), "\nMODULES = {}\n"]

for rel in MODULE_PATHS:
    source = (REPO / rel).read_text()
    parts.append(f'\nMODULES["{rel}"] = function(script)\n{source}\nend\n')

parts.append(PROBE)

bundle = TESTS / "bootstrap_bundle.luau"
bundle.write_text("".join(parts))

result = subprocess.run([LUAU, str(bundle)], capture_output=True, text=True)
sys.stdout.write(result.stdout)
if result.stderr:
    sys.stderr.write("\n[stderr]\n" + result.stderr)
sys.exit(result.returncode)
