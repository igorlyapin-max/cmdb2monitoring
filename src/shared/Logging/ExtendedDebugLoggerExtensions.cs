using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cmdb2Monitoring.Logging;

public static class ExtendedDebugLoggerExtensions
{
    private static readonly EventId EventId = new(2000, "ExtendedDebug");

    public static void LogBasic(
        this ILogger logger,
        IOptions<ExtendedDebugLoggingOptions> options,
        string message,
        params object?[] args)
    {
        logger.LogExtendedDebug(options, ExtendedDebugLogLevel.Basic, message, args);
    }

    public static void LogVerbose(
        this ILogger logger,
        IOptions<ExtendedDebugLoggingOptions> options,
        string message,
        params object?[] args)
    {
        logger.LogExtendedDebug(options, ExtendedDebugLogLevel.Verbose, message, args);
    }

    public static void LogExtendedDebug(
        this ILogger logger,
        IOptions<ExtendedDebugLoggingOptions> options,
        ExtendedDebugLogLevel level,
        string message,
        params object?[] args)
    {
        if (!options.Value.IsEnabledFor(level))
        {
            return;
        }

        logger.LogInformation(EventId, $"ExtendedDebug {level}: {message}", args);
    }
}
