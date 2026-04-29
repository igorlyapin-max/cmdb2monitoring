namespace ZabbixRequests2Api.Processing;

public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    public int DelayBetweenObjectsMs { get; init; } = 2000;

    public int MaxRetryAttempts { get; init; } = 3;

    public int RetryDelayMs { get; init; } = 5000;
}
