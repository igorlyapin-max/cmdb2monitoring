using Confluent.Kafka;

namespace ZabbixBindings2Cmdbuild.Kafka;

public abstract class KafkaClientOptions
{
    public string BootstrapServers { get; init; } = string.Empty;

    public string ClientId { get; init; } = string.Empty;

    public string SecurityProtocol { get; init; } = string.Empty;

    public string SaslMechanism { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public string SslCaLocation { get; init; } = string.Empty;

    public string SslCertificateLocation { get; init; } = string.Empty;

    public string SslKeyLocation { get; init; } = string.Empty;

    public string SslKeyPassword { get; init; } = string.Empty;

    public string SslEndpointIdentificationAlgorithm { get; init; } = "Https";

    public bool AllowPlaintextKafka { get; init; }

    public SecurityProtocol GetSecurityProtocol()
    {
        return Enum.Parse<SecurityProtocol>(SecurityProtocol, ignoreCase: true);
    }

    public bool HasValidSecurityProtocol()
    {
        return Enum.TryParse<SecurityProtocol>(SecurityProtocol, ignoreCase: true, out _);
    }

    public bool HasValidSaslMechanism()
    {
        return string.IsNullOrWhiteSpace(SaslMechanism)
            || Enum.TryParse<SaslMechanism>(SaslMechanism, ignoreCase: true, out _);
    }

    public bool HasValidSslEndpointIdentificationAlgorithm()
    {
        return string.IsNullOrWhiteSpace(SslEndpointIdentificationAlgorithm)
            || Enum.TryParse<SslEndpointIdentificationAlgorithm>(SslEndpointIdentificationAlgorithm, ignoreCase: true, out _);
    }

    protected void ApplySaslConfig(ClientConfig config)
    {
        if (config.SecurityProtocol is not (Confluent.Kafka.SecurityProtocol.SaslPlaintext or Confluent.Kafka.SecurityProtocol.SaslSsl))
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(SaslMechanism))
        {
            config.SaslMechanism = Enum.Parse<SaslMechanism>(SaslMechanism, ignoreCase: true);
        }

        if (!string.IsNullOrWhiteSpace(Username))
        {
            config.SaslUsername = Username;
        }

        if (!string.IsNullOrWhiteSpace(Password))
        {
            config.SaslPassword = Password;
        }
    }

    protected void ApplySslConfig(ClientConfig config)
    {
        if (config.SecurityProtocol is not (Confluent.Kafka.SecurityProtocol.Ssl or Confluent.Kafka.SecurityProtocol.SaslSsl))
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(SslCaLocation))
        {
            config.SslCaLocation = SslCaLocation;
        }

        if (!string.IsNullOrWhiteSpace(SslCertificateLocation))
        {
            config.SslCertificateLocation = SslCertificateLocation;
        }

        if (!string.IsNullOrWhiteSpace(SslKeyLocation))
        {
            config.SslKeyLocation = SslKeyLocation;
        }

        if (!string.IsNullOrWhiteSpace(SslKeyPassword))
        {
            config.SslKeyPassword = SslKeyPassword;
        }

        if (!string.IsNullOrWhiteSpace(SslEndpointIdentificationAlgorithm))
        {
            config.SslEndpointIdentificationAlgorithm = Enum.Parse<SslEndpointIdentificationAlgorithm>(
                SslEndpointIdentificationAlgorithm,
                ignoreCase: true);
        }
    }
}
