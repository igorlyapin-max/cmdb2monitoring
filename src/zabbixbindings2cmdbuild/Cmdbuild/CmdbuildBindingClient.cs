using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cmdb2Monitoring.Logging;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Models;

namespace ZabbixBindings2Cmdbuild.Cmdbuild;

public sealed class CmdbuildBindingClient(
    HttpClient httpClient,
    IOptions<CmdbuildOptions> options,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
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
        var attributeName = options.Value.MainHostIdAttributeName;
        var desiredHostId = IsDeleted(bindingEvent) ? null : bindingEvent.ZabbixHostId;
        var currentHostId = await TryReadCurrentMainHostIdAsync(bindingEvent, cancellationToken);
        if (currentHostId is not null && BindingValueMatches(currentHostId.Value.HostId, desiredHostId))
        {
            logger.LogInformation(
                "Skipped CMDBuild main host binding write for {SourceClass}/{SourceCardId}: {Attribute} is already {ZabbixHostId}",
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                attributeName,
                IsDeleted(bindingEvent) ? "<cleared>" : desiredHostId);
            return;
        }

        var body = new JsonObject
        {
            [attributeName] = desiredHostId
        };

        using var updateResponse = await SendAsync(
            HttpMethod.Put,
            $"/classes/{Uri.EscapeDataString(bindingEvent.SourceClass)}/cards/{Uri.EscapeDataString(bindingEvent.SourceCardId)}",
            body,
            cancellationToken);
        logger.LogVerbose(
            debugLoggingOptions,
            "Updated CMDBuild main host binding payload {CmdbuildPayload}",
            body.ToJsonString(JsonOptions));

        logger.LogInformation(
            "Updated CMDBuild main host binding for {SourceClass}/{SourceCardId}: {Attribute}={ZabbixHostId}",
            bindingEvent.SourceClass,
            bindingEvent.SourceCardId,
            attributeName,
            IsDeleted(bindingEvent) ? "<cleared>" : desiredHostId);
    }

    private async Task UpsertProfileBindingAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        var existingCard = await FindBindingCardAsync(bindingEvent, cancellationToken);
        var body = BuildBindingBody(bindingEvent);
        logger.LogBasic(
            debugLoggingOptions,
            "CMDBuild profile binding lookup for {SourceClass}/{SourceCardId}, profile {HostProfile}: existing card {BindingCardId}",
            bindingEvent.SourceClass,
            bindingEvent.SourceCardId,
            bindingEvent.HostProfile,
            existingCard?.CardId ?? "<new>");
        if (existingCard is null)
        {
            using var createResponse = await SendAsync(
                HttpMethod.Post,
                $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards",
                body,
                cancellationToken);
            logger.LogVerbose(
                debugLoggingOptions,
                "Created CMDBuild profile binding payload {CmdbuildPayload}",
                body.ToJsonString(JsonOptions));
            logger.LogInformation(
                "Created CMDBuild {BindingClass} binding for {SourceClass}/{SourceCardId}, profile {HostProfile}, hostid {ZabbixHostId}",
                options.Value.BindingClassName,
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                bindingEvent.HostProfile,
                bindingEvent.ZabbixHostId);
            return;
        }

        if (ProfileBindingMatches(existingCard.Value.Card, bindingEvent))
        {
            logger.LogInformation(
                "Skipped CMDBuild {BindingClass} binding write for {SourceClass}/{SourceCardId}, profile {HostProfile}: binding is already current",
                options.Value.BindingClassName,
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                bindingEvent.HostProfile);
            return;
        }

        using var updateResponse = await SendAsync(
            HttpMethod.Put,
            $"/classes/{Uri.EscapeDataString(options.Value.BindingClassName)}/cards/{Uri.EscapeDataString(existingCard.Value.CardId)}",
            body,
            cancellationToken);
        logger.LogVerbose(
            debugLoggingOptions,
            "Updated CMDBuild profile binding payload {CmdbuildPayload}",
            body.ToJsonString(JsonOptions));
        logger.LogInformation(
            "Updated CMDBuild {BindingClass} binding {BindingCardId} for {SourceClass}/{SourceCardId}, profile {HostProfile}, status {BindingStatus}",
            options.Value.BindingClassName,
            existingCard.Value.CardId,
            bindingEvent.SourceClass,
            bindingEvent.SourceCardId,
            bindingEvent.HostProfile,
            bindingEvent.BindingStatus);
    }

    private async Task<CurrentMainHostId?> TryReadCurrentMainHostIdAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
    {
        try
        {
            using var document = await SendAsync(
                HttpMethod.Get,
                $"/classes/{Uri.EscapeDataString(bindingEvent.SourceClass)}/cards/{Uri.EscapeDataString(bindingEvent.SourceCardId)}",
                null,
                cancellationToken);
            var data = ReadDataObject(document?.RootElement);
            return data is null
                ? null
                : new CurrentMainHostId(ReadString(data.Value, options.Value.MainHostIdAttributeName));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(
                ex,
                "Failed to read current CMDBuild main host binding for {SourceClass}/{SourceCardId}; binding writer will perform the write",
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId);
            return null;
        }
    }

    private async Task<ExistingBindingCard?> FindBindingCardAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken)
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
                var cardId = ReadString(card, "_id") ?? ReadString(card, "id");
                return string.IsNullOrWhiteSpace(cardId)
                    ? null
                    : new ExistingBindingCard(cardId, card.Clone());
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

    private static bool ProfileBindingMatches(JsonElement card, ZabbixBindingEvent bindingEvent)
    {
        return Same(ReadString(card, "OwnerClass"), bindingEvent.SourceClass)
            && Same(ReadString(card, "OwnerCardId"), bindingEvent.SourceCardId)
            && Same(ReadString(card, "OwnerCode"), bindingEvent.SourceCode)
            && Same(ReadString(card, "HostProfile"), bindingEvent.HostProfile)
            && Same(ReadString(card, "ZabbixHostId"), bindingEvent.ZabbixHostId)
            && Same(ReadString(card, "ZabbixHostName"), bindingEvent.ZabbixHostName)
            && Same(ReadString(card, "BindingStatus"), bindingEvent.BindingStatus)
            && Same(ReadString(card, "RulesVersion"), bindingEvent.RulesVersion);
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
        logger.LogVerbose(
            debugLoggingOptions,
            "CMDBuild {HttpMethod} {Path} returned HTTP {StatusCode}",
            method.Method,
            path,
            (int)response.StatusCode);
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

    private static JsonElement? ReadDataObject(JsonElement? root)
    {
        if (root is { ValueKind: JsonValueKind.Object } rootObject
            && rootObject.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Object)
        {
            return data;
        }

        return null;
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

    private static bool BindingValueMatches(string? left, string? right)
    {
        return string.IsNullOrWhiteSpace(left) && string.IsNullOrWhiteSpace(right)
            || Same(left, right);
    }

    private static bool IsDeleted(ZabbixBindingEvent bindingEvent)
    {
        return string.Equals(bindingEvent.BindingStatus, "deleted", StringComparison.OrdinalIgnoreCase)
            || string.Equals(bindingEvent.Operation, "host.delete", StringComparison.OrdinalIgnoreCase);
    }

    private readonly record struct CurrentMainHostId(string? HostId);

    private readonly record struct ExistingBindingCard(string CardId, JsonElement Card);
}
