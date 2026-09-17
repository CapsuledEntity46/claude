# Forge

A first/third-person 3D game engine in C# with a Hammer++-style brush editor, built on
MonoGame.

Levels are authored the way Quake and Source levels are: by pushing around convex
**brushes** — solids defined by their planes rather than their vertices — and carving them
with CSG. That model is what makes a Hammer-like editor possible at all. Because a brush
is guaranteed convex, point containment is a handful of dot products, collision needs no
acceleration structure, and boolean operations reduce to clipping half-spaces.

## Status

**Phase 1 complete: the geometry kernel.** The part every other system depends on is
built and tested — 93 tests covering plane/polygon math, brush construction, CSG,
Hammer-compatible texture projection, and the level file format.

The renderer and editor UI are next. See [docs/ROADMAP.md](docs/ROADMAP.md).

| Component | State |
| --- | --- |
| `Forge.Core` — solids, CSG, texture projection, `.tmap` format, mesh building | Done, tested |
| `forge` CLI — map generation, validation, OBJ export | Done |
| MonoGame renderer | Not started (Phase 2) |
| Editor UI — viewports, tools | Not started (Phase 3) |
| Map compiler — BSP, visibility, lightmaps | Not started (Phase 5) |
| Gameplay runtime — character controllers, entity I/O | Not started (Phase 6) |

## Quick start

Requires the .NET 9 SDK.

```bash
dotnet build Forge.sln

# Run the test suite (no test framework needed - it is a plain console app)
dotnet run --project tests/Forge.Core.Tests

# Run one group of tests
dotnet run --project tests/Forge.Core.Tests -- Csg

# Exercise the whole pipeline and print measured results
dotnet run --project tools/Forge.Cli -- demo build/demo
```

`demo` builds a level in code, carves it, saves it, reloads it, validates it, and exports
it — reporting numbers rather than impressions:

```
[1] CSG carve
    wall volume             524,288.0
    fragments ( 8)           460,947.1
    removed                  63,341.0
    fragments+removed       524,288.0   (error 0.0195)
    all fragments convex and closed: True
...
[3] Format round-trip
    byte-identical on re-save: yes
```

### Look at the geometry

There is no renderer yet, so export to OBJ and open it in any 3D viewer:

```bash
dotnet run --project tools/Forge.Cli -- obj content/maps/testroom.tmap build/testroom.obj
```

### Other CLI commands

```bash
forge new <out.tmap>            # write the built-in sample level
forge info <map.tmap>           # geometry and entity statistics
forge validate <map.tmap>       # non-zero exit on problems, for CI
forge obj <map.tmap> <out.obj>  # export geometry (--z-up keeps native axes)
```

## Layout

```
src/Forge.Core/          Geometry kernel. No third-party dependencies, by design.
  Geometry/              Plane3, Winding (convex polygon clipping), Aabb
  Map/                   Brush, Face, TextureAlignment, Csg, Entity, MapDocument
  Serialization/         Keyvalue parser/writer and the .tmap format
  Export/                MeshBuilder (renderer-agnostic batches), ObjExporter
tools/Forge.Cli/         Headless map tooling
tests/Forge.Core.Tests/  Dependency-free test harness and suite
content/maps/            Sample levels
docs/                    Architecture, roadmap, file format
```

`Forge.Core` deliberately has **no** dependency on MonoGame or any graphics API. The
geometry kernel is the hardest part of the engine to get right and the easiest to break,
so it is kept verifiable without a GPU, a window, or a content pipeline. `MeshBuilder`
emits plain vertex/index arrays that the renderer uploads as-is.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — coordinate system, layering, and the
  design decisions worth knowing before changing anything
- [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md) — the `.tmap` format
- [docs/ROADMAP.md](docs/ROADMAP.md) — what is next, in order, and the MonoGame shader
  caveat on Linux/macOS
