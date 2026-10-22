using System.Text.Json;

namespace MomentVault.Host;

public sealed partial class VaultStore
{
    private readonly RecordingMedia recordingMedia;
    private readonly CancellationTokenSource recordingLifetime = new();
    // Only the protocol thread changes store metadata. Tasks own only their unique output files.
    private readonly Dictionary<string, Task<RecordingMediaInfo>> recordingJobs = [];

    public UploadState BeginRecording(string name, string attachmentId, string source, RecordingSelection selection,
        string note = "", string? requestedId = null)
    {
        if (!double.IsFinite(selection.A) || !double.IsFinite(selection.B) || selection.A < 0 || selection.B <= selection.A)
            throw new VaultException("invalid-recording-range", "请先选择有效的视频起点和终点");
        return Begin(name, [new(attachmentId, "webm", "video", "video/webm", source)], note, requestedId,
            new RecordingUpload { Selection = selection });
    }

    public RecordingProgress ProcessRecording(string uploadId, RecordingEnd end)
    {
        if (!double.IsFinite(end.ActualStart) || !double.IsFinite(end.ActualEnd) || end.ActualStart < 0 ||
            end.ActualEnd <= end.ActualStart || string.IsNullOrWhiteSpace(end.StopReason) || end.StopReason.Length > 80)
            throw new VaultException("invalid-recording-range", "实际录制范围或结束原因无效，原片已保留");
        var existing = List("draft").Items.SingleOrDefault(i => i.Id == uploadId);
        if (existing is not null) return new("saved", existing);
        var directory = Pending(uploadId); var state = ReadUpload(directory); var recording = Recording(state);
        if (recording.End is not null && recording.End != end)
            throw new VaultException("recording-conflict", "重试的录制范围与原记录不同，原片已保留");
        activeUploads.Add(uploadId);
        if (recordingJobs.ContainsKey(uploadId)) return RecordingStatus(uploadId);
        if (recording.Result is not null)
        {
            recording.Phase = "ready"; recording.Error = null; WriteUpload(directory, state);
            return CompleteRecording(uploadId, directory, state);
        }
        var file = state.Material.Attachments.Single();
        var input = Path.Combine(directory, recording.InputFileName);
        SafeFiles.RejectLinks(input);
        if (!state.FinishedChunks.ContainsKey(file.Id) || !File.Exists(input) ||
            new FileInfo(input).Length != file.Bytes || SafeFiles.Hash(input) != file.Sha256)
            throw new VaultException("incomplete-upload", "录制分块尚未完整保存，原片已保留");
        recording.End = end;
        if (!recordingMedia.Available)
        {
            const string message = "本地助手缺少配套视频处理组件，原片已保留";
            FailRecording(uploadId, directory, state, message);
            throw new VaultException("media-tools-missing", message);
        }
        recording.Error = null; recording.Phase = "processing";
        recording.OutputFileName = ".recording-" + Guid.NewGuid().ToString("N") + ".mp4";
        WriteUpload(directory, state);
        var output = Path.Combine(directory, recording.OutputFileName);
        recordingJobs.Add(uploadId, Task.Run(() => recordingMedia.ConvertAsync(input, output, recordingLifetime.Token)));
        return new("processing");
    }

    public RecordingProgress RecordingStatus(string uploadId)
    {
        var existing = List("draft").Items.SingleOrDefault(i => i.Id == uploadId);
        if (existing is not null) return new("saved", existing);
        var directory = Pending(uploadId); var state = ReadUpload(directory); var recording = Recording(state);
        if (recording.Phase == "ready") return CompleteRecording(uploadId, directory, state);
        if (recording.Phase != "processing") return new(recording.Phase, Error: recording.Error);
        if (!recordingJobs.TryGetValue(uploadId, out var task))
            return FailRecording(uploadId, directory, state, "上次视频处理已中断，原片已保留，请重试");
        if (!task.IsCompleted) return new("processing");
        recordingJobs.Remove(uploadId);
        try
        {
            var result = task.GetAwaiter().GetResult();
            var candidate = Path.Combine(directory, recording.OutputFileName);
            SafeFiles.RejectLinks(candidate);
            if (SafeFiles.Hash(candidate) != result.Sha256)
                throw new VaultException("media-changed", "成片被外部修改，原片已保留");
            var file = state.Material.Attachments.Single();
            file.FileName = "视频-001.mp4"; file.Mime = "video/mp4";
            var output = Path.Combine(directory, file.FileName); SafeFiles.RejectLinks(output);
            File.Move(candidate, output, true);
            file.Bytes = result.Bytes; file.Sha256 = result.Sha256;
            file.Range = JsonSerializer.SerializeToElement(new
            {
                recording.Selection.A, recording.Selection.B, recording.End!.ActualStart,
                recording.End.ActualEnd, recording.End.StopReason, duration = result.Duration, capture = "tabCapture-to-canvas"
            }, Json.Options);
            recording.Result = result; recording.Phase = "ready"; recording.OutputFileName = file.FileName;
            WriteUpload(directory, state);
            return CompleteRecording(uploadId, directory, state);
        }
        catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException or JsonException)
        { return FailRecording(uploadId, directory, state, ex.Message); }
    }

    private RecordingProgress CompleteRecording(string id, string directory, UploadState state)
    {
        try { return new("saved", Commit(id)); }
        catch (Exception ex) when (ex is VaultException or IOException or UnauthorizedAccessException)
        { return FailRecording(id, directory, state, ex.Message); }
    }
    private RecordingProgress FailRecording(string id, string directory, UploadState state, string message)
    {
        state.Recording!.Phase = "failed"; state.Recording.Error = message;
        WriteUpload(directory, state); activeUploads.Remove(id);
        return new("failed", Error: message);
    }
    private static RecordingUpload Recording(UploadState state)
    {
        var value = state.Recording ?? throw new VaultException("not-recording", "这不是录制上传");
        if (state.Material.Attachments.Count != 1 || value.InputFileName != "视频-001.webm" ||
            (!string.IsNullOrEmpty(value.OutputFileName) && Path.GetFileName(value.OutputFileName) != value.OutputFileName))
            throw new VaultException("invalid-recording", "录制恢复信息无效，原文件保留");
        return value;
    }
    public void Dispose()
    {
        recordingLifetime.Cancel();
        try { Task.WhenAll(recordingJobs.Values).GetAwaiter().GetResult(); }
        catch (Exception) { /* Failed or cancelled tasks leave their original pending files for retry. */ }
        recordingLifetime.Dispose();
    }
}
