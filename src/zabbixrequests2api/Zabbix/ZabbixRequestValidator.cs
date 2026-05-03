using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixRequestValidator(
    IZabbixClient zabbixClient,
    IOptions<ZabbixOptions> options)
{
    private const string TemplateCompatibilityReadMore =
        "Read PROJECT_DOCUMENTATION.md or PROJECT_DOCUMENTATION.en.md, section 'Zabbix template compatibility'.";

    public async Task<ZabbixValidationResult> ValidateAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        var result = ValidateShape(request);
        if (!result.IsValid)
        {
            return result;
        }

        if (ShouldValidateHostGroups(request.Method))
        {
            ValidateHostGroupShape(request.Params, result);
            if (!result.IsValid)
            {
                return result;
            }
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
            case "maintenance.get":
            case "maintenance.create":
            case "maintenance.update":
            case "maintenance.delete":
            case "usermacro.get":
            case "usermacro.create":
            case "usermacro.update":
            case "usermacro.delete":
            case "proxy.get":
            case "proxy.create":
            case "proxy.update":
            case "proxy.delete":
            case "valuemap.get":
            case "valuemap.create":
            case "valuemap.update":
            case "valuemap.delete":
                ValidateGenericParams(request, result);
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
        ValidateHostExtendedFields(request.Params, result);
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
        ValidateHostExtendedFields(request.Params, result);
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

        var hasHostFilter = request.Params.TryGetProperty("filter", out var filter)
            && filter.ValueKind == JsonValueKind.Object
            && filter.TryGetProperty("host", out var hostFilter)
            && hostFilter.ValueKind == JsonValueKind.Array
            && hostFilter.GetArrayLength() > 0;
        var hasHostIds = request.Params.TryGetProperty("hostids", out var hostIds)
            && hostIds.ValueKind == JsonValueKind.Array
            && hostIds.GetArrayLength() > 0;

        if (!hasHostFilter && !hasHostIds)
        {
            result.AddError("missing_host_filter", "host.get params.filter.host or params.hostids must contain at least one host identifier.");
        }
    }

    private static void ValidateGenericParams(ZabbixRequestDocument request, ZabbixValidationResult result)
    {
        if (request.Params.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
        {
            return;
        }

        result.AddError("missing_params", $"{request.Method} params object or array is required.");
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

    private static void ValidateHostExtendedFields(JsonElement parameters, ZabbixValidationResult result)
    {
        ValidateStatus(parameters, result);
        ValidateMacros(parameters, result);
        ValidateInventory(parameters, result);
        ValidateTlsPsk(parameters, result);
    }

    private static void ValidateStatus(JsonElement parameters, ZabbixValidationResult result)
    {
        if (!parameters.TryGetProperty("status", out var status) || status.ValueKind == JsonValueKind.Undefined)
        {
            return;
        }

        if (!TryReadInt(status, out var value) || value is < 0 or > 1)
        {
            result.AddError("invalid_host_status", "params.status must be 0 (monitored) or 1 (unmonitored).");
        }
    }

    private static void ValidateMacros(JsonElement parameters, ZabbixValidationResult result)
    {
        if (!parameters.TryGetProperty("macros", out var macros) || macros.ValueKind == JsonValueKind.Undefined)
        {
            return;
        }

        if (macros.ValueKind != JsonValueKind.Array)
        {
            result.AddError("invalid_macros", "params.macros must be an array.");
            return;
        }

        foreach (var macro in macros.EnumerateArray())
        {
            if (macro.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(ReadString(macro, "macro")))
            {
                result.AddError("invalid_macro", "Each host macro must contain a non-empty macro field.");
                return;
            }
        }
    }

    private static void ValidateInventory(JsonElement parameters, ZabbixValidationResult result)
    {
        if (!parameters.TryGetProperty("inventory", out var inventory) || inventory.ValueKind == JsonValueKind.Undefined)
        {
            return;
        }

        if (inventory.ValueKind != JsonValueKind.Object)
        {
            result.AddError("invalid_inventory", "params.inventory must be an object.");
        }
    }

    private static void ValidateTlsPsk(JsonElement parameters, ZabbixValidationResult result)
    {
        var hasTlsConnect = parameters.TryGetProperty("tls_connect", out var tlsConnect)
            && tlsConnect.ValueKind != JsonValueKind.Undefined;
        var hasTlsAccept = parameters.TryGetProperty("tls_accept", out var tlsAccept)
            && tlsAccept.ValueKind != JsonValueKind.Undefined;

        if (hasTlsConnect && !TryReadInt(tlsConnect, out _))
        {
            result.AddError("invalid_tls_connect", "params.tls_connect must be numeric.");
        }

        if (hasTlsAccept && !TryReadInt(tlsAccept, out _))
        {
            result.AddError("invalid_tls_accept", "params.tls_accept must be numeric.");
        }

        if (parameters.TryGetProperty("tls_psk", out var psk)
            && psk.ValueKind != JsonValueKind.Undefined
            && string.IsNullOrWhiteSpace(ReadScalar(psk)))
        {
            result.AddError("invalid_tls_psk", "params.tls_psk must be non-empty when provided.");
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

    private void ValidateHostGroupShape(JsonElement parameters, ZabbixValidationResult result)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("groups", out var groups)
            || groups.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var group in groups.EnumerateArray())
        {
            if (group.ValueKind != JsonValueKind.Object)
            {
                result.AddError("invalid_host_group", "Each host group must be an object.");
                return;
            }

            var groupId = ReadString(group, "groupid");
            if (!string.IsNullOrWhiteSpace(groupId))
            {
                continue;
            }

            var name = ReadString(group, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                result.AddError("missing_host_group", "Host group must contain groupid or dynamic name.");
                return;
            }

            if (ReadBool(group, "createIfMissing") && !options.Value.AllowDynamicHostGroupCreate)
            {
                result.AddError(
                    "auto_expand_disabled",
                    $"Dynamic host group '{name}' is not present in Zabbix and AllowDynamicHostGroupCreate is disabled.");
                return;
            }

            result.AddError(
                "missing_host_group",
                $"Dynamic host group '{name}' is not present in Zabbix and createIfMissing is not enabled.");
            return;
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

        if (options.Value.ValidateTemplateCompatibility && result.MissingTemplates.Count == 0)
        {
            ValidateTemplateCompatibility(templateIds, templates, result);
        }

        if (result.MissingTemplateGroups.Count > 0)
        {
            result.AddError(
                "missing_template_group",
                $"Zabbix templates without template group ids: {string.Join(", ", result.MissingTemplateGroups)}.");
        }
    }

    private static void ValidateTemplateCompatibility(
        string[] templateIds,
        IReadOnlyDictionary<string, ZabbixTemplateInfo> templates,
        ZabbixValidationResult result)
    {
        var selectedTemplates = templateIds
            .Select(templateId => templates.TryGetValue(templateId, out var template) ? template : null)
            .OfType<ZabbixTemplateInfo>()
            .ToArray();

        var conflicts = FindDuplicateKeyConflicts(selectedTemplates, template => template.ItemKeys, "item key")
            .Concat(FindDuplicateKeyConflicts(selectedTemplates, template => template.DiscoveryRuleKeys, "LLD rule key"))
            .Concat(FindDuplicateInventoryLinkConflicts(selectedTemplates))
            .ToArray();
        if (conflicts.Length == 0)
        {
            return;
        }

        var shownConflicts = conflicts.Take(6).ToArray();
        var details = string.Join(" ", shownConflicts);
        if (conflicts.Length > shownConflicts.Length)
        {
            details = $"{details} Plus {conflicts.Length - shownConflicts.Length} more conflict(s).";
        }

        result.AddError(
            "template_conflict",
            "Zabbix template compatibility conflict was detected before the Zabbix API call. "
            + "The write request was not sent to Zabbix. "
            + details
            + " Resolve it by changing conversion rules/templates or by sending templates_clear for templates that must be removed during update. "
            + TemplateCompatibilityReadMore);
    }

    private static IEnumerable<string> FindDuplicateKeyConflicts(
        IReadOnlyCollection<ZabbixTemplateInfo> templates,
        Func<ZabbixTemplateInfo, IReadOnlyCollection<string>> keySelector,
        string keyType)
    {
        var ownersByKey = new Dictionary<string, HashSet<TemplateKeyOwner>>(StringComparer.OrdinalIgnoreCase);
        foreach (var template in templates)
        {
            foreach (var key in keySelector(template).Where(key => !string.IsNullOrWhiteSpace(key)))
            {
                if (!ownersByKey.TryGetValue(key, out var owners))
                {
                    owners = [];
                    ownersByKey[key] = owners;
                }

                owners.Add(new TemplateKeyOwner(template.TemplateId, ResolveTemplateName(template)));
            }
        }

        return ownersByKey
            .Where(item => item.Value.Count > 1)
            .OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase)
            .Select(item => FormatTemplateConflict(keyType, item.Key, item.Value));
    }

    private static IEnumerable<string> FindDuplicateInventoryLinkConflicts(
        IReadOnlyCollection<ZabbixTemplateInfo> templates)
    {
        var ownersByInventoryLink = new Dictionary<string, HashSet<TemplateInventoryOwner>>(StringComparer.OrdinalIgnoreCase);
        foreach (var template in templates)
        {
            foreach (var item in template.InventoryLinkedItems)
            {
                if (string.IsNullOrWhiteSpace(item.InventoryLink)
                    || string.Equals(item.InventoryLink, "0", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (!ownersByInventoryLink.TryGetValue(item.InventoryLink, out var owners))
                {
                    owners = [];
                    ownersByInventoryLink[item.InventoryLink] = owners;
                }

                owners.Add(new TemplateInventoryOwner(
                    template.TemplateId,
                    ResolveTemplateName(template),
                    item.Key));
            }
        }

        return ownersByInventoryLink
            .Where(item => item.Value.Select(owner => owner.TemplateId).Distinct(StringComparer.OrdinalIgnoreCase).Count() > 1)
            .OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase)
            .Select(item => FormatInventoryLinkConflict(item.Key, item.Value));
    }

    private static string FormatTemplateConflict(
        string keyType,
        string key,
        IReadOnlyCollection<TemplateKeyOwner> owners)
    {
        var ownerList = owners
            .OrderBy(owner => owner.TemplateName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(owner => owner.TemplateId, StringComparer.OrdinalIgnoreCase)
            .Select(owner => $"{owner.TemplateName} ({owner.TemplateId})");

        return $"Duplicate {keyType} '{key}' is present in templates {string.Join(", ", ownerList)}.";
    }

    private static string FormatInventoryLinkConflict(
        string inventoryLink,
        IReadOnlyCollection<TemplateInventoryOwner> owners)
    {
        var ownerList = owners
            .OrderBy(owner => owner.TemplateName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(owner => owner.TemplateId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(owner => owner.ItemKey, StringComparer.OrdinalIgnoreCase)
            .Select(owner => $"item '{owner.ItemKey}' in template {owner.TemplateName} ({owner.TemplateId})");

        return $"Duplicate inventory link '{inventoryLink}' is filled by {string.Join(", ", ownerList)}.";
    }

    private static string ResolveTemplateName(ZabbixTemplateInfo template)
    {
        if (!string.IsNullOrWhiteSpace(template.Name))
        {
            return template.Name;
        }

        if (!string.IsNullOrWhiteSpace(template.Host))
        {
            return template.Host;
        }

        return template.TemplateId;
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

    private static bool TryReadInt(JsonElement value, out int result)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out result))
        {
            return true;
        }

        if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out result))
        {
            return true;
        }

        result = 0;
        return false;
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

    private sealed record TemplateKeyOwner(string TemplateId, string TemplateName);

    private sealed record TemplateInventoryOwner(string TemplateId, string TemplateName, string ItemKey);
}
