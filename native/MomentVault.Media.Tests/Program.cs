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
