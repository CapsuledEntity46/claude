using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>
/// Per-surface behaviour hints. These mirror the "tool texture" concept from Hammer,
/// where a material name implies compile-time semantics, but are stored explicitly so
/// the compiler never has to string-match material paths.
/// </summary>
[Flags]
public enum SurfaceFlags
{
    None = 0,
    /// <summary>Collides but is never rendered. Faces sealed inside geometry.</summary>
    NoDraw = 1 << 0,
    /// <summary>Removed entirely at compile time. Used on hint/skip brush sides.</summary>
    Skip = 1 << 1,
    /// <summary>Forces a BSP split along this plane without generating geometry.</summary>
    Hint = 1 << 2,
    /// <summary>Rendered as the skybox; also marks leaves as outdoors.</summary>
    Sky = 1 << 3,
    /// <summary>Excluded from lightmap packing; lit per-vertex or unlit.</summary>
    NoLightmap = 1 << 4,
    /// <summary>Surface scrolls or animates; the compiler keeps it in its own batch.</summary>
    Dynamic = 1 << 5,
}

/// <summary>
/// One side of a brush: an outward-facing plane plus its material and projection.
/// <para>
/// A face does not store its own polygon. The polygon (<see cref="Winding"/>) is
/// <i>derived</i> by intersecting the brush's half-spaces, which is the defining
/// property of brush-based geometry: dragging a face's plane automatically re-cuts
/// every neighbouring face, so a solid can never be torn open.
/// </para>
/// </summary>
public sealed class Face
{
    public int Id;

    /// <summary>The face's plane, with the normal pointing <b>out</b> of the solid.</summary>
    public Plane3 Plane;

    /// <summary>Material path, e.g. <c>dev/dev_measuregeneric01</c>.</summary>
    public string Material = MaterialDefaults.Placeholder;

    public TextureAlignment Texture = new();

    /// <summary>World units per lightmap sample. Lower is higher quality and more memory.</summary>
    public float LightmapScale = 16f;

    /// <summary>
    /// Bitmask of smoothing groups. Faces sharing a bit get averaged vertex normals,
    /// which is how curved-looking surfaces are built out of flat brush sides.
    /// </summary>
    public int SmoothingGroups;

    public SurfaceFlags Flags = SurfaceFlags.None;

    /// <summary>
    /// The polygon carved out of this face's plane by the rest of the brush. Null until
    /// <see cref="Brush.Rebuild"/> runs, or when the face contributes no surface area
    /// (a plane that the other half-spaces cut away entirely).
    /// </summary>
    public Winding? Winding { get; internal set; }

    /// <summary>
    /// The exact three points this plane was last serialised from or parsed into, or null
    /// if the plane has never been through the file format.
    /// <para>
    /// Carrying these along makes a load/save cycle bit-for-bit lossless. Without them the
    /// writer has to re-derive three points from the generated polygon, and for an oblique
    /// plane that reconstruction is not the exact float it started as - so merely opening
    /// and saving a level would nudge every slanted surface. Transforms carry these points
    /// with the plane; anything that sets a plane outright clears them, and the writer
    /// re-checks that they still describe the current plane before trusting them.
    /// </para>
    /// </summary>
    public Vector3[]? SourcePoints;

    public Vector3 Normal => Plane.Normal;

    public bool HasGeometry => Winding is { Count: >= 3 };

    public Face()
    {
    }

    public Face(Plane3 plane, string? material = null, float textureScale = 0.25f)
    {
        Plane = plane;
        Material = material ?? MaterialDefaults.Placeholder;
        Texture = TextureAlignment.ForNormal(plane.Normal, textureScale);
    }

    /// <summary>Creates a face from three points wound counter-clockwise as seen from outside.</summary>
    public static Face FromPoints(Vector3 a, Vector3 b, Vector3 c, string? material = null)
        => new(Plane3.FromPoints(a, b, c), material);

    /// <summary>Re-derives texture axes for the current plane.</summary>
    public void AlignTexture(TextureAlignmentMode mode) => Texture.Align(Plane.Normal, mode);

    /// <summary>Normalised UV for a world position on this face.</summary>
    public Vector2 GetUV(Vector3 worldPosition, int textureWidth, int textureHeight)
        => Texture.GetUV(worldPosition, textureWidth, textureHeight);

    /// <summary>Area of the generated polygon, or zero if the face carries no geometry.</summary>
    public float Area => Winding?.Area ?? 0f;

    /// <summary>Centroid of the generated polygon.</summary>
    public Vector3 Center => Winding?.Center ?? Plane.Origin;

    public Face Clone() => new()
    {
        Id = Id,
        Plane = Plane,
        Material = Material,
        Texture = Texture.Clone(),
        LightmapScale = LightmapScale,
        SmoothingGroups = SmoothingGroups,
        Flags = Flags,
        Winding = Winding?.Clone(),
        SourcePoints = SourcePoints is null ? null : (Vector3[])SourcePoints.Clone(),
    };

    public override string ToString() => $"Face #{Id} {Material} {Plane}";
}

/// <summary>Well-known material paths the editor and compiler special-case.</summary>
public static class MaterialDefaults
{
    /// <summary>Default material applied to freshly created brushes.</summary>
    public const string Placeholder = "dev/dev_measuregeneric01";

    /// <summary>Invisible but solid. Sides that face into other solids get this.</summary>
    public const string NoDraw = "tools/toolsnodraw";

    /// <summary>Renders the sky and marks the leaf as outdoors.</summary>
    public const string Sky = "tools/toolsskybox";

    /// <summary>Blocks the player but not projectiles or sight.</summary>
    public const string PlayerClip = "tools/toolsplayerclip";

    /// <summary>Guides BSP splitting without producing visible geometry.</summary>
    public const string Hint = "tools/toolshint";

    /// <summary>Faces of a hint brush that should not become hint planes.</summary>
    public const string Skip = "tools/toolsskip";

    /// <summary>Applied to trigger volumes; invisible and non-solid at runtime.</summary>
    public const string Trigger = "tools/toolstrigger";

    /// <summary>Maps a material path to the surface flags it implies.</summary>
    public static SurfaceFlags FlagsFor(string material) => material.Replace('\\', '/').ToLowerInvariant() switch
    {
        NoDraw => SurfaceFlags.NoDraw,
        Sky => SurfaceFlags.Sky | SurfaceFlags.NoLightmap,
        PlayerClip => SurfaceFlags.NoDraw,
        Hint => SurfaceFlags.Hint | SurfaceFlags.Skip,
        Skip => SurfaceFlags.Skip,
        Trigger => SurfaceFlags.NoDraw,
        _ => SurfaceFlags.None,
    };
}
