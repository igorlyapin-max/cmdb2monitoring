using System.Text;
using System.Text.Json;
using CmdbWebhooks2Kafka.Models;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace CmdbWebhooks2Kafka.Kafka;

public sealed class KafkaEventPublisher(
    IProducer<string, string> producer,
    IOptions<KafkaOptions> options,
    ILogger<KafkaEventPublisher> logger) : IKafkaEventPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task PublishAsync(CmdbWebhookEnvelope envelope, CancellationToken cancellationToken)
    {
        var topic = options.Value.Topic;
        var key = envelope.EntityId ?? envelope.EventType;
        var value = JsonSerializer.Serialize(envelope, JsonOptions);

        var result = await producer.ProduceAsync(topic, new Message<string, string>
        {
            Key = key,
            Value = value,
            Headers = new Headers
            {
                { options.Value.SourceHeaderName, Encoding.UTF8.GetBytes(envelope.Source) },
                { options.Value.EventTypeHeaderName, Encoding.UTF8.GetBytes(envelope.EventType) }
            }
        }, cancellationToken);

        logger.LogInformation(
            "Published CMDBuild webhook to Kafka topic {Topic} partition {Partition} offset {Offset}",
            result.Topic,
            result.Partition.Value,
            result.Offset.Value);
    }
}
