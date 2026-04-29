namespace ZabbixRequests2Api.Zabbix;

public sealed record ZabbixApiCallResult(
    bool Success,
    string? ResponseJson,
    string? ErrorCode,
    string? ErrorMessage)
{
    public static ZabbixApiCallResult Failed(string code, string message, string? responseJson = null)
    {
        return new ZabbixApiCallResult(false, responseJson, code, message);
    }
}
