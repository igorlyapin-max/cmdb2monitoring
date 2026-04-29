using CmdbKafka2Zabbix.Conversion;
using Confluent.Kafka;

namespace CmdbKafka2Zabbix.Kafka;

public interface IZabbixRequestPublisher
{
    Task<DeliveryResult<string, string>> PublishAsync(ZabbixConversionResult result, CancellationToken cancellationToken);
}
