using System.Text.Json;
using Confluent.Kafka;
using ZabbixRequests2Api.Configuration;

namespace ZabbixRequests2Api.Logging;

internal sealed class KafkaElkLogger(
    string categoryName,
    KafkaLogDestinationOptions options,
    IProducer<string, string> producer) : ILogger
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull
    {
        return null;
    }

    public bool IsEnabled(LogLevel logLevel)
    {
        return logLevel != LogLevel.None && logLevel >= options.GetMinimumLevel();
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

        var payload = JsonSerializer.Serialize(new
        {
            timestamp = DateTimeOffset.UtcNow,
            level = logLevel.ToString(),
            category = categoryName,
            eventId = eventId.Id,
            eventName = eventId.Name,
            message = formatter(state, exception),
            exception = exception?.ToString(),
            service = options.ServiceName,
            environment = options.Environment
        }, JsonOptions);

        _ = producer.ProduceAsync(
            options.Topic,
            new Message<string, string>
            {
                Key = categoryName,
                Value = payload
            });
    }
}
