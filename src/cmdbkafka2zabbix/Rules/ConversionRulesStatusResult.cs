namespace CmdbKafka2Zabbix.Rules;

public sealed record ConversionRulesStatusResult(
    string RuleName,
    string SchemaVersion,
    string RulesVersion,
    string Location,
    string? Version,
    string RepositoryPath,
    string RepositoryUrl,
    bool ReadFromGit,
    bool PullOnStartup,
    bool PullOnReload,
    string TemplateEngine,
    string TemplateName,
    string TrustedArtifactPath,
    bool RequireTrustedArtifactInProduction,
    DateTimeOffset? LastWriteTime,
    DateTimeOffset CheckedAt);
