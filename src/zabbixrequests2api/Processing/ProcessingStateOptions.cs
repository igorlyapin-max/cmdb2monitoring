namespace ZabbixRequests2Api.Processing;

public sealed class ProcessingStateOptions
{
    public const string SectionName = "ProcessingState";

    public string FilePath { get; init; } = string.Empty;

    public bool WriteOnSuccess { get; init; } = true;
}
