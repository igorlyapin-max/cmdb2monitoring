namespace ZabbixRequests2Api.Processing;

public sealed record ProcessingStateDocument(
    string? LastEntityId,
    string? LastMethod,
    string? LastInputTopic,
    int? LastInputPartition,
    long? LastInputOffset,
    string? LastOutputTopic,
    bool OutputPublished,
    bool ZabbixRequestSent,
    bool Success,
    string? ErrorCode,
    DateTimeOffset ProcessedAt);
