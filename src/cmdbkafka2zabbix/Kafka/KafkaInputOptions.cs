using Confluent.Kafka;

namespace CmdbKafka2Zabbix.Kafka;

public sealed class KafkaInputOptions : KafkaClientOptions
{
    public string Topic { get; init; } = string.Empty;

    public string GroupId { get; init; } = string.Empty;

    public string AutoOffsetReset { get; init; } = "Earliest";

    public bool EnableAutoCommit { get; init; }

    public int PollTimeoutMs { get; init; } = 1000;

    public int ReadinessProbeIntervalMs { get; init; } = 10000;

    public int ReadinessProbeTimeoutMs { get; init; } = 3000;

    public AdminClientConfig BuildAdminConfig()
    {
        var config = new AdminClientConfig { BootstrapServers = BootstrapServers, ClientId = $"{ClientId}-readiness", SecurityProtocol = GetSecurityProtocol() };
        ApplySaslConfig(config);
        ApplySslConfig(config);
        return config;
    }

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
        ApplySslConfig(config);

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
