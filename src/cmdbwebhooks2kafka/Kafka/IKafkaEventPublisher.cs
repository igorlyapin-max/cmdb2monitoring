using CmdbWebhooks2Kafka.Models;

namespace CmdbWebhooks2Kafka.Kafka;

public interface IKafkaEventPublisher
{
    Task PublishAsync(CmdbWebhookEnvelope envelope, CancellationToken cancellationToken);
}
