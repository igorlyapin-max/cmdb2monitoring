using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Models;

namespace ZabbixBindings2Cmdbuild.Cmdbuild;

public sealed class CmdbuildBindingClient(
    HttpClient httpClient,
    IOptions<CmdbuildOptions> options,
    ILogger<CmdbuildBindingClient> logger) : ICmdbuildBindingClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task ApplyAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        if (bindingEvent.IsMainProfile)
        {
            await UpdateMainHostIdAsync(bindingEvent, cancellationToken);
            return;
        }

        await UpsertProfileBindingAsync(bindingEvent, cancellationToken);
    }

    private async Task UpdateMainHostIdAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        var body = new JsonObject();
        if (IsDeleted(bindingEvent))
        {
            body[options.Value.MainHostIdAttributeName] = null;
        }
        else
        {
            body[options.Value.MainHostIdAttributeName] = bindingEvent.ZabbixHostId;
        }

        using var updateResponse = await SendAsync(
            HttpMethod.Put,
            $"/classes/{Uri.EscapeDataString(bindingEvent.SourceClass)}/cards/{Uri.EscapeDataString(bindingEvent.SourceCardId)}",
            body,
            cancellationToken);

        logger.LogInformation(
            "Updated CMDBuild main host binding for {SourceClass}/{SourceCardId}: {Attribute}={ZabbixHostId}",
            bindingEvent.SourceClass,
            bindingEvent.SourceCardId,
            options.Value.MainHostIdAttributeName,
            IsDeleted(bindingEvent) ? "<cleared>" : bindingEvent.ZabbixHostId);
    }

    private async Task UpsertProfileBindingAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        var existingCardId = await FindBindingCardIdAsync(bindingEvent, cancellationToken);
        var body = BuildBindingBody(bindingEvent);
        if (string.IsNullOrWhiteSpace(existingCardId))
        {
            using var createResponse = await SendAsync(
                HttpMethod.Post,
                $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards",
                body,
                cancellationToken);
            logger.LogInformation(
                "Created CMDBuild {BindingClass} binding for {SourceClass}/{SourceCardId}, profile {HostProfile}, hostid {ZabbixHostId}",
                options.Value.BindingClassName,
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                bindingEvent.HostProfile,
                bindingEvent.ZabbixHostId);
            return;
        }

        using var updateResponse = await SendAsync(
            HttpMethod.Put,
            $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards/{Uri.EscapeDataString(existingCardId)}",
            body,
            cancellationToken);
        logger.LogInformation(
            "Updated CMDBuild {BindingClass} binding {BindingCardId} for {SourceClass}/{SourceCardId}, profile {HostProfile}, status {BindingStatus}",
            options.Value.BindingClassName,
            existingCardId,
            bindingEvent.SourceClass,
            bindingEvent.SourceCardId,
            bindingEvent.HostProfile,
            bindingEvent.BindingStatus);
    }

    private async Task<string?> FindBindingCardIdAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        using var document = await SendAsync(
            HttpMethod.Get,
            $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards?limit={Math.Max(1, options.Value.BindingLookupLimit)}",
            null,
            cancellationToken);
        if (document is null)
        {
            return null;
        }

        foreach (var card in ReadDataArray(document.RootElement))
        {
            if (Same(ReadString(card, "OwnerClass"), bindingEvent.SourceClass)
                && Same(ReadString(card, "OwnerCardId"), bindingEvent.SourceCardId)
                && Same(ReadString(card, "HostProfile"), bindingEvent.HostProfile))
            {
                return ReadString(card, "_id") ?? ReadString(card, "id");
            }
        }

        return null;
    }

    private static JsonObject BuildBindingBody(ZabbixBindingEvent bindingEvent)
    {
        return new JsonObject
        {
            ["OwnerClass"] = bindingEvent.SourceClass,
            ["OwnerCardId"] = bindingEvent.SourceCardId,
            ["OwnerCode"] = bindingEvent.SourceCode,
            ["HostProfile"] = bindingEvent.HostProfile,
            ["ZabbixHostId"] = bindingEvent.ZabbixHostId,
            ["ZabbixHostName"] = bindingEvent.ZabbixHostName,
            ["BindingStatus"] = bindingEvent.BindingStatus,
            ["RulesVersion"] = bindingEvent.RulesVersion,
            ["LastSyncAt"] = DateTimeOffset.UtcNow.ToString("O")
        };
    }

    private async Task<JsonDocument?> SendAsync(
        HttpMethod method,
        string path,
        JsonObject? body,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(options.Value.RequestTimeoutMs));

        using var request = new HttpRequestMessage(method, $"{BaseUrl()}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.Value.Username}:{options.Value.Password}")));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Add("CMDBuild-View", "admin");

        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(JsonOptions), Encoding.UTF8, "application/json");
        }

        using var response = await httpClient.SendAsync(request, timeout.Token);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength == 0)
        {
            return null;
        }

        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        return JsonDocument.Parse(text);
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

    private static bool IsDeleted(ZabbixBindingEvent bindingEvent)
    {
        return string.Equals(bindingEvent.BindingStatus, "deleted", StringComparison.OrdinalIgnoreCase)
            || string.Equals(bindingEvent.Operation, "host.delete", StringComparison.OrdinalIgnoreCase);
    }
}
