namespace CmdbKafka2Zabbix.Processing;

public sealed class ProcessingStateOptions
{
    public const string SectionName = "ProcessingState";

    public string FilePath { get; init; } = string.Empty;

    public string BaseDirectory { get; init; } = ".";

    public bool WriteOnSuccess { get; init; } = true;
}
