using System.Numerics;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Tests;

public static class BrushTests
{
    private const float Tol = 1e-2f;

    private static Aabb Box64 => new(new Vector3(-32), new Vector3(32));

    [Test("a box has six faces, eight vertices, and the right volume")]
    public static void BoxGeometry()
    {
        Brush box = BrushFactory.CreateBox(Box64);

        Assert.AreEqual(6, box.Faces.Count, "a box has six planes");
        Assert.AreEqual(6, box.GeometryFaces.Count(), "all six contribute surface area");
        Assert.AreEqual(8, box.GetVertices().Count, "a box has eight corners");
        Assert.IsTrue(box.IsValid, "a box is a valid solid");

        Assert.AreClose(64f * 64f * 64f, box.Volume, 1f, "volume of a 64-unit cube");
        Assert.AreClose(6f * 64f * 64f, box.SurfaceArea, 1f, "surface area of a 64-unit cube");
        Assert.AreClose(new Vector3(-32), box.Bounds.Min, Tol, "bounds minimum");
        Assert.AreClose(new Vector3(32), box.Bounds.Max, Tol, "bounds maximum");
    }

    [Test("every box face polygon is a 64x64 square facing outward")]
    public static void BoxFacesFaceOutward()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        Vector3 centre = box.Center;

        foreach (Face face in box.GeometryFaces)
        {
            Assert.AreEqual(4, face.Winding!.Count, "a box face is a quad");
            Assert.AreClose(64f * 64f, face.Winding.Area, 1f, "box face area");

            // The winding's derived normal must agree with the stored plane, and the
            // plane must point away from the solid's interior.
            Assert.AreClose(face.Plane.Normal, face.Winding.GetPlane().Normal, Tol, "winding agrees with plane");
            Assert.Less(face.Plane.Distance(centre), 0f, "the brush centre is behind every face");
        }
    }

    [Test("a plane that the solid cuts away contributes no polygon")]
    public static void RedundantPlaneYieldsNoWinding()
    {
        Brush box = BrushFactory.CreateBox(Box64);

        // A plane far outside the box is entirely clipped away by the other half-spaces.
        var stray = new Face(new Plane3(Vector3.UnitX, 1000f));
        box.AddFace(stray);
        box.Rebuild();

        Assert.IsNull(stray.Winding, "a redundant plane produces no geometry");
        Assert.AreEqual(6, box.GeometryFaces.Count(), "the box still has six real faces");
        Assert.AreClose(64f * 64f * 64f, box.Volume, 1f, "a redundant plane does not change volume");
        Assert.IsTrue(box.IsValid, "the brush is still valid");
    }

    [Test("containment is exact for a convex solid")]
    public static void ContainsPoint()
    {
        Brush box = BrushFactory.CreateBox(Box64);

        Assert.IsTrue(box.ContainsPoint(Vector3.Zero), "centre is inside");
        Assert.IsTrue(box.ContainsPoint(new Vector3(31.9f, -31.9f, 0f)), "near-corner is inside");
        Assert.IsTrue(box.ContainsPoint(new Vector3(32f, 0f, 0f)), "a point on the surface counts as inside");
        Assert.IsFalse(box.ContainsPoint(new Vector3(32.5f, 0f, 0f)), "a point just outside is rejected");
        Assert.IsFalse(box.ContainsPoint(new Vector3(0f, 0f, 500f)), "a far point is rejected");
    }

    [Test("a wedge is exactly half its bounding box")]
    public static void WedgeIsHalfBox()
    {
        Brush wedge = BrushFactory.CreateWedge(Box64);

        Assert.IsTrue(wedge.IsValid, "wedge is a valid solid");
        Assert.AreEqual(5, wedge.GeometryFaces.Count(), "a triangular prism has five faces");
        Assert.AreClose(64f * 64f * 64f / 2f, wedge.Volume, 1f, "a right prism is half the box");
    }

    [Test("a prism volume matches the regular polygon formula")]
    public static void CylinderVolume()
    {
        const int sides = 8;
        Brush cylinder = BrushFactory.CreateCylinder(Box64, sides);

        Assert.IsTrue(cylinder.IsValid, "cylinder is a valid solid");
        Assert.AreEqual(sides + 2, cylinder.GeometryFaces.Count(), "sides plus a cap at each end");

        // Regular n-gon inscribed in a circle of radius r: area = 0.5 * n * r^2 * sin(2pi/n)
        const float radius = 32f;
        float baseArea = 0.5f * sides * radius * radius * MathF.Sin(MathF.Tau / sides);
        Assert.AreClose(baseArea * 64f, cylinder.Volume, baseArea * 0.01f, "prism volume");
    }

    [Test("a spike volume is one third of the matching prism")]
    public static void SpikeVolume()
    {
        const int sides = 8;
        Brush spike = BrushFactory.CreateSpike(Box64, sides);

        Assert.IsTrue(spike.IsValid, "spike is a valid solid");
        Assert.AreEqual(sides + 1, spike.GeometryFaces.Count(), "sloped sides plus one floor");

        const float radius = 32f;
        float baseArea = 0.5f * sides * radius * radius * MathF.Sin(MathF.Tau / sides);
        float expected = baseArea * 64f / 3f;
        Assert.AreClose(expected, spike.Volume, expected * 0.02f, "pyramid volume is base * height / 3");
    }

    [Test("a sphere circumscribes the ideal sphere and fits its box")]
    public static void SphereBounds()
    {
        Brush sphere = BrushFactory.CreateSphere(Box64, 12);

        Assert.IsTrue(sphere.IsValid, "sphere is a valid solid");

        // Built from tangent planes, so it strictly contains the true sphere while
        // staying inside the bounding box that generated it.
        float idealVolume = 4f / 3f * MathF.PI * 32f * 32f * 32f;
        Assert.Greater(sphere.Volume, idealVolume, "tangent-plane hull contains the true sphere");
        Assert.Less(sphere.Volume, 64f * 64f * 64f, "and is smaller than its bounding box");

        foreach (Vector3 v in sphere.GetVertices())
            Assert.Less(v.Length(), 32f * 1.3f, "vertices stay near the surface");
    }

    [Test("brush intersection detects overlap and separation")]
    public static void IntersectsDetectsOverlap()
    {
        Brush a = BrushFactory.CreateBox(Box64);

        Assert.IsTrue(a.Intersects(BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(64)))),
            "overlapping boxes intersect");
        Assert.IsTrue(a.Intersects(BrushFactory.CreateBox(new Aabb(new Vector3(-8), new Vector3(8)))),
            "a fully contained box intersects");
        Assert.IsFalse(a.Intersects(BrushFactory.CreateBox(new Aabb(new Vector3(64), new Vector3(128)))),
            "separated boxes do not intersect");

        // Diagonally offset so the bounding boxes overlap but the solids do not.
        Brush diagonal = BrushFactory.CreateCylinder(new Aabb(new Vector3(20, 20, -100), new Vector3(120, 120, 100)), 6);
        bool overlaps = a.Intersects(diagonal);
        Assert.IsTrue(overlaps == diagonal.Intersects(a), "intersection is symmetric");
    }

    [Test("translation moves the solid and keeps its volume")]
    public static void TranslationPreservesVolume()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        float volume = box.Volume;

        box.Translate(new Vector3(128, -64, 32));

        Assert.AreClose(volume, box.Volume, 1f, "translation preserves volume");
        Assert.AreClose(new Vector3(96, -96, 0), box.Bounds.Min, Tol, "bounds moved");
        Assert.IsTrue(box.ContainsPoint(new Vector3(128, -64, 32)), "the new centre is inside");
    }

    [Test("mirroring keeps the solid right side out")]
    public static void MirroringKeepsSolidValid()
    {
        // Deliberately asymmetric, so an inside-out result cannot hide behind symmetry.
        Brush box = BrushFactory.CreateBox(new Aabb(Vector3.Zero, new Vector3(64, 32, 16)));
        float volume = box.Volume;

        box.Transform(Matrix4x4.CreateScale(-1f, 1f, 1f), textureLock: false);

        // A negative volume is the signature of inverted face normals.
        Assert.Greater(box.Volume, 0f, "mirrored brush must not be inside out");
        Assert.AreClose(volume, box.Volume, 1f, "mirroring preserves volume magnitude");
        Assert.AreClose(new Vector3(-64, 0, 0), box.Bounds.Min, Tol, "mirrored bounds minimum");
        Assert.AreClose(new Vector3(0, 32, 16), box.Bounds.Max, Tol, "mirrored bounds maximum");
        Assert.IsTrue(box.ContainsPoint(new Vector3(-32, 16, 8)), "the mirrored interior is still interior");

        Vector3 centre = box.Center;
        foreach (Face face in box.GeometryFaces)
            Assert.Less(face.Plane.Distance(centre), 0f, "every face still points away from the interior");
    }

    [Test("rotation preserves volume")]
    public static void RotationPreservesVolume()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        float volume = box.Volume;

        box.Transform(Matrix4x4.CreateRotationZ(MathUtil.DegToRad(37f)), textureLock: false);

        Assert.AreClose(volume, box.Volume, 10f, "rotation preserves volume");
        Assert.IsTrue(box.IsValid, "rotated brush is still valid");
    }

    [Test("uniform scaling cubes the volume")]
    public static void ScalingScalesVolume()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        float volume = box.Volume;

        box.Transform(Matrix4x4.CreateScale(2f), textureLock: false);

        Assert.AreClose(volume * 8f, box.Volume, volume * 0.01f, "doubling every axis multiplies volume by eight");
    }

    [Test("hollowing leaves a sealed cavity")]
    public static void HollowLeavesCavity()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-128), new Vector3(128)));
        List<Brush> walls = BrushFactory.Hollow(box, 16f);

        Assert.AreEqual(6, walls.Count, "a hollow box yields six walls");
        foreach (Brush wall in walls)
            Assert.IsTrue(wall.IsValid, "each wall is a valid solid");

        // The middle must be empty, and points inside the shell must be solid.
        Assert.IsFalse(walls.Any(w => w.ContainsPoint(Vector3.Zero)), "the interior is hollow");
        Assert.IsTrue(walls.Any(w => w.ContainsPoint(new Vector3(0, 0, 120))), "the ceiling slab is solid");
        Assert.IsTrue(walls.Any(w => w.ContainsPoint(new Vector3(-120, 0, 0))), "the west wall is solid");

        // Walls overlap at the corners (as they do in Hammer), so the shell volume is
        // between the ideal shell and the sum of unclipped slabs.
        float idealShell = 256f * 256f * 256f - 224f * 224f * 224f;
        float total = walls.Sum(w => w.Volume);
        Assert.Greater(total, idealShell * 0.99f, "shell covers at least the ideal wall volume");
        Assert.Less(total, idealShell * 1.5f, "corner overlap is bounded");
    }

    [Test("texture lock keeps UVs glued to a moving surface")]
    public static void TextureLockKeepsUvStable()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        Vector3 sample = top.Winding![0];
        Vector2 before = top.GetUV(sample, 128, 128);

        var offset = new Vector3(37f, -91f, 13f);
        box.Translate(offset, textureLock: true);

        Vector2 after = top.GetUV(sample + offset, 128, 128);
        Assert.AreClose(before, after, 1e-3f, "UVs travel with the surface under texture lock");
    }

    [Test("without texture lock the surface slides under the texture")]
    public static void WithoutTextureLockUvSlides()
    {
        Brush box = BrushFactory.CreateBox(Box64);
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        Vector3 sample = top.Winding![0];
        Vector2 before = top.GetUV(sample, 128, 128);

        var offset = new Vector3(37f, 0f, 0f);
        box.Translate(offset, textureLock: false);

        Vector2 after = top.GetUV(sample + offset, 128, 128);
        Assert.Greater(MathF.Abs(after.X - before.X), 1e-3f, "the projection stays fixed in world space");
    }

    [Test("plane snapping removes accumulated drift")]
    public static void SnapPlanesRemovesDrift()
    {
        var drifted = new Brush();
        foreach ((Vector3 normal, float dist) in new (Vector3, float)[]
        {
            (Vector3.UnitX, 32.000004f), (-Vector3.UnitX, 31.999996f),
            (Vector3.UnitY, 32.000004f), (-Vector3.UnitY, 31.999996f),
            (Vector3.UnitZ, 32.000004f), (-Vector3.UnitZ, 31.999996f),
        })
        {
            drifted.AddFace(new Face(new Plane3(normal, dist)));
        }

        drifted.SnapPlanes();
        drifted.Rebuild();

        Assert.AreClose(64f * 64f * 64f, drifted.Volume, 0.01f, "snapped box has exact volume");
        foreach (Vector3 v in drifted.GetVertices())
        {
            Assert.AreClose(32f, MathF.Abs(v.X), 0f, "vertex X is bit-exact");
            Assert.AreClose(32f, MathF.Abs(v.Y), 0f, "vertex Y is bit-exact");
            Assert.AreClose(32f, MathF.Abs(v.Z), 0f, "vertex Z is bit-exact");
        }
    }

    [Test("an unbounded plane set is not a valid solid")]
    public static void UnboundedPlaneSetIsInvalid()
    {
        // Three planes cannot enclose a volume; the result runs off to the world edge.
        var open = new Brush();
        open.AddFace(new Face(new Plane3(Vector3.UnitX, 32f)));
        open.AddFace(new Face(new Plane3(Vector3.UnitY, 32f)));
        open.AddFace(new Face(new Plane3(Vector3.UnitZ, 32f)));
        open.Rebuild();

        Assert.IsFalse(open.IsValid, "an open plane set must be rejected");
        Assert.IsNull(BrushFactory.CreateFromPlanes(new[]
        {
            new Plane3(Vector3.UnitX, 32f),
            new Plane3(Vector3.UnitY, 32f),
            new Plane3(Vector3.UnitZ, 32f),
        }), "CreateFromPlanes returns null for an unbounded set");
    }

    [Test("cloning produces an independent solid")]
    public static void CloneIsIndependent()
    {
        Brush original = BrushFactory.CreateBox(Box64);
        Brush copy = original.Clone();

        copy.Translate(new Vector3(1000, 0, 0));

        Assert.AreClose(new Vector3(-32), original.Bounds.Min, Tol, "moving the clone leaves the original alone");
        Assert.AreClose(new Vector3(968, -32, -32), copy.Bounds.Min, Tol, "the clone moved");

        copy.SetMaterial("concrete/wall01");
        Assert.AreEqual(MaterialDefaults.Placeholder, original.Faces[0].Material, "materials are not shared");
    }
}
