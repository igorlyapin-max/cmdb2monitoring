using Cmdb2Monitoring.State;

namespace Cmdb2Monitoring.Metrics;

public interface IReadinessCheck
{
    string Name { get; }

    Task<ReadinessCheckResult> CheckAsync(CancellationToken cancellationToken);
}

public sealed record ReadinessCheckResult(string Name, bool Ready, string Message);

public sealed record ServiceReadinessResult(bool Ready, DateTimeOffset CheckedAt, IReadOnlyList<ReadinessCheckResult> Checks);

public sealed class DelegateReadinessCheck(
    string name,
    Func<CancellationToken, Task<ReadinessCheckResult>> check) : IReadinessCheck
{
    public string Name { get; } = name;

    public Task<ReadinessCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        return check(cancellationToken);
    }
}

public static class ReadinessProbe
{
    public static async Task<ServiceReadinessResult> CheckAsync(
        IEnumerable<IReadinessCheck> checks,
        CancellationToken cancellationToken)
    {
        var results = new List<ReadinessCheckResult>();
        foreach (var check in checks)
        {
            try
            {
                results.Add(await check.CheckAsync(cancellationToken));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                results.Add(new ReadinessCheckResult(check.Name, false, ex.Message));
            }
        }

        return new ServiceReadinessResult(
            results.All(result => result.Ready),
            DateTimeOffset.UtcNow,
            results);
    }
}

public static class ReadinessChecks
{
    public static IReadinessCheck WritableStateFile(
        string name,
        Func<(string FilePath, string BaseDirectory)> statePathFactory)
    {
        return new DelegateReadinessCheck(name, async cancellationToken =>
        {
            var (filePath, baseDirectory) = statePathFactory();
            if (string.IsNullOrWhiteSpace(filePath))
            {
                return new ReadinessCheckResult(name, false, "Processing state file path is not configured.");
            }

            var resolvedPath = SafeStateFileStore.ResolvePath(filePath, baseDirectory);
            var directory = Path.GetDirectoryName(resolvedPath);
            if (string.IsNullOrWhiteSpace(directory))
            {
                return new ReadinessCheckResult(name, false, $"Processing state directory cannot be resolved for '{resolvedPath}'.");
            }

            Directory.CreateDirectory(directory);
            var probePath = Path.Combine(directory, $".{Path.GetFileName(resolvedPath)}.ready-{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllTextAsync(probePath, "ready", cancellationToken);
                File.Delete(probePath);
                return new ReadinessCheckResult(name, true, $"State directory is writable: {directory}");
            }
            finally
            {
                if (File.Exists(probePath))
                {
                    File.Delete(probePath);
                }
            }
        });
    }
}
