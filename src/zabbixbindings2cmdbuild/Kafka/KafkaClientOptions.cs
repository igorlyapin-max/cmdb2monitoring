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
}
