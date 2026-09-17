using System.Numerics;
using Forge.Geometry;

namespace Forge.Tests;

public static class GeometryTests
{
    private const float Tol = 1e-3f;

    [Test("plane from counter-clockwise points faces the viewer")]
    public static void PlaneFromPointsFacesViewer()
    {
        // Wound counter-clockwise when looking down -Z at the XY plane => normal is +Z.
        var plane = Plane3.FromPoints(Vector3.Zero, Vector3.UnitX, Vector3.UnitY);
        Assert.AreClose(Vector3.UnitZ, plane.Normal, Tol, "normal of CCW triangle in XY plane");
        Assert.AreClose(0f, plane.Dist, Tol, "plane through the origin has zero distance");
    }

    [Test("signed distance is positive in front of the plane")]
    public static void SignedDistanceSigns()
    {
        var plane = new Plane3(Vector3.UnitZ, 64f);
        Assert.AreClose(36f, plane.Distance(new Vector3(0, 0, 100)), Tol, "point above plane");
        Assert.AreClose(-64f, plane.Distance(Vector3.Zero), Tol, "point below plane");
        Assert.AreEqual((int)PlaneSide.On, (int)plane.ClassifyPoint(new Vector3(10, -5, 64f)), "point exactly on plane");
    }

    [Test("collinear points are rejected as a plane")]
    public static void CollinearPointsRejected()
    {
        Assert.Throws<ArgumentException>(
            () => Plane3.FromPoints(Vector3.Zero, Vector3.UnitX, new Vector3(2, 0, 0)),
            "three collinear points cannot define a plane");
        Assert.IsFalse(Plane3.IsValidTriangle(Vector3.Zero, Vector3.UnitX, new Vector3(2, 0, 0)),
            "IsValidTriangle should reject collinear input");
    }

    [Test("near-axial normals snap to exact axes")]
    public static void SnapNormalisesNearAxialPlanes()
    {
        var wonky = new Plane3(Vector3.Normalize(new Vector3(0.9999999f, 0.00001f, 0f)), 63.999998f);
        Plane3 snapped = wonky.Snapped();
        Assert.AreClose(Vector3.UnitX, snapped.Normal, 1e-6f, "normal snapped to +X exactly");
        Assert.AreClose(64f, snapped.Dist, 1e-6f, "distance snapped to integer");
    }

    [Test("three planes intersect at a shared corner")]
    public static void ThreePlanesIntersect()
    {
        var x = new Plane3(Vector3.UnitX, 32f);
        var y = new Plane3(Vector3.UnitY, 16f);
        var z = new Plane3(Vector3.UnitZ, 8f);

        Assert.IsTrue(Plane3.IntersectThree(x, y, z, out Vector3 corner), "axis planes should meet");
        Assert.AreClose(new Vector3(32, 16, 8), corner, Tol, "corner position");

        // Parallel planes share no single point.
        Assert.IsFalse(Plane3.IntersectThree(x, new Plane3(Vector3.UnitX, 64f), z, out _),
            "parallel planes must report no intersection");
    }

    [Test("plane transform survives rotation")]
    public static void PlaneTransformRotates()
    {
        var plane = new Plane3(Vector3.UnitZ, 64f);
        Matrix4x4 rotate = Matrix4x4.CreateRotationX(MathF.PI / 2f);
        Plane3 result = plane.Transform(rotate);

        // Rotating +Z by 90 degrees about X sends it to -Y... verify via a known point.
        Vector3 movedPoint = Vector3.Transform(plane.Origin, rotate);
        Assert.AreClose(0f, result.Distance(movedPoint), Tol, "transformed point stays on transformed plane");
        Assert.AreClose(1f, result.Normal.Length(), Tol, "transformed normal stays unit length");
    }

    [Test("winding generated from a plane matches that plane's normal")]
    public static void BaseWindingMatchesPlaneNormal()
    {
        // This guards the winding-order convention. If FromPlane produced a clockwise
        // ring, every brush face in the engine would be inside-out.
        Vector3[] normals =
        {
            Vector3.UnitZ, -Vector3.UnitZ, Vector3.UnitX, -Vector3.UnitX, Vector3.UnitY, -Vector3.UnitY,
            Vector3.Normalize(new Vector3(1, 1, 1)),
            Vector3.Normalize(new Vector3(-2, 0.5f, 3)),
            Vector3.Normalize(new Vector3(0.1f, -4f, 0.02f)),
        };

        foreach (Vector3 normal in normals)
        {
            var plane = new Plane3(normal, 17f);
            Winding winding = Winding.FromPlane(plane, 100f);
            Assert.AreEqual(4, winding.Count, "base winding is a quad");
            Assert.AreClose(normal, winding.GetPlane().Normal, Tol, $"derived normal for {plane}");
            Assert.AreClose(17f, winding.GetPlane().Dist, 1e-2f, $"derived distance for {plane}");
        }
    }

    [Test("winding area matches the analytic value")]
    public static void WindingArea()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 50f);
        Assert.AreClose(100f * 100f, quad.Area, 1f, "area of a 100x100 quad");

        var triangle = new Winding(new[] { Vector3.Zero, new Vector3(10, 0, 0), new Vector3(0, 10, 0) });
        Assert.AreClose(50f, triangle.Area, Tol, "area of a right triangle with legs of 10");
    }

    [Test("splitting conserves area and shares the seam")]
    public static void SplitConservesAreaAndSeam()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 100f);
        float originalArea = quad.Area;

        quad.Split(new Plane3(Vector3.UnitX, 10f), out Winding? front, out Winding? back);

        Assert.IsNotNull(front, "front half exists");
        Assert.IsNotNull(back, "back half exists");

        // Area is conserved: nothing is lost or double-counted at the cut.
        Assert.AreClose(originalArea, front!.Area + back!.Area, 1f, "split halves conserve total area");

        // The expected split of a 200x200 quad at x=10.
        Assert.AreClose(90f * 200f, front.Area, 1f, "front area");
        Assert.AreClose(110f * 200f, back.Area, 1f, "back area");

        // Both halves must contain the two seam vertices exactly, or a crack appears.
        foreach (Vector3 p in front.Points)
        {
            if (MathF.Abs(p.X - 10f) < Tol)
            {
                bool shared = back.Points.Any(q => MathUtil.NearlyEqual(p, q, 1e-4f));
                Assert.IsTrue(shared, $"seam vertex {p} must be shared by both halves");
            }
        }
    }

    [Test("axial split vertices land exactly on the plane")]
    public static void SplitSnapsToAxialPlane()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 137.5f);
        quad.Split(new Plane3(Vector3.UnitX, 33f), out Winding? front, out _);

        Assert.IsNotNull(front, "front half exists");
        foreach (Vector3 p in front!.Points)
        {
            if (MathF.Abs(p.X - 33f) < 0.5f)
                Assert.AreClose(33f, p.X, 0f, "seam vertex is bit-exact on an axial split plane");
        }
    }

    [Test("a winding entirely on one side is not split")]
    public static void SplitLeavesUntouchedWindingWhole()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 10f);

        quad.Split(new Plane3(Vector3.UnitX, 1000f), out Winding? front, out Winding? back);
        Assert.IsNull(front, "nothing lies in front of a far-away plane");
        Assert.IsNotNull(back, "everything lies behind it");
        Assert.AreEqual(4, back!.Count, "untouched winding keeps its vertex count");

        quad.Split(new Plane3(Vector3.UnitX, -1000f), out front, out back);
        Assert.IsNotNull(front, "everything lies in front");
        Assert.IsNull(back, "nothing lies behind");
    }

    [Test("clip behind keeps the interior half-space")]
    public static void ClipBehindKeepsInterior()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 100f);
        Winding? clipped = quad.ClipBehind(new Plane3(Vector3.UnitX, 0f));

        Assert.IsNotNull(clipped, "half the quad survives");
        foreach (Vector3 p in clipped!.Points)
            Assert.IsTrue(p.X <= Tol, $"every surviving vertex is behind x=0, got x={p.X}");
    }

    [Test("collinear and duplicate vertices are removed")]
    public static void RemoveCollinearCleansRing()
    {
        var messy = new Winding(new[]
        {
            new Vector3(0, 0, 0),
            new Vector3(5, 0, 0),    // collinear midpoint
            new Vector3(10, 0, 0),
            new Vector3(10, 0, 0),   // exact duplicate
            new Vector3(10, 10, 0),
            new Vector3(0, 10, 0),
        });

        Winding cleaned = messy.RemoveCollinear();
        Assert.AreEqual(4, cleaned.Count, "a rectangle needs only four corners");
        Assert.AreClose(100f, cleaned.Area, Tol, "cleaning must not change the area");
    }

    [Test("reversing a winding flips its normal")]
    public static void ReverseFlipsNormal()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 5f), 10f);
        Winding flipped = quad.Reversed();
        Assert.AreClose(-Vector3.UnitZ, flipped.GetPlane().Normal, Tol, "reversed ring faces the other way");
        Assert.AreClose(quad.Area, flipped.Area, Tol, "reversal preserves area");
    }

    [Test("point containment respects polygon edges")]
    public static void ContainsPointRespectsEdges()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 10f);
        Assert.IsTrue(quad.ContainsPoint(Vector3.Zero), "centre is inside");
        Assert.IsTrue(quad.ContainsPoint(new Vector3(9.9f, 9.9f, 0)), "near-corner is inside");
        Assert.IsFalse(quad.ContainsPoint(new Vector3(10.5f, 0, 0)), "point beyond the edge is outside");
        Assert.IsFalse(quad.ContainsPoint(new Vector3(50, 50, 0)), "far point is outside");
    }

    [Test("ray hits a winding from the front")]
    public static void RayHitsWinding()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 10f);

        Assert.IsTrue(quad.IntersectRay(new Vector3(0, 0, 50), -Vector3.UnitZ, out float t), "ray fired downward hits");
        Assert.AreClose(50f, t, Tol, "hit distance");

        Assert.IsFalse(quad.IntersectRay(new Vector3(100, 100, 50), -Vector3.UnitZ, out _), "ray outside the quad misses");
        Assert.IsFalse(quad.IntersectRay(new Vector3(0, 0, 50), Vector3.UnitZ, out _), "ray fired away misses");
    }

    [Test("triangulation covers the polygon exactly once")]
    public static void TriangulationCoversArea()
    {
        Winding pentagon = Winding.FromPlane(new Plane3(Vector3.UnitZ, 0f), 20f)
            .Clip(new Plane3(Vector3.Normalize(new Vector3(-1, -1, 0)), 10f))!;

        int[] indices = pentagon.Triangulate();
        Assert.AreEqual((pentagon.Count - 2) * 3, indices.Length, "fan triangle count");

        float triangulatedArea = 0f;
        for (int i = 0; i < indices.Length; i += 3)
        {
            Vector3 a = pentagon[indices[i]];
            Vector3 b = pentagon[indices[i + 1]];
            Vector3 c = pentagon[indices[i + 2]];
            triangulatedArea += Vector3.Cross(b - a, c - a).Length() * 0.5f;
        }

        Assert.AreClose(pentagon.Area, triangulatedArea, 0.1f, "fan triangles reproduce the polygon area");
    }

    [Test("mirroring a winding preserves outward facing")]
    public static void MirroringPreservesFacing()
    {
        Winding quad = Winding.FromPlane(new Plane3(Vector3.UnitZ, 10f), 5f);
        Winding mirrored = quad.Transformed(Matrix4x4.CreateScale(-1f, 1f, 1f));

        // A mirror flips handedness; the winding must be reversed to compensate so the
        // surface still faces the same way relative to the solid it belongs to.
        Assert.AreClose(Vector3.UnitZ, mirrored.GetPlane().Normal, Tol, "mirrored winding keeps +Z facing");
    }

    [Test("aabb classification against planes")]
    public static void AabbClassification()
    {
        var box = new Aabb(new Vector3(-10), new Vector3(10));

        Assert.AreEqual((int)PlaneSide.Front, (int)box.Classify(new Plane3(Vector3.UnitZ, -20f)), "box above plane");
        Assert.AreEqual((int)PlaneSide.Back, (int)box.Classify(new Plane3(Vector3.UnitZ, 20f)), "box below plane");
        Assert.AreEqual((int)PlaneSide.Spanning, (int)box.Classify(new Plane3(Vector3.UnitZ, 0f)), "box straddles plane");
    }

    [Test("aabb ray intersection reports entry and exit")]
    public static void AabbRayIntersection()
    {
        var box = new Aabb(new Vector3(-10), new Vector3(10));

        Assert.IsTrue(box.IntersectRay(new Vector3(0, 0, 100), -Vector3.UnitZ, out float tMin, out float tMax), "ray hits box");
        Assert.AreClose(90f, tMin, Tol, "entry distance");
        Assert.AreClose(110f, tMax, Tol, "exit distance");

        Assert.IsFalse(box.IntersectRay(new Vector3(50, 50, 100), -Vector3.UnitZ, out _, out _), "ray misses box");

        // Origin inside the box yields a negative entry parameter.
        Assert.IsTrue(box.IntersectRay(Vector3.Zero, Vector3.UnitX, out tMin, out _), "ray from inside hits");
        Assert.Less(tMin, 0f, "entry is behind an interior origin");
    }

    [Test("aabb union and containment")]
    public static void AabbUnionAndContainment()
    {
        Aabb empty = Aabb.Empty;
        Assert.IsTrue(empty.IsEmpty, "the sentinel box reports empty");

        Aabb grown = empty.Union(new Aabb(new Vector3(-5), new Vector3(5)));
        Assert.AreClose(new Vector3(-5), grown.Min, Tol, "union with empty adopts the other box");
        Assert.AreClose(1000f, grown.Volume, Tol, "10x10x10 volume");

        Assert.IsTrue(grown.Contains(Vector3.Zero), "centre is contained");
        Assert.IsFalse(grown.Contains(new Vector3(6, 0, 0)), "point outside is not contained");
        Assert.IsTrue(grown.Intersects(new Aabb(new Vector3(5), new Vector3(15))), "touching boxes intersect");
        Assert.IsFalse(grown.Intersects(new Aabb(new Vector3(6), new Vector3(15))), "separated boxes do not");
    }

    [Test("grid snapping rounds to the nearest intersection")]
    public static void GridSnapping()
    {
        Assert.AreClose(64f, MathUtil.SnapToGrid(60f, 16f), Tol, "60 snaps to 64 on a 16 grid");
        Assert.AreClose(48f, MathUtil.SnapToGrid(52f, 16f), Tol, "52 snaps to 48 on a 16 grid");
        Assert.AreClose(0f, MathUtil.SnapToGrid(7f, 16f), Tol, "7 snaps to 0 on a 16 grid");
        Assert.AreClose(-64f, MathUtil.SnapToGrid(-60f, 16f), Tol, "negatives snap symmetrically");
        Assert.AreClose(60f, MathUtil.SnapToGrid(60f, 0f), Tol, "a zero grid is a no-op");
    }
}
