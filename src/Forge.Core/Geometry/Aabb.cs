using System.Numerics;

namespace Forge.Geometry;

/// <summary>An axis-aligned bounding box. Used for broad-phase culling and editor selection.</summary>
public readonly struct Aabb : IEquatable<Aabb>
{
    public readonly Vector3 Min;
    public readonly Vector3 Max;

    public Aabb(Vector3 min, Vector3 max)
    {
        Min = min;
        Max = max;
    }

    /// <summary>An inverted box that absorbs the first point unioned into it.</summary>
    public static Aabb Empty => new(new Vector3(float.MaxValue), new Vector3(float.MinValue));

    public bool IsEmpty => Min.X > Max.X || Min.Y > Max.Y || Min.Z > Max.Z;

    public Vector3 Center => (Min + Max) * 0.5f;

    public Vector3 Size => Max - Min;

    public Vector3 Extents => (Max - Min) * 0.5f;

    public float Volume
    {
        get
        {
            if (IsEmpty) return 0f;
            Vector3 s = Size;
            return s.X * s.Y * s.Z;
        }
    }

    public static Aabb FromPoints(IEnumerable<Vector3> points)
    {
        Vector3 min = new(float.MaxValue), max = new(float.MinValue);
        foreach (Vector3 p in points)
        {
            min = Vector3.Min(min, p);
            max = Vector3.Max(max, p);
        }
        return new Aabb(min, max);
    }

    public static Aabb FromCenterSize(Vector3 center, Vector3 size)
    {
        Vector3 half = size * 0.5f;
        return new Aabb(center - half, center + half);
    }

    public Aabb Union(Aabb other)
    {
        if (IsEmpty) return other;
        if (other.IsEmpty) return this;
        return new Aabb(Vector3.Min(Min, other.Min), Vector3.Max(Max, other.Max));
    }

    public Aabb Union(Vector3 point)
        => new(Vector3.Min(Min, point), Vector3.Max(Max, point));

    /// <summary>Grows the box outward by a uniform margin.</summary>
    public Aabb Expanded(float margin)
        => new(Min - new Vector3(margin), Max + new Vector3(margin));

    public bool Contains(Vector3 p, float epsilon = 0f)
        => p.X >= Min.X - epsilon && p.X <= Max.X + epsilon
        && p.Y >= Min.Y - epsilon && p.Y <= Max.Y + epsilon
        && p.Z >= Min.Z - epsilon && p.Z <= Max.Z + epsilon;

    public bool Contains(Aabb other)
        => other.Min.X >= Min.X && other.Max.X <= Max.X
        && other.Min.Y >= Min.Y && other.Max.Y <= Max.Y
        && other.Min.Z >= Min.Z && other.Max.Z <= Max.Z;

    /// <summary>Overlap test. Touching faces count as intersecting.</summary>
    public bool Intersects(Aabb other, float epsilon = 0f)
        => Min.X <= other.Max.X + epsilon && Max.X >= other.Min.X - epsilon
        && Min.Y <= other.Max.Y + epsilon && Max.Y >= other.Min.Y - epsilon
        && Min.Z <= other.Max.Z + epsilon && Max.Z >= other.Min.Z - epsilon;

    /// <summary>The eight corners, ordered so bit 0=X, bit 1=Y, bit 2=Z select Max.</summary>
    public Vector3[] GetCorners() => new[]
    {
        new Vector3(Min.X, Min.Y, Min.Z),
        new Vector3(Max.X, Min.Y, Min.Z),
        new Vector3(Min.X, Max.Y, Min.Z),
        new Vector3(Max.X, Max.Y, Min.Z),
        new Vector3(Min.X, Min.Y, Max.Z),
        new Vector3(Max.X, Min.Y, Max.Z),
        new Vector3(Min.X, Max.Y, Max.Z),
        new Vector3(Max.X, Max.Y, Max.Z),
    };

    /// <summary>
    /// Classifies the box against a plane. Uses the projected-radius trick rather
    /// than testing all eight corners.
    /// </summary>
    public PlaneSide Classify(Plane3 plane, float epsilon = MathUtil.OnEpsilon)
    {
        Vector3 c = Center, e = Extents;
        float distance = plane.Distance(c);
        float radius = MathF.Abs(plane.Normal.X) * e.X
                     + MathF.Abs(plane.Normal.Y) * e.Y
                     + MathF.Abs(plane.Normal.Z) * e.Z;

        if (distance - radius > epsilon) return PlaneSide.Front;
        if (distance + radius < -epsilon) return PlaneSide.Back;
        return PlaneSide.Spanning;
    }

    /// <summary>Slab-method ray test. <paramref name="tMin"/> may be negative if the origin is inside.</summary>
    public bool IntersectRay(Vector3 origin, Vector3 direction, out float tMin, out float tMax)
    {
        tMin = float.NegativeInfinity;
        tMax = float.PositiveInfinity;

        for (int axis = 0; axis < 3; axis++)
        {
            float o = MathUtil.GetComponent(origin, axis);
            float d = MathUtil.GetComponent(direction, axis);
            float lo = MathUtil.GetComponent(Min, axis);
            float hi = MathUtil.GetComponent(Max, axis);

            if (MathF.Abs(d) < 1e-9f)
            {
                if (o < lo || o > hi) return false;
                continue;
            }

            float inv = 1f / d;
            float t1 = (lo - o) * inv;
            float t2 = (hi - o) * inv;
            if (t1 > t2) (t1, t2) = (t2, t1);

            tMin = MathF.Max(tMin, t1);
            tMax = MathF.Min(tMax, t2);
            if (tMin > tMax) return false;
        }

        return tMax >= 0f;
    }

    /// <summary>Bounding box of this box after an arbitrary transform.</summary>
    public Aabb Transform(Matrix4x4 matrix)
    {
        Vector3 min = new(float.MaxValue), max = new(float.MinValue);
        foreach (Vector3 corner in GetCorners())
        {
            Vector3 t = Vector3.Transform(corner, matrix);
            min = Vector3.Min(min, t);
            max = Vector3.Max(max, t);
        }
        return new Aabb(min, max);
    }

    public bool Equals(Aabb other) => Min.Equals(other.Min) && Max.Equals(other.Max);

    public override bool Equals(object? obj) => obj is Aabb a && Equals(a);

    public override int GetHashCode() => HashCode.Combine(Min, Max);

    public override string ToString() => $"[{Min.X:0.##} {Min.Y:0.##} {Min.Z:0.##}] .. [{Max.X:0.##} {Max.Y:0.##} {Max.Z:0.##}]";
}
