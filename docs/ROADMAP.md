# Roadmap

The goal: a first/third-person 3D engine with a Hammer++-style level editor, in C# on
MonoGame.

Phases are ordered so each one is usable on its own rather than being scaffolding for the
next. Phase 1 is complete.

---

## Read this before Phase 2: MonoGame shader compilation

MonoGame's content pipeline compiles effects (`.fx`) with a **DirectX-based** compiler.

- **On Windows** this works out of the box.
- **On Linux/macOS** effect compilation is not natively supported and is normally run
  through Wine, via the `mgfxc_wine_setup.sh` script described in the
  [MonoGame setup docs](https://docs.monogame.net/articles/getting_started/1_setting_up_your_os_for_development_arch.html).

MonoGame **3.8.5** (July 2026) introduced a new native C/C++ backend and a new `DesktopVK`
target built on SDL2 + Vulkan + FAudio, intended to eventually replace `DesktopGL`
([release notes](https://monogame.net/blog/2026-07-15-3.8.5-release-2026/)). Whether that
changes the shader-compilation story on Linux is worth verifying on your machine before
committing to a platform — it directly affects how painful the renderer is to iterate on.

**Recommendation:** target `MonoGame.Framework.DesktopGL` for now (mature, cross-platform),
and keep every shader behind a thin material abstraction so a later move to `DesktopVK` is
a contained change. Everything targets `net9.0`, which is what current MonoGame expects.

> Note: the Phase 1 code in this repository was written and tested in an environment with
> no NuGet access, so nothing MonoGame-dependent has been compiled yet. Expect to shake out
> ordinary API mismatches when Phase 2 first builds locally.

---

## Phase 1 — Geometry kernel ✅

Convex-brush solids, CSG, Hammer-compatible texture projection, the `.tmap` format, and
renderer-agnostic mesh batching. 93 tests, no dependencies.

## Phase 2 — Renderer and runtime

Get a level on screen. `Forge.Runtime`, referencing MonoGame.

- Window and game loop; `net9.0`, `MonoGame.Framework.DesktopGL`
- **Z-up camera** — build view matrices with `Vector3.UnitZ` as up; do not convert the world
- Material system: material path → texture + shader parameters, with a hot-reload path.
  A placeholder checkerboard for missing textures beats crashing
- Static geometry renderer consuming `MeshBuilder` batches directly into
  `VertexBuffer`/`IndexBuffer`, one draw call per material
- Basic forward lighting, plus a `light_environment` directional light
- Debug rendering — wireframe, brush normals, an on-screen stats overlay
- Free-fly camera and a level loaded from `.tmap`

*Done when:* `content/maps/testroom.tmap` renders, and you can fly through it.

## Phase 3 — Editor shell

`Forge.Editor` — MonoGame host with an ImGui.NET interface.

- ImGui.NET with docking enabled ([docking wiki](https://github.com/ocornut/imgui/wiki/Docking));
  a MonoGame backend is straightforward, and existing wrappers such as
  [MonoGame.ImGuiNet](https://github.com/tsMezotic/MonoGame.ImGuiNet) can serve as reference
- **Four-viewport layout**: 3D perspective plus top/front/side orthographic, each rendering
  to a `RenderTarget2D` displayed as an ImGui image
- 2D viewports: grid with power-of-two zoom, coordinate readout, pan/zoom
- Selection — click picking via `Winding.IntersectRay`, rubber-band select, groups
- Object/face/vertex selection modes
- Panels: material browser, entity properties, visgroups, map statistics
- Undo/redo. Build this **early**; retrofitting an undo system onto mutable brushes is
  miserable. Command objects with explicit apply/revert, not deep snapshots

*Done when:* you can open the sample map, navigate all four viewports, and select brushes.

## Phase 4 — Editor tools

The part that has to feel like Hammer.

- **Block tool** — drag out a box in a 2D view, extrude in another; primitive picker
  (block/wedge/cylinder/spike/sphere — all already in `BrushFactory`)
- **Selection/transform tool** — move, rotate, scale, flip, with grid snapping and texture
  lock (`Brush.Transform` already implements the lock)
- **Clip tool** — draw a plane, keep front/back/both (`Csg.Split`)
- **Vertex and face manipulation** — drag face planes; the derived-geometry model means
  neighbouring faces re-cut automatically
- **Texture application tool** — apply, align to world/face, fit, justify, rotate, shift;
  lift-and-apply between faces
- **Entity tool** with FGD-driven property editing, plus an I/O editor for `connections`
- Carve and hollow (`Csg.Subtract`, `BrushFactory.Hollow`)
- Prefabs, and Hammer++ conveniences: instancing, per-face smoothing groups

*Done when:* the sample map can be rebuilt from scratch in the editor.

## Phase 5 — Map compiler

Turn authored brushes into something efficient to render and collide with. Belongs in
`Forge.Core` — it is pure geometry and should stay testable.

- BSP tree from face planes, with a split-cost heuristic; `hint` brushes force splits
- Portal generation between leaves, and **leak detection** by flood-filling from entity
  origins. Report the leak path — a compiler that says "leaked" without saying where is
  nearly useless
- Visibility (PVS) per leaf
- Face merging and T-junction removal
- Collision hulls straight from brush planes, Quake-style — no mesh collision needed
- Lightmap packing and a radiosity or ray-traced bounce solver
- A compiled binary level format the runtime memory-maps

*Done when:* a compiled level renders with baked lighting and only visible leaves drawn.

## Phase 6 — Gameplay runtime

- **Character controller** — capsule swept against brush planes; the convex-hull collision
  the brush model already gives you. Ground detection, step-up, slope limits, crouch,
  swimming for `water` contents, ladders
- **First-person camera** with view bob and configurable FOV
- **Third-person camera** with a spring arm, collision-aware pull-in, and shoulder offset
- Entity runtime: spawn from classname, and an I/O dispatcher implementing
  `connections` (delays, `timesToFire`)
- Trigger volumes from `trigger` contents; brush entities that move (`func_door`)
- Input mapping, a player state machine, and basic weapon/interaction hooks

*Done when:* you can walk the sample map in both first and third person, and the button
opens the door.

## Phase 7 — Beyond

- Displacement/terrain surfaces subdivided from brush faces
- Model loading and animation
- Particles, decals, post-processing
- Sound with occlusion driven by the BSP
- Navmesh generation from compiled geometry
- Networking

---

## Suggested near-term order

1. **Phase 2 renderer** — the highest-value next step. You get immediate visual feedback,
   and every later phase is easier to debug once you can see geometry.
2. **Phase 3 shell with undo/redo from day one.**
3. **Phase 4 block tool and selection**, then the rest of the tools.
4. **Phase 6 character controller** before Phase 5 — walking around an uncompiled level is
   more motivating than optimising visibility, and brush-plane collision needs no compiler.
5. **Phase 5 compiler** once level size makes it necessary.
