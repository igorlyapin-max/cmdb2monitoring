using Confluent.Kafka;
using Confluent.Kafka.Admin;
using CmdbWebhooks2Kafka.Configuration;
using Microsoft.Extensions.Options;

namespace CmdbWebhooks2Kafka.Kafka;

public sealed class KafkaTopicProvisioner(
    IOptions<KafkaOptions> kafkaOptions,
    IOptions<ElkLoggingOptions> elkLoggingOptions,
    ILogger<KafkaTopicProvisioner> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await EnsureTopicAsync(
            kafkaOptions.Value,
            kafkaOptions.Value.Topic,
            kafkaOptions.Value.TopicProvisioning,
            cancellationToken);

        var elkOptions = elkLoggingOptions.Value;
        if (elkOptions.Enabled && elkOptions.Kafka.Enabled)
        {
            await EnsureTopicAsync(
                elkOptions.Kafka,
                elkOptions.Kafka.Topic,
                elkOptions.Kafka.TopicProvisioning,
                cancellationToken);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    private async Task EnsureTopicAsync(
        KafkaClientOptions clientOptions,
        string topic,
        KafkaTopicProvisioningOptions provisioningOptions,
        CancellationToken cancellationToken)
    {
        if (!provisioningOptions.Enabled)
        {
            return;
        }

        try
        {
            using var adminClient = new AdminClientBuilder(clientOptions.BuildAdminClientConfig()).Build();
            await adminClient.CreateTopicsAsync(
                [
                    new TopicSpecification
                    {
                        Name = topic,
                        NumPartitions = provisioningOptions.Partitions,
                        ReplicationFactor = provisioningOptions.ReplicationFactor
                    }
                ],
                new CreateTopicsOptions
                {
                    RequestTimeout = TimeSpan.FromMilliseconds(provisioningOptions.RequestTimeoutMs)
                }).WaitAsync(cancellationToken);

            logger.LogInformation("Kafka topic {Topic} created", topic);
        }
        catch (CreateTopicsException ex) when (ex.Results.All(result => result.Error.Code == ErrorCode.TopicAlreadyExists))
        {
            logger.LogInformation("Kafka topic {Topic} already exists", topic);
        }
        catch (Exception ex) when (!provisioningOptions.FailOnError)
        {
            logger.LogWarning(ex, "Kafka topic {Topic} was not created", topic);
        }
    }
}
