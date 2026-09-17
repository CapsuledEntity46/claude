using System.Numerics;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Export;

/// <summary>
/// A single render-ready vertex. Field order and types deliberately match what a GPU
/// vertex buffer wants, so the renderer can upload a batch without repacking.
/// </summary>
public readonly struct MeshVertex
{
    public readonly Vector3 Position;
    public readonly Vector3 Normal;
    public readonly Vector2 TexCoord;

    public MeshVertex(Vector3 position, Vector3 normal, Vector2 texCoord)
    {
        Position = position;
        Normal = normal;
        TexCoord = texCoord;
    }
}

/// <summary>All triangles in a level that share one material, ready to draw in one call.</summary>
public sealed class MeshBatch
{
    public MeshBatch(string material) => Material = material;

    public string Material { get; }

    public List<MeshVertex> Vertices { get; } = new();

    public List<int> Indices { get; } = new();

    public int TriangleCount => Indices.Count / 3;

    public Aabb Bounds => Aabb.FromPoints(Vertices.Select(v => v.Position));

    public override string ToString() => $"{Material}: {Vertices.Count} verts, {TriangleCount} tris";
}

/// <summary>
/// Turns brush faces into triangle batches grouped by material.
/// <para>
/// This is the bridge between the editing representation and anything that draws:
/// the MonoGame renderer, the OBJ exporter, and the compiled level format all consume
/// its output. It is intentionally free of graphics API types so the geometry pipeline
/// stays testable without a device.
/// </para>
/// <para>
/// Normals are flat per face, which is correct for brush geometry. Smoothing groups are
/// recorded on faces but not yet applied here.
/// </para>
/// </summary>
public static class MeshBuilder
{
    /// <summary>Assumed texture dimensions when a material's real size is unknown.</summary>
    public const int DefaultTextureSize = 128;

    /// <summary>
    /// Builds batches from a set of brushes.
    /// </summary>
    /// <param name="textureSizeResolver">
    /// Supplies pixel dimensions per material path. Texture size participates in the UV
    /// calculation, so a wrong answer here shows up as mis-scaled textures rather than
    /// broken geometry.
    /// </param>
    /// <param name="skipNonVisible">
    /// Drops faces flagged <see cref="SurfaceFlags.NoDraw"/> or <see cref="SurfaceFlags.Skip"/>.
    /// </param>
    public static List<MeshBatch> Build(
        IEnumerable<Brush> brushes,
        Func<string, (int Width, int Height)>? textureSizeResolver = null,
        bool skipNonVisible = true)
    {
        ArgumentNullException.ThrowIfNull(brushes);
        textureSizeResolver ??= _ => (DefaultTextureSize, DefaultTextureSize);

        var batches = new Dictionary<string, MeshBatch>(StringComparer.OrdinalIgnoreCase);
        var sizeCache = new Dictionary<string, (int Width, int Height)>(StringComparer.OrdinalIgnoreCase);

        foreach (Brush brush in brushes)
        {
            if (!brush.GeometryValid) brush.Rebuild();

            foreach (Face face in brush.Faces)
            {
                if (!face.HasGeometry) continue;
                if (skipNonVisible && (face.Flags.HasFlag(SurfaceFlags.NoDraw) || face.Flags.HasFlag(SurfaceFlags.Skip)))
                    continue;

                if (!batches.TryGetValue(face.Material, out MeshBatch? batch))
                {
                    batch = new MeshBatch(face.Material);
                    batches[face.Material] = batch;
                }

                if (!sizeCache.TryGetValue(face.Material, out (int Width, int Height) size))
                {
                    size = textureSizeResolver(face.Material);
                    if (size.Width <= 0) size = (DefaultTextureSize, size.Height);
                    if (size.Height <= 0) size = (size.Width, DefaultTextureSize);
                    sizeCache[face.Material] = size;
                }

                AppendFace(batch, face, size.Width, size.Height);
            }
        }

        return batches.Values
            .Where(b => b.Indices.Count > 0)
            .OrderBy(b => b.Material, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static List<MeshBatch> Build(
        MapDocument document,
        Func<string, (int Width, int Height)>? textureSizeResolver = null,
        bool skipNonVisible = true)
        => Build(document.AllBrushes, textureSizeResolver, skipNonVisible);

    private static void AppendFace(MeshBatch batch, Face face, int textureWidth, int textureHeight)
    {
        Winding winding = face.Winding!;
        Vector3 normal = face.Plane.Normal;
        int baseIndex = batch.Vertices.Count;

        for (int i = 0; i < winding.Count; i++)
        {
            Vector3 position = winding[i];
            batch.Vertices.Add(new MeshVertex(position, normal, face.GetUV(position, textureWidth, textureHeight)));
        }

        // Windings are convex, so a triangle fan is always valid.
        for (int i = 1; i < winding.Count - 1; i++)
        {
            batch.Indices.Add(baseIndex);
            batch.Indices.Add(baseIndex + i);
            batch.Indices.Add(baseIndex + i + 1);
        }
    }

    /// <summary>Total triangle count across batches, for statistics and budget checks.</summary>
    public static int CountTriangles(IEnumerable<MeshBatch> batches) => batches.Sum(b => b.TriangleCount);
}
