using CmdbKafka2Zabbix.Kafka;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Processing;

public sealed class KafkaReadinessProbeWorker(
    IOptions<KafkaOptions> options,
    KafkaConsumerReadiness readiness,
    ILogger<KafkaReadinessProbeWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var input = options.Value.Input;
        readiness.ConfigureProbe(TimeSpan.FromMilliseconds(input.ReadinessProbeIntervalMs + input.ReadinessProbeTimeoutMs));
        using var admin = new AdminClientBuilder(input.BuildAdminConfig()).Build();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var metadata = admin.GetMetadata(input.Topic, TimeSpan.FromMilliseconds(input.ReadinessProbeTimeoutMs));
                if (metadata.Brokers.Count == 0 || metadata.Topics.Count != 1 || metadata.Topics[0].Error.IsError || metadata.Topics[0].Partitions.Count == 0 || metadata.Topics[0].Partitions.Any(partition => partition.Error.IsError || partition.Leader < 0))
                    throw new InvalidOperationException("Input topic metadata is unavailable.");
                readiness.MarkProbeSucceeded();
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                readiness.MarkProbeFailed();
                logger.LogWarning("Kafka readiness metadata probe failed: {ErrorType}", ex.GetType().Name);
            }
            await Task.Delay(input.ReadinessProbeIntervalMs, stoppingToken);
        }
    }
}
