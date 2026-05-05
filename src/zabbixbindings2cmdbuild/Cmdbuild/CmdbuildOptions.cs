namespace ZabbixBindings2Cmdbuild.Cmdbuild;

public sealed class CmdbuildOptions
{
    public const string SectionName = "Cmdbuild";

    public string BaseUrl { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public int RequestTimeoutMs { get; init; } = 10000;

    public string MainHostIdAttributeName { get; init; } = "zabbix_main_hostid";

    public string BindingClassName { get; init; } = "ZabbixHostBinding";

    public int BindingLookupLimit { get; init; } = 1000;
}
