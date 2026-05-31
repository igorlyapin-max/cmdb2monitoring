namespace Cmdb2Monitoring.Http;

public sealed class HttpClientTlsOptions
{
    public string CaCertificatePath { get; init; } = string.Empty;

    public string ClientCertificatePath { get; init; } = string.Empty;

    public string ClientCertificateKeyPath { get; init; } = string.Empty;

    public string ClientCertificatePassword { get; init; } = string.Empty;

    public bool RejectUnauthorized { get; init; } = true;

    public bool AllowInsecureHttp { get; init; }
}
