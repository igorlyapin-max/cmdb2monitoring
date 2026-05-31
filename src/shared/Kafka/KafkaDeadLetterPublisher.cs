using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace Cmdb2Monitoring.Kafka;

public sealed class KafkaDeadLetterPublisher(
    IProducer<string, string> producer,
    IOptions<KafkaDeadLetterOptions> options) : IKafkaDeadLetterPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<DeliveryResult<string, string>?> PublishAsync(
        KafkaDeadLetterMessage message,
        CancellationToken cancellationToken)
    {
        var currentOptions = options.Value;
        if (!currentOptions.Enabled)
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(currentOptions.Topic))
        {
            throw new InvalidOperationException("DeadLetter:Topic is required when DeadLetter:Enabled=true.");
        }

        var headers = new Headers();
        AddHeader(headers, currentOptions.ServiceHeaderName, message.Service);
        AddHeader(headers, currentOptions.ErrorCodeHeaderName, message.ErrorCode);
        AddHeader(headers, currentOptions.CorrelationHeaderName, message.CorrelationId);

        return await producer.ProduceAsync(currentOptions.Topic, new Message<string, string>
        {
            Key = message.InputKey ?? $"{message.InputTopic}:{message.InputPartition}:{message.InputOffset}",
            Value = JsonSerializer.Serialize(message, JsonOptions),
            Headers = headers
        }, cancellationToken);
    }

    private static void AddHeader(Headers headers, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(value))
        {
            headers.Add(name, Encoding.UTF8.GetBytes(value));
        }
    }
}
