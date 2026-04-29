using System.Text.Json;
using CmdbKafka2Zabbix.Conversion;
using CmdbKafka2Zabbix.Kafka;
using CmdbKafka2Zabbix.Rules;
using Confluent.Kafka;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Processing;

public sealed class KafkaConversionWorker(
    IOptions<KafkaOptions> kafkaOptions,
    IConversionRulesProvider rulesProvider,
    CmdbEventReader eventReader,
    CmdbToZabbixConverter converter,
    IZabbixRequestPublisher publisher,
    IProcessingStateStore stateStore,
    ILogger<KafkaConversionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var previousState = await stateStore.ReadAsync(stoppingToken);
        if (previousState is not null)
        {
            logger.LogInformation(
                "Loaded processing state: last entity {EntityId}, event {EventType}, input {Topic}[{Partition}]@{Offset}, processed at {ProcessedAt}",
                previousState.LastEntityId ?? "<unknown>",
                previousState.LastEventType ?? "<unknown>",
                previousState.LastInputTopic ?? "<unknown>",
                previousState.LastInputPartition,
                previousState.LastInputOffset,
                previousState.ProcessedAt);
        }

        var inputOptions = kafkaOptions.Value.Input;
        using var consumer = new ConsumerBuilder<string, string>(inputOptions.BuildConsumerConfig()).Build();
        consumer.Subscribe(inputOptions.Topic);

        logger.LogInformation(
            "Started Kafka consumer for topic {InputTopic} and group {GroupId}",
            inputOptions.Topic,
            inputOptions.GroupId);

        while (!stoppingToken.IsCancellationRequested)
        {
            ConsumeResult<string, string>? consumed = null;

            try
            {
                consumed = consumer.Consume(TimeSpan.FromMilliseconds(inputOptions.PollTimeoutMs));
                if (consumed is null)
                {
                    continue;
                }

                await ProcessMessageAsync(consumed, consumer, stoppingToken);
            }
            catch (ConsumeException ex)
            {
                logger.LogError(ex, "Kafka consume error: {KafkaReason}", ex.Error.Reason);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(
                    ex,
                    "Failed to process Kafka message from {Topic}[{Partition}]@{Offset}; message will be retried after restart or next poll",
                    consumed?.Topic ?? "<unknown>",
                    consumed?.Partition.Value,
                    consumed?.Offset.Value);

                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }

        consumer.Close();
    }

    private async Task ProcessMessageAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        CancellationToken cancellationToken)
    {
        var rules = await rulesProvider.GetRulesAsync(cancellationToken);
        CmdbSourceEvent source;

        try
        {
            source = eventReader.Read(consumed.Message.Value, rules);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(
                ex,
                "Skipping invalid JSON message from {Topic}[{Partition}]@{Offset}",
                consumed.Topic,
                consumed.Partition.Value,
                consumed.Offset.Value);

            await WriteStateAndCommitAsync(
                consumed,
                consumer,
                entityId: consumed.Message.Key,
                eventType: "unknown",
                outputPublished: false,
                skipReason: "invalid_json",
                cancellationToken);

            return;
        }

        var result = await converter.ConvertAsync(source, rules, cancellationToken);

        if (!result.ShouldPublish)
        {
            logger.LogInformation(
                "Skipped CMDBuild event {EventType} for entity {EntityId}: {SkipReason}",
                result.EventType,
                result.EntityId ?? "<unknown>",
                result.SkipReason);

            await WriteStateAndCommitAsync(
                consumed,
                consumer,
                result.EntityId,
                result.EventType,
                outputPublished: false,
                skipReason: result.SkipReason,
                cancellationToken);

            return;
        }

        var deliveryResult = await publisher.PublishAsync(result, cancellationToken);
        await WriteStateAndCommitAsync(
            consumed,
            consumer,
            result.EntityId,
            result.EventType,
            outputPublished: true,
            skipReason: null,
            cancellationToken,
            outputTopic: deliveryResult.Topic);

        logger.LogInformation(
            "Processed CMDBuild event {EventType} for entity {EntityId} into Zabbix host {Host}",
            result.EventType,
            result.EntityId ?? "<unknown>",
            result.Host ?? "<unknown>");
    }

    private async Task WriteStateAndCommitAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        string? entityId,
        string eventType,
        bool outputPublished,
        string? skipReason,
        CancellationToken cancellationToken,
        string? outputTopic = null)
    {
        await stateStore.WriteAsync(new ProcessingStateDocument(
            LastEntityId: entityId,
            LastEventType: eventType,
            LastInputTopic: consumed.Topic,
            LastInputPartition: consumed.Partition.Value,
            LastInputOffset: consumed.Offset.Value,
            LastOutputTopic: outputTopic,
            OutputPublished: outputPublished,
            SkipReason: skipReason,
            ProcessedAt: DateTimeOffset.UtcNow), cancellationToken);

        consumer.Commit(consumed);
    }
}
