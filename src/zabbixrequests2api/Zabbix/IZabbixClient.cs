namespace ZabbixRequests2Api.Zabbix;

public interface IZabbixClient
{
    Task<ZabbixApiCallResult> ExecuteAsync(ZabbixRequestDocument request, CancellationToken cancellationToken);

    Task<HashSet<string>> GetExistingHostGroupIdsAsync(
        IReadOnlyCollection<string> groupIds,
        CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<string, ZabbixTemplateInfo>> GetTemplateInfosAsync(
        IReadOnlyCollection<string> templateIds,
        CancellationToken cancellationToken);
}
