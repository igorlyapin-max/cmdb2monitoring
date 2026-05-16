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
    private readonly object cacheLock = new();
    private readonly Dictionary<string, CacheEntry<bool>> hostGroupIdCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, CacheEntry<string>> hostGroupNameCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, CacheEntry<ZabbixTemplateInfo>> templateInfoCache = new(StringComparer.OrdinalIgnoreCase);
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
        var requestedIds = groupIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (requestedIds.Length == 0)
        {
            return [];
        }

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var missingIds = new List<string>();
        foreach (var groupId in requestedIds)
        {
            if (TryReadCache(hostGroupIdCache, groupId, options.Value.HostGroupCacheTtlSeconds, out _))
            {
                result.Add(groupId);
                continue;
            }

            missingIds.Add(groupId);
        }

        if (missingIds.Count == 0)
        {
            return result;
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "hostgroup.get",
            @params = new
            {
                output = new[] { "groupid", "name" },
                groupids = missingIds
            },
            id = 1
        }, JsonOptions);

        var response = await SendJsonRpcAsync(request, authenticated: true, cancellationToken);
        if (!response.Success || string.IsNullOrWhiteSpace(response.ResponseJson))
        {
            throw new InvalidOperationException(response.ErrorMessage ?? "Failed to query Zabbix host groups.");
        }

        using var document = JsonDocument.Parse(response.ResponseJson);
        foreach (var id in document.RootElement
            .GetProperty("result")
            .EnumerateArray()
            .Select(item => ReadString(item, "groupid"))
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!))
        {
            result.Add(id);
            WriteCache(hostGroupIdCache, id, true, options.Value.HostGroupCacheTtlSeconds);
        }

        return result;
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

        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var missingNames = new List<string>();
        foreach (var name in names)
        {
            if (TryReadCache(hostGroupNameCache, name, options.Value.HostGroupCacheTtlSeconds, out var groupId))
            {
                result[name] = groupId;
                continue;
            }

            missingNames.Add(name);
        }

        if (missingNames.Count == 0)
        {
            return result;
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
                    name = missingNames
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
        foreach (var item in document.RootElement.GetProperty("result").EnumerateArray())
        {
            var name = ReadString(item, "name");
            var groupId = ReadString(item, "groupid");
            if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(groupId))
            {
                result[name] = groupId;
                WriteCache(hostGroupNameCache, name, groupId, options.Value.HostGroupCacheTtlSeconds);
                WriteCache(hostGroupIdCache, groupId, true, options.Value.HostGroupCacheTtlSeconds);
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
                WriteCache(hostGroupNameCache, groupName, groupId, options.Value.HostGroupCacheTtlSeconds);
                WriteCache(hostGroupIdCache, groupId, true, options.Value.HostGroupCacheTtlSeconds);
                return groupId;
            }
        }

        throw new InvalidOperationException($"Zabbix hostgroup.create did not return a groupid for '{groupName}'.");
    }

    public async Task<IReadOnlyDictionary<string, ZabbixTemplateInfo>> GetTemplateInfosAsync(
        IReadOnlyCollection<string> templateIds,
        CancellationToken cancellationToken)
    {
        var requestedIds = templateIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (requestedIds.Length == 0)
        {
            return new Dictionary<string, ZabbixTemplateInfo>(StringComparer.OrdinalIgnoreCase);
        }

        var result = new Dictionary<string, ZabbixTemplateInfo>(StringComparer.OrdinalIgnoreCase);
        var missingIds = new List<string>();
        foreach (var templateId in requestedIds)
        {
            if (TryReadCache(templateInfoCache, templateId, options.Value.TemplateCacheTtlSeconds, out var templateInfo))
            {
                result[templateId] = templateInfo;
                continue;
            }

            missingIds.Add(templateId);
        }

        if (missingIds.Count == 0)
        {
            return result;
        }

        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "template.get",
            @params = new
            {
                output = new[] { "templateid", "host", "name" },
                templateids = missingIds,
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
            var templateInfo = new ZabbixTemplateInfo(
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
            result[templateId] = templateInfo;
            WriteCache(templateInfoCache, templateId, templateInfo, options.Value.TemplateCacheTtlSeconds);
        }

        return result;
    }

    private bool TryReadCache<T>(
        Dictionary<string, CacheEntry<T>> cache,
        string key,
        int ttlSeconds,
        out T value)
    {
        value = default!;
        if (ttlSeconds <= 0 || string.IsNullOrWhiteSpace(key))
        {
            return false;
        }

        var now = DateTimeOffset.UtcNow;
        lock (cacheLock)
        {
            if (cache.TryGetValue(key, out var cached))
            {
                if (cached.ExpiresAt > now)
                {
                    value = cached.Value;
                    return true;
                }

                cache.Remove(key);
            }
        }

        return false;
    }

    private void WriteCache<T>(
        Dictionary<string, CacheEntry<T>> cache,
        string key,
        T value,
        int ttlSeconds)
    {
        if (ttlSeconds <= 0 || string.IsNullOrWhiteSpace(key))
        {
            return;
        }

        lock (cacheLock)
        {
            cache[key] = new CacheEntry<T>(value, DateTimeOffset.UtcNow.AddSeconds(ttlSeconds));
        }
    }

    private sealed record CacheEntry<T>(T Value, DateTimeOffset ExpiresAt);

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
