using Confluent.Kafka;
using ZabbixRequests2Api.Zabbix;

namespace ZabbixRequests2Api.Kafka;

public interface IZabbixBindingEventPublisher
{
    Task<DeliveryResult<string, string>?> PublishAsync(
        ZabbixProcessingResult result,
        ConsumeResult<string, string> input,
        CancellationToken cancellationToken);
}
