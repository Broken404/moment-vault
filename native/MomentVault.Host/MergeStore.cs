using System.Text.Json;

namespace MomentVault.Host;

public sealed partial class VaultStore
{
    public MergeResult Merge(string operationId, MergeSelection[] selection)
    {
        SafeFiles.Id(operationId);
        if (selection.Length is < 2 or > 200 || selection.Select(s => s.Id).Distinct().Count() != selection.Length)
            throw new VaultException("merge-not-created", "请选择 2–200 条不同的草稿");
        foreach (var source in selection) SafeFiles.Id(source.Id);
        var area = Area("merges");
        var lockPath = Path.Combine(area, ".lock"); SafeFiles.RejectLinks(lockPath);
        using var lease = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var journalPath = Path.Combine(area, operationId + ".json"); SafeFiles.RejectLinks(journalPath);
        if (File.Exists(journalPath))
        {
            var previous = Json.Read<MergeJournal>(File.ReadAllText(journalPath));
            if (previous.Id != operationId || !previous.Selection.SequenceEqual(selection))
                throw new VaultException("merge-conflict", "重试合并与原选择不同，请继续处理原合并");
            return FinishMerge(previous);
        }
        var staging = Path.Combine(area, operationId + ".staging");
        MergeJournal journal;
        try
        {
            if (List("draft").Items.Any(i => i.Id == operationId) || selection.Any(s => s.Id == operationId))
                throw new VaultException("merge-conflict", "合并标识已被使用，原素材保留");
            var sources = selection.Select(s =>
            {
                var directory = Find("draft", s.Id);
                var item = Description.Load(directory);
                if (item.Revision != s.Revision)
                    throw new VaultException("external-change", "草稿说明已改变，请刷新后重新选择");
                var hashes = SafeFiles.Snapshot(directory);
                var registered = item.Attachments.Select(a => a.FileName).Append(Description.FileName).ToHashSet(StringComparer.OrdinalIgnoreCase);
                if (hashes.Count != registered.Count || hashes.Keys.Any(k => !registered.Contains(k)) || Directory.EnumerateDirectories(directory).Any())
                    throw new VaultException("unregistered-files", "草稿中有未登记文件或文件夹，请先整理；原文件保留");
                foreach (var file in item.Attachments)
                {
                    var path = Path.Combine(directory, file.FileName);
                    if (!hashes.TryGetValue(file.FileName, out var hash) || hash != file.Sha256 || new FileInfo(path).Length != file.Bytes)
                        throw new VaultException("media-changed", "附件缺失或内容已改变，原素材保留");
                }
                return (Item: item, Source: new MergeSource(s.Id, s.Revision, directory, hashes));
            }).ToArray();
            if (sources.SelectMany(s => s.Item.Attachments).Select(a => a.Id).Distinct().Count() != sources.Sum(s => s.Item.Attachments.Count))
                throw new VaultException("duplicate-attachment", "所选草稿包含重复附件标识，原素材保留");
            var merged = new Material
            {
                Id = operationId, Name = $"{DateTime.Now:yyyyMMdd}-{(sources.All(s => s.Item.Attachments.All(a => a.Kind == "image")) ? "图片组" : "素材组")}",
                Note = string.Join("\n\n", sources.Where(s => s.Item.Note.Length > 0).Select(s => $"### {s.Item.Name}\n\n{s.Item.Note}")),
                MergedFrom = sources.Select(s => JsonSerializer.SerializeToElement(new
                {
                    s.Source.Id, s.Source.Revision, material = s.Item, note = s.Item.Note
                }, Json.Options)).ToList()
            };
            // Only this operation's private staging directory is reusable. No
            // source is removed until a verified target and journal both exist.
            SafeFiles.RejectLinks(staging);
            if (Directory.Exists(staging)) { _ = SafeFiles.Snapshot(staging); Directory.Delete(staging, true); }
            Directory.CreateDirectory(staging);
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Description.FileName };
            foreach (var source in sources)
                foreach (var original in source.Item.Attachments)
                {
                    var file = Json.Read<Attachment>(Json.Write(original));
                    var stem = Path.GetFileNameWithoutExtension(file.FileName); var extension = Path.GetExtension(file.FileName);
                    for (var number = 2; !names.Add(file.FileName); number++) file.FileName = $"{stem}-{number:000}{extension}";
                    var target = Path.Combine(staging, file.FileName);
                    File.Copy(Path.Combine(source.Source.Directory, original.FileName), target, false);
                    if (SafeFiles.Hash(target) != original.Sha256) throw new VaultException("copy-mismatch", "合并复制校验失败，原素材保留");
                    merged.Attachments.Add(file);
                }
            Description.Save(staging, merged);
            if (JsonSerializer.SerializeToUtf8Bytes(new { material = merged, note = merged.Note }, Json.Options).Length > 850_000)
                throw new VaultException("merge-too-large", "合并后的说明过大，请减少本次选择的条目");
            foreach (var source in sources)
                if (!SafeFiles.Same(source.Source.Hashes, SafeFiles.Snapshot(source.Source.Directory)))
                    throw new VaultException("source-changed", "复制期间原素材已改变，原数据保留");
            journal = new(operationId, selection, sources.Select(s => s.Source).ToArray(),
                SafeFiles.Available(Root("draft"), merged.Name), staging, SafeFiles.Snapshot(staging));
            SafeFiles.AtomicText(journalPath, Json.Write(journal));
        }
        catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException or JsonException)
        {
            // Before the journal is persisted nothing can have become visible.
            // Keep private staging for inspection/retry, and allow a new choice.
            if (File.Exists(journalPath)) throw;
            throw new VaultException("merge-not-created", ex.Message);
        }
        return FinishMerge(journal);
    }

    private MergeResult FinishMerge(MergeJournal journal)
    {
        var root = Root("draft");
        bool DirectChild(string path, string parent) => string.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), parent, StringComparison.OrdinalIgnoreCase);
        if (!DirectChild(journal.Target, root) || Path.GetFileName(journal.Target).StartsWith('.') ||
            !string.Equals(journal.Staging, Path.Combine(Area("merges"), journal.Id + ".staging"), StringComparison.OrdinalIgnoreCase) ||
            journal.Sources.Length != journal.Selection.Length ||
            journal.Sources.Where((s, i) => s.Id != journal.Selection[i].Id || s.Revision != journal.Selection[i].Revision).Any() ||
            journal.Sources.Any(s => !DirectChild(s.Directory, root) || Path.GetFileName(s.Directory).StartsWith('.') || string.Equals(s.Directory, journal.Target, StringComparison.OrdinalIgnoreCase)) ||
            journal.Sources.Select(s => s.Directory).Distinct(StringComparer.OrdinalIgnoreCase).Count() != journal.Sources.Length)
            throw new VaultException("invalid-journal", "合并记录不属于当前草稿箱，原数据保留");
        SafeFiles.RejectLinks(journal.Target); SafeFiles.RejectLinks(journal.Staging);
        if (!Directory.Exists(journal.Target) && Directory.Exists(journal.Staging))
        {
            if (!SafeFiles.Same(journal.TargetHashes, SafeFiles.Snapshot(journal.Staging)) ||
                journal.Sources.Any(s => !Directory.Exists(s.Directory) || !SafeFiles.Same(s.Hashes, SafeFiles.Snapshot(s.Directory))))
                throw new VaultException("merge-source-changed", "合并中断后文件已改变，原素材保留，请检查");
            Directory.Move(journal.Staging, journal.Target);
        }
        if (!Directory.Exists(journal.Target) || !SafeFiles.Same(journal.TargetHashes, SafeFiles.Snapshot(journal.Target)))
            throw new VaultException("merge-target-changed", "合并副本未完成或已改变，原素材保留，请检查");
        var item = Description.Load(journal.Target);
        if (item.Id != journal.Id) throw new VaultException("invalid-journal", "合并副本标识不匹配，原数据保留");
        var remaining = journal.Sources.Where(s => Directory.Exists(s.Directory)).ToArray();
        foreach (var source in remaining)
        {
            var description = Path.Combine(source.Directory, Description.FileName);
            if ((File.Exists(description) && Description.Load(source.Directory).Id != source.Id) ||
                SafeFiles.Snapshot(source.Directory).Any(p => !source.Hashes.TryGetValue(p.Key, out var hash) || hash != p.Value))
                return new("source-retained", item, remaining.Select(s => s.Id).ToArray(), "合并副本已保存，原文件已改变，保留原条目，请检查后重试");
        }
        var retained = new List<string>();
        foreach (var source in remaining)
        {
            try
            {
                var hashes = SafeFiles.Snapshot(source.Directory);
                if (hashes.Any(p => !source.Hashes.TryGetValue(p.Key, out var hash) || hash != p.Value) ||
                    hashes.Keys.Any(k => (File.GetAttributes(Path.Combine(source.Directory, k)) & FileAttributes.ReadOnly) != 0))
                { retained.Add(source.Id); continue; }
                Directory.Delete(source.Directory, true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { retained.Add(source.Id); }
        }
        // Keep the small receipt: a lost successful reply must never create a
        // second material, including after the native process has restarted.
        return new(retained.Count == 0 ? "merged" : "source-retained", item, retained.ToArray(),
            retained.Count == 0 ? null : "合并副本已保存，部分原条目暂未清理；解除占用或只读后重试");
    }
}
