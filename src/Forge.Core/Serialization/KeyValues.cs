using System.Globalization;
using System.Text;

namespace Forge.Serialization;

/// <summary>Raised when a map file cannot be parsed, with the offending line number.</summary>
public sealed class MapParseException : Exception
{
    public MapParseException(string message, int line, int column)
        : base($"Line {line}, column {column}: {message}")
    {
        Line = line;
        Column = column;
    }

    public int Line { get; }

    public int Column { get; }
}

/// <summary>
/// A node in a keyvalue tree: a named block holding ordered properties and child blocks.
/// <para>
/// Forge stores maps in a brace-and-quote text format rather than JSON or a binary blob.
/// The reason is version control: a level is a long-lived collaborative document, and a
/// line-oriented text format produces reviewable diffs and survives merge conflicts.
/// Duplicate keys are permitted because entity outputs rely on them.
/// </para>
/// </summary>
public sealed class KvNode
{
    public KvNode(string name) => Name = name;

    public string Name { get; }

    /// <summary>Line the block started on, for error reporting.</summary>
    public int Line { get; internal set; }

    public List<KeyValuePair<string, string>> Properties { get; } = new();

    public List<KvNode> Children { get; } = new();

    public void Set(string key, string value) => Properties.Add(new KeyValuePair<string, string>(key, value));

    public void Set(string key, int value) => Set(key, value.ToString(CultureInfo.InvariantCulture));

    public void Set(string key, float value) => Set(key, Format(value));

    public void Set(string key, bool value) => Set(key, value ? "1" : "0");

    public KvNode AddChild(string name)
    {
        var child = new KvNode(name);
        Children.Add(child);
        return child;
    }

    public string? Get(string key)
    {
        foreach (KeyValuePair<string, string> property in Properties)
        {
            if (string.Equals(property.Key, key, StringComparison.OrdinalIgnoreCase)) return property.Value;
        }
        return null;
    }

    public string GetString(string key, string fallback = "") => Get(key) ?? fallback;

    public float GetFloat(string key, float fallback = 0f)
    {
        string? raw = Get(key);
        return raw is not null && float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out float value)
            ? value
            : fallback;
    }

    public int GetInt(string key, int fallback = 0)
    {
        string? raw = Get(key);
        return raw is not null && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? value
            : fallback;
    }

    public bool GetBool(string key, bool fallback = false)
    {
        string? raw = Get(key);
        return raw is null ? fallback : raw is "1" or "true" or "True" or "yes";
    }

    public IEnumerable<KvNode> ChildrenNamed(string name)
        => Children.Where(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));

    public KvNode? FirstChild(string name) => ChildrenNamed(name).FirstOrDefault();

    /// <summary>Formats a float compactly but losslessly enough for level geometry.</summary>
    internal static string Format(float value)
    {
        if (float.IsNaN(value) || float.IsInfinity(value)) return "0";

        // Collapse negative zero. It is numerically equal to +0 everywhere, but it prints
        // as "-0" and would otherwise make saving a file twice produce different bytes:
        // a plane distance built as -(0f) is -0, while the same distance recovered from a
        // dot product sums to +0, because IEEE addition of +0 and -0 yields +0.
        if (value == 0f) value = 0f;

        // Prefer the short form: whole numbers write as "64", not "64.000000", which keeps
        // the axis-aligned geometry that dominates real levels readable and diffable.
        string compact = value.ToString("0.######", CultureInfo.InvariantCulture);
        if (float.TryParse(compact, NumberStyles.Float, CultureInfo.InvariantCulture, out float parsed)
            && parsed == value)
        {
            return compact;
        }

        // Otherwise spend the extra digits. Truncating here would move an oblique plane
        // slightly on every save, and that drift compounds: geometry that was welded
        // watertight opens up after a few edit cycles. G9 is the shortest form guaranteed
        // to round-trip a float exactly.
        return value.ToString("G9", CultureInfo.InvariantCulture);
    }

    public override string ToString() => $"{Name} ({Properties.Count} props, {Children.Count} children)";
}

/// <summary>Tokenises and parses the keyvalue text format.</summary>
public static class KeyValueParser
{
    private enum TokenKind
    {
        String,
        OpenBrace,
        CloseBrace,
        End,
    }

    private readonly struct Token
    {
        public Token(TokenKind kind, string text, int line, int column)
        {
            Kind = kind;
            Text = text;
            Line = line;
            Column = column;
        }

        public TokenKind Kind { get; }

        public string Text { get; }

        public int Line { get; }

        public int Column { get; }
    }

    /// <summary>
    /// Parses a document into its top-level blocks. A document is a sequence of named
    /// blocks; there is no single root element.
    /// </summary>
    public static List<KvNode> Parse(string text)
    {
        List<Token> tokens = Tokenise(text);
        var nodes = new List<KvNode>();
        int index = 0;

        while (tokens[index].Kind != TokenKind.End)
        {
            Token token = tokens[index];
            if (token.Kind != TokenKind.String)
                throw new MapParseException($"Expected a block name but found '{Describe(token)}'.", token.Line, token.Column);

            index++;
            if (tokens[index].Kind != TokenKind.OpenBrace)
                throw new MapParseException($"Expected '{{' after block name '{token.Text}'.", tokens[index].Line, tokens[index].Column);

            index++;
            nodes.Add(ParseBlock(token.Text, token.Line, tokens, ref index));
        }

        return nodes;
    }

    private static KvNode ParseBlock(string name, int line, List<Token> tokens, ref int index)
    {
        var node = new KvNode(name) { Line = line };

        while (true)
        {
            Token token = tokens[index];

            switch (token.Kind)
            {
                case TokenKind.CloseBrace:
                    index++;
                    return node;

                case TokenKind.End:
                    throw new MapParseException($"Unexpected end of file: block '{name}' opened on line {line} was never closed.",
                        token.Line, token.Column);

                case TokenKind.String:
                {
                    index++;
                    Token next = tokens[index];

                    if (next.Kind == TokenKind.String)
                    {
                        // A key/value pair.
                        node.Set(token.Text, next.Text);
                        index++;
                    }
                    else if (next.Kind == TokenKind.OpenBrace)
                    {
                        // A nested block.
                        index++;
                        node.Children.Add(ParseBlock(token.Text, token.Line, tokens, ref index));
                    }
                    else
                    {
                        throw new MapParseException($"Expected a value or '{{' after '{token.Text}'.", next.Line, next.Column);
                    }
                    break;
                }

                default:
                    throw new MapParseException($"Unexpected '{Describe(token)}'.", token.Line, token.Column);
            }
        }
    }

    private static string Describe(Token token) => token.Kind switch
    {
        TokenKind.OpenBrace => "{",
        TokenKind.CloseBrace => "}",
        TokenKind.End => "end of file",
        _ => token.Text,
    };

    private static List<Token> Tokenise(string text)
    {
        var tokens = new List<Token>(256);
        int line = 1;
        int lineStart = 0;

        for (int i = 0; i < text.Length;)
        {
            char c = text[i];

            if (c == '\n')
            {
                line++;
                i++;
                lineStart = i;
                continue;
            }
            if (char.IsWhiteSpace(c))
            {
                i++;
                continue;
            }

            // Line comments.
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '/')
            {
                while (i < text.Length && text[i] != '\n') i++;
                continue;
            }

            int column = i - lineStart + 1;

            if (c == '{')
            {
                tokens.Add(new Token(TokenKind.OpenBrace, "{", line, column));
                i++;
                continue;
            }
            if (c == '}')
            {
                tokens.Add(new Token(TokenKind.CloseBrace, "}", line, column));
                i++;
                continue;
            }

            if (c == '"')
            {
                i++;
                var sb = new StringBuilder();
                while (i < text.Length && text[i] != '"')
                {
                    if (text[i] == '\\' && i + 1 < text.Length)
                    {
                        // Only quote and backslash need escaping; anything else stays literal
                        // so Windows-style material paths survive untouched.
                        char escaped = text[i + 1];
                        if (escaped is '"' or '\\')
                        {
                            sb.Append(escaped);
                            i += 2;
                            continue;
                        }
                    }
                    if (text[i] == '\n')
                        throw new MapParseException("Unterminated quoted string.", line, column);

                    sb.Append(text[i]);
                    i++;
                }
                if (i >= text.Length)
                    throw new MapParseException("Unterminated quoted string at end of file.", line, column);

                i++; // closing quote
                tokens.Add(new Token(TokenKind.String, sb.ToString(), line, column));
                continue;
            }

            // Bare word: block names are written unquoted.
            int start = i;
            while (i < text.Length && !char.IsWhiteSpace(text[i]) && text[i] != '{' && text[i] != '}' && text[i] != '"')
                i++;
            tokens.Add(new Token(TokenKind.String, text[start..i], line, column));
        }

        tokens.Add(new Token(TokenKind.End, string.Empty, line, 1));
        return tokens;
    }
}

/// <summary>Writes keyvalue trees back out as text.</summary>
public static class KeyValueWriter
{
    public static string Write(IEnumerable<KvNode> nodes)
    {
        var sb = new StringBuilder(4096);
        foreach (KvNode node in nodes) WriteNode(sb, node, 0);
        return sb.ToString();
    }

    private static void WriteNode(StringBuilder sb, KvNode node, int depth)
    {
        string indent = new('\t', depth);
        sb.Append(indent).Append(node.Name).Append('\n');
        sb.Append(indent).Append('{').Append('\n');

        string inner = new('\t', depth + 1);
        foreach (KeyValuePair<string, string> property in node.Properties)
        {
            sb.Append(inner)
              .Append('"').Append(Escape(property.Key)).Append('"')
              .Append(' ')
              .Append('"').Append(Escape(property.Value)).Append('"')
              .Append('\n');
        }

        foreach (KvNode child in node.Children)
            WriteNode(sb, child, depth + 1);

        sb.Append(indent).Append('}').Append('\n');
    }

    private static string Escape(string value)
    {
        if (!value.Contains('"') && !value.Contains('\\')) return value;
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
