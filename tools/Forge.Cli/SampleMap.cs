using System.Numerics;
using Forge.Geometry;
using Forge.Map;

namespace Forge.Cli;

/// <summary>
/// Builds a reference level in code, exercising the whole authoring pipeline: hollowing,
/// carving, primitives, entities, and entity I/O. It doubles as the content the demo and
/// smoke-test commands operate on.
/// </summary>
public static class SampleMap
{
    public static MapDocument BuildTestRoom()
    {
        var document = new MapDocument();
        document.SkyName = "sky_day01";
        document.Worldspawn.SetString("mapname", "testroom");

        // ---- Main hall: a hollow box, then a doorway carved through the north wall.
        var hallOuter = new Aabb(new Vector3(-384, -384, -16), new Vector3(384, 384, 256));
        List<Brush> hall = BrushFactory.Hollow(BrushFactory.CreateBox(hallOuter, "concrete/wall01"), 16f);

        // The doorway cutter spans the wall's full thickness and then some, so the carve
        // cleanly punches through rather than leaving a paper-thin sliver.
        Brush doorway = BrushFactory.CreateBox(
            new Aabb(new Vector3(-48, 352, -16), new Vector3(48, 400, 144)), "trim/doorframe01");

        List<Brush> carved = Csg.Subtract(hall, doorway);
        document.AddWorldBrushes(carved);

        // ---- Four pillars, built as eight-sided prisms.
        foreach ((float x, float y) in new[] { (-192f, -192f), (192f, -192f), (-192f, 192f), (192f, 192f) })
        {
            document.AddWorldBrush(BrushFactory.CreateCylinder(
                new Aabb(new Vector3(x - 24, y - 24, 0), new Vector3(x + 24, y + 24, 240)),
                sides: 8,
                material: "stone/pillar01"));
        }

        // ---- A ramp up to a ledge along the east wall.
        document.AddWorldBrush(BrushFactory.CreateWedge(
            new Aabb(new Vector3(160, -320, 0), new Vector3(352, -160, 64)), "concrete/floor02"));
        document.AddWorldBrush(BrushFactory.CreateBox(
            new Aabb(new Vector3(160, -160, 48), new Vector3(368, 160, 64)), "concrete/floor02"));

        // ---- A water volume, flagged as detail so it never seals the level's visibility.
        Brush water = BrushFactory.CreateBox(
            new Aabb(new Vector3(-96, -96, -16), new Vector3(96, 96, -4)), "nature/water01");
        water.Contents = BrushContents.Water | BrushContents.Detail;
        document.AddWorldBrush(water);

        // ---- Entities.
        var spawn = new Entity("info_player_start")
        {
            Origin = new Vector3(0, -256, 8),
            Angles = new Vector3(0, 90, 0),
        };
        document.AddEntity(spawn);

        foreach ((float x, float y) in new[] { (-160f, -160f), (160f, -160f), (-160f, 160f), (160f, 160f) })
        {
            var light = new Entity("light") { Origin = new Vector3(x, y, 200) };
            light.SetInt("brightness", 350);
            light.SetString("_light", "255 244 214");
            document.AddEntity(light);
        }

        var sun = new Entity("light_environment") { Angles = new Vector3(-45, 210, 0) };
        sun.SetString("_light", "255 250 235");
        sun.SetInt("brightness", 700);
        document.AddEntity(sun);

        // A door filling the carved opening, driven by a button.
        var door = new Entity("func_door") { TargetName = "hall_door" };
        door.SetFloat("speed", 96f);
        door.SetString("movedir", "0 0 1");
        door.Brushes.Add(BrushFactory.CreateBox(
            new Aabb(new Vector3(-48, 368, -16), new Vector3(48, 384, 144)), "metal/door01"));
        document.AddEntity(door);

        var button = new Entity("func_button") { TargetName = "hall_button" };
        button.Origin = new Vector3(96, 360, 64);
        button.Outputs.Add(new Output
        {
            Name = "OnPressed",
            TargetEntity = "hall_door",
            TargetInput = "Open",
            Delay = 0f,
            TimesToFire = -1,
        });
        document.AddEntity(button);

        // ---- Editor metadata.
        document.VisGroups.Add(new VisGroup { Name = "Lighting", Color = new ColorRgb(255, 220, 100) });
        document.VisGroups.Add(new VisGroup { Name = "Detail", Color = new ColorRgb(120, 200, 255) });
        document.Cameras.Add(new CameraBookmark
        {
            Position = new Vector3(0, -640, 220),
            Look = new Vector3(0, 0, 96),
        });

        document.AssignMissingIds();
        document.RebuildAll();
        return document;
    }
}
