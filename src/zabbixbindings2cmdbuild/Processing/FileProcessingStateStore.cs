using System.Text.Json;
using Cmdb2Monitoring.State;
using Microsoft.Extensions.Options;

namespace ZabbixBindings2Cmdbuild.Processing;

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
        var path = options.Value.FilePath;
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        try
        {
            return await SafeStateFileStore.ReadAsync<ProcessingStateDocument>(
                path,
                options.Value.BaseDirectory,
                JsonOptions,
                cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Could not read processing state from {StatePath}", path);
            return null;
        }
    }

    public async Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken)
    {
        await SafeStateFileStore.WriteAsync(options.Value.FilePath, options.Value.BaseDirectory, state, JsonOptions, cancellationToken);
    }
}
