using System.Diagnostics;
using System.Text.Json;

namespace MomentVault.Host;

public sealed partial class VaultStore : IDisposable
{
    private readonly string stateDirectory;
    private HostConfig config;
    private readonly HashSet<string> activeUploads = [];
    public VaultStore(string stateDirectory, RecordingMedia? recordingMedia = null)
    {
        this.recordingMedia = recordingMedia ?? RecordingMedia.Bundled();
        this.stateDirectory = Path.GetFullPath(stateDirectory);
        Directory.CreateDirectory(this.stateDirectory);
        SafeFiles.RejectLinks(this.stateDirectory);
        config = File.Exists(ConfigPath) ? Json.Read<HostConfig>(File.ReadAllText(ConfigPath)) : new();
    }

    private string ConfigPath => Path.Combine(stateDirectory, "config.json");
    public HostConfig Config => config;
    public void ReleaseUpload(string id)
    { if (!recordingJobs.ContainsKey(id)) activeUploads.Remove(id); }
    public bool Configured => !string.IsNullOrEmpty(config.DraftRoot) && !string.IsNullOrEmpty(config.LibraryRoot);

    public object Status()
    {
        var ready = false;
        var pending = 0;
        string? storageError = null;
        if (Configured)
        {
            try { _ = Root("draft"); _ = Root("library"); pending = PendingCount; ready = true; }
            catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException) { storageError = ex.Message; }
        }
        return new { protocol = Protocol.Version, version = "0.1.0", configured = ready, config, pendingUploads = pending, storageError,
            recordingToolsAvailable = recordingMedia.Available };
    }

    public void Configure(HostConfig next)
    {
        if (activeUploads.Count > 0 || recordingJobs.Count > 0)
            throw new VaultException("pending-operation", "有尚未完成的保存，请先重试完成后再更换目录");
        var draft = SafeFiles.Root(next.DraftRoot);
        var library = SafeFiles.Root(next.LibraryRoot);
        if (SafeFiles.Contains(draft, library) || SafeFiles.Contains(library, draft))
            throw new VaultException("overlapping-directories", "草稿箱与资产库不能相同或相互包含");
        Probe(draft); Probe(library);
        next = new(draft, library);
        SafeFiles.AtomicText(ConfigPath, Json.Write(next));
        config = next;
    }

    private static void Probe(string directory)
    {
        var file = Path.Combine(directory, ".moment-vault-probe-" + Guid.NewGuid().ToString("N"));
        try { File.WriteAllText(file, "Moment Vault directory check"); }
        finally { if (File.Exists(file)) File.Delete(file); }
    }

    private string PrivateRoot
    {
        get
        {
            if (!Configured) throw new VaultException("not-configured", "请先配置草稿箱与资产库");
            var root = SafeFiles.Root(config.DraftRoot);
            var path = Path.Combine(root, ".moment-vault");
            SafeFiles.RejectLinks(path);
            Directory.CreateDirectory(path);
            return path;
        }
    }
    private string Area(string name)
    {
        var path = Path.Combine(PrivateRoot, name);
        SafeFiles.RejectLinks(path);
        Directory.CreateDirectory(path);
        return path;
    }
    public int PendingCount
    {
        get
        {
            if (!Configured) return 0;
            var committed = List("draft").Items.Select(i => i.Id).ToHashSet();
            return Directory.EnumerateDirectories(Area("pending")).Count(d => !committed.Contains(Path.GetFileName(d)) && !UploadDiscarded(Path.GetFileName(d)));
        }
    }
    public string Root(string bucket) => bucket switch
    {
        "draft" when Configured => SafeFiles.Root(config.DraftRoot),
        "library" when Configured => SafeFiles.Root(config.LibraryRoot),
        "trash" when Configured => Area("recycle"),
        _ => throw new VaultException("not-configured", "请先配置有效的草稿箱与资产库")
    };

    public (List<Material> Items, List<string> Warnings) List(string bucket)
    {
        var directories = Directory.EnumerateDirectories(Root(bucket)).Where(d => !Path.GetFileName(d).StartsWith('.')).ToArray();
        var loaded = new Material?[directories.Length];
        var errors = new string?[directories.Length];
        // Bound file reads, rather than serially waiting on every newly opened
        // description. Each worker owns one slot; collection order stays stable.
        Parallel.ForEachAsync(Enumerable.Range(0, directories.Length), new ParallelOptions { MaxDegreeOfParallelism = 16 }, async (index, _) =>
        {
            try { loaded[index] = await Description.LoadAsync(directories[index]).ConfigureAwait(false); }
            catch (Exception ex) when (ex is IOException or VaultException or JsonException or UnauthorizedAccessException)
            { errors[index] = Path.GetFileName(directories[index]) + "：无法读取说明，原文件保留"; }
        }).GetAwaiter().GetResult();
        var items = loaded.OfType<Material>().ToList();
        var warnings = errors.OfType<string>().ToList();
        var duplicates = items.GroupBy(i => i.Id).Where(g => g.Count() > 1).ToList();
        foreach (var duplicate in duplicates)
        {
            warnings.Add("发现重复素材标识，相关文件夹保留，请先移出重复副本");
            items.RemoveAll(i => i.Id == duplicate.Key);
        }
        var sorted = items.OrderByDescending(i => i.CreatedAt).ToList();
        RememberThumbnailPaths(bucket, sorted);
        return (sorted, warnings);
    }

    public string Find(string bucket, string id)
    {
        SafeFiles.Id(id);
        var item = List(bucket).Items.SingleOrDefault(i => i.Id == id)
            ?? throw new VaultException("missing-item", "当前目录没有找到这条素材，请刷新列表");
        var path = Path.Combine(Root(bucket), item.FolderName);
        SafeFiles.RejectLinks(path);
        return path;
    }

    private string Pending(string id)
    {
        RequireUploadNotDiscarded(id);
        var path = Path.Combine(Area("pending"), SafeFiles.Id(id));
        SafeFiles.RejectLinks(path);
        if (!Directory.Exists(path)) throw new VaultException("missing-upload", "未完成的保存不存在");
        return path;
    }
    private static string UploadStatePath(string directory) => Path.Combine(directory, "upload.json");
    private static UploadState ReadUpload(string directory)
    {
        SafeFiles.RejectLinks(UploadStatePath(directory));
        var state = Json.Read<UploadState>(File.ReadAllText(UploadStatePath(directory)));
        state.Material.Note = state.Note;
        return state;
    }
    private static void WriteUpload(string directory, UploadState state)
    {
        state.Note = state.Material.Note;
        SafeFiles.AtomicText(UploadStatePath(directory), Json.Write(state));
    }

    public UploadState Begin(string name, FileUpload[] files, string note = "", string? requestedId = null,
        RecordingUpload? recording = null)
    {
        _ = Root("draft"); _ = Root("library");
        if (files.Length == 0 || files.Length > 200) throw new VaultException("invalid-files", "每次请选择 1–200 个素材文件");
        var state = new UploadState { Recording = recording, Inputs = files.ToList() };
        if (requestedId is not null) state.Material.Id = SafeFiles.Id(requestedId);
        RequireUploadNotDiscarded(state.Material.Id);
        state.Material.Name = SafeFiles.Name(string.IsNullOrWhiteSpace(name) ? $"{DateTime.Now:yyyyMMdd}-素材组" : name);
        state.Material.Note = note;
        var ids = new HashSet<string>();
        for (var index = 0; index < files.Length; index++)
        {
            var file = files[index];
            if (file.OriginalName.Length > 255 || file.Bytes is <= 0 || file.LastModified is < 0)
                throw new VaultException("invalid-files", "原文件信息无效");
            SafeFiles.Id(file.Id);
            if (!ids.Add(file.Id)) throw new VaultException("invalid-files", "附件标识重复");
            var extension = file.Extension.TrimStart('.').ToLowerInvariant();
            var allowed = file.Kind == "image" ? new[] { "png", "jpg", "jpeg", "webp", "gif" }
                : file.Kind == "video" ? ["mp4", "webm", "mov"] : Array.Empty<string>();
            if (!allowed.Contains(extension)) throw new VaultException("unsupported-file", "只接收 PNG、JPEG、WebP、GIF 或 MP4、WebM、MOV 文件");
            state.Material.Attachments.Add(new Attachment
            {
                Id = file.Id, FileName = $"{(file.Kind == "image" ? "图片" : "视频")}-{index + 1:000}.{extension}",
                Kind = file.Kind, Mime = file.Mime, Source = file.Source, Note = file.Note
            });
        }
        var directory = Path.Combine(Area("pending"), state.Material.Id);
        SafeFiles.RejectLinks(directory);
        var committed = List("draft").Items.SingleOrDefault(i => i.Id == state.Material.Id);
        if (committed is not null) return new() { Material = committed };
        if (Directory.Exists(directory))
        {
            var previous = ReadUpload(directory);
            if (previous.Material.Name != state.Material.Name || previous.Material.Attachments.Count != files.Length ||
                previous.Recording?.Selection != recording?.Selection ||
                !previous.Material.Attachments.Zip(state.Material.Attachments).All(pair => pair.First.Id == pair.Second.Id &&
                    (previous.Recording?.InputFileName ?? pair.First.FileName) == pair.Second.FileName && pair.First.Kind == pair.Second.Kind))
                throw new VaultException("upload-conflict", "重试保存与原输入不同，原内容保留");
            if (previous.Inputs.Count > 0 && !previous.Inputs.SequenceEqual(state.Inputs))
                throw new VaultException("upload-conflict", "重试保存与原文件信息不同，原内容保留");
            activeUploads.Add(previous.Material.Id);
            return previous;
        }
        Directory.CreateDirectory(directory);
        WriteUpload(directory, state);
        activeUploads.Add(state.Material.Id);
        return state;
    }

    public void Append(string uploadId, string attachmentId, int sequence, string base64)
    {
        if (sequence < 0 || sequence > 100000 || base64.Length > 350000)
            throw new VaultException("invalid-chunk", "文件分块无效或过大");
        var directory = Pending(uploadId);
        var state = ReadUpload(directory);
        if (!state.Material.Attachments.Any(a => a.Id == attachmentId)) throw new VaultException("invalid-chunk", "附件不属于此次保存");
        if (state.FinishedChunks.ContainsKey(attachmentId)) throw new VaultException("closed-upload", "附件已完成，不能继续追加");
        var bytes = Convert.FromBase64String(base64);
        if (bytes.Length == 0 || bytes.Length > 256 * 1024) throw new VaultException("invalid-chunk", "文件分块大小无效");
        var path = Path.Combine(directory, $"{SafeFiles.Id(attachmentId)}.{sequence:000000}.part");
        if (File.Exists(path))
        {
            if (!File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes)) throw new VaultException("chunk-conflict", "重试分块与已保存内容不一致");
            return;
        }
        if (sequence > 0 && !File.Exists(Path.Combine(directory, $"{attachmentId}.{sequence - 1:000000}.part")))
            throw new VaultException("chunk-order", "文件分块顺序不完整，请重试");
        // A crash or a full disk must not publish a truncated acknowledged part.
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { stream.Write(bytes); stream.Flush(true); }
            File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public void FinishFile(string uploadId, string attachmentId, int chunks, long bytes)
    {
        var directory = Pending(uploadId);
        var state = ReadUpload(directory);
        if (state.Recording is { Phase: not "capturing" })
            throw new VaultException("recording-processing", "录制已开始处理，原始文件不能再改变");
        var file = state.Material.Attachments.SingleOrDefault(a => a.Id == attachmentId)
            ?? throw new VaultException("missing-attachment", "附件不存在");
        if (chunks <= 0 || chunks > 100001 || bytes <= 0) throw new VaultException("empty-file", "没有收到完整文件");
        var input = state.Inputs.SingleOrDefault(i => i.Id == attachmentId);
        if (input?.Bytes is long expected && expected != bytes)
            throw new VaultException("file-mismatch", "文件大小与原文件不同，原分块保留，请重新选择原文件");
        var target = Path.Combine(directory, file.FileName);
        var temporary = target + ".assembling";
        try
        {
            using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                for (var i = 0; i < chunks; i++)
                {
                    using var part = File.OpenRead(Path.Combine(directory, $"{attachmentId}.{i:000000}.part"));
                    part.CopyTo(output);
                }
                output.Flush(true);
                if (output.Length != bytes) throw new VaultException("incomplete-file", "文件大小校验未通过，分块已保留");
            }
            File.Move(temporary, target, true);
            file.Bytes = bytes; file.Sha256 = SafeFiles.Hash(target);
            state.FinishedChunks[attachmentId] = chunks;
            state.ExpectedBytes[attachmentId] = bytes;
            WriteUpload(directory, state);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public Material Commit(string uploadId)
    {
        // Retry after a lost successful response returns the already committed item.
        var existing = List("draft").Items.SingleOrDefault(i => i.Id == uploadId);
        if (existing is not null) { activeUploads.Remove(uploadId); return existing; }
        var directory = Pending(uploadId);
        var state = ReadUpload(directory);
        if (state.Recording is not null && state.Recording.Phase != "ready")
            throw new VaultException("recording-not-ready", "录制尚未完成转码和检查，原片已保留");
        foreach (var file in state.Material.Attachments)
        {
            var path = Path.Combine(directory, file.FileName);
            if (!state.FinishedChunks.ContainsKey(file.Id) || !File.Exists(path) || new FileInfo(path).Length != file.Bytes || SafeFiles.Hash(path) != file.Sha256)
                throw new VaultException("incomplete-upload", "附件尚未完整保存，请重试");
        }
        Description.Save(directory, state.Material);
        var destination = SafeFiles.Available(Root("draft"), state.Material.Name);
        // Keep upload bookkeeping outside the visible item. Move only verified
        // media and description into a staging folder before atomic promotion.
        var ready = Path.Combine(directory, "ready");
        Directory.CreateDirectory(ready);
        foreach (var name in state.Material.Attachments.Select(a => a.FileName).Append(Description.FileName))
        {
            var source = Path.Combine(directory, name);
            var target = Path.Combine(ready, name);
            File.Copy(source, target, true);
            if (SafeFiles.Hash(source) != SafeFiles.Hash(target)) throw new VaultException("copy-mismatch", "保存校验失败，原始分块已保留");
        }
        Directory.Move(ready, destination);
        // A cleanup failure does not turn a committed material into a failed save.
        try { Directory.Delete(directory, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        activeUploads.Remove(uploadId);
        return Description.Load(destination);
    }

    public Material Update(string id, string revision, string name, string note, Dictionary<string, (string Source, string Note)> attachments)
    {
        var directory = Find("draft", id);
        var item = Description.Load(directory);
        if (item.Revision != revision) throw new VaultException("external-change", "说明已被其他程序修改，请刷新后再保存");
        item.Name = SafeFiles.Name(name); item.Note = note;
        foreach (var file in item.Attachments)
            if (attachments.TryGetValue(file.Id, out var edit)) { file.Source = edit.Source; file.Note = edit.Note; }
        Description.Save(directory, item, revision);
        if (!string.Equals(Path.GetFileName(directory), item.Name, StringComparison.Ordinal))
        {
            var target = SafeFiles.Available(Root("draft"), item.Name);
            Directory.Move(directory, target);
            directory = target;
        }
        return Description.Load(directory);
    }

    public TransferResult Transfer(string id, string from, string to)
    {
        if (!((from == "draft" && to is "library" or "trash") || (from == "trash" && to == "draft")))
            throw new VaultException("invalid-transfer", "不支持这项素材转移");
        var journalPath = Path.Combine(Area("transactions"), $"{SafeFiles.Id(id)}-{from}-{to}.json");
        if (File.Exists(journalPath)) return FinishTransfer(journalPath, Json.Read<TransferJournal>(File.ReadAllText(journalPath)));
        var source = Find(from, id);
        var sourceHashes = SafeFiles.Snapshot(source);
        if (List(to).Items.Any(i => i.Id == id)) throw new VaultException("duplicate-id", "目标目录已有同标识素材，原素材已保留");
        var target = SafeFiles.Available(Root(to), Path.GetFileName(source));
        var temporary = Path.Combine(Root(to), ".moment-vault-incoming-" + Guid.NewGuid().ToString("N"));
        SafeFiles.CopyVerified(source, temporary);
        if (to == "library")
        {
            var approved = Description.Load(temporary); approved.ApprovedAt = DateTimeOffset.Now;
            Description.Save(temporary, approved);
        }
        var targetHashes = SafeFiles.Snapshot(temporary);
        // Persist the destination before it becomes visible. A retry can finish
        // cleanup without creating a second library entry after a host restart.
        var journal = new TransferJournal(id, source, target, temporary, sourceHashes, targetHashes);
        SafeFiles.AtomicText(journalPath, Json.Write(journal));
        Directory.Move(temporary, target);
        return FinishTransfer(journalPath, journal);
    }

    private TransferResult FinishTransfer(string journalPath, TransferJournal journal)
    {
        // Journals live in the configured draft area; never trust an edited path
        // outside either root, even though it originated locally.
        var sourceParent = Path.GetDirectoryName(Path.GetFullPath(journal.Source));
        var targetParent = Path.GetDirectoryName(Path.GetFullPath(journal.Target));
        var sourceRoots = new[] { Root("draft"), Root("trash") };
        var targetRoots = new[] { Root("draft"), Root("trash"), Root("library") };
        if (!sourceRoots.Any(r => string.Equals(r, sourceParent, StringComparison.OrdinalIgnoreCase)) ||
            !targetRoots.Any(r => string.Equals(r, targetParent, StringComparison.OrdinalIgnoreCase)) ||
            string.Equals(journal.Source, journal.Target, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetDirectoryName(Path.GetFullPath(journal.Staging)), targetParent, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(journal.Staging).StartsWith(".moment-vault-incoming-", StringComparison.Ordinal))
            throw new VaultException("invalid-journal", "操作记录路径不属于当前目录，原数据保留");
        if (!Directory.Exists(journal.Target) && Directory.Exists(journal.Staging))
        {
            if (!SafeFiles.Same(journal.TargetHashes, SafeFiles.Snapshot(journal.Staging)))
                throw new VaultException("copy-mismatch", "中间副本校验失败，原数据保留");
            Directory.Move(journal.Staging, journal.Target);
        }
        if (!Directory.Exists(journal.Target) || !SafeFiles.Same(journal.TargetHashes, SafeFiles.Snapshot(journal.Target)))
            throw new VaultException("target-changed", "目标尚未完成或被外部修改，原素材已保留");
        if (Description.Load(journal.Target).Id != journal.Id)
            throw new VaultException("invalid-journal", "目标素材标识不匹配，原数据保留");
        if (Directory.Exists(journal.Source))
        {
            if (File.Exists(Path.Combine(journal.Source, Description.FileName)) && Description.Load(journal.Source).Id != journal.Id)
                throw new VaultException("invalid-journal", "来源素材标识不匹配，原数据保留");
            var remaining = SafeFiles.Snapshot(journal.Source);
            if (remaining.Any(pair => !journal.SourceHashes.TryGetValue(pair.Key, out var hash) || hash != pair.Value))
                return new(journal.Id, "copied-source-retained", "源文件被外部修改，保留两处内容，请检查");
            try
            {
                // Preflight common failures before recursive deletion can remove
                // the description. A later I/O failure may still leave a subset;
                // the persisted hashes above make that subset recoverable.
                if (remaining.Keys.Any(relative => (File.GetAttributes(Path.Combine(journal.Source, relative)) & FileAttributes.ReadOnly) != 0))
                    return new(journal.Id, "copied-source-retained", "目标完整，源包含只读文件；解除只读后可重试清理");
                Directory.Delete(journal.Source, true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            { return new(journal.Id, "copied-source-retained", "目标完整，源清理失败；可再次执行完成清理"); }
        }
        File.Delete(journalPath);
        return new(journal.Id, "moved");
    }

    public void Delete(string bucket, string id, bool confirmed)
    {
        if (!confirmed || bucket is not ("library" or "trash")) throw new VaultException("confirmation-required", "请先确认删除后不可恢复");
        var directory = Find(bucket, id);
        var item = Description.Load(directory);
        _ = SafeFiles.Snapshot(directory);
        Directory.Delete(directory, true);
        try { ForgetThumbnails(item); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or VaultException) { /* Disposable cache cleanup must not turn a completed deletion into a failed result. */ }
    }

    public void Open(string bucket, string? id, string? attachmentId)
    {
        var path = id is null ? Root(bucket) : Find(bucket, id);
        if (attachmentId is not null && id is not null)
        {
            var item = Description.Load(path);
            var file = item.Attachments.Single(a => a.Id == attachmentId);
            path = Path.Combine(path, file.FileName);
            var extension = Path.GetExtension(path).ToLowerInvariant();
            if (!new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov" }.Contains(extension))
                throw new VaultException("unsupported-file", "请在文件夹中检查此附件");
        }
        SafeFiles.RejectLinks(path);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }
}
