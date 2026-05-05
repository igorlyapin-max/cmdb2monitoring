using System.Text.Json;

namespace ZabbixBindings2Cmdbuild.Models;

public sealed class ZabbixBindingEventReader
{
    public ZabbixBindingEvent Read(string messageValue)
    {
        using var document = JsonDocument.Parse(messageValue);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("Zabbix binding event root must be a JSON object.");
        }

        return new ZabbixBindingEvent(
            Source: ReadString(root, "source") ?? "zabbixrequests2api",
            EventType: RequireString(root, "eventType"),
            Operation: ReadString(root, "operation") ?? string.Empty,
            SourceClass: RequireString(root, "sourceClass"),
            SourceCardId: RequireString(root, "sourceCardId"),
            SourceCode: ReadString(root, "sourceCode"),
            HostProfile: ReadString(root, "hostProfile") ?? "main",
            IsMainProfile: ReadBool(root, "isMainProfile"),
            ZabbixHostId: RequireString(root, "zabbixHostId"),
            ZabbixHostName: ReadString(root, "zabbixHostName"),
            BindingStatus: ReadString(root, "bindingStatus") ?? "active",
            RulesVersion: ReadString(root, "rulesVersion"),
            SchemaVersion: ReadString(root, "schemaVersion"),
            RequestId: ReadString(root, "requestId"),
            OccurredAt: ReadDateTimeOffset(root, "occurredAt"));
    }

    private static string RequireString(JsonElement element, string propertyName)
    {
        var value = ReadString(element, propertyName);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new JsonException($"Zabbix binding event field '{propertyName}' is required.");
        }

        return value;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
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

    private static bool ReadBool(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
        {
            return false;
        }

        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(value.GetString(), out var parsed) && parsed,
            _ => false
        };
    }

    private static DateTimeOffset? ReadDateTimeOffset(JsonElement element, string propertyName)
    {
        var value = ReadString(element, propertyName);
        return DateTimeOffset.TryParse(value, out var result) ? result : null;
    }
}
