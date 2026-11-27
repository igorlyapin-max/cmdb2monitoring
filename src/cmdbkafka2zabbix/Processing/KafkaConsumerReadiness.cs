using Cmdb2Monitoring.Metrics;

namespace CmdbKafka2Zabbix.Processing;

public sealed class KafkaConsumerReadiness : IReadinessCheck
{
    private int assigned;
    private int consecutiveErrors;
    private int fatal;
    private long lastProbeSuccessTicks;
    private long maxProbeAgeTicks = TimeSpan.FromSeconds(13).Ticks;

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

    public void ConfigureProbe(TimeSpan maxAge) => Volatile.Write(ref maxProbeAgeTicks, maxAge.Ticks);

    public void MarkProbeSucceeded() => Volatile.Write(ref lastProbeSuccessTicks, DateTimeOffset.UtcNow.UtcTicks);

    public void MarkProbeFailed() => Volatile.Write(ref lastProbeSuccessTicks, 0);

    public Task<ReadinessCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        var probeTicks = Volatile.Read(ref lastProbeSuccessTicks);
        var probeReady = probeTicks > 0 && DateTimeOffset.UtcNow.UtcTicks - probeTicks <= Volatile.Read(ref maxProbeAgeTicks);
        var ready = Volatile.Read(ref assigned) == 1 && Volatile.Read(ref consecutiveErrors) < 3 && probeReady;
        var message = ready
            ? "Kafka consumer has an assigned partition."
            : Volatile.Read(ref assigned) == 1
                ? (probeReady ? "Kafka consumer has repeated consume errors." : "Kafka topic metadata probe is unavailable or stale.")
                : "Kafka consumer has no assigned partition.";
        return Task.FromResult(new ReadinessCheckResult(
            Name,
            ready,
            message));
    }
}
