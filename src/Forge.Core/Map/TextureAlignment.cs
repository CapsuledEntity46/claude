using System.Numerics;
using Forge.Geometry;

namespace Forge.Map;

/// <summary>How a face's texture axes are derived when they are (re)initialised.</summary>
public enum TextureAlignmentMode
{
    /// <summary>
    /// Axes snap to the world axis pair most closely matching the face normal. Textures
    /// stay consistent across adjacent walls but "smear" on steep slopes. Hammer's default.
    /// </summary>
    World,

    /// <summary>
    /// Axes are projected onto the face plane, so the texture lies flat along a slope
    /// without stretching. Hammer's "Face" alignment.
    /// </summary>
    Face,
}

/// <summary>
/// Planar texture projection for a single brush face, matching the Valve 220 / Hammer
/// model: two world-space axes, a pixel offset, a scale in units-per-pixel, and a
/// rotation about the face normal.
/// <para>
/// UVs are computed directly from world position:
/// <c>u = dot(p, UAxis) / UScale + UShift</c>. Because the projection is world-space
/// rather than per-vertex, textures automatically line up across brushes that share a
/// surface — the property that makes brush-based level design feel seamless, and the
/// reason UVs are never stored per-vertex in the map file.
/// </para>
/// </summary>
public sealed class TextureAlignment
{
    /// <summary>Base axis table: (normal, uAxis, vAxis) triples for the six cardinal orientations.</summary>
    private static readonly Vector3[] BaseAxes =
    {
        new(0, 0, 1),   new(1, 0, 0),  new(0, -1, 0),  // floor
        new(0, 0, -1),  new(1, 0, 0),  new(0, -1, 0),  // ceiling
        new(1, 0, 0),   new(0, 1, 0),  new(0, 0, -1),  // west wall
        new(-1, 0, 0),  new(0, 1, 0),  new(0, 0, -1),  // east wall
        new(0, 1, 0),   new(1, 0, 0),  new(0, 0, -1),  // south wall
        new(0, -1, 0),  new(1, 0, 0),  new(0, 0, -1),  // north wall
    };

    public Vector3 UAxis = Vector3.UnitX;
    public Vector3 VAxis = -Vector3.UnitY;

    /// <summary>Texture offset in pixels.</summary>
    public float UShift;
    public float VShift;

    /// <summary>World units per texture pixel. Larger values make the texture appear bigger.</summary>
    public float UScale = 0.25f;
    public float VScale = 0.25f;

    /// <summary>Rotation in degrees about the face normal. Stored for round-tripping and UI display.</summary>
    public float Rotation;

    public TextureAlignment()
    {
    }

    public TextureAlignment(Vector3 uAxis, Vector3 vAxis, float uShift, float vShift, float uScale, float vScale, float rotation = 0f)
    {
        UAxis = uAxis;
        VAxis = vAxis;
        UShift = uShift;
        VShift = vShift;
        UScale = uScale;
        VScale = vScale;
        Rotation = rotation;
    }

    /// <summary>
    /// Picks the world-aligned axis pair whose reference normal best matches
    /// <paramref name="normal"/>. This is the classic Quake/Hammer alignment.
    /// </summary>
    public static TextureAlignment ForNormal(Vector3 normal, float scale = 0.25f)
    {
        int best = 0;
        float bestDot = -float.MaxValue;
        for (int i = 0; i < 6; i++)
        {
            float dot = Vector3.Dot(normal, BaseAxes[i * 3]);
            if (dot > bestDot)
            {
                bestDot = dot;
                best = i;
            }
        }

        return new TextureAlignment
        {
            UAxis = BaseAxes[best * 3 + 1],
            VAxis = BaseAxes[best * 3 + 2],
            UScale = scale,
            VScale = scale,
        };
    }

    /// <summary>
    /// Re-derives the axes for a face normal using the requested alignment mode,
    /// preserving scale, shift, and rotation.
    /// </summary>
    public void Align(Vector3 normal, TextureAlignmentMode mode)
    {
        TextureAlignment world = ForNormal(normal, UScale);
        Vector3 u = world.UAxis;
        Vector3 v = world.VAxis;

        if (mode == TextureAlignmentMode.Face)
        {
            // Project the world axes onto the face plane so the texture lies flat on slopes.
            u -= normal * Vector3.Dot(u, normal);
            if (u.Length() < MathUtil.Epsilon) u = MathUtil.Perpendicular(normal);
            u = Vector3.Normalize(u);
            v = Vector3.Normalize(Vector3.Cross(u, normal));
        }

        UAxis = u;
        VAxis = v;

        if (MathF.Abs(Rotation) > MathUtil.Epsilon)
        {
            float rotation = Rotation;
            Rotation = 0f;
            SetRotation(rotation, normal);
        }
    }

    /// <summary>Rotates the axes about the face normal to an absolute angle in degrees.</summary>
    public void SetRotation(float degrees, Vector3 normal)
    {
        float delta = degrees - Rotation;
        if (MathF.Abs(delta) < MathUtil.Epsilon) return;
        UAxis = Vector3.Normalize(MathUtil.RotateAbout(UAxis, normal, delta));
        VAxis = Vector3.Normalize(MathUtil.RotateAbout(VAxis, normal, delta));
        Rotation = NormalizeAngle(degrees);
    }

    private static float NormalizeAngle(float degrees)
    {
        degrees %= 360f;
        if (degrees < 0f) degrees += 360f;
        return degrees;
    }

    /// <summary>Texture-space coordinates in <b>pixels</b> for a world position.</summary>
    public Vector2 GetPixelCoords(Vector3 worldPosition)
    {
        float uScale = MathF.Abs(UScale) < MathUtil.Epsilon ? 1f : UScale;
        float vScale = MathF.Abs(VScale) < MathUtil.Epsilon ? 1f : VScale;
        return new Vector2(
            Vector3.Dot(worldPosition, UAxis) / uScale + UShift,
            Vector3.Dot(worldPosition, VAxis) / vScale + VShift);
    }

    /// <summary>
    /// Normalised UVs ready for the GPU, given the texture's pixel dimensions.
    /// </summary>
    public Vector2 GetUV(Vector3 worldPosition, int textureWidth, int textureHeight)
    {
        Vector2 pixels = GetPixelCoords(worldPosition);
        if (textureWidth <= 0) textureWidth = 1;
        if (textureHeight <= 0) textureHeight = 1;
        return new Vector2(pixels.X / textureWidth, pixels.Y / textureHeight);
    }

    /// <summary>
    /// Rewrites the projection so that the texture appears glued to the surface as it
    /// moves. <paramref name="referencePoint"/> is a point on the face before the
    /// transform; its texture coordinate is preserved exactly.
    /// </summary>
    public void TransformWithLock(Matrix4x4 matrix, Vector3 referencePoint)
    {
        Vector2 before = GetPixelCoords(referencePoint);

        // dot(M*p, L^-T * a) == dot(p, a), so the inverse-transpose carries the axes.
        Matrix4x4 linear = matrix;
        linear.Translation = Vector3.Zero;

        Matrix4x4 basis = Matrix4x4.Invert(linear, out Matrix4x4 inverse)
            ? Matrix4x4.Transpose(inverse)
            : linear;

        Vector3 newU = Vector3.TransformNormal(UAxis, basis);
        Vector3 newV = Vector3.TransformNormal(VAxis, basis);

        // Renormalising the axes folds the length change into the scale, which is what
        // keeps a stretched brush from also stretching its texture unexpectedly.
        float lenU = newU.Length();
        float lenV = newV.Length();
        if (lenU > MathUtil.Epsilon)
        {
            UAxis = newU / lenU;
            UScale /= lenU;
        }
        if (lenV > MathUtil.Epsilon)
        {
            VAxis = newV / lenV;
            VScale /= lenV;
        }

        // Re-anchor the offset so the reference point keeps its original coordinate.
        Vector3 movedReference = Vector3.Transform(referencePoint, matrix);
        UShift = 0f;
        VShift = 0f;
        Vector2 after = GetPixelCoords(movedReference);
        UShift = before.X - after.X;
        VShift = before.Y - after.Y;
    }

    /// <summary>
    /// Shifts the projection so the texture's origin lands at the winding's minimum
    /// corner in texture space. Hammer calls this "Justify".
    /// </summary>
    public void JustifyToWinding(Winding winding, int textureWidth, int textureHeight, bool center = false)
    {
        if (winding.Count == 0) return;

        float minU = float.MaxValue, minV = float.MaxValue;
        float maxU = float.MinValue, maxV = float.MinValue;
        foreach (Vector3 p in winding.Points)
        {
            Vector2 uv = GetPixelCoords(p);
            minU = MathF.Min(minU, uv.X);
            minV = MathF.Min(minV, uv.Y);
            maxU = MathF.Max(maxU, uv.X);
            maxV = MathF.Max(maxV, uv.Y);
        }

        if (center)
        {
            UShift += (textureWidth - (minU + maxU)) * 0.5f;
            VShift += (textureHeight - (minV + maxV)) * 0.5f;
        }
        else
        {
            UShift -= minU;
            VShift -= minV;
        }
    }

    /// <summary>Scales the projection so the texture exactly covers the winding once.</summary>
    public void FitToWinding(Winding winding, int textureWidth, int textureHeight)
    {
        if (winding.Count == 0) return;

        UShift = 0f;
        VShift = 0f;
        UScale = 1f;
        VScale = 1f;

        float minU = float.MaxValue, minV = float.MaxValue;
        float maxU = float.MinValue, maxV = float.MinValue;
        foreach (Vector3 p in winding.Points)
        {
            Vector2 uv = GetPixelCoords(p);
            minU = MathF.Min(minU, uv.X);
            minV = MathF.Min(minV, uv.Y);
            maxU = MathF.Max(maxU, uv.X);
            maxV = MathF.Max(maxV, uv.Y);
        }

        float spanU = maxU - minU;
        float spanV = maxV - minV;
        if (spanU > MathUtil.Epsilon) UScale = spanU / textureWidth;
        if (spanV > MathUtil.Epsilon) VScale = spanV / textureHeight;

        JustifyToWinding(winding, textureWidth, textureHeight);
    }

    public TextureAlignment Clone() => new(UAxis, VAxis, UShift, VShift, UScale, VScale, Rotation);

    public override string ToString()
        => $"U[{UAxis.X:0.##} {UAxis.Y:0.##} {UAxis.Z:0.##} {UShift:0.##}] x{UScale:0.###} / "
         + $"V[{VAxis.X:0.##} {VAxis.Y:0.##} {VAxis.Z:0.##} {VShift:0.##}] x{VScale:0.###} rot {Rotation:0.#}";
}
