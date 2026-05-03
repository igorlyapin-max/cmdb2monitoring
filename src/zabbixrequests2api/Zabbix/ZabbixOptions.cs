namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixOptions
{
    public const string SectionName = "Zabbix";

    public string ApiEndpoint { get; init; } = string.Empty;

    public string AuthMode { get; init; } = "LoginOrToken";

    public string ApiToken { get; init; } = string.Empty;

    public string User { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public int RequestTimeoutMs { get; init; } = 30000;

    public bool ValidateHostGroups { get; init; } = true;

    public bool ValidateTemplates { get; init; } = true;

    public bool ValidateTemplateGroups { get; init; } = true;

    public bool ValidateTemplateCompatibility { get; init; } = true;

    public bool AllowDynamicHostGroupCreate { get; init; } = true;

    public bool HasValidAuthMode()
    {
        return string.Equals(AuthMode, "None", StringComparison.OrdinalIgnoreCase)
            || string.Equals(AuthMode, "Token", StringComparison.OrdinalIgnoreCase)
            || string.Equals(AuthMode, "Login", StringComparison.OrdinalIgnoreCase)
            || string.Equals(AuthMode, "LoginOrToken", StringComparison.OrdinalIgnoreCase);
    }
}
