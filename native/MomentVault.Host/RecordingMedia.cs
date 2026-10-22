using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace MomentVault.Host;

// Executables are chosen by the host, never supplied by a browser message.
public sealed class RecordingMedia(string ffmpeg, string ffprobe)
{
    public static RecordingMedia Bundled() => new(Path.Combine(AppContext.BaseDirectory, "media", "ffmpeg.exe"),
        Path.Combine(AppContext.BaseDirectory, "media", "ffprobe.exe"));
    public bool Available => File.Exists(ffmpeg) && File.Exists(ffprobe);

    public async Task<RecordingMediaInfo> ConvertAsync(string input, string output, CancellationToken cancellation)
    {
        if (!Available) throw new VaultException("media-tools-missing", "本地助手缺少配套视频处理组件，原片已保留");
        SafeFiles.RejectLinks(input); SafeFiles.RejectLinks(output);
        if (!Path.IsPathFullyQualified(input) || !Path.IsPathFullyQualified(output) ||
            string.Equals(input, output, StringComparison.OrdinalIgnoreCase) || File.Exists(output))
            throw new VaultException("invalid-media-path", "视频处理路径无效，原片未修改");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromMinutes(30));
        var token = timeout.Token;
        var completed = false;
        try
        {
            var source = await Inspect(input, "matroska", token);
            await Run(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-n",
                "-protocol_whitelist", "file,pipe", "-f", "matroska", "-i", input,
                "-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1",
                "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", output], token);
            var result = await Inspect(output, "mov", token);
            if (result.VideoCodec != "h264" || result.AudioCodec != "aac" ||
                result.Width != source.Width / 2 * 2 || result.Height != source.Height / 2 * 2 ||
                result.VideoDuration <= 0 || result.AudioDuration <= 0 ||
                Math.Abs(result.VideoDuration - result.AudioDuration) > 0.25)
                throw new VaultException("recording-incomplete", "成片音视频或尺寸检查未通过，原片已保留，可重试");
            var info = new RecordingMediaInfo(result.Width, result.Height, Math.Max(result.VideoDuration, result.AudioDuration),
                result.VideoDuration, result.AudioDuration, new FileInfo(output).Length, SafeFiles.Hash(output));
            completed = true;
            return info;
        }
        catch (OperationCanceledException)
        {
            throw new VaultException("media-interrupted", "视频处理已中断，原片已保留，可重试");
        }
        finally
        {
            // Only this attempt's unique generated candidate is disposable. Input and chunks remain.
            if (!completed && File.Exists(output))
                try { File.Delete(output); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private sealed record Inspection(int Width, int Height, string VideoCodec, string AudioCodec,
        double VideoDuration, double AudioDuration);
    private async Task<Inspection> Inspect(string path, string format, CancellationToken cancellation)
    {
        var text = await Run(ffprobe, ["-v", "error", "-err_detect", "explode", "-protocol_whitelist", "file,pipe",
            "-f", format, "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,duration,nb_read_frames",
            "-of", "json", path], cancellation);
        using var json = JsonDocument.Parse(text);
        var streams = json.RootElement.GetProperty("streams").EnumerateArray().ToArray();
        var video = streams.FirstOrDefault(s => s.GetProperty("codec_type").GetString() == "video");
        var audio = streams.FirstOrDefault(s => s.GetProperty("codec_type").GetString() == "audio");
        if (video.ValueKind == JsonValueKind.Undefined || audio.ValueKind == JsonValueKind.Undefined ||
            video.GetProperty("width").GetInt32() < 2 || video.GetProperty("height").GetInt32() < 2 ||
            Number(video, "nb_read_frames") <= 0 || Number(audio, "nb_read_frames") <= 0)
            throw new VaultException("invalid-recording", "中间文件没有完整的音视频，原片已保留");
        return new(video.GetProperty("width").GetInt32(), video.GetProperty("height").GetInt32(),
            video.GetProperty("codec_name").GetString()!, audio.GetProperty("codec_name").GetString()!,
            Number(video, "duration"), Number(audio, "duration"));
    }
    private static double Number(JsonElement element, string property) => element.TryGetProperty(property, out var value) &&
        double.TryParse(value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : 0;

    private static async Task<string> Run(string executable, string[] arguments, CancellationToken cancellation)
    {
        if (!Path.IsPathFullyQualified(executable)) throw new VaultException("media-tools-missing", "视频处理组件路径无效");
        SafeFiles.RejectLinks(executable);
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start };
        try
        {
            cancellation.ThrowIfCancellationRequested();
            process.Start();
            // Both pipes are drained concurrently and bounded; neither can stall the child.
            var output = ReadBounded(process.StandardOutput);
            var errors = ReadBounded(process.StandardError);
            try { await process.WaitForExitAsync(cancellation); }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                await Task.WhenAll(output, errors);
                throw;
            }
            var stdout = await output; var stderr = await errors;
            if (process.ExitCode != 0 || !string.IsNullOrWhiteSpace(stderr))
                throw new VaultException("media-conversion-failed", "视频处理组件未能完成检查或转码，原片已保留，可重试");
            return stdout;
        }
        catch (Win32Exception)
        { throw new VaultException("media-tools-missing", "无法启动配套视频处理组件，原片已保留"); }
    }
    private static async Task<string> ReadBounded(StreamReader reader)
    {
        var text = new StringBuilder(); var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory())) > 0)
            if (text.Length < 128 * 1024) text.Append(buffer, 0, Math.Min(count, 128 * 1024 - text.Length));
        return text.ToString();
    }
}
