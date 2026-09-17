using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>What a brush volume means to the physics and visibility systems.</summary>
[Flags]
public enum BrushContents
{
    None = 0,
    /// <summary>Blocks everything and seals the level against leaks.</summary>
    Solid = 1 << 0,
    /// <summary>Geometry that does not seal visibility; cheap decoration (func_detail).</summary>
    Detail = 1 << 1,
    /// <summary>Blocks player movement only.</summary>
    PlayerClip = 1 << 2,
    /// <summary>Non-solid volume that fires entity outputs on touch.</summary>
    Trigger = 1 << 3,
    /// <summary>Swimmable volume.</summary>
    Water = 1 << 4,
    /// <summary>Climbable surface volume.</summary>
    Ladder = 1 << 5,
    /// <summary>Belongs to a brush entity, so it moves at runtime and cannot seal the BSP.</summary>
    Entity = 1 << 6,
}

/// <summary>
/// A convex solid defined as the intersection of its faces' half-spaces.
/// <para>
/// Convexity is not a limitation here, it is the entire point. Because a brush is
/// guaranteed convex, point containment is a handful of dot products, collision needs
/// no mesh data structure, and CSG reduces to plane clipping. Concave shapes are built
/// by combining brushes, exactly as in Quake, Source, and Hammer.
/// </para>
/// <para>
/// Geometry is lazily derived: <see cref="Rebuild"/> turns the plane set into per-face
/// polygons. Anything that mutates a plane must invalidate the cached geometry.
/// </para>
/// </summary>
public sealed class Brush
{
    private readonly List<Face> _faces;
    private Aabb _bounds;
    private bool _geometryValid;

    public int Id;

    public BrushContents Contents = BrushContents.Solid;

    /// <summary>Optional visgroup membership, used by the editor to hide sets of brushes.</summary>
    public string? VisGroup;

    public Brush()
    {
        _faces = new List<Face>(6);
    }

    public Brush(IEnumerable<Face> faces)
    {
        _faces = faces.ToList();
    }

    public IReadOnlyList<Face> Faces => _faces;

    /// <summary>True once <see cref="Rebuild"/> has produced polygons for the current planes.</summary>
    public bool GeometryValid => _geometryValid;

    public void AddFace(Face face)
    {
        _faces.Add(face);
        Invalidate();
    }

    public bool RemoveFace(Face face)
    {
        bool removed = _faces.Remove(face);
        if (removed) Invalidate();
        return removed;
    }

    /// <summary>
    /// Replaces a face's plane and invalidates geometry. Use this rather than mutating
    /// <see cref="Face.Plane"/> directly so the cached windings cannot go stale.
    /// </summary>
    public void SetFacePlane(Face face, Plane3 plane)
    {
        face.Plane = plane;
        // The stored serialisation points describe the old plane and are now meaningless.
        face.SourcePoints = null;
        Invalidate();
    }

    /// <summary>Marks cached polygons and bounds as stale.</summary>
    public void Invalidate() => _geometryValid = false;

    /// <summary>
    /// Derives each face's polygon by starting from an infinite plane and clipping it
    /// against every other face's half-space.
    /// <para>
    /// This is the core of brush geometry. Faces whose plane is cut away entirely by the
    /// other half-spaces end up with a null winding, which is normal and expected: it is
    /// how a redundant plane silently drops out of a solid.
    /// </para>
    /// </summary>
    public void Rebuild(float epsilon = MathUtil.OnEpsilon)
    {
        _bounds = Aabb.Empty;

        for (int i = 0; i < _faces.Count; i++)
        {
            Face face = _faces[i];
            Winding? winding = Winding.FromPlane(face.Plane);

            for (int j = 0; j < _faces.Count && winding is not null; j++)
            {
                if (i == j) continue;
                Plane3 other = _faces[j].Plane;

                // A duplicate of our own plane would annihilate the winding; ignore it.
                if (other.IsCoincident(face.Plane)) continue;

                // The solid interior is the intersection of the *back* half-spaces,
                // because face normals point outward.
                winding = winding.ClipBehind(other, epsilon);
            }

            if (winding is not null)
            {
                winding = winding.RemoveCollinear(epsilon).Snapped();
                if (winding.IsDegenerate()) winding = null;
            }

            face.Winding = winding;

            if (winding is not null)
                _bounds = _bounds.Union(winding.Bounds);
        }

        _geometryValid = true;
    }

    private void EnsureGeometry()
    {
        if (!_geometryValid) Rebuild();
    }

    public Aabb Bounds
    {
        get
        {
            EnsureGeometry();
            return _bounds;
        }
    }

    public Vector3 Center => Bounds.Center;

    /// <summary>Faces that actually contribute surface area.</summary>
    public IEnumerable<Face> GeometryFaces
    {
        get
        {
            EnsureGeometry();
            return _faces.Where(f => f.HasGeometry);
        }
    }

    /// <summary>
    /// A brush is well-formed when it is a bounded solid: at least four contributing
    /// faces, and every vertex inside the legal world volume. An unbounded plane set
    /// produces vertices out at <see cref="MathUtil.PlaneExtent"/>, which this catches.
    /// </summary>
    public bool IsValid
    {
        get
        {
            EnsureGeometry();
            int contributing = 0;
            foreach (Face face in _faces)
            {
                if (!face.HasGeometry) continue;
                contributing++;
                foreach (Vector3 p in face.Winding!.Points)
                {
                    if (!MathUtil.IsInWorldBounds(p)) return false;
                }
            }
            return contributing >= 4;
        }
    }

    /// <summary>
    /// Volume via the divergence theorem: summing <c>dot(centroid, normal) * area</c>
    /// over a closed surface gives three times the enclosed volume. Cheap, and a
    /// precise invariant to assert CSG operations against.
    /// </summary>
    public float Volume
    {
        get
        {
            EnsureGeometry();
            float total = 0f;
            foreach (Face face in _faces)
            {
                if (!face.HasGeometry) continue;
                Winding w = face.Winding!;
                total += Vector3.Dot(w.Center, face.Plane.Normal) * w.Area;
            }
            return total / 3f;
        }
    }

    /// <summary>Total surface area of all contributing faces.</summary>
    public float SurfaceArea
    {
        get
        {
            EnsureGeometry();
            float total = 0f;
            foreach (Face face in _faces)
                if (face.HasGeometry) total += face.Winding!.Area;
            return total;
        }
    }

    /// <summary>
    /// Containment test: a point is inside when it is behind every face plane. Convexity
    /// makes this exact and branch-free.
    /// </summary>
    public bool ContainsPoint(Vector3 point, float epsilon = MathUtil.OnEpsilon)
    {
        if (_faces.Count == 0) return false;
        foreach (Face face in _faces)
        {
            if (face.Plane.Distance(point) > epsilon) return false;
        }
        return true;
    }

    /// <summary>Unique vertices of the solid.</summary>
    public List<Vector3> GetVertices(float weldEpsilon = MathUtil.OnEpsilon)
    {
        EnsureGeometry();
        var vertices = new List<Vector3>(24);
        foreach (Face face in _faces)
        {
            if (!face.HasGeometry) continue;
            foreach (Vector3 p in face.Winding!.Points)
            {
                bool duplicate = false;
                for (int i = 0; i < vertices.Count; i++)
                {
                    if (MathUtil.NearlyEqual(vertices[i], p, weldEpsilon))
                    {
                        duplicate = true;
                        break;
                    }
                }
                if (!duplicate) vertices.Add(p);
            }
        }
        return vertices;
    }

    /// <summary>
    /// Convex overlap test via the separating-plane theorem. For two convex polyhedra it
    /// is sufficient to test the face planes of both: if any plane has the whole other
    /// solid strictly in front of it, they are disjoint.
    /// </summary>
    public bool Intersects(Brush other, float epsilon = MathUtil.OnEpsilon)
    {
        EnsureGeometry();
        other.EnsureGeometry();

        if (!Bounds.Intersects(other.Bounds, epsilon)) return false;

        List<Vector3> ourVertices = GetVertices();
        List<Vector3> theirVertices = other.GetVertices();

        foreach (Face face in _faces)
        {
            if (IsFullyInFront(face.Plane, theirVertices, epsilon)) return false;
        }
        foreach (Face face in other._faces)
        {
            if (IsFullyInFront(face.Plane, ourVertices, epsilon)) return false;
        }
        return true;
    }

    private static bool IsFullyInFront(Plane3 plane, List<Vector3> points, float epsilon)
    {
        if (points.Count == 0) return false;
        for (int i = 0; i < points.Count; i++)
        {
            if (plane.Distance(points[i]) <= epsilon) return false;
        }
        return true;
    }

    /// <summary>
    /// Applies an affine transform to every face plane.
    /// </summary>
    /// <param name="textureLock">
    /// When true, texture projections are rewritten so materials appear glued to the
    /// surfaces. When false, the world-space projection is left alone and geometry
    /// slides underneath the texture — occasionally desirable, usually not.
    /// </param>
    /// <remarks>
    /// Mirroring needs no special handling. A half-space is <c>dot(n, p) &lt;= d</c>, and its
    /// image under <c>M</c> is <c>dot(M^-T n, q) &lt;= d'</c>; because the inverse-transpose
    /// carries the *gradient*, a negative determinant negates the normal on its own and
    /// "outward" stays outward. Explicitly flipping here would turn the solid inside out.
    /// Winding order is not a concern either, since <see cref="Rebuild"/> regenerates
    /// polygons from the planes afterwards.
    /// </remarks>
    public void Transform(Matrix4x4 matrix, bool textureLock = true)
    {
        EnsureGeometry();

        foreach (Face face in _faces)
        {
            Vector3 reference = face.HasGeometry ? face.Winding!.Center : face.Plane.Origin;

            if (textureLock)
                face.Texture.TransformWithLock(matrix, reference);

            face.Plane = face.Plane.Transform(matrix);

            // Carry the serialisation points along. Transforming points that lie on a plane
            // keeps them on the transformed plane, so the exact-round-trip property
            // survives moving and rotating geometry.
            if (face.SourcePoints is { Length: 3 } points)
            {
                for (int i = 0; i < 3; i++)
                    points[i] = Vector3.Transform(points[i], matrix);
            }
        }

        Invalidate();
    }

    public void Translate(Vector3 offset, bool textureLock = true)
        => Transform(Matrix4x4.CreateTranslation(offset), textureLock);

    /// <summary>Snaps every face plane so axis-aligned geometry lands exactly on integers.</summary>
    public void SnapPlanes()
    {
        foreach (Face face in _faces)
        {
            face.Plane = face.Plane.Snapped();
            face.SourcePoints = null;
        }
        Invalidate();
    }

    /// <summary>Replaces the material on every face.</summary>
    public void SetMaterial(string material)
    {
        foreach (Face face in _faces)
        {
            face.Material = material;
            face.Flags = MaterialDefaults.FlagsFor(material);
        }
    }

    public Brush Clone()
    {
        var clone = new Brush(_faces.Select(f => f.Clone()))
        {
            Id = Id,
            Contents = Contents,
            VisGroup = VisGroup,
        };
        clone.Invalidate();
        return clone;
    }

    public override string ToString()
        => $"Brush #{Id} ({_faces.Count} faces, {Contents})";
}
