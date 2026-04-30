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
        var sourceFields = ReadConfiguredFields(payload, rules);

        var configuredEntityId = ReadConfiguredField(sourceFields, "entityId");
        var configuredCode = ReadConfiguredField(sourceFields, "code");
        var configuredClassName = ReadConfiguredField(sourceFields, "className");
        var configuredIpAddress = ReadConfiguredField(sourceFields, "ipAddress");
        var configuredDnsName = ReadConfiguredField(sourceFields, "dnsName");
        var configuredZabbixHostId = ReadConfiguredField(sourceFields, "zabbixHostId");
        var configuredDescription = ReadConfiguredField(sourceFields, "description");
        var configuredOperatingSystem = ReadConfiguredField(sourceFields, "os");
        var configuredZabbixTag = ReadConfiguredField(sourceFields, "zabbixTag");

        return new CmdbSourceEvent(
            Source: source,
            EventType: eventType,
            EntityType: entityType ?? configuredClassName,
            EntityId: configuredEntityId ?? entityId,
            Code: configuredCode,
            ClassName: configuredClassName ?? entityType,
            IpAddress: configuredIpAddress,
            DnsName: configuredDnsName,
            ZabbixHostId: configuredZabbixHostId,
            Description: configuredDescription,
            OperatingSystem: configuredOperatingSystem,
            ZabbixTag: configuredZabbixTag,
            SourceFields: sourceFields,
            ReceivedAt: receivedAt,
            Payload: payload.Clone());
    }

    private static Dictionary<string, string> ReadConfiguredFields(JsonElement payload, ConversionRulesDocument rules)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (fieldName, fieldRule) in rules.Source.Fields)
        {
            var sourceNames = SourceNames(fieldRule).ToArray();
            if (sourceNames.Length == 0)
            {
                continue;
            }

            var value = sourceNames
                .Select(sourceName => ReadString(payload, sourceName))
                .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
            if (!string.IsNullOrWhiteSpace(value))
            {
                values[fieldName] = value;
            }
        }

        return values;
    }

    private static IEnumerable<string> SourceNames(SourceFieldRule rule)
    {
        if (!string.IsNullOrWhiteSpace(rule.Source))
        {
            yield return rule.Source;
        }

        foreach (var source in rule.Sources)
        {
            if (!string.IsNullOrWhiteSpace(source))
            {
                yield return source;
            }
        }
    }

    private static string? ReadConfiguredField(IReadOnlyDictionary<string, string> sourceFields, string fieldName)
    {
        return sourceFields.TryGetValue(fieldName, out var value) ? value : null;
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
