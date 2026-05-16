using System.Diagnostics;
using System.Text.Json;
using Cmdb2Monitoring.Logging;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Cmdbuild;
using ZabbixBindings2Cmdbuild.Kafka;
using ZabbixBindings2Cmdbuild.Models;

namespace ZabbixBindings2Cmdbuild.Processing;

public sealed class KafkaBindingWorker(
    IOptions<KafkaOptions> kafkaOptions,
    ZabbixBindingEventReader eventReader,
    ICmdbuildBindingClient cmdbuildClient,
    IProcessingStateStore stateStore,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
    ILogger<KafkaBindingWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var previousState = await stateStore.ReadAsync(stoppingToken);
        if (previousState is not null)
        {
            logger.LogInformation(
                "Loaded processing state: last source {SourceClass}/{SourceCardId}, profile {HostProfile}, input {Topic}[{Partition}]@{Offset}, success {Success}, processed at {ProcessedAt}",
                previousState.LastSourceClass ?? "<unknown>",
                previousState.LastSourceCardId ?? "<unknown>",
                previousState.LastHostProfile ?? "<unknown>",
                previousState.LastInputTopic ?? "<unknown>",
                previousState.LastInputPartition,
                previousState.LastInputOffset,
                previousState.Success,
                previousState.ProcessedAt);
        }

        var inputOptions = kafkaOptions.Value.Input;
        using var consumer = new ConsumerBuilder<string, string>(inputOptions.BuildConsumerConfig())
            .SetPartitionsAssignedHandler((_, partitions) => BuildPartitionAssignments(partitions, previousState))
            .Build();
        consumer.Subscribe(inputOptions.Topic);

        logger.LogInformation(
            "Started Kafka consumer for Zabbix binding topic {InputTopic} and group {GroupId}",
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
                    "Consumed Zabbix binding event from {Topic}[{Partition}]@{Offset}, key {KafkaKey}",
                    consumed.Topic,
                    consumed.Partition.Value,
                    consumed.Offset.Value,
                    consumed.Message.Key ?? "<empty>");
                logger.LogVerbose(
                    debugLoggingOptions,
                    "Consumed Zabbix binding payload {KafkaPayload}",
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
                    "Failed to process binding message from {Topic}[{Partition}]@{Offset}; message will be retried after restart or next poll",
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
        long parseMs = 0;
        long applyMs = 0;
        long stateCommitMs = 0;

        ZabbixBindingEvent? bindingEvent = null;
        try
        {
            bindingEvent = eventReader.Read(consumed.Message.Value);
            parseMs = stageStopwatch.ElapsedMilliseconds;
            logger.LogBasic(
                debugLoggingOptions,
                "Applying Zabbix binding event {EventType} for {SourceClass}/{SourceCardId}, profile {HostProfile}, hostid {ZabbixHostId}",
                bindingEvent.EventType,
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                bindingEvent.HostProfile,
                bindingEvent.ZabbixHostId);
            stageStopwatch.Restart();
            await cmdbuildClient.ApplyAsync(bindingEvent, cancellationToken);
            applyMs = stageStopwatch.ElapsedMilliseconds;
            stageStopwatch.Restart();
            await WriteStateAndCommitAsync(consumed, consumer, bindingEvent, true, null, cancellationToken);
            stateCommitMs = stageStopwatch.ElapsedMilliseconds;
            LogStageDurations(
                consumed,
                bindingEvent,
                outcome: "applied",
                totalStopwatch.ElapsedMilliseconds,
                parseMs,
                applyMs,
                stateCommitMs);

            logger.LogInformation(
                "Applied Zabbix binding event {EventType} for {SourceClass}/{SourceCardId}, profile {HostProfile}",
                bindingEvent.EventType,
                bindingEvent.SourceClass,
                bindingEvent.SourceCardId,
                bindingEvent.HostProfile);
        }
        catch (JsonException ex)
        {
            parseMs = stageStopwatch.ElapsedMilliseconds;
            logger.LogWarning(
                ex,
                "Skipping invalid binding JSON from {Topic}[{Partition}]@{Offset}",
                consumed.Topic,
                consumed.Partition.Value,
                consumed.Offset.Value);
            stageStopwatch.Restart();
            await WriteStateAndCommitAsync(consumed, consumer, bindingEvent, false, "invalid_json", cancellationToken);
            stateCommitMs = stageStopwatch.ElapsedMilliseconds;
            LogStageDurations(
                consumed,
                bindingEvent,
                outcome: "invalid_json",
                totalStopwatch.ElapsedMilliseconds,
                parseMs,
                applyMs,
                stateCommitMs);
        }
    }

    private void LogStageDurations(
        ConsumeResult<string, string> consumed,
        ZabbixBindingEvent? bindingEvent,
        string outcome,
        long totalMs,
        long parseMs,
        long applyMs,
        long stateCommitMs)
    {
        logger.LogBasic(
            debugLoggingOptions,
            "Zabbix binding stage durations for {Topic}[{Partition}]@{Offset}, source {SourceClass}/{SourceCardId}, profile {HostProfile}, outcome {Outcome}: total {TotalMs} ms, parse {ParseMs} ms, apply {ApplyMs} ms, stateCommit {StateCommitMs} ms",
            consumed.Topic,
            consumed.Partition.Value,
            consumed.Offset.Value,
            bindingEvent?.SourceClass ?? "<unknown>",
            bindingEvent?.SourceCardId ?? consumed.Message.Key ?? "<unknown>",
            bindingEvent?.HostProfile ?? "<unknown>",
            outcome,
            totalMs,
            parseMs,
            applyMs,
            stateCommitMs);
    }

    private async Task WriteStateAndCommitAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        ZabbixBindingEvent? bindingEvent,
        bool success,
        string? errorCode,
        CancellationToken cancellationToken)
    {
        await stateStore.WriteAsync(new ProcessingStateDocument(
            LastSourceClass: bindingEvent?.SourceClass,
            LastSourceCardId: bindingEvent?.SourceCardId,
            LastHostProfile: bindingEvent?.HostProfile,
            LastInputTopic: consumed.Topic,
            LastInputPartition: consumed.Partition.Value,
            LastInputOffset: consumed.Offset.Value,
            Success: success,
            ErrorCode: errorCode,
            ProcessedAt: DateTimeOffset.UtcNow), cancellationToken);

        consumer.Commit(consumed);
        logger.LogBasic(
            debugLoggingOptions,
            "Committed Zabbix binding event {Topic}[{Partition}]@{Offset}, success {Success}, error {ErrorCode}",
            consumed.Topic,
            consumed.Partition.Value,
            consumed.Offset.Value,
            success,
            errorCode ?? "<none>");
    }
}
