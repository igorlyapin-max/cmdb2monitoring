using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace Cmdb2Monitoring.Http;

public static class HttpClientTlsConfigurator
{
    public static HttpClientHandler CreateHandler(HttpClientTlsOptions options)
    {
        var handler = new HttpClientHandler();

        if (!options.RejectUnauthorized)
        {
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        else if (!string.IsNullOrWhiteSpace(options.CaCertificatePath))
        {
            var caCertificate = X509CertificateLoader.LoadCertificateFromFile(options.CaCertificatePath);
            handler.ServerCertificateCustomValidationCallback = (_, certificate, chain, errors) =>
            {
                if (errors == SslPolicyErrors.None)
                {
                    return true;
                }

                if (certificate is null || chain is null)
                {
                    return false;
                }

                chain.ChainPolicy.ExtraStore.Add(caCertificate);
                chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                return chain.Build(new X509Certificate2(certificate))
                    && chain.ChainElements
                        .Cast<X509ChainElement>()
                        .Any(element => string.Equals(
                            element.Certificate.Thumbprint,
                            caCertificate.Thumbprint,
                            StringComparison.OrdinalIgnoreCase));
            };
        }

        if (!string.IsNullOrWhiteSpace(options.ClientCertificatePath))
        {
            var certificate = string.IsNullOrWhiteSpace(options.ClientCertificateKeyPath)
                ? LoadClientCertificate(options.ClientCertificatePath, options.ClientCertificatePassword)
                : X509Certificate2.CreateFromPemFile(options.ClientCertificatePath, options.ClientCertificateKeyPath);
            handler.ClientCertificates.Add(certificate);
        }

        return handler;
    }

    private static X509Certificate2 LoadClientCertificate(string path, string password)
    {
        return string.IsNullOrWhiteSpace(password)
            ? X509CertificateLoader.LoadPkcs12FromFile(path, null)
            : X509CertificateLoader.LoadPkcs12FromFile(path, password);
    }
}
