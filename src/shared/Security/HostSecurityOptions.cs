namespace Cmdb2Monitoring.Security;

public sealed class HostSecurityOptions
{
    public const string SectionName = "HostSecurity";

    public bool AllowWildcardAllowedHosts { get; init; }
}
