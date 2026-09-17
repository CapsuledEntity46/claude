# The `.tmap` level format

A brace-and-quote text format, closely modelled on Valve's VMF.

Text rather than JSON or binary, because a level is a long-lived collaborative document.
A line-oriented format produces reviewable diffs, survives merge conflicts, and can be
hand-edited or grepped. Saving a loaded map is byte-identical, so version control never
shows spurious churn.

## Syntax

```
blockname
{
    "key" "value"
    childblock
    {
        "key" "value"
    }
}
```

- Block names are bare words; keys and values are always quoted.
- `//` starts a line comment.
- `\"` and `\\` are the only escapes. Other backslashes are literal, so
  `"materials\stone\wall"` needs no escaping.
- **Duplicate keys are legal and ordered.** Entity outputs depend on this.
- Unknown blocks and keys are preserved-or-ignored rather than rejected, so a file written
  by a newer build still loads.

## Document structure

Top level is a sequence of blocks, with no single root:

| Block | Purpose |
| --- | --- |
| `versioninfo` | Format version and generator |
| `visgroups` | Named show/hide groups for the editor |
| `world` | Worldspawn keys plus every static `solid` |
| `entity` | One per entity; may contain `solid` blocks and a `connections` block |
| `cameras` | Saved viewport bookmarks |

## Geometry

```
solid
{
    "id" "1"
    "contents" "solid"
    side
    {
        "id" "2"
        "plane" "(384 -384 256) (384 -384 -16) (384 384 -16)"
        "material" "concrete/wall01"
        "uaxis" "[0 1 0 0] 0.25"
        "vaxis" "[0 0 -1 0] 0.25"
        "rotation" "0"
        "lightmapscale" "16"
    }
}
```

A `solid` is a convex volume defined by the intersection of its sides' half-spaces. Each
`side` stores only a plane — polygons are derived at load time. A side needs no explicit
vertices, and a solid needs at least four sides that contribute area.

### `plane`

Three points, **counter-clockwise as seen from outside the solid**. The normal is
`normalize(cross(b - a, c - a))` and points *out* of the volume.

Three points rather than a normal and distance because axis-aligned geometry — the bulk of
any real level — is then stored as exact integers, and a human can read a face's position
straight off the file. See [ARCHITECTURE.md](ARCHITECTURE.md#what-the-format-guarantees)
for the precision guarantees.

### `uaxis` / `vaxis`

`[x y z shift] scale` — a world-space axis, a pixel offset, and world units per pixel.
Smaller scale means the texture appears smaller and tiles more often; `0.25` means a
128-pixel texture covers 32 units.

### `contents`

Space-separated names, written for readability rather than as a bitmask. A plain integer is
also accepted.

`solid` · `detail` · `playerclip` · `trigger` · `water` · `ladder` · `entity`

`detail` marks geometry that does not seal visibility. `entity` is applied automatically to
solids owned by a brush entity.

### `flags` (optional, per side)

`nodraw` · `skip` · `hint` · `sky` · `nolightmap` · `dynamic`

Omitted when a side has no flags; then they are inferred from the material path (for
example `tools/toolsnodraw` implies `nodraw`).

## Entities

```
entity
{
    "id" "20"
    "classname" "func_button"
    "targetname" "hall_button"
    "origin" "96 360 64"
    connections
    {
        "OnPressed" "hall_door,Open,,0,-1"
    }
}
```

Entities are schemaless key/value bags. The editor learns which keys an entity supports
from its FGD definition at runtime, so adding a gameplay type never requires changing the
editor or this format.

Keys are written in a stable order — `classname`, `targetname`, `origin`, `angles` first,
then the rest alphabetically — so output is deterministic.

An entity containing `solid` blocks is a *brush entity* (a door, a trigger volume);
otherwise it is a *point entity* (a light, a spawn point).

### `connections`

Source-style entity I/O. The value is
`targetEntity,targetInput,parameter,delay,timesToFire`, where `timesToFire` of `-1` means
unlimited. Trailing fields may be omitted. Because duplicate keys are preserved, one event
can fire several outputs.

## Editor metadata

```
visgroups
{
    visgroup
    {
        "name" "Lighting"
        "visible" "1"
        "color" "255 220 100"
    }
}
cameras
{
    "activecamera" "0"
    camera
    {
        "position" "(0 -640 220)"
        "look" "(0 0 96)"
    }
}
```

## Ids

Every solid, side, and entity carries a document-unique integer `id`, stable across
save/load. The reader reserves loaded ids so freshly allocated ones cannot collide.

## Validation

`forge validate <map.tmap>` exits non-zero and reports:

- solids that are not closed convex volumes
- geometry beyond the ±16384-unit world limit
- a missing `info_player_start`
- entity outputs targeting a `targetname` that does not exist
