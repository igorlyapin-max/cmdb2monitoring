using Cmdb2Monitoring.Metrics;

namespace CmdbKafka2Zabbix.Processing;

public sealed class KafkaConsumerReadiness : IReadinessCheck
{
    private int assigned;
    private int consecutiveErrors;
    private int fatal;

    public string Name => "kafka-consumer";

    public void MarkAssigned(int partitionCount)
    {
        Volatile.Write(ref assigned, partitionCount > 0 ? 1 : 0);
        Volatile.Write(ref consecutiveErrors, 0);
        Volatile.Write(ref fatal, 0);
    }

    public void MarkUnavailable()
    {
        Volatile.Write(ref assigned, 0);
    }

    public void MarkConsumerError(bool isFatal)
    {
        if (isFatal)
        {
            Volatile.Write(ref fatal, 1);
            MarkUnavailable();
        }
        else
        {
            Interlocked.Increment(ref consecutiveErrors);
        }
    }

    public void MarkPollSucceeded()
    {
        if (Volatile.Read(ref fatal) == 0)
        {
            Volatile.Write(ref consecutiveErrors, 0);
        }
    }

    public Task<ReadinessCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        var ready = Volatile.Read(ref assigned) == 1 && Volatile.Read(ref consecutiveErrors) < 3;
        var message = ready
            ? "Kafka consumer has an assigned partition."
            : Volatile.Read(ref assigned) == 1
                ? "Kafka consumer has repeated consume errors."
                : "Kafka consumer has no assigned partition.";
        return Task.FromResult(new ReadinessCheckResult(
            Name,
            ready,
            message));
    }
}
