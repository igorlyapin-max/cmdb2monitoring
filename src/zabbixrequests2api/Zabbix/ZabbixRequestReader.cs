using System.Text.Json;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixRequestReader
{
    private const string MetadataPropertyName = "cmdb2monitoring";

    public ZabbixRequestDocument Read(string? key, string messageValue, string? hostOverride = null)
    {
        using var document = JsonDocument.Parse(messageValue);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("Zabbix request root must be a JSON object.");
        }

        var method = ReadString(root, "method") ?? string.Empty;
        var metadata = root.TryGetProperty(MetadataPropertyName, out var metadataElement)
            && metadataElement.ValueKind == JsonValueKind.Object
                ? metadataElement
                : default;
        var parameters = root.TryGetProperty("params", out var paramsElement)
            ? paramsElement.Clone()
            : default;
        var id = root.TryGetProperty("id", out var idElement)
            ? idElement.Clone()
            : default;
        var fallbackUpdateParams = metadata.ValueKind == JsonValueKind.Object
            && metadata.TryGetProperty("fallbackUpdateParams", out var updateParams)
            && updateParams.ValueKind == JsonValueKind.Object
                ? updateParams.Clone()
                : default;

        return new ZabbixRequestDocument
        {
            RawJson = messageValue,
            ZabbixJson = BuildZabbixJson(messageValue, root),
            Root = root.Clone(),
            Params = parameters,
            Id = id,
            Method = method,
            RequestId = ReadScalar(id),
            EntityId = key,
            Host = hostOverride ?? ReadHost(method, parameters) ?? ReadString(metadata, "host"),
            FallbackForMethod = ReadString(metadata, "fallbackForMethod"),
            FallbackUpdateParams = fallbackUpdateParams
        };
    }

    private static string BuildZabbixJson(string rawJson, JsonElement root)
    {
        if (!root.TryGetProperty(MetadataPropertyName, out _))
        {
            return rawJson;
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var property in root.EnumerateObject())
            {
                if (string.Equals(property.Name, MetadataPropertyName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string? ReadHost(string method, JsonElement parameters)
    {
        if (parameters.ValueKind == JsonValueKind.Object)
        {
            var host = ReadString(parameters, "host");
            if (!string.IsNullOrWhiteSpace(host))
            {
                return host;
            }

            if (string.Equals(method, "host.get", StringComparison.OrdinalIgnoreCase)
                && parameters.TryGetProperty("filter", out var filter)
                && filter.ValueKind == JsonValueKind.Object
                && filter.TryGetProperty("host", out var hostFilter)
                && hostFilter.ValueKind == JsonValueKind.Array
                && hostFilter.GetArrayLength() > 0)
            {
                return ReadScalar(hostFilter[0]);
            }
        }

        return null;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        return ReadScalar(value);
    }

    private static string? ReadScalar(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => bool.TrueString,
            JsonValueKind.False => bool.FalseString,
            _ => null
        };
    }
}
