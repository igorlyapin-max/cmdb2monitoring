using System.Text.Json;

namespace Cmdb2Monitoring.State;

public static class SafeStateFileStore
{
    public static string ResolvePath(string filePath, string? baseDirectory = null)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            throw new InvalidOperationException("Processing state file path is required.");
        }

        var basePath = Path.GetFullPath(string.IsNullOrWhiteSpace(baseDirectory) ? "." : baseDirectory);
        var resolvedPath = Path.IsPathRooted(filePath)
            ? Path.GetFullPath(filePath)
            : Path.GetFullPath(Path.Combine(basePath, filePath));

        if (!IsPathInside(basePath, resolvedPath))
        {
            throw new InvalidOperationException($"Processing state file path '{resolvedPath}' escapes base directory '{basePath}'.");
        }

        return resolvedPath;
    }

    public static async Task<T?> ReadAsync<T>(
        string filePath,
        string? baseDirectory,
        JsonSerializerOptions jsonOptions,
        CancellationToken cancellationToken)
    {
        var resolvedPath = ResolvePath(filePath, baseDirectory);
        if (!File.Exists(resolvedPath))
        {
            return default;
        }

        await using var stream = File.OpenRead(resolvedPath);
        return await JsonSerializer.DeserializeAsync<T>(stream, jsonOptions, cancellationToken);
    }

    public static async Task WriteAsync<T>(
        string filePath,
        string? baseDirectory,
        T value,
        JsonSerializerOptions jsonOptions,
        CancellationToken cancellationToken)
    {
        var resolvedPath = ResolvePath(filePath, baseDirectory);
        var directory = Path.GetDirectoryName(resolvedPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var tempPath = $"{resolvedPath}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = new FileStream(
                tempPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 16 * 1024,
                FileOptions.WriteThrough | FileOptions.Asynchronous))
            {
                await JsonSerializer.SerializeAsync(stream, value, jsonOptions, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }

            File.Move(tempPath, resolvedPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }

    private static bool IsPathInside(string basePath, string candidatePath)
    {
        var normalizedBase = EnsureTrailingSeparator(Path.GetFullPath(basePath));
        var normalizedCandidate = Path.GetFullPath(candidatePath);
        return normalizedCandidate.StartsWith(normalizedBase, StringComparison.Ordinal)
            || string.Equals(normalizedCandidate.TrimEnd(Path.DirectorySeparatorChar), normalizedBase.TrimEnd(Path.DirectorySeparatorChar), StringComparison.Ordinal);
    }

    private static string EnsureTrailingSeparator(string path)
    {
        return path.EndsWith(Path.DirectorySeparatorChar)
            ? path
            : $"{path}{Path.DirectorySeparatorChar}";
    }
}
