using System.Globalization;
using System.Numerics;

namespace Forge.Map;

/// <summary>
/// One entry in an entity's output list, wiring an event on this entity to an input on
/// another. This is the Source-style I/O system, and it is what lets designers build
/// logic (a button opening a door) without writing code.
/// </summary>
public sealed class Output
{
    /// <summary>The event that fires, e.g. <c>OnPressed</c>.</summary>
    public string Name = string.Empty;

    /// <summary>Target entity's <c>targetname</c>. May match several entities.</summary>
    public string TargetEntity = string.Empty;

    /// <summary>The input to invoke on the target, e.g. <c>Open</c>.</summary>
    public string TargetInput = string.Empty;

    /// <summary>Optional parameter passed to the input.</summary>
    public string Parameter = string.Empty;

    /// <summary>Delay in seconds before the input fires.</summary>
    public float Delay;

    /// <summary>How many times this output may fire. -1 means unlimited.</summary>
    public int TimesToFire = -1;

    /// <summary>Serialises to <c>target,input,parameter,delay,times</c>.</summary>
    public string ToValueString()
        => string.Join(',',
            TargetEntity,
            TargetInput,
            Parameter,
            Delay.ToString("0.####", CultureInfo.InvariantCulture),
            TimesToFire.ToString(CultureInfo.InvariantCulture));

    /// <summary>Parses the comma-separated output payload. Missing trailing fields use defaults.</summary>
    public static Output Parse(string name, string value)
    {
        string[] parts = value.Split(',');
        var output = new Output { Name = name };

        if (parts.Length > 0) output.TargetEntity = parts[0].Trim();
        if (parts.Length > 1) output.TargetInput = parts[1].Trim();
        if (parts.Length > 2) output.Parameter = parts[2].Trim();
        if (parts.Length > 3 && float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out float delay))
            output.Delay = delay;
        if (parts.Length > 4 && int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out int times))
            output.TimesToFire = times;

        return output;
    }

    public Output Clone() => new()
    {
        Name = Name,
        TargetEntity = TargetEntity,
        TargetInput = TargetInput,
        Parameter = Parameter,
        Delay = Delay,
        TimesToFire = TimesToFire,
    };

    public override string ToString() => $"{Name} -> {TargetEntity}.{TargetInput}";
}

/// <summary>
/// A gameplay object: either a point entity (a light, a spawn point) or a brush entity
/// (a door, a trigger volume) that owns solids.
/// <para>
/// Entities are schemaless key/value bags rather than typed classes. That is deliberate:
/// the editor learns what keys an entity supports from its <see cref="Fgd"/> definition
/// at runtime, so adding a new gameplay type never requires touching the editor or the
/// map format.
/// </para>
/// </summary>
public sealed class Entity
{
    /// <summary>Keys promoted to the front of the file for readability.</summary>
    private static readonly string[] PreferredKeyOrder = { "classname", "targetname", "origin", "angles" };

    private readonly Dictionary<string, string> _properties = new(StringComparer.OrdinalIgnoreCase);

    public int Id;

    public List<Output> Outputs { get; } = new();

    /// <summary>Solids owned by this entity. Empty for point entities.</summary>
    public List<Brush> Brushes { get; } = new();

    public string? VisGroup;

    public Entity()
    {
    }

    public Entity(string className) => ClassName = className;

    public string ClassName
    {
        get => GetString("classname", "info_null");
        set => SetString("classname", value);
    }

    public string? TargetName
    {
        get => _properties.TryGetValue("targetname", out string? v) ? v : null;
        set
        {
            if (string.IsNullOrEmpty(value)) _properties.Remove("targetname");
            else SetString("targetname", value);
        }
    }

    public Vector3 Origin
    {
        get => GetVector3("origin", Vector3.Zero);
        set => SetVector3("origin", value);
    }

    /// <summary>Euler angles in degrees, stored as <c>pitch yaw roll</c>.</summary>
    public Vector3 Angles
    {
        get => GetVector3("angles", Vector3.Zero);
        set => SetVector3("angles", value);
    }

    public bool IsBrushEntity => Brushes.Count > 0;

    public bool IsPointEntity => Brushes.Count == 0;

    /// <summary>Keys in a stable order: well-known keys first, then the rest alphabetically.</summary>
    public IEnumerable<string> Keys
    {
        get
        {
            foreach (string key in PreferredKeyOrder)
            {
                if (_properties.ContainsKey(key)) yield return key;
            }
            foreach (string key in _properties.Keys
                         .Where(k => !PreferredKeyOrder.Contains(k, StringComparer.OrdinalIgnoreCase))
                         .OrderBy(k => k, StringComparer.OrdinalIgnoreCase))
            {
                yield return key;
            }
        }
    }

    public bool HasKey(string key) => _properties.ContainsKey(key);

    public bool Remove(string key) => _properties.Remove(key);

    public string GetString(string key, string fallback = "")
        => _properties.TryGetValue(key, out string? value) ? value : fallback;

    public void SetString(string key, string value) => _properties[key] = value;

    public float GetFloat(string key, float fallback = 0f)
        => _properties.TryGetValue(key, out string? value)
        && float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out float result)
            ? result
            : fallback;

    public void SetFloat(string key, float value)
        => _properties[key] = value.ToString("0.######", CultureInfo.InvariantCulture);

    public int GetInt(string key, int fallback = 0)
        => _properties.TryGetValue(key, out string? value)
        && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int result)
            ? result
            : fallback;

    public void SetInt(string key, int value)
        => _properties[key] = value.ToString(CultureInfo.InvariantCulture);

    public bool GetBool(string key, bool fallback = false)
        => _properties.TryGetValue(key, out string? value)
            ? value is "1" or "true" or "True" or "yes"
            : fallback;

    public void SetBool(string key, bool value) => _properties[key] = value ? "1" : "0";

    /// <summary>Reads a space-separated triple, e.g. <c>"0 0 64"</c>.</summary>
    public Vector3 GetVector3(string key, Vector3 fallback = default)
    {
        if (!_properties.TryGetValue(key, out string? value)) return fallback;
        return TryParseVector3(value, out Vector3 result) ? result : fallback;
    }

    public void SetVector3(string key, Vector3 value)
        => _properties[key] = string.Join(' ',
            value.X.ToString("0.######", CultureInfo.InvariantCulture),
            value.Y.ToString("0.######", CultureInfo.InvariantCulture),
            value.Z.ToString("0.######", CultureInfo.InvariantCulture));

    /// <summary>Parses a whitespace-separated triple, tolerating surrounding brackets.</summary>
    public static bool TryParseVector3(string text, out Vector3 result)
    {
        result = default;
        string trimmed = text.Trim().Trim('(', ')', '[', ']');
        string[] parts = trimmed.Split(new[] { ' ', '\t', ',' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3) return false;

        if (!float.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out float x)) return false;
        if (!float.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out float y)) return false;
        if (!float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out float z)) return false;

        result = new Vector3(x, y, z);
        return true;
    }

    /// <summary>
    /// The entity's position for editor display and compilation. Brush entities report the
    /// centre of their solids, because their <c>origin</c> key is usually absent or is a
    /// pivot rather than a location.
    /// </summary>
    public Vector3 GetEffectiveOrigin()
    {
        if (IsPointEntity || HasKey("origin")) return Origin;

        Geometry.Aabb bounds = Geometry.Aabb.Empty;
        foreach (Brush brush in Brushes) bounds = bounds.Union(brush.Bounds);
        return bounds.IsEmpty ? Vector3.Zero : bounds.Center;
    }

    public Entity Clone()
    {
        var clone = new Entity { Id = Id, VisGroup = VisGroup };
        foreach ((string key, string value) in _properties) clone._properties[key] = value;
        foreach (Output output in Outputs) clone.Outputs.Add(output.Clone());
        foreach (Brush brush in Brushes) clone.Brushes.Add(brush.Clone());
        return clone;
    }

    public override string ToString()
        => $"{ClassName}#{Id}{(TargetName is null ? "" : $" \"{TargetName}\"")}"
         + (IsBrushEntity ? $" ({Brushes.Count} solids)" : "");
}
