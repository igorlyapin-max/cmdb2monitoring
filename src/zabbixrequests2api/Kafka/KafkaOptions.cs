namespace ZabbixRequests2Api.Kafka;

public sealed class KafkaOptions
{
    public const string SectionName = "Kafka";

    public KafkaInputOptions Input { get; init; } = new();

    public KafkaOutputOptions Output { get; init; } = new();
}
