namespace Cmdb2Monitoring.Transport;

public sealed class TransportOptions
{
    public const string SectionName = "Transport";

    public string Mode { get; init; } = "Http";

    public string[] Urls { get; init; } = [];

    public string Url { get; init; } = string.Empty;

    public TransportCertificateOptions Certificate { get; init; } = new();

    public bool AllowPlainHttp { get; init; }

    public bool IsHttps => string.Equals(Mode, "Https", StringComparison.OrdinalIgnoreCase);

    public bool HasValidMode()
    {
        return string.Equals(Mode, "Http", StringComparison.OrdinalIgnoreCase)
            || string.Equals(Mode, "Https", StringComparison.OrdinalIgnoreCase);
    }

    public string[] ResolveUrls(string fallbackHttpUrl)
    {
        if (Urls.Length > 0)
        {
            return Urls;
        }

        if (!string.IsNullOrWhiteSpace(Url))
        {
            return [Url];
        }

        return IsHttps
            ? [fallbackHttpUrl.Replace("http://", "https://", StringComparison.OrdinalIgnoreCase)]
            : [fallbackHttpUrl];
    }
}

public sealed class TransportCertificateOptions
{
    public string Path { get; init; } = string.Empty;

    public string KeyPath { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;
}
