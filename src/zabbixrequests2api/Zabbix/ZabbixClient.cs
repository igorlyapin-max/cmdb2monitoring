using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixClient(
    HttpClient httpClient,
    IOptions<ZabbixOptions> options,
    ILogger<ZabbixClient> logger) : IZabbixClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private string? loginToken;

    public async Task<ZabbixApiCallResult> ExecuteAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        return await SendJsonRpcAsync(request.RawJson, authenticated: true, cancellationToken);
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
                selectGroups = new[] { "groupid", "name" }
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

            result[templateId] = new ZabbixTemplateInfo(templateId, ReadTemplateGroupIds(item));
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

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(requestJson, Encoding.UTF8, "application/json")
        };

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

    private static string[] ReadTemplateGroupIds(JsonElement template)
    {
        if (!template.TryGetProperty("groups", out var groups) || groups.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return groups
            .EnumerateArray()
            .Select(group => ReadString(group, "groupid"))
            .Where(groupId => !string.IsNullOrWhiteSpace(groupId))
            .ToArray()!;
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
}
