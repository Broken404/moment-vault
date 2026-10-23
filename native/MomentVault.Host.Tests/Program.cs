using System.Buffers.Binary;
using System.Drawing.Imaging;
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
        store.Append(upload.Material.Id, file.File.Id, 0, Convert.ToBase64String(file.Bytes));
        store.FinishFile(upload.Material.Id, file.File.Id, 1, file.Bytes.Length);
    }
    return store.Commit(upload.Material.Id);
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
