using Confluent.Kafka;

namespace Cmdb2Monitoring.Kafka;

public interface IKafkaDeadLetterPublisher
{
    Task<DeliveryResult<string, string>?> PublishAsync(
        KafkaDeadLetterMessage message,
        CancellationToken cancellationToken);
}
