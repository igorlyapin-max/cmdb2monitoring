using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Processing;

public sealed class FileProcessingStateStore(
    IOptions<ProcessingStateOptions> options,
    ILogger<FileProcessingStateStore> logger) : IProcessingStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    public async Task<ProcessingStateDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var filePath = options.Value.FilePath;
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(filePath);
            return await JsonSerializer.DeserializeAsync<ProcessingStateDocument>(stream, JsonOptions, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Failed to read processing state from {StateFilePath}", filePath);
            return null;
        }
    }

    public async Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteOnSuccess)
        {
            return;
        }

        var filePath = options.Value.FilePath;
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return;
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(filePath));
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var stream = File.Create(filePath);
        await JsonSerializer.SerializeAsync(stream, state, JsonOptions, cancellationToken);
    }
}
