using System.Globalization;
using System.Numerics;
using System.Text;
using Forge.Map;

namespace Forge.Export;

/// <summary>
/// Writes level geometry to Wavefront OBJ/MTL.
/// <para>
/// This exists mainly as a diagnostic escape hatch: OBJ opens in essentially any 3D
/// viewer, so a compiled level's geometry can be inspected without running the engine or
/// trusting the renderer. It is also how the geometry kernel is verified visually in
/// environments with no GPU.
/// </para>
/// </summary>
public static class ObjExporter
{
    /// <summary>
    /// Exports the document's visible geometry.
    /// </summary>
    /// <param name="convertToYUp">
    /// Forge is Z-up, but most DCC tools and viewers assume Y-up. When true, coordinates
    /// are remapped as <c>(x, z, -y)</c>, which preserves handedness and therefore
    /// face winding.
    /// </param>
    public static void Export(
        MapDocument document,
        string objPath,
        bool convertToYUp = true,
        Func<string, (int Width, int Height)>? textureSizeResolver = null)
    {
        ArgumentNullException.ThrowIfNull(document);
        List<MeshBatch> batches = MeshBuilder.Build(document, textureSizeResolver);
        Export(batches, objPath, convertToYUp);
    }

    public static void Export(List<MeshBatch> batches, string objPath, bool convertToYUp = true)
    {
        ArgumentNullException.ThrowIfNull(batches);

        string fullPath = Path.GetFullPath(objPath);
        string? directory = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        string mtlPath = Path.ChangeExtension(fullPath, ".mtl");
        string mtlName = Path.GetFileName(mtlPath);

        File.WriteAllText(fullPath, BuildObj(batches, mtlName, convertToYUp), Utf8NoBom);
        File.WriteAllText(mtlPath, BuildMtl(batches), Utf8NoBom);
    }

    private static UTF8Encoding Utf8NoBom => new(encoderShouldEmitUTF8Identifier: false);

    private static string BuildObj(List<MeshBatch> batches, string mtlName, bool convertToYUp)
    {
        var sb = new StringBuilder(64 * 1024);
        sb.Append("# Exported by Forge\n");
        sb.Append(convertToYUp ? "# Converted from Forge Z-up to Y-up\n" : "# Forge native Z-up coordinates\n");
        sb.Append("mtllib ").Append(mtlName).Append('\n');

        // OBJ indices are global and 1-based across the whole file, so they are
        // accumulated as batches are written.
        int vertexOffset = 1;

        foreach (MeshBatch batch in batches)
        {
            sb.Append("\no ").Append(SanitiseName(batch.Material)).Append('\n');
            sb.Append("usemtl ").Append(SanitiseName(batch.Material)).Append('\n');

            foreach (MeshVertex vertex in batch.Vertices)
            {
                Vector3 p = convertToYUp ? ToYUp(vertex.Position) : vertex.Position;
                sb.Append("v ").Append(F(p.X)).Append(' ').Append(F(p.Y)).Append(' ').Append(F(p.Z)).Append('\n');
            }

            foreach (MeshVertex vertex in batch.Vertices)
            {
                // OBJ's V axis points up, ours points down, hence the flip.
                sb.Append("vt ").Append(F(vertex.TexCoord.X)).Append(' ').Append(F(-vertex.TexCoord.Y)).Append('\n');
            }

            foreach (MeshVertex vertex in batch.Vertices)
            {
                Vector3 n = convertToYUp ? ToYUp(vertex.Normal) : vertex.Normal;
                sb.Append("vn ").Append(F(n.X)).Append(' ').Append(F(n.Y)).Append(' ').Append(F(n.Z)).Append('\n');
            }

            for (int i = 0; i < batch.Indices.Count; i += 3)
            {
                int a = batch.Indices[i] + vertexOffset;
                int b = batch.Indices[i + 1] + vertexOffset;
                int c = batch.Indices[i + 2] + vertexOffset;
                sb.Append("f ")
                  .Append(a).Append('/').Append(a).Append('/').Append(a).Append(' ')
                  .Append(b).Append('/').Append(b).Append('/').Append(b).Append(' ')
                  .Append(c).Append('/').Append(c).Append('/').Append(c).Append('\n');
            }

            vertexOffset += batch.Vertices.Count;
        }

        return sb.ToString();
    }

    private static string BuildMtl(List<MeshBatch> batches)
    {
        var sb = new StringBuilder(2048);
        sb.Append("# Exported by Forge\n");

        foreach (MeshBatch batch in batches)
        {
            sb.Append("\nnewmtl ").Append(SanitiseName(batch.Material)).Append('\n');
            sb.Append("Ka 0.2 0.2 0.2\n");
            sb.Append("Kd 0.8 0.8 0.8\n");
            sb.Append("Ks 0.0 0.0 0.0\n");
            sb.Append("d 1.0\n");
            sb.Append("illum 2\n");
            // Points at the engine's material path; viewers resolve it if the file exists.
            sb.Append("map_Kd ").Append(batch.Material).Append(".png\n");
        }

        return sb.ToString();
    }

    /// <summary>Z-up to Y-up, preserving handedness so winding order stays valid.</summary>
    private static Vector3 ToYUp(Vector3 v) => new(v.X, v.Z, -v.Y);

    private static string F(float value)
    {
        if (value == 0f) value = 0f; // avoid "-0"
        return value.ToString("0.######", CultureInfo.InvariantCulture);
    }

    /// <summary>OBJ names cannot contain whitespace; slashes are kept as they read fine.</summary>
    private static string SanitiseName(string name) => name.Replace(' ', '_');
}
