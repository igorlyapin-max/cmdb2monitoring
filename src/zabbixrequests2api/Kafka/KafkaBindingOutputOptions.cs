using Confluent.Kafka;

namespace ZabbixRequests2Api.Kafka;

public sealed class KafkaBindingOutputOptions : KafkaClientOptions
{
    public string Topic { get; init; } = string.Empty;

    public string Acks { get; init; } = string.Empty;

    public bool EnableIdempotence { get; init; }

    public int MessageTimeoutMs { get; init; }

    public string EventTypeHeaderName { get; init; } = "binding-event-type";

    public string HostProfileHeaderName { get; init; } = "binding-host-profile";

    public string BindingStatusHeaderName { get; init; } = "binding-status";

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
