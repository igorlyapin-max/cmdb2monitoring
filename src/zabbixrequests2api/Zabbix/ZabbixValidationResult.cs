namespace ZabbixRequests2Api.Zabbix;

public sealed class ZabbixValidationResult
{
    public bool IsValid => Errors.Count == 0;

    public List<ZabbixValidationError> Errors { get; } = [];

    public List<string> MissingHostGroups { get; } = [];

    public List<string> MissingTemplates { get; } = [];

    public List<string> MissingTemplateGroups { get; } = [];

    public void AddError(string code, string message)
    {
        Errors.Add(new ZabbixValidationError(code, message));
    }

    public string PrimaryErrorCode()
    {
        return Errors.FirstOrDefault()?.Code ?? "invalid_zabbix_request";
    }

    public string PrimaryErrorMessage()
    {
        return Errors.FirstOrDefault()?.Message ?? "Invalid Zabbix request.";
    }
}

public sealed record ZabbixValidationError(string Code, string Message);
