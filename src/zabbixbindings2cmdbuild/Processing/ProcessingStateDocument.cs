namespace ZabbixBindings2Cmdbuild.Processing;

public sealed record ProcessingStateDocument(
    string? LastSourceClass,
    string? LastSourceCardId,
    string? LastHostProfile,
    string? LastInputTopic,
    int? LastInputPartition,
    long? LastInputOffset,
    bool Success,
    string? ErrorCode,
    DateTimeOffset ProcessedAt);
