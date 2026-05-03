namespace CmdbKafka2Zabbix.Rules;

public sealed record ConversionRulesStatusResult(
    string RuleName,
    string SchemaVersion,
    string RulesVersion,
    string Location,
    string? Version,
    bool ReadFromGit,
    DateTimeOffset? LastWriteTime,
    DateTimeOffset CheckedAt);
