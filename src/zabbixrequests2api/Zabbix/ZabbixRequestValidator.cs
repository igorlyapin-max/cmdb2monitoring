using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixRequestValidator(
    IZabbixClient zabbixClient,
    IOptions<ZabbixOptions> options)
{
    public async Task<ZabbixValidationResult> ValidateAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        var result = ValidateShape(request);
        if (!result.IsValid)
        {
            return result;
        }

        if (ShouldValidateHostGroups(request.Method) && options.Value.ValidateHostGroups)
        {
            await ValidateHostGroupsAsync(request, result, cancellationToken);
        }

        if (ShouldValidateTemplates(request.Method) && options.Value.ValidateTemplates)
        {
            await ValidateTemplatesAsync(request, result, cancellationToken);
        }

        return result;
    }

    private static ZabbixValidationResult ValidateShape(ZabbixRequestDocument request)
    {
        var result = new ZabbixValidationResult();

        if (request.Root.ValueKind != JsonValueKind.Object)
        {
            result.AddError("invalid_jsonrpc_payload", "JSON-RPC request must be a JSON object.");
            return result;
        }

        if (!string.Equals(ReadString(request.Root, "jsonrpc"), "2.0", StringComparison.Ordinal))
        {
            result.AddError("missing_jsonrpc_version", "JSON-RPC version 2.0 is required.");
        }

        if (string.IsNullOrWhiteSpace(request.Method))
        {
            result.AddError("missing_method", "JSON-RPC method is required.");
            return result;
        }

        if (request.Id.ValueKind == JsonValueKind.Undefined)
        {
            result.AddError("missing_request_id", "JSON-RPC id is required.");
        }

        switch (request.Method.ToLowerInvariant())
        {
            case "host.create":
                ValidateHostCreate(request, result);
                break;
            case "host.update":
                ValidateHostUpdate(request, result);
                break;
            case "host.delete":
                ValidateHostDelete(request, result);
                break;
            case "host.get":
                ValidateHostGet(request, result);
                break;
            default:
                result.AddError("unsupported_method", $"Unsupported Zabbix method '{request.Method}'.");
                break;
        }

        return result;
    }

    private static void ValidateHostCreate(ZabbixRequestDocument request, ZabbixValidationResult result)
    {
        if (request.Params.ValueKind != JsonValueKind.Object)
        {
            result.AddError("missing_params", "host.create params object is required.");
            return;
        }

        if (string.IsNullOrWhiteSpace(ReadString(request.Params, "host")))
        {
            result.AddError("missing_host", "host.create params.host is required.");
        }

        if (ReadObjectArray(request.Params, "interfaces").Length == 0)
        {
            result.AddError("missing_interfaces", "host.create params.interfaces must contain at least one interface.");
        }

        if (ReadObjectArray(request.Params, "groups").Length == 0)
        {
            result.AddError("missing_host_group", "host.create params.groups must contain at least one host group.");
        }

        if (ReadObjectArray(request.Params, "templates").Length == 0)
        {
            result.AddError("missing_template", "host.create params.templates must contain at least one monitoring template.");
        }

        ValidateTags(request.Params, result);
    }

    private static void ValidateHostUpdate(ZabbixRequestDocument request, ZabbixValidationResult result)
    {
        if (request.Params.ValueKind != JsonValueKind.Object)
        {
            result.AddError("missing_params", "host.update params object is required.");
            return;
        }

        if (string.IsNullOrWhiteSpace(ReadString(request.Params, "hostid")))
        {
            result.AddError("missing_hostid", "host.update params.hostid is required.");
        }

        ValidateTags(request.Params, result);
    }

    private static void ValidateHostDelete(ZabbixRequestDocument request, ZabbixValidationResult result)
    {
        if (request.Params.ValueKind != JsonValueKind.Array || request.Params.GetArrayLength() == 0)
        {
            result.AddError("missing_hostid", "host.delete params must contain at least one hostid.");
            return;
        }

        if (request.Params.EnumerateArray().Any(item => string.IsNullOrWhiteSpace(ReadScalar(item))))
        {
            result.AddError("invalid_hostid", "host.delete params must contain only non-empty hostid values.");
        }
    }

    private static void ValidateHostGet(ZabbixRequestDocument request, ZabbixValidationResult result)
    {
        if (request.Params.ValueKind != JsonValueKind.Object)
        {
            result.AddError("missing_params", "host.get params object is required.");
            return;
        }

        if (!request.Params.TryGetProperty("filter", out var filter)
            || filter.ValueKind != JsonValueKind.Object
            || !filter.TryGetProperty("host", out var hostFilter)
            || hostFilter.ValueKind != JsonValueKind.Array
            || hostFilter.GetArrayLength() == 0)
        {
            result.AddError("missing_host_filter", "host.get params.filter.host must contain at least one host name.");
        }
    }

    private static void ValidateTags(JsonElement parameters, ZabbixValidationResult result)
    {
        if (!parameters.TryGetProperty("tags", out var tags) || tags.ValueKind == JsonValueKind.Undefined)
        {
            return;
        }

        if (tags.ValueKind != JsonValueKind.Array)
        {
            result.AddError("invalid_tags", "params.tags must be an array.");
            return;
        }

        foreach (var tag in tags.EnumerateArray())
        {
            if (tag.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(ReadString(tag, "tag")))
            {
                result.AddError("invalid_tag", "Each Zabbix tag must contain a non-empty tag field.");
                return;
            }
        }
    }

    private async Task ValidateHostGroupsAsync(
        ZabbixRequestDocument request,
        ZabbixValidationResult result,
        CancellationToken cancellationToken)
    {
        var groupIds = ReadObjectArrayValues(request.Params, "groups", "groupid");
        if (groupIds.Length == 0)
        {
            return;
        }

        var existingIds = await zabbixClient.GetExistingHostGroupIdsAsync(groupIds, cancellationToken);
        foreach (var groupId in groupIds.Where(groupId => !existingIds.Contains(groupId)))
        {
            result.MissingHostGroups.Add(groupId);
        }

        if (result.MissingHostGroups.Count > 0)
        {
            result.AddError("missing_host_group", $"Missing Zabbix host group ids: {string.Join(", ", result.MissingHostGroups)}.");
        }
    }

    private async Task ValidateTemplatesAsync(
        ZabbixRequestDocument request,
        ZabbixValidationResult result,
        CancellationToken cancellationToken)
    {
        var templateIds = ReadObjectArrayValues(request.Params, "templates", "templateid");
        if (templateIds.Length == 0)
        {
            return;
        }

        var templates = await zabbixClient.GetTemplateInfosAsync(templateIds, cancellationToken);
        foreach (var templateId in templateIds.Where(templateId => !templates.ContainsKey(templateId)))
        {
            result.MissingTemplates.Add(templateId);
        }

        if (options.Value.ValidateTemplateGroups)
        {
            foreach (var template in templates.Values.Where(template => template.TemplateGroupIds.Length == 0))
            {
                result.MissingTemplateGroups.Add(template.TemplateId);
            }
        }

        if (result.MissingTemplates.Count > 0)
        {
            result.AddError("missing_template", $"Missing Zabbix template ids: {string.Join(", ", result.MissingTemplates)}.");
        }

        if (result.MissingTemplateGroups.Count > 0)
        {
            result.AddError(
                "missing_template_group",
                $"Zabbix templates without template group ids: {string.Join(", ", result.MissingTemplateGroups)}.");
        }
    }

    private static bool ShouldValidateHostGroups(string method)
    {
        return string.Equals(method, "host.create", StringComparison.OrdinalIgnoreCase)
            || string.Equals(method, "host.update", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ShouldValidateTemplates(string method)
    {
        return string.Equals(method, "host.create", StringComparison.OrdinalIgnoreCase)
            || string.Equals(method, "host.update", StringComparison.OrdinalIgnoreCase);
    }

    private static JsonElement[] ReadObjectArray(JsonElement parameters, string propertyName)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty(propertyName, out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return array.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).ToArray();
    }

    private static string[] ReadObjectArrayValues(JsonElement parameters, string arrayPropertyName, string valuePropertyName)
    {
        return ReadObjectArray(parameters, arrayPropertyName)
            .Select(item => ReadString(item, valuePropertyName))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
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
