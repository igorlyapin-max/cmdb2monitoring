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
        if (IsDeleteFallbackRequest(request))
        {
            return await ProcessDeleteFallbackAsync(request, apiResult, cancellationToken);
        }

        if (IsUpdateFallbackRequest(request))
        {
            return await ProcessUpdateFallbackAsync(request, apiResult, cancellationToken);
        }

        return ZabbixProcessingResult.FromApiResult(request, apiResult);
    }

    private async Task<ZabbixProcessingResult> ProcessDeleteFallbackAsync(
        ZabbixRequestDocument lookupRequest,
        ZabbixApiCallResult lookupResult,
        CancellationToken cancellationToken)
    {
        if (!lookupResult.Success)
        {
            return ZabbixProcessingResult.FromApiResult(lookupRequest, lookupResult);
        }

        var hostId = ReadFirstHostId(lookupResult.ResponseJson);
        if (string.IsNullOrWhiteSpace(hostId))
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                "host_not_found",
                $"Zabbix host '{lookupRequest.Host ?? "<unknown>"}' was not found for delete fallback.",
                [],
                [],
                []);
        }

        var deleteRequestJson = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "host.delete",
            @params = new[] { hostId },
            id = ResolveJsonRpcId(lookupRequest)
        });
        var deleteRequest = requestReader.Read(lookupRequest.EntityId, deleteRequestJson, lookupRequest.Host);
        var deleteValidation = await requestValidator.ValidateAsync(deleteRequest, cancellationToken);
        if (!deleteValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                deleteRequest,
                deleteValidation.PrimaryErrorCode(),
                deleteValidation.PrimaryErrorMessage(),
                deleteValidation.MissingHostGroups.ToArray(),
                deleteValidation.MissingTemplates.ToArray(),
                deleteValidation.MissingTemplateGroups.ToArray());
        }

        var deleteResult = await zabbixClient.ExecuteAsync(deleteRequest, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(deleteRequest, deleteResult);
    }

    private async Task<ZabbixProcessingResult> ProcessUpdateFallbackAsync(
        ZabbixRequestDocument lookupRequest,
        ZabbixApiCallResult lookupResult,
        CancellationToken cancellationToken)
    {
        if (!lookupResult.Success)
        {
            return ZabbixProcessingResult.FromApiResult(lookupRequest, lookupResult);
        }

        var hostInfo = ReadFirstHostLookupInfo(lookupResult.ResponseJson);
        if (hostInfo is null)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                "host_not_found",
                $"Zabbix host '{lookupRequest.Host ?? "<unknown>"}' was not found for update fallback.",
                [],
                [],
                []);
        }

        if (lookupRequest.FallbackUpdateParams.ValueKind != JsonValueKind.Object)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                "missing_update_payload",
                "Fallback host.update params are missing in cmdb2monitoring metadata.",
                [],
                [],
                []);
        }

        var updateRequestJson = BuildHostUpdateRequestJson(
            lookupRequest,
            hostInfo.HostId,
            hostInfo.InterfaceId);
        var updateRequest = requestReader.Read(lookupRequest.EntityId, updateRequestJson, lookupRequest.Host);
        var updateValidation = await requestValidator.ValidateAsync(updateRequest, cancellationToken);
        if (!updateValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                updateRequest,
                updateValidation.PrimaryErrorCode(),
                updateValidation.PrimaryErrorMessage(),
                updateValidation.MissingHostGroups.ToArray(),
                updateValidation.MissingTemplates.ToArray(),
                updateValidation.MissingTemplateGroups.ToArray());
        }

        var updateResult = await zabbixClient.ExecuteAsync(updateRequest, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(updateRequest, updateResult);
    }

    private static bool IsDeleteFallbackRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.get", StringComparison.OrdinalIgnoreCase)
            && string.Equals(request.FallbackForMethod, "host.delete", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsUpdateFallbackRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.get", StringComparison.OrdinalIgnoreCase)
            && string.Equals(request.FallbackForMethod, "host.update", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ReadFirstHostId(string? responseJson)
    {
        return ReadFirstHostLookupInfo(responseJson)?.HostId;
    }

    private static ZabbixHostLookupInfo? ReadFirstHostLookupInfo(string? responseJson)
    {
        if (string.IsNullOrWhiteSpace(responseJson))
        {
            return null;
        }

        using var document = JsonDocument.Parse(responseJson);
        if (!document.RootElement.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var host in result.EnumerateArray())
        {
            if (host.ValueKind == JsonValueKind.Object
                && host.TryGetProperty("hostid", out var hostId))
            {
                var parsedHostId = ReadScalar(hostId);
                if (string.IsNullOrWhiteSpace(parsedHostId))
                {
                    continue;
                }

                return new ZabbixHostLookupInfo(parsedHostId, ReadFirstInterfaceId(host));
            }
        }

        return null;
    }

    private static string? ReadFirstInterfaceId(JsonElement host)
    {
        if (!host.TryGetProperty("interfaces", out var interfaces)
            || interfaces.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var zabbixInterface in interfaces.EnumerateArray())
        {
            if (zabbixInterface.ValueKind == JsonValueKind.Object
                && zabbixInterface.TryGetProperty("interfaceid", out var interfaceId))
            {
                return ReadScalar(interfaceId);
            }
        }

        return null;
    }

    private static string BuildHostUpdateRequestJson(
        ZabbixRequestDocument lookupRequest,
        string hostId,
        string? interfaceId)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "host.update");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("hostid", hostId);
            foreach (var property in lookupRequest.FallbackUpdateParams.EnumerateObject())
            {
                if (string.Equals(property.Name, "hostid", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (string.Equals(property.Name, "interfaces", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteInterfacesWithExistingId(writer, property.Value, interfaceId);
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteEndObject();
            writer.WritePropertyName("id");
            lookupRequest.Id.WriteTo(writer);
            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteInterfacesWithExistingId(
        Utf8JsonWriter writer,
        JsonElement interfaces,
        string? interfaceId)
    {
        writer.WritePropertyName("interfaces");
        writer.WriteStartArray();

        var index = 0;
        foreach (var zabbixInterface in interfaces.EnumerateArray())
        {
            if (zabbixInterface.ValueKind != JsonValueKind.Object)
            {
                zabbixInterface.WriteTo(writer);
                index++;
                continue;
            }

            writer.WriteStartObject();
            if (index == 0 && !string.IsNullOrWhiteSpace(interfaceId))
            {
                writer.WriteString("interfaceid", interfaceId);
            }

            foreach (var property in zabbixInterface.EnumerateObject())
            {
                if (string.Equals(property.Name, "interfaceid", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteEndObject();
            index++;
        }

        writer.WriteEndArray();
    }

    private static object ResolveJsonRpcId(ZabbixRequestDocument request)
    {
        return request.Id.ValueKind switch
        {
            JsonValueKind.Number when request.Id.TryGetInt64(out var value) => value,
            JsonValueKind.String => request.Id.GetString() ?? request.RequestId ?? "1",
            _ => request.RequestId ?? "1"
        };
    }

    private static string? ReadScalar(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => bool.TrueString,
            JsonValueKind.False => bool.FalseString,
            _ => null
        };
    }

    private sealed record ZabbixHostLookupInfo(string HostId, string? InterfaceId);

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
