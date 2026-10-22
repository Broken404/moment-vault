using System.Buffers.Binary;
using System.Text.Json;
using System.Runtime.InteropServices;

namespace MomentVault.Host;

public static class Protocol
{
    public const int Version = 1;
    private const int MaximumMessage = 900_000;

    public static void Run(Stream input, Stream output, VaultStore store, nint parentWindow = 0)
    {
        var header = new byte[4];
        while (true)
        {
            var first = input.ReadByte();
            if (first < 0) return;
            header[0] = (byte)first;
            input.ReadExactly(header.AsSpan(1));
            var size = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (size == 0 || size > MaximumMessage) throw new VaultException("message-size", "通信消息大小无效");
            var bytes = new byte[size];
            input.ReadExactly(bytes);
            string id = "";
            string uploadId = "";
            object response;
            try
            {
                using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
                var request = document.RootElement;
                id = request.GetProperty("id").GetString() ?? "";
                if (id.Length is 0 or > 100 || request.GetProperty("protocol").GetInt32() != Version)
                    throw new VaultException("protocol-version", "扩展与本地助手版本不兼容，请重新安装配套版本");
                var payload = request.GetProperty("payload");
                uploadId = Text(payload, "uploadId");
                var result = Dispatch(store, request.GetProperty("op").GetString()!, payload, parentWindow);
                response = new { id, ok = true, result };
            }
            catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException or JsonException
                or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
            {
                if (uploadId.Length > 0) store.ReleaseUpload(uploadId);
                response = new
                {
                    id, ok = false,
                    error = new { code = (ex as VaultException)?.Code ?? "operation-failed", message = ex.Message, retryable = ex is IOException }
                };
            }
            var serialized = JsonSerializer.SerializeToUtf8Bytes(response, Json.Options);
            if (serialized.Length > MaximumMessage)
                serialized = JsonSerializer.SerializeToUtf8Bytes(new { id, ok = false, error = new { code = "response-too-large", message = "结果过大，请缩小读取范围", retryable = false } }, Json.Options);
            BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)serialized.Length);
            output.Write(header); output.Write(serialized); output.Flush();
        }
    }

    public static object Dispatch(VaultStore store, string op, JsonElement p, nint parentWindow = 0) => op switch
    {
        "ping" => store.Status(),
        "config.get" => store.Config,
        "config.set" => Configure(store, p),
        "folder.pick" => PickFolder(p, parentWindow),
        "items.list" => List(store, p),
        "items.get" => View(Description.Load(store.Find(Text(p, "bucket"), Text(p, "id"))), Text(p, "bucket")),
        "items.begin" => Begin(store, p),
        "items.append" => Append(store, p),
        "items.finishFile" => FinishFile(store, p),
        "items.commit" => View(store.Commit(Text(p, "uploadId")), "draft"),
        "recordings.begin" => BeginRecording(store, p),
        "recordings.process" => RecordingView(store.ProcessRecording(Text(p, "uploadId"),
            Json.Read<RecordingEnd>(p.GetProperty("end").GetRawText()))),
        "recordings.status" => RecordingView(store.RecordingStatus(Text(p, "uploadId"))),
        "items.update" => Update(store, p),
        "items.promote" => Transfer(store, p, "draft", "library"),
        "items.recycle" => Transfer(store, p, "draft", "trash"),
        "items.restore" => Transfer(store, p, "trash", "draft"),
        "items.delete" => Delete(store, p),
        "items.open" => Open(store, p),
        "items.readFile" => store.ReadFile(Text(p, "bucket"), Text(p, "id"), Text(p, "attachmentId"), p.GetProperty("offset").GetInt64()),
        _ => throw new VaultException("unsupported-operation", "当前版本尚未实现这项操作")
    };

    private static string Text(JsonElement p, string name, string fallback = "") => p.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : fallback;
    public static object View(Material item, string bucket) => new
    {
        item.FormatVersion, item.Id, item.Name, item.CreatedAt, item.ApprovedAt, item.Attachments,
        item.Note, item.Revision, item.FolderName, bucket
    };
    private static object Configure(VaultStore store, JsonElement p)
    { store.Configure(new(Text(p, "draftRoot"), Text(p, "libraryRoot"))); return store.Config; }

    private sealed class DialogOwner(nint handle) : IWin32Window
    {
        public nint Handle { get; } = handle;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint window);

    private static object PickFolder(JsonElement p, nint parentWindow)
    {
        if (parentWindow == 0 || !IsWindow(parentWindow))
            throw new VaultException("folder-picker-owner", "目录选择窗口需要关联浏览器，请重新加载扩展并刷新设置页后重试");
        string? selected = null;
        Exception? error = null;
        var title = Text(p, "title", "选择素材目录");
        var initial = Text(p, "initial");
        var thread = new Thread(() =>
        {
            try
            {
                using var dialog = new FolderBrowserDialog { Description = title, UseDescriptionForTitle = true, ShowNewFolderButton = true };
                if (Directory.Exists(initial)) dialog.InitialDirectory = initial;
                if (dialog.ShowDialog(new DialogOwner(parentWindow)) == DialogResult.OK) selected = dialog.SelectedPath;
            }
            catch (Exception ex) { error = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (error is not null) throw new VaultException("folder-picker", "无法打开目录选择器：" + error.Message);
        return new { cancelled = selected is null, path = selected };
    }

    private static object List(VaultStore store, JsonElement p)
    {
        var bucket = Text(p, "bucket");
        var (items, warnings) = store.List(bucket);
        var offset = p.TryGetProperty("offset", out var value) ? Math.Max(0, value.GetInt32()) : 0;
        return new { items = items.Skip(offset).Take(40).Select(i => View(i, bucket)), total = items.Count, warnings = warnings.Take(40) };
    }
    private static object Begin(VaultStore store, JsonElement p)
    {
        var files = Json.Read<FileUpload[]>(p.GetProperty("files").GetRawText());
        var id = Text(p, "uploadId");
        var upload = store.Begin(Text(p, "name"), files, Text(p, "note"), id.Length == 0 ? null : id);
        return new { uploadId = upload.Material.Id, attachments = upload.Material.Attachments.Select(a => new { a.Id, a.FileName }) };
    }
    private static object Append(VaultStore store, JsonElement p)
    { store.Append(Text(p, "uploadId"), Text(p, "attachmentId"), p.GetProperty("sequence").GetInt32(), Text(p, "base64")); return new { accepted = true }; }
    private static object BeginRecording(VaultStore store, JsonElement p)
    {
        var id = Text(p, "uploadId");
        var upload = store.BeginRecording(Text(p, "name"), Text(p, "attachmentId"), Text(p, "source"),
            Json.Read<RecordingSelection>(p.GetProperty("selection").GetRawText()), Text(p, "note"), id.Length == 0 ? null : id);
        return new { uploadId = upload.Material.Id, attachments = upload.Material.Attachments.Select(a => new { a.Id, a.FileName }) };
    }
    private static object RecordingView(RecordingProgress progress) => new
    { progress.Phase, item = progress.Item is null ? null : View(progress.Item, "draft"), progress.Error };
    private static object FinishFile(VaultStore store, JsonElement p)
    { store.FinishFile(Text(p, "uploadId"), Text(p, "attachmentId"), p.GetProperty("chunks").GetInt32(), p.GetProperty("bytes").GetInt64()); return new { complete = true }; }
    private static object Update(VaultStore store, JsonElement p)
    {
        var edits = new Dictionary<string, (string, string)>();
        if (p.TryGetProperty("attachments", out var values))
            foreach (var a in values.EnumerateArray()) edits[Text(a, "id")] = (Text(a, "source"), Text(a, "note"));
        return View(store.Update(Text(p, "id"), Text(p, "revision"), Text(p, "name"), Text(p, "note"), edits), "draft");
    }
    private static object Transfer(VaultStore store, JsonElement p, string from, string to)
    {
        var ids = p.GetProperty("ids").EnumerateArray().Select(i => i.GetString()!).Distinct().ToArray();
        if (ids.Length is 0 or > 200) throw new VaultException("invalid-selection", "请选择 1–200 条素材");
        return ids.Select(id =>
        {
            try { return store.Transfer(id, from, to); }
            catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException)
            { return new TransferResult(id, "failed", ex.Message); }
        }).ToArray();
    }
    private static object Delete(VaultStore store, JsonElement p)
    { store.Delete(Text(p, "bucket"), Text(p, "id"), p.TryGetProperty("confirmed", out var flag) && flag.ValueKind == JsonValueKind.True); return new { deleted = true }; }
    private static object Open(VaultStore store, JsonElement p)
    {
        var id = Text(p, "id"); var attachment = Text(p, "attachmentId");
        store.Open(Text(p, "bucket"), id.Length == 0 ? null : id, attachment.Length == 0 ? null : attachment);
        return new { opened = true };
    }
}
