using System.Security.Cryptography;
using System.Text;

namespace MomentVault.Host;

public static class SafeFiles
{
    public static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static void AtomicText(string path, string text)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var bytes = new UTF8Encoding(false).GetBytes(text);
                stream.Write(bytes);
                stream.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static string Root(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new VaultException("invalid-directory", "请选择完整的本地目录");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (!Directory.Exists(full)) throw new VaultException("missing-directory", "目录不存在，请重新选择");
        RejectLinks(full);
        return full;
    }

    public static void RejectLinks(string path)
    {
        var current = Path.GetFullPath(path);
        while (!string.IsNullOrEmpty(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new VaultException("linked-path", "此路径含链接或重定向，请选择实际目录");
            current = Path.GetDirectoryName(current);
        }
    }

    public static bool Contains(string parent, string child) =>
        string.Equals(parent, child, StringComparison.OrdinalIgnoreCase) ||
        child.StartsWith(Path.TrimEndingDirectorySeparator(parent) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    public static string Id(string value)
    {
        if (!Guid.TryParseExact(value, "N", out _)) throw new VaultException("invalid-id", "素材标识无效");
        return value;
    }

    public static string Name(string value)
    {
        var clean = new string(value.Where(c => !Path.GetInvalidFileNameChars().Contains(c) && !char.IsControl(c)).ToArray()).Trim().TrimEnd('.', ' ');
        if (clean.Length > 100) clean = clean[..100];
        var stem = clean.Split('.')[0].ToUpperInvariant();
        if (new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(stem)) clean = "素材-" + clean;
        return string.IsNullOrWhiteSpace(clean) || clean.StartsWith('.') ? "素材" : clean;
    }

    public static string Available(string root, string name)
    {
        name = Name(name);
        var result = Path.Combine(root, name);
        for (var i = 2; Directory.Exists(result) || File.Exists(result); i++) result = Path.Combine(root, $"{name}-{i:000}");
        return result;
    }

    public static Dictionary<string, string> Snapshot(string directory)
    {
        RejectLinks(directory);
        var hashes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        Walk(directory);
        return hashes;
        void Walk(string parent)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(parent))
            {
                RejectLinks(path);
                if (Directory.Exists(path)) Walk(path);
                else hashes.Add(Path.GetRelativePath(directory, path), Hash(path));
            }
        }
    }

    public static bool Same(Dictionary<string, string> a, Dictionary<string, string> b) =>
        a.Count == b.Count && a.All(pair => b.TryGetValue(pair.Key, out var hash) && hash == pair.Value);

    public static void CopyVerified(string source, string target)
    {
        var original = Snapshot(source);
        Directory.CreateDirectory(target);
        foreach (var relative in original.Keys)
        {
            var destination = Path.Combine(target, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(Path.Combine(source, relative), destination, false);
        }
        if (!Same(original, Snapshot(target)) || !Same(original, Snapshot(source)))
            throw new VaultException("copy-mismatch", "复制校验未通过，原素材已保留");
    }
}
