using System.Buffers.Binary;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using MomentVault.Host;

var failures = 0;
var testRoot = Path.Combine(Path.GetTempPath(), "moment-vault-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(testRoot);
var tests = new List<(string Name, Action Action)>
{
    ("reject equal and nested roots without altering configuration", () =>
    {
        var store = Store("roots");
        var previous = store.Config;
        Throws(() => store.Configure(new(previous.DraftRoot, previous.DraftRoot)), "overlapping-directories");
        var nested = Path.Combine(previous.DraftRoot, "nested"); Directory.CreateDirectory(nested);
        Throws(() => store.Configure(new(previous.DraftRoot, nested)), "overlapping-directories");
        Equal(store.Config, previous);
    }),
    ("a chunk retry is idempotent; a conflicting retry cannot corrupt original bytes", () =>
    {
        var store = Store("chunk"); var file = FileDescriptor(); var bytes = ImageBytes();
        var upload = store.Begin("图片", [file]);
        store.Append(upload.Material.Id, file.Id, 0, Convert.ToBase64String(bytes));
        store.Append(upload.Material.Id, file.Id, 0, Convert.ToBase64String(bytes));
        Throws(() => store.Append(upload.Material.Id, file.Id, 0, Convert.ToBase64String([1, 2, 3])), "chunk-conflict");
        store.FinishFile(upload.Material.Id, file.Id, 1, bytes.Length);
        var item = store.Commit(upload.Material.Id);
        True(File.ReadAllBytes(Path.Combine(store.Find("draft", item.Id), item.Attachments[0].FileName)).SequenceEqual(bytes));
        Equal(store.Commit(upload.Material.Id).Id, item.Id);
        Equal(store.List("draft").Items.Count, 1);
    }),
    ("missing storage does not disconnect the helper or prevent directory repair", () =>
    {
        var store = Store("repair");
        Directory.Move(store.Config.DraftRoot, store.Config.DraftRoot + "-moved");
        using var status = JsonDocument.Parse(MomentVault.Host.Json.Write(store.Status()));
        True(!status.RootElement.GetProperty("configured").GetBoolean());
        True(status.RootElement.GetProperty("storageError").GetString()!.Length > 0);
        var repaired = store.Config.DraftRoot + "-new"; Directory.CreateDirectory(repaired);
        store.Configure(new(repaired, store.Config.LibraryRoot));
        Equal(store.Config.DraftRoot, repaired);
    }),
    ("incomplete or out-of-order uploads never become visible materials", () =>
    {
        var store = Store("incomplete"); var file = FileDescriptor();
        var upload = store.Begin("未完成", [file]);
        Throws(() => store.Append(upload.Material.Id, file.Id, 1, "AQID"), "chunk-order");
        Throws(() => store.Commit(upload.Material.Id), "incomplete-upload");
        Equal(store.List("draft").Items.Count, 0);
        Equal(store.PendingCount, 1);
    }),
    ("description edits detect external changes and preserve unknown fields", () =>
    {
        var store = Store("external"); var item = Save(store);
        var directory = store.Find("draft", item.Id);
        item.Extra = new() { ["customField"] = JsonSerializer.SerializeToElement(new { owner = "user" }) };
        Description.Save(directory, item);
        var loaded = Description.Load(directory);
        store.Update(item.Id, loaded.Revision, "新名字", "共同说明", []);
        directory = store.Find("draft", item.Id); loaded = Description.Load(directory);
        Equal(loaded.Extra!["customField"].GetProperty("owner").GetString(), "user");
        File.AppendAllText(Path.Combine(directory, Description.FileName), "\n外部编辑\n");
        Throws(() => store.Update(item.Id, loaded.Revision, "覆盖", "丢失", []), "external-change");
        True(File.ReadAllText(Path.Combine(directory, Description.FileName)).Contains("外部编辑"));
    }),
    ("promote, recycle and restore keep actual media bytes intact", () =>
    {
        var store = Store("move"); var item = Save(store);
        var expected = item.Attachments[0].Sha256;
        Equal(store.Transfer(item.Id, "draft", "trash").Status, "moved");
        Equal(store.List("draft").Items.Count, 0);
        Equal(store.Transfer(item.Id, "trash", "draft").Status, "moved");
        Equal(store.Transfer(item.Id, "draft", "library").Status, "moved");
        var path = store.Find("library", item.Id); var actual = Description.Load(path);
        Equal(SafeFiles.Hash(Path.Combine(path, actual.Attachments[0].FileName)), expected);
        True(actual.ApprovedAt is not null);
        Throws(() => store.Transfer(item.Id, "library", "draft"), "invalid-transfer");
    }),
    ("source cleanup failure is recoverable after restart without duplicate target", () =>
    {
        var store = Store("cleanup"); var item = Save(store); var source = store.Find("draft", item.Id);
        var media = Path.Combine(source, item.Attachments[0].FileName);
        File.SetAttributes(media, FileAttributes.ReadOnly);
        var result = store.Transfer(item.Id, "draft", "library");
        Equal(result.Status, "copied-source-retained");
        True(Directory.Exists(source));
        File.SetAttributes(media, FileAttributes.Normal);
        // Emulate an interrupted recursive cleanup after a prior successful copy.
        File.Delete(Path.Combine(source, Description.FileName));
        var restarted = new VaultStore(Path.Combine(testRoot, "cleanup", "state"));
        Equal(restarted.Transfer(item.Id, "draft", "library").Status, "moved");
        Equal(restarted.List("library").Items.Count, 1);
        True(!Directory.Exists(source));
    }),
    ("modified target cannot cause source cleanup on retry", () =>
    {
        var store = Store("corruption"); var item = Save(store); var source = store.Find("draft", item.Id);
        var media = Path.Combine(source, item.Attachments[0].FileName);
        File.SetAttributes(media, FileAttributes.ReadOnly);
        Equal(store.Transfer(item.Id, "draft", "library").Status, "copied-source-retained");
        File.SetAttributes(media, FileAttributes.Normal);
        var copied = Path.Combine(store.Find("library", item.Id), item.Attachments[0].FileName);
        File.SetAttributes(copied, FileAttributes.Normal); File.AppendAllText(copied, "broken");
        Throws(() => store.Transfer(item.Id, "draft", "library"), "target-changed");
        True(File.Exists(media));
    }),
    ("permanent delete requires explicit confirmation and a library or trash item", () =>
    {
        var store = Store("delete"); var item = Save(store);
        Throws(() => store.Delete("draft", item.Id, true), "confirmation-required");
        store.Transfer(item.Id, "draft", "library");
        Throws(() => store.Delete("library", item.Id, false), "confirmation-required");
        store.Delete("library", item.Id, true);
        Equal(store.List("library").Items.Count, 0);
        Throws(() => store.Find("draft", "../escape"), "invalid-id");
    }),
    ("folder picks require the browser owner and keep the protocol usable after rejection", () =>
    {
        var store = Store("folder-owner");
        using var input = new MemoryStream(); using var output = new MemoryStream();
        Frame(input, "draft", "folder.pick", new { title = "选择草稿箱", parentWindow = 123 });
        Frame(input, "library", "folder.pick", new { title = "选择资产库" });
        Frame(input, "still-connected", "ping", new { });
        input.Position = 0; Protocol.Run(input, output, store); output.Position = 0;
        using var first = ReadFrame(output); using var second = ReadFrame(output); using var third = ReadFrame(output);
        Equal(first.RootElement.GetProperty("error").GetProperty("code").GetString(), "folder-picker-owner");
        Equal(second.RootElement.GetProperty("error").GetProperty("code").GetString(), "folder-picker-owner");
        Equal(third.RootElement.GetProperty("id").GetString(), "still-connected");
        True(third.RootElement.GetProperty("ok").GetBoolean());
        Equal(output.Position, output.Length);
    }),
    ("browser owner is parsed from the native invocation rather than a request payload", () =>
    {
        Equal(MomentVault.Host.Program.ParentWindow(["chrome-extension://example/", "--parent-window=12345"]), (nint)12345);
        Equal(MomentVault.Host.Program.ParentWindow(["--parent-window=0"]), (nint)0);
        Equal(MomentVault.Host.Program.ParentWindow(["--parent-window=not-a-number"]), (nint)0);
        Equal(MomentVault.Host.Program.ParentWindow(["--parent-window=-1"]), (nint)0);
        Equal(MomentVault.Host.Program.ParentWindow(["--parent-window=9999999999999999999999"]), (nint)0);
        Equal(MomentVault.Host.Program.ParentWindow([]), (nint)0);
    }),
    ("recordings cannot publish intermediate WebM and preserve capture when tools are missing", () =>
    {
        var store = Store("recording", new RecordingMedia(Path.Combine(testRoot, "missing-ffmpeg.exe"), Path.Combine(testRoot, "missing-ffprobe.exe")));
        var fileId = Guid.NewGuid().ToString("N");
        Throws(() => store.BeginRecording("无效", fileId, "self-made", new(4, 2)), "invalid-recording-range");
        var upload = store.BeginRecording("录制", fileId, "self-made", new(2, 12), "录制备注");
        store.Append(upload.Material.Id, fileId, 0, "AQID");
        store.FinishFile(upload.Material.Id, fileId, 1, 3);
        Throws(() => store.Commit(upload.Material.Id), "recording-not-ready");
        Throws(() => store.ProcessRecording(upload.Material.Id, new(2, 4, "manual-shortcut")), "media-tools-missing");
        Equal(store.List("draft").Items.Count, 0);
        Equal(store.PendingCount, 1);
        var pending = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", upload.Material.Id);
        True(File.ReadAllBytes(Path.Combine(pending, "视频-001.webm")).SequenceEqual(new byte[] { 1, 2, 3 }));
        using var recovered = new VaultStore(Path.Combine(testRoot, "recording", "state"));
        Equal(recovered.RecordingStatus(upload.Material.Id).Phase, "failed");
    }),
    ("an interrupted recording job is recoverable and never becomes a listed draft", () =>
    {
        var store = Store("recording-interrupted");
        var upload = store.BeginRecording("录制", Guid.NewGuid().ToString("N"), "self-made", new(2, 12));
        var path = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", upload.Material.Id, "upload.json");
        var state = MomentVault.Host.Json.Read<UploadState>(File.ReadAllText(path));
        state.Recording!.Phase = "processing";
        File.WriteAllText(path, MomentVault.Host.Json.Write(state));
        using var recovered = new VaultStore(Path.Combine(testRoot, "recording-interrupted", "state"));
        Equal(recovered.RecordingStatus(upload.Material.Id).Phase, "failed");
        Equal(recovered.List("draft").Items.Count, 0);
        Equal(recovered.PendingCount, 1);
    }),
    ("initial notes survive pending upload bookkeeping and commit", () =>
    {
        var store = Store("initial-notes");
        Equal(Save(store).Note, "原有备注");
    }),
    ("merge groups mixed attachments in request order and preserves identities, metadata and bytes", () =>
    {
        var store = Store("merge-mixed"); var a = Save(store);
        var b = SaveFiles(store, "第二组", [(new(Guid.NewGuid().ToString("N"), "mp4", "video", "video/mp4", "https://example.com/video", "视频备注"), new byte[] { 1, 2, 3 }), (FileDescriptor(), ImageBytes())]);
        var bPath = store.Find("draft", b.Id);
        b.Note = "第二组共同说明\n保留换行";
        b.Attachments[0].Range = JsonSerializer.SerializeToElement(new { a = 2, b = 8, actualStart = 2, actualEnd = 7.5 });
        b.Attachments[0].Extra = new() { ["customAttachment"] = JsonSerializer.SerializeToElement("kept") };
        b.Extra = new() { ["customMaterial"] = JsonSerializer.SerializeToElement("original") };
        Description.Save(bPath, b); b = Description.Load(bPath);
        var expected = b.Attachments.Concat(a.Attachments).ToArray();
        var operation = Guid.NewGuid().ToString("N"); MergeSelection[] selection = [new(b.Id, b.Revision), new(a.Id, a.Revision)];
        var result = store.Merge(operation, selection); var merged = result.Item;
        Equal(result.Status, "merged"); Equal(merged.Id, operation); Equal(merged.ApprovedAt, null);
        Equal(store.List("draft").Items.Count, 1); Equal(store.List("library").Items.Count, 0);
        True(!Directory.Exists(bPath)); Equal(merged.Attachments.Count, 3);
        True(merged.Attachments.Select(f => f.Id).SequenceEqual(expected.Select(f => f.Id)));
        Equal(merged.Attachments.Select(f => f.FileName).Distinct(StringComparer.OrdinalIgnoreCase).Count(), 3);
        foreach (var (actual, original) in merged.Attachments.Zip(expected))
        {
            Equal(actual.Source, original.Source); Equal(actual.Note, original.Note); Equal(actual.CollectedAt, original.CollectedAt);
            Equal(actual.Sha256, original.Sha256); Equal(actual.Bytes, original.Bytes);
            Equal(SafeFiles.Hash(Path.Combine(store.Find("draft", merged.Id), actual.FileName)), original.Sha256);
        }
        Equal(merged.Attachments[0].Range!.Value.GetProperty("actualEnd").GetDouble(), 7.5);
        Equal(merged.Attachments[0].Extra!["customAttachment"].GetString(), "kept");
        Equal(merged.MergedFrom![0].GetProperty("material").GetProperty("customMaterial").GetString(), "original");
        Equal(merged.MergedFrom[0].GetProperty("note").GetString(), b.Note);
        True(merged.Note.Contains("第二组共同说明\n保留换行") && merged.Note.Contains(a.Note));
        using var restarted = new VaultStore(Path.Combine(testRoot, "merge-mixed", "state"));
        Equal(restarted.Merge(operation, selection).Item.Id, merged.Id); Equal(restarted.List("draft").Items.Count, 1);
        Throws(() => restarted.Merge(operation, selection.Reverse().ToArray()), "merge-conflict");
        var third = Save(restarted);
        var nested = restarted.Merge(Guid.NewGuid().ToString("N"), [new(merged.Id, merged.Revision), new(third.Id, third.Revision)]).Item;
        Equal(nested.Attachments.Count, 4);
        True(nested.Attachments.Take(3).Select(f => f.Id).SequenceEqual(expected.Select(f => f.Id)));
        Equal(nested.MergedFrom![0].GetProperty("material").GetProperty("mergedFrom").GetArrayLength(), 2);
    }),
    ("merge rejects stale descriptions, changed bytes and unregistered files before removing sources", () =>
    {
        var store = Store("merge-validation"); var a = Save(store); var b = Save(store);
        var path = store.Find("draft", a.Id); var original = File.ReadAllText(Path.Combine(path, Description.FileName));
        MergeSelection[] selection = [new(a.Id, a.Revision), new(b.Id, b.Revision)];
        File.AppendAllText(Path.Combine(path, Description.FileName), "\nexternal edit");
        Throws(() => store.Merge(Guid.NewGuid().ToString("N"), selection), "merge-not-created");
        True(File.ReadAllText(Path.Combine(path, Description.FileName)).Contains("external edit"));
        File.WriteAllText(Path.Combine(path, Description.FileName), original);
        File.WriteAllText(Path.Combine(path, "unregistered.txt"), "must not be lost");
        Throws(() => store.Merge(Guid.NewGuid().ToString("N"), selection), "merge-not-created");
        True(File.Exists(Path.Combine(path, "unregistered.txt"))); File.Delete(Path.Combine(path, "unregistered.txt"));
        File.AppendAllText(Path.Combine(path, a.Attachments[0].FileName), "modified");
        Throws(() => store.Merge(Guid.NewGuid().ToString("N"), selection), "merge-not-created");
        Equal(store.List("draft").Items.Count, 2); Equal(store.List("library").Items.Count, 0);
    }),
    ("merge rejects duplicate attachment identities and library sources", () =>
    {
        var store = Store("merge-identities"); var a = Save(store); var b = Save(store);
        var path = store.Find("draft", b.Id); b.Attachments[0].Id = a.Attachments[0].Id;
        Description.Save(path, b); b = Description.Load(path);
        Throws(() => store.Merge(Guid.NewGuid().ToString("N"), [new(a.Id, a.Revision), new(b.Id, b.Revision)]), "merge-not-created");
        Equal(store.List("draft").Items.Count, 2);
        store.Transfer(b.Id, "draft", "library");
        Throws(() => store.Merge(Guid.NewGuid().ToString("N"), [new(a.Id, a.Revision), new(b.Id, b.Revision)]), "merge-not-created");
        Equal(store.List("draft").Items.Count, 1); Equal(store.List("library").Items.Count, 1);
    }),
    ("merge cleanup can resume after restart and partial source cleanup without duplicating the result", () =>
    {
        var store = Store("merge-cleanup"); var a = Save(store); var b = Save(store);
        var source = store.Find("draft", a.Id); var media = Path.Combine(source, a.Attachments[0].FileName);
        File.SetAttributes(media, FileAttributes.ReadOnly);
        var operation = Guid.NewGuid().ToString("N"); MergeSelection[] selection = [new(a.Id, a.Revision), new(b.Id, b.Revision)];
        var first = store.Merge(operation, selection); Equal(first.Status, "source-retained");
        True(first.RetainedSourceIds.SequenceEqual(new[] { a.Id })); True(Directory.Exists(source));
        File.SetAttributes(media, FileAttributes.Normal); File.Delete(Path.Combine(source, Description.FileName));
        using var restarted = new VaultStore(Path.Combine(testRoot, "merge-cleanup", "state"));
        Equal(restarted.Merge(operation, selection).Status, "merged");
        True(!Directory.Exists(source)); Equal(restarted.List("draft").Items.Count, 1);
    }),
    ("changed merged target prevents original cleanup on retry", () =>
    {
        var store = Store("merge-target-changed"); var a = Save(store); var b = Save(store);
        var source = store.Find("draft", a.Id); var media = Path.Combine(source, a.Attachments[0].FileName);
        File.SetAttributes(media, FileAttributes.ReadOnly);
        var operation = Guid.NewGuid().ToString("N"); MergeSelection[] selection = [new(a.Id, a.Revision), new(b.Id, b.Revision)];
        var first = store.Merge(operation, selection); File.SetAttributes(media, FileAttributes.Normal);
        var target = Path.Combine(store.Find("draft", first.Item.Id), first.Item.Attachments[0].FileName);
        File.SetAttributes(target, FileAttributes.Normal); File.AppendAllText(target, "corrupted");
        Throws(() => store.Merge(operation, selection), "merge-target-changed"); True(File.Exists(media));
    }),
    ("merge journal resumes publication and rejects an unrelated cleanup path", () =>
    {
        var store = Store("merge-publication"); var a = Save(store); var b = Save(store);
        var source = store.Find("draft", a.Id); var media = Path.Combine(source, a.Attachments[0].FileName);
        File.SetAttributes(media, FileAttributes.ReadOnly);
        var operation = Guid.NewGuid().ToString("N"); MergeSelection[] selection = [new(a.Id, a.Revision), new(b.Id, b.Revision)];
        store.Merge(operation, selection);
        var journalPath = Path.Combine(store.Config.DraftRoot, ".moment-vault", "merges", operation + ".json");
        var journal = MomentVault.Host.Json.Read<MergeJournal>(File.ReadAllText(journalPath));
        // Recreate the before-publication interruption while keeping both sources.
        var other = journal.Sources[1]; Directory.CreateDirectory(other.Directory);
        foreach (var file in b.Attachments) File.Copy(Path.Combine(journal.Target, Description.Load(journal.Target).Attachments.Single(a => a.Id == file.Id).FileName), Path.Combine(other.Directory, file.FileName));
        Description.Save(other.Directory, b);
        Directory.Move(journal.Target, journal.Staging); File.SetAttributes(media, FileAttributes.Normal);
        Equal(store.Merge(operation, selection).Status, "merged"); Equal(store.List("draft").Items.Count, 1);
        var outside = Path.Combine(testRoot, "must-keep"); Directory.CreateDirectory(outside); File.WriteAllText(Path.Combine(outside, "important.txt"), "keep");
        var invalid = journal with { Sources = [journal.Sources[0] with { Directory = outside }, journal.Sources[1]] };
        File.WriteAllText(journalPath, MomentVault.Host.Json.Write(invalid));
        Throws(() => store.Merge(operation, selection), "invalid-journal"); True(File.Exists(Path.Combine(outside, "important.txt")));
    }),
    ("framed merge protocol returns one material and keeps a lost-response retry idempotent", () =>
    {
        var store = Store("merge-protocol"); var a = Save(store); var b = Save(store);
        using var input = new MemoryStream(); using var output = new MemoryStream();
        var payload = new { operationId = Guid.NewGuid().ToString("N"), draftRoot = store.Config.DraftRoot, selection = new[] { new MergeSelection(a.Id, a.Revision), new MergeSelection(b.Id, b.Revision) } };
        Frame(input, "merge", "items.merge", payload); Frame(input, "retry", "items.merge", payload);
        input.Position = 0; Protocol.Run(input, output, store); output.Position = 0;
        using var first = ReadFrame(output); using var second = ReadFrame(output);
        True(first.RootElement.GetProperty("ok").GetBoolean()); True(second.RootElement.GetProperty("ok").GetBoolean());
        Equal(first.RootElement.GetProperty("result").GetProperty("status").GetString(), "merged");
        Equal(second.RootElement.GetProperty("result").GetProperty("item").GetProperty("id").GetString(), payload.operationId);
        Equal(store.List("draft").Items.Count, 1);
    }),
    ("interrupted mixed uploads recover after restart with metadata, prefix verification and one result", () =>
    {
        using var store = Store("upload-recovery");
        var bytes = ImageBytes(); var large = Enumerable.Repeat((byte)17, 250000).ToArray();
        var first = FileDescriptor() with { OriginalName = "finished.png", Bytes = bytes.Length, LastModified = 123 };
        var second = FileDescriptor() with { OriginalName = "remaining.png", Bytes = large.Length, LastModified = 124 };
        var upload = store.Begin("原素材", [first, second], "原备注"); var id = upload.Material.Id;
        store.Append(id, first.Id, 0, Convert.ToBase64String(bytes)); store.FinishFile(id, first.Id, 1, bytes.Length);
        store.Append(id, second.Id, 0, Convert.ToBase64String(large[..196608]));
        using var restarted = new VaultStore(Path.Combine(testRoot, "upload-recovery", "state"));
        var jobs = restarted.IncompleteUploads(store.Config.DraftRoot, 0); Equal(jobs.Total, 1);
        Equal(jobs.Items[0].CompleteFiles, 1); Equal(jobs.Items[0].ReceivedBytes, (long)bytes.Length + 196608);
        var progress = restarted.GetUpload(store.Config.DraftRoot, id);
        Equal(progress.Files[1].OriginalName, "remaining.png"); Equal(progress.Files[1].Bytes, (long?)250000);
        var pending = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", id);
        var before = SafeFiles.Snapshot(pending);
        Throws(() => restarted.Append(id, second.Id, 0, Convert.ToBase64String([99, 100])), "chunk-conflict");
        True(SafeFiles.Same(before, SafeFiles.Snapshot(pending)));
        restarted.Append(id, second.Id, 0, Convert.ToBase64String(large[..196608]));
        restarted.Append(id, second.Id, 1, Convert.ToBase64String(large[196608..]));
        Throws(() => restarted.FinishFile(id, second.Id, 2, large.Length - 1), "file-mismatch");
        restarted.FinishFile(id, second.Id, 2, large.Length);
        var saved = restarted.Commit(id); Equal(saved.Id, id); Equal(saved.Note, "原备注"); Equal(saved.Name, "原素材");
        Equal(saved.Attachments[0].Source, first.Source); Equal(saved.Attachments[1].Note, second.Note);
        True(File.ReadAllBytes(Path.Combine(restarted.Find("draft", id), saved.Attachments[1].FileName)).SequenceEqual(large));
        Equal(restarted.Commit(id).Id, id); Equal(restarted.List("draft").Items.Count, 1);
        Equal(restarted.IncompleteUploads(store.Config.DraftRoot, 0).Total, 0);
    }),
    ("a failed finish record write retains replayable parts across restart", () =>
    {
        using var store = Store("finish-interrupted"); var bytes = ImageBytes();
        var file = FileDescriptor() with { OriginalName = "original.png", Bytes = bytes.Length };
        var upload = store.Begin("未完成写入", [file]); var id = upload.Material.Id;
        store.Append(id, file.Id, 0, Convert.ToBase64String(bytes));
        var pending = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", id);
        var record = Path.Combine(pending, "upload.json"); File.SetAttributes(record, FileAttributes.ReadOnly);
        var failed = false;
        try { store.FinishFile(id, file.Id, 1, bytes.Length); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { failed = true; }
        True(failed); File.SetAttributes(record, FileAttributes.Normal);
        using var restarted = new VaultStore(Path.Combine(testRoot, "finish-interrupted", "state"));
        True(!restarted.GetUpload(store.Config.DraftRoot, id).Files[0].Complete);
        restarted.Append(id, file.Id, 0, Convert.ToBase64String(bytes));
        restarted.FinishFile(id, file.Id, 1, bytes.Length);
        True(restarted.GetUpload(store.Config.DraftRoot, id).Files[0].Complete);
        Equal(restarted.Commit(id).Id, id);
    }),
    ("lost final replies and retained cleanup records return the already saved item", () =>
    {
        using var store = Store("upload-lost-reply"); var file = FileDescriptor(); var bytes = ImageBytes();
        var upload = store.Begin("已收到", [file]); var id = upload.Material.Id;
        store.Append(id, file.Id, 0, Convert.ToBase64String(bytes)); store.FinishFile(id, file.Id, 1, bytes.Length);
        var record = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", id, "upload.json");
        File.SetAttributes(record, FileAttributes.ReadOnly);
        var item = store.Commit(id);
        using var restarted = new VaultStore(Path.Combine(testRoot, "upload-lost-reply", "state"));
        Equal(restarted.GetUpload(store.Config.DraftRoot, id).Phase, "saved");
        Equal(restarted.IncompleteUploads(store.Config.DraftRoot, 0).Total, 0);
        using var input = new MemoryStream(); using var output = new MemoryStream();
        Frame(input, "retry", "items.begin", new { uploadId = id, draftRoot = store.Config.DraftRoot, name = "已收到", files = new[] { file } });
        input.Position = 0; Protocol.Run(input, output, restarted); output.Position = 0;
        using var reply = ReadFrame(output);
        True(reply.RootElement.GetProperty("ok").GetBoolean());
        Equal(reply.RootElement.GetProperty("result").GetProperty("recovery").GetProperty("phase").GetString(), "saved");
        Equal(restarted.List("draft").Items.Count, 1); Equal(item.Id, id);
        File.SetAttributes(record, FileAttributes.Normal);
    }),
    ("discard requires confirmation and an occupied part leaves its recovery record retryable", () =>
    {
        using var store = Store("upload-discard"); var item = Save(store); var directory = store.Find("draft", item.Id);
        var before = SafeFiles.Snapshot(directory); var file = FileDescriptor(); var upload = store.Begin("不要的暂存", [file]);
        var id = upload.Material.Id; store.Append(id, file.Id, 0, "AQID");
        Throws(() => store.DiscardUpload(store.Config.DraftRoot, id, false), "confirmation-required");
        var pending = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", id);
        var part = Path.Combine(pending, file.Id + ".000000.part"); File.SetAttributes(part, FileAttributes.ReadOnly);
        var failed = false;
        try { store.DiscardUpload(store.Config.DraftRoot, id, true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { failed = true; }
        True(failed); True(File.Exists(Path.Combine(pending, "upload.json")));
        File.SetAttributes(part, FileAttributes.Normal); store.DiscardUpload(store.Config.DraftRoot, id, true);
        store.DiscardUpload(store.Config.DraftRoot, id, true); True(!Directory.Exists(pending));
        Throws(() => store.Begin("不要的暂存", [file], requestedId: id), "upload-discarded");
        Throws(() => store.DiscardUpload(store.Config.DraftRoot, item.Id, true), "upload-already-saved");
        True(SafeFiles.Same(before, SafeFiles.Snapshot(directory)));
    }),
    ("stale directory requests cannot resume, publish or delete another root's pending upload", () =>
    {
        using var store = Store("upload-root"); var root = store.Config.DraftRoot; var file = FileDescriptor();
        var upload = store.Begin("原目录", [file]); var id = upload.Material.Id; store.Append(id, file.Id, 0, "AQID");
        using var restarted = new VaultStore(Path.Combine(testRoot, "upload-root", "state"));
        var next = root + "-next"; Directory.CreateDirectory(next); restarted.Configure(new(next, store.Config.LibraryRoot));
        Throws(() => restarted.GetUpload(root, id), "upload-directory-changed");
        Throws(() => restarted.DiscardUpload(root, id, true), "upload-directory-changed");
        Equal(restarted.IncompleteUploads(next, 0).Total, 0);
        using var input = new MemoryStream(); using var output = new MemoryStream();
        Frame(input, "stale", "items.commit", new { draftRoot = root, uploadId = id });
        input.Position = 0; Protocol.Run(input, output, restarted); output.Position = 0;
        using var reply = ReadFrame(output); Equal(reply.RootElement.GetProperty("error").GetProperty("code").GetString(), "upload-directory-changed");
        True(File.Exists(Path.Combine(root, ".moment-vault", "pending", id, file.Id + ".000000.part")));
    }),
    ("legacy uploads remain recoverable while recordings and unreadable records are handled separately", () =>
    {
        using var store = Store("legacy-upload"); var file = FileDescriptor(); var bytes = ImageBytes(); var upload = store.Begin("旧任务", [file]);
        var id = upload.Material.Id; store.Append(id, file.Id, 0, Convert.ToBase64String(bytes));
        var pendingRoot = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending");
        var path = Path.Combine(pendingRoot, id, "upload.json");
        var state = MomentVault.Host.Json.Read<UploadState>(File.ReadAllText(path)); state.Inputs.Clear();
        File.WriteAllText(path, MomentVault.Host.Json.Write(state));
        _ = store.BeginRecording("录制", Guid.NewGuid().ToString("N"), "self-made", new(0, 2));
        var broken = Path.Combine(pendingRoot, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(broken);
        File.WriteAllText(Path.Combine(broken, "upload.json"), "incomplete-json");
        var listed = store.IncompleteUploads(store.Config.DraftRoot, 0); Equal(listed.Total, 1); Equal(listed.Warnings.Length, 1);
        var legacy = store.GetUpload(store.Config.DraftRoot, id); Equal(legacy.Files[0].OriginalName, ""); Equal(legacy.Files[0].Bytes, null);
        store.Append(id, file.Id, 0, Convert.ToBase64String(bytes)); store.FinishFile(id, file.Id, 1, bytes.Length);
        Equal(store.Commit(id).Id, id); True(Directory.Exists(broken));
    }),
    ("thumbnail work reports missing tools without altering sources or blocking protocol calls", () =>
    {
        using var store = Store("thumbnail-missing-tools", new RecordingMedia(Path.Combine(testRoot, "missing-ffmpeg.exe"), Path.Combine(testRoot, "missing-ffprobe.exe")));
        var item = Save(store); var directory = store.Find("draft", item.Id); var before = SafeFiles.Snapshot(directory);
        Equal(store.Thumbnail("draft", item.Id, item.Attachments[0].Id).Phase, "loading");
        _ = store.Status();
        True(SpinWait.SpinUntil(() => store.Thumbnail("draft", item.Id, item.Attachments[0].Id).Phase == "unavailable", 5000));
        True(SafeFiles.Same(before, SafeFiles.Snapshot(directory)));
        Equal(store.Thumbnail("draft", item.Id, item.Attachments[0].Id).Phase, "unavailable");
    }),
    ("thumbnail requests cannot choose paths or read another bucket attachment", () =>
    {
        using var store = Store("thumbnail-scope"); var item = Save(store);
        Throws(() => store.Thumbnail("draft", item.Id, "../escape"), "invalid-id");
        Throws(() => store.Thumbnail("draft", item.Id, Guid.NewGuid().ToString("N")), "missing-attachment");
        Throws(() => store.Thumbnail("library", item.Id, item.Attachments[0].Id), "missing-item");
        Equal(store.List("draft").Items.Count, 1);
    }),
    ("chunked reads reject a changed source and can restart with its current bytes", () =>
    {
        using var store = Store("read-source-change"); var bytes = LargeImageBytes(42);
        var item = SaveFiles(store, "large source", [(FileDescriptor(), bytes)]); var attachment = item.Attachments[0];
        var first = ReadBytes(store, "draft", item, 0); True(first.Length == 192 * 1024);
        True(first.SequenceEqual(bytes.Take(first.Length)));
        var directory = store.Find("draft", item.Id); var media = Path.Combine(directory, attachment.FileName);
        var stamp = File.GetLastWriteTimeUtc(media); var changed = (byte[])bytes.Clone(); changed[first.Length] ^= 1;
        File.WriteAllBytes(media, changed); File.SetLastWriteTimeUtc(media, stamp.AddSeconds(1));
        Throws(() => store.ReadFile("draft", item.Id, attachment.Id, first.Length), "read-changed");
        var reopened = ReadAllBytes(store, "draft", item); True(reopened.SequenceEqual(changed));
    }),
    ("chunked reads reject changed description snapshots and reopen after a folder rename", () =>
    {
        using var store = Store("read-description-change"); var bytes = LargeImageBytes(43);
        var item = SaveFiles(store, "large description", [(FileDescriptor(), bytes)]);
        var first = ReadBytes(store, "draft", item, 0); var directory = store.Find("draft", item.Id);
        var edited = Description.Load(directory); edited.Note = "External note update"; Description.Save(directory, edited);
        Throws(() => store.ReadFile("draft", item.Id, item.Attachments[0].Id, first.Length), "read-changed");
        True(ReadAllBytes(store, "draft", item).SequenceEqual(bytes));
        first = ReadBytes(store, "draft", item, 0);
        Directory.Move(directory, directory + "-renamed");
        Throws(() => store.ReadFile("draft", item.Id, item.Attachments[0].Id, first.Length), "read-changed");
        True(ReadAllBytes(store, "draft", item).SequenceEqual(bytes));
    }),
    ("interleaved and nonsequential reads stay correct and cannot reuse another bucket or root", () =>
    {
        using var store = Store("read-scope"); var bytes = LargeImageBytes(44); var otherBytes = LargeImageBytes(45);
        var item = SaveFiles(store, "large A", [(FileDescriptor(), bytes)]); var other = SaveFiles(store, "large B", [(FileDescriptor(), otherBytes)]);
        var first = ReadBytes(store, "draft", item, 0); var otherFirst = ReadBytes(store, "draft", other, 0);
        True(ReadBytes(store, "draft", item, first.Length).SequenceEqual(bytes.Skip(first.Length).Take(192 * 1024)));
        True(ReadBytes(store, "draft", other, otherFirst.Length).SequenceEqual(otherBytes.Skip(otherFirst.Length).Take(192 * 1024)));
        True(ReadBytes(store, "draft", item, 42).SequenceEqual(bytes.Skip(42).Take(192 * 1024)));
        True(ReadBytes(store, "draft", item, 0).SequenceEqual(first));
        Throws(() => store.ReadFile("library", item.Id, item.Attachments[0].Id, first.Length), "missing-item");
        var source = store.Find("draft", item.Id); var newDraft = Path.Combine(Path.GetDirectoryName(store.Config.DraftRoot)!, "other-draft"); Directory.CreateDirectory(newDraft);
        var target = Path.Combine(newDraft, "copy"); Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        var changed = (byte[])bytes.Clone(); changed[first.Length] ^= 1; File.WriteAllBytes(Path.Combine(target, item.Attachments[0].FileName), changed);
        store.Configure(new(newDraft, store.Config.LibraryRoot));
        True(ReadBytes(store, "draft", item, first.Length).SequenceEqual(changed.Skip(first.Length).Take(192 * 1024)));
    }),
    ("read continuation reuse never bypasses duplicate material checks for writes", () =>
    {
        using var store = Store("read-write-separation"); var bytes = LargeImageBytes(46);
        var item = SaveFiles(store, "read then update", [(FileDescriptor(), bytes)]);
        _ = ReadBytes(store, "draft", item, 0); var source = store.Find("draft", item.Id);
        var duplicate = Path.Combine(store.Config.DraftRoot, "duplicate"); Directory.CreateDirectory(duplicate);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(duplicate, Path.GetFileName(file)));
        Throws(() => store.Update(item.Id, item.Revision, "must not update", "", []), "missing-item");
        Equal(Description.Load(source).Name, item.Name); Equal(Description.Load(duplicate).Name, item.Name);
    }),
    ("framed protocol handles multiple messages and keeps stdout structured", () =>
    {
        var store = Store("protocol");
        using var input = new MemoryStream(); using var output = new MemoryStream();
        Frame(input, "one", "ping", new { }); Frame(input, "two", "unknown", new { });
        input.Position = 0; Protocol.Run(input, output, store); output.Position = 0;
        using var first = ReadFrame(output); using var second = ReadFrame(output);
        Equal(first.RootElement.GetProperty("id").GetString(), "one");
        True(first.RootElement.GetProperty("ok").GetBoolean());
        Equal(second.RootElement.GetProperty("error").GetProperty("code").GetString(), "unsupported-operation");
        Equal(output.Position, output.Length);
    })
};

try
{
    foreach (var (name, action) in tests)
    {
        try { action(); Console.WriteLine("PASS " + name); }
        catch (Exception ex) { failures++; Console.Error.WriteLine("FAIL " + name + ": " + ex); }
    }
}
finally
{
    // Only this invocation's generated test directory can be cleaned up.
    var resolved = Path.GetFullPath(testRoot);
    if (!Path.GetFileName(resolved).StartsWith("moment-vault-tests-", StringComparison.Ordinal) ||
        !SafeFiles.Contains(Path.GetTempPath(), resolved)) throw new Exception("Unsafe test cleanup path");
    foreach (var file in Directory.EnumerateFiles(resolved, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
    Directory.Delete(resolved, true);
}
Console.WriteLine($"{tests.Count - failures}/{tests.Count} native file/protocol checks passed.");
return failures == 0 ? 0 : 1;

VaultStore Store(string name, RecordingMedia? media = null)
{
    var root = Path.Combine(testRoot, name);
    var draft = Path.Combine(root, "草稿箱"); var library = Path.Combine(root, "资产库");
    Directory.CreateDirectory(draft); Directory.CreateDirectory(library);
    var store = new VaultStore(Path.Combine(root, "state"), media); store.Configure(new(draft, library)); return store;
}
static FileUpload FileDescriptor() => new(Guid.NewGuid().ToString("N"), "png", "image", "image/png", "https://example.com/self-made", "附件说明");
static byte[] ImageBytes()
{
    using var image = new Bitmap(8, 8); using var graphics = Graphics.FromImage(image);
    graphics.Clear(Color.FromArgb(239, 189, 80)); using var stream = new MemoryStream();
    image.Save(stream, ImageFormat.Png); return stream.ToArray();
}
static Material Save(VaultStore store)
{
    var file = FileDescriptor(); var bytes = ImageBytes(); var upload = store.Begin("测试图片", [file], "原有备注");
    store.Append(upload.Material.Id, file.Id, 0, Convert.ToBase64String(bytes));
    store.FinishFile(upload.Material.Id, file.Id, 1, bytes.Length); return store.Commit(upload.Material.Id);
}
static Material SaveFiles(VaultStore store, string name, (FileUpload File, byte[] Bytes)[] files)
{
    var upload = store.Begin(name, files.Select(f => f.File).ToArray());
    foreach (var file in files)
    {
        var chunks = (file.Bytes.Length + 192 * 1024 - 1) / (192 * 1024);
        for (var sequence = 0; sequence < chunks; sequence++)
            store.Append(upload.Material.Id, file.File.Id, sequence, Convert.ToBase64String(file.Bytes.AsSpan(sequence * 192 * 1024, Math.Min(192 * 1024, file.Bytes.Length - sequence * 192 * 1024))));
        store.FinishFile(upload.Material.Id, file.File.Id, chunks, file.Bytes.Length);
    }
    return store.Commit(upload.Material.Id);
}
static byte[] LargeImageBytes(int seed)
{
    using var image = new Bitmap(512, 512, PixelFormat.Format24bppRgb);
    var data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
    try { var pixels = new byte[Math.Abs(data.Stride) * image.Height]; new Random(seed).NextBytes(pixels); Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); }
    finally { image.UnlockBits(data); }
    using var stream = new MemoryStream(); image.Save(stream, ImageFormat.Png); return stream.ToArray();
}
static byte[] ReadBytes(VaultStore store, string bucket, Material item, long offset)
{
    using var response = JsonDocument.Parse(MomentVault.Host.Json.Write(store.ReadFile(bucket, item.Id, item.Attachments[0].Id, offset)));
    Equal(response.RootElement.GetProperty("offset").GetInt64(), offset);
    return Convert.FromBase64String(response.RootElement.GetProperty("base64").GetString()!);
}
static byte[] ReadAllBytes(VaultStore store, string bucket, Material item)
{
    using var stream = new MemoryStream(); var length = new FileInfo(Path.Combine(store.Find(bucket, item.Id), item.Attachments[0].FileName)).Length;
    while (stream.Length < length) { var bytes = ReadBytes(store, bucket, item, stream.Length); True(bytes.Length > 0); stream.Write(bytes); }
    return stream.ToArray();
}
static void True(bool value) { if (!value) throw new Exception("Assertion failed"); }
static void Equal<T>(T a, T b) { if (!EqualityComparer<T>.Default.Equals(a, b)) throw new Exception($"Expected {b}; actual {a}"); }
static void Throws(Action action, string code)
{
    try { action(); } catch (VaultException error) when (error.Code == code) { return; }
    throw new Exception("Expected VaultException: " + code);
}
static void Frame(Stream stream, string id, string op, object payload)
{
    var data = JsonSerializer.SerializeToUtf8Bytes(new { protocol = 1, id, op, payload }, MomentVault.Host.Json.Options);
    Span<byte> size = stackalloc byte[4]; BinaryPrimitives.WriteInt32LittleEndian(size, data.Length); stream.Write(size); stream.Write(data);
}
static JsonDocument ReadFrame(Stream stream)
{
    Span<byte> size = stackalloc byte[4]; stream.ReadExactly(size); var data = new byte[BinaryPrimitives.ReadInt32LittleEndian(size)]; stream.ReadExactly(data); return JsonDocument.Parse(data);
}
