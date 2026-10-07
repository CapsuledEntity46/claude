# Tests

A headless test suite for the server and shared code: **1101 assertions**, no
Roblox Studio required.

## Why this exists

Roblox has no built-in way to run server logic outside a live session, and
"open Studio and press Play" is a slow, non-repeatable way to find out whether
a timestamp calculation is right. So the game's modules are bundled with a stub
of the Roblox API and run under the plain [Luau CLI].

What the stubs cover: `Instance` with attributes, children and a crude `IsA`;
`Players`; `Workspace`; `DataStoreService` (with a JSON round-trip, so numeric
keys become strings exactly as the real thing does); `RemoteEvent` and
`RemoteFunction`; `Vector3`, `Color3`, `UDim2`; and a **virtual clock** with a
cooperative scheduler standing in for `task`.

The virtual clock is the important part. Almost everything in this project is
derived from timestamps — crop growth, health regeneration, status effect
expiry, session locks — and `advance(seconds)` fast-forwards all of it
instantly. Tests that would take twenty minutes of real waiting run in
milliseconds, which is the only reason offline growth and lock expiry are
tested at all.

## Running them

You need the Luau CLI, which is a single binary and is **not** vendored here.
Download it from [the Luau releases page][Luau CLI], then:

```sh
# Put `luau` on your PATH, or:
export LUAU=/path/to/luau

python3 tests/build_and_run.py      # the suite
python3 tests/bootstrap_probe.py    # server startup failure modes
```

Both print a pass/fail count and name every failure.

## The two runners

`build_and_run.py` concatenates `prelude.luau`, every game module, and
`tests.luau` into one file and runs it. The Luau CLI has no filesystem library,
so modules are embedded as functions keyed by their repo path and the prelude's
`require` resolves them from there.

`bootstrap_probe.py` is separate because `Bootstrap.server.luau` is a Script
with top-level side effects — it cannot run inside a suite that has already
started every service. It builds deliberately broken instance trees to check
that a missing module aborts with a named, actionable error rather than
`Attempted to call require with invalid argument(s)`, and that a missing
*optional* module still boots.

## What is worth knowing before editing

- **Luau caps live locals at 200 per function** and the suite is one function,
  so sections are wrapped in `do ... end` blocks. Adding locals to an existing
  section can push it over; scope them.
- Assertions are `check(condition, label)` and `checkEqual(actual, expected,
  label)`. Labels read as sentences because the output is the documentation.
- `advance(n)` moves the virtual clock and resumes parked threads in time
  order, so service loops (growth, status effects, attacks, raider movement)
  tick as they would live.
- Tests deliberately assert *reasons*, not just failure: a refusal that cannot
  explain itself is a bug of its own.

## Counter-testing

Every mechanism here was checked by breaking it on purpose and confirming the
suite goes red. That is not ceremony — it has repeatedly caught assertions that
passed for the wrong reason, including a test for "raiders stop outside the
wall" that measured the raider's centre instead of its body, and a test for
"shots are not banked up during a stall" that any implementation would have
passed. If you add a test, break the thing it covers once and make sure it
fails.

[Luau CLI]: https://github.com/luau-lang/luau/releases
