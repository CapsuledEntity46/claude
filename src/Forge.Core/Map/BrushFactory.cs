using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>
/// Constructs the primitive solids the editor offers, mirroring Hammer's block tool:
/// block, wedge, cylinder, spike, and sphere, plus the "make hollow" shell operation.
/// <para>
/// Every primitive is expressed purely as a set of outward-facing planes. Vertices are
/// never authored directly, which guarantees the result is a closed convex solid.
/// </para>
/// </summary>
public static class BrushFactory
{
    /// <summary>Axis-aligned box. The workhorse primitive.</summary>
    public static Brush CreateBox(Aabb bounds, string? material = null, float textureScale = 0.25f)
    {
        var brush = new Brush();
        AddFace(brush, Vector3.UnitX, bounds.Max.X, material, textureScale);
        AddFace(brush, -Vector3.UnitX, -bounds.Min.X, material, textureScale);
        AddFace(brush, Vector3.UnitY, bounds.Max.Y, material, textureScale);
        AddFace(brush, -Vector3.UnitY, -bounds.Min.Y, material, textureScale);
        AddFace(brush, Vector3.UnitZ, bounds.Max.Z, material, textureScale);
        AddFace(brush, -Vector3.UnitZ, -bounds.Min.Z, material, textureScale);
        brush.Rebuild();
        return brush;
    }

    public static Brush CreateBox(Vector3 min, Vector3 max, string? material = null)
        => CreateBox(new Aabb(Vector3.Min(min, max), Vector3.Max(min, max)), material);

    /// <summary>
    /// Right triangular prism: a box with one vertical edge collapsed. The slope rises
    /// along +Z as X decreases, and the prism extrudes along Y.
    /// </summary>
    public static Brush CreateWedge(Aabb bounds, string? material = null, float textureScale = 0.25f)
    {
        var brush = new Brush();
        float dx = bounds.Max.X - bounds.Min.X;
        float dz = bounds.Max.Z - bounds.Min.Z;

        AddFace(brush, -Vector3.UnitZ, -bounds.Min.Z, material, textureScale);   // floor
        AddFace(brush, -Vector3.UnitX, -bounds.Min.X, material, textureScale);   // vertical back
        AddFace(brush, Vector3.UnitY, bounds.Max.Y, material, textureScale);     // cap
        AddFace(brush, -Vector3.UnitY, -bounds.Min.Y, material, textureScale);   // cap

        // Hypotenuse from (max.X, min.Z) up to (min.X, max.Z); normal leans +X/+Z.
        Vector3 slope = Vector3.Normalize(new Vector3(dz, 0f, dx));
        float dist = Vector3.Dot(slope, new Vector3(bounds.Max.X, 0f, bounds.Min.Z));
        AddFace(brush, slope, dist, material, textureScale);

        brush.Rebuild();
        return brush;
    }

    /// <summary>
    /// Prism with <paramref name="sides"/> faces inscribed in the bounding box's XY
    /// footprint, extruded along Z. With 6-16 sides this is the standard way to build
    /// pillars and tunnels.
    /// </summary>
    public static Brush CreateCylinder(Aabb bounds, int sides = 8, string? material = null, float angleOffsetDegrees = 0f, float textureScale = 0.25f)
    {
        if (sides < 3) throw new ArgumentOutOfRangeException(nameof(sides), "A prism needs at least 3 sides.");

        var brush = new Brush();
        AddFace(brush, Vector3.UnitZ, bounds.Max.Z, material, textureScale);
        AddFace(brush, -Vector3.UnitZ, -bounds.Min.Z, material, textureScale);

        Vector2[] ring = BuildRing(bounds, sides, angleOffsetDegrees);
        for (int i = 0; i < sides; i++)
        {
            Vector2 a = ring[i];
            Vector2 b = ring[(i + 1) % sides];
            Vector2 edge = b - a;
            // Outward normal of a counter-clockwise ring is (dy, -dx).
            var normal = new Vector3(edge.Y, -edge.X, 0f);
            float length = normal.Length();
            if (length < MathUtil.Epsilon) continue;
            normal /= length;
            AddFace(brush, normal, Vector3.Dot(normal, new Vector3(a.X, a.Y, 0f)), material, textureScale);
        }

        brush.Rebuild();
        return brush;
    }

    /// <summary>Cone/pyramid rising from the box's floor to a single apex at the top centre.</summary>
    public static Brush CreateSpike(Aabb bounds, int sides = 8, string? material = null, float angleOffsetDegrees = 0f, float textureScale = 0.25f)
    {
        if (sides < 3) throw new ArgumentOutOfRangeException(nameof(sides), "A cone needs at least 3 sides.");

        var brush = new Brush();
        AddFace(brush, -Vector3.UnitZ, -bounds.Min.Z, material, textureScale);

        Vector2[] ring = BuildRing(bounds, sides, angleOffsetDegrees);
        Vector3 center = bounds.Center;
        var apex = new Vector3(center.X, center.Y, bounds.Max.Z);

        for (int i = 0; i < sides; i++)
        {
            var a = new Vector3(ring[i].X, ring[i].Y, bounds.Min.Z);
            var b = new Vector3(ring[(i + 1) % sides].X, ring[(i + 1) % sides].Y, bounds.Min.Z);
            if (!Plane3.IsValidTriangle(a, b, apex)) continue;
            AddFace(brush, Plane3.FromPoints(a, b, apex), material, textureScale);
        }

        brush.Rebuild();
        return brush;
    }

    /// <summary>
    /// Convex approximation of an ellipsoid built from tangent planes sampled on a
    /// latitude/longitude grid. <paramref name="sides"/> controls the longitudinal
    /// resolution; latitude rings are half that.
    /// </summary>
    public static Brush CreateSphere(Aabb bounds, int sides = 8, string? material = null, float textureScale = 0.25f)
    {
        if (sides < 3) throw new ArgumentOutOfRangeException(nameof(sides), "A sphere needs at least 3 sides.");

        int rings = Math.Max(1, sides / 2);
        var brush = new Brush();

        // Build a unit sphere from tangent planes, then squash it into the bounds. Doing
        // it in that order keeps the tangency exact under non-uniform scaling.
        AddFace(brush, Vector3.UnitZ, 1f, material, textureScale);
        AddFace(brush, -Vector3.UnitZ, 1f, material, textureScale);

        for (int ring = 1; ring < rings; ring++)
        {
            float phi = MathF.PI * ring / rings;   // 0 at +Z pole
            float sinPhi = MathF.Sin(phi);
            float cosPhi = MathF.Cos(phi);

            for (int i = 0; i < sides; i++)
            {
                float theta = MathF.Tau * i / sides;
                var normal = new Vector3(
                    sinPhi * MathF.Cos(theta),
                    sinPhi * MathF.Sin(theta),
                    cosPhi);
                AddFace(brush, Vector3.Normalize(normal), 1f, material, textureScale);
            }
        }

        Vector3 extents = bounds.Extents;
        Matrix4x4 transform = Matrix4x4.CreateScale(
                                  MathF.Max(extents.X, MathUtil.Epsilon),
                                  MathF.Max(extents.Y, MathUtil.Epsilon),
                                  MathF.Max(extents.Z, MathUtil.Epsilon))
                            * Matrix4x4.CreateTranslation(bounds.Center);

        brush.Rebuild();
        brush.Transform(transform, textureLock: false);
        foreach (Face face in brush.Faces)
            face.Texture = TextureAlignment.ForNormal(face.Plane.Normal, textureScale);
        brush.Rebuild();
        return brush;
    }

    /// <summary>
    /// Builds a solid directly from a plane set. Returns null when the planes do not
    /// bound a finite volume, which is the caller's cue that the input was malformed.
    /// </summary>
    public static Brush? CreateFromPlanes(IEnumerable<Plane3> planes, string? material = null, float textureScale = 0.25f)
    {
        var brush = new Brush();
        foreach (Plane3 plane in planes)
            AddFace(brush, plane, material, textureScale);

        brush.Rebuild();
        return brush.IsValid ? brush : null;
    }

    /// <summary>
    /// Hammer's "Make Hollow": replaces a solid with a shell of walls of the given
    /// thickness. Each output brush spans one original face and its inward offset.
    /// <para>
    /// Like Hammer, the resulting walls overlap at the corners. That is harmless for
    /// rendering and collision, and it keeps the shell watertight without mitre joints.
    /// </para>
    /// </summary>
    /// <param name="thickness">Wall thickness in units. Positive hollows inward.</param>
    public static List<Brush> Hollow(Brush source, float thickness, string? interiorMaterial = null)
    {
        if (thickness <= 0f) throw new ArgumentOutOfRangeException(nameof(thickness), "Wall thickness must be positive.");

        var walls = new List<Brush>(source.Faces.Count);

        foreach (Face face in source.Faces)
        {
            Brush wall = source.Clone();

            // Offset this face's plane inward by `thickness` and flip it to face inward,
            // so the wall occupies the slab between the two planes.
            var inner = new Plane3(-face.Plane.Normal, thickness - face.Plane.Dist);
            var innerFace = new Face(inner, interiorMaterial ?? face.Material)
            {
                LightmapScale = face.LightmapScale,
            };
            innerFace.Flags = MaterialDefaults.FlagsFor(innerFace.Material);
            wall.AddFace(innerFace);

            wall.Rebuild();
            if (wall.IsValid) walls.Add(wall);
        }

        return walls;
    }

    /// <summary>
    /// Convenience helper: an enclosed room built as a hollow box, with the floor,
    /// ceiling, and walls as separate solids.
    /// </summary>
    public static List<Brush> CreateRoom(Aabb outerBounds, float wallThickness = 16f, string? material = null)
        => Hollow(CreateBox(outerBounds, material), wallThickness);

    private static Vector2[] BuildRing(Aabb bounds, int sides, float angleOffsetDegrees)
    {
        Vector3 center = bounds.Center;
        Vector3 extents = bounds.Extents;
        float offset = MathUtil.DegToRad(angleOffsetDegrees);

        var ring = new Vector2[sides];
        for (int i = 0; i < sides; i++)
        {
            float theta = MathF.Tau * i / sides + offset;
            ring[i] = new Vector2(
                center.X + extents.X * MathF.Cos(theta),
                center.Y + extents.Y * MathF.Sin(theta));
        }
        return ring;
    }

    private static void AddFace(Brush brush, Vector3 normal, float dist, string? material, float textureScale)
        => AddFace(brush, new Plane3(normal, dist), material, textureScale);

    private static void AddFace(Brush brush, Plane3 plane, string? material, float textureScale)
    {
        var face = new Face(plane, material, textureScale)
        {
            Flags = MaterialDefaults.FlagsFor(material ?? MaterialDefaults.Placeholder),
        };
        brush.AddFace(face);
    }
}
