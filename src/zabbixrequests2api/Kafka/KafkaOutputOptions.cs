using Confluent.Kafka;

namespace ZabbixRequests2Api.Kafka;

public sealed class KafkaOutputOptions : KafkaClientOptions
{
    public string Topic { get; init; } = string.Empty;

    public string Acks { get; init; } = string.Empty;

    public bool EnableIdempotence { get; init; }

    public int MessageTimeoutMs { get; init; }

    public string SuccessHeaderName { get; init; } = string.Empty;

    public string MethodHeaderName { get; init; } = string.Empty;

    public string ErrorCodeHeaderName { get; init; } = string.Empty;

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

    public bool HasValidAcks()
    {
        return Enum.TryParse<Acks>(Acks, ignoreCase: true, out _);
    }

    private Acks GetAcks()
    {
        return Enum.Parse<Acks>(Acks, ignoreCase: true);
    }
}
