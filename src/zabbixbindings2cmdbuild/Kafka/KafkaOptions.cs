namespace ZabbixBindings2Cmdbuild.Kafka;

public sealed class KafkaOptions
{
    public const string SectionName = "Kafka";

    public KafkaInputOptions Input { get; init; } = new();
}
