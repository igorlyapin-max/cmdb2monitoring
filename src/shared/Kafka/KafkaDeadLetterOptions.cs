namespace Cmdb2Monitoring.Kafka;

public sealed class KafkaDeadLetterOptions
{
    public const string SectionName = "DeadLetter";

    public bool Enabled { get; init; } = true;

    public string Topic { get; init; } = string.Empty;

    public string ServiceHeaderName { get; init; } = "service";

    public string ErrorCodeHeaderName { get; init; } = "errorCode";

    public string CorrelationHeaderName { get; init; } = KafkaCorrelation.HeaderName;
}
