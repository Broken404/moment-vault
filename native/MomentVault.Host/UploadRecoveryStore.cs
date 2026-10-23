using System.Text.Json;

namespace MomentVault.Host;

public sealed partial class VaultStore
{
    public void RequireDraftRoot(string root)
    {
        if (!string.Equals(Path.TrimEndingDirectorySeparator(root), config.DraftRoot, StringComparison.OrdinalIgnoreCase))
            throw new VaultException("upload-directory-changed", "草稿目录已改变，请返回原目录后继续保存");
    }

    public (UploadSummary[] Items, int Total, string[] Warnings) IncompleteUploads(string root, int offset)
    {
        RequireDraftRoot(root);
        var saved = List("draft").Items.Select(i => i.Id).ToHashSet();
        var states = new List<UploadSummary>();
        var warnings = new List<string>();
        foreach (var directory in Directory.EnumerateDirectories(Area("pending")))
        {
            if (saved.Contains(Path.GetFileName(directory)) || UploadDiscarded(Path.GetFileName(directory))) continue;
            try
            {
                SafeFiles.RejectLinks(directory);
                var state = ReadUpload(directory);
                if (state.Recording is not null) continue;
                if (SafeFiles.Id(state.Material.Id) != Path.GetFileName(directory))
                    throw new VaultException("invalid-upload", "保存记录标识不一致");
                states.Add(Summary(UploadProgress(directory, state)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or VaultException or JsonException)
            { if (warnings.Count < 20) warnings.Add("一条未完成保存的记录无法读取，原数据保留，请检查本地目录"); }
        }
        var page = states.OrderByDescending(i => i.CreatedAt).Skip(Math.Max(0, offset)).Take(20).ToArray();
        return (page, states.Count, warnings.ToArray());
    }

    public UploadProgress GetUpload(string root, string id)
    {
        RequireDraftRoot(root); SafeFiles.Id(id);
        var saved = List("draft").Items.SingleOrDefault(i => i.Id == id);
        if (saved is not null) return new("saved", id, saved.Name, saved.CreatedAt, [], saved);
        var directory = Pending(id);
        var state = ReadUpload(directory);
        if (state.Recording is not null) throw new VaultException("recording-upload", "录制请使用重试保存 MP4");
        if (state.Material.Id != id) throw new VaultException("invalid-upload", "保存记录标识不一致，原数据保留");
        return UploadProgress(directory, state);
    }

    private static UploadSummary Summary(UploadProgress progress) => new(progress.Id, progress.Name, progress.CreatedAt,
        progress.Files.Length, progress.Files.Count(f => f.Complete), progress.Files.Sum(f => f.ReceivedBytes),
        progress.Files.All(f => f.Bytes.HasValue) ? progress.Files.Sum(f => f.Bytes!.Value) : null);

    internal UploadProgress UploadProgress(UploadState state)
    {
        if (state.Material.FolderName.Length > 0 || !Directory.Exists(Path.Combine(Area("pending"), state.Material.Id)))
            return new("saved", state.Material.Id, state.Material.Name, state.Material.CreatedAt, [], state.Material);
        return UploadProgress(Pending(state.Material.Id), state);
    }

    private static UploadProgress UploadProgress(string directory, UploadState state)
    {
        var parts = Directory.EnumerateFiles(directory, "*.part").Select(path =>
        {
            SafeFiles.RejectLinks(path);
            return new FileInfo(path);
        }).ToArray();
        var files = state.Material.Attachments.Select(file =>
        {
            SafeFiles.Id(file.Id);
            // Native names are derived at Begin; a tampered record cannot select another path.
            if (file.FileName != Path.GetFileName(file.FileName)) throw new VaultException("invalid-upload", "附件文件名无效");
            var path = Path.Combine(directory, file.FileName); SafeFiles.RejectLinks(path);
            var complete = state.FinishedChunks.ContainsKey(file.Id) && File.Exists(path) && new FileInfo(path).Length == file.Bytes;
            var input = state.Inputs.SingleOrDefault(i => i.Id == file.Id);
            return new UploadFileProgress(file.Id, file.FileName, input?.OriginalName ?? "", Path.GetExtension(file.FileName).TrimStart('.'),
                file.Kind, file.Mime, input?.Bytes ?? (complete ? file.Bytes : null), input?.LastModified, complete,
                complete ? file.Bytes : parts.Where(p => p.Name.StartsWith(file.Id + ".", StringComparison.Ordinal)).Sum(p => p.Length));
        }).ToArray();
        return new("pending", state.Material.Id, state.Material.Name, state.Material.CreatedAt, files);
    }

    public void DiscardUpload(string root, string id, bool confirmed)
    {
        RequireDraftRoot(root); SafeFiles.Id(id);
        if (!confirmed) throw new VaultException("confirmation-required", "请先确认删除后不可恢复");
        if (List("draft").Items.Any(i => i.Id == id))
            throw new VaultException("upload-already-saved", "素材已经保存，请刷新草稿箱查看");
        var path = Path.Combine(Area("pending"), id); SafeFiles.RejectLinks(path);
        if (!Directory.Exists(path)) return;
        if (UploadDiscarded(id))
        {
            try { File.Delete(UploadStatePath(path)); Directory.Delete(path); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            activeUploads.Remove(id);
            return;
        }
        if (ReadUpload(path).Recording is not null) throw new VaultException("recording-upload", "录制请使用重试保存 MP4");
        RejectTreeLinks(path);
        // Keep the recovery record until all temporary content was deleted, so
        // an occupied/read-only part can be released and deletion retried.
        foreach (var directory in Directory.EnumerateDirectories(path)) Directory.Delete(directory, true);
        foreach (var file in Directory.EnumerateFiles(path).Where(f => f != UploadStatePath(path))) File.Delete(file);
        // A late retry from the original page must not recreate a discarded ID.
        SafeFiles.AtomicText(Path.Combine(Area("discarded-uploads"), id + ".json"), "{\"discarded\":true}");
        try { File.Delete(UploadStatePath(path)); Directory.Delete(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        activeUploads.Remove(id);
    }

    private bool UploadDiscarded(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) return false;
        var path = Path.Combine(Area("discarded-uploads"), SafeFiles.Id(id) + ".json");
        SafeFiles.RejectLinks(path);
        return File.Exists(path);
    }

    private void RequireUploadNotDiscarded(string id)
    {
        if (UploadDiscarded(id)) throw new VaultException("upload-discarded", "这次未完成保存已删除，请重新选择素材开始新保存");
    }

    private static void RejectTreeLinks(string directory)
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            SafeFiles.RejectLinks(path);
            if (Directory.Exists(path)) RejectTreeLinks(path);
        }
    }
}
