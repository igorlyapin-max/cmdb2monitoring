using System.Text.Json;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixRequestReader
{
    public ZabbixRequestDocument Read(string? key, string messageValue)
    {
        using var document = JsonDocument.Parse(messageValue);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("Zabbix request root must be a JSON object.");
        }

        var method = ReadString(root, "method") ?? string.Empty;
        var parameters = root.TryGetProperty("params", out var paramsElement)
            ? paramsElement.Clone()
            : default;
        var id = root.TryGetProperty("id", out var idElement)
            ? idElement.Clone()
            : default;

        return new ZabbixRequestDocument
        {
            RawJson = messageValue,
            Root = root.Clone(),
            Params = parameters,
            Id = id,
            Method = method,
            RequestId = ReadScalar(id),
            EntityId = key,
            Host = ReadHost(method, parameters)
        };
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
