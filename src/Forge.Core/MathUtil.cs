using System.Numerics;

namespace Forge;

/// <summary>
/// Shared numeric tolerances and helpers.
/// <para>
/// Forge uses the Hammer/Source conventions: a right-handed, <b>Z-up</b> coordinate
/// system where one unit is nominally one inch. Player eye height is ~64 units,
/// a comfortable corridor is 128 units wide, and the practical world limit is
/// +/-16384 units on each axis.
/// </para>
/// <para>
/// Because the world is measured in inches rather than metres, the epsilons here
/// look large compared to typical graphics code. That is deliberate: at a
/// coordinate magnitude of 16384 a 32-bit float only resolves ~0.002 units, so
/// sub-millimetre tolerances would be pure noise.
/// </para>
/// </summary>
public static class MathUtil
{
    /// <summary>General purpose comparison tolerance for normalized quantities.</summary>
    public const float Epsilon = 1e-5f;

    /// <summary>
    /// Distance below which a point is considered to lie *on* a plane.
    /// Matches Quake/Source "ON_EPSILON" style tolerances scaled for inch units.
    /// </summary>
    public const float OnEpsilon = 0.01f;

    /// <summary>Tolerance used when deciding whether two plane normals point the same way.</summary>
    public const float NormalEpsilon = 1e-4f;

    /// <summary>Half-extent of the quad generated when materialising an infinite plane.</summary>
    public const float PlaneExtent = 32768f;

    /// <summary>Largest coordinate a valid map is allowed to reach on any axis.</summary>
    public const float MaxWorldCoord = 16384f;

    /// <summary>Windings with an area smaller than this are treated as degenerate slivers.</summary>
    public const float MinWindingArea = 0.05f;

    /// <summary>Grid sizes offered by the editor, in units. Power-of-two, Hammer style.</summary>
    public static readonly int[] GridSizes = { 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 };

    public static float Clamp(float v, float min, float max) => v < min ? min : v > max ? max : v;

    public static float Lerp(float a, float b, float t) => a + (b - a) * t;

    public static float DegToRad(float degrees) => degrees * (MathF.PI / 180f);

    public static float RadToDeg(float radians) => radians * (180f / MathF.PI);

    public static bool NearlyEqual(float a, float b, float tolerance = Epsilon)
        => MathF.Abs(a - b) <= tolerance;

    public static bool NearlyEqual(Vector3 a, Vector3 b, float tolerance = Epsilon)
        => MathF.Abs(a.X - b.X) <= tolerance
        && MathF.Abs(a.Y - b.Y) <= tolerance
        && MathF.Abs(a.Z - b.Z) <= tolerance;

    /// <summary>Snaps a scalar to the nearest multiple of <paramref name="grid"/>.</summary>
    public static float SnapToGrid(float value, float grid)
        => grid <= 0f ? value : MathF.Round(value / grid) * grid;

    /// <summary>Snaps every component of a point to the nearest grid intersection.</summary>
    public static Vector3 SnapToGrid(Vector3 value, float grid) => grid <= 0f
        ? value
        : new Vector3(SnapToGrid(value.X, grid), SnapToGrid(value.Y, grid), SnapToGrid(value.Z, grid));

    /// <summary>
    /// Rounds values that are within <see cref="OnEpsilon"/> of an integer to that
    /// integer. Brush vertices are produced by intersecting planes, which tends to
    /// yield 63.999996 where the designer clearly meant 64.
    /// </summary>
    public static float SnapToInteger(float value, float tolerance = OnEpsilon)
    {
        float rounded = MathF.Round(value);
        return MathF.Abs(value - rounded) < tolerance ? rounded : value;
    }

    public static Vector3 SnapToInteger(Vector3 value, float tolerance = OnEpsilon)
        => new(SnapToInteger(value.X, tolerance),
               SnapToInteger(value.Y, tolerance),
               SnapToInteger(value.Z, tolerance));

    /// <summary>Index (0=X, 1=Y, 2=Z) of the component with the largest magnitude.</summary>
    public static int DominantAxis(Vector3 v)
    {
        float ax = MathF.Abs(v.X), ay = MathF.Abs(v.Y), az = MathF.Abs(v.Z);
        if (ax >= ay && ax >= az) return 0;
        return ay >= az ? 1 : 2;
    }

    public static float GetComponent(Vector3 v, int axis) => axis switch
    {
        0 => v.X,
        1 => v.Y,
        2 => v.Z,
        _ => throw new ArgumentOutOfRangeException(nameof(axis)),
    };

    public static Vector3 WithComponent(Vector3 v, int axis, float value)
    {
        switch (axis)
        {
            case 0: v.X = value; break;
            case 1: v.Y = value; break;
            case 2: v.Z = value; break;
            default: throw new ArgumentOutOfRangeException(nameof(axis));
        }
        return v;
    }

    /// <summary>
    /// Returns a unit vector perpendicular to <paramref name="normal"/>, chosen so that
    /// the result is numerically stable regardless of the input orientation.
    /// </summary>
    public static Vector3 Perpendicular(Vector3 normal)
    {
        // Pick the *least* dominant axis so the cross product never collapses.
        int axis = DominantAxis(normal);
        Vector3 seed = axis == 0 ? Vector3.UnitY : Vector3.UnitX;
        Vector3 result = Vector3.Cross(normal, seed);
        float length = result.Length();
        if (length < Epsilon)
        {
            result = Vector3.Cross(normal, Vector3.UnitZ);
            length = result.Length();
            if (length < Epsilon) return Vector3.UnitX;
        }
        return result / length;
    }

    /// <summary>
    /// Rotates <paramref name="v"/> about <paramref name="axis"/> by
    /// <paramref name="degrees"/> using Rodrigues' rotation formula.
    /// </summary>
    public static Vector3 RotateAbout(Vector3 v, Vector3 axis, float degrees)
    {
        if (MathF.Abs(degrees) < Epsilon) return v;
        axis = Vector3.Normalize(axis);
        float rad = DegToRad(degrees);
        float cos = MathF.Cos(rad), sin = MathF.Sin(rad);
        return v * cos
             + Vector3.Cross(axis, v) * sin
             + axis * (Vector3.Dot(axis, v) * (1f - cos));
    }

    /// <summary>True when the point lies inside the legal world bounds.</summary>
    public static bool IsInWorldBounds(Vector3 p)
        => MathF.Abs(p.X) <= MaxWorldCoord
        && MathF.Abs(p.Y) <= MaxWorldCoord
        && MathF.Abs(p.Z) <= MaxWorldCoord;
}
