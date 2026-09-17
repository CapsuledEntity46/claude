using System.Numerics;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Tests;

public static class CsgTests
{
    private static Brush Wall => BrushFactory.CreateBox(new Aabb(new Vector3(-128, -8, 0), new Vector3(128, 8, 128)));

    private static Brush Doorway => BrushFactory.CreateBox(new Aabb(new Vector3(-24, -32, 0), new Vector3(24, 32, 96)));

    [Test("splitting a brush conserves its volume")]
    public static void SplitConservesVolume()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        float volume = box.Volume;

        Csg.Split(box, new Plane3(Vector3.UnitX, 10f), out Brush? front, out Brush? back);

        Assert.IsNotNull(front, "front piece exists");
        Assert.IsNotNull(back, "back piece exists");
        Assert.AreClose(volume, front!.Volume + back!.Volume, 1f, "the two pieces conserve volume");
        Assert.AreClose(22f * 64f * 64f, front.Volume, 1f, "front piece spans x in [10, 32]");
        Assert.AreClose(42f * 64f * 64f, back.Volume, 1f, "back piece spans x in [-32, 10]");

        Assert.IsTrue(front.ContainsPoint(new Vector3(20, 0, 0)), "front piece holds the +X side");
        Assert.IsTrue(back.ContainsPoint(new Vector3(-20, 0, 0)), "back piece holds the -X side");
        Assert.IsFalse(back.ContainsPoint(new Vector3(20, 0, 0)), "the pieces do not overlap");
    }

    [Test("a plane that misses the brush leaves it whole")]
    public static void SplitOutsideLeavesBrushWhole()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));

        Csg.Split(box, new Plane3(Vector3.UnitX, 500f), out Brush? front, out Brush? back);
        Assert.IsNull(front, "nothing is in front of a distant plane");
        Assert.IsNotNull(back, "the whole brush is behind it");
        Assert.AreClose(box.Volume, back!.Volume, 1f, "volume unchanged");
    }

    [Test("the clip tool keeps the half behind the plane")]
    public static void ClipKeepsBackHalf()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        Brush? clipped = Csg.Clip(box, new Plane3(Vector3.UnitZ, 0f));

        Assert.IsNotNull(clipped, "the lower half survives");
        Assert.AreClose(64f * 64f * 32f, clipped!.Volume, 1f, "half the volume remains");
        Assert.IsTrue(clipped.ContainsPoint(new Vector3(0, 0, -16)), "below the plane is kept");
        Assert.IsFalse(clipped.ContainsPoint(new Vector3(0, 0, 16)), "above the plane is gone");
    }

    [Test("subtracting a disjoint brush changes nothing")]
    public static void SubtractDisjointIsIdentity()
    {
        Brush wall = Wall;
        Brush far = BrushFactory.CreateBox(new Aabb(new Vector3(1000), new Vector3(1064)));

        List<Brush> result = Csg.Subtract(wall, far);

        Assert.AreEqual(1, result.Count, "a disjoint cutter leaves one brush");
        Assert.AreClose(wall.Volume, result[0].Volume, 1f, "volume unchanged");
    }

    [Test("subtracting an enclosing brush removes everything")]
    public static void SubtractEnclosingRemovesAll()
    {
        Brush small = BrushFactory.CreateBox(new Aabb(new Vector3(-8), new Vector3(8)));
        Brush huge = BrushFactory.CreateBox(new Aabb(new Vector3(-64), new Vector3(64)));

        List<Brush> result = Csg.Subtract(small, huge);

        Assert.AreEqual(0, result.Count, "nothing survives being fully carved away");
    }

    [Test("carving a doorway conserves volume exactly")]
    public static void CarveConservesVolume()
    {
        Brush wall = Wall;
        Brush door = Doorway;

        float wallVolume = wall.Volume;
        List<Brush> fragments = Csg.Subtract(wall, door);
        Brush? overlap = Csg.Intersection(wall, door);

        Assert.IsNotNull(overlap, "the wall and doorway do overlap");
        Assert.Greater(fragments.Count, 0f, "carving produces fragments");

        float fragmentVolume = fragments.Sum(f => f.Volume);

        // The defining invariant: fragments tile exactly the part of the wall outside the
        // cutter, so fragments + overlap must reconstruct the original wall.
        Assert.AreClose(wallVolume, fragmentVolume + overlap!.Volume, wallVolume * 1e-4f,
            "fragments plus overlap reconstruct the original solid");

        // The removed volume is the doorway clipped to the wall's thickness.
        Assert.AreClose(48f * 16f * 96f, overlap.Volume, 1f, "removed volume is the doorway within the wall");
    }

    [Test("carve fragments cover exactly the intended region")]
    public static void CarveFragmentsAreCorrectPointwise()
    {
        Brush wall = Wall;
        Brush door = Doorway;
        List<Brush> fragments = Csg.Subtract(wall, door);

        // Sample on a deliberately irregular lattice so samples rarely land on a face
        // plane, then skip any that are still too close to one to classify confidently.
        int checkedSamples = 0;
        for (float x = -130f; x <= 130f; x += 7.3f)
        for (float y = -10f; y <= 10f; y += 3.1f)
        for (float z = -2f; z <= 130f; z += 5.7f)
        {
            var p = new Vector3(x, y, z);
            if (NearAnyFace(wall, p) || NearAnyFace(door, p)) continue;

            bool expected = wall.ContainsPoint(p) && !door.ContainsPoint(p);
            bool actual = fragments.Any(f => f.ContainsPoint(p));

            if (expected != actual)
                Assert.Fail($"point ({x:0.#} {y:0.#} {z:0.#}) should {(expected ? "be" : "not be")} covered by the carve result");

            // Fragments must tile without overlapping: a point strictly inside one
            // fragment must not be strictly inside another.
            int strictlyInside = fragments.Count(f => f.ContainsPoint(p, -0.5f));
            if (strictlyInside > 1)
                Assert.Fail($"point ({x:0.#} {y:0.#} {z:0.#}) is inside {strictlyInside} fragments; they must be disjoint");

            checkedSamples++;
        }

        Assert.Greater(checkedSamples, 500f, "the sampling actually exercised the volume");
    }

    [Test("carved surfaces inherit the cutter's material")]
    public static void CarveInheritsCutterMaterial()
    {
        Brush wall = Wall;
        wall.SetMaterial("concrete/wall01");

        Brush door = Doorway;
        door.SetMaterial("trim/doorframe");

        List<Brush> fragments = Csg.Subtract(wall, door, inheritCutterMaterials: true);
        bool anyTrim = fragments.Any(f => f.Faces.Any(face => face.Material == "trim/doorframe"));
        Assert.IsTrue(anyTrim, "newly exposed faces take the cutter's material");

        List<Brush> blended = Csg.Subtract(wall, door, inheritCutterMaterials: false);
        bool noTrim = blended.All(f => f.Faces.All(face => face.Material == "concrete/wall01"));
        Assert.IsTrue(noTrim, "with inheritance off, new faces blend with the target");
    }

    [Test("intersection is the shared volume")]
    public static void IntersectionVolume()
    {
        Brush a = BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(64)));
        Brush b = BrushFactory.CreateBox(new Aabb(new Vector3(32), new Vector3(96)));

        Brush? overlap = Csg.Intersection(a, b);

        Assert.IsNotNull(overlap, "the boxes overlap");
        Assert.AreClose(32f * 32f * 32f, overlap!.Volume, 1f, "overlap is a 32-unit cube");
        Assert.IsTrue(overlap.ContainsPoint(new Vector3(48)), "the shared centre is inside");

        Assert.IsNull(Csg.Intersection(a, BrushFactory.CreateBox(new Aabb(new Vector3(1000), new Vector3(1064)))),
            "disjoint brushes have no intersection");
    }

    [Test("merging rejoins a brush that was split")]
    public static void MergeRejoinsSplitBrush()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        float volume = box.Volume;

        Csg.Split(box, new Plane3(Vector3.UnitX, 0f), out Brush? front, out Brush? back);
        Brush? merged = Csg.TryMerge(front!, back!);

        Assert.IsNotNull(merged, "two halves of a box form a convex union");
        Assert.AreClose(volume, merged!.Volume, 1f, "the merge restores the original volume");
        Assert.AreEqual(6, merged.GeometryFaces.Count(), "the internal wall is gone");
    }

    [Test("merging refuses a concave union")]
    public static void MergeRefusesConcaveUnion()
    {
        // An L shape: the two arms share part of a plane, but their union is concave.
        Brush arm = BrushFactory.CreateBox(new Aabb(new Vector3(0, 0, 0), new Vector3(64, 32, 32)));
        Brush stub = BrushFactory.CreateBox(new Aabb(new Vector3(0, 32, 0), new Vector3(32, 64, 32)));

        Assert.IsNull(Csg.TryMerge(arm, stub), "a concave union must not be merged");
    }

    [Test("merging refuses brushes that only touch at a corner")]
    public static void MergeRefusesCornerTouch()
    {
        Brush a = BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(32)));
        Brush b = BrushFactory.CreateBox(new Aabb(new Vector3(32), new Vector3(64)));

        Assert.IsNull(Csg.TryMerge(a, b), "corner-touching brushes do not form a convex solid");
    }

    [Test("merge all simplifies redundant splits")]
    public static void MergeAllSimplifies()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-64), new Vector3(64)));
        float volume = box.Volume;

        // Slice into four slabs, then let MergeAll put them back together.
        List<Brush> slabs = Csg.SplitAll(new[] { box }, new Plane3(Vector3.UnitX, 0f));
        slabs = Csg.SplitAll(slabs, new Plane3(Vector3.UnitX, 32f));
        Assert.AreEqual(3, slabs.Count, "three slabs after two cuts");

        List<Brush> merged = Csg.MergeAll(slabs);

        Assert.AreEqual(1, merged.Count, "the slabs recombine into one box");
        Assert.AreClose(volume, merged[0].Volume, 1f, "volume is preserved through split and merge");
    }

    [Test("carving with a cylinder yields valid solids")]
    public static void CarveWithCylinder()
    {
        Brush floor = BrushFactory.CreateBox(new Aabb(new Vector3(-128, -128, -16), new Vector3(128, 128, 0)));
        Brush hole = BrushFactory.CreateCylinder(new Aabb(new Vector3(-32, -32, -64), new Vector3(32, 32, 64)), 8);

        float floorVolume = floor.Volume;
        List<Brush> fragments = Csg.Subtract(floor, hole);
        Brush? overlap = Csg.Intersection(floor, hole);

        Assert.Greater(fragments.Count, 3f, "a round hole needs several fragments");
        foreach (Brush fragment in fragments)
        {
            Assert.IsTrue(fragment.IsValid, "every fragment is a valid convex solid");
            Assert.Greater(fragment.Volume, 0f, "every fragment has positive volume");
        }

        Assert.IsNotNull(overlap, "the cylinder meets the floor");
        Assert.AreClose(floorVolume, fragments.Sum(f => f.Volume) + overlap!.Volume, floorVolume * 1e-3f,
            "volume is conserved when carving with a prism");

        Assert.IsFalse(fragments.Any(f => f.ContainsPoint(new Vector3(0, 0, -8))),
            "the middle of the hole is empty");
    }

    [Test("carving twice is order independent in total volume")]
    public static void SequentialCarvesConserveVolume()
    {
        Brush wall = Wall;
        float wallVolume = wall.Volume;

        Brush windowA = BrushFactory.CreateBox(new Aabb(new Vector3(-96, -32, 48), new Vector3(-48, 32, 96)));
        Brush windowB = BrushFactory.CreateBox(new Aabb(new Vector3(48, -32, 48), new Vector3(96, 32, 96)));

        List<Brush> once = Csg.Subtract(wall, windowA);
        List<Brush> twice = Csg.Subtract(once, windowB);

        // Two disjoint windows remove two independent volumes.
        float removed = 48f * 16f * 48f * 2f;
        Assert.AreClose(wallVolume - removed, twice.Sum(f => f.Volume), wallVolume * 1e-3f,
            "sequential carves remove both windows and nothing more");

        foreach (Brush fragment in twice)
            Assert.IsTrue(fragment.IsValid, "fragments stay valid across sequential carves");
    }

    /// <summary>
    /// True when the point sits close enough to any of the brush's face planes that
    /// containment is ambiguous at our tolerances.
    /// </summary>
    private static bool NearAnyFace(Brush brush, Vector3 point, float margin = 0.75f)
    {
        foreach (Face face in brush.Faces)
        {
            if (MathF.Abs(face.Plane.Distance(point)) < margin) return true;
        }
        return false;
    }
}
