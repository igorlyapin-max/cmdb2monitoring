using Cmdb2Monitoring.Transport;
using Confluent.Kafka;
using Microsoft.Extensions.Hosting;

namespace Cmdb2Monitoring.Security;

public static class ProductionSecurityGuards
{
    public static bool AllowsPlainHttp(IHostEnvironment environment, TransportOptions options)
    {
        return !environment.IsProduction()
            || options.IsHttps
            || options.AllowPlainHttp;
    }

    public static bool AllowsKafkaProtocol(IHostEnvironment environment, SecurityProtocol protocol, bool allowPlaintext)
    {
        return !environment.IsProduction()
            || allowPlaintext
            || protocol is SecurityProtocol.Ssl or SecurityProtocol.SaslSsl;
    }

    public static bool AllowsKafkaProtocol(IHostEnvironment environment, string securityProtocol, bool allowPlaintext)
    {
        return !Enum.TryParse<SecurityProtocol>(securityProtocol, ignoreCase: true, out var protocol)
            || AllowsKafkaProtocol(environment, protocol, allowPlaintext);
    }

    public static bool AllowsHttpEndpoint(IHostEnvironment environment, string url, bool allowInsecureHttp)
    {
        return !environment.IsProduction()
            || allowInsecureHttp
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
    }

    public static bool AllowsWildcardAllowedHosts(
        IHostEnvironment environment,
        string? allowedHosts,
        bool allowWildcardAllowedHosts)
    {
        return !environment.IsProduction()
            || allowWildcardAllowedHosts
            || !string.Equals(allowedHosts?.Trim(), "*", StringComparison.Ordinal);
    }

    public static bool IsStrongSecret(string value)
    {
        return !string.IsNullOrWhiteSpace(value)
            && value.Length >= 32
            && !value.Contains("dev-", StringComparison.OrdinalIgnoreCase)
            && !value.Contains("password", StringComparison.OrdinalIgnoreCase)
            && !value.Contains("token", StringComparison.OrdinalIgnoreCase);
    }
}
