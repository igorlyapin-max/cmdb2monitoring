using System.Diagnostics;
using System.Text.Json;
using Cmdb2Monitoring.Logging;
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
    CmdbSourceFieldResolver fieldResolver,
    CmdbToZabbixConverter converter,
    IZabbixRequestPublisher publisher,
    IProcessingStateStore stateStore,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
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
        using var consumer = new ConsumerBuilder<string, string>(inputOptions.BuildConsumerConfig())
            .SetPartitionsAssignedHandler((_, partitions) =>
            {
                var assignments = BuildPartitionAssignments(partitions, previousState);
                foreach (var assignment in assignments.Where(item => item.Offset != Offset.Unset))
                {
                    logger.LogInformation(
                        "Resuming Kafka consumer from state at {Topic}[{Partition}]@{Offset}",
                        assignment.Topic,
                        assignment.Partition.Value,
                        assignment.Offset.Value);
                }

                return assignments;
            })
            .Build();
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

                logger.LogBasic(
                    debugLoggingOptions,
                    "Consumed CMDBuild Kafka event from {Topic}[{Partition}]@{Offset}, key {KafkaKey}",
                    consumed.Topic,
                    consumed.Partition.Value,
                    consumed.Offset.Value,
                    consumed.Message.Key ?? "<empty>");
                logger.LogVerbose(
                    debugLoggingOptions,
                    "Consumed CMDBuild Kafka payload {KafkaPayload}",
                    consumed.Message.Value);

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

    private static List<TopicPartitionOffset> BuildPartitionAssignments(
        IReadOnlyCollection<TopicPartition> partitions,
        ProcessingStateDocument? previousState)
    {
        return partitions
            .Select(partition => new TopicPartitionOffset(
                partition,
                ResolveStartOffset(partition, previousState)))
            .ToList();
    }

    private static Offset ResolveStartOffset(
        TopicPartition partition,
        ProcessingStateDocument? previousState)
    {
        if (previousState?.LastInputTopic is null
            || previousState.LastInputPartition is null
            || previousState.LastInputOffset is null
            || !string.Equals(previousState.LastInputTopic, partition.Topic, StringComparison.Ordinal)
            || previousState.LastInputPartition.Value != partition.Partition.Value)
        {
            return Offset.Unset;
        }

        return new Offset(previousState.LastInputOffset.Value + 1);
    }

    private async Task ProcessMessageAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        CancellationToken cancellationToken)
    {
        var totalStopwatch = Stopwatch.StartNew();
        var stageStopwatch = Stopwatch.StartNew();
        long rulesMs = 0;
        long readResolveMs = 0;
        long convertMs = 0;
        long publishMs = 0;
        long stateCommitMs = 0;

        var rules = await rulesProvider.GetRulesAsync(cancellationToken);
        rulesMs = stageStopwatch.ElapsedMilliseconds;
        CmdbSourceEvent source;

        try
        {
            stageStopwatch.Restart();
            source = eventReader.Read(consumed.Message.Value, rules);
            source = await fieldResolver.ResolveAsync(source, rules, cancellationToken);
            readResolveMs = stageStopwatch.ElapsedMilliseconds;
            logger.LogBasic(
                debugLoggingOptions,
                "Resolved CMDBuild event {EventType} for {ClassName}/{EntityId} with {FieldCount} source field(s)",
                source.EventType,
                source.ClassName ?? source.EntityType ?? "<unknown>",
                source.EntityId ?? "<unknown>",
                source.SourceFields.Count);
            logger.LogVerbose(
                debugLoggingOptions,
                "Resolved CMDBuild source fields for {ClassName}/{EntityId}: {SourceFields}",
                source.ClassName ?? source.EntityType ?? "<unknown>",
                source.EntityId ?? "<unknown>",
                JsonSerializer.Serialize(source.SourceFields));
        }
        catch (JsonException ex)
        {
            readResolveMs = stageStopwatch.ElapsedMilliseconds;
            logger.LogWarning(
                ex,
                "Skipping invalid JSON message from {Topic}[{Partition}]@{Offset}",
                consumed.Topic,
                consumed.Partition.Value,
                consumed.Offset.Value);

            stageStopwatch.Restart();
            await WriteStateAndCommitAsync(
                consumed,
                consumer,
                entityId: consumed.Message.Key,
                eventType: "unknown",
                outputPublished: false,
                skipReason: "invalid_json",
                cancellationToken);
            stateCommitMs = stageStopwatch.ElapsedMilliseconds;
            LogStageDurations(
                consumed,
                source: null,
                outcome: "invalid_json",
                totalStopwatch.ElapsedMilliseconds,
                rulesMs,
                readResolveMs,
                convertMs,
                publishMs,
                stateCommitMs);

            return;
        }

        stageStopwatch.Restart();
        var results = await converter.ConvertAsync(source, rules, cancellationToken);
        convertMs = stageStopwatch.ElapsedMilliseconds;
        var publishableResults = results.Where(result => result.ShouldPublish).ToArray();
        logger.LogBasic(
            debugLoggingOptions,
            "Converted CMDBuild event {EventType} for {EntityId}: {PublishableCount} publishable result(s), {SkippedCount} skipped result(s)",
            source.EventType,
            source.EntityId ?? "<unknown>",
            publishableResults.Length,
            results.Count(result => !result.ShouldPublish));
        foreach (var skippedResult in results.Where(result => !result.ShouldPublish))
        {
            logger.LogInformation(
                "Skipped CMDBuild event {EventType} for entity {EntityId}, profile {ProfileName}: {SkipReason}",
                skippedResult.EventType,
                skippedResult.EntityId ?? "<unknown>",
                skippedResult.ProfileName ?? "<default>",
                skippedResult.SkipReason);
        }

        if (publishableResults.Length == 0)
        {
            stageStopwatch.Restart();
            await WriteStateAndCommitAsync(
                consumed,
                consumer,
                source.EntityId,
                source.EventType,
                outputPublished: false,
                skipReason: string.Join(';', results.Select(result => result.SkipReason).Where(reason => !string.IsNullOrWhiteSpace(reason))),
                cancellationToken);
            stateCommitMs = stageStopwatch.ElapsedMilliseconds;
            LogStageDurations(
                consumed,
                source,
                outcome: "skipped",
                totalStopwatch.ElapsedMilliseconds,
                rulesMs,
                readResolveMs,
                convertMs,
                publishMs,
                stateCommitMs);

            return;
        }

        DeliveryResult<string, string>? lastDeliveryResult = null;
        stageStopwatch.Restart();
        foreach (var result in publishableResults)
        {
            lastDeliveryResult = await publisher.PublishAsync(result, cancellationToken);
            logger.LogVerbose(
                debugLoggingOptions,
                "Published conversion result for profile {ProfileName}, method {Method}, payload {ZabbixPayload}",
                result.ProfileName ?? "<default>",
                result.Method,
                result.Value);
        }
        publishMs = stageStopwatch.ElapsedMilliseconds;

        stageStopwatch.Restart();
        await WriteStateAndCommitAsync(
            consumed,
            consumer,
            source.EntityId,
            source.EventType,
            outputPublished: true,
            skipReason: null,
            cancellationToken,
            outputTopic: lastDeliveryResult?.Topic);
        stateCommitMs = stageStopwatch.ElapsedMilliseconds;
        LogStageDurations(
            consumed,
            source,
            outcome: "published",
            totalStopwatch.ElapsedMilliseconds,
            rulesMs,
            readResolveMs,
            convertMs,
            publishMs,
            stateCommitMs);

        logger.LogInformation(
            "Processed CMDBuild event {EventType} for entity {EntityId} into {PublishedCount} Zabbix request(s)",
            source.EventType,
            source.EntityId ?? "<unknown>",
            publishableResults.Length);
    }

    private void LogStageDurations(
        ConsumeResult<string, string> consumed,
        CmdbSourceEvent? source,
        string outcome,
        long totalMs,
        long rulesMs,
        long readResolveMs,
        long convertMs,
        long publishMs,
        long stateCommitMs)
    {
        logger.LogBasic(
            debugLoggingOptions,
            "CMDBuild conversion stage durations for {Topic}[{Partition}]@{Offset}, entity {EntityId}, outcome {Outcome}: total {TotalMs} ms, rules {RulesMs} ms, readResolve {ReadResolveMs} ms, convert {ConvertMs} ms, publish {PublishMs} ms, stateCommit {StateCommitMs} ms",
            consumed.Topic,
            consumed.Partition.Value,
            consumed.Offset.Value,
            source?.EntityId ?? consumed.Message.Key ?? "<unknown>",
            outcome,
            totalMs,
            rulesMs,
            readResolveMs,
            convertMs,
            publishMs,
            stateCommitMs);
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
        logger.LogBasic(
            debugLoggingOptions,
            "Committed CMDBuild Kafka event {Topic}[{Partition}]@{Offset}, output published {OutputPublished}, skip reason {SkipReason}",
            consumed.Topic,
            consumed.Partition.Value,
            consumed.Offset.Value,
            outputPublished,
            skipReason ?? "<none>");
    }
}
