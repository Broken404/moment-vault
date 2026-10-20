using System.Security.Cryptography;
using System.Text;

namespace MomentVault.Host;

public static class Description
{
    public const string FileName = "描述.md";
    public static Material Load(string directory)
    {
        SafeFiles.RejectLinks(directory);
        var path = Path.Combine(directory, FileName);
        SafeFiles.RejectLinks(path);
        var raw = File.ReadAllText(path, Encoding.UTF8);
        var text = raw.Replace("\r\n", "\n");
        if (!text.StartsWith("---\n")) throw new VaultException("invalid-description", "说明文件缺少有效元数据，原文件未修改");
        var end = text.IndexOf("\n---\n", 4, StringComparison.Ordinal);
        if (end < 0) throw new VaultException("invalid-description", "说明文件格式有误，原文件未修改");
        var item = Json.Read<Material>(text[4..end]);
        SafeFiles.Id(item.Id);
        if (item.FormatVersion != 1 || item.Attachments.Count == 0) throw new VaultException("invalid-description", "说明格式版本或附件列表无效");
        foreach (var attachment in item.Attachments)
        {
            SafeFiles.Id(attachment.Id);
            if (Path.GetFileName(attachment.FileName) != attachment.FileName || string.IsNullOrWhiteSpace(attachment.FileName))
                throw new VaultException("invalid-description", "附件文件名无效");
        }
        item.Note = text[(end + 5)..].TrimEnd('\n');
        item.Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
        item.FolderName = Path.GetFileName(directory);
        return item;
    }

    public static void Save(string directory, Material item, string? expectedRevision = null)
    {
        var path = Path.Combine(directory, FileName);
        if (expectedRevision is not null && SafeFiles.Hash(path) != expectedRevision)
            throw new VaultException("external-change", "说明已被其他程序修改，请重新读取后再保存");
        // JSON flow mappings are valid YAML 1.2. Keep one representation that
        // System.Text.Json can round-trip with unknown fields preserved.
        SafeFiles.AtomicText(path, "---\n" + Json.Write(item) + "\n---\n" + item.Note.TrimEnd('\n') + "\n");
    }
}
