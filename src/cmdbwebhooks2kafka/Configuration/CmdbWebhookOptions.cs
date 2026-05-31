namespace CmdbWebhooks2Kafka.Configuration;

public sealed class CmdbWebhookOptions
{
    public const string SectionName = "CmdbWebhook";

    public string Route { get; init; } = string.Empty;

    public string EndpointTag { get; init; } = string.Empty;

    public string AuthorizationMode { get; init; } = "Static";

    public string BearerToken { get; init; } = string.Empty;

    public bool AllowDisabledAuthorizationInProduction { get; init; }

    public string Source { get; init; } = string.Empty;

    public string UnknownEventType { get; init; } = string.Empty;

    public string[] EventTypeFields { get; init; } = [];

    public string[] EntityTypeFields { get; init; } = [];

    public string[] EntityIdFields { get; init; } = [];

    public string[] SearchContainers { get; init; } = [];

    public WebhookRateLimitOptions RateLimit { get; init; } = new();

    public bool RequiresBearerToken()
    {
        return string.Equals(AuthorizationMode, "Static", StringComparison.OrdinalIgnoreCase);
    }

    public bool HasValidAuthorizationMode()
    {
        return string.Equals(AuthorizationMode, "Static", StringComparison.OrdinalIgnoreCase)
            || string.Equals(AuthorizationMode, "Disabled", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed class WebhookRateLimitOptions
{
    public bool Enabled { get; init; } = true;

    public int PermitLimit { get; init; } = 600;

    public int WindowSeconds { get; init; } = 60;

    public bool HasValidValues()
    {
        return PermitLimit > 0 && WindowSeconds > 0;
    }
}
