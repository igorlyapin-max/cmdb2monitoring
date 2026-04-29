using System.Text.Json;
using CmdbWebhooks2Kafka.Configuration;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace CmdbWebhooks2Kafka.Logging;

public sealed class KafkaElkLoggerProvider : ILoggerProvider, ISupportExternalScope
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ElkLoggingOptions options;
    private readonly LogLevel minimumLevel;
    private readonly IProducer<string, string>? producer;
    private bool disposed;

    internal IExternalScopeProvider ScopeProvider { get; private set; } = new LoggerExternalScopeProvider();

    public KafkaElkLoggerProvider(IOptions<ElkLoggingOptions> options)
    {
        this.options = options.Value;
        minimumLevel = this.options.Kafka.HasValidMinimumLevel()
            ? this.options.Kafka.GetMinimumLevel()
            : LogLevel.Information;

        if (!this.options.Enabled || !this.options.Kafka.Enabled)
        {
            return;
        }

        producer = new ProducerBuilder<string, string>(this.options.Kafka.BuildProducerConfig()).Build();
    }

    public ILogger CreateLogger(string categoryName)
    {
        return new KafkaElkLogger(categoryName, this);
    }

    public void SetScopeProvider(IExternalScopeProvider scopeProvider)
    {
        ScopeProvider = scopeProvider;
    }

    internal bool IsEnabled(LogLevel logLevel)
    {
        return !disposed
            && producer is not null
            && logLevel != LogLevel.None
            && logLevel >= minimumLevel;
    }

    internal void Write<TState>(
        string categoryName,
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

        try
        {
            var message = formatter(state, exception);
            if (string.IsNullOrWhiteSpace(message) && exception is null)
            {
                return;
            }

            var logRecord = BuildLogRecord(categoryName, logLevel, eventId, state, exception, message);
            var value = JsonSerializer.Serialize(logRecord, JsonOptions);
            var key = eventId.Id != 0 ? eventId.Id.ToString() : categoryName;

            producer?.Produce(options.Kafka.Topic, new Message<string, string>
            {
                Key = key,
                Value = value,
                Headers = new Headers
                {
                    { "service", JsonSerializer.SerializeToUtf8Bytes(options.Kafka.ServiceName, JsonOptions) },
                    { "environment", JsonSerializer.SerializeToUtf8Bytes(options.Kafka.Environment, JsonOptions) },
                    { "level", JsonSerializer.SerializeToUtf8Bytes(logLevel.ToString(), JsonOptions) }
                }
            });
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to write log event to Kafka topic '{options.Kafka.Topic}': {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;

        if (producer is not null)
        {
            producer.Flush(TimeSpan.FromMilliseconds(options.Kafka.FlushTimeoutMs));
            producer.Dispose();
        }
    }

    private Dictionary<string, object?> BuildLogRecord<TState>(
        string categoryName,
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        string message)
    {
        var record = new Dictionary<string, object?>
        {
            ["@timestamp"] = DateTimeOffset.UtcNow,
            ["message"] = message,
            ["log.level"] = logLevel.ToString(),
            ["log.logger"] = categoryName,
            ["event.id"] = eventId.Id,
            ["event.name"] = eventId.Name,
            ["service.name"] = options.Kafka.ServiceName,
            ["service.environment"] = options.Kafka.Environment
        };

        var stateValues = ReadStateValues(state);
        if (stateValues.Count > 0)
        {
            record["labels"] = stateValues;
        }

        var scopes = ReadScopes();
        if (scopes.Count > 0)
        {
            record["scope"] = scopes;
        }

        if (exception is not null)
        {
            record["error.type"] = exception.GetType().FullName;
            record["error.message"] = exception.Message;
            record["error.stack_trace"] = exception.ToString();
        }

        return record;
    }

    private static Dictionary<string, object?> ReadStateValues<TState>(TState state)
    {
        var values = new Dictionary<string, object?>();

        if (state is not IEnumerable<KeyValuePair<string, object?>> stateProperties)
        {
            return values;
        }

        foreach (var property in stateProperties)
        {
            if (property.Key == "{OriginalFormat}")
            {
                values["event.original"] = property.Value;
                continue;
            }

            values[property.Key] = property.Value;
        }

        return values;
    }

    private List<object?> ReadScopes()
    {
        var scopes = new List<object?>();

        ScopeProvider.ForEachScope((scope, state) =>
        {
            state.Add(scope);
        }, scopes);

        return scopes;
    }
}
