using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace MomentVault.Host;

public sealed record ThumbnailResult(string Phase, string? Base64 = null, string? CacheKey = null, string Mime = "image/png");

public sealed partial class VaultStore
{
    private readonly Dictionary<string, string> thumbnailPaths = [];
    private readonly Dictionary<string, Task> thumbnailJobs = [];
    private readonly Dictionary<string, DateTime> thumbnailFailures = [];
    private readonly SemaphoreSlim thumbnailWorker = new(1);
    private readonly object thumbnailCacheLock = new();
    private const int MaximumThumbnailBytes = 160 * 1024;
    private string ThumbnailDirectory
    {
        get
        {
            var path = Path.Combine(stateDirectory, "thumbnails-v1");
            SafeFiles.RejectLinks(path); Directory.CreateDirectory(path); return path;
        }
    }
    private void RememberThumbnailPaths(string bucket, List<Material> items)
    {
        if (thumbnailPaths.Count > 2048) thumbnailPaths.Clear();
        var root = Root(bucket);
        foreach (var item in items.Take(1024)) thumbnailPaths[$"{root}|{item.Id}"] = Path.Combine(root, item.FolderName);
    }
    public ThumbnailResult Thumbnail(string bucket, string id, string attachmentId)
    {
        SafeFiles.Id(id); SafeFiles.Id(attachmentId);
        foreach (var entry in thumbnailJobs.Where(p => p.Value.IsCompleted).ToArray())
        {
            try { entry.Value.GetAwaiter().GetResult(); }
            catch (Exception) { thumbnailFailures[entry.Key] = DateTime.UtcNow; }
            thumbnailJobs.Remove(entry.Key);
        }
        foreach (var entry in thumbnailFailures.Where(p => DateTime.UtcNow - p.Value > TimeSpan.FromSeconds(30)).ToArray()) thumbnailFailures.Remove(entry.Key);
        var root = Root(bucket); var lookup = $"{root}|{id}";
        Material item;
        try
        {
            var directory = thumbnailPaths.GetValueOrDefault(lookup) ?? Find(bucket, id);
            item = Description.Load(directory);
            if (item.Id != id) throw new VaultException("missing-item", "素材已改变，请刷新列表");
        }
        catch (Exception ex) when (ex is IOException or VaultException)
        {
            thumbnailPaths.Remove(lookup);
            item = Description.Load(Find(bucket, id));
        }
        var file = item.Attachments.SingleOrDefault(a => a.Id == attachmentId)
            ?? throw new VaultException("missing-attachment", "附件不存在");
        var input = Path.Combine(root, item.FolderName, file.FileName);
        SafeFiles.RejectLinks(input);
        var info = new FileInfo(input);
        if (!info.Exists || info.Length == 0) return new("unavailable");
        var length = info.Length; var modified = info.LastWriteTimeUtc;
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"v1|{input.ToLowerInvariant()}|{file.Kind}|{file.Sha256}|{length}|{modified.Ticks}"))).ToLowerInvariant();
        var cache = Path.Combine(ThumbnailDirectory, $"{file.Id.ToLowerInvariant()}-{key}.png");
        lock (thumbnailCacheLock)
        {
            SafeFiles.RejectLinks(cache);
            if (File.Exists(cache))
            {
                var bytes = new FileInfo(cache).Length <= MaximumThumbnailBytes ? File.ReadAllBytes(cache) : [];
                if (ValidThumbnail(bytes))
                {
                    File.SetLastWriteTimeUtc(cache, DateTime.UtcNow);
                    return new("ready", Convert.ToBase64String(bytes), key);
                }
                File.Delete(cache);
            }
        }
        if (thumbnailFailures.ContainsKey(key)) return new("unavailable", CacheKey: key);
        if (!thumbnailJobs.ContainsKey(key) && thumbnailJobs.Count < 16)
        {
            var temporary = cache + "." + Guid.NewGuid().ToString("N") + ".tmp";
            thumbnailJobs.Add(key, Task.Run(async () =>
            {
                await thumbnailWorker.WaitAsync(recordingLifetime.Token);
                try
                {
                    await recordingMedia.CreateThumbnailAsync(input, temporary, file.Kind, recordingLifetime.Token);
                    var bytes = new FileInfo(temporary).Length <= MaximumThumbnailBytes ? File.ReadAllBytes(temporary) : [];
                    if (!ValidThumbnail(bytes)) throw new VaultException("thumbnail-unavailable", "缩略图无效");
                    lock (thumbnailCacheLock)
                    {
                        var current = new FileInfo(input);
                        if (!current.Exists || current.Length != length || current.LastWriteTimeUtc != modified)
                            throw new VaultException("thumbnail-changed", "附件已改变");
                        SafeFiles.RejectLinks(input); SafeFiles.RejectLinks(cache);
                        File.Move(temporary, cache, true);
                        TrimThumbnails();
                    }
                }
                finally
                {
                    if (File.Exists(temporary)) File.Delete(temporary);
                    thumbnailWorker.Release();
                }
            }));
        }
        return new("loading", CacheKey: key);
    }
    private static bool ValidThumbnail(byte[] bytes) => bytes.Length >= 24 &&
        bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) &&
        BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16, 4)) is > 0 and <= 192 &&
        BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20, 4)) is > 0 and <= 144;

    private void TrimThumbnails()
    {
        long bytes = 0; var count = 0;
        foreach (var file in new DirectoryInfo(ThumbnailDirectory).GetFiles("*.png").OrderByDescending(f => f.LastWriteTimeUtc))
        {
            SafeFiles.RejectLinks(file.FullName);
            bytes += file.Length;
            if (++count > 512 || bytes > 64 * 1024 * 1024)
                try { file.Delete(); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
    private void ForgetThumbnails(Material item)
    {
        lock (thumbnailCacheLock)
            foreach (var attachment in item.Attachments)
                foreach (var file in Directory.EnumerateFiles(ThumbnailDirectory, attachment.Id.ToLowerInvariant() + "-*.png"))
                {
                    SafeFiles.RejectLinks(file);
                    try { File.Delete(file); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
    }
}
