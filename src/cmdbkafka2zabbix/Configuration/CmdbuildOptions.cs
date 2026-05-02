namespace CmdbKafka2Zabbix.Configuration;

public sealed class CmdbuildOptions
{
    public const string SectionName = "Cmdbuild";

    public string BaseUrl { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public int RequestTimeoutMs { get; init; } = 10000;

    public int MaxPathDepth { get; init; } = 2;

    public bool Enabled { get; init; } = true;

    public bool HasCredentials =>
        !string.IsNullOrWhiteSpace(Username)
        && !string.IsNullOrWhiteSpace(Password);

    public bool CanResolve =>
        Enabled
        && !string.IsNullOrWhiteSpace(BaseUrl)
        && HasCredentials;
}
