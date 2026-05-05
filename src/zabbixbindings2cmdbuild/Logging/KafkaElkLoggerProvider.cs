using Confluent.Kafka;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Configuration;

namespace ZabbixBindings2Cmdbuild.Logging;

public sealed class KafkaElkLoggerProvider : ILoggerProvider
{
    private readonly ElkLoggingOptions options;
    private readonly IProducer<string, string>? producer;

    public KafkaElkLoggerProvider(IOptions<ElkLoggingOptions> options)
    {
        this.options = options.Value;

        if (!this.options.Enabled || !this.options.Kafka.Enabled)
        {
            return;
        }

        producer = new ProducerBuilder<string, string>(this.options.Kafka.BuildProducerConfig()).Build();
    }

    public ILogger CreateLogger(string categoryName)
    {
        if (!options.Enabled || !options.Kafka.Enabled || producer is null)
        {
            return NullLogger.Instance;
        }

        return new KafkaElkLogger(categoryName, options.Kafka, producer);
    }

    public void Dispose()
    {
        if (producer is null)
        {
            return;
        }

        producer.Flush(TimeSpan.FromMilliseconds(options.Kafka.FlushTimeoutMs));
        producer.Dispose();
    }

    private sealed class NullLogger : ILogger
    {
        public static readonly NullLogger Instance = new();

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
        {
            return null;
        }

        public bool IsEnabled(LogLevel logLevel)
        {
            return false;
        }

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
        }
    }
}
