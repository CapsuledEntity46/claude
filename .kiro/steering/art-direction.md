# Art direction

## Items and props are low-poly, not voxelised

**The voxel grid is for the world, not for the things in it.** Terrain, blocks you
place, and buildings are voxels because that is the game. Everything else —
weapons, shields, tools, torches, held items, pickups, decorative props — is
modelled as **free low-poly geometry with no grid restriction whatsoever**.

There is no requirement that an item look blocky or read as made of cubes. Use
whatever shapes suit the object:

- Tapered, pointed blades rather than rectangular slabs
- Cross-guards, ricassos, and pommels as separate turned shapes
- Kite and round shields as curved, bevelled plates with a rim and a boss
- Bows and crossbows as curved limbs, not stepped staircases
- Axe and mace heads as faceted wedges and flanges

Real triangles are fine. `LatheGeometry`, `ExtrudeGeometry`, `CylinderGeometry`,
`ConeGeometry`, and hand-built `BufferGeometry` are all fair game. Keep the
triangle budget modest and the silhouette readable — low *poly*, not low effort.

Still no external assets: geometry stays procedural and generated in code.

## What stays blocky

- Terrain and placed blocks (the voxel world itself)
- Particles — squares with whole-pixel sizes and quantised alpha, deliberately,
  so effects match the world rather than the items

## Scale of held items

Held items read far smaller on screen than they feel like they should. A shield
in particular has to occupy a substantial part of the lower view to read as
cover, and a torch has to be big enough that its flame is an obvious light
source. When in doubt, err large: a first-person item that looks correctly sized
in isolation is almost always too small in the viewport.
