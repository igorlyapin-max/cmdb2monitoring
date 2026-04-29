namespace CmdbWebhooks2Kafka.Kafka;

public sealed class KafkaTopicProvisioningOptions
{
    public bool Enabled { get; init; }

    public int Partitions { get; init; } = 1;

    public short ReplicationFactor { get; init; } = 1;

    public int RequestTimeoutMs { get; init; } = 10000;

    public bool FailOnError { get; init; }
}
