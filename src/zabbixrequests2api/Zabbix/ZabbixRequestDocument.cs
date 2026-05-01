using System.Text.Json;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixRequestDocument
{
    public string RawJson { get; init; } = string.Empty;

    public string ZabbixJson { get; init; } = string.Empty;

    public JsonElement Root { get; init; }

    public JsonElement Params { get; init; }

    public JsonElement Id { get; init; }

    public string Method { get; init; } = string.Empty;

    public string? RequestId { get; init; }

    public string? EntityId { get; init; }

    public string? Host { get; init; }

    public string? HostProfileName { get; init; }

    public string? FallbackForMethod { get; init; }

    public bool CreateOnUpdateWhenMissing { get; init; }

    public JsonElement FallbackUpdateParams { get; init; }

    public JsonElement FallbackCreateParams { get; init; }
}
