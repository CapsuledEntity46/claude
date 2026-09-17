# Architecture

## Coordinate system and units

Right-handed, **Z-up**, one unit ≈ one inch. This matches Hammer/Source, and the
convention carries all the way through the engine — including the renderer, whose view
matrices use `Vector3.UnitZ` as up. Mixing Y-up rendering with Z-up authoring is a
reliable source of sign bugs, so there is exactly one convention and conversion happens
only at export boundaries (see `ObjExporter`).

Practical consequences of inch-scale units:

| Quantity | Value |
| --- | --- |
| Player eye height | ~64 |
| Comfortable corridor width | 128 |
| Standard door | 48 × 112 |
| World limit per axis | ±16384 |
| Editor grid sizes | powers of two, 1 … 512 |

Because coordinates reach ~16384, a 32-bit float only resolves about 0.002 units at the
world edge. Tolerances are sized for that reality: `MathUtil.OnEpsilon` is **0.01 units**,
not the `1e-6` you would use in normalized graphics code. Sub-micron tolerances at this
scale are pure noise.

## Layering

```
Forge.Core            geometry, CSG, map format, mesh building   (no dependencies)
      ↑
Forge.Runtime         MonoGame renderer, input, physics          (Phase 2)
      ↑                        ↑
Forge.Editor          Forge.Game
```

The one hard rule: **`Forge.Core` never references MonoGame.** Brush clipping and CSG are
the subtlest code in the engine, and keeping them free of graphics types means they can be
tested exhaustively with no device, no window, and no content pipeline. The test suite runs
in ~130 ms and needs nothing but a .NET SDK. `MeshBuilder` is the seam: it emits
`MeshVertex` structs laid out the way a GPU vertex buffer wants them, so the renderer
uploads batches without repacking.

## Plane convention

A plane is `dot(Normal, p) == Dist`, so signed distance is `dot(Normal, p) - Dist`.

Note this differs from `System.Numerics.Plane`, which stores `dot(N, p) + D == 0`. Forge
defines its own `Plane3` rather than reusing the BCL type specifically to avoid that sign
flip leaking in silently.

**Face normals point out of the solid.** Therefore:

> A brush's interior is the intersection of the **back** half-spaces of its faces.

That single sentence explains most of the geometry code. `Brush.Rebuild` derives each
face's polygon by starting from an infinite plane and clipping it behind every *other*
face's plane. Containment is "behind every face". CSG subtraction peels off the part of the
target in *front* of each cutter plane.

## Brushes: planes, not vertices

A `Brush` stores only planes. Polygons (`Winding`) are derived.

This is why dragging a face in a Hammer-style editor cannot tear a solid open: moving a
plane automatically re-cuts every neighbouring face. It also means a plane can legitimately
contribute *no* geometry — if the other half-spaces clip it away entirely, its winding is
`null`. That is normal, and it is how a redundant plane silently drops out.

`Brush.Volume` uses the divergence theorem: summing `dot(centroid, normal) * area` over a
closed surface gives three times the enclosed volume. It is nearly free to compute and
makes a precise invariant to assert CSG against — and a *negative* volume immediately
reveals inverted normals.

### Mirroring needs no special case

A half-space `dot(n, p) ≤ d` maps under matrix `M` to `dot(M⁻ᵀn, q) ≤ d′`. Because the
inverse-transpose carries the *gradient*, a negative determinant negates the normal on its
own and "outward" stays outward. Explicitly flipping planes on a mirror — which looks
correct by analogy with triangle winding order — turns solids inside out. Winding order is
not a concern either, since `Rebuild` regenerates polygons from planes afterwards.

## Texture projection

Textures are projected from **world space**, Valve 220 style: two axes, a pixel shift, a
scale in units-per-pixel, and a rotation about the face normal.

```
u = dot(p, UAxis) / UScale + UShift      (pixels; divide by texture width for UVs)
```

UVs are never stored per vertex. The payoff is that two independently created brushes
sharing a surface line up automatically with no manual work — the property that makes
brush-based level design feel seamless. `TextureTests.AdjacentBrushesShareContinuousUv`
pins this down.

Texture *lock* (materials staying glued to geometry as it moves) rewrites the projection
under transform: axes travel by the inverse-transpose, renormalising folds any length
change into the scale, and the shift is re-anchored so a reference point keeps its exact
coordinate.

## Numerical robustness

Three specific hazards, each with a deliberate countermeasure:

**Axial snapping during clipping.** When a split plane is axis-aligned, the interpolated
vertex is forced exactly onto it. Without this, clipping leaves values like `63.999996`
that compound across successive cuts until visible cracks open between brushes.

**Two-pass collinear removal.** Deduplicating vertices and testing collinearity in one pass
is subtly wrong: a duplicated corner makes *both* copies look degenerate to their
neighbours, so both are discarded and a real corner disappears. Collinearity is measured as
a perpendicular distance in world units, so the tolerance means the same thing for a
4-unit edge and a 4096-unit one.

**Negative zero.** `-0.0f` equals `+0.0f` everywhere in arithmetic but prints as `-0`. A
plane distance built as `-(0f)` is `-0`, while the same distance recovered from a dot
product sums to `+0` (IEEE addition of `+0` and `-0` yields `+0`). Left alone, that makes
saving a file twice produce different bytes. It is normalised at the formatting boundary.

## What the format guarantees

Face planes are stored as three points, not a normal and distance — three points are exact
integers for the axis-aligned geometry that dominates real levels.

- **Axis-aligned geometry round-trips bit-for-bit.**
- **Oblique geometry** (slopes, faceted cylinders) takes a one-time error on first save,
  bounded well under the 0.01-unit tolerance, because three points cannot reproduce an
  arbitrary plane's exact float bits.
- **That error never compounds.** Faces remember the exact points they were parsed from
  (`Face.SourcePoints`), so every subsequent save is byte-identical. Compounding drift is
  the dangerous failure mode: it would slowly crack welded geometry apart over many edit
  cycles.

Two related subtleties are worth knowing before touching the serializer:

*Point selection must be combinatorial.* Choosing the largest-area vertex triple sounds
better conditioned, but a regular polygon has many near-equal-area triples, so a one-ULP
change flips the winner and the stored points jump to entirely different vertices. Forge
picks evenly spaced indices instead, comparing no floats at all.

*Float formatting falls back to exact.* Values are written compactly (`64`, not
`64.000000`) when that representation round-trips, and at full `G9` precision when it does
not.

## Testing

`tests/Forge.Core.Tests` is a plain console app with a ~200-line reflection-based harness —
no xunit, no NuGet. That keeps the geometry kernel verifiable in any environment with a
.NET SDK, including offline CI images.

The tests that carry the most weight are the invariants:

- **Volume conservation** — carve fragments plus the removed overlap must reconstruct the
  original solid exactly.
- **Pointwise correctness** — a lattice of sample points confirms the carve result covers
  exactly `inside target AND NOT inside cutter`, and that fragments never overlap.
- **Idempotent serialization** — save, load, save must produce identical bytes. This is the
  test that caught both the negative-zero bug and the unstable point selection.
