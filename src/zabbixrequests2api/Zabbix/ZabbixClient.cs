using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cmdb2Monitoring.Logging;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixClient(
    HttpClient httpClient,
    IOptions<ZabbixOptions> options,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
    ILogger<ZabbixClient> logger) : IZabbixClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private string? loginToken;

    public async Task<ZabbixApiCallResult> ExecuteAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        return await SendJsonRpcAsync(request.ZabbixJson, authenticated: true, cancellationToken);
    }

    public async Task<HashSet<string>> GetExistingHostGroupIdsAsync(
        IReadOnlyCollection<string> groupIds,
        CancellationToken cancellationToken)
    {
        if (groupIds.Count == 0)
        {
            return [];
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "hostgroup.get",
            @params = new
            {
                output = new[] { "groupid", "name" },
                groupids = groupIds
            },
            id = 1
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: true, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            throw new InvalidOperationException(response.ErrorMessage ?? "Failed to query Zabbix host groups.");
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        return document.RootElement
            .GetProperty("result")
            .EnumerateArray()
            .Select(item => ReadString(item, "groupid"))
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .ToHashSet(StringComparer.OrdinalIgnoreCase)!;
    }

    public async Task<IReadOnlyDictionary<string, string>> GetHostGroupIdsByNameAsync(
        IReadOnlyCollection<string> groupNames,
        CancellationToken cancellationToken)
    {
        var names = groupNames
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (names.Length == 0)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "hostgroup.get",
            @params = new
            {
                output = new[] { "groupid", "name" },
                filter = new
                {
                    name = names
                }
            },
            id = 3
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: true, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            throw new InvalidOperationException(response.ErrorMessage ?? "Failed to query Zabbix host groups by name.");
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in document.RootElement.GetProperty("result").EnumerateArray())
        {
            var name = ReadString(item, "name");
            var groupId = ReadString(item, "groupid");
            if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(groupId))
            {
                result[name] = groupId;
            }
        }

        return result;
    }

    public async Task<string> CreateHostGroupAsync(
        string groupName,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(groupName))
        {
            throw new ArgumentException("Host group name is required.", nameof(groupName));
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "hostgroup.create",
            @params = new
            {
                name = groupName
            },
            id = 4
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: true, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            throw new InvalidOperationException(response.ErrorMessage ?? $"Failed to create Zabbix host group '{groupName}'.");
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        if (document.RootElement.TryGetProperty("result", out var result)
            && result.TryGetProperty("groupids", out var groupIds)
            && groupIds.ValueKind == JsonValueKind.Array
            && groupIds.GetArrayLength() > 0)
        {
            var groupId = ReadScalar(groupIds[0]);
            if (!string.IsNullOrWhiteSpace(groupId))
            {
                return groupId;
            }
        }

        throw new InvalidOperationException($"Zabbix hostgroup.create did not return a groupid for '{groupName}'.");
    }

    public async Task<IReadOnlyDictionary<string, ZabbixTemplateInfo>> GetTemplateInfosAsync(
        IReadOnlyCollection<string> templateIds,
        CancellationToken cancellationToken)
    {
        if (templateIds.Count == 0)
        {
            return new Dictionary<string, ZabbixTemplateInfo>(StringComparer.OrdinalIgnoreCase);
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "template.get",
            @params = new
            {
                output = new[] { "templateid", "host", "name" },
                templateids = templateIds,
                selectTemplateGroups = new[] { "groupid", "name" },
                selectItems = new[] { "itemid", "key_", "name", "inventory_link" },
                selectDiscoveryRules = new[] { "itemid", "key_", "name" }
            },
            id = 2
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: true, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            throw new InvalidOperationException(response.ErrorMessage ?? "Failed to query Zabbix templates.");
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        var result = new Dictionary<string, ZabbixTemplateInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in document.RootElement.GetProperty("result").EnumerateArray())
        {
            var templateId = ReadString(item, "templateid");
            if (string.IsNullOrWhiteSpace(templateId))
            {
                continue;
            }

            var host = ReadString(item, "host") ?? string.Empty;
            var name = ReadString(item, "name") ?? host;
            var itemInfos = ReadItemInfos(item, "items");
            result[templateId] = new ZabbixTemplateInfo(
                templateId,
                name,
                host,
                ReadTemplateGroupIds(item),
                itemInfos
                    .Select(info => info.Key)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                ReadDiscoveryRuleKeys(item),
                itemInfos
                    .Where(info => !string.IsNullOrWhiteSpace(info.InventoryLink)
                        && !string.Equals(info.InventoryLink, "0", StringComparison.OrdinalIgnoreCase))
                    .ToArray());
        }

        return result;
    }

    private async Task<ZabbixApiCallResult> SendJsonRpcAsync(
        string requestJson,
        bool authenticated,
        CancellationToken cancellationToken)
    {
        var endpoint = options.Value.ApiEndpoint;
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            return ZabbixApiCallResult.Failed("zabbix_api_endpoint_not_configured", "Zabbix API endpoint is not configured.");
        }

        var requestMethod = ReadJsonRpcMethod(requestJson);
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(requestJson, Encoding.UTF8, "application/json")
        };
        logger.LogVerbose(
            debugLoggingOptions,
            "Sending Zabbix JSON-RPC request to {Endpoint}, authenticated {Authenticated}, payload {ZabbixRequestJson}",
            endpoint,
            authenticated,
            RedactSecretJsonFields(requestJson, redactResult: false));

        if (authenticated)
        {
            var token = await ResolveAuthTokenAsync(cancellationToken);
            if (!string.IsNullOrWhiteSpace(token))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
        }

        using var response = await httpClient.SendAsync(request, cancellationToken);
        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
        logger.LogBasic(
            debugLoggingOptions,
            "Zabbix API returned HTTP {StatusCode} for authenticated {Authenticated}",
            (int)response.StatusCode,
            authenticated);
        logger.LogVerbose(
            debugLoggingOptions,
            "Zabbix API response JSON {ZabbixResponseJson}",
            RedactSecretJsonFields(
                responseJson,
                redactResult: string.Equals(requestMethod, "user.login", StringComparison.OrdinalIgnoreCase)));
        if (!response.IsSuccessStatusCode)
        {
            return ZabbixApiCallResult.Failed(
                "zabbix_http_error",
                $"Zabbix API returned HTTP {(int)response.StatusCode}.",
                responseJson);
        }

        return ParseJsonRpcResponse(responseJson);
    }

    private async Task<string?> ResolveAuthTokenAsync(CancellationToken cancellationToken)
    {
        var authMode = options.Value.AuthMode;
        if (string.Equals(authMode, "None", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(options.Value.ApiToken)
            && !string.Equals(authMode, "Login", StringComparison.OrdinalIgnoreCase))
        {
            return options.Value.ApiToken;
        }

        if (!string.IsNullOrWhiteSpace(loginToken))
        {
            return loginToken;
        }

        if (string.Equals(authMode, "Token", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        loginToken = await LoginAsync(useUsernameField: true, cancellationToken)
            ?? await LoginAsync(useUsernameField: false, cancellationToken);

        return loginToken;
    }

    private async Task<string?> LoginAsync(bool useUsernameField, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.Value.User) || string.IsNullOrWhiteSpace(options.Value.Password))
        {
            return null;
        }

        var loginParams = useUsernameField
            ? new Dictionary<string, string>
            {
                ["username"] = options.Value.User,
                ["password"] = options.Value.Password
            }
            : new Dictionary<string, string>
            {
                ["user"] = options.Value.User,
                ["password"] = options.Value.Password
            };

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "user.login",
            @params = loginParams,
            id = 1000
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: false, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            logger.LogWarning(
                "Zabbix login attempt with {LoginField} failed: {ErrorMessage}",
                useUsernameField ? "username" : "user",
                response.ErrorMessage ?? "<unknown>");
            return null;
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        if (document.RootElement.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.String)
        {
            return result.GetString();
        }

        return null;
    }

    private static ZabbixApiCallResult ParseJsonRpcResponse(string responseJson)
    {
        using var document = JsonDocument.Parse(responseJson);
        if (document.RootElement.TryGetProperty("error", out var error))
        {
            var code = ReadString(error, "code") ?? "zabbix_api_error";
            var message = ReadString(error, "message") ?? "Zabbix API returned an error.";
            var data = ReadString(error, "data");
            return ZabbixApiCallResult.Failed(code, string.IsNullOrWhiteSpace(data) ? message : $"{message}: {data}", responseJson);
        }

        return new ZabbixApiCallResult(true, responseJson, null, null);
    }

    private static string ReadJsonRpcMethod(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return ReadString(document.RootElement, "method") ?? string.Empty;
        }
        catch (JsonException)
        {
            return string.Empty;
        }
    }

    private static string RedactSecretJsonFields(string json, bool redactResult)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return json;
        }

        try
        {
            var node = JsonNode.Parse(json);
            RedactNode(node, redactResult);
            return node?.ToJsonString(JsonOptions) ?? string.Empty;
        }
        catch (JsonException)
        {
            return "<invalid-json>";
        }
    }

    private static void RedactNode(JsonNode? node, bool redactResult)
    {
        if (node is JsonObject jsonObject)
        {
            foreach (var property in jsonObject.ToList())
            {
                if (IsSecretProperty(property.Key)
                    || redactResult && string.Equals(property.Key, "result", StringComparison.OrdinalIgnoreCase))
                {
                    jsonObject[property.Key] = "<redacted>";
                    continue;
                }

                RedactNode(property.Value, redactResult: false);
            }

            return;
        }

        if (node is JsonArray jsonArray)
        {
            foreach (var item in jsonArray)
            {
                RedactNode(item, redactResult: false);
            }
        }
    }

    private static bool IsSecretProperty(string propertyName)
    {
        return string.Equals(propertyName, "password", StringComparison.OrdinalIgnoreCase)
            || string.Equals(propertyName, "passwd", StringComparison.OrdinalIgnoreCase)
            || string.Equals(propertyName, "token", StringComparison.OrdinalIgnoreCase)
            || string.Equals(propertyName, "apiToken", StringComparison.OrdinalIgnoreCase)
            || string.Equals(propertyName, "authorization", StringComparison.OrdinalIgnoreCase)
            || string.Equals(propertyName, "auth", StringComparison.OrdinalIgnoreCase);
    }

    private static string[] ReadTemplateGroupIds(JsonElement template)
    {
        if (!template.TryGetProperty("templategroups", out var templateGroups) || templateGroups.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return templateGroups
            .EnumerateArray()
            .Select(group => ReadString(group, "groupid"))
            .Where(groupId => !string.IsNullOrWhiteSpace(groupId))
            .ToArray()!;
    }

    private static string[] ReadDiscoveryRuleKeys(JsonElement template)
    {
        return ReadItemKeys(template, "discoveryRules");
    }

    private static ZabbixTemplateItemInfo[] ReadItemInfos(JsonElement template, string propertyName)
    {
        if (!template.TryGetProperty(propertyName, out var items) || items.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return items
            .EnumerateArray()
            .Select(item => new ZabbixTemplateItemInfo(
                ReadString(item, "key_") ?? string.Empty,
                ReadString(item, "inventory_link") ?? "0"))
            .Where(info => !string.IsNullOrWhiteSpace(info.Key))
            .ToArray();
    }

    private static string[] ReadItemKeys(JsonElement template, string propertyName)
    {
        if (!template.TryGetProperty(propertyName, out var items) || items.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return items
            .EnumerateArray()
            .Select(item => ReadString(item, "key_"))
            .Where(key => !string.IsNullOrWhiteSpace(key))
            .Select(key => key!)
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
