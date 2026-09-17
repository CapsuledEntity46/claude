using System.Numerics;

namespace Forge.Geometry;

/// <summary>Which side of a plane something lies on.</summary>
public enum PlaneSide
{
    /// <summary>Entirely within the plane's tolerance band.</summary>
    On = 0,
    /// <summary>On the side the normal points toward (positive distance).</summary>
    Front = 1,
    /// <summary>Opposite the normal (negative distance).</summary>
    Back = 2,
    /// <summary>Straddles the plane. Only returned for volumes/polygons.</summary>
    Spanning = 3,
}

/// <summary>
/// An oriented plane stored in constant-distance form.
/// <para>
/// The plane is the set of points satisfying <c>dot(Normal, p) == Dist</c>, so the
/// signed distance of any point is <c>dot(Normal, p) - Dist</c>. This differs from
/// <see cref="System.Numerics.Plane"/>, which stores <c>dot(N, p) + D == 0</c>; the
/// sign flip is a classic source of bugs, so Forge uses one explicit convention
/// everywhere and never round-trips through the BCL type implicitly.
/// </para>
/// <para>
/// Brush face normals always point <b>out</b> of the solid, which means the interior
/// of a convex brush is the intersection of the half-spaces where every face's
/// signed distance is negative.
/// </para>
/// </summary>
public readonly struct Plane3 : IEquatable<Plane3>
{
    public readonly Vector3 Normal;
    public readonly float Dist;

    public Plane3(Vector3 normal, float dist)
    {
        Normal = normal;
        Dist = dist;
    }

    /// <summary>Builds a plane from a normal and any point lying on it.</summary>
    public static Plane3 FromPointNormal(Vector3 point, Vector3 normal)
    {
        normal = Vector3.Normalize(normal);
        return new Plane3(normal, Vector3.Dot(normal, point));
    }

    /// <summary>
    /// Builds a plane from three points wound <b>counter-clockwise as seen from the
    /// front</b> (i.e. from outside the solid). The normal is
    /// <c>normalize(cross(b - a, c - a))</c>.
    /// </summary>
    /// <remarks>
    /// This is the convention the <c>.tmap</c> file format stores face planes in, so
    /// the reader and writer agree by construction.
    /// </remarks>
    public static Plane3 FromPoints(Vector3 a, Vector3 b, Vector3 c)
    {
        Vector3 normal = Vector3.Cross(b - a, c - a);
        float length = normal.Length();
        if (length < MathUtil.Epsilon)
            throw new ArgumentException("Cannot build a plane from collinear or coincident points.");
        normal /= length;
        return new Plane3(normal, Vector3.Dot(normal, a));
    }

    /// <summary>True when the three points are distinct and non-collinear.</summary>
    public static bool IsValidTriangle(Vector3 a, Vector3 b, Vector3 c)
        => Vector3.Cross(b - a, c - a).Length() >= MathUtil.Epsilon;

    /// <summary>Signed distance from the plane. Positive means in front.</summary>
    public float Distance(Vector3 point) => Vector3.Dot(Normal, point) - Dist;

    /// <summary>Any point guaranteed to lie on the plane.</summary>
    public Vector3 Origin => Normal * Dist;

    /// <summary>The same plane facing the opposite direction.</summary>
    public Plane3 Flipped => new(-Normal, -Dist);

    public Plane3 Normalized()
    {
        float length = Normal.Length();
        if (length < MathUtil.Epsilon) return this;
        return new Plane3(Normal / length, Dist / length);
    }

    /// <summary>
    /// Nudges normals that are almost axis-aligned onto the exact axis, and rounds
    /// near-integer distances. Designers overwhelmingly build axis-aligned geometry,
    /// and exact axial planes let downstream clipping snap vertices exactly.
    /// </summary>
    public Plane3 Snapped()
    {
        Vector3 n = Normal;
        for (int axis = 0; axis < 3; axis++)
        {
            float c = MathUtil.GetComponent(n, axis);
            if (MathF.Abs(c - 1f) < MathUtil.NormalEpsilon)
            {
                n = MathUtil.WithComponent(Vector3.Zero, axis, 1f);
                break;
            }
            if (MathF.Abs(c + 1f) < MathUtil.NormalEpsilon)
            {
                n = MathUtil.WithComponent(Vector3.Zero, axis, -1f);
                break;
            }
        }

        // Zero out dust in the off-axis components.
        for (int axis = 0; axis < 3; axis++)
        {
            if (MathF.Abs(MathUtil.GetComponent(n, axis)) < MathUtil.NormalEpsilon)
                n = MathUtil.WithComponent(n, axis, 0f);
        }

        return new Plane3(n, MathUtil.SnapToInteger(Dist));
    }

    public PlaneSide ClassifyPoint(Vector3 point, float epsilon = MathUtil.OnEpsilon)
    {
        float d = Distance(point);
        if (d > epsilon) return PlaneSide.Front;
        if (d < -epsilon) return PlaneSide.Back;
        return PlaneSide.On;
    }

    /// <summary>Classifies a set of points as a group, reporting <see cref="PlaneSide.Spanning"/> when they straddle.</summary>
    public PlaneSide ClassifyPoints(IReadOnlyList<Vector3> points, float epsilon = MathUtil.OnEpsilon)
    {
        bool front = false, back = false;
        for (int i = 0; i < points.Count; i++)
        {
            switch (ClassifyPoint(points[i], epsilon))
            {
                case PlaneSide.Front: front = true; break;
                case PlaneSide.Back: back = true; break;
            }
            if (front && back) return PlaneSide.Spanning;
        }
        if (front) return PlaneSide.Front;
        if (back) return PlaneSide.Back;
        return PlaneSide.On;
    }

    /// <summary>True when both planes describe the same surface with the same facing.</summary>
    public bool IsCoincident(Plane3 other, float normalEpsilon = MathUtil.NormalEpsilon, float distEpsilon = MathUtil.OnEpsilon)
        => Vector3.Dot(Normal, other.Normal) > 1f - normalEpsilon
        && MathF.Abs(Dist - other.Dist) < distEpsilon;

    /// <summary>True when both planes describe the same surface, facing either way.</summary>
    public bool IsCoplanar(Plane3 other, float normalEpsilon = MathUtil.NormalEpsilon, float distEpsilon = MathUtil.OnEpsilon)
        => IsCoincident(other, normalEpsilon, distEpsilon)
        || IsCoincident(other.Flipped, normalEpsilon, distEpsilon);

    /// <summary>
    /// Intersects three planes. Returns false when the planes are parallel or form a
    /// prism (no single common point). This is the direct way to recover a brush
    /// corner from its three adjacent faces.
    /// </summary>
    public static bool IntersectThree(Plane3 a, Plane3 b, Plane3 c, out Vector3 point)
    {
        Vector3 bc = Vector3.Cross(b.Normal, c.Normal);
        float denom = Vector3.Dot(a.Normal, bc);
        if (MathF.Abs(denom) < 1e-6f)
        {
            point = default;
            return false;
        }

        Vector3 ca = Vector3.Cross(c.Normal, a.Normal);
        Vector3 ab = Vector3.Cross(a.Normal, b.Normal);
        point = (bc * a.Dist + ca * b.Dist + ab * c.Dist) / denom;
        return true;
    }

    /// <summary>
    /// Casts a ray at the plane. Returns false for rays that are parallel to, or
    /// travelling away from, the surface.
    /// </summary>
    public bool IntersectRay(Vector3 origin, Vector3 direction, out float t)
    {
        float denom = Vector3.Dot(Normal, direction);
        if (MathF.Abs(denom) < 1e-6f)
        {
            t = 0f;
            return false;
        }
        t = (Dist - Vector3.Dot(Normal, origin)) / denom;
        return true;
    }

    /// <summary>Projects a point onto the plane along the normal.</summary>
    public Vector3 Project(Vector3 point) => point - Normal * Distance(point);

    /// <summary>
    /// Transforms the plane by an affine matrix. Uses the inverse-transpose for the
    /// normal so that non-uniform scaling still yields a correct surface.
    /// </summary>
    public Plane3 Transform(Matrix4x4 matrix)
    {
        Vector3 pointOnPlane = Vector3.Transform(Origin, matrix);
        if (!Matrix4x4.Invert(matrix, out Matrix4x4 inverse))
            return FromPointNormal(pointOnPlane, Vector3.TransformNormal(Normal, matrix));

        Matrix4x4 it = Matrix4x4.Transpose(inverse);
        Vector3 normal = Vector3.TransformNormal(Normal, it);
        return FromPointNormal(pointOnPlane, normal);
    }

    public bool Equals(Plane3 other) => Normal.Equals(other.Normal) && Dist.Equals(other.Dist);

    public override bool Equals(object? obj) => obj is Plane3 p && Equals(p);

    public override int GetHashCode() => HashCode.Combine(Normal, Dist);

    public override string ToString() => $"({Normal.X:0.###} {Normal.Y:0.###} {Normal.Z:0.###}) d={Dist:0.###}";
}
