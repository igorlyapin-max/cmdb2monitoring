namespace Cmdb2Monitoring.Logging;

public sealed class ExtendedDebugLoggingOptions
{
    public const string SectionName = "DebugLogging";

    public bool Enabled { get; init; }

    public string Level { get; init; } = nameof(ExtendedDebugLogLevel.Basic);

    public bool HasValidLevel()
    {
        return string.Equals(Level, nameof(ExtendedDebugLogLevel.Basic), StringComparison.OrdinalIgnoreCase)
            || string.Equals(Level, nameof(ExtendedDebugLogLevel.Verbose), StringComparison.OrdinalIgnoreCase);
    }

    public bool IsEnabledFor(ExtendedDebugLogLevel eventLevel)
    {
        if (!Enabled || !HasValidLevel())
        {
            return false;
        }

        return eventLevel == ExtendedDebugLogLevel.Basic
            || string.Equals(Level, nameof(ExtendedDebugLogLevel.Verbose), StringComparison.OrdinalIgnoreCase);
    }
}
