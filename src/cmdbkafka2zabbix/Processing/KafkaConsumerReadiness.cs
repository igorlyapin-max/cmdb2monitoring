using Cmdb2Monitoring.Metrics;

namespace CmdbKafka2Zabbix.Processing;

public sealed class KafkaConsumerReadiness : IReadinessCheck
{
    private int assigned;

    public string Name => "kafka-consumer";

    public void MarkAssigned(int partitionCount)
    {
        Volatile.Write(ref assigned, partitionCount > 0 ? 1 : 0);
    }

    public void MarkUnavailable()
    {
        Volatile.Write(ref assigned, 0);
    }

    public Task<ReadinessCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        var ready = Volatile.Read(ref assigned) == 1;
        return Task.FromResult(new ReadinessCheckResult(
            Name,
            ready,
            ready ? "Kafka consumer has an assigned partition." : "Kafka consumer has no assigned partition."));
    }
}
