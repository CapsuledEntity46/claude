using System.Globalization;
using Forge.Export;
using Forge.Geometry;
using Forge.Map;
using Forge.Serialization;

namespace Forge.Cli;

/// <summary>
/// Headless entry point for map authoring chores: generating the sample level, printing
/// statistics, validating a map in CI, and exporting geometry for inspection.
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
        {
            PrintUsage();
            return args.Length == 0 ? 1 : 0;
        }

        try
        {
            return args[0].ToLowerInvariant() switch
            {
                "new" => CommandNew(args),
                "info" => CommandInfo(args),
                "validate" => CommandValidate(args),
                "obj" => CommandObj(args),
                "demo" => CommandDemo(args),
                _ => Fail($"Unknown command '{args[0]}'. Run 'forge --help'."),
            };
        }
        catch (MapParseException ex)
        {
            Console.Error.WriteLine($"Map syntax error: {ex.Message}");
            return 2;
        }
        catch (FileNotFoundException ex)
        {
            Console.Error.WriteLine($"File not found: {ex.FileName}");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"{ex.GetType().Name}: {ex.Message}");
            return 3;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            forge - headless tools for the Forge engine

            Usage:
              forge new <out.tmap>              Write the built-in sample level
              forge info <map.tmap>             Print geometry and entity statistics
              forge validate <map.tmap>         Check a map, non-zero exit on problems
              forge obj <map.tmap> <out.obj>    Export visible geometry as OBJ/MTL
              forge demo <outputDirectory>      Run the full pipeline and report on it

            Options:
              --z-up                            For 'obj': keep native Z-up coordinates
                                                instead of converting to Y-up
            """);
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 1;
    }

    private static int CommandNew(string[] args)
    {
        if (args.Length < 2) return Fail("Usage: forge new <out.tmap>");

        MapDocument document = SampleMap.BuildTestRoom();
        MapSerializer.Save(document, args[1]);

        Console.WriteLine($"Wrote {args[1]}");
        PrintSummary(document);
        return 0;
    }

    private static int CommandInfo(string[] args)
    {
        if (args.Length < 2) return Fail("Usage: forge info <map.tmap>");

        MapDocument document = MapSerializer.Load(args[1]);
        Console.WriteLine($"{args[1]}");
        PrintSummary(document);

        Console.WriteLine();
        Console.WriteLine("Materials:");
        foreach (string material in document.GetUsedMaterials())
        {
            int faces = document.AllFaces.Count(f =>
                string.Equals(f.Material, material, StringComparison.OrdinalIgnoreCase) && f.HasGeometry);
            Console.WriteLine($"  {material,-32} {faces,5} faces");
        }

        Console.WriteLine();
        Console.WriteLine("Entities:");
        foreach (IGrouping<string, Entity> group in document.Entities
                     .GroupBy(e => e.ClassName, StringComparer.OrdinalIgnoreCase)
                     .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase))
        {
            Console.WriteLine($"  {group.Key,-32} {group.Count(),5}");
        }

        return 0;
    }

    private static int CommandValidate(string[] args)
    {
        if (args.Length < 2) return Fail("Usage: forge validate <map.tmap>");

        MapDocument document = MapSerializer.Load(args[1]);
        List<string> problems = document.Validate();

        if (problems.Count == 0)
        {
            Console.WriteLine($"{args[1]}: OK");
            return 0;
        }

        Console.Error.WriteLine($"{args[1]}: {problems.Count} problem(s)");
        foreach (string problem in problems) Console.Error.WriteLine($"  - {problem}");
        return 1;
    }

    private static int CommandObj(string[] args)
    {
        if (args.Length < 3) return Fail("Usage: forge obj <map.tmap> <out.obj> [--z-up]");

        bool zUp = args.Contains("--z-up");
        MapDocument document = MapSerializer.Load(args[1]);
        List<MeshBatch> batches = MeshBuilder.Build(document);

        ObjExporter.Export(batches, args[2], convertToYUp: !zUp);

        Console.WriteLine($"Wrote {args[2]} ({batches.Count} material batches, "
                        + $"{MeshBuilder.CountTriangles(batches)} triangles, "
                        + $"{(zUp ? "native Z-up" : "converted to Y-up")})");
        return 0;
    }

    /// <summary>
    /// Exercises the pipeline end to end and reports measurable results, so a change in
    /// the geometry kernel shows up as a number rather than a vague "looks fine".
    /// </summary>
    private static int CommandDemo(string[] args)
    {
        string outputDirectory = args.Length > 1 ? args[1] : "out";
        Directory.CreateDirectory(outputDirectory);

        Console.WriteLine("Forge pipeline demo");
        Console.WriteLine(new string('=', 60));

        // 1. A carve, with volume accounted for.
        Console.WriteLine("\n[1] CSG carve");
        Brush wall = BrushFactory.CreateBox(new Aabb(new(-128, -8, 0), new(128, 8, 128)), "concrete/wall01");
        Brush hole = BrushFactory.CreateCylinder(new Aabb(new(-32, -32, 32), new(32, 32, 96)), 12, "trim/pipe01");

        float wallVolume = wall.Volume;
        List<Brush> fragments = Csg.Subtract(wall, hole);
        Brush? overlap = Csg.Intersection(wall, hole);
        float fragmentVolume = fragments.Sum(f => f.Volume);
        float removed = overlap?.Volume ?? 0f;

        Console.WriteLine($"    wall volume        {wallVolume,14:N1}");
        Console.WriteLine($"    fragments ({fragments.Count,2})      {fragmentVolume,14:N1}");
        Console.WriteLine($"    removed            {removed,14:N1}");
        Console.WriteLine($"    fragments+removed  {fragmentVolume + removed,14:N1}"
                        + $"   (error {MathF.Abs(wallVolume - fragmentVolume - removed):N4})");
        Console.WriteLine($"    all fragments convex and closed: {fragments.All(f => f.IsValid)}");

        // 2. The sample level.
        Console.WriteLine("\n[2] Sample level");
        MapDocument document = SampleMap.BuildTestRoom();
        PrintSummary(document);

        // 3. Save, reload, and confirm the format is lossless.
        Console.WriteLine("\n[3] Format round-trip");
        string mapPath = Path.Combine(outputDirectory, "testroom.tmap");
        MapSerializer.Save(document, mapPath);

        string first = File.ReadAllText(mapPath);
        MapDocument reloaded = MapSerializer.ReadFromString(first);
        string second = MapSerializer.WriteToString(reloaded);

        float before = document.AllBrushes.Sum(b => b.Volume);
        float after = reloaded.AllBrushes.Sum(b => b.Volume);
        Console.WriteLine($"    {mapPath} ({new FileInfo(mapPath).Length:N0} bytes)");
        Console.WriteLine($"    volume before      {before,14:N1}");
        Console.WriteLine($"    volume after       {after,14:N1}   (error {MathF.Abs(before - after):N4})");
        Console.WriteLine($"    byte-identical on re-save: {(first == second ? "yes" : "NO")}");
        if (first != second) ReportFirstDifference(first, second);

        // 4. Validation.
        Console.WriteLine("\n[4] Validation");
        List<string> problems = reloaded.Validate();
        if (problems.Count == 0)
        {
            Console.WriteLine("    no problems");
        }
        else
        {
            foreach (string problem in problems) Console.WriteLine($"    - {problem}");
        }

        // 5. Mesh + OBJ export.
        Console.WriteLine("\n[5] Mesh build and OBJ export");
        List<MeshBatch> batches = MeshBuilder.Build(reloaded);
        string objPath = Path.Combine(outputDirectory, "testroom.obj");
        ObjExporter.Export(batches, objPath);

        foreach (MeshBatch batch in batches)
            Console.WriteLine($"    {batch.Material,-28} {batch.Vertices.Count,6} verts {batch.TriangleCount,6} tris");
        Console.WriteLine($"    total                        {batches.Sum(b => b.Vertices.Count),6} verts "
                        + $"{MeshBuilder.CountTriangles(batches),6} tris");
        Console.WriteLine($"    {objPath} ({new FileInfo(objPath).Length:N0} bytes)");

        bool ok = problems.Count == 0
               && first == second
               && fragments.All(f => f.IsValid)
               && MathF.Abs(wallVolume - fragmentVolume - removed) < 1f;

        Console.WriteLine();
        Console.WriteLine(new string('=', 60));
        Console.WriteLine(ok ? "Pipeline OK" : "Pipeline reported problems");
        return ok ? 0 : 1;
    }

    /// <summary>Prints the first line where two serialisations diverge, to localise drift.</summary>
    private static void ReportFirstDifference(string first, string second)
    {
        string[] a = first.Split('\n');
        string[] b = second.Split('\n');
        int differences = 0;

        for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            string left = i < a.Length ? a[i] : "<missing>";
            string right = i < b.Length ? b[i] : "<missing>";
            if (left == right) continue;

            differences++;
            if (differences <= 3)
            {
                Console.WriteLine($"      line {i + 1}:");
                Console.WriteLine($"        first  {left.Trim()}");
                Console.WriteLine($"        second {right.Trim()}");
            }
        }

        Console.WriteLine($"      {differences} differing line(s) of {a.Length}");
    }

    private static void PrintSummary(MapDocument document)
    {
        Aabb bounds = document.ComputeBounds();
        int brushes = document.AllBrushes.Count();
        int faces = document.AllFaces.Count(f => f.HasGeometry);

        Console.WriteLine($"    world brushes      {document.WorldBrushes.Count,14:N0}");
        Console.WriteLine($"    total brushes      {brushes,14:N0}");
        Console.WriteLine($"    faces with area    {faces,14:N0}");
        Console.WriteLine($"    entities           {document.Entities.Count,14:N0}");
        Console.WriteLine($"    materials          {document.GetUsedMaterials().Count(),14:N0}");
        Console.WriteLine($"    bounds             {Describe(bounds)}");
    }

    private static string Describe(Aabb bounds)
    {
        if (bounds.IsEmpty) return "(empty)";
        string N(float v) => v.ToString("0.#", CultureInfo.InvariantCulture);
        return $"({N(bounds.Min.X)} {N(bounds.Min.Y)} {N(bounds.Min.Z)}) .. "
             + $"({N(bounds.Max.X)} {N(bounds.Max.Y)} {N(bounds.Max.Z)})";
    }
}
