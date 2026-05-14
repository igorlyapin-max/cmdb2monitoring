namespace ZabbixRequests2Api.Processing;

public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    public int DelayBetweenObjectsMs { get; init; } = 2000;

    public int MaxRetryAttempts { get; init; } = 3;

    public int RetryDelayMs { get; init; } = 5000;

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
}

public sealed class ProtectedHostTagOptions
{
    public string Tag { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;
}
