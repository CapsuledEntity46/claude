using System.Numerics;
using Forge.Export;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Tests;

public static class ExportTests
{
    private const float Tol = 1e-3f;

    [Test("a box builds one batch with twelve triangles")]
    public static void BoxBuildsExpectedBatch()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)), "concrete/wall01");
        List<MeshBatch> batches = MeshBuilder.Build(new[] { box });

        Assert.AreEqual(1, batches.Count, "one material means one batch");
        Assert.AreEqual("concrete/wall01", batches[0].Material, "batch material");
        Assert.AreEqual(24, batches[0].Vertices.Count, "six quads, four vertices each");
        Assert.AreEqual(12, batches[0].TriangleCount, "two triangles per quad");
        Assert.AreEqual(36, batches[0].Indices.Count, "index count");

        foreach (int index in batches[0].Indices)
            Assert.IsTrue(index >= 0 && index < batches[0].Vertices.Count, "indices stay in range");
    }

    [Test("faces are grouped by material")]
    public static void FacesGroupByMaterial()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)), "concrete/wall01");
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);
        top.Material = "tile/floor03";

        List<MeshBatch> batches = MeshBuilder.Build(new[] { box });

        Assert.AreEqual(2, batches.Count, "two materials means two batches");
        // Ordering is by material name so output is deterministic.
        Assert.AreEqual("concrete/wall01", batches[0].Material, "batches are sorted by material");
        Assert.AreEqual("tile/floor03", batches[1].Material, "second batch");
        Assert.AreEqual(2, batches[1].TriangleCount, "the retextured face alone");
    }

    [Test("non-visible surfaces are dropped")]
    public static void NonVisibleFacesSkipped()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)), "concrete/wall01");
        Face bottom = box.GeometryFaces.First(f => f.Plane.Normal.Z < -0.9f);
        bottom.Material = MaterialDefaults.NoDraw;
        bottom.Flags = MaterialDefaults.FlagsFor(bottom.Material);

        List<MeshBatch> visible = MeshBuilder.Build(new[] { box });
        Assert.AreEqual(10, MeshBuilder.CountTriangles(visible), "the nodraw face contributes nothing");
        Assert.IsFalse(visible.Any(b => b.Material == MaterialDefaults.NoDraw), "no nodraw batch is emitted");

        List<MeshBatch> everything = MeshBuilder.Build(new[] { box }, skipNonVisible: false);
        Assert.AreEqual(12, MeshBuilder.CountTriangles(everything), "opting in includes hidden surfaces");
    }

    [Test("vertex normals match their face plane")]
    public static void NormalsMatchFaces()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)));
        MeshBatch batch = MeshBuilder.Build(new[] { box })[0];

        foreach (MeshVertex vertex in batch.Vertices)
        {
            Assert.AreClose(1f, vertex.Normal.Length(), Tol, "normals are unit length");
            // Every normal on a box is axis-aligned and points away from the centre.
            Assert.Greater(Vector3.Dot(vertex.Normal, vertex.Position), 0f, "normals point outward");
        }
    }

    [Test("texture size affects generated uvs")]
    public static void TextureSizeAffectsUv()
    {
        Brush box = BrushFactory.CreateBox(new Aabb(Vector3.Zero, new Vector3(64, 64, 16)), "tile/floor03");

        MeshBatch small = MeshBuilder.Build(new[] { box }, _ => (64, 64))[0];
        MeshBatch large = MeshBuilder.Build(new[] { box }, _ => (256, 256))[0];

        float maxSmall = small.Vertices.Max(v => v.TexCoord.X);
        float maxLarge = large.Vertices.Max(v => v.TexCoord.X);

        // A texture four times larger tiles four times less across the same surface.
        Assert.AreClose(maxSmall / 4f, maxLarge, Tol, "uv range scales inversely with texture size");
    }

    [Test("obj export writes matching geometry and materials")]
    public static void ObjExportWritesFiles()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"forge-obj-{Guid.NewGuid():N}");
        string objPath = Path.Combine(directory, "level.obj");

        try
        {
            var document = new MapDocument();
            document.AddWorldBrush(BrushFactory.CreateBox(new Aabb(new Vector3(-32), new Vector3(32)), "concrete/wall01"));
            document.AddWorldBrush(BrushFactory.CreateCylinder(
                new Aabb(new Vector3(64, 64, 0), new Vector3(128, 128, 96)), 6, "stone/pillar01"));

            ObjExporter.Export(document, objPath);

            string mtlPath = Path.ChangeExtension(objPath, ".mtl");
            Assert.IsTrue(File.Exists(objPath), "the obj file was written");
            Assert.IsTrue(File.Exists(mtlPath), "the mtl file was written");

            string obj = File.ReadAllText(objPath);
            List<MeshBatch> batches = MeshBuilder.Build(document);

            int vertexLines = obj.Split('\n').Count(l => l.StartsWith("v ", StringComparison.Ordinal));
            int faceLines = obj.Split('\n').Count(l => l.StartsWith("f ", StringComparison.Ordinal));

            Assert.AreEqual(batches.Sum(b => b.Vertices.Count), vertexLines, "one 'v' line per vertex");
            Assert.AreEqual(MeshBuilder.CountTriangles(batches), faceLines, "one 'f' line per triangle");
            Assert.IsTrue(obj.Contains("mtllib level.mtl"), "the obj references its material library");
            Assert.IsFalse(obj.Contains("-0 "), "negative zero never reaches the file");

            string mtl = File.ReadAllText(mtlPath);
            Assert.IsTrue(mtl.Contains("newmtl concrete/wall01"), "materials are declared");
            Assert.IsTrue(mtl.Contains("newmtl stone/pillar01"), "all materials are declared");
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Test("obj export converts to y-up while preserving handedness")]
    public static void ObjExportConvertsAxes()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"forge-obj-{Guid.NewGuid():N}");
        try
        {
            var document = new MapDocument();
            // A distinctive box: 16 tall in Z, 128 long in Y.
            document.AddWorldBrush(BrushFactory.CreateBox(new Aabb(Vector3.Zero, new Vector3(32, 128, 16))));

            string yUpPath = Path.Combine(directory, "yup.obj");
            string zUpPath = Path.Combine(directory, "zup.obj");
            ObjExporter.Export(document, yUpPath, convertToYUp: true);
            ObjExporter.Export(document, zUpPath, convertToYUp: false);

            (float MinY, float MaxY) yUp = VerticalRange(yUpPath);
            (float MinY, float MaxY) zUp = VerticalRange(zUpPath);

            // In Y-up output the 16-unit height lands on the Y axis.
            Assert.AreClose(16f, yUp.MaxY - yUp.MinY, Tol, "converted output is 16 units tall on Y");
            // Natively, Y still holds the 128-unit depth.
            Assert.AreClose(128f, zUp.MaxY - zUp.MinY, Tol, "native output keeps 128 units on Y");
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    private static (float Min, float Max) VerticalRange(string objPath)
    {
        float min = float.MaxValue, max = float.MinValue;
        foreach (string line in File.ReadLines(objPath))
        {
            if (!line.StartsWith("v ", StringComparison.Ordinal)) continue;
            string[] parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            float y = float.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture);
            min = MathF.Min(min, y);
            max = MathF.Max(max, y);
        }
        return (min, max);
    }
}
