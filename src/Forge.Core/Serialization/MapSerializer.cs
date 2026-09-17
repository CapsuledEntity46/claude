using System.Globalization;
using System.Numerics;
using System.Text;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Serialization;

/// <summary>
/// Reads and writes the <c>.tmap</c> level format.
/// <para>
/// Face planes are stored as three points rather than a normal and distance. That is a
/// deliberate choice inherited from the Quake/VMF lineage: three points are exact
/// integers for the axis-aligned geometry that dominates real levels, so a plane
/// round-trips bit-for-bit through text, whereas a normalised normal would immediately
/// pick up decimal noise. It also means a human can read a face's position off the file.
/// </para>
/// </summary>
public static class MapSerializer
{
    private const string VersionInfoBlock = "versioninfo";
    private const string VisGroupsBlock = "visgroups";
    private const string WorldBlock = "world";
    private const string EntityBlock = "entity";
    private const string CamerasBlock = "cameras";
    private const string SolidBlock = "solid";
    private const string SideBlock = "side";
    private const string ConnectionsBlock = "connections";

    // ---------------------------------------------------------------- writing

    public static string WriteToString(MapDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        document.AssignMissingIds();

        var nodes = new List<KvNode>();

        var version = new KvNode(VersionInfoBlock);
        version.Set("formatversion", MapDocument.CurrentFormatVersion);
        version.Set("generator", "forge");
        nodes.Add(version);

        if (document.VisGroups.Count > 0)
        {
            var visGroups = new KvNode(VisGroupsBlock);
            foreach (VisGroup group in document.VisGroups)
            {
                KvNode child = visGroups.AddChild("visgroup");
                child.Set("name", group.Name);
                child.Set("visible", group.Visible);
                child.Set("color", group.Color.ToString());
            }
            nodes.Add(visGroups);
        }

        var world = new KvNode(WorldBlock);
        world.Set("id", document.Worldspawn.Id);
        foreach (string key in document.Worldspawn.Keys)
            world.Set(key, document.Worldspawn.GetString(key));
        foreach (Brush brush in document.WorldBrushes)
            world.Children.Add(WriteBrush(brush));
        nodes.Add(world);

        foreach (Entity entity in document.Entities)
            nodes.Add(WriteEntity(entity));

        if (document.Cameras.Count > 0)
        {
            var cameras = new KvNode(CamerasBlock);
            cameras.Set("activecamera", document.ActiveCamera);
            foreach (CameraBookmark camera in document.Cameras)
            {
                KvNode child = cameras.AddChild("camera");
                child.Set("position", FormatPoint(camera.Position));
                child.Set("look", FormatPoint(camera.Look));
            }
            nodes.Add(cameras);
        }

        return KeyValueWriter.Write(nodes);
    }

    public static void Save(MapDocument document, string path)
    {
        string text = WriteToString(document);
        string? directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        document.FilePath = path;
    }

    private static KvNode WriteBrush(Brush brush)
    {
        var node = new KvNode(SolidBlock);
        node.Set("id", brush.Id);
        node.Set("contents", FormatContents(brush.Contents));
        if (brush.VisGroup is not null) node.Set("visgroup", brush.VisGroup);

        foreach (Face face in brush.Faces)
            node.Children.Add(WriteFace(face, brush));

        return node;
    }

    private static KvNode WriteFace(Face face, Brush brush)
    {
        var node = new KvNode(SideBlock);
        node.Set("id", face.Id);
        node.Set("plane", FormatPlane(face, brush));
        node.Set("material", face.Material);
        node.Set("uaxis", FormatAxis(face.Texture.UAxis, face.Texture.UShift, face.Texture.UScale));
        node.Set("vaxis", FormatAxis(face.Texture.VAxis, face.Texture.VShift, face.Texture.VScale));
        node.Set("rotation", face.Texture.Rotation);
        node.Set("lightmapscale", face.LightmapScale);
        if (face.SmoothingGroups != 0) node.Set("smoothing", face.SmoothingGroups);
        if (face.Flags != SurfaceFlags.None) node.Set("flags", FormatSurfaceFlags(face.Flags));
        return node;
    }

    private static KvNode WriteEntity(Entity entity)
    {
        var node = new KvNode(EntityBlock);
        node.Set("id", entity.Id);
        foreach (string key in entity.Keys)
            node.Set(key, entity.GetString(key));
        if (entity.VisGroup is not null) node.Set("visgroup", entity.VisGroup);

        if (entity.Outputs.Count > 0)
        {
            KvNode connections = node.AddChild(ConnectionsBlock);
            foreach (Output output in entity.Outputs)
                connections.Set(output.Name, output.ToValueString());
        }

        foreach (Brush brush in entity.Brushes)
            node.Children.Add(WriteBrush(brush));

        return node;
    }

    // ---------------------------------------------------------------- reading

    public static MapDocument ReadFromString(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        List<KvNode> nodes = KeyValueParser.Parse(text);
        var document = new MapDocument();

        foreach (KvNode node in nodes)
        {
            switch (node.Name.ToLowerInvariant())
            {
                case VersionInfoBlock:
                    // Reserved for future migrations; the reader currently accepts any version.
                    break;

                case VisGroupsBlock:
                    foreach (KvNode child in node.ChildrenNamed("visgroup"))
                    {
                        document.VisGroups.Add(new VisGroup
                        {
                            Name = child.GetString("name", "Group"),
                            Visible = child.GetBool("visible", true),
                            Color = ParseColor(child.GetString("color", "255 255 255")),
                        });
                    }
                    break;

                case WorldBlock:
                    ReadWorld(node, document);
                    break;

                case EntityBlock:
                    document.Entities.Add(ReadEntity(node, document));
                    break;

                case CamerasBlock:
                    document.ActiveCamera = node.GetInt("activecamera");
                    foreach (KvNode child in node.ChildrenNamed("camera"))
                    {
                        document.Cameras.Add(new CameraBookmark
                        {
                            Position = ParsePoint(child.GetString("position"), child.Line),
                            Look = ParsePoint(child.GetString("look"), child.Line),
                        });
                    }
                    break;

                default:
                    // Unknown top-level blocks are ignored so newer files stay loadable.
                    break;
            }
        }

        document.AssignMissingIds();
        document.RebuildAll();
        return document;
    }

    public static MapDocument Load(string path)
    {
        MapDocument document = ReadFromString(File.ReadAllText(path));
        document.FilePath = path;
        return document;
    }

    private static void ReadWorld(KvNode node, MapDocument document)
    {
        int id = node.GetInt("id");
        if (id != 0)
        {
            document.Worldspawn.Id = id;
            document.ReserveId(id);
        }

        foreach (KeyValuePair<string, string> property in node.Properties)
        {
            if (string.Equals(property.Key, "id", StringComparison.OrdinalIgnoreCase)) continue;
            document.Worldspawn.SetString(property.Key, property.Value);
        }

        foreach (KvNode child in node.ChildrenNamed(SolidBlock))
            document.WorldBrushes.Add(ReadBrush(child, document));
    }

    private static Entity ReadEntity(KvNode node, MapDocument document)
    {
        var entity = new Entity();

        int id = node.GetInt("id");
        if (id != 0)
        {
            entity.Id = id;
            document.ReserveId(id);
        }

        foreach (KeyValuePair<string, string> property in node.Properties)
        {
            if (string.Equals(property.Key, "id", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.Equals(property.Key, "visgroup", StringComparison.OrdinalIgnoreCase))
            {
                entity.VisGroup = property.Value;
                continue;
            }
            entity.SetString(property.Key, property.Value);
        }

        KvNode? connections = node.FirstChild(ConnectionsBlock);
        if (connections is not null)
        {
            foreach (KeyValuePair<string, string> property in connections.Properties)
                entity.Outputs.Add(Output.Parse(property.Key, property.Value));
        }

        foreach (KvNode child in node.ChildrenNamed(SolidBlock))
            entity.Brushes.Add(ReadBrush(child, document));

        return entity;
    }

    private static Brush ReadBrush(KvNode node, MapDocument document)
    {
        var brush = new Brush
        {
            Contents = ParseContents(node.GetString("contents", "solid")),
        };

        int id = node.GetInt("id");
        if (id != 0)
        {
            brush.Id = id;
            document.ReserveId(id);
        }

        string visGroup = node.GetString("visgroup");
        if (!string.IsNullOrEmpty(visGroup)) brush.VisGroup = visGroup;

        foreach (KvNode child in node.ChildrenNamed(SideBlock))
            brush.AddFace(ReadFace(child, document));

        brush.Rebuild();
        return brush;
    }

    private static Face ReadFace(KvNode node, MapDocument document)
    {
        string planeText = node.GetString("plane");
        if (string.IsNullOrWhiteSpace(planeText))
            throw new MapParseException("A 'side' block requires a 'plane' key.", node.Line, 1);

        var face = new Face
        {
            Plane = ParsePlane(planeText, node.Line, out Vector3[] planePoints),
            Material = node.GetString("material", MaterialDefaults.Placeholder),
            LightmapScale = node.GetFloat("lightmapscale", 16f),
            SmoothingGroups = node.GetInt("smoothing"),
            SourcePoints = planePoints,
        };

        int id = node.GetInt("id");
        if (id != 0)
        {
            face.Id = id;
            document.ReserveId(id);
        }

        string uaxis = node.GetString("uaxis");
        string vaxis = node.GetString("vaxis");
        if (!string.IsNullOrWhiteSpace(uaxis) && !string.IsNullOrWhiteSpace(vaxis))
        {
            ParseAxis(uaxis, node.Line, out Vector3 u, out float uShift, out float uScale);
            ParseAxis(vaxis, node.Line, out Vector3 v, out float vShift, out float vScale);
            face.Texture = new TextureAlignment(u, v, uShift, vShift, uScale, vScale, node.GetFloat("rotation"));
        }
        else
        {
            // Tolerate files authored without explicit projection.
            face.Texture = TextureAlignment.ForNormal(face.Plane.Normal);
        }

        string flags = node.GetString("flags");
        face.Flags = string.IsNullOrWhiteSpace(flags)
            ? MaterialDefaults.FlagsFor(face.Material)
            : ParseSurfaceFlags(flags);

        return face;
    }

    // ------------------------------------------------------------ formatting

    /// <summary>
    /// Emits three points on the face, taken from its generated polygon so that
    /// axis-aligned geometry is written as exact integers. Falls back to synthesising
    /// points for a plane the solid clipped away entirely.
    /// </summary>
    private static string FormatPlane(Face face, Brush brush)
    {
        // Reuse the points this plane came from when they still describe it. This is what
        // makes opening a level and saving it a no-op at the byte level.
        if (face.SourcePoints is { Length: 3 } stored
            && Plane3.IsValidTriangle(stored[0], stored[1], stored[2])
            && Plane3.FromPoints(stored[0], stored[1], stored[2])
                     .IsCoincident(face.Plane, normalEpsilon: 1e-5f, distEpsilon: 1e-3f))
        {
            return $"{FormatPoint(stored[0])} {FormatPoint(stored[1])} {FormatPoint(stored[2])}";
        }

        if (!brush.GeometryValid) brush.Rebuild();

        Winding winding = face.Winding ?? Winding.FromPlane(face.Plane, 64f);
        (Vector3 a, Vector3 b, Vector3 c) = PickSpreadTriple(winding, face.Plane);

        // Remember the choice so subsequent saves stay identical.
        face.SourcePoints = new[] { a, b, c };
        return $"{FormatPoint(a)} {FormatPoint(b)} {FormatPoint(c)}";
    }

    /// <summary>
    /// Chooses three vertices spread evenly around the ring, in ring order so the result
    /// stays counter-clockwise.
    /// </summary>
    /// <remarks>
    /// Selection is purely combinatorial, by index, and never compares floating-point
    /// magnitudes. Picking the largest-area triple instead sounds better conditioned but
    /// is badly unstable: a regular polygon has many near-equal-area triples, so a
    /// one-ULP change flips which one wins and the file's stored points jump to entirely
    /// different vertices. Because a convex winding has no three consecutive collinear
    /// points (<see cref="Winding.RemoveCollinear"/> guarantees it), evenly spaced
    /// indices are always well conditioned.
    /// </remarks>
    private static (Vector3 A, Vector3 B, Vector3 C) PickSpreadTriple(Winding winding, Plane3 plane)
    {
        if (winding.Count < 3)
        {
            Winding fallback = Winding.FromPlane(plane, 64f);
            return (fallback[0], fallback[1], fallback[2]);
        }

        int count = winding.Count;
        return (winding[0], winding[count / 3], winding[2 * count / 3]);
    }

    private static string FormatPoint(Vector3 p)
        => $"({KvNode.Format(p.X)} {KvNode.Format(p.Y)} {KvNode.Format(p.Z)})";

    private static string FormatAxis(Vector3 axis, float shift, float scale)
        => $"[{KvNode.Format(axis.X)} {KvNode.Format(axis.Y)} {KvNode.Format(axis.Z)} {KvNode.Format(shift)}] {KvNode.Format(scale)}";

    private static string FormatContents(BrushContents contents)
    {
        if (contents == BrushContents.None) return "none";
        var parts = new List<string>(3);
        foreach (BrushContents flag in Enum.GetValues<BrushContents>())
        {
            if (flag != BrushContents.None && contents.HasFlag(flag))
                parts.Add(flag.ToString().ToLowerInvariant());
        }
        return string.Join(' ', parts);
    }

    private static string FormatSurfaceFlags(SurfaceFlags flags)
    {
        if (flags == SurfaceFlags.None) return "none";
        var parts = new List<string>(3);
        foreach (SurfaceFlags flag in Enum.GetValues<SurfaceFlags>())
        {
            if (flag != SurfaceFlags.None && flags.HasFlag(flag))
                parts.Add(flag.ToString().ToLowerInvariant());
        }
        return string.Join(' ', parts);
    }

    // -------------------------------------------------------------- parsing

    /// <summary>
    /// Parses <c>(x y z) (x y z) (x y z)</c> into a plane, also returning the points
    /// verbatim so the face can reproduce them exactly when it is saved again.
    /// </summary>
    internal static Plane3 ParsePlane(string text, int line, out Vector3[] points)
    {
        points = new Vector3[3];
        int found = 0;
        int index = 0;

        while (found < 3)
        {
            int open = text.IndexOf('(', index);
            if (open < 0) break;
            int close = text.IndexOf(')', open + 1);
            if (close < 0) break;

            if (!Entity.TryParseVector3(text[(open + 1)..close], out points[found]))
                throw new MapParseException($"Malformed point in plane definition: '{text}'.", line, 1);

            found++;
            index = close + 1;
        }

        if (found < 3)
            throw new MapParseException($"A plane needs three points but found {found}: '{text}'.", line, 1);

        if (!Plane3.IsValidTriangle(points[0], points[1], points[2]))
            throw new MapParseException($"Plane points are collinear or coincident: '{text}'.", line, 1);

        return Plane3.FromPoints(points[0], points[1], points[2]);
    }

    /// <summary>Parses <c>[x y z shift] scale</c>.</summary>
    internal static void ParseAxis(string text, int line, out Vector3 axis, out float shift, out float scale)
    {
        int open = text.IndexOf('[');
        int close = text.IndexOf(']');
        if (open < 0 || close < open)
            throw new MapParseException($"Malformed texture axis: '{text}'.", line, 1);

        string[] parts = text[(open + 1)..close]
            .Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 4)
            throw new MapParseException($"A texture axis needs four numbers: '{text}'.", line, 1);

        axis = new Vector3(ParseFloat(parts[0], text, line), ParseFloat(parts[1], text, line), ParseFloat(parts[2], text, line));
        shift = ParseFloat(parts[3], text, line);

        string tail = text[(close + 1)..].Trim();
        scale = tail.Length == 0 ? 0.25f : ParseFloat(tail, text, line);
        if (MathF.Abs(scale) < MathUtil.Epsilon) scale = 0.25f;
    }

    private static float ParseFloat(string token, string context, int line)
        => float.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out float value)
            ? value
            : throw new MapParseException($"'{token}' is not a number, in '{context}'.", line, 1);

    private static Vector3 ParsePoint(string text, int line)
        => Entity.TryParseVector3(text, out Vector3 result)
            ? result
            : throw new MapParseException($"Malformed point: '{text}'.", line, 1);

    private static ColorRgb ParseColor(string text)
    {
        string[] parts = text.Split(new[] { ' ', '\t', ',' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3) return ColorRgb.White;

        byte Component(string s) => byte.TryParse(s, out byte v) ? v : (byte)255;
        return new ColorRgb(Component(parts[0]), Component(parts[1]), Component(parts[2]));
    }

    private static BrushContents ParseContents(string text)
    {
        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int numeric))
            return (BrushContents)numeric;

        BrushContents contents = BrushContents.None;
        foreach (string token in text.Split(new[] { ' ', '\t', '|', ',' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (Enum.TryParse(token, ignoreCase: true, out BrushContents flag)) contents |= flag;
        }
        return contents == BrushContents.None ? BrushContents.Solid : contents;
    }

    private static SurfaceFlags ParseSurfaceFlags(string text)
    {
        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int numeric))
            return (SurfaceFlags)numeric;

        SurfaceFlags flags = SurfaceFlags.None;
        foreach (string token in text.Split(new[] { ' ', '\t', '|', ',' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (Enum.TryParse(token, ignoreCase: true, out SurfaceFlags flag)) flags |= flag;
        }
        return flags;
    }
}
