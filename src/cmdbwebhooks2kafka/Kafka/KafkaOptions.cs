namespace CmdbWebhooks2Kafka.Kafka;

public sealed class KafkaOptions : KafkaClientOptions
{
    public const string SectionName = "Kafka";

    public string Topic { get; init; } = string.Empty;

    public string SourceHeaderName { get; init; } = string.Empty;

    public string EventTypeHeaderName { get; init; } = string.Empty;
}
