using System.Numerics;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Tests;

public static class TextureTests
{
    private const float Tol = 1e-3f;

    [Test("world alignment picks the axis pair matching the face")]
    public static void WorldAlignmentPicksAxes()
    {
        TextureAlignment floor = TextureAlignment.ForNormal(Vector3.UnitZ);
        Assert.AreClose(Vector3.UnitX, floor.UAxis, Tol, "floor u axis runs along +X");
        Assert.AreClose(-Vector3.UnitY, floor.VAxis, Tol, "floor v axis runs along -Y");

        TextureAlignment eastWall = TextureAlignment.ForNormal(Vector3.UnitX);
        Assert.AreClose(Vector3.UnitY, eastWall.UAxis, Tol, "wall u axis runs along +Y");
        Assert.AreClose(-Vector3.UnitZ, eastWall.VAxis, Tol, "wall v axis runs down");

        // Both texture axes must lie in the surface, or the projection would skew.
        foreach (Vector3 normal in new[] { Vector3.UnitZ, -Vector3.UnitZ, Vector3.UnitX, Vector3.UnitY, -Vector3.UnitY })
        {
            TextureAlignment alignment = TextureAlignment.ForNormal(normal);
            Assert.AreClose(0f, Vector3.Dot(alignment.UAxis, normal), Tol, $"u axis lies in the face for {normal}");
            Assert.AreClose(0f, Vector3.Dot(alignment.VAxis, normal), Tol, $"v axis lies in the face for {normal}");
        }
    }

    [Test("uv scales with texture size and texture scale")]
    public static void UvRespectsScaleAndSize()
    {
        var alignment = new TextureAlignment { UAxis = Vector3.UnitX, VAxis = -Vector3.UnitY, UScale = 0.25f, VScale = 0.25f };

        // At 0.25 units per pixel, a 128 pixel texture spans 32 world units.
        Assert.AreClose(0f, alignment.GetUV(Vector3.Zero, 128, 128).X, Tol, "origin maps to zero");
        Assert.AreClose(1f, alignment.GetUV(new Vector3(32, 0, 0), 128, 128).X, Tol, "32 units is one tile");
        Assert.AreClose(2f, alignment.GetUV(new Vector3(64, 0, 0), 128, 128).X, Tol, "64 units is two tiles");

        // Doubling the scale halves the tiling rate.
        alignment.UScale = 0.5f;
        Assert.AreClose(1f, alignment.GetUV(new Vector3(64, 0, 0), 128, 128).X, Tol, "a coarser scale stretches the texture");
    }

    [Test("shift offsets the projection in pixels")]
    public static void ShiftOffsetsProjection()
    {
        var alignment = new TextureAlignment { UAxis = Vector3.UnitX, UScale = 0.25f, UShift = 64f };
        Assert.AreClose(0.5f, alignment.GetUV(Vector3.Zero, 128, 128).X, Tol, "a 64 pixel shift is half a 128 pixel texture");
    }

    [Test("rotation turns the axes about the face normal")]
    public static void RotationTurnsAxes()
    {
        TextureAlignment alignment = TextureAlignment.ForNormal(Vector3.UnitZ);
        alignment.SetRotation(90f, Vector3.UnitZ);

        // Rotating the floor projection 90 degrees sends +X to +Y.
        Assert.AreClose(Vector3.UnitY, alignment.UAxis, Tol, "u axis rotated");
        Assert.AreClose(90f, alignment.Rotation, Tol, "rotation is recorded");

        // Axes stay in the plane and stay perpendicular to each other.
        Assert.AreClose(0f, Vector3.Dot(alignment.UAxis, Vector3.UnitZ), Tol, "u axis still lies in the face");
        Assert.AreClose(0f, Vector3.Dot(alignment.UAxis, alignment.VAxis), Tol, "axes stay orthogonal");

        alignment.SetRotation(0f, Vector3.UnitZ);
        Assert.AreClose(Vector3.UnitX, alignment.UAxis, Tol, "rotation is absolute, not cumulative");
    }

    [Test("face alignment lays the texture flat on a slope")]
    public static void FaceAlignmentFollowsSlope()
    {
        Brush wedge = BrushFactory.CreateWedge(new Aabb(new Vector3(-32), new Vector3(32)));
        Face slope = wedge.GeometryFaces.First(f => MathF.Abs(f.Plane.Normal.X) > 0.1f && MathF.Abs(f.Plane.Normal.Z) > 0.1f);

        // World alignment leaves the axes off the surface, which is what causes the
        // familiar "smeared" look on steep geometry.
        slope.AlignTexture(TextureAlignmentMode.World);
        Assert.Greater(MathF.Abs(Vector3.Dot(slope.Texture.UAxis, slope.Plane.Normal)), Tol,
            "world alignment does not follow the slope");

        slope.AlignTexture(TextureAlignmentMode.Face);
        Assert.AreClose(0f, Vector3.Dot(slope.Texture.UAxis, slope.Plane.Normal), Tol, "face alignment puts u in the surface");
        Assert.AreClose(0f, Vector3.Dot(slope.Texture.VAxis, slope.Plane.Normal), Tol, "face alignment puts v in the surface");
        Assert.AreClose(0f, Vector3.Dot(slope.Texture.UAxis, slope.Texture.VAxis), Tol, "axes are orthogonal");
        Assert.AreClose(1f, slope.Texture.UAxis.Length(), Tol, "u axis is unit length");
    }

    [Test("world projection makes textures continuous across neighbouring brushes")]
    public static void AdjacentBrushesShareContinuousUv()
    {
        // This is the payoff of world-space projection, and the reason UVs are not stored
        // per vertex: two independently created brushes line up with no manual work.
        Brush left = BrushFactory.CreateBox(new Aabb(new Vector3(0, 0, 0), new Vector3(64, 64, 16)));
        Brush right = BrushFactory.CreateBox(new Aabb(new Vector3(64, 0, 0), new Vector3(128, 64, 16)));

        Face leftTop = left.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);
        Face rightTop = right.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        var seam = new Vector3(64, 32, 16);
        Vector2 fromLeft = leftTop.GetUV(seam, 128, 128);
        Vector2 fromRight = rightTop.GetUV(seam, 128, 128);

        Assert.AreClose(fromLeft, fromRight, 1e-4f, "UVs agree exactly at the shared edge");
    }

    [Test("fit scales the texture to cover the face once")]
    public static void FitToWindingCoversOnce()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(64, 96, 16)));
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        top.Texture.FitToWinding(top.Winding!, 128, 128);

        float minU = float.MaxValue, minV = float.MaxValue;
        float maxU = float.MinValue, maxV = float.MinValue;
        foreach (Vector3 p in top.Winding!.Points)
        {
            Vector2 uv = top.GetUV(p, 128, 128);
            minU = MathF.Min(minU, uv.X);
            minV = MathF.Min(minV, uv.Y);
            maxU = MathF.Max(maxU, uv.X);
            maxV = MathF.Max(maxV, uv.Y);
        }

        Assert.AreClose(0f, minU, Tol, "u starts at zero");
        Assert.AreClose(0f, minV, Tol, "v starts at zero");
        Assert.AreClose(1f, maxU, Tol, "u ends at exactly one tile");
        Assert.AreClose(1f, maxV, Tol, "v ends at exactly one tile");
    }

    [Test("justify moves the texture origin to the face corner")]
    public static void JustifyMovesOrigin()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(100, 200, 0), new Vector3(164, 264, 16)));
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        top.Texture.JustifyToWinding(top.Winding!, 128, 128);

        float minU = top.Winding!.Points.Min(p => top.Texture.GetPixelCoords(p).X);
        float minV = top.Winding.Points.Min(p => top.Texture.GetPixelCoords(p).Y);
        Assert.AreClose(0f, minU, Tol, "u origin sits on the face corner");
        Assert.AreClose(0f, minV, Tol, "v origin sits on the face corner");
    }

    [Test("texture lock survives rotation")]
    public static void TextureLockSurvivesRotation()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        Vector3 sample = top.Winding![0];
        Vector2 before = top.GetUV(sample, 128, 128);

        Matrix4x4 rotate = Matrix4x4.CreateRotationZ(MathUtil.DegToRad(90f));
        box.Transform(rotate, textureLock: true);

        Vector2 after = top.GetUV(Vector3.Transform(sample, rotate), 128, 128);
        Assert.AreClose(before, after, 1e-3f, "rotating with texture lock carries the texture along");
    }

    [Test("texture lock compensates for scaling")]
    public static void TextureLockSurvivesScaling()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        Vector3 sample = top.Winding![0];
        Vector2 before = top.GetUV(sample, 128, 128);

        Matrix4x4 scale = Matrix4x4.CreateScale(2f, 2f, 1f);
        box.Transform(scale, textureLock: true);

        // The reference point keeps its coordinate; the scale absorbs the stretch.
        Vector2 after = top.GetUV(Vector3.Transform(sample, scale), 128, 128);
        Assert.AreClose(before, after, 1e-3f, "scaling with texture lock preserves the anchor UV");
        Assert.AreClose(0.5f, top.Texture.UScale, 1e-3f, "the stretch is folded into the scale");
    }

    [Test("material names imply surface flags")]
    public static void MaterialImpliesFlags()
    {
        Assert.AreEqual((int)SurfaceFlags.NoDraw, (int)MaterialDefaults.FlagsFor(MaterialDefaults.NoDraw), "nodraw");
        Assert.AreEqual((int)(SurfaceFlags.Hint | SurfaceFlags.Skip), (int)MaterialDefaults.FlagsFor(MaterialDefaults.Hint), "hint");
        Assert.AreEqual((int)SurfaceFlags.None, (int)MaterialDefaults.FlagsFor("concrete/wall01"), "an ordinary material has no flags");

        // Backslashes are normalised, so Windows-style paths behave the same.
        Assert.AreEqual((int)SurfaceFlags.NoDraw, (int)MaterialDefaults.FlagsFor(@"tools\toolsnodraw"), "backslash path");
    }
}
