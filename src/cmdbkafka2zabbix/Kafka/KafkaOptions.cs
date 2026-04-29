namespace CmdbKafka2Zabbix.Kafka;

public sealed class KafkaOptions
{
    public const string SectionName = "Kafka";

    public KafkaInputOptions Input { get; init; } = new();

    public KafkaOutputOptions Output { get; init; } = new();
}
