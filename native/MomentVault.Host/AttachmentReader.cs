using System.Text.Json;

namespace MomentVault.Host;

public sealed partial class VaultStore
{
    private sealed record ReadKey(string Root, string MaterialId, string AttachmentId);
    private sealed record ReadContinuation(string Directory, string Revision, string FileName,
        long Length, DateTime LastWriteTimeUtc, long NextOffset, long ExpiresAt);
    private readonly Dictionary<ReadKey, ReadContinuation> readContinuations = [];
    private const int MaximumReadContinuations = 16;
    private const long ReadContinuationLifetimeMilliseconds = 10_000;

    public object ReadFile(string bucket, string id, string attachmentId, long offset)
    {
        SafeFiles.Id(id); SafeFiles.Id(attachmentId);
        var key = new ReadKey(Root(bucket), id, attachmentId);
        var now = Environment.TickCount64;
        foreach (var expired in readContinuations.Where(p => p.Value.ExpiresAt <= now).Select(p => p.Key).ToArray())
            readContinuations.Remove(expired);
        readContinuations.TryGetValue(key, out var previous);
        var continuing = previous is not null && offset > 0 && previous.NextOffset == offset;
        readContinuations.Remove(key);
        try
        {
            // Resolve a new read through the normal full-library checks. Only
            // the next chunk of that same read may reuse its resolved folder.
            // No file handles or media bytes are retained between requests.
            var directory = continuing ? previous!.Directory : Find(bucket, id);
            var item = Description.Load(directory);
            if (continuing && (item.Id != id || item.Revision != previous!.Revision)) throw ChangedRead();
            var file = item.Attachments.SingleOrDefault(a => a.Id == attachmentId)
                ?? throw new VaultException("missing-attachment", "附件不存在");
            var path = Path.Combine(directory, file.FileName);
            SafeFiles.RejectLinks(path);
            var info = new FileInfo(path);
            if (continuing && (file.FileName != previous!.FileName || !info.Exists ||
                info.Length != previous.Length || info.LastWriteTimeUtc != previous.LastWriteTimeUtc)) throw ChangedRead();
            using var stream = File.OpenRead(path);
            if (offset < 0 || offset > stream.Length) throw new VaultException("invalid-offset", "读取位置无效");
            stream.Position = offset;
            var buffer = new byte[(int)Math.Min(192 * 1024, stream.Length - offset)];
            stream.ReadExactly(buffer);
            var nextOffset = offset + buffer.Length;
            if (nextOffset < stream.Length)
            {
                if (readContinuations.Count >= MaximumReadContinuations)
                    readContinuations.Remove(readContinuations.MinBy(p => p.Value.ExpiresAt).Key);
                readContinuations[key] = new(directory, item.Revision, file.FileName, stream.Length,
                    info.LastWriteTimeUtc, nextOffset, Environment.TickCount64 + ReadContinuationLifetimeMilliseconds);
            }
            return new { base64 = Convert.ToBase64String(buffer), offset, total = stream.Length, mime = file.Mime };
        }
        catch (Exception ex) when (continuing && ex is IOException or UnauthorizedAccessException or VaultException or JsonException)
        {
            // A moved, removed or edited source cannot silently mix two
            // snapshots. A fresh request at offset zero resolves it again.
            throw ChangedRead();
        }
    }

    private static VaultException ChangedRead() => new("read-changed", "附件读取中断，请重新打开");
}
