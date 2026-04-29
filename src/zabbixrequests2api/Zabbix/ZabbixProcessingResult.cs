namespace ZabbixRequests2Api.Zabbix;

public sealed record ZabbixProcessingResult(
    bool Success,
    string? EntityId,
    string Method,
    string? RequestId,
    string? Host,
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
            ErrorCode: "zabbix_api_error",
            ErrorMessage: exception.Message,
            MissingHostGroups: [],
            MissingTemplates: [],
            MissingTemplateGroups: [],
            ZabbixRequestSent: false,
            ZabbixResponseJson: null,
            ProcessedAt: DateTimeOffset.UtcNow);
    }
}
