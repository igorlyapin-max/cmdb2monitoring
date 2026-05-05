namespace ZabbixBindings2Cmdbuild.Models;

public sealed record ZabbixBindingEvent(
    string Source,
    string EventType,
    string Operation,
    string SourceClass,
    string SourceCardId,
    string? SourceCode,
    string HostProfile,
    bool IsMainProfile,
    string ZabbixHostId,
    string? ZabbixHostName,
    string BindingStatus,
    string? RulesVersion,
    string? SchemaVersion,
    string? RequestId,
    DateTimeOffset? OccurredAt);
