using System.Numerics;
using Forge.Geometry;
using Forge.Map;
using Forge.Serialization;

namespace Forge.Tests;

public static class MapFormatTests
{
    private const float Tol = 1e-3f;

    private static MapDocument BuildSampleMap()
    {
        var document = new MapDocument();
        document.SkyName = "sky_dusk02";

        // A hollow room, so the sample exercises non-trivial brush geometry.
        document.AddWorldBrushes(BrushFactory.CreateRoom(
            new Aabb(new Vector3(-256, -256, 0), new Vector3(256, 256, 192)), 16f, "concrete/wall01"));

        // Oblique planes too. Axis-aligned geometry round-trips trivially; slanted and
        // faceted surfaces are where a text format actually gets tested.
        document.AddWorldBrush(BrushFactory.CreateCylinder(
            new Aabb(new Vector3(-24, -24, 0), new Vector3(24, 24, 192)), 8, "stone/pillar01"));
        document.AddWorldBrush(BrushFactory.CreateWedge(
            new Aabb(new Vector3(96, -128, 0), new Vector3(224, 0, 64)), "concrete/ramp01"));

        var spawn = new Entity("info_player_start")
        {
            Origin = new Vector3(0, -128, 24),
            Angles = new Vector3(0, 90, 0),
        };
        document.AddEntity(spawn);

        var light = new Entity("light");
        light.Origin = new Vector3(0, 0, 160);
        light.SetInt("brightness", 400);
        light.SetString("_light", "255 240 220");
        document.AddEntity(light);

        var door = new Entity("func_door") { TargetName = "vault_door" };
        door.SetFloat("speed", 96.5f);
        door.Brushes.Add(BrushFactory.CreateBox(
            new Aabb(new Vector3(-32, 236, 0), new Vector3(32, 252, 112)), "metal/door01"));
        document.AddEntity(door);

        var button = new Entity("func_button") { TargetName = "vault_button" };
        button.Origin = new Vector3(64, 236, 48);
        button.Outputs.Add(new Output
        {
            Name = "OnPressed",
            TargetEntity = "vault_door",
            TargetInput = "Open",
            Delay = 0.5f,
            TimesToFire = 1,
        });
        button.Outputs.Add(new Output
        {
            Name = "OnPressed",
            TargetEntity = "vault_door",
            TargetInput = "Lock",
            Parameter = "yes",
            Delay = 5f,
        });
        document.AddEntity(button);

        document.VisGroups.Add(new VisGroup { Name = "Lighting", Visible = false, Color = new ColorRgb(255, 200, 0) });
        document.Cameras.Add(new CameraBookmark { Position = new Vector3(0, -512, 128), Look = new Vector3(0, 0, 96) });

        return document;
    }

    [Test("the parser reads properties and nested blocks")]
    public static void ParserReadsNestedBlocks()
    {
        const string text = """
            // a leading comment
            world
            {
                "id" "1"
                "classname" "worldspawn"
                solid
                {
                    "id" "2"
                    side
                    {
                        "id" "3"
                        "material" "concrete/wall01"
                    }
                }
            }
            """;

        List<KvNode> nodes = KeyValueParser.Parse(text);

        Assert.AreEqual(1, nodes.Count, "one top-level block");
        Assert.AreEqual("world", nodes[0].Name, "block name");
        Assert.AreEqual("worldspawn", nodes[0].GetString("classname"), "property lookup");
        Assert.AreEqual(1, nodes[0].Children.Count, "one solid");
        Assert.AreEqual("concrete/wall01", nodes[0].Children[0].Children[0].GetString("material"), "nested property");
    }

    [Test("the parser reports the line number of a syntax error")]
    public static void ParserReportsLineNumbers()
    {
        // Unclosed block.
        try
        {
            KeyValueParser.Parse("world\n{\n\t\"id\" \"1\"\n");
            Assert.Fail("an unclosed block must be rejected");
        }
        catch (MapParseException ex)
        {
            Assert.IsTrue(ex.Message.Contains("never closed"), $"error should explain the problem, got: {ex.Message}");
        }

        // Missing value after a key.
        try
        {
            KeyValueParser.Parse("world\n{\n\t\"id\"\n}\n");
            Assert.Fail("a key with no value must be rejected");
        }
        catch (MapParseException ex)
        {
            Assert.AreEqual(4, ex.Line, "the error points at the offending line");
        }

        // Block name with no body.
        try
        {
            KeyValueParser.Parse("world\n");
            Assert.Fail("a block with no body must be rejected");
        }
        catch (MapParseException)
        {
        }
    }

    [Test("quotes and backslashes survive escaping")]
    public static void EscapingRoundTrips()
    {
        var node = new KvNode("entity");
        node.Set("message", "He said \"hello\"");
        node.Set("path", @"materials\stone\wall");

        string text = KeyValueWriter.Write(new[] { node });
        KvNode parsed = KeyValueParser.Parse(text)[0];

        Assert.AreEqual("He said \"hello\"", parsed.GetString("message"), "embedded quotes round-trip");
        Assert.AreEqual(@"materials\stone\wall", parsed.GetString("path"), "backslash paths round-trip");
    }

    [Test("a map round-trips its geometry")]
    public static void RoundTripPreservesGeometry()
    {
        MapDocument original = BuildSampleMap();
        string text = MapSerializer.WriteToString(original);
        MapDocument reloaded = MapSerializer.ReadFromString(text);

        Assert.AreEqual(original.WorldBrushes.Count, reloaded.WorldBrushes.Count, "world brush count");
        Assert.AreEqual(original.Entities.Count, reloaded.Entities.Count, "entity count");
        Assert.AreEqual("sky_dusk02", reloaded.SkyName, "worldspawn keys survive");

        float originalVolume = original.WorldBrushes.Sum(b => b.Volume);
        float reloadedVolume = reloaded.WorldBrushes.Sum(b => b.Volume);
        Assert.AreClose(originalVolume, reloadedVolume, originalVolume * 1e-5f, "total world volume is preserved");

        Aabb originalBounds = original.ComputeBounds();
        Aabb reloadedBounds = reloaded.ComputeBounds();
        Assert.AreClose(originalBounds.Min, reloadedBounds.Min, Tol, "bounds minimum");
        Assert.AreClose(originalBounds.Max, reloadedBounds.Max, Tol, "bounds maximum");

        foreach (Brush brush in reloaded.AllBrushes)
            Assert.IsTrue(brush.IsValid, $"reloaded brush #{brush.Id} is a valid solid");
    }

    [Test("axis-aligned geometry round-trips bit-exactly")]
    public static void AxisAlignedGeometryIsExact()
    {
        var document = new MapDocument();
        document.AddWorldBrush(BrushFactory.CreateBox(new Aabb(new Vector3(-64, -128, 0), new Vector3(192, 256, 96))));

        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(document));

        // Storing planes as three points means integer geometry survives the text format
        // with no drift at all - not merely within tolerance.
        Aabb bounds = reloaded.WorldBrushes[0].Bounds;
        Assert.AreClose(new Vector3(-64, -128, 0), bounds.Min, 0f, "minimum is bit-exact");
        Assert.AreClose(new Vector3(192, 256, 96), bounds.Max, 0f, "maximum is bit-exact");
    }

    [Test("entity keys, outputs, and solids round-trip")]
    public static void RoundTripPreservesEntities()
    {
        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(BuildSampleMap()));

        Entity spawn = reloaded.FindByClassName("info_player_start").Single();
        Assert.AreClose(new Vector3(0, -128, 24), spawn.Origin, Tol, "spawn origin");
        Assert.AreClose(new Vector3(0, 90, 0), spawn.Angles, Tol, "spawn angles");

        Entity light = reloaded.FindByClassName("light").Single();
        Assert.AreEqual(400, light.GetInt("brightness"), "integer key");
        Assert.AreEqual("255 240 220", light.GetString("_light"), "string key with leading underscore");

        Entity? door = reloaded.FindByTargetName("vault_door");
        Assert.IsNotNull(door, "the door is found by targetname");
        Assert.AreEqual(1, door!.Brushes.Count, "the door keeps its solid");
        Assert.IsTrue(door.IsBrushEntity, "the door is a brush entity");
        Assert.AreClose(96.5f, door.GetFloat("speed"), Tol, "fractional key");
        Assert.IsTrue(door.Brushes[0].Contents.HasFlag(BrushContents.Entity), "entity solids are marked as such");

        Entity button = reloaded.FindByClassName("func_button").Single();
        Assert.AreEqual(2, button.Outputs.Count, "both outputs survive, including the duplicate key");

        Output open = button.Outputs.First(o => o.TargetInput == "Open");
        Assert.AreEqual("OnPressed", open.Name, "output name");
        Assert.AreEqual("vault_door", open.TargetEntity, "output target");
        Assert.AreClose(0.5f, open.Delay, Tol, "output delay");
        Assert.AreEqual(1, open.TimesToFire, "output fire count");

        Output lock_ = button.Outputs.First(o => o.TargetInput == "Lock");
        Assert.AreEqual("yes", lock_.Parameter, "output parameter");
        Assert.AreEqual(-1, lock_.TimesToFire, "unlimited firing is the default");
    }

    [Test("materials and texture projections round-trip")]
    public static void RoundTripPreservesTextures()
    {
        var document = new MapDocument();
        Brush box = BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(64)), "tile/floor03");
        Face top = box.GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);
        top.Texture.UShift = 17.5f;
        top.Texture.VScale = 0.5f;
        top.Texture.SetRotation(45f, top.Plane.Normal);
        top.LightmapScale = 8f;
        top.SmoothingGroups = 3;
        document.AddWorldBrush(box);

        Vector2 expectedUv = top.GetUV(new Vector3(32, 32, 64), 256, 256);

        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(document));
        Face reloadedTop = reloaded.WorldBrushes[0].GeometryFaces.First(f => f.Plane.Normal.Z > 0.9f);

        Assert.AreEqual("tile/floor03", reloadedTop.Material, "material path");
        Assert.AreClose(17.5f, reloadedTop.Texture.UShift, Tol, "shift");
        Assert.AreClose(0.5f, reloadedTop.Texture.VScale, Tol, "scale");
        Assert.AreClose(45f, reloadedTop.Texture.Rotation, Tol, "rotation");
        Assert.AreClose(8f, reloadedTop.LightmapScale, Tol, "lightmap scale");
        Assert.AreEqual(3, reloadedTop.SmoothingGroups, "smoothing groups");
        Assert.AreClose(expectedUv, reloadedTop.GetUV(new Vector3(32, 32, 64), 256, 256), 1e-4f, "the projection is identical");
    }

    [Test("writing is deterministic and idempotent")]
    public static void WritingIsStable()
    {
        // Save, load, save again: the bytes must match. This catches unstable key
        // ordering and any field the writer emits but the reader silently drops.
        string first = MapSerializer.WriteToString(BuildSampleMap());
        string second = MapSerializer.WriteToString(MapSerializer.ReadFromString(first));

        if (first != second)
        {
            string[] a = first.Split('\n');
            string[] b = second.Split('\n');
            for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
            {
                string left = i < a.Length ? a[i] : "<missing>";
                string right = i < b.Length ? b[i] : "<missing>";
                if (left != right)
                    Assert.Fail($"round-trip differs at line {i + 1}:\n  first:  {left}\n  second: {right}");
            }
            Assert.Fail("round-trip output differs in length only");
        }
    }

    [Test("oblique geometry stops drifting after the first save")]
    public static void ObliqueGeometryConverges()
    {
        // Storing a plane as three points cannot reproduce an arbitrary oblique plane's
        // exact float bits, so the very first save shifts slanted surfaces a hair. What
        // must never happen is that shift repeating on every save, because that compounds
        // until welded geometry cracks apart. Faces remember the points they came from,
        // which makes every subsequent cycle exact.
        var document = new MapDocument();
        document.AddWorldBrush(BrushFactory.CreateCylinder(
            new Aabb(new Vector3(-32, -32, 0), new Vector3(32, 32, 128)), 12, "stone/pillar01"));
        document.AddWorldBrush(BrushFactory.CreateSpike(
            new Aabb(new Vector3(64, 64, 0), new Vector3(128, 128, 96)), 7, "stone/cone01"));

        float authored = document.AllBrushes.Sum(b => b.Volume);

        string save1 = MapSerializer.WriteToString(document);
        MapDocument load1 = MapSerializer.ReadFromString(save1);
        string save2 = MapSerializer.WriteToString(load1);
        MapDocument load2 = MapSerializer.ReadFromString(save2);
        string save3 = MapSerializer.WriteToString(load2);

        float first = load1.AllBrushes.Sum(b => b.Volume);
        float second = load2.AllBrushes.Sum(b => b.Volume);

        // The one-time cost of the text representation must be negligible.
        Assert.Less(MathF.Abs(authored - first) / authored, 1e-4f, "the initial save barely moves oblique planes");

        // And from then on, nothing moves at all.
        Assert.AreClose(first, second, 0f, "volume is bit-identical after the first cycle");
        if (save2 != save3) Assert.Fail("repeated saves must be byte-identical once the map has been through the format");
    }

    [Test("moving axis-aligned geometry through the format is lossless")]
    public static void TransformOfAxisAlignedGeometryIsExact()
    {
        var document = new MapDocument();
        document.AddWorldBrush(BrushFactory.CreateBox(
            new Aabb(new Vector3(-32, -32, 0), new Vector3(32, 32, 128)), "concrete/wall01"));

        MapDocument loaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(document));
        float before = loaded.AllBrushes.Sum(b => b.Volume);

        foreach (Brush brush in loaded.AllBrushes) brush.Translate(new Vector3(256, -128, 64));

        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(loaded));

        Assert.AreClose(before, reloaded.AllBrushes.Sum(b => b.Volume), 0f, "volume is untouched");
        Assert.AreClose(new Vector3(224, -160, 64), reloaded.WorldBrushes[0].Bounds.Min, 0f, "bounds moved exactly");
    }

    [Test("moving oblique geometry stays within tolerance and does not compound")]
    public static void TransformOfObliqueGeometryIsBounded()
    {
        // An oblique plane's points are not exactly representable, so translating them is
        // not exact either. What matters is that the error stays far below the geometry
        // kernel's 0.01 unit tolerance and does not grow as the brush is moved repeatedly.
        var document = new MapDocument();
        document.AddWorldBrush(BrushFactory.CreateCylinder(
            new Aabb(new Vector3(-32, -32, 0), new Vector3(32, 32, 128)), 8, "stone/pillar01"));

        MapDocument current = MapSerializer.ReadFromString(MapSerializer.WriteToString(document));
        float reference = current.AllBrushes.Sum(b => b.Volume);

        for (int move = 0; move < 8; move++)
        {
            foreach (Brush brush in current.AllBrushes) brush.Translate(new Vector3(64, 0, 0));
            current = MapSerializer.ReadFromString(MapSerializer.WriteToString(current));

            float relative = MathF.Abs(current.AllBrushes.Sum(b => b.Volume) - reference) / reference;
            Assert.Less(relative, 1e-3f, $"volume error stays bounded after {move + 1} move(s)");
        }

        // After eight moves the brush must still be a well-formed solid in the right place.
        Assert.IsTrue(current.WorldBrushes[0].IsValid, "the solid survives repeated round-trips");
        Assert.AreClose(8 * 64f, current.WorldBrushes[0].Bounds.Center.X, 0.01f, "the brush ended up where it was moved");
    }

    [Test("ids are preserved across a round-trip")]
    public static void IdsArePreserved()
    {
        MapDocument original = BuildSampleMap();
        List<int> originalIds = original.AllBrushes.Select(b => b.Id).OrderBy(i => i).ToList();

        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(original));
        List<int> reloadedIds = reloaded.AllBrushes.Select(b => b.Id).OrderBy(i => i).ToList();

        Assert.AreEqual(originalIds.Count, reloadedIds.Count, "brush count");
        for (int i = 0; i < originalIds.Count; i++)
            Assert.AreEqual(originalIds[i], reloadedIds[i], $"brush id at index {i}");

        // A freshly allocated id must not collide with one already loaded.
        int fresh = reloaded.AllocateId();
        Assert.IsFalse(reloadedIds.Contains(fresh), "newly allocated ids do not collide with loaded ones");
    }

    [Test("visgroups and cameras round-trip")]
    public static void RoundTripPreservesEditorState()
    {
        MapDocument reloaded = MapSerializer.ReadFromString(MapSerializer.WriteToString(BuildSampleMap()));

        Assert.AreEqual(1, reloaded.VisGroups.Count, "visgroup count");
        Assert.AreEqual("Lighting", reloaded.VisGroups[0].Name, "visgroup name");
        Assert.IsFalse(reloaded.VisGroups[0].Visible, "hidden state survives");
        Assert.AreEqual(200, reloaded.VisGroups[0].Color.G, "visgroup colour");

        Assert.AreEqual(1, reloaded.Cameras.Count, "camera count");
        Assert.AreClose(new Vector3(0, -512, 128), reloaded.Cameras[0].Position, Tol, "camera position");
    }

    [Test("brush contents round-trip as readable names")]
    public static void ContentsRoundTrip()
    {
        var document = new MapDocument();
        Brush water = BrushFactory.CreateBox(new Aabb(new Vector3(0), new Vector3(64)));
        water.Contents = BrushContents.Water | BrushContents.Detail;
        document.AddWorldBrush(water);

        string text = MapSerializer.WriteToString(document);
        Assert.IsTrue(text.Contains("water"), "contents are written as names, not a bitmask");

        MapDocument reloaded = MapSerializer.ReadFromString(text);
        Assert.IsTrue(reloaded.WorldBrushes[0].Contents.HasFlag(BrushContents.Water), "water flag");
        Assert.IsTrue(reloaded.WorldBrushes[0].Contents.HasFlag(BrushContents.Detail), "detail flag");
    }

    [Test("a malformed plane is rejected with a clear message")]
    public static void MalformedPlaneRejected()
    {
        const string text = """
            world
            {
                "id" "1"
                solid
                {
                    "id" "2"
                    side
                    {
                        "id" "3"
                        "plane" "(0 0 0) (64 0 0)"
                        "material" "concrete/wall01"
                    }
                }
            }
            """;

        try
        {
            MapSerializer.ReadFromString(text);
            Assert.Fail("a plane with only two points must be rejected");
        }
        catch (MapParseException ex)
        {
            Assert.IsTrue(ex.Message.Contains("three points"), $"error should mention the missing point, got: {ex.Message}");
        }
    }

    [Test("collinear plane points are rejected")]
    public static void CollinearPlaneRejected()
    {
        const string text = """
            world
            {
                "id" "1"
                solid
                {
                    "id" "2"
                    side
                    {
                        "id" "3"
                        "plane" "(0 0 0) (64 0 0) (128 0 0)"
                    }
                }
            }
            """;

        try
        {
            MapSerializer.ReadFromString(text);
            Assert.Fail("collinear plane points must be rejected");
        }
        catch (MapParseException ex)
        {
            Assert.IsTrue(ex.Message.Contains("collinear"), $"error should mention collinearity, got: {ex.Message}");
        }
    }

    [Test("unknown blocks and keys are tolerated")]
    public static void ForwardCompatibility()
    {
        const string text = """
            versioninfo
            {
                "formatversion" "99"
            }
            some_future_block
            {
                "whatever" "1"
            }
            world
            {
                "id" "1"
                "classname" "worldspawn"
                "future_key" "future_value"
            }
            """;

        MapDocument document = MapSerializer.ReadFromString(text);
        Assert.AreEqual("future_value", document.Worldspawn.GetString("future_key"), "unknown keys are kept");
        Assert.AreEqual(0, document.WorldBrushes.Count, "no solids in this document");
    }

    [Test("validation reports real problems")]
    public static void ValidationReportsProblems()
    {
        MapDocument good = BuildSampleMap();
        List<string> problems = good.Validate();
        Assert.AreEqual(0, problems.Count, $"the sample map is clean, got: {string.Join(" | ", problems)}");

        var bad = new MapDocument();
        // An open plane set, plus no spawn point, plus a dangling output.
        var open = new Brush();
        open.AddFace(new Face(new Plane3(Vector3.UnitX, 32f)));
        open.AddFace(new Face(new Plane3(Vector3.UnitY, 32f)));
        bad.AddWorldBrush(open);

        var trigger = new Entity("func_button");
        trigger.Outputs.Add(new Output { Name = "OnPressed", TargetEntity = "nonexistent", TargetInput = "Open" });
        bad.AddEntity(trigger);

        List<string> found = bad.Validate();
        Assert.IsTrue(found.Any(p => p.Contains("not a closed convex solid")), "malformed brush is reported");
        Assert.IsTrue(found.Any(p => p.Contains("info_player_start")), "missing spawn point is reported");
        Assert.IsTrue(found.Any(p => p.Contains("nonexistent")), "dangling entity output is reported");
    }

    [Test("saving and loading through the file system works")]
    public static void FileRoundTrip()
    {
        string path = Path.Combine(Path.GetTempPath(), $"forge-test-{Guid.NewGuid():N}.tmap");
        try
        {
            MapDocument original = BuildSampleMap();
            MapSerializer.Save(original, path);

            Assert.IsTrue(File.Exists(path), "the file was written");
            Assert.AreEqual(path, original.FilePath!, "the document remembers where it was saved");

            MapDocument loaded = MapSerializer.Load(path);
            Assert.AreEqual(original.WorldBrushes.Count, loaded.WorldBrushes.Count, "brush count survives the file system");
            Assert.AreEqual(original.Entities.Count, loaded.Entities.Count, "entity count survives the file system");
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
