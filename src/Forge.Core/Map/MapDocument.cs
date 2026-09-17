using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>A simple 8-bit-per-channel colour, used for editor display only.</summary>
public readonly struct ColorRgb
{
    public readonly byte R;
    public readonly byte G;
    public readonly byte B;

    public ColorRgb(byte r, byte g, byte b)
    {
        R = r;
        G = g;
        B = b;
    }

    public static ColorRgb White => new(255, 255, 255);

    public override string ToString() => $"{R} {G} {B}";
}

/// <summary>
/// A named, toggleable set of objects. Visgroups are how designers keep a dense level
/// workable, hiding lighting, clip brushes, or a whole floor while working.
/// </summary>
public sealed class VisGroup
{
    public string Name = "Group";
    public bool Visible = true;
    public ColorRgb Color = ColorRgb.White;

    public VisGroup Clone() => new() { Name = Name, Visible = Visible, Color = Color };

    public override string ToString() => $"{Name} ({(Visible ? "visible" : "hidden")})";
}

/// <summary>A saved viewport position the designer can jump back to.</summary>
public sealed class CameraBookmark
{
    public Vector3 Position = new(0, -256, 128);
    public Vector3 Look = Vector3.Zero;

    public CameraBookmark Clone() => new() { Position = Position, Look = Look };
}

/// <summary>
/// An entire level as the editor sees it: the world's solids, its entities, and editor
/// metadata.
/// <para>
/// This is the authoring representation, kept deliberately close to what the designer
/// manipulates. It is not what the game loads; a compile step turns this into visibility
/// structures, collision hulls, and render batches. Keeping the two apart means the
/// editor never has to care about compile-time optimisation, and the runtime never has to
/// carry editing concerns.
/// </para>
/// </summary>
public sealed class MapDocument
{
    public const int CurrentFormatVersion = 1;

    private int _nextId = 1;

    /// <summary>
    /// The world itself. Holds global keys such as <c>skyname</c> and, by convention, has
    /// classname <c>worldspawn</c>.
    /// </summary>
    public Entity Worldspawn { get; } = new("worldspawn");

    /// <summary>Static solids that make up the level's structure.</summary>
    public List<Brush> WorldBrushes { get; } = new();

    public List<Entity> Entities { get; } = new();

    public List<VisGroup> VisGroups { get; } = new();

    public List<CameraBookmark> Cameras { get; } = new();

    public int ActiveCamera;

    /// <summary>Path this document was loaded from or last saved to.</summary>
    public string? FilePath;

    public string SkyName
    {
        get => Worldspawn.GetString("skyname", "sky_day01");
        set => Worldspawn.SetString("skyname", value);
    }

    /// <summary>Hands out a document-unique id. Ids are stable across a save/load cycle.</summary>
    public int AllocateId() => _nextId++;

    /// <summary>Ensures the allocator will not reissue an id already present in the document.</summary>
    public void ReserveId(int id)
    {
        if (id >= _nextId) _nextId = id + 1;
    }

    /// <summary>Every brush in the document, world and entity-owned alike.</summary>
    public IEnumerable<Brush> AllBrushes
    {
        get
        {
            foreach (Brush brush in WorldBrushes) yield return brush;
            foreach (Entity entity in Entities)
            {
                foreach (Brush brush in entity.Brushes) yield return brush;
            }
        }
    }

    public IEnumerable<Face> AllFaces
    {
        get
        {
            foreach (Brush brush in AllBrushes)
            {
                foreach (Face face in brush.Faces) yield return face;
            }
        }
    }

    public void AddWorldBrush(Brush brush)
    {
        if (brush.Id == 0) brush.Id = AllocateId();
        AssignFaceIds(brush);
        WorldBrushes.Add(brush);
    }

    public void AddWorldBrushes(IEnumerable<Brush> brushes)
    {
        foreach (Brush brush in brushes) AddWorldBrush(brush);
    }

    public void AddEntity(Entity entity)
    {
        if (entity.Id == 0) entity.Id = AllocateId();
        foreach (Brush brush in entity.Brushes)
        {
            if (brush.Id == 0) brush.Id = AllocateId();
            brush.Contents |= BrushContents.Entity;
            AssignFaceIds(brush);
        }
        Entities.Add(entity);
    }

    private void AssignFaceIds(Brush brush)
    {
        foreach (Face face in brush.Faces)
        {
            if (face.Id == 0) face.Id = AllocateId();
        }
    }

    /// <summary>Fills in ids for anything created without one, e.g. by CSG operations.</summary>
    public void AssignMissingIds()
    {
        if (Worldspawn.Id == 0) Worldspawn.Id = AllocateId();

        foreach (Brush brush in WorldBrushes)
        {
            if (brush.Id == 0) brush.Id = AllocateId();
            AssignFaceIds(brush);
        }
        foreach (Entity entity in Entities)
        {
            if (entity.Id == 0) entity.Id = AllocateId();
            foreach (Brush brush in entity.Brushes)
            {
                if (brush.Id == 0) brush.Id = AllocateId();
                AssignFaceIds(brush);
            }
        }
    }

    /// <summary>Regenerates polygons for every brush. Call after bulk plane edits or loading.</summary>
    public void RebuildAll()
    {
        foreach (Brush brush in AllBrushes) brush.Rebuild();
    }

    public Aabb ComputeBounds()
    {
        Aabb bounds = Aabb.Empty;
        foreach (Brush brush in AllBrushes) bounds = bounds.Union(brush.Bounds);
        foreach (Entity entity in Entities)
        {
            if (entity.IsPointEntity) bounds = bounds.Union(entity.Origin);
        }
        return bounds;
    }

    public IEnumerable<Entity> FindByClassName(string className)
        => Entities.Where(e => string.Equals(e.ClassName, className, StringComparison.OrdinalIgnoreCase));

    public Entity? FindByTargetName(string targetName)
        => Entities.FirstOrDefault(e => string.Equals(e.TargetName, targetName, StringComparison.OrdinalIgnoreCase));

    /// <summary>Distinct material paths referenced anywhere in the document.</summary>
    public IEnumerable<string> GetUsedMaterials()
        => AllFaces.Select(f => f.Material).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(m => m, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Reports structural problems a designer needs to fix before compiling: malformed
    /// solids, out-of-bounds geometry, missing spawn points, and dangling entity I/O.
    /// </summary>
    public List<string> Validate()
    {
        var problems = new List<string>();

        foreach (Brush brush in AllBrushes)
        {
            brush.Rebuild();
            if (!brush.IsValid)
            {
                problems.Add($"Brush #{brush.Id} is not a closed convex solid ({brush.Faces.Count} planes).");
                continue;
            }
            if (!brush.Bounds.Contains(new Aabb(new Vector3(-MathUtil.MaxWorldCoord), new Vector3(MathUtil.MaxWorldCoord))) &&
                (MathF.Abs(brush.Bounds.Min.X) > MathUtil.MaxWorldCoord ||
                 MathF.Abs(brush.Bounds.Min.Y) > MathUtil.MaxWorldCoord ||
                 MathF.Abs(brush.Bounds.Min.Z) > MathUtil.MaxWorldCoord ||
                 MathF.Abs(brush.Bounds.Max.X) > MathUtil.MaxWorldCoord ||
                 MathF.Abs(brush.Bounds.Max.Y) > MathUtil.MaxWorldCoord ||
                 MathF.Abs(brush.Bounds.Max.Z) > MathUtil.MaxWorldCoord))
            {
                problems.Add($"Brush #{brush.Id} extends outside the {MathUtil.MaxWorldCoord:0} unit world limit.");
            }
        }

        if (!FindByClassName("info_player_start").Any())
            problems.Add("No info_player_start entity: the player has nowhere to spawn.");

        foreach (Entity entity in Entities)
        {
            foreach (Output output in entity.Outputs)
            {
                if (string.IsNullOrWhiteSpace(output.TargetEntity)) continue;
                bool exists = Entities.Any(e => string.Equals(e.TargetName, output.TargetEntity, StringComparison.OrdinalIgnoreCase));
                if (!exists)
                    problems.Add($"{entity.ClassName}#{entity.Id} output '{output.Name}' targets unknown entity '{output.TargetEntity}'.");
            }
        }

        return problems;
    }

    public override string ToString()
        => $"MapDocument ({WorldBrushes.Count} world brushes, {Entities.Count} entities)";
}
