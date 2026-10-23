using System.Text.Json;
using System.Text.Json.Serialization;

namespace MomentVault.Host;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };
    public static T Read<T>(string text) => JsonSerializer.Deserialize<T>(text, Options)
        ?? throw new VaultException("invalid-data", "数据为空或格式无效");
    public static string Write<T>(T value) => JsonSerializer.Serialize(value, Options);
}

public sealed class VaultException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed record HostConfig(string DraftRoot = "", string LibraryRoot = "");
public sealed class Attachment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string FileName { get; set; } = "";
    public string Kind { get; set; } = "image";
    public string Mime { get; set; } = "";
    public long Bytes { get; set; }
    public string Sha256 { get; set; } = "";
    public DateTimeOffset CollectedAt { get; set; } = DateTimeOffset.Now;
    public string Source { get; set; } = "";
    public string Note { get; set; } = "";
    public JsonElement? Range { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
}

public sealed class Material
{
    public int FormatVersion { get; set; } = 1;
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.Now;
    public DateTimeOffset? ApprovedAt { get; set; }
    public List<Attachment> Attachments { get; set; } = [];
    public List<JsonElement>? MergedFrom { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    [JsonIgnore] public string Note { get; set; } = "";
    [JsonIgnore] public string Revision { get; set; } = "";
    [JsonIgnore] public string FolderName { get; set; } = "";
}

public sealed record FileUpload(string Id, string Extension, string Kind, string Mime, string Source = "", string Note = "");
public sealed class UploadState
{
    public Material Material { get; set; } = new();
    public string Note { get; set; } = "";
    public Dictionary<string, int> FinishedChunks { get; set; } = [];
    public Dictionary<string, long> ExpectedBytes { get; set; } = [];
    public RecordingUpload? Recording { get; set; }
}
public sealed record RecordingSelection(double A, double B);
public sealed record RecordingEnd(double ActualStart, double ActualEnd, string StopReason);
public sealed record RecordingMediaInfo(int Width, int Height, double Duration, double VideoDuration,
    double AudioDuration, long Bytes, string Sha256);
public sealed class RecordingUpload
{
    public RecordingSelection Selection { get; set; } = new(0, 0);
    public RecordingEnd? End { get; set; }
    public string InputFileName { get; set; } = "视频-001.webm";
    public string OutputFileName { get; set; } = "";
    public string Phase { get; set; } = "capturing";
    public string? Error { get; set; }
    public RecordingMediaInfo? Result { get; set; }
}
public sealed record RecordingProgress(string Phase, Material? Item = null, string? Error = null);
public sealed record TransferResult(string Id, string Status, string? Error = null);
public sealed record MergeSelection(string Id, string Revision);
public sealed record MergeSource(string Id, string Revision, string Directory, Dictionary<string, string> Hashes);
public sealed record MergeJournal(string Id, MergeSelection[] Selection, MergeSource[] Sources, string Target,
    string Staging, Dictionary<string, string> TargetHashes);
public sealed record MergeResult(string Status, Material Item, string[] RetainedSourceIds, string? Error = null);
public sealed record TransferJournal(string Id, string Source, string Target, string Staging, Dictionary<string, string> SourceHashes,
    Dictionary<string, string> TargetHashes);
