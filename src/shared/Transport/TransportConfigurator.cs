using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Configuration;

namespace Cmdb2Monitoring.Transport;

public static class TransportConfigurator
{
    public static void Configure(WebHostBuilderContext context, KestrelServerOptions kestrelOptions)
    {
        var options = context.Configuration.GetSection(TransportOptions.SectionName).Get<TransportOptions>() ?? new();
        if (!options.IsHttps || string.IsNullOrWhiteSpace(options.Certificate.Path))
        {
            return;
        }

        kestrelOptions.ConfigureHttpsDefaults(httpsOptions =>
        {
            httpsOptions.ServerCertificate = LoadCertificate(options.Certificate);
        });
    }

    public static void UseConfiguredUrls(
        IWebHostBuilder webHostBuilder,
        IConfiguration configuration,
        string fallbackHttpUrl)
    {
        var options = configuration.GetSection(TransportOptions.SectionName).Get<TransportOptions>() ?? new();
        var aspnetcoreUrls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
        var fallbackUrl = string.IsNullOrWhiteSpace(aspnetcoreUrls)
            ? fallbackHttpUrl
            : aspnetcoreUrls;
        webHostBuilder.UseUrls(options.ResolveUrls(fallbackUrl)
            .SelectMany(url => url.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .ToArray());
        webHostBuilder.ConfigureKestrel(Configure);
    }

    private static X509Certificate2 LoadCertificate(TransportCertificateOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.KeyPath))
        {
            return X509Certificate2.CreateFromPemFile(options.Path, options.KeyPath);
        }

        return string.IsNullOrWhiteSpace(options.Password)
            ? X509CertificateLoader.LoadPkcs12FromFile(options.Path, null)
            : X509CertificateLoader.LoadPkcs12FromFile(options.Path, options.Password);
    }
}
