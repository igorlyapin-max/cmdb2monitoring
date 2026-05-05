using Confluent.Kafka;

namespace ZabbixBindings2Cmdbuild.Kafka;

public sealed class KafkaInputOptions : KafkaClientOptions
{
    public string Topic { get; init; } = string.Empty;

    public string GroupId { get; init; } = string.Empty;

    public string AutoOffsetReset { get; init; } = "Earliest";

    public bool EnableAutoCommit { get; init; }

    public int PollTimeoutMs { get; init; } = 1000;

    public ConsumerConfig BuildConsumerConfig()
    {
        var config = new ConsumerConfig
        {
            BootstrapServers = BootstrapServers,
            ClientId = ClientId,
            GroupId = GroupId,
            SecurityProtocol = GetSecurityProtocol(),
            AutoOffsetReset = GetAutoOffsetReset(),
            EnableAutoCommit = EnableAutoCommit,
            EnablePartitionEof = false
        };

        ApplySaslConfig(config);

        return config;
    }

    public bool HasValidAutoOffsetReset()
    {
        return Enum.TryParse<AutoOffsetReset>(AutoOffsetReset, ignoreCase: true, out _);
    }

    private AutoOffsetReset GetAutoOffsetReset()
    {
        return Enum.Parse<AutoOffsetReset>(AutoOffsetReset, ignoreCase: true);
    }
}
