namespace ZabbixRequests2Api.Zabbix;

public sealed record ZabbixTemplateInfo(
    string TemplateId,
    string Name,
    string Host,
    string[] TemplateGroupIds,
    string[] ItemKeys,
    string[] DiscoveryRuleKeys,
    ZabbixTemplateItemInfo[] InventoryLinkedItems);

public sealed record ZabbixTemplateItemInfo(string Key, string InventoryLink);
