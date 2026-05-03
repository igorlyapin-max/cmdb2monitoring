using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixDynamicHostGroupResolver(
    IZabbixClient zabbixClient,
    IOptions<ZabbixOptions> options,
    ZabbixRequestReader requestReader)
{
    public async Task<ZabbixRequestDocument> ResolveAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        if (!IsHostWriteRequest(request)
            || request.Params.ValueKind != JsonValueKind.Object
            || !request.Params.TryGetProperty("groups", out var groups)
            || groups.ValueKind != JsonValueKind.Array)
        {
            return request;
        }

        var groupNames = groups.EnumerateArray()
            .Where(group => group.ValueKind == JsonValueKind.Object
                && string.IsNullOrWhiteSpace(ReadString(group, "groupid")))
            .Select(group => ReadString(group, "name"))
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => name!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (groupNames.Length == 0)
        {
            return request;
        }

        var existingGroups = await zabbixClient.GetHostGroupIdsByNameAsync(groupNames, cancellationToken);
        var resolvedGroups = new Dictionary<string, string>(existingGroups, StringComparer.OrdinalIgnoreCase);
        if (options.Value.AllowDynamicHostGroupCreate)
        {
            foreach (var group in groups.EnumerateArray())
            {
                var name = ReadString(group, "name");
                if (string.IsNullOrWhiteSpace(name)
                    || resolvedGroups.ContainsKey(name)
                    || !ReadBool(group, "createIfMissing"))
                {
                    continue;
                }

                resolvedGroups[name] = await zabbixClient.CreateHostGroupAsync(name, cancellationToken);
            }
        }

        var rewrittenJson = RewriteParamsGroups(request.Root, resolvedGroups);
        return requestReader.Read(request.EntityId, rewrittenJson, request.Host);
    }

    private static bool IsHostWriteRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.create", StringComparison.OrdinalIgnoreCase)
            || string.Equals(request.Method, "host.update", StringComparison.OrdinalIgnoreCase);
    }

    private static string RewriteParamsGroups(
        JsonElement root,
        IReadOnlyDictionary<string, string> resolvedGroups)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var property in root.EnumerateObject())
            {
                if (string.Equals(property.Name, "params", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Object)
                {
                    writer.WritePropertyName(property.Name);
                    WriteParamsWithResolvedGroups(writer, property.Value, resolvedGroups);
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteParamsWithResolvedGroups(
        Utf8JsonWriter writer,
        JsonElement parameters,
        IReadOnlyDictionary<string, string> resolvedGroups)
    {
        writer.WriteStartObject();
        foreach (var property in parameters.EnumerateObject())
        {
            if (string.Equals(property.Name, "groups", StringComparison.OrdinalIgnoreCase)
                && property.Value.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName(property.Name);
                WriteResolvedGroups(writer, property.Value, resolvedGroups);
                continue;
            }

            property.WriteTo(writer);
        }

        writer.WriteEndObject();
    }

    private static void WriteResolvedGroups(
        Utf8JsonWriter writer,
        JsonElement groups,
        IReadOnlyDictionary<string, string> resolvedGroups)
    {
        var writtenGroupIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        writer.WriteStartArray();
        foreach (var group in groups.EnumerateArray())
        {
            if (group.ValueKind != JsonValueKind.Object)
            {
                group.WriteTo(writer);
                continue;
            }

            var groupId = ReadString(group, "groupid");
            if (!string.IsNullOrWhiteSpace(groupId))
            {
                if (!writtenGroupIds.Add(groupId))
                {
                    continue;
                }

                WriteKeyOnlyObject(writer, "groupid", groupId);
                continue;
            }

            var name = ReadString(group, "name");
            if (!string.IsNullOrWhiteSpace(name) && resolvedGroups.TryGetValue(name, out var resolvedGroupId))
            {
                if (!writtenGroupIds.Add(resolvedGroupId))
                {
                    continue;
                }

                WriteKeyOnlyObject(writer, "groupid", resolvedGroupId);
                continue;
            }

            group.WriteTo(writer);
        }

        writer.WriteEndArray();
    }

    private static void WriteKeyOnlyObject(Utf8JsonWriter writer, string keyName, string value)
    {
        writer.WriteStartObject();
        writer.WriteString(keyName, value);
        writer.WriteEndObject();
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(propertyName, out var value)
            ? ReadScalar(value)
            : null;
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
