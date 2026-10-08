#!/usr/bin/env python3
"""Bundles the game modules + harness into one Luau file and runs it.

The Luau CLI has no filesystem library, so module sources are embedded as
functions keyed by their repo-relative path. prelude.luau's require() looks
them up in the MODULES global.
"""

import os
import pathlib
import re
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
    "src/Shared/Husbandry.luau",
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
    "src/Server/Pens/AnimalFactory.luau",
    "src/Server/Services/PlayerDataService.luau",
    "src/Server/Services/FarmService.luau",
    "src/Server/World/ShopBuilder.luau",
    "src/Server/World/StructureBuilder.luau",
    "src/Server/World/TrainingGround.luau",
    "src/Server/World/PlacementService.luau",
    "src/Server/Services/AnimalService.luau",
    "src/Server/Combat/DamageableService.luau",
    "src/Server/Combat/StatusEffectService.luau",
    "src/Server/Combat/AttackService.luau",
    "src/Server/Combat/RaidService.luau",
    "src/Server/Combat/DefeatService.luau",
    "src/Server/Services/ShopService.luau",
    "src/Server/Services/MarketplaceService.luau",
]


def generate_long_string(body: str) -> str:
    """Wraps `body` in a Luau long string, choosing a safe bracket level."""
    level = 0
    while f"]{'=' * level}]" in body:
        level += 1
    equals = "=" * level
    # A leading newline is swallowed by Luau, so one is added to preserve the text.
    return f"[{equals}[\n{body}]{equals}]"


parts = [(TESTS / "prelude.luau").read_text()]

parts.append("\nMODULES = {}\n")
for rel in MODULE_PATHS:
    source = (REPO / rel).read_text()
    parts.append(f'\nMODULES["{rel}"] = function(script)\n{source}\nend\n')

#: Every Luau source in the project, as TEXT, with comments stripped.
#:
#: Client scripts cannot be executed here - they build GUIs and bind to
#: UserInputService - so nothing catches a client referencing a config field
#: that has been renamed. That happened: DefeatClient was left reading
#: GameConfig.Defeat.SurrenderLoss after it became SurrenderPurseLoss, which
#: threw while building a label and stopped the defeat panel appearing at all.
#:
#: So the suite audits the source text instead. Comments are stripped first,
#: because a stale name in prose is a documentation problem, not a crash.


def strip_comments(source: str) -> str:
    source = re.sub(r"--\[\[.*?\]\]", "", source, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", "", source)


audited = sorted(
    str(path.relative_to(REPO)).replace("\\", "/")
    for path in (REPO / "src").rglob("*.luau")
)

parts.append("\nSOURCES = {}\n")
for rel in audited:
    cleaned = strip_comments((REPO / rel).read_text())
    parts.append(f'\nSOURCES["{rel}"] = {generate_long_string(cleaned)}\n')

parts.append("\n" + (TESTS / "tests.luau").read_text())

bundle = TESTS / "bundle.luau"
bundle.write_text("".join(parts))

result = subprocess.run([LUAU, str(bundle)], capture_output=True, text=True)

sys.stdout.write(result.stdout)
if result.stderr:
    sys.stderr.write("\n[stderr]\n" + result.stderr)

sys.exit(result.returncode)
