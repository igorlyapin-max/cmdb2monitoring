using System.Text;
using CmdbKafka2Zabbix.Conversion;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Kafka;

public sealed class ZabbixRequestPublisher(
    IProducer<string, string> producer,
    IOptions<KafkaOptions> options,
    ILogger<ZabbixRequestPublisher> logger) : IZabbixRequestPublisher
{
    public async Task<DeliveryResult<string, string>> PublishAsync(
        ZabbixConversionResult result,
        CancellationToken cancellationToken)
    {
        if (!result.ShouldPublish || string.IsNullOrWhiteSpace(result.Value))
        {
            throw new InvalidOperationException("Skipped conversion result cannot be published.");
        }

        var outputOptions = options.Value.Output;
        var deliveryResult = await producer.ProduceAsync(outputOptions.Topic, new Message<string, string>
        {
            Key = result.Key ?? result.EntityId ?? result.Host ?? result.EventType,
            Value = result.Value,
            Headers = BuildHeaders(result, outputOptions)
        }, cancellationToken);

        logger.LogInformation(
            "Published Zabbix request {Method} for entity {EntityId} to Kafka topic {Topic} partition {Partition} offset {Offset}",
            result.Method,
            result.EntityId ?? "<unknown>",
            deliveryResult.Topic,
            deliveryResult.Partition.Value,
            deliveryResult.Offset.Value);

        return deliveryResult;
    }

    private static Headers BuildHeaders(ZabbixConversionResult result, KafkaOutputOptions options)
    {
        var headers = new Headers
        {
            { options.MethodHeaderName, Encoding.UTF8.GetBytes(result.Method) },
            { options.EventTypeHeaderName, Encoding.UTF8.GetBytes(result.EventType) },
            { options.EntityIdHeaderName, Encoding.UTF8.GetBytes(result.EntityId ?? string.Empty) }
        };

        if (!string.IsNullOrWhiteSpace(options.ProfileHeaderName))
        {
            headers.Add(options.ProfileHeaderName, Encoding.UTF8.GetBytes(result.ProfileName ?? string.Empty));
        }

        return headers;
    }
}
