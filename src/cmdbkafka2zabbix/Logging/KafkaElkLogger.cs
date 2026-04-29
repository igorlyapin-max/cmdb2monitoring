namespace CmdbKafka2Zabbix.Logging;

internal sealed class KafkaElkLogger(string categoryName, KafkaElkLoggerProvider provider) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull
    {
        return provider.ScopeProvider.Push(state);
    }

    public bool IsEnabled(LogLevel logLevel)
    {
        return provider.IsEnabled(logLevel);
    }

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
        {
            return;
        }

        provider.Write(categoryName, logLevel, eventId, state, exception, formatter);
    }
}
