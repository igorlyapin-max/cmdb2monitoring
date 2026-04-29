using CmdbWebhooks2Kafka.Kafka;
using Microsoft.Extensions.Logging;

namespace CmdbWebhooks2Kafka.Configuration;

public sealed class ElkLoggingOptions
{
    public const string SectionName = "ElkLogging";

    public bool Enabled { get; init; }

    public string Mode { get; init; } = "Kafka";

    public ElkEndpointOptions Elk { get; init; } = new();

    public ElkKafkaOptions Kafka { get; init; } = new();

    public bool HasValidMode()
    {
        return string.Equals(Mode, "Kafka", StringComparison.OrdinalIgnoreCase)
            || string.Equals(Mode, "Elasticsearch", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed class ElkEndpointOptions
{
    public bool Enabled { get; init; }

    public string Endpoint { get; init; } = string.Empty;

    public string Index { get; init; } = string.Empty;

    public string ApiKey { get; init; } = string.Empty;
}

public sealed class ElkKafkaOptions : KafkaClientOptions
{
    public bool Enabled { get; init; }

    public string Topic { get; init; } = string.Empty;

    public string MinimumLevel { get; init; } = nameof(LogLevel.Information);

    public string ServiceName { get; init; } = string.Empty;

    public string Environment { get; init; } = string.Empty;

    public int FlushTimeoutMs { get; init; } = 5000;

    public KafkaTopicProvisioningOptions TopicProvisioning { get; init; } = new();

    public bool HasValidMinimumLevel()
    {
        return Enum.TryParse<LogLevel>(MinimumLevel, ignoreCase: true, out _);
    }

    public LogLevel GetMinimumLevel()
    {
        return Enum.Parse<LogLevel>(MinimumLevel, ignoreCase: true);
    }
}
