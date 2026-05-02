namespace CmdbKafka2Zabbix.Rules;

public sealed record ConversionRulesReloadResult(
    string RuleName,
    string SchemaVersion,
    string RulesVersion,
    string Location,
    string? Version,
    bool StorageRefreshed,
    DateTimeOffset ReloadedAt);
