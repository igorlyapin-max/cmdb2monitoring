using System.Text.Json;
using CmdbKafka2Zabbix.Rules;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbEventReader
{
    public CmdbSourceEvent Read(string messageValue, ConversionRulesDocument rules)
    {
        using var document = JsonDocument.Parse(messageValue);
        var root = document.RootElement;
        var payload = root.TryGetProperty("payload", out var payloadElement)
            ? payloadElement
            : root;

        var eventType = ReadString(root, "eventType") ?? ReadString(payload, "eventType") ?? "unknown";
        var entityType = ReadString(root, "entityType");
        var entityId = ReadString(root, "entityId");
        var source = ReadString(root, "source") ?? "cmdbuild";
        var receivedAt = ReadDateTimeOffset(root, "receivedAt");

        var configuredEntityId = ReadConfiguredField(payload, rules, "entityId");
        var configuredCode = ReadConfiguredField(payload, rules, "code");
        var configuredClassName = ReadConfiguredField(payload, rules, "className");
        var configuredIpAddress = ReadConfiguredField(payload, rules, "ipAddress");
        var configuredZabbixHostId = ReadConfiguredField(payload, rules, "zabbixHostId");
        var configuredDescription = ReadConfiguredField(payload, rules, "description");
        var configuredOperatingSystem = ReadConfiguredField(payload, rules, "os");
        var configuredZabbixTag = ReadConfiguredField(payload, rules, "zabbixTag");

        return new CmdbSourceEvent(
            Source: source,
            EventType: eventType,
            EntityType: entityType ?? configuredClassName,
            EntityId: configuredEntityId ?? entityId,
            Code: configuredCode,
            ClassName: configuredClassName ?? entityType,
            IpAddress: configuredIpAddress,
            ZabbixHostId: configuredZabbixHostId,
            Description: configuredDescription,
            OperatingSystem: configuredOperatingSystem,
            ZabbixTag: configuredZabbixTag,
            ReceivedAt: receivedAt,
            Payload: payload.Clone());
    }

    private static string? ReadConfiguredField(JsonElement payload, ConversionRulesDocument rules, string fieldName)
    {
        if (!rules.Source.Fields.TryGetValue(fieldName, out var fieldRule) || string.IsNullOrWhiteSpace(fieldRule.Source))
        {
            return null;
        }

        return ReadString(payload, fieldRule.Source);
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!element.TryGetProperty(propertyName, out var value))
        {
            foreach (var property in element.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    break;
                }
            }
        }

        if (value.ValueKind == JsonValueKind.Undefined)
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => bool.TrueString,
            JsonValueKind.False => bool.FalseString,
            _ => null
        };
    }

    private static DateTimeOffset? ReadDateTimeOffset(JsonElement element, string propertyName)
    {
        var value = ReadString(element, propertyName);
        return DateTimeOffset.TryParse(value, out var result) ? result : null;
    }
}
