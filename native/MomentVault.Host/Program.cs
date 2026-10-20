using System.Text.Json;

namespace MomentVault.Host;

public static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            var origin = args.FirstOrDefault(a => a.StartsWith("chrome-extension://", StringComparison.Ordinal));
            if (origin is not null)
            {
                var identityFile = Path.Combine(AppContext.BaseDirectory, "extension-identity.json");
                using var identity = JsonDocument.Parse(File.ReadAllText(identityFile));
                if (origin != $"chrome-extension://{identity.RootElement.GetProperty("id").GetString()}/") return 3;
            }
            else if (!args.Contains("--stdio-test"))
            { Console.Error.WriteLine("Moment Vault is started by Microsoft Edge Native Messaging."); return 2; }
            var homeIndex = Array.IndexOf(args, "--data-home");
            var dataHome = homeIndex >= 0 && homeIndex + 1 < args.Length ? args[homeIndex + 1]
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MomentVault");
            var store = new VaultStore(dataHome);
            Protocol.Run(Console.OpenStandardInput(), Console.OpenStandardOutput(), store);
            return 0;
        }
        catch (Exception ex)
        {
            // stdout belongs exclusively to the framed browser protocol.
            Console.Error.WriteLine($"Moment Vault host: {ex.GetType().Name}");
            return 1;
        }
    }
}
