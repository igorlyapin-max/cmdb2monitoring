namespace ZabbixRequests2Api.Processing;

public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    public int DelayBetweenObjectsMs { get; init; } = 50;

    public int MaxRetryAttempts { get; init; } = 3;

    public int RetryDelayMs { get; init; } = 5000;

    public int RetryMaxDelayMs { get; init; } = 30000;

    public double RetryBackoffMultiplier { get; init; } = 2.0;

    public double RetryJitterRatio { get; init; } = 0.2;

    public bool ProtectManagedAggregateHosts { get; init; } = true;

    public string[] ProtectedHostNames { get; init; } = ["cmdb2monitoring-suppression-aggregates"];

    public ProtectedHostTagOptions[] ProtectedHostTags { get; init; } =
    [
        new()
        {
            Tag = "cmdb2monitoring:aggregate",
            Value = "true"
        }
    ];

    public bool HasProtectedHostMarkers()
    {
        return (ProtectedHostNames ?? []).Any(name => !string.IsNullOrWhiteSpace(name))
            || (ProtectedHostTags ?? []).Any(tag => !string.IsNullOrWhiteSpace(tag.Tag));
    }

    public bool HasValidRetryBackoffValues()
    {
        return RetryDelayMs >= 0
            && RetryMaxDelayMs >= RetryDelayMs
            && RetryBackoffMultiplier >= 1
            && RetryJitterRatio is >= 0 and <= 1;
    }
}

public sealed class ProtectedHostTagOptions
{
    public string Tag { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;
}
