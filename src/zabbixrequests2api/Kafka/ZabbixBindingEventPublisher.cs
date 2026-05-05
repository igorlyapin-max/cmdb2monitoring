using System.Text;
using System.Text.Json.Nodes;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using ZabbixRequests2Api.Zabbix;

namespace ZabbixRequests2Api.Kafka;

public sealed class ZabbixBindingEventPublisher : IZabbixBindingEventPublisher, IDisposable
{
    private readonly IProducer<string, string> producer;
    private readonly IOptions<KafkaOptions> options;
    private readonly ILogger<ZabbixBindingEventPublisher> logger;

    public ZabbixBindingEventPublisher(
        IOptions<KafkaOptions> options,
        ILogger<ZabbixBindingEventPublisher> logger)
    {
        this.options = options;
        this.logger = logger;
        producer = new ProducerBuilder<string, string>(options.Value.BindingOutput.BuildProducerConfig()).Build();
    }

    public async Task<DeliveryResult<string, string>?> PublishAsync(
        ZabbixProcessingResult result,
        ConsumeResult<string, string> input,
        CancellationToken cancellationToken)
    {
        if (!ShouldPublish(result))
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(result.SourceClass)
            || string.IsNullOrWhiteSpace(result.SourceCardId)
            || string.IsNullOrWhiteSpace(result.ZabbixHostId))
        {
            logger.LogWarning(
                "Skipping binding event for method {Method}, entity {EntityId}: missing source class/card id or Zabbix hostid",
                result.Method,
                result.EntityId ?? "<unknown>");
            return null;
        }

        var bindingStatus = BindingStatus(result.Method);
        var eventType = BindingEventType(result.Method);
        var outputOptions = options.Value.BindingOutput;
        var message = new Message<string, string>
        {
            Key = BindingKey(result),
            Value = BuildPayload(result, input, eventType, bindingStatus),
            Headers = BuildHeaders(result, outputOptions, eventType, bindingStatus)
        };

        var deliveryResult = await producer.ProduceAsync(outputOptions.Topic, message, cancellationToken);
        logger.LogInformation(
            "Published Zabbix binding event {EventType} for {SourceClass}/{SourceCardId}, profile {HostProfile}, hostid {ZabbixHostId} to Kafka topic {Topic} partition {Partition} offset {Offset}",
            eventType,
            result.SourceClass,
            result.SourceCardId,
            HostProfile(result),
            result.ZabbixHostId,
            deliveryResult.Topic,
            deliveryResult.Partition.Value,
            deliveryResult.Offset.Value);

        return deliveryResult;
    }

    public void Dispose()
    {
        producer.Dispose();
    }

    private static bool ShouldPublish(ZabbixProcessingResult result)
    {
        return result.Success
            && result.ZabbixRequestSent
            && (string.Equals(result.Method, "host.create", StringComparison.OrdinalIgnoreCase)
                || string.Equals(result.Method, "host.update", StringComparison.OrdinalIgnoreCase)
                || string.Equals(result.Method, "host.delete", StringComparison.OrdinalIgnoreCase));
    }

    private static string BindingKey(ZabbixProcessingResult result)
    {
        return $"{result.SourceClass}:{result.SourceCardId}:{HostProfile(result)}";
    }

    private static string HostProfile(ZabbixProcessingResult result)
    {
        return string.IsNullOrWhiteSpace(result.HostProfileName) ? "main" : result.HostProfileName;
    }

    private static string BindingEventType(string method)
    {
        return method.ToLowerInvariant() switch
        {
            "host.create" => "zabbix.host.binding.created",
            "host.update" => "zabbix.host.binding.updated",
            "host.delete" => "zabbix.host.binding.deleted",
            _ => "zabbix.host.binding.unknown"
        };
    }

    private static string BindingStatus(string method)
    {
        return string.Equals(method, "host.delete", StringComparison.OrdinalIgnoreCase) ? "deleted" : "active";
    }

    private static string BuildPayload(
        ZabbixProcessingResult result,
        ConsumeResult<string, string> input,
        string eventType,
        string bindingStatus)
    {
        var payload = new JsonObject
        {
            ["source"] = "zabbixrequests2api",
            ["eventType"] = eventType,
            ["operation"] = result.Method,
            ["sourceClass"] = result.SourceClass,
            ["sourceCardId"] = result.SourceCardId,
            ["sourceCode"] = result.SourceCode,
            ["hostProfile"] = HostProfile(result),
            ["isMainProfile"] = result.IsMainProfile,
            ["zabbixHostId"] = result.ZabbixHostId,
            ["zabbixHostName"] = result.Host,
            ["bindingStatus"] = bindingStatus,
            ["rulesVersion"] = result.RulesVersion,
            ["schemaVersion"] = result.SchemaVersion,
            ["requestId"] = result.RequestId,
            ["occurredAt"] = result.ProcessedAt,
            ["input"] = new JsonObject
            {
                ["topic"] = input.Topic,
                ["partition"] = input.Partition.Value,
                ["offset"] = input.Offset.Value,
                ["key"] = input.Message.Key
            }
        };

        return payload.ToJsonString();
    }

    private static Headers BuildHeaders(
        ZabbixProcessingResult result,
        KafkaBindingOutputOptions options,
        string eventType,
        string bindingStatus)
    {
        var headers = new Headers();
        AddHeader(headers, options.EventTypeHeaderName, eventType);
        AddHeader(headers, options.HostProfileHeaderName, HostProfile(result));
        AddHeader(headers, options.BindingStatusHeaderName, bindingStatus);
        return headers;
    }

    private static void AddHeader(Headers headers, string name, string value)
    {
        if (!string.IsNullOrWhiteSpace(name))
        {
            headers.Add(name, Encoding.UTF8.GetBytes(value));
        }
    }
}
