using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using CmdbKafka2Zabbix.Configuration;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbZabbixHostBindingResolver(
    HttpClient httpClient,
    IOptions<CmdbuildOptions> options,
    ILogger<CmdbZabbixHostBindingResolver> logger) : ICmdbZabbixHostBindingResolver
{
    public async Task<string?> ResolveHostIdAsync(
        CmdbSourceEvent source,
        string hostProfile,
        bool isMainProfile,
        CancellationToken cancellationToken)
    {
        var currentOptions = options.Value;
        if (!currentOptions.CanResolveHostBindings)
        {
            return null;
        }

        var sourceClass = source.ClassName ?? source.EntityType;
        if (string.IsNullOrWhiteSpace(sourceClass) || string.IsNullOrWhiteSpace(source.EntityId))
        {
            return null;
        }

        try
        {
            return isMainProfile
                ? await ResolveMainHostIdAsync(sourceClass, source.EntityId, hostProfile, cancellationToken)
                : await ResolveAdditionalHostIdAsync(sourceClass, source.EntityId, hostProfile, cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(
                ex,
                "Failed to resolve stored Zabbix host binding for {SourceClass}/{SourceCardId}, profile {HostProfile}; converter will use fallback host.get if route allows it",
                sourceClass,
                source.EntityId,
                hostProfile);
            return null;
        }
    }

    private async Task<string?> ResolveMainHostIdAsync(
        string sourceClass,
        string sourceCardId,
        string hostProfile,
        CancellationToken cancellationToken)
    {
        using var document = await GetJsonAsync(
            $"/classes/{Uri.EscapeDataString(sourceClass)}/cards/{Uri.EscapeDataString(sourceCardId)}",
            cancellationToken);
        var data = ReadDataObject(document.RootElement);
        var hostId = ReadString(data, options.Value.MainHostIdAttributeName);
        if (!string.IsNullOrWhiteSpace(hostId))
        {
            logger.LogInformation(
                "Resolved stored Zabbix hostid {ZabbixHostId} from {Attribute} for {SourceClass}/{SourceCardId}, profile {HostProfile}",
                hostId,
                options.Value.MainHostIdAttributeName,
                sourceClass,
                sourceCardId,
                hostProfile);
        }

        return hostId;
    }

    private async Task<string?> ResolveAdditionalHostIdAsync(
        string sourceClass,
        string sourceCardId,
        string hostProfile,
        CancellationToken cancellationToken)
    {
        using var document = await GetJsonAsync(
            $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards?limit={Math.Max(1, options.Value.BindingLookupLimit)}",
            cancellationToken);

        foreach (var card in ReadDataArray(document.RootElement))
        {
            if (!Same(ReadString(card, "OwnerClass"), sourceClass)
                || !Same(ReadString(card, "OwnerCardId"), sourceCardId)
                || !Same(ReadString(card, "HostProfile"), hostProfile)
                || IsDeleted(ReadString(card, "BindingStatus")))
            {
                continue;
            }

            var hostId = ReadString(card, "ZabbixHostId");
            if (string.IsNullOrWhiteSpace(hostId))
            {
                continue;
            }

            logger.LogInformation(
                "Resolved stored Zabbix hostid {ZabbixHostId} from {BindingClass} for {SourceClass}/{SourceCardId}, profile {HostProfile}",
                hostId,
                options.Value.BindingClassName,
                sourceClass,
                sourceCardId,
                hostProfile);
            return hostId;
        }

        return null;
    }

    private async Task<JsonDocument> GetJsonAsync(string path, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(options.Value.RequestTimeoutMs));

        using var request = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl()}{path}");
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.Value.Username}:{options.Value.Password}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Add("CMDBuild-View", "admin");

        using var response = await httpClient.SendAsync(request, timeout.Token);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        return await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
    }

    private string BaseUrl()
    {
        return options.Value.BaseUrl.TrimEnd('/');
    }

    private static JsonElement[] ReadDataArray(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Array)
        {
            return data.EnumerateArray().Select(item => item.Clone()).ToArray();
        }

        return [];
    }

    private static JsonElement ReadDataObject(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Object)
        {
            return data.Clone();
        }

        return root.Clone();
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var property in element.EnumerateObject())
        {
            if (!string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.Number => property.Value.GetRawText(),
                JsonValueKind.True => bool.TrueString,
                JsonValueKind.False => bool.FalseString,
                _ => null
            };
        }

        return null;
    }

    private static bool Same(string? left, string? right)
    {
        return string.Equals(left ?? string.Empty, right ?? string.Empty, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsDeleted(string? bindingStatus)
    {
        return string.Equals(bindingStatus, "deleted", StringComparison.OrdinalIgnoreCase);
    }
}
