using Confluent.Kafka;
using Microsoft.Extensions.Logging;

namespace ZabbixBindings2Cmdbuild.Configuration;

public sealed class ElkLoggingOptions
{
    public const string SectionName = "ElkLogging";

    public bool Enabled { get; init; }

    public string Mode { get; init; } = "Kafka";

    public ElkDestinationOptions Elk { get; init; } = new();

    public KafkaLogDestinationOptions Kafka { get; init; } = new();

    public bool HasValidMode()
    {
        return string.Equals(Mode, "Kafka", StringComparison.OrdinalIgnoreCase)
            || string.Equals(Mode, "Elk", StringComparison.OrdinalIgnoreCase)
            || string.Equals(Mode, "Both", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed class ElkDestinationOptions
{
    public bool Enabled { get; init; }

    public string Endpoint { get; init; } = string.Empty;

    public string Index { get; init; } = string.Empty;

    public string ApiKey { get; init; } = string.Empty;
}

public sealed class KafkaLogDestinationOptions
{
    public bool Enabled { get; init; }

    public string BootstrapServers { get; init; } = string.Empty;

    public string Topic { get; init; } = string.Empty;

    public string ClientId { get; init; } = string.Empty;

    public string SecurityProtocol { get; init; } = string.Empty;

    public string SaslMechanism { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;

    public string Password { get; init; } = string.Empty;

    public string Acks { get; init; } = string.Empty;

    public bool EnableIdempotence { get; init; }

    public int MessageTimeoutMs { get; init; }

    public string MinimumLevel { get; init; } = "Information";

    public string ServiceName { get; init; } = string.Empty;

    public string Environment { get; init; } = string.Empty;

    public int FlushTimeoutMs { get; init; } = 5000;

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

        if (config.SecurityProtocol is not (Confluent.Kafka.SecurityProtocol.SaslPlaintext or Confluent.Kafka.SecurityProtocol.SaslSsl))
        {
            return config;
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

        return config;
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

    public bool HasValidAcks()
    {
        return Enum.TryParse<Acks>(Acks, ignoreCase: true, out _);
    }

    public bool HasValidMinimumLevel()
    {
        return Enum.TryParse<LogLevel>(MinimumLevel, ignoreCase: true, out _);
    }

    public LogLevel GetMinimumLevel()
    {
        return Enum.Parse<LogLevel>(MinimumLevel, ignoreCase: true);
    }

    private SecurityProtocol GetSecurityProtocol()
    {
        return Enum.Parse<SecurityProtocol>(SecurityProtocol, ignoreCase: true);
    }

    private Acks GetAcks()
    {
        return Enum.Parse<Acks>(Acks, ignoreCase: true);
    }
}
