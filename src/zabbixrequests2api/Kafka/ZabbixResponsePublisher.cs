using System.Text;
using System.Text.Json.Nodes;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using ZabbixRequests2Api.Zabbix;

namespace ZabbixRequests2Api.Kafka;

public sealed class ZabbixResponsePublisher(
    IProducer<string, string> producer,
    IOptions<KafkaOptions> options,
    ILogger<ZabbixResponsePublisher> logger) : IZabbixResponsePublisher
{
    public async Task<DeliveryResult<string, string>> PublishAsync(
        ZabbixProcessingResult result,
        ConsumeResult<string, string> input,
        CancellationToken cancellationToken)
    {
        var outputOptions = options.Value.Output;
        var message = new Message<string, string>
        {
            Key = result.EntityId ?? result.Host ?? result.Method,
            Value = BuildPayload(result, input),
            Headers = BuildHeaders(result, outputOptions)
        };

        var deliveryResult = await producer.ProduceAsync(outputOptions.Topic, message, cancellationToken);
        logger.LogInformation(
            "Published Zabbix API response for method {Method}, entity {EntityId}, success {Success} to Kafka topic {Topic} partition {Partition} offset {Offset}",
            result.Method,
            result.EntityId ?? "<unknown>",
            result.Success,
            deliveryResult.Topic,
            deliveryResult.Partition.Value,
            deliveryResult.Offset.Value);

        return deliveryResult;
    }

    private static string BuildPayload(ZabbixProcessingResult result, ConsumeResult<string, string> input)
    {
        var payload = new JsonObject
        {
            ["source"] = "zabbixrequests2api",
            ["success"] = result.Success,
            ["method"] = result.Method,
            ["entityId"] = result.EntityId,
            ["requestId"] = result.RequestId,
            ["host"] = result.Host,
            ["hostProfile"] = result.HostProfileName,
            ["sourceClass"] = result.SourceClass,
            ["sourceCardId"] = result.SourceCardId,
            ["sourceCode"] = result.SourceCode,
            ["isMainProfile"] = result.IsMainProfile,
            ["zabbixHostId"] = result.ZabbixHostId,
            ["rulesVersion"] = result.RulesVersion,
            ["schemaVersion"] = result.SchemaVersion,
            ["errorCode"] = result.ErrorCode,
            ["errorMessage"] = result.ErrorMessage,
            ["zabbixRequestSent"] = result.ZabbixRequestSent,
            ["processedAt"] = result.ProcessedAt,
            ["input"] = new JsonObject
            {
                ["topic"] = input.Topic,
                ["partition"] = input.Partition.Value,
                ["offset"] = input.Offset.Value,
                ["key"] = input.Message.Key
            },
            ["missing"] = new JsonObject
            {
                ["hostGroups"] = ToJsonArray(result.MissingHostGroups),
                ["templates"] = ToJsonArray(result.MissingTemplates),
                ["templateGroups"] = ToJsonArray(result.MissingTemplateGroups)
            }
        };

        if (!string.IsNullOrWhiteSpace(result.ZabbixResponseJson))
        {
            payload["zabbixResponse"] = JsonNode.Parse(result.ZabbixResponseJson);
        }

        return payload.ToJsonString();
    }

    private static Headers BuildHeaders(ZabbixProcessingResult result, KafkaOutputOptions options)
    {
        var headers = new Headers();
        AddHeader(headers, options.SuccessHeaderName, result.Success ? "true" : "false");
        AddHeader(headers, options.MethodHeaderName, result.Method);
        AddHeader(headers, options.ErrorCodeHeaderName, result.ErrorCode ?? string.Empty);
        return headers;
    }

    private static void AddHeader(Headers headers, string name, string value)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        headers.Add(name, Encoding.UTF8.GetBytes(value));
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(value);
        }

        return array;
    }
}
