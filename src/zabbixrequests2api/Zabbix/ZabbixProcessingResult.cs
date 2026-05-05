using System.Text.Json;

namespace ZabbixRequests2Api.Zabbix;

public sealed record ZabbixProcessingResult(
    bool Success,
    string? EntityId,
    string Method,
    string? RequestId,
    string? Host,
    string? HostProfileName,
    string? SourceClass,
    string? SourceCardId,
    string? SourceCode,
    bool IsMainProfile,
    string? RulesVersion,
    string? SchemaVersion,
    string? ZabbixHostId,
    string? ErrorCode,
    string? ErrorMessage,
    string[] MissingHostGroups,
    string[] MissingTemplates,
    string[] MissingTemplateGroups,
    bool ZabbixRequestSent,
    string? ZabbixResponseJson,
    DateTimeOffset ProcessedAt)
{
    public static ZabbixProcessingResult FromValidationError(
        ZabbixRequestDocument? request,
        string errorCode,
        string errorMessage,
        string[] missingHostGroups,
        string[] missingTemplates,
        string[] missingTemplateGroups)
    {
        return new ZabbixProcessingResult(
            Success: false,
            EntityId: request?.EntityId,
            Method: request?.Method ?? "unknown",
            RequestId: request?.RequestId,
            Host: request?.Host,
            HostProfileName: request?.HostProfileName,
            SourceClass: request?.SourceClass,
            SourceCardId: request?.SourceCardId ?? request?.EntityId,
            SourceCode: request?.SourceCode,
            IsMainProfile: request?.IsMainProfile ?? true,
            RulesVersion: request?.RulesVersion,
            SchemaVersion: request?.SchemaVersion,
            ZabbixHostId: null,
            ErrorCode: errorCode,
            ErrorMessage: errorMessage,
            MissingHostGroups: missingHostGroups,
            MissingTemplates: missingTemplates,
            MissingTemplateGroups: missingTemplateGroups,
            ZabbixRequestSent: false,
            ZabbixResponseJson: null,
            ProcessedAt: DateTimeOffset.UtcNow);
    }

    public static ZabbixProcessingResult FromApiResult(ZabbixRequestDocument request, ZabbixApiCallResult apiResult)
    {
        return new ZabbixProcessingResult(
            Success: apiResult.Success,
            EntityId: request.EntityId,
            Method: request.Method,
            RequestId: request.RequestId,
            Host: request.Host,
            HostProfileName: request.HostProfileName,
            SourceClass: request.SourceClass,
            SourceCardId: request.SourceCardId ?? request.EntityId,
            SourceCode: request.SourceCode,
            IsMainProfile: request.IsMainProfile,
            RulesVersion: request.RulesVersion,
            SchemaVersion: request.SchemaVersion,
            ZabbixHostId: ReadZabbixHostId(apiResult.ResponseJson) ?? ReadRequestHostId(request),
            ErrorCode: apiResult.ErrorCode,
            ErrorMessage: apiResult.ErrorMessage,
            MissingHostGroups: [],
            MissingTemplates: [],
            MissingTemplateGroups: [],
            ZabbixRequestSent: true,
            ZabbixResponseJson: apiResult.ResponseJson,
            ProcessedAt: DateTimeOffset.UtcNow);
    }

    public static ZabbixProcessingResult FromException(ZabbixRequestDocument? request, Exception exception)
    {
        return new ZabbixProcessingResult(
            Success: false,
            EntityId: request?.EntityId,
            Method: request?.Method ?? "unknown",
            RequestId: request?.RequestId,
            Host: request?.Host,
            HostProfileName: request?.HostProfileName,
            SourceClass: request?.SourceClass,
            SourceCardId: request?.SourceCardId ?? request?.EntityId,
            SourceCode: request?.SourceCode,
            IsMainProfile: request?.IsMainProfile ?? true,
            RulesVersion: request?.RulesVersion,
            SchemaVersion: request?.SchemaVersion,
            ZabbixHostId: null,
            ErrorCode: "zabbix_api_error",
            ErrorMessage: exception.Message,
            MissingHostGroups: [],
            MissingTemplates: [],
            MissingTemplateGroups: [],
            ZabbixRequestSent: false,
            ZabbixResponseJson: null,
            ProcessedAt: DateTimeOffset.UtcNow);
    }

    private static string? ReadZabbixHostId(string? responseJson)
    {
        if (string.IsNullOrWhiteSpace(responseJson))
        {
            return null;
        }

        using var document = JsonDocument.Parse(responseJson);
        if (!document.RootElement.TryGetProperty("result", out var result)
            || result.ValueKind != JsonValueKind.Object
            || !result.TryGetProperty("hostids", out var hostIds)
            || hostIds.ValueKind != JsonValueKind.Array
            || hostIds.GetArrayLength() == 0)
        {
            return null;
        }

        return ReadScalar(hostIds[0]);
    }

    private static string? ReadRequestHostId(ZabbixRequestDocument request)
    {
        return request.Params.ValueKind == JsonValueKind.Object
            && request.Params.TryGetProperty("hostid", out var hostId)
                ? ReadScalar(hostId)
                : null;
    }

    private static string? ReadScalar(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            _ => null
        };
    }
}
