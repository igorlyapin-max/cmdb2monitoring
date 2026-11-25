namespace CmdbKafka2Zabbix.Rules;

public sealed record ConversionRulesReloadResult(
    string RuleName,
    string SchemaVersion,
    string RulesVersion,
    string ContentSha256,
    string Location,
    string? Version,
    string RepositoryPath,
    string RepositoryUrl,
    bool StorageRefreshed,
    DateTimeOffset ReloadedAt);
