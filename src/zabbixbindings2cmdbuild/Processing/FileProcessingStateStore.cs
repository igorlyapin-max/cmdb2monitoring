using System.Text.Json;
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
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<ProcessingStateDocument>(stream, JsonOptions, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not read processing state from {StatePath}", path);
            return null;
        }
    }

    public async Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken)
    {
        var path = options.Value.FilePath;
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, state, JsonOptions, cancellationToken);
    }
}
