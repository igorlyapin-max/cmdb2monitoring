namespace Cmdb2Monitoring.Kafka;

public sealed record KafkaDeadLetterMessage(
    string Service,
    string ErrorCode,
    string ErrorMessage,
    string? CorrelationId,
    string InputTopic,
    int InputPartition,
    long InputOffset,
    string? InputKey,
    string OriginalPayload,
    string? RulesVersion,
    string? ExceptionType,
    DateTimeOffset OccurredAt);
