using System.Text.Json;
using Cmdb2Monitoring.Logging;
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
    ZabbixDynamicHostGroupResolver dynamicHostGroupResolver,
    IZabbixClient zabbixClient,
    IZabbixResponsePublisher responsePublisher,
    IZabbixBindingEventPublisher bindingEventPublisher,
    IProcessingStateStore stateStore,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
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

                logger.LogBasic(
                    debugLoggingOptions,
                    "Consumed Zabbix request from {Topic}[{Partition}]@{Offset}, key {KafkaKey}",
                    consumed.Topic,
                    consumed.Partition.Value,
                    consumed.Offset.Value,
                    consumed.Message.Key ?? "<empty>");
                logger.LogVerbose(
                    debugLoggingOptions,
                    "Consumed Zabbix request payload {KafkaPayload}",
                    consumed.Message.Value);

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
            logger.LogBasic(
                debugLoggingOptions,
                "Parsed Zabbix request {Method} for entity {EntityId}, profile {HostProfileName}, host {Host}",
                request.Method,
                request.EntityId ?? "<unknown>",
                request.HostProfileName ?? "<default>",
                request.Host ?? "<unknown>");
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
        logger.LogBasic(
            debugLoggingOptions,
            "Zabbix processing result for {Method}, entity {EntityId}: success {Success}, sent {ZabbixRequestSent}, error {ErrorCode}",
            result.Method,
            result.EntityId ?? "<unknown>",
            result.Success,
            result.ZabbixRequestSent,
            result.ErrorCode ?? "<none>");
        logger.LogVerbose(
            debugLoggingOptions,
            "Zabbix response JSON for {Method}, entity {EntityId}: {ZabbixResponseJson}",
            result.Method,
            result.EntityId ?? "<unknown>",
            result.ZabbixResponseJson ?? "<empty>");
        await PublishStateAndCommitAsync(consumed, consumer, result, cancellationToken);

        logger.LogInformation(
            "Processed Zabbix request {Method} for entity {EntityId}, profile {HostProfileName}, success {Success}, error {ErrorCode}",
            result.Method,
            result.EntityId ?? "<unknown>",
            result.HostProfileName ?? "<default>",
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
        request = await dynamicHostGroupResolver.ResolveAsync(request, cancellationToken);
        var validation = await requestValidator.ValidateAsync(request, cancellationToken);
        if (!validation.IsValid)
        {
            logger.LogBasic(
                debugLoggingOptions,
                "Rejected Zabbix request {Method} for entity {EntityId}: {ValidationErrorCode} {ValidationErrorMessage}",
                request.Method,
                request.EntityId ?? "<unknown>",
                validation.PrimaryErrorCode(),
                validation.PrimaryErrorMessage());
            return ZabbixProcessingResult.FromValidationError(
                request,
                validation.PrimaryErrorCode(),
                validation.PrimaryErrorMessage(),
                validation.MissingHostGroups.ToArray(),
                validation.MissingTemplates.ToArray(),
                validation.MissingTemplateGroups.ToArray());
        }

        var protectedPayloadResult = ValidateProtectedHostPayload(request);
        if (protectedPayloadResult is not null)
        {
            return protectedPayloadResult;
        }

        if (IsDirectUpdateRequest(request) && HasMergeableHostUpdateFields(request.Params))
        {
            logger.LogBasic(
                debugLoggingOptions,
                "Processing direct mergeable host.update for entity {EntityId}, host {Host}",
                request.EntityId ?? "<unknown>",
                request.Host ?? "<unknown>");
            return await ProcessDirectUpdateAsync(request, cancellationToken);
        }

        var protectedMutationResult = await ValidateProtectedHostMutationAsync(request, cancellationToken);
        if (protectedMutationResult is not null)
        {
            return protectedMutationResult;
        }

        logger.LogBasic(
            debugLoggingOptions,
            "Sending Zabbix API request {Method} for entity {EntityId}, host {Host}",
            request.Method,
            request.EntityId ?? "<unknown>",
            request.Host ?? "<unknown>");
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

        var hostInfo = ReadFirstHostLookupInfo(lookupResult.ResponseJson);
        if (hostInfo is null)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                "host_not_found",
                $"Zabbix host '{lookupRequest.Host ?? "<unknown>"}' was not found for delete fallback.",
                [],
                [],
                []);
        }

        var deleteRequestJson = BuildHostDeleteRequestJson(lookupRequest, hostInfo.HostId);
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

        var protectedHostResult = RejectProtectedAggregateHost(deleteRequest, hostInfo);
        if (protectedHostResult is not null)
        {
            return protectedHostResult;
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
            if (lookupRequest.CreateOnUpdateWhenMissing)
            {
                logger.LogBasic(
                    debugLoggingOptions,
                    "Zabbix update fallback did not find host {Host}; create-on-update is enabled",
                    lookupRequest.Host ?? "<unknown>");
                return await ProcessCreateOnMissingUpdateAsync(lookupRequest, cancellationToken);
            }

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

        var existingProtectedHostResult = RejectProtectedAggregateHost(lookupRequest, hostInfo);
        if (existingProtectedHostResult is not null)
        {
            return existingProtectedHostResult;
        }

        var updateRequestJson = BuildHostUpdateRequestJson(
            lookupRequest,
            hostInfo);
        logger.LogVerbose(
            debugLoggingOptions,
            "Built fallback host.update payload for hostid {HostId}: {ZabbixPayload}",
            hostInfo.HostId,
            updateRequestJson);
        var updateRequest = requestReader.Read(lookupRequest.EntityId, updateRequestJson, lookupRequest.Host);
        updateRequest = await dynamicHostGroupResolver.ResolveAsync(updateRequest, cancellationToken);
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

        var protectedPayloadResult = ValidateProtectedHostPayload(updateRequest);
        if (protectedPayloadResult is not null)
        {
            return protectedPayloadResult;
        }

        var updateResult = await zabbixClient.ExecuteAsync(updateRequest, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(updateRequest, updateResult);
    }

    private async Task<ZabbixProcessingResult> ProcessDirectUpdateAsync(
        ZabbixRequestDocument updateRequest,
        CancellationToken cancellationToken)
    {
        var hostId = ReadString(updateRequest.Params, "hostid");
        if (string.IsNullOrWhiteSpace(hostId))
        {
            return ZabbixProcessingResult.FromValidationError(
                updateRequest,
                "missing_hostid",
                "host.update params.hostid is required for mergeable host update fields.",
                [],
                [],
                []);
        }

        var lookupRequestJson = BuildHostGetByIdRequestJson(updateRequest, hostId);
        var lookupRequest = requestReader.Read(updateRequest.EntityId, lookupRequestJson, updateRequest.Host);
        var lookupValidation = await requestValidator.ValidateAsync(lookupRequest, cancellationToken);
        if (!lookupValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                lookupValidation.PrimaryErrorCode(),
                lookupValidation.PrimaryErrorMessage(),
                lookupValidation.MissingHostGroups.ToArray(),
                lookupValidation.MissingTemplates.ToArray(),
                lookupValidation.MissingTemplateGroups.ToArray());
        }

        var lookupResult = await zabbixClient.ExecuteAsync(lookupRequest, cancellationToken);
        if (!lookupResult.Success)
        {
            return ZabbixProcessingResult.FromApiResult(lookupRequest, lookupResult);
        }

        var hostInfo = ReadFirstHostLookupInfo(lookupResult.ResponseJson);
        if (hostInfo is null)
        {
            return ZabbixProcessingResult.FromValidationError(
                updateRequest,
                "host_not_found",
                $"Zabbix hostid '{hostId}' was not found for update merge.",
                [],
                [],
                []);
        }

        var existingProtectedHostResult = RejectProtectedAggregateHost(updateRequest, hostInfo);
        if (existingProtectedHostResult is not null)
        {
            return existingProtectedHostResult;
        }

        var mergedUpdateRequestJson = BuildHostUpdateRequestJson(
            updateRequest,
            updateRequest.Params,
            hostInfo);
        logger.LogVerbose(
            debugLoggingOptions,
            "Built merged host.update payload for hostid {HostId}: {ZabbixPayload}",
            hostInfo.HostId,
            mergedUpdateRequestJson);
        var mergedUpdateRequest = requestReader.Read(updateRequest.EntityId, mergedUpdateRequestJson, updateRequest.Host);
        mergedUpdateRequest = await dynamicHostGroupResolver.ResolveAsync(mergedUpdateRequest, cancellationToken);
        var mergedValidation = await requestValidator.ValidateAsync(mergedUpdateRequest, cancellationToken);
        if (!mergedValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                mergedUpdateRequest,
                mergedValidation.PrimaryErrorCode(),
                mergedValidation.PrimaryErrorMessage(),
                mergedValidation.MissingHostGroups.ToArray(),
                mergedValidation.MissingTemplates.ToArray(),
                mergedValidation.MissingTemplateGroups.ToArray());
        }

        var protectedPayloadResult = ValidateProtectedHostPayload(mergedUpdateRequest);
        if (protectedPayloadResult is not null)
        {
            return protectedPayloadResult;
        }

        var mergedUpdateResult = await zabbixClient.ExecuteAsync(mergedUpdateRequest, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(mergedUpdateRequest, mergedUpdateResult);
    }

    private async Task<ZabbixProcessingResult> ProcessCreateOnMissingUpdateAsync(
        ZabbixRequestDocument lookupRequest,
        CancellationToken cancellationToken)
    {
        if (lookupRequest.FallbackCreateParams.ValueKind != JsonValueKind.Object)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                "missing_create_payload",
                "Fallback host.create params are missing in cmdb2monitoring metadata.",
                [],
                [],
                []);
        }

        var createRequestJson = BuildHostCreateRequestJson(lookupRequest);
        logger.LogVerbose(
            debugLoggingOptions,
            "Built create-on-update host.create payload for host {Host}: {ZabbixPayload}",
            lookupRequest.Host ?? "<unknown>",
            createRequestJson);
        var createRequest = requestReader.Read(lookupRequest.EntityId, createRequestJson, lookupRequest.Host);
        createRequest = await dynamicHostGroupResolver.ResolveAsync(createRequest, cancellationToken);
        var createValidation = await requestValidator.ValidateAsync(createRequest, cancellationToken);
        if (!createValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                createRequest,
                createValidation.PrimaryErrorCode(),
                createValidation.PrimaryErrorMessage(),
                createValidation.MissingHostGroups.ToArray(),
                createValidation.MissingTemplates.ToArray(),
                createValidation.MissingTemplateGroups.ToArray());
        }

        var protectedPayloadResult = ValidateProtectedHostPayload(createRequest);
        if (protectedPayloadResult is not null)
        {
            return protectedPayloadResult;
        }

        var createResult = await zabbixClient.ExecuteAsync(createRequest, cancellationToken);
        return ZabbixProcessingResult.FromApiResult(createRequest, createResult);
    }

    private ZabbixProcessingResult? ValidateProtectedHostPayload(ZabbixRequestDocument request)
    {
        if (!processingOptions.Value.ProtectManagedAggregateHosts
            || !IsHostCreateOrUpdateRequest(request)
            || request.Params.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var violation = FindProtectedHostViolation(
            ReadString(request.Params, "hostid"),
            ReadString(request.Params, "host"),
            ReadString(request.Params, "name"),
            ReadObjectArray(request.Params, "tags"));

        return violation is null ? null : RejectProtectedHost(request, violation);
    }

    private async Task<ZabbixProcessingResult?> ValidateProtectedHostMutationAsync(
        ZabbixRequestDocument request,
        CancellationToken cancellationToken)
    {
        if (!processingOptions.Value.ProtectManagedAggregateHosts
            || !IsHostUpdateOrDeleteRequest(request))
        {
            return null;
        }

        var hostIds = ReadMutationHostIds(request)
            .Where(hostId => !string.IsNullOrWhiteSpace(hostId))
            .Select(hostId => hostId!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (hostIds.Length == 0)
        {
            return null;
        }

        var lookupRequestJson = BuildHostGetByIdsRequestJson(request, hostIds);
        var lookupRequest = requestReader.Read(request.EntityId, lookupRequestJson, request.Host);
        var lookupValidation = await requestValidator.ValidateAsync(lookupRequest, cancellationToken);
        if (!lookupValidation.IsValid)
        {
            return ZabbixProcessingResult.FromValidationError(
                lookupRequest,
                lookupValidation.PrimaryErrorCode(),
                lookupValidation.PrimaryErrorMessage(),
                lookupValidation.MissingHostGroups.ToArray(),
                lookupValidation.MissingTemplates.ToArray(),
                lookupValidation.MissingTemplateGroups.ToArray());
        }

        var lookupResult = await zabbixClient.ExecuteAsync(lookupRequest, cancellationToken);
        if (!lookupResult.Success)
        {
            return ZabbixProcessingResult.FromApiResult(lookupRequest, lookupResult);
        }

        foreach (var hostInfo in ReadHostLookupInfos(lookupResult.ResponseJson))
        {
            var protectedHostResult = RejectProtectedAggregateHost(request, hostInfo);
            if (protectedHostResult is not null)
            {
                return protectedHostResult;
            }
        }

        return null;
    }

    private ZabbixProcessingResult? RejectProtectedAggregateHost(
        ZabbixRequestDocument request,
        ZabbixHostLookupInfo hostInfo)
    {
        var violation = FindProtectedHostViolation(
            hostInfo.HostId,
            hostInfo.Host,
            hostInfo.Name,
            hostInfo.Tags);

        return violation is null ? null : RejectProtectedHost(request, violation);
    }

    private ZabbixProcessingResult RejectProtectedHost(
        ZabbixRequestDocument request,
        ProtectedHostViolation violation)
    {
        var method = string.Equals(request.Method, "host.get", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(request.FallbackForMethod)
                ? request.FallbackForMethod
                : request.Method;
        logger.LogWarning(
            "Blocked Zabbix {Method} for protected aggregate host {HostId} ({Host}/{Name}): {Reason}",
            method,
            violation.HostId ?? "<new>",
            violation.Host ?? "<unknown>",
            violation.Name ?? "<unknown>",
            violation.Reason);

        return ZabbixProcessingResult.FromValidationError(
            request,
            "protected_aggregate_host",
            $"Refusing {method} for protected aggregate Zabbix host {FormatProtectedHost(violation)}: {violation.Reason}.",
            [],
            [],
            []);
    }

    private ProtectedHostViolation? FindProtectedHostViolation(
        string? hostId,
        string? host,
        string? name,
        IReadOnlyCollection<JsonElement> tags)
    {
        var options = processingOptions.Value;
        if (!options.ProtectManagedAggregateHosts)
        {
            return null;
        }

        foreach (var protectedHostName in options.ProtectedHostNames ?? [])
        {
            if (string.IsNullOrWhiteSpace(protectedHostName))
            {
                continue;
            }

            if (SameScalar(host, protectedHostName) || SameScalar(name, protectedHostName))
            {
                return new ProtectedHostViolation(
                    $"protected host name '{protectedHostName}'",
                    hostId,
                    host,
                    name);
            }
        }

        foreach (var tag in tags)
        {
            if (tag.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var tagName = ReadString(tag, "tag");
            if (string.IsNullOrWhiteSpace(tagName))
            {
                continue;
            }

            foreach (var protectedTag in options.ProtectedHostTags ?? [])
            {
                if (string.IsNullOrWhiteSpace(protectedTag.Tag)
                    || !SameScalar(tagName, protectedTag.Tag))
                {
                    continue;
                }

                var expectedValue = protectedTag.Value;
                var actualValue = ReadString(tag, "value");
                if (!string.IsNullOrWhiteSpace(expectedValue)
                    && !SameScalar(actualValue, expectedValue))
                {
                    continue;
                }

                var marker = string.IsNullOrWhiteSpace(expectedValue)
                    ? protectedTag.Tag
                    : $"{protectedTag.Tag}={expectedValue}";
                return new ProtectedHostViolation(
                    $"protected host tag '{marker}'",
                    hostId,
                    host,
                    name);
            }
        }

        return null;
    }

    private static string FormatProtectedHost(ProtectedHostViolation violation)
    {
        if (!string.IsNullOrWhiteSpace(violation.Host))
        {
            return $"'{violation.Host}'";
        }

        if (!string.IsNullOrWhiteSpace(violation.Name))
        {
            return $"'{violation.Name}'";
        }

        return violation.HostId is null ? "<new>" : $"hostid {violation.HostId}";
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

    private static bool IsDirectUpdateRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.update", StringComparison.OrdinalIgnoreCase)
            && request.Params.ValueKind == JsonValueKind.Object;
    }

    private static bool IsHostCreateOrUpdateRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.create", StringComparison.OrdinalIgnoreCase)
            || string.Equals(request.Method, "host.update", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsHostUpdateOrDeleteRequest(ZabbixRequestDocument request)
    {
        return string.Equals(request.Method, "host.update", StringComparison.OrdinalIgnoreCase)
            || string.Equals(request.Method, "host.delete", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<string?> ReadMutationHostIds(ZabbixRequestDocument request)
    {
        if (string.Equals(request.Method, "host.update", StringComparison.OrdinalIgnoreCase)
            && request.Params.ValueKind == JsonValueKind.Object)
        {
            yield return ReadString(request.Params, "hostid");
            yield break;
        }

        if (string.Equals(request.Method, "host.delete", StringComparison.OrdinalIgnoreCase)
            && request.Params.ValueKind == JsonValueKind.Array)
        {
            foreach (var hostId in request.Params.EnumerateArray())
            {
                yield return ReadScalar(hostId);
            }
        }
    }

    private static bool HasMergeableHostUpdateFields(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        return parameters.TryGetProperty("groups", out var groups) && groups.ValueKind == JsonValueKind.Array
            || parameters.TryGetProperty("templates", out var templates) && templates.ValueKind == JsonValueKind.Array
            || parameters.TryGetProperty("templates_clear", out var templatesClear) && templatesClear.ValueKind == JsonValueKind.Array
            || parameters.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array
            || parameters.TryGetProperty("macros", out var macros) && macros.ValueKind == JsonValueKind.Array
            || parameters.TryGetProperty("inventory", out var inventory) && inventory.ValueKind == JsonValueKind.Object;
    }

    private static ZabbixHostLookupInfo? ReadFirstHostLookupInfo(string? responseJson)
    {
        return ReadHostLookupInfos(responseJson).FirstOrDefault();
    }

    private static ZabbixHostLookupInfo[] ReadHostLookupInfos(string? responseJson)
    {
        if (string.IsNullOrWhiteSpace(responseJson))
        {
            return [];
        }

        using var document = JsonDocument.Parse(responseJson);
        if (!document.RootElement.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var hostInfos = new List<ZabbixHostLookupInfo>();
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

                hostInfos.Add(new ZabbixHostLookupInfo(
                    parsedHostId,
                    ReadString(host, "host"),
                    ReadString(host, "name"),
                    ReadInterfaces(host),
                    ReadTemplateIds(host),
                    ReadObjectArray(host, "groups"),
                    ReadObjectArray(host, "tags"),
                    ReadObjectArray(host, "macros"),
                    ReadObject(host, "inventory")));
            }
        }

        return hostInfos.ToArray();
    }

    private static JsonElement[] ReadObjectArray(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return array.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Object)
            .Select(item => item.Clone())
            .ToArray();
    }

    private static JsonElement ReadObject(JsonElement value, string propertyName)
    {
        return value.TryGetProperty(propertyName, out var nested)
            && nested.ValueKind == JsonValueKind.Object
                ? nested.Clone()
                : default;
    }

    private static ZabbixInterfaceLookupInfo[] ReadInterfaces(JsonElement host)
    {
        if (!host.TryGetProperty("interfaces", out var interfaces)
            || interfaces.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<ZabbixInterfaceLookupInfo>();
        foreach (var zabbixInterface in interfaces.EnumerateArray())
        {
            if (zabbixInterface.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            result.Add(new ZabbixInterfaceLookupInfo(
                InterfaceId: ReadString(zabbixInterface, "interfaceid"),
                Type: ReadString(zabbixInterface, "type"),
                Main: ReadString(zabbixInterface, "main"),
                UseIp: ReadString(zabbixInterface, "useip"),
                Ip: ReadString(zabbixInterface, "ip"),
                Dns: ReadString(zabbixInterface, "dns"),
                Port: ReadString(zabbixInterface, "port")));
        }

        return result.ToArray();
    }

    private static string[] ReadTemplateIds(JsonElement host)
    {
        foreach (var propertyName in new[] { "parentTemplates", "templates" })
        {
            if (!host.TryGetProperty(propertyName, out var templates)
                || templates.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            return templates.EnumerateArray()
                .Select(template => ReadString(template, "templateid"))
                .Where(templateId => !string.IsNullOrWhiteSpace(templateId))
                .Select(templateId => templateId!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        return [];
    }

    private static string BuildHostUpdateRequestJson(
        ZabbixRequestDocument lookupRequest,
        ZabbixHostLookupInfo hostInfo)
    {
        return BuildHostUpdateRequestJson(
            lookupRequest,
            lookupRequest.FallbackUpdateParams,
            hostInfo);
    }

    private static string BuildHostUpdateRequestJson(
        ZabbixRequestDocument lookupRequest,
        JsonElement updateParams,
        ZabbixHostLookupInfo hostInfo)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            WriteCmdbMetadata(writer, lookupRequest);
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "host.update");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("hostid", hostInfo.HostId);
            var templateIdsToClear = ReadObjectArrayValues(updateParams, "templates_clear", "templateid")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var property in updateParams.EnumerateObject())
            {
                if (string.Equals(property.Name, "hostid", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (string.Equals(property.Name, "interfaces", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteInterfacesWithExistingIds(writer, property.Value, hostInfo.Interfaces);
                    continue;
                }

                if (string.Equals(property.Name, "groups", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteMergedObjectArrayByKey(writer, "groups", property.Value, hostInfo.Groups, "groupid", true);
                    continue;
                }

                if (string.Equals(property.Name, "templates", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteMergedTemplates(writer, property.Value, hostInfo.TemplateIds, templateIdsToClear);
                    continue;
                }

                if (string.Equals(property.Name, "tags", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteMergedTags(writer, property.Value, hostInfo.Tags);
                    continue;
                }

                if (string.Equals(property.Name, "macros", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteMergedObjectArrayByKey(writer, "macros", property.Value, hostInfo.Macros, "macro", false);
                    continue;
                }

                if (string.Equals(property.Name, "inventory", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Object)
                {
                    WriteMergedObject(writer, "inventory", hostInfo.Inventory, property.Value);
                    continue;
                }

                if (string.Equals(property.Name, "templates_clear", StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Array)
                {
                    WriteTemplatesClearWithExistingIds(writer, property.Value, hostInfo.TemplateIds);
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

    private static string BuildHostGetByIdRequestJson(
        ZabbixRequestDocument updateRequest,
        string hostId)
    {
        return BuildHostGetByIdsRequestJson(updateRequest, [hostId]);
    }

    private static string BuildHostGetByIdsRequestJson(
        ZabbixRequestDocument updateRequest,
        IReadOnlyCollection<string> hostIds)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            WriteCmdbMetadata(writer, updateRequest);
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "host.get");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WritePropertyName("output");
            WriteStringArray(writer, new[] { "hostid", "host", "name" });
            writer.WritePropertyName("hostids");
            WriteStringArray(writer, hostIds);
            writer.WritePropertyName("selectInterfaces");
            WriteStringArray(writer, new[] { "interfaceid", "type", "main", "useip", "ip", "dns", "port" });
            writer.WritePropertyName("selectGroups");
            WriteStringArray(writer, new[] { "groupid", "name" });
            writer.WritePropertyName("selectParentTemplates");
            WriteStringArray(writer, new[] { "templateid" });
            writer.WritePropertyName("selectTags");
            WriteStringArray(writer, new[] { "tag", "value" });
            writer.WritePropertyName("selectMacros");
            WriteStringArray(writer, new[] { "hostmacroid", "macro", "value", "description", "type" });
            writer.WriteString("selectInventory", "extend");
            writer.WriteEndObject();
            writer.WritePropertyName("id");
            updateRequest.Id.WriteTo(writer);
            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string BuildHostDeleteRequestJson(ZabbixRequestDocument lookupRequest, string hostId)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            WriteCmdbMetadata(writer, lookupRequest);
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "host.delete");
            writer.WritePropertyName("params");
            writer.WriteStartArray();
            writer.WriteStringValue(hostId);
            writer.WriteEndArray();
            writer.WritePropertyName("id");
            lookupRequest.Id.WriteTo(writer);
            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string BuildHostCreateRequestJson(ZabbixRequestDocument lookupRequest)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            WriteCmdbMetadata(writer, lookupRequest, "createOnUpdateWhenMissing");
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "host.create");
            writer.WritePropertyName("params");
            lookupRequest.FallbackCreateParams.WriteTo(writer);
            writer.WritePropertyName("id");
            lookupRequest.Id.WriteTo(writer);
            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCmdbMetadata(
        Utf8JsonWriter writer,
        ZabbixRequestDocument request,
        string? fallbackSource = null)
    {
        writer.WritePropertyName("cmdb2monitoring");
        writer.WriteStartObject();
        WriteOptionalString(writer, "entityId", request.EntityId);
        WriteOptionalString(writer, "sourceCardId", request.SourceCardId ?? request.EntityId);
        WriteOptionalString(writer, "sourceClass", request.SourceClass);
        WriteOptionalString(writer, "sourceCode", request.SourceCode);
        WriteOptionalString(writer, "host", request.Host);
        WriteOptionalString(writer, "hostProfile", request.HostProfileName);
        WriteOptionalString(writer, "rulesVersion", request.RulesVersion);
        WriteOptionalString(writer, "schemaVersion", request.SchemaVersion);
        writer.WriteBoolean("isMainProfile", request.IsMainProfile);
        if (!string.IsNullOrWhiteSpace(fallbackSource))
        {
            writer.WriteString("fallbackSource", fallbackSource);
        }

        writer.WriteEndObject();
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string propertyName, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(propertyName, value);
        }
    }

    private static void WriteInterfacesWithExistingIds(
        Utf8JsonWriter writer,
        JsonElement interfaces,
        IReadOnlyList<ZabbixInterfaceLookupInfo> existingInterfaces)
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
            var interfaceId = FindMatchingInterfaceId(zabbixInterface, existingInterfaces, index);
            if (!string.IsNullOrWhiteSpace(interfaceId))
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

    private static void WriteMergedObjectArrayByKey(
        Utf8JsonWriter writer,
        string propertyName,
        JsonElement desiredObjects,
        IReadOnlyCollection<JsonElement> existingObjects,
        string keyName,
        bool preserveExistingAsKeyOnly)
    {
        var desiredByKey = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        var desiredKeyOrder = new List<string>();
        var desiredWithoutKey = new List<JsonElement>();
        foreach (var desired in desiredObjects.EnumerateArray())
        {
            if (desired.ValueKind != JsonValueKind.Object)
            {
                desiredWithoutKey.Add(desired.Clone());
                continue;
            }

            var key = ReadString(desired, keyName);
            if (string.IsNullOrWhiteSpace(key))
            {
                desiredWithoutKey.Add(desired.Clone());
                continue;
            }

            if (!desiredByKey.ContainsKey(key))
            {
                desiredKeyOrder.Add(key);
            }

            desiredByKey[key] = desired.Clone();
        }

        writer.WritePropertyName(propertyName);
        writer.WriteStartArray();
        foreach (var existing in existingObjects)
        {
            var key = ReadString(existing, keyName);
            if (string.IsNullOrWhiteSpace(key) || desiredByKey.ContainsKey(key))
            {
                continue;
            }

            if (preserveExistingAsKeyOnly)
            {
                WriteKeyOnlyObject(writer, keyName, key);
            }
            else
            {
                existing.WriteTo(writer);
            }
        }

        foreach (var key in desiredKeyOrder)
        {
            desiredByKey[key].WriteTo(writer);
        }

        foreach (var desired in desiredWithoutKey)
        {
            desired.WriteTo(writer);
        }

        writer.WriteEndArray();
    }

    private static void WriteMergedTemplates(
        Utf8JsonWriter writer,
        JsonElement desiredTemplates,
        IReadOnlyCollection<string> existingTemplateIds,
        IReadOnlySet<string> templateIdsToClear)
    {
        var desiredById = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        var desiredIdOrder = new List<string>();
        var desiredWithoutId = new List<JsonElement>();
        foreach (var desired in desiredTemplates.EnumerateArray())
        {
            if (desired.ValueKind != JsonValueKind.Object)
            {
                desiredWithoutId.Add(desired.Clone());
                continue;
            }

            var templateId = ReadString(desired, "templateid");
            if (string.IsNullOrWhiteSpace(templateId))
            {
                desiredWithoutId.Add(desired.Clone());
                continue;
            }

            if (!desiredById.ContainsKey(templateId))
            {
                desiredIdOrder.Add(templateId);
            }

            desiredById[templateId] = desired.Clone();
        }

        writer.WritePropertyName("templates");
        writer.WriteStartArray();
        foreach (var templateId in existingTemplateIds)
        {
            if (string.IsNullOrWhiteSpace(templateId)
                || templateIdsToClear.Contains(templateId)
                || desiredById.ContainsKey(templateId))
            {
                continue;
            }

            WriteKeyOnlyObject(writer, "templateid", templateId);
        }

        foreach (var templateId in desiredIdOrder)
        {
            if (!templateIdsToClear.Contains(templateId))
            {
                desiredById[templateId].WriteTo(writer);
            }
        }

        foreach (var desired in desiredWithoutId)
        {
            desired.WriteTo(writer);
        }

        writer.WriteEndArray();
    }

    private static void WriteMergedTags(
        Utf8JsonWriter writer,
        JsonElement desiredTags,
        IReadOnlyCollection<JsonElement> existingTags)
    {
        var desiredByKey = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        var desiredKeyOrder = new List<string>();
        foreach (var desired in desiredTags.EnumerateArray())
        {
            var key = TagKey(desired);
            if (string.IsNullOrWhiteSpace(key))
            {
                key = $"raw:{desired.GetRawText()}";
            }

            if (!desiredByKey.ContainsKey(key))
            {
                desiredKeyOrder.Add(key);
            }

            desiredByKey[key] = desired.Clone();
        }

        writer.WritePropertyName("tags");
        writer.WriteStartArray();
        foreach (var existing in existingTags)
        {
            var key = TagKey(existing);
            if (string.IsNullOrWhiteSpace(key) || desiredByKey.ContainsKey(key))
            {
                continue;
            }

            existing.WriteTo(writer);
        }

        foreach (var key in desiredKeyOrder)
        {
            desiredByKey[key].WriteTo(writer);
        }

        writer.WriteEndArray();
    }

    private static void WriteMergedObject(
        Utf8JsonWriter writer,
        string propertyName,
        JsonElement existingObject,
        JsonElement desiredObject)
    {
        writer.WritePropertyName(propertyName);
        if (existingObject.ValueKind != JsonValueKind.Object)
        {
            desiredObject.WriteTo(writer);
            return;
        }

        writer.WriteStartObject();
        var desiredNames = desiredObject.EnumerateObject()
            .Select(property => property.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var property in existingObject.EnumerateObject())
        {
            if (!desiredNames.Contains(property.Name))
            {
                property.WriteTo(writer);
            }
        }

        foreach (var property in desiredObject.EnumerateObject())
        {
            property.WriteTo(writer);
        }

        writer.WriteEndObject();
    }

    private static void WriteTemplatesClearWithExistingIds(
        Utf8JsonWriter writer,
        JsonElement templatesClear,
        IReadOnlyCollection<string> existingTemplateIds)
    {
        var requestedTemplateIds = templatesClear.EnumerateArray()
            .Select(template => ReadString(template, "templateid"))
            .Where(templateId => !string.IsNullOrWhiteSpace(templateId))
            .Select(templateId => templateId!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (requestedTemplateIds.Count == 0 || existingTemplateIds.Count == 0)
        {
            return;
        }

        var templateIdsToClear = existingTemplateIds
            .Where(requestedTemplateIds.Contains)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (templateIdsToClear.Length == 0)
        {
            return;
        }

        writer.WritePropertyName("templates_clear");
        writer.WriteStartArray();
        foreach (var templateId in templateIdsToClear)
        {
            writer.WriteStartObject();
            writer.WriteString("templateid", templateId);
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
    }

    private static void WriteKeyOnlyObject(Utf8JsonWriter writer, string keyName, string value)
    {
        writer.WriteStartObject();
        writer.WriteString(keyName, value);
        writer.WriteEndObject();
    }

    private static void WriteStringArray(Utf8JsonWriter writer, IReadOnlyCollection<string> values)
    {
        writer.WriteStartArray();
        foreach (var value in values)
        {
            writer.WriteStringValue(value);
        }

        writer.WriteEndArray();
    }

    private static string? FindMatchingInterfaceId(
        JsonElement zabbixInterface,
        IReadOnlyList<ZabbixInterfaceLookupInfo> existingInterfaces,
        int index)
    {
        var type = ReadString(zabbixInterface, "type");
        var useIp = ReadString(zabbixInterface, "useip");
        var ip = ReadString(zabbixInterface, "ip");
        var dns = ReadString(zabbixInterface, "dns");
        var port = ReadString(zabbixInterface, "port");

        var exact = existingInterfaces.FirstOrDefault(item =>
            SameScalar(item.Type, type)
            && SameScalar(item.UseIp, useIp)
            && SameScalar(item.Ip, ip)
            && SameScalar(item.Dns, dns)
            && SameScalar(item.Port, port));
        if (!string.IsNullOrWhiteSpace(exact?.InterfaceId))
        {
            return exact.InterfaceId;
        }

        var sameAddress = existingInterfaces.FirstOrDefault(item =>
            SameScalar(item.Type, type)
            && SameScalar(item.Port, port)
            && (!string.IsNullOrWhiteSpace(ip) && SameScalar(item.Ip, ip)
                || !string.IsNullOrWhiteSpace(dns) && SameScalar(item.Dns, dns)));
        if (!string.IsNullOrWhiteSpace(sameAddress?.InterfaceId))
        {
            return sameAddress.InterfaceId;
        }

        return index == 0 ? existingInterfaces.FirstOrDefault()?.InterfaceId : null;
    }

    private static string TagKey(JsonElement tag)
    {
        var tagName = ReadString(tag, "tag");
        if (string.IsNullOrWhiteSpace(tagName))
        {
            return string.Empty;
        }

        return $"{tagName}\u001f{ReadString(tag, "value") ?? string.Empty}";
    }

    private static bool SameScalar(string? left, string? right)
    {
        return string.Equals(left ?? string.Empty, right ?? string.Empty, StringComparison.OrdinalIgnoreCase);
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

    private static string? ReadString(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(propertyName, out var value)
            ? ReadScalar(value)
            : null;
    }

    private static IEnumerable<string> ReadObjectArrayValues(
        JsonElement element,
        string arrayPropertyName,
        string valuePropertyName)
    {
        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty(arrayPropertyName, out var values)
            || values.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var value in values.EnumerateArray())
        {
            var scalar = ReadString(value, valuePropertyName);
            if (!string.IsNullOrWhiteSpace(scalar))
            {
                yield return scalar;
            }
        }
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

    private sealed record ZabbixHostLookupInfo(
        string HostId,
        string? Host,
        string? Name,
        ZabbixInterfaceLookupInfo[] Interfaces,
        string[] TemplateIds,
        JsonElement[] Groups,
        JsonElement[] Tags,
        JsonElement[] Macros,
        JsonElement Inventory);

    private sealed record ProtectedHostViolation(
        string Reason,
        string? HostId,
        string? Host,
        string? Name);

    private sealed record ZabbixInterfaceLookupInfo(
        string? InterfaceId,
        string? Type,
        string? Main,
        string? UseIp,
        string? Ip,
        string? Dns,
        string? Port);

    private async Task PublishStateAndCommitAsync(
        ConsumeResult<string, string> consumed,
        IConsumer<string, string> consumer,
        ZabbixProcessingResult result,
        CancellationToken cancellationToken)
    {
        var deliveryResult = await responsePublisher.PublishAsync(result, consumed, cancellationToken);
        try
        {
            await bindingEventPublisher.PublishAsync(result, consumed, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogError(
                ex,
                "Failed to publish Zabbix binding event for method {Method}, entity {EntityId}; Zabbix response stays committed to avoid duplicate Zabbix writes",
                result.Method,
                result.EntityId ?? "<unknown>");
        }

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
