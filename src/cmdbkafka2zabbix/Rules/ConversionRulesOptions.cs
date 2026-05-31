namespace CmdbKafka2Zabbix.Rules;

public sealed class ConversionRulesOptions
{
    public const string SectionName = "ConversionRules";

    public string RepositoryPath { get; init; } = string.Empty;

    public string BaseDirectory { get; init; } = ".";

    public bool ReadFromGit { get; init; }

    public string RepositoryUrl { get; init; } = string.Empty;

    public string TrustedArtifactPath { get; init; } = string.Empty;

    public bool RequireTrustedArtifactInProduction { get; init; }

    public string RulesFilePath { get; init; } = string.Empty;

    public bool PullOnStartup { get; init; }

    public bool PullOnReload { get; init; }

    public string GitExecutablePath { get; init; } = "git";

    public bool AllowRuntimeGitInProduction { get; init; }

    public string TemplateEngine { get; init; } = "Mono.TextTemplating";

    public string TemplateName { get; init; } = "hostCreateJsonRpcRequestLines";

    public bool AddDefaultDirectives { get; init; } = true;
}
