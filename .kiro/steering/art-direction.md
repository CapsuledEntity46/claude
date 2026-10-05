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

**Geometry stays procedural and generated in code.** No model is ever loaded at
runtime. That rule is about *shape*, and it is not negotiable: a silhouette that
can only be changed in Blender cannot be tuned against the game.

## Block textures may be authored

Surface *texture* is the one exception, and only for the voxel world's own blocks.
Authored source art lives in `assets/blocks/` as `.glb`, and `npm run tiles` bakes
it down into committed atlas tiles in `public/textures/`.

The rules that keep that from leaking:

- **Nothing authored is loaded at runtime in its source form.** The GLBs are
  ~2.5 MB each; the tiles baked out of them are ~85 KB. The bake is offline and
  its output is committed, so a checkout needs no build step.
- **Only the colour is taken, never the mesh.** These files happen to contain a
  cube. The cube is not the asset — the baked maps on it are.
- **Every authored tile has a procedural fallback painted in code.** The atlas is
  complete and correct before any fetch resolves, the authored sheets merely
  composite over it, and a failed request costs the painted look and nothing
  else. Startup never waits on a texture.
- **Items, creatures, props and particles get none of this.** They stay fully
  procedural, colour included.

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
