namespace CmdbKafka2Zabbix.Rules;

public static class RulesArtifactFailureCodes
{
    public const string FileMissing = "rules_file_missing";
    public const string FileUnreadable = "rules_file_unreadable";
    public const string Invalid = "rules_invalid";
    public const string PathInvalid = "rules_path_invalid";
    public const string StatusFailed = "rules_status_failed";

    public static bool IsKnown(string code) => code is FileMissing
        or FileUnreadable
        or Invalid
        or PathInvalid
        or StatusFailed;
}

public sealed class RulesArtifactException(
    string failureCode,
    string stage,
    string configuredPath,
    string? resolvedPath = null,
    Exception? innerException = null)
    : Exception("Rules artifact inspection failed.", innerException)
{
    public string FailureCode { get; } = failureCode;

    public string Stage { get; } = stage;

    public string ConfiguredPath { get; } = configuredPath;

    public string? ResolvedPath { get; } = resolvedPath;
}
