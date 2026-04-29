namespace CmdbKafka2Zabbix.Processing;

public sealed record ProcessingStateDocument(
    string? LastEntityId,
    string? LastEventType,
    string? LastInputTopic,
    int? LastInputPartition,
    long? LastInputOffset,
    string? LastOutputTopic,
    bool OutputPublished,
    string? SkipReason,
    DateTimeOffset ProcessedAt);
