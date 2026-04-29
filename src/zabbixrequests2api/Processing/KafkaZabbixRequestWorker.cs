using System.Text.Json;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using ZabbixRequests2Api.Kafka;
using ZabbixRequests2Api.Zabbix;

namespace ZabbixRequests2Api.Processing;

public sealed class KafkaZabbixRequestWorker(
    IOptions<KafkaOptions> kafkaOptions,
    IOptions<ProcessingOptions> processingOptions,
    ZabbixRequestReader requestReader,
    ZabbixRequestValidator requestValidator,
    IZabbixClient zabbixClient,
    IZabbixResponsePublisher responsePublisher,
    IProcessingStateStore stateStore,
    ILogger<KafkaZabbixRequestWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var previousState = await stateStore.ReadAsync(stoppingToken);
        if (previousState is not null)
        {
            logger.LogInformation(
                "Loaded processing state: last entity {EntityId}, method {Method}, input {Topic}[{Partition}]@{Offset}, success {Success}, processed at {ProcessedAt}",
                previousState.LastEntityId ?? "<unknown>",
                previousState.LastMethod ?? "<unknown>",
                previousState.LastInputTopic ?? "<unknown>",
                previousState.LastInputPartition,
                previousState.LastInputOffset,
                previousState.Success,
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
                await DelayBeforeNextObjectAsync(stoppingToken);
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
        ZabbixRequestDocument? request = null;
        ZabbixProcessingResult result;

        try
        {
            request = requestReader.Read(consumed.Message.Key, consumed.Message.Value);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(
                ex,
                "Skipping invalid JSON message from {Topic}[{Partition}]@{Offset}",
                consumed.Topic,
                consumed.Partition.Value,
                consumed.Offset.Value);

            result = ZabbixProcessingResult.FromValidationError(
                request: null,
                errorCode: "invalid_json",
                errorMessage: ex.Message,
                missingHostGroups: [],
                missingTemplates: [],
                missingTemplateGroups: []);

            await PublishStateAndCommitAsync(consumed, consumer, result, cancellationToken);
            return;
        }

        result = await ProcessRequestWithRetryAsync(request, cancellationToken);
        await PublishStateAndCommitAsync(consumed, consumer, result, cancellationToken);

        logger.LogInformation(
            "Processed Zabbix request {Method} for entity {EntityId}, success {Success}, error {ErrorCode}",
            result.Method,
            result.EntityId ?? "<unknown>",
            result.Success,
            result.ErrorCode ?? "<none>");
    }

    private async Task<ZabbixProcessingResult> ProcessRequestWithRetryAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        var maxAttempts = Math.Max(1, processingOptions.Value.MaxRetryAttempts);
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                return await ProcessRequestAsync(request, cancellationToken);
            }
            catch (Exception ex) when (attempt < maxAttempts)
            {
                logger.LogWarning(
                    ex,
                    "Zabbix request {Method} for entity {EntityId} failed on attempt {Attempt}/{MaxAttempts}; retrying after {RetryDelayMs} ms",
                    request.Method,
                    request.EntityId ?? "<unknown>",
                    attempt,
                    maxAttempts,
                    processingOptions.Value.RetryDelayMs);

                await Task.Delay(TimeSpan.FromMilliseconds(processingOptions.Value.RetryDelayMs), cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogError(
                    ex,
                    "Zabbix request {Method} for entity {EntityId} failed after {MaxAttempts} attempts",
                    request.Method,
                    request.EntityId ?? "<unknown>",
                    maxAttempts);

                return ZabbixProcessingResult.FromException(request, ex);
            }
        }

        return ZabbixProcessingResult.FromValidationError(
            request,
            "zabbix_api_error",
            "Unexpected processing failure.",
            [],
            [],
            []);
    }

    private async Task<ZabbixProcessingResult> ProcessRequestAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        var validation = await requestValidator.ValidateAsync(request, cancellationToken);
        if (!validation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                request,
                validation.PrimaryErrorCode(),
                validation.PrimaryErrorMessage(),
                validation.MissingHostGroups.ToArray(),
                validation.MissingTemplates.ToArray(),
                validation.MissingTemplateGroups.ToArray());
        }

        var apiResult = await zabbixClient.ExecuteAsync(request, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(request, apiResult);
    }

    private async Task PublishStateAndCommitAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        ZabbixProcessingResult result,
        CancellationToken cancellationToken)
    {
        var deliveryResult = await responsePublisher.PublishAsync(result, consumed, cancellationToken);

        await stateStore.WriteAsync(new ProcessingStateDocument(
            LastEntityId: result.EntityId,
            LastMethod: result.Method,
            LastInputTopic: consumed.Topic,
            LastInputPartition: consumed.Partition.Value,
            LastInputOffset: consumed.Offset.Value,
            LastOutputTopic: deliveryResult.Topic,
            OutputPublished: true,
            ZabbixRequestSent: result.ZabbixRequestSent,
            Success: result.Success,
            ErrorCode: result.ErrorCode,
            ProcessedAt: result.ProcessedAt), cancellationToken);

        consumer.Commit(consumed);
    }

    private async Task DelayBeforeNextObjectAsync(CancellationToken cancellationToken)
    {
        if (processingOptions.Value.DelayBetweenObjectsMs <= 0)
        {
            return;
        }

        await Task.Delay(TimeSpan.FromMilliseconds(processingOptions.Value.DelayBetweenObjectsMs), cancellationToken);
    }
}
