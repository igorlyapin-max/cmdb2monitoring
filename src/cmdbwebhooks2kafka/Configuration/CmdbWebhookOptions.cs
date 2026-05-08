namespace CmdbWebhooks2Kafka.Configuration;

public sealed class CmdbWebhookOptions
{
    public const string SectionName = "CmdbWebhook";

    public string Route { get; init; } = string.Empty;

    public string EndpointTag { get; init; } = string.Empty;

    public string AuthorizationMode { get; init; } = "Static";

    public string BearerToken { get; init; } = string.Empty;

    public string Source { get; init; } = string.Empty;

    public string UnknownEventType { get; init; } = string.Empty;

    public string[] EventTypeFields { get; init; } = [];

    public string[] EntityTypeFields { get; init; } = [];

    public string[] EntityIdFields { get; init; } = [];

    public string[] SearchContainers { get; init; } = [];

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
