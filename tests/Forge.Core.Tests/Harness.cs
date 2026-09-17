using System.Diagnostics;
using System.Numerics;
using System.Reflection;

namespace Forge.Tests;

/// <summary>Marks a parameterless static method as a test case.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class TestAttribute : Attribute
{
    public TestAttribute(string? description = null) => Description = description;

    public string? Description { get; }
}

/// <summary>Thrown when an assertion fails. Carries only the human-readable reason.</summary>
public sealed class AssertionException : Exception
{
    public AssertionException(string message) : base(message)
    {
    }
}

/// <summary>
/// Assertion helpers tuned for geometry work: every numeric comparison takes an explicit
/// tolerance, and failures report the actual delta so a near-miss is distinguishable
/// from a wrong answer.
/// </summary>
public static class Assert
{
    public static void IsTrue(bool condition, string message)
    {
        if (!condition) throw new AssertionException($"Expected true: {message}");
    }

    public static void IsFalse(bool condition, string message)
    {
        if (condition) throw new AssertionException($"Expected false: {message}");
    }

    public static void IsNotNull(object? value, string message)
    {
        if (value is null) throw new AssertionException($"Expected non-null: {message}");
    }

    public static void IsNull(object? value, string message)
    {
        if (value is not null) throw new AssertionException($"Expected null but got {value}: {message}");
    }

    public static void AreEqual(int expected, int actual, string message)
    {
        if (expected != actual)
            throw new AssertionException($"{message}: expected {expected}, got {actual}");
    }

    public static void AreEqual(string expected, string actual, string message)
    {
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
            throw new AssertionException($"{message}: expected \"{expected}\", got \"{actual}\"");
    }

    public static void AreClose(float expected, float actual, float tolerance, string message)
    {
        float delta = MathF.Abs(expected - actual);
        if (float.IsNaN(actual) || delta > tolerance)
            throw new AssertionException($"{message}: expected {expected:0.######}, got {actual:0.######} (delta {delta:0.######}, tolerance {tolerance:0.######})");
    }

    public static void AreClose(Vector3 expected, Vector3 actual, float tolerance, string message)
    {
        if (!MathUtil.NearlyEqual(expected, actual, tolerance))
            throw new AssertionException(
                $"{message}: expected ({expected.X:0.####} {expected.Y:0.####} {expected.Z:0.####}), "
              + $"got ({actual.X:0.####} {actual.Y:0.####} {actual.Z:0.####})");
    }

    public static void AreClose(Vector2 expected, Vector2 actual, float tolerance, string message)
    {
        if (MathF.Abs(expected.X - actual.X) > tolerance || MathF.Abs(expected.Y - actual.Y) > tolerance)
            throw new AssertionException(
                $"{message}: expected ({expected.X:0.####} {expected.Y:0.####}), got ({actual.X:0.####} {actual.Y:0.####})");
    }

    public static void Greater(float value, float threshold, string message)
    {
        if (!(value > threshold))
            throw new AssertionException($"{message}: expected > {threshold:0.####}, got {value:0.####}");
    }

    public static void Less(float value, float threshold, string message)
    {
        if (!(value < threshold))
            throw new AssertionException($"{message}: expected < {threshold:0.####}, got {value:0.####}");
    }

    public static void Throws<TException>(Action action, string message) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        catch (Exception ex)
        {
            throw new AssertionException($"{message}: expected {typeof(TException).Name} but got {ex.GetType().Name}");
        }
        throw new AssertionException($"{message}: expected {typeof(TException).Name} but nothing was thrown");
    }

    public static void Fail(string message) => throw new AssertionException(message);
}

/// <summary>
/// Discovers every <see cref="TestAttribute"/>-marked static method in the assembly and
/// runs it, reporting a summary and a non-zero exit code on failure.
/// </summary>
public static class Harness
{
    public static int Run(string[] args)
    {
        string? filter = args.FirstOrDefault(a => !a.StartsWith('-'));

        List<MethodInfo> tests = Assembly.GetExecutingAssembly()
            .GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Where(m => m.GetCustomAttribute<TestAttribute>() is not null)
            .Where(m => m.GetParameters().Length == 0)
            .OrderBy(m => m.DeclaringType!.Name, StringComparer.Ordinal)
            .ThenBy(m => m.Name, StringComparer.Ordinal)
            .ToList();

        if (filter is not null)
        {
            tests = tests
                .Where(m => $"{m.DeclaringType!.Name}.{m.Name}".Contains(filter, StringComparison.OrdinalIgnoreCase))
                .ToList();
            Console.WriteLine($"Filter: \"{filter}\"");
        }

        Console.WriteLine($"Running {tests.Count} test(s)\n");

        var failures = new List<(string Name, string Message, string? Stack)>();
        string? currentGroup = null;
        var stopwatch = Stopwatch.StartNew();

        foreach (MethodInfo test in tests)
        {
            string group = test.DeclaringType!.Name;
            if (group != currentGroup)
            {
                if (currentGroup is not null) Console.WriteLine();
                Console.WriteLine($"  {group}");
                currentGroup = group;
            }

            string label = test.GetCustomAttribute<TestAttribute>()!.Description ?? Humanise(test.Name);

            try
            {
                test.Invoke(null, null);
                Console.WriteLine($"    PASS  {label}");
            }
            catch (Exception ex)
            {
                // Reflection wraps whatever the test threw; report the real cause.
                Exception actual = (ex as TargetInvocationException)?.InnerException ?? ex;

                Console.WriteLine($"    FAIL  {label}");
                Console.WriteLine($"          {actual.Message}");

                failures.Add((
                    $"{group}.{test.Name}",
                    actual.Message,
                    actual is AssertionException ? null : actual.StackTrace));
            }
        }

        stopwatch.Stop();

        Console.WriteLine();
        Console.WriteLine(new string('-', 68));

        if (failures.Count == 0)
        {
            Console.WriteLine($"All {tests.Count} test(s) passed in {stopwatch.ElapsedMilliseconds} ms.");
            return 0;
        }

        Console.WriteLine($"{failures.Count} of {tests.Count} test(s) FAILED in {stopwatch.ElapsedMilliseconds} ms:");
        foreach ((string name, string message, string? stack) in failures)
        {
            Console.WriteLine($"  * {name}");
            Console.WriteLine($"      {message}");
            if (stack is not null) Console.WriteLine($"      {stack.Trim()}");
        }
        return 1;
    }

    /// <summary>Turns <c>SplitProducesWatertightHalves</c> into <c>split produces watertight halves</c>.</summary>
    private static string Humanise(string methodName)
    {
        var sb = new System.Text.StringBuilder(methodName.Length + 8);
        for (int i = 0; i < methodName.Length; i++)
        {
            char c = methodName[i];
            if (i > 0 && char.IsUpper(c) && !char.IsUpper(methodName[i - 1]))
            {
                sb.Append(' ').Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(i == 0 ? c : char.ToLowerInvariant(c));
            }
        }
        return sb.ToString();
    }
}

public static class Program
{
    public static int Main(string[] args) => Harness.Run(args);
}
