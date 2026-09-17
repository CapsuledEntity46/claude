using System.Numerics;
using System.Text;

namespace Forge.Geometry;

/// <summary>
/// A convex polygon in 3D, stored as an ordered ring of coplanar points wound
/// counter-clockwise when viewed from the front.
/// <para>
/// "Winding" is the Quake-lineage name for this structure and it is the single most
/// load-bearing type in the engine: brush faces are produced by clipping a winding
/// against half-spaces, CSG carving splits windings, BSP construction splits
/// windings, and the renderer triangulates windings.
/// </para>
/// <para>
/// Windings are treated as immutable. Every operation returns a new instance.
/// </para>
/// </summary>
public sealed class Winding
{
    private readonly Vector3[] _points;

    public Winding(Vector3[] points, bool takeOwnership = false)
    {
        ArgumentNullException.ThrowIfNull(points);
        _points = takeOwnership ? points : (Vector3[])points.Clone();
    }

    public Winding(IEnumerable<Vector3> points)
        : this(points.ToArray(), takeOwnership: true)
    {
    }

    public IReadOnlyList<Vector3> Points => _points;

    public int Count => _points.Length;

    public Vector3 this[int index] => _points[index];

    /// <summary>Direct access for hot loops. Do not mutate the returned array.</summary>
    internal Vector3[] RawPoints => _points;

    /// <summary>
    /// Materialises an infinite plane as a large quad, which downstream code then
    /// whittles down by clipping against neighbouring half-spaces. This is how brush
    /// faces are born.
    /// </summary>
    public static Winding FromPlane(Plane3 plane, float extent = MathUtil.PlaneExtent)
    {
        // Choose an "up" reference that is never parallel to the normal.
        Vector3 up = MathUtil.Perpendicular(plane.Normal);
        // right = normal x up gives a counter-clockwise ring w.r.t. the normal.
        Vector3 right = Vector3.Cross(plane.Normal, up);

        up *= extent;
        right *= extent;
        Vector3 origin = plane.Origin;

        return new Winding(new[]
        {
            origin - right + up,
            origin + right + up,
            origin + right - up,
            origin - right - up,
        }, takeOwnership: true);
    }

    /// <summary>Creates a winding for an axis-aligned rectangle on a plane, used by editor grids and tests.</summary>
    public static Winding Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d)
        => new(new[] { a, b, c, d }, takeOwnership: true);

    /// <summary>
    /// Derives the supporting plane using Newell's method, which averages across all
    /// edges instead of trusting a single vertex triple. That matters for windings
    /// with slivers, where any one triangle may be numerically useless.
    /// </summary>
    public Plane3 GetPlane()
    {
        if (_points.Length < 3)
            throw new InvalidOperationException($"A winding needs at least 3 points to define a plane (has {_points.Length}).");

        Vector3 normal = Vector3.Zero;
        for (int i = 0; i < _points.Length; i++)
        {
            Vector3 p = _points[i];
            Vector3 q = _points[(i + 1) % _points.Length];
            normal.X += (p.Y - q.Y) * (p.Z + q.Z);
            normal.Y += (p.Z - q.Z) * (p.X + q.X);
            normal.Z += (p.X - q.X) * (p.Y + q.Y);
        }

        float length = normal.Length();
        if (length < MathUtil.Epsilon)
            throw new InvalidOperationException("Degenerate winding has no well-defined plane.");

        normal /= length;
        return new Plane3(normal, Vector3.Dot(normal, Center));
    }

    /// <summary>Surface area. Newell's normal has magnitude 2*area, so this is nearly free.</summary>
    public float Area
    {
        get
        {
            if (_points.Length < 3) return 0f;
            Vector3 sum = Vector3.Zero;
            Vector3 origin = _points[0];
            for (int i = 1; i < _points.Length - 1; i++)
                sum += Vector3.Cross(_points[i] - origin, _points[i + 1] - origin);
            return sum.Length() * 0.5f;
        }
    }

    /// <summary>Centroid of the vertices (equals the area centroid for convex rings).</summary>
    public Vector3 Center
    {
        get
        {
            if (_points.Length == 0) return Vector3.Zero;
            Vector3 sum = Vector3.Zero;
            foreach (Vector3 p in _points) sum += p;
            return sum / _points.Length;
        }
    }

    public Aabb Bounds => Aabb.FromPoints(_points);

    /// <summary>Flips facing by reversing the ring.</summary>
    public Winding Reversed()
    {
        var result = new Vector3[_points.Length];
        for (int i = 0; i < _points.Length; i++)
            result[i] = _points[_points.Length - 1 - i];
        return new Winding(result, takeOwnership: true);
    }

    public PlaneSide Classify(Plane3 plane, float epsilon = MathUtil.OnEpsilon)
        => plane.ClassifyPoints(_points, epsilon);

    /// <summary>
    /// Splits the winding by a plane into the portion in front of it and the portion
    /// behind it. Either output may be <c>null</c> when the winding lies wholly on one
    /// side. Points within <paramref name="epsilon"/> of the plane are shared by both
    /// outputs so the two halves stay watertight along the seam.
    /// </summary>
    public void Split(Plane3 plane, out Winding? front, out Winding? back, float epsilon = MathUtil.OnEpsilon)
    {
        int count = _points.Length;
        Span<float> distances = count <= 64 ? stackalloc float[count + 1] : new float[count + 1];
        Span<PlaneSide> sides = count <= 64 ? stackalloc PlaneSide[count + 1] : new PlaneSide[count + 1];

        int frontCount = 0, backCount = 0;
        for (int i = 0; i < count; i++)
        {
            float d = plane.Distance(_points[i]);
            distances[i] = d;
            if (d > epsilon) { sides[i] = PlaneSide.Front; frontCount++; }
            else if (d < -epsilon) { sides[i] = PlaneSide.Back; backCount++; }
            else { sides[i] = PlaneSide.On; }
        }

        // Wrap around simplifies the edge walk below.
        distances[count] = distances[0];
        sides[count] = sides[0];

        if (frontCount == 0 && backCount == 0)
        {
            // Winding is coplanar with the split plane. Assign it to the front by
            // convention; callers that care inspect Classify() first.
            front = this;
            back = null;
            return;
        }
        if (frontCount == 0)
        {
            front = null;
            back = this;
            return;
        }
        if (backCount == 0)
        {
            front = this;
            back = null;
            return;
        }

        // Worst case each edge contributes its own vertex plus one split vertex.
        var frontPoints = new List<Vector3>(count + 4);
        var backPoints = new List<Vector3>(count + 4);

        for (int i = 0; i < count; i++)
        {
            Vector3 current = _points[i];

            if (sides[i] == PlaneSide.On)
            {
                // Shared vertex: belongs to both halves, and no edge split is needed.
                frontPoints.Add(current);
                backPoints.Add(current);
                continue;
            }

            if (sides[i] == PlaneSide.Front) frontPoints.Add(current);
            else backPoints.Add(current);

            // Does the edge to the next vertex cross the plane?
            if (sides[i + 1] == PlaneSide.On || sides[i + 1] == sides[i])
                continue;

            Vector3 next = _points[(i + 1) % count];
            float t = distances[i] / (distances[i] - distances[i + 1]);
            Vector3 mid = SnapToPlane(current + (next - current) * t, plane);

            frontPoints.Add(mid);
            backPoints.Add(mid);
        }

        front = frontPoints.Count >= 3 ? new Winding(frontPoints.ToArray(), takeOwnership: true) : null;
        back = backPoints.Count >= 3 ? new Winding(backPoints.ToArray(), takeOwnership: true) : null;
    }

    /// <summary>
    /// For axis-aligned planes, forces the split vertex exactly onto the plane. Without
    /// this, interpolation leaves values like 63.99999 that accumulate across successive
    /// clips and eventually open visible cracks between brushes.
    /// </summary>
    private static Vector3 SnapToPlane(Vector3 point, Plane3 plane)
    {
        for (int axis = 0; axis < 3; axis++)
        {
            float n = MathUtil.GetComponent(plane.Normal, axis);
            if (MathF.Abs(n - 1f) < MathUtil.NormalEpsilon)
                return MathUtil.WithComponent(point, axis, plane.Dist);
            if (MathF.Abs(n + 1f) < MathUtil.NormalEpsilon)
                return MathUtil.WithComponent(point, axis, -plane.Dist);
        }
        return point;
    }

    /// <summary>Keeps only the part in front of the plane. Returns null if nothing survives.</summary>
    public Winding? Clip(Plane3 plane, float epsilon = MathUtil.OnEpsilon)
    {
        Split(plane, out Winding? front, out _, epsilon);
        return front;
    }

    /// <summary>
    /// Keeps only the part behind the plane. This is the common case when building brush
    /// faces, because a brush interior is the intersection of the *back* half-spaces of
    /// its outward-facing planes.
    /// </summary>
    public Winding? ClipBehind(Plane3 plane, float epsilon = MathUtil.OnEpsilon)
    {
        Split(plane, out _, out Winding? back, epsilon);
        return back;
    }

    /// <summary>True when the winding has too few points or too little area to matter.</summary>
    public bool IsDegenerate(float minArea = MathUtil.MinWindingArea)
        => _points.Length < 3 || Area < minArea;

    /// <summary>
    /// Drops duplicate and collinear vertices. Repeated clipping accumulates redundant
    /// points along shared edges; left alone they inflate triangle counts and break
    /// normal calculation.
    /// </summary>
    /// <remarks>
    /// Runs as two distinct passes. Collapsing duplicates and testing collinearity in a
    /// single pass is subtly wrong: a duplicated corner makes both copies look degenerate
    /// to their neighbours, so both get discarded and a real corner of the polygon
    /// disappears.
    /// </remarks>
    public Winding RemoveCollinear(float epsilon = MathUtil.OnEpsilon)
    {
        if (_points.Length < 3) return this;

        // Pass 1: collapse runs of coincident vertices, including across the wrap point.
        var unique = new List<Vector3>(_points.Length);
        foreach (Vector3 p in _points)
        {
            if (unique.Count == 0 || !MathUtil.NearlyEqual(unique[^1], p, epsilon))
                unique.Add(p);
        }
        while (unique.Count > 1 && MathUtil.NearlyEqual(unique[0], unique[^1], epsilon))
            unique.RemoveAt(unique.Count - 1);

        if (unique.Count < 3) return this;

        // Pass 2: drop vertices that sit on the straight line between their neighbours.
        // Measured as a perpendicular distance in world units so the tolerance means the
        // same thing for a 4-unit edge and a 4096-unit one.
        int count = unique.Count;
        var kept = new List<Vector3>(count);
        for (int i = 0; i < count; i++)
        {
            Vector3 prev = unique[(i - 1 + count) % count];
            Vector3 current = unique[i];
            Vector3 next = unique[(i + 1) % count];

            Vector3 span = next - prev;
            float spanLength = span.Length();
            if (spanLength < epsilon) continue;

            float deviation = Vector3.Cross(current - prev, span).Length() / spanLength;
            if (deviation < epsilon) continue;

            kept.Add(current);
        }

        return kept.Count >= 3 ? new Winding(kept.ToArray(), takeOwnership: true) : this;
    }

    /// <summary>Rounds near-integer vertex coordinates, tidying up designer-authored geometry.</summary>
    public Winding Snapped(float tolerance = MathUtil.OnEpsilon)
    {
        var result = new Vector3[_points.Length];
        for (int i = 0; i < _points.Length; i++)
            result[i] = MathUtil.SnapToInteger(_points[i], tolerance);
        return new Winding(result, takeOwnership: true);
    }

    public Winding Translated(Vector3 offset)
    {
        var result = new Vector3[_points.Length];
        for (int i = 0; i < _points.Length; i++)
            result[i] = _points[i] + offset;
        return new Winding(result, takeOwnership: true);
    }

    /// <summary>
    /// Applies an affine transform. Mirroring flips the winding order, so the ring is
    /// reversed to keep the normal pointing out of the solid.
    /// </summary>
    public Winding Transformed(Matrix4x4 matrix)
    {
        var result = new Vector3[_points.Length];
        for (int i = 0; i < _points.Length; i++)
            result[i] = Vector3.Transform(_points[i], matrix);

        var transformed = new Winding(result, takeOwnership: true);
        return matrix.GetDeterminant() < 0f ? transformed.Reversed() : transformed;
    }

    /// <summary>
    /// Triangle-fan indices. Valid because windings are convex by construction.
    /// </summary>
    public int[] Triangulate()
    {
        if (_points.Length < 3) return Array.Empty<int>();
        var indices = new int[(_points.Length - 2) * 3];
        int w = 0;
        for (int i = 1; i < _points.Length - 1; i++)
        {
            indices[w++] = 0;
            indices[w++] = i;
            indices[w++] = i + 1;
        }
        return indices;
    }

    /// <summary>
    /// Point-in-polygon test for a point assumed to be on the winding's plane. Used for
    /// face picking in the editor's 3D viewport.
    /// </summary>
    public bool ContainsPoint(Vector3 point, float epsilon = MathUtil.OnEpsilon)
    {
        if (_points.Length < 3) return false;
        Vector3 normal = GetPlane().Normal;

        for (int i = 0; i < _points.Length; i++)
        {
            Vector3 a = _points[i];
            Vector3 b = _points[(i + 1) % _points.Length];
            // Inward-facing edge plane; the point must be on or inside every edge.
            Vector3 edgeNormal = Vector3.Cross(normal, b - a);
            float length = edgeNormal.Length();
            if (length < MathUtil.Epsilon) continue;
            edgeNormal /= length;
            if (Vector3.Dot(edgeNormal, point - a) < -epsilon) return false;
        }
        return true;
    }

    /// <summary>Ray/polygon intersection. Returns the ray parameter in <paramref name="t"/>.</summary>
    public bool IntersectRay(Vector3 origin, Vector3 direction, out float t, float epsilon = MathUtil.OnEpsilon)
    {
        t = 0f;
        if (_points.Length < 3) return false;
        Plane3 plane = GetPlane();
        if (!plane.IntersectRay(origin, direction, out t)) return false;
        if (t < 0f) return false;
        return ContainsPoint(origin + direction * t, epsilon);
    }

    public Winding Clone() => new(_points);

    public override string ToString()
    {
        var sb = new StringBuilder();
        sb.Append(_points.Length).Append(" pts [");
        for (int i = 0; i < _points.Length; i++)
        {
            if (i > 0) sb.Append(", ");
            sb.Append($"({_points[i].X:0.##} {_points[i].Y:0.##} {_points[i].Z:0.##})");
        }
        sb.Append(']');
        return sb.ToString();
    }
}
