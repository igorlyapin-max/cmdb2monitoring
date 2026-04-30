using System.Text.Json;

namespace CmdbKafka2Zabbix.Conversion;

public sealed record CmdbSourceEvent(
    string Source,
    string EventType,
    string? EntityType,
    string? EntityId,
    string? Code,
    string? ClassName,
    string? IpAddress,
    string? DnsName,
    string? ZabbixHostId,
    string? Description,
    string? OperatingSystem,
    string? ZabbixTag,
    IReadOnlyDictionary<string, string> SourceFields,
    DateTimeOffset? ReceivedAt,
    JsonElement Payload);
