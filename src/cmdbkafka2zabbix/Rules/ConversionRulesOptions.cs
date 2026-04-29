namespace CmdbKafka2Zabbix.Rules;

public sealed class ConversionRulesOptions
{
    public const string SectionName = "ConversionRules";

    public string RepositoryPath { get; init; } = string.Empty;

    public string RulesFilePath { get; init; } = string.Empty;

    public bool PullOnStartup { get; init; }

    public string GitExecutablePath { get; init; } = "git";

    public string TemplateEngine { get; init; } = "Mono.TextTemplating";

    public string TemplateName { get; init; } = "hostCreateJsonRpcRequestLines";

    public bool AddDefaultDirectives { get; init; } = true;
}
