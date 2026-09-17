using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>
/// Constructive solid geometry on convex brushes.
/// <para>
/// Every operation here reduces to clipping half-spaces, which is what makes
/// brush-based editing tractable: there is no mesh boolean, no vertex welding, and no
/// tolerance-sensitive edge intersection. A subtraction is just a sequence of plane
/// splits, and the result is always a set of well-formed convex solids.
/// </para>
/// </summary>
public static class Csg
{
    /// <summary>
    /// Splits a brush by a plane. Either output is null when the brush lies wholly on
    /// one side. The front piece is the part on the side the normal points toward.
    /// </summary>
    /// <param name="template">
    /// Supplies the material and projection for the newly exposed face. When null, the
    /// material is inherited from whichever existing face points most similarly, which
    /// is what makes the editor's clip tool produce sensible textures.
    /// </param>
    public static void Split(Brush brush, Plane3 plane, out Brush? front, out Brush? back, Face? template = null)
    {
        ArgumentNullException.ThrowIfNull(brush);

        List<Vector3> vertices = brush.GetVertices();
        PlaneSide side = plane.ClassifyPoints(vertices);

        if (side is PlaneSide.Front or PlaneSide.On)
        {
            front = brush.Clone();
            back = null;
            return;
        }
        if (side == PlaneSide.Back)
        {
            front = null;
            back = brush.Clone();
            return;
        }

        // Interior lies behind each face, so the piece in *front* of `plane` is bounded
        // by the flipped plane, and the piece behind it by the plane itself.
        front = BuildPiece(brush, plane.Flipped, template);
        back = BuildPiece(brush, plane, template);
    }

    private static Brush? BuildPiece(Brush source, Plane3 boundary, Face? template)
    {
        Brush piece = source.Clone();

        var face = new Face(boundary, template?.Material ?? PickMaterialFor(source, boundary));
        if (template is not null)
        {
            face.Texture = template.Texture.Clone();
            face.LightmapScale = template.LightmapScale;
            face.SmoothingGroups = template.SmoothingGroups;
        }
        face.Texture.Align(boundary.Normal, TextureAlignmentMode.World);
        face.Flags = MaterialDefaults.FlagsFor(face.Material);

        piece.AddFace(face);
        piece.Rebuild();
        return piece.IsValid ? piece : null;
    }

    /// <summary>
    /// Picks the material of the existing face whose normal best matches
    /// <paramref name="plane"/>, so a newly cut surface blends in with its neighbours.
    /// </summary>
    private static string PickMaterialFor(Brush brush, Plane3 plane)
    {
        string material = MaterialDefaults.Placeholder;
        float bestDot = -float.MaxValue;
        foreach (Face face in brush.Faces)
        {
            float dot = Vector3.Dot(face.Plane.Normal, plane.Normal);
            if (dot > bestDot)
            {
                bestDot = dot;
                material = face.Material;
            }
        }
        return material;
    }

    /// <summary>
    /// Keeps only the part of the brush behind the plane. This is the editor's clip
    /// tool: everything in front of the drawn plane is discarded.
    /// </summary>
    public static Brush? Clip(Brush brush, Plane3 plane, Face? template = null)
    {
        Split(brush, plane, out _, out Brush? back, template);
        return back;
    }

    /// <summary>
    /// Subtracts <paramref name="cutter"/> from <paramref name="target"/>, returning the
    /// convex fragments that tile the remaining volume. This is Hammer's "carve".
    /// <para>
    /// The algorithm walks the cutter's planes, peeling off the slab of the target that
    /// lies outside each one. What survives every plane is exactly the intersection, and
    /// is discarded. At all times the emitted fragments plus the running remainder
    /// reconstruct the original target exactly, which is why no volume is ever lost.
    /// </para>
    /// <para>
    /// Returns an empty list when the cutter swallows the target whole, and a single
    /// clone of the target when they do not touch.
    /// </para>
    /// </summary>
    /// <param name="inheritCutterMaterials">
    /// When true, newly exposed interior surfaces take their material from the cutter
    /// face that created them - carving a doorway with a trim-textured brush leaves the
    /// doorway trimmed. When false, they blend with the target's own materials.
    /// </param>
    public static List<Brush> Subtract(Brush target, Brush cutter, bool inheritCutterMaterials = true)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(cutter);

        var fragments = new List<Brush>();

        if (!target.Intersects(cutter))
        {
            fragments.Add(target.Clone());
            return fragments;
        }

        Brush? remainder = target.Clone();

        // Only faces that contribute geometry are needed: redundant planes do not change
        // the cutter's volume, and skipping them avoids emitting pointless fragments.
        foreach (Face cutFace in cutter.GeometryFaces)
        {
            if (remainder is null) break;

            Split(remainder, cutFace.Plane, out Brush? outside, out Brush? inside,
                  inheritCutterMaterials ? cutFace : null);

            if (outside is not null) fragments.Add(outside);

            if (inside is null)
            {
                // Nothing of the remainder reaches inside this half-space, so the target
                // never actually met the cutter. `outside` already captured everything.
                remainder = null;
                break;
            }

            remainder = inside;
        }

        // Whatever survived every plane is the overlap, which is what we are removing.
        return fragments;
    }

    /// <summary>Subtracts a cutter from many targets, flattening the resulting fragments.</summary>
    public static List<Brush> Subtract(IEnumerable<Brush> targets, Brush cutter, bool inheritCutterMaterials = true)
    {
        var result = new List<Brush>();
        foreach (Brush target in targets)
            result.AddRange(Subtract(target, cutter, inheritCutterMaterials));
        return result;
    }

    /// <summary>
    /// The convex overlap of two brushes, or null when they do not intersect. Combining
    /// both plane sets works directly here because an intersection of convex solids is
    /// always convex.
    /// </summary>
    public static Brush? Intersection(Brush a, Brush b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);

        if (!a.Intersects(b)) return null;

        var result = new Brush { Contents = a.Contents, VisGroup = a.VisGroup };
        foreach (Face face in a.GeometryFaces) result.AddFace(face.Clone());
        foreach (Face face in b.GeometryFaces) result.AddFace(face.Clone());

        result.Rebuild();
        return result.IsValid ? result : null;
    }

    /// <summary>
    /// Attempts to fuse two brushes into one, succeeding only when their union happens to
    /// be convex. Used to simplify geometry after carving, where a carve often leaves
    /// fragments that could be a single simpler solid.
    /// <para>
    /// Convexity is verified numerically rather than by combinatorial reasoning: the
    /// merged plane set is rebuilt and its volume compared against the sum of the inputs.
    /// If the union were concave, the convex hull of the merged planes would enclose extra
    /// space and the volumes would not match.
    /// </para>
    /// </summary>
    public static Brush? TryMerge(Brush a, Brush b, float volumeTolerance = 0.01f)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);

        float targetVolume = a.Volume + b.Volume;
        if (targetVolume <= 0f) return null;

        // Drop the shared boundary: any plane of `a` that `b` mirrors exactly is an
        // internal wall between them and must not survive into the merged solid.
        var planes = new List<Plane3>();
        var merged = new Brush { Contents = a.Contents, VisGroup = a.VisGroup };

        foreach (Face face in a.GeometryFaces)
        {
            if (b.GeometryFaces.Any(other => other.Plane.IsCoincident(face.Plane.Flipped))) continue;
            if (planes.Any(p => p.IsCoincident(face.Plane))) continue;
            planes.Add(face.Plane);
            merged.AddFace(face.Clone());
        }
        foreach (Face face in b.GeometryFaces)
        {
            if (a.GeometryFaces.Any(other => other.Plane.IsCoincident(face.Plane.Flipped))) continue;
            if (planes.Any(p => p.IsCoincident(face.Plane))) continue;
            planes.Add(face.Plane);
            merged.AddFace(face.Clone());
        }

        merged.Rebuild();
        if (!merged.IsValid) return null;

        float mergedVolume = merged.Volume;
        float allowed = MathF.Max(volumeTolerance, targetVolume * volumeTolerance);
        return MathF.Abs(mergedVolume - targetVolume) <= allowed ? merged : null;
    }

    /// <summary>
    /// Repeatedly fuses brushes in a set wherever <see cref="TryMerge"/> succeeds. A
    /// cheap post-carve cleanup pass; it is greedy rather than optimal.
    /// </summary>
    public static List<Brush> MergeAll(IEnumerable<Brush> brushes, float volumeTolerance = 0.01f)
    {
        var working = brushes.ToList();

        bool changed = true;
        while (changed)
        {
            changed = false;
            for (int i = 0; i < working.Count && !changed; i++)
            {
                for (int j = i + 1; j < working.Count; j++)
                {
                    Brush? merged = TryMerge(working[i], working[j], volumeTolerance);
                    if (merged is null) continue;

                    merged.Id = working[i].Id;
                    working.RemoveAt(j);
                    working[i] = merged;
                    changed = true;
                    break;
                }
            }
        }

        return working;
    }

    /// <summary>
    /// Splits every brush in a set by a plane, keeping both halves. Used by the editor's
    /// clip tool in "keep both" mode.
    /// </summary>
    public static List<Brush> SplitAll(IEnumerable<Brush> brushes, Plane3 plane)
    {
        var result = new List<Brush>();
        foreach (Brush brush in brushes)
        {
            Split(brush, plane, out Brush? front, out Brush? back);
            if (front is not null) result.Add(front);
            if (back is not null) result.Add(back);
        }
        return result;
    }
}
