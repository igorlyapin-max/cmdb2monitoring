using System.Text.Json;
using Cmdb2Monitoring.State;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Processing;

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
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return null;
        }

        try
        {
            return await SafeStateFileStore.ReadAsync<ProcessingStateDocument>(
                filePath,
                options.Value.BaseDirectory,
                JsonOptions,
                cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or InvalidOperationException)
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

        await SafeStateFileStore.WriteAsync(filePath, options.Value.BaseDirectory, state, JsonOptions, cancellationToken);
    }
}
