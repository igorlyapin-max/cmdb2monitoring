using Confluent.Kafka;

namespace CmdbWebhooks2Kafka.Kafka;

public abstract class KafkaClientOptions
{
    public string BootstrapServers { get; init; } = string.Empty;

    public string ClientId { get; init; } = string.Empty;

    public string SecurityProtocol { get; init; } = string.Empty;

    public string SaslMechanism { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public string Acks { get; init; } = string.Empty;

    public bool EnableIdempotence { get; init; }

    public int MessageTimeoutMs { get; init; }

    public ProducerConfig BuildProducerConfig()
    {
        var config = new ProducerConfig
        {
            BootstrapServers = BootstrapServers,
            ClientId = ClientId,
            SecurityProtocol = GetSecurityProtocol(),
            Acks = GetAcks(),
            EnableIdempotence = EnableIdempotence,
            MessageTimeoutMs = MessageTimeoutMs
        };

        ApplySaslConfig(config);

        return config;
    }

    public AdminClientConfig BuildAdminClientConfig()
    {
        var config = new AdminClientConfig
        {
            BootstrapServers = BootstrapServers,
            ClientId = $"{ClientId}-admin",
            SecurityProtocol = GetSecurityProtocol()
        };

        ApplySaslConfig(config);

        return config;
    }

    public SecurityProtocol GetSecurityProtocol()
    {
        return Enum.Parse<SecurityProtocol>(SecurityProtocol, ignoreCase: true);
    }

    public Acks GetAcks()
    {
        return Enum.Parse<Acks>(Acks, ignoreCase: true);
    }

    public bool HasValidSecurityProtocol()
    {
        return Enum.TryParse<SecurityProtocol>(SecurityProtocol, ignoreCase: true, out _);
    }

    public bool HasValidAcks()
    {
        return Enum.TryParse<Acks>(Acks, ignoreCase: true, out _);
    }

    public bool HasValidSaslMechanism()
    {
        return string.IsNullOrWhiteSpace(SaslMechanism)
            || Enum.TryParse<SaslMechanism>(SaslMechanism, ignoreCase: true, out _);
    }

    private void ApplySaslConfig(ClientConfig config)
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
