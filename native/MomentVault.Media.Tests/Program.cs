using System.Diagnostics;
using System.Buffers.Binary;
using System.Text.Json;
using MomentVault.Host;

if (args.Length != 5)
{
    Console.Error.WriteLine("Usage: Media.Tests <ffmpeg.exe> <ffprobe.exe> <valid-self-made.webm> <audio-tail-counterexample.webm> <new-output-directory>");
    return 2;
}
var ffmpeg = Path.GetFullPath(args[0]); var ffprobe = Path.GetFullPath(args[1]);
var valid = Path.GetFullPath(args[2]); var invalid = Path.GetFullPath(args[3]);
var root = Path.GetFullPath(args[4]);
if (Directory.Exists(root)) throw new Exception("Use a new, isolated output directory.");
Directory.CreateDirectory(root);
var tools = new RecordingMedia(ffmpeg, ffprobe);
var checks = new List<object>();
var end = new RecordingEnd(2, 4.010456, "selected-end");

// Real codecs + chunk storage + asynchronous processing + atomic visible commit.
using (var store = Store("complete", tools))
{
    var upload = Upload(store, valid, "实际录制备注");
    var watch = Stopwatch.StartNew();
    var started = Request(store, "recordings.process", new { uploadId = upload.Material.Id, end });
    watch.Stop(); Equal(started.GetProperty("phase").GetString(), "processing");
    Throws(() => store.Commit(upload.Material.Id), "recording-not-ready");
    store.ReleaseUpload(upload.Material.Id);
    Throws(() => store.Configure(store.Config), "pending-operation");
    _ = Request(store, "ping", new { });
    var saved = await Await(store, upload.Material.Id);
    var item = saved.Item!;
    Equal(item.Note, "实际录制备注"); Equal(item.Attachments.Single().Mime, "video/mp4");
    Equal(item.Attachments.Single().Range!.Value.GetProperty("stopReason").GetString(), "selected-end");
    Equal(item.Attachments.Single().Range!.Value.GetProperty("actualEnd").GetDouble(), end.ActualEnd);
    Equal(store.ProcessRecording(item.Id, end).Item!.Id, item.Id);
    Equal(store.List("draft").Items.Count, 1);
    var directory = store.Find("draft", item.Id);
    Equal(Directory.GetFiles(directory).Length, 2);
    var output = Path.Combine(directory, item.Attachments.Single().FileName);
    Equal(SafeFiles.Hash(output), item.Attachments.Single().Sha256);
    checks.Add(new { name = "real-codecs-chunks-commit-and-idempotent-retry", passed = true, startReturnedMs = watch.ElapsedMilliseconds,
        output, bytes = item.Attachments.Single().Bytes, range = item.Attachments.Single().Range });
}

// Missing binaries are a recoverable failure; no fake media success.
var missing = new RecordingMedia(Path.Combine(root, "missing-ffmpeg.exe"), Path.Combine(root, "missing-ffprobe.exe"));
string retryId;
using (var store = Store("missing-tools", missing))
{
    var upload = Upload(store, valid); retryId = upload.Material.Id;
    Throws(() => store.ProcessRecording(retryId, end), "media-tools-missing");
    OriginalIntact(store, retryId, valid); Equal(store.List("draft").Items.Count, 0);
}
using (var recovered = new VaultStore(Path.Combine(root, "missing-tools", "state"), tools))
{
    Equal(recovered.ProcessRecording(retryId, end).Phase, "processing");
    _ = await Await(recovered, retryId);
    Equal(recovered.List("draft").Items.Count, 1);
    checks.Add(new { name = "missing-tools-restart-and-retry-original", passed = true });
}

// The provided audio-tail counterexample must not become a successful draft.
using (var store = Store("retained-failure", tools))
{
    var upload = Upload(store, invalid, selection: new(2, 12));
    store.ProcessRecording(upload.Material.Id, new(2, 3.918114, "manual-shortcut"));
    var result = await Await(store, upload.Material.Id, expected: "failed");
    Equal(store.List("draft").Items.Count, 0); OriginalIntact(store, upload.Material.Id, invalid);
    checks.Add(new { name = "audio-tail-counterexample-not-published", passed = true, result.Error });
}

// Truly static source pictures are allowed; content-motion tests are fixture-only.
var portrait = Path.Combine(root, "static-portrait.webm");
await GeneratePortrait(portrait);
using (var store = Store("portrait", tools))
{
    var upload = Upload(store, portrait, selection: new(0, 2));
    store.ProcessRecording(upload.Material.Id, new(0, 2, "selected-end"));
    var saved = await Await(store, upload.Material.Id);
    var path = Path.Combine(store.Find("draft", saved.Item!.Id), saved.Item.Attachments.Single().FileName);
    checks.Add(new { name = "static-portrait-keeps-size-and-audio", passed = true, output = path });
}

// Host shutdown cancels its child and leaves a restartable pending recording.
string interruptedId;
using (var store = Store("interrupted", tools))
{
    var upload = Upload(store, valid); interruptedId = upload.Material.Id;
    Equal(store.ProcessRecording(interruptedId, end).Phase, "processing");
}
using (var recovered = new VaultStore(Path.Combine(root, "interrupted", "state"), tools))
{
    Equal(recovered.RecordingStatus(interruptedId).Phase, "failed");
    OriginalIntact(recovered, interruptedId, valid);
    Equal(recovered.ProcessRecording(interruptedId, end).Phase, "processing");
    _ = await Await(recovered, interruptedId);
    Equal(recovered.List("draft").Items.Count, 1);
    checks.Add(new { name = "interrupted-processing-restart-and-retry", passed = true });
}

// Imported videos keep their original bytes and format; only recordings are transcoded.
using (var store = Store("import-original", tools))
{
    var id = Guid.NewGuid().ToString("N");
    var upload = store.Begin("导入视频", [new(id, "webm", "video", "video/webm")]);
    var bytes = File.ReadAllBytes(portrait);
    store.Append(upload.Material.Id, id, 0, Convert.ToBase64String(bytes));
    store.FinishFile(upload.Material.Id, id, 1, bytes.Length);
    var item = store.Commit(upload.Material.Id);
    Equal(item.Attachments.Single().Mime, "video/webm");
    Equal(item.Attachments.Single().Sha256, SafeFiles.Hash(portrait));
    checks.Add(new { name = "imported-webm-keeps-original-format-and-bytes", passed = true });
}
// Real thumbnail decoding uses the same installed tools and isolated roots.
var imageFixture = Path.Combine(root, "thumbnail.png");
using (var image = new Bitmap(320, 180))
{
    using var graphics = Graphics.FromImage(image); graphics.Clear(Color.Goldenrod);
    image.Save(imageFixture, System.Drawing.Imaging.ImageFormat.Png);
    image.Save(Path.Combine(root, "thumbnail.jpg"), System.Drawing.Imaging.ImageFormat.Jpeg);
    image.Save(Path.Combine(root, "thumbnail.gif"), System.Drawing.Imaging.ImageFormat.Gif);
}
var transparent = Path.Combine(root, "transparent.png");
using (var image = new Bitmap(40, 40))
{
    using var graphics = Graphics.FromImage(image); graphics.Clear(Color.Transparent);
    graphics.FillRectangle(Brushes.Blue, 10, 10, 20, 20);
    image.Save(transparent, System.Drawing.Imaging.ImageFormat.Png);
}
await Generate(["-i", imageFixture, Path.Combine(root, "thumbnail.webp")]);
var shortVideo = Path.Combine(root, "short.mp4");
await Generate(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "0.4", "-c:v", "libx264", shortVideo]);
await Generate(["-i", shortVideo, "-c", "copy", Path.Combine(root, "short.mov")]);
string cachedItemId, cachedAttachmentId, cacheKey, originalHash;
using (var store = Store("thumbnail-formats", tools))
{
    foreach (var file in new[] { imageFixture, Path.Combine(root, "thumbnail.jpg"), Path.Combine(root, "thumbnail.gif"), Path.Combine(root, "thumbnail.webp"), transparent, valid, shortVideo, Path.Combine(root, "short.mov"), portrait })
    {
        var kind = new[] { ".png", ".jpg", ".gif", ".webp" }.Contains(Path.GetExtension(file)) ? "image" : "video";
        var item = Import(store, file, kind); var source = store.Find("draft", item.Id);
        var before = SafeFiles.Snapshot(source);
        var result = await AwaitThumbnail(store, item);
        using var stream = new MemoryStream(Convert.FromBase64String(result.Base64!));
        using var decoded = new Bitmap(stream);
        if (decoded.Width > 192 || decoded.Height > 144 || decoded.Width < 1 || decoded.Height < 1) throw new Exception("Thumbnail dimensions exceed bounds");
        if (file == transparent) Equal(decoded.GetPixel(0, 0).A, (byte)0);
        if (file == portrait && decoded.Height <= decoded.Width) throw new Exception("Portrait aspect ratio was not retained");
        if (!SafeFiles.Same(before, SafeFiles.Snapshot(source))) throw new Exception("Thumbnail changed original files or description");
    }
    checks.Add(new { name = "thumbnail-real-png-jpeg-gif-webp-alpha-webm-short-mp4-mov-and-portrait", passed = true, formats = 9 });
    var cached = Import(store, imageFixture, "image");
    var resultCached = await AwaitThumbnail(store, cached);
    Equal(store.Thumbnail("draft", cached.Id, cached.Attachments[0].Id).Phase, "ready");
    cachedItemId = cached.Id; cachedAttachmentId = cached.Attachments[0].Id;
    cacheKey = resultCached.CacheKey!; originalHash = SafeFiles.Hash(Path.Combine(store.Find("draft", cached.Id), cached.Attachments[0].FileName));
}
using (var store = new VaultStore(Path.Combine(root, "thumbnail-formats", "state"), tools))
{
    var cached = Description.Load(store.Find("draft", cachedItemId));
    var hit = store.Thumbnail("draft", cachedItemId, cachedAttachmentId);
    Equal(hit.Phase, "ready"); Equal(hit.CacheKey, cacheKey);
    checks.Add(new { name = "thumbnail-disk-cache-survives-native-restart", passed = true });
    var source = Path.Combine(store.Find("draft", cachedItemId), cached.Attachments[0].FileName);
    using (var replacement = new Bitmap(320, 180))
    {
        using var graphics = Graphics.FromImage(replacement); graphics.Clear(Color.Blue);
        replacement.Save(source, System.Drawing.Imaging.ImageFormat.Png);
    }
    File.SetLastWriteTimeUtc(source, DateTime.UtcNow.AddSeconds(1));
    var changed = await AwaitThumbnail(store, cached);
    if (changed.CacheKey == cacheKey || changed.Base64 == hit.Base64) throw new Exception("Stale thumbnail after an external media change");
    checks.Add(new { name = "thumbnail-invalidates-on-external-source-change", passed = true });
    File.Copy(imageFixture, source, true); Equal(SafeFiles.Hash(source), originalHash);
    var renamed = store.Update(cached.Id, cached.Revision, "缩略图改名", cached.Note, []);
    _ = await AwaitThumbnail(store, renamed);
    store.Transfer(renamed.Id, "draft", "trash");
    _ = await AwaitThumbnail(store, renamed, "trash");
    store.Transfer(renamed.Id, "trash", "draft");
    store.Transfer(renamed.Id, "draft", "library");
    _ = await AwaitThumbnail(store, renamed, "library");
    checks.Add(new { name = "thumbnail-follows-rename-recycle-restore-and-promotion", passed = true });
    store.Delete("library", renamed.Id, true);
    Equal(Directory.GetFiles(Path.Combine(root, "thumbnail-formats", "state", "thumbnails-v1"), cachedAttachmentId + "-*.png").Length, 0);
    checks.Add(new { name = "thumbnail-derived-cache-removed-with-permanent-delete", passed = true });
}
using (var store = Store("thumbnail-budget", tools))
{
    var cache = Path.Combine(root, "thumbnail-budget", "state", "thumbnails-v1"); Directory.CreateDirectory(cache);
    var oversized = Path.Combine(cache, "owned-budget-counterexample.png");
    using (var stream = File.Create(oversized)) stream.SetLength(65L * 1024 * 1024);
    File.SetLastWriteTimeUtc(oversized, DateTime.UtcNow.AddDays(-2));
    for (var i = 0; i < 520; i++)
    {
        var path = Path.Combine(cache, $"owned-count-{i:000}.png"); File.WriteAllBytes(path, [1]);
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddDays(-1));
    }
    var item = Import(store, imageFixture, "image");
    var watch = Stopwatch.StartNew();
    var pending = Request(store, "items.thumbnail", new { bucket = "draft", id = item.Id, attachmentId = item.Attachments[0].Id });
    Equal(pending.GetProperty("phase").GetString(), "loading");
    _ = Request(store, "ping", new { }); watch.Stop();
    _ = await AwaitThumbnail(store, item);
    var files = new DirectoryInfo(cache).GetFiles("*.png");
    if (files.Length > 512 || files.Sum(f => f.Length) > 64L * 1024 * 1024) throw new Exception("Thumbnail disk cache exceeds budget");
    checks.Add(new { name = "thumbnail-async-protocol-and-disk-budget", passed = true, pendingAndPingReturnedMs = watch.ElapsedMilliseconds, cacheEntries = files.Length, cacheBytes = files.Sum(f => f.Length) });
}
Console.WriteLine(MomentVault.Host.Json.Write(new { passed = checks.Count, checks, artifacts = root }));
return 0;

VaultStore Store(string name, RecordingMedia media)
{
    var directory = Path.Combine(root, name);
    var draft = Path.Combine(directory, "草稿箱"); var library = Path.Combine(directory, "资产库");
    Directory.CreateDirectory(draft); Directory.CreateDirectory(library);
    var store = new VaultStore(Path.Combine(directory, "state"), media); store.Configure(new(draft, library)); return store;
}
static UploadState Upload(VaultStore store, string path, string note = "", RecordingSelection? selection = null)
{
    var id = Guid.NewGuid().ToString("N");
    selection ??= new(2, 4);
    var uploadId = Guid.NewGuid().ToString("N");
    var opened = Request(store, "recordings.begin", new { uploadId, name = "自制素材", attachmentId = id,
        source = "self-made-fixture", selection, note });
    Equal(opened.GetProperty("uploadId").GetString(), uploadId);
    // A lost begin acknowledgement can repeat the exact same request.
    var upload = store.BeginRecording("自制素材", id, "self-made-fixture", selection, note, uploadId);
    using var file = File.OpenRead(path); var chunk = new byte[192 * 1024];
    int count, sequence = 0;
    while ((count = file.Read(chunk)) > 0)
    {
        var data = Convert.ToBase64String(chunk, 0, count);
        Request(store, "items.append", new { uploadId, attachmentId = id, sequence, base64 = data });
        if (sequence == 0) Request(store, "items.append", new { uploadId, attachmentId = id, sequence, base64 = data });
        sequence++;
    }
    Request(store, "items.finishFile", new { uploadId, attachmentId = id, chunks = sequence, bytes = file.Length });
    Equal(store.List("draft").Items.Count, 0); return upload;
}
static void OriginalIntact(VaultStore store, string id, string original)
{
    var path = Path.Combine(store.Config.DraftRoot, ".moment-vault", "pending", id, "视频-001.webm");
    Equal(SafeFiles.Hash(path), SafeFiles.Hash(original));
}
static async Task<RecordingProgress> Await(VaultStore store, string id, string expected = "saved")
{
    var clock = Stopwatch.StartNew();
    while (clock.Elapsed < TimeSpan.FromSeconds(45))
    {
        var response = Request(store, "recordings.status", new { uploadId = id });
        var phase = response.GetProperty("phase").GetString();
        if (phase != "processing")
        { Equal(phase, expected); return store.RecordingStatus(id); }
        await Task.Delay(20);
    }
    throw new Exception("Media check timed out.");
}
async Task GeneratePortrait(string output)
{
    var start = new ProcessStartInfo(ffmpeg) { UseShellExecute = false, CreateNoWindow = true };
    foreach (var argument in new[] { "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", output })
        start.ArgumentList.Add(argument);
    using var process = Process.Start(start)!; await process.WaitForExitAsync(); Equal(process.ExitCode, 0);
}
async Task Generate(string[] arguments)
{
    var start = new ProcessStartInfo(ffmpeg) { UseShellExecute = false, CreateNoWindow = true };
    foreach (var argument in new[] { "-nostdin", "-v", "error", "-n" }.Concat(arguments)) start.ArgumentList.Add(argument);
    using var process = Process.Start(start)!; await process.WaitForExitAsync(); Equal(process.ExitCode, 0);
}
static Material Import(VaultStore store, string path, string kind)
{
    var id = Guid.NewGuid().ToString("N"); var bytes = File.ReadAllBytes(path);
    var upload = store.Begin(Path.GetFileName(path), [new(id, Path.GetExtension(path)[1..], kind, kind == "image" ? "image/png" : "video/webm")]);
    for (var offset = 0; offset < bytes.Length; offset += 192 * 1024)
        store.Append(upload.Material.Id, id, offset / (192 * 1024), Convert.ToBase64String(bytes, offset, Math.Min(192 * 1024, bytes.Length - offset)));
    store.FinishFile(upload.Material.Id, id, (bytes.Length + 192 * 1024 - 1) / (192 * 1024), bytes.Length);
    return store.Commit(upload.Material.Id);
}
static async Task<ThumbnailResult> AwaitThumbnail(VaultStore store, Material item, string bucket = "draft")
{
    var clock = Stopwatch.StartNew();
    while (clock.Elapsed < TimeSpan.FromSeconds(15))
    {
        var result = store.Thumbnail(bucket, item.Id, item.Attachments[0].Id);
        if (result.Phase != "loading") { Equal(result.Phase, "ready"); return result; }
        await Task.Delay(25);
    }
    throw new Exception("Thumbnail check timed out");
}
static void Equal<T>(T actual, T expected)
{ if (!EqualityComparer<T>.Default.Equals(actual, expected)) throw new Exception($"Expected {expected}; actual {actual}"); }
static void Throws(Action action, string code)
{
    try { action(); } catch (VaultException error) when (error.Code == code) { return; }
    throw new Exception("Expected VaultException: " + code);
}
static JsonElement Request(VaultStore store, string op, object payload)
{
    using var input = new MemoryStream(); using var output = new MemoryStream();
    var bytes = JsonSerializer.SerializeToUtf8Bytes(new { protocol = 1, id = Guid.NewGuid().ToString("N"), op, payload }, MomentVault.Host.Json.Options);
    Span<byte> header = stackalloc byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
    input.Write(header); input.Write(bytes); input.Position = 0;
    Protocol.Run(input, output, store); output.Position = 0;
    output.ReadExactly(header); var response = new byte[BinaryPrimitives.ReadInt32LittleEndian(header)]; output.ReadExactly(response);
    using var document = JsonDocument.Parse(response);
    if (!document.RootElement.GetProperty("ok").GetBoolean()) throw new Exception(document.RootElement.GetRawText());
    return document.RootElement.GetProperty("result").Clone();
}
