using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cmdb2Monitoring.Logging;
using CmdbWebhooks2Kafka.Configuration;
using CmdbWebhooks2Kafka.Kafka;
using CmdbWebhooks2Kafka.Models;
using Microsoft.Extensions.Options;

namespace CmdbWebhooks2Kafka.Endpoints;

public static class CmdbWebhookEndpoints
{
    public static IEndpointRouteBuilder MapCmdbWebhookEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var webhookOptions = endpoints.ServiceProvider.GetRequiredService<IOptions<CmdbWebhookOptions>>().Value;

        var group = endpoints.MapGroup(webhookOptions.Route)
            .WithTags(webhookOptions.EndpointTag);

        group.MapPost("", async (
            HttpRequest request,
            IKafkaEventPublisher publisher,
            IOptions<CmdbWebhookOptions> cmdbWebhookOptions,
            IOptions<KafkaOptions> kafkaOptions,
            IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
        {
            var logger = loggerFactory.CreateLogger("CmdbWebhookEndpoints");
            var options = cmdbWebhookOptions.Value;
            if (!ValidateWebhookAuthorization(request, options))
            {
                logger.LogWarning("Rejected CMDBuild webhook with missing or invalid Bearer token");

                return Results.Unauthorized();
            }

            JsonElement payload;

            try
            {
                using var document = await JsonDocument.ParseAsync(request.Body, cancellationToken: cancellationToken);
                payload = document.RootElement.Clone();
            }
            catch (JsonException ex)
            {
                logger.LogWarning(ex, "Received CMDBuild webhook with invalid JSON payload");

                return Results.BadRequest(new
                {
                    status = "invalid_json"
                });
            }

            var envelope = CmdbWebhookEnvelope.FromPayload(payload, options);
            logger.LogBasic(
                debugLoggingOptions,
                "Received webhook payload for event {EventType}, entity type {EntityType}, entity id {EntityId}",
                envelope.EventType,
                envelope.EntityType ?? "<unknown>",
                envelope.EntityId ?? "<unknown>");
            logger.LogVerbose(
                debugLoggingOptions,
                "Webhook payload JSON {WebhookPayload}",
                payload.GetRawText());

            logger.LogInformation(
                "Received CMDBuild webhook event {EventType} for {EntityType} {EntityId}",
                envelope.EventType,
                envelope.EntityType ?? "<unknown>",
                envelope.EntityId ?? "<unknown>");

            await publisher.PublishAsync(envelope, cancellationToken);
            logger.LogBasic(
                debugLoggingOptions,
                "Webhook event {EventType} for {EntityType}/{EntityId} accepted for Kafka topic {Topic}",
                envelope.EventType,
                envelope.EntityType ?? "<unknown>",
                envelope.EntityId ?? "<unknown>",
                kafkaOptions.Value.Topic);

            return Results.Accepted(value: new
            {
                status = "accepted",
                kafkaOptions.Value.Topic,
                envelope.EventType,
                envelope.EntityType,
                envelope.EntityId,
                envelope.ReceivedAt
            });
        });

        return endpoints;
    }

    private static bool ValidateWebhookAuthorization(HttpRequest request, CmdbWebhookOptions options)
    {
        if (!options.RequiresBearerToken())
        {
            return true;
        }

        if (!AuthenticationHeaderValue.TryParse(request.Headers.Authorization.ToString(), out var header)
            || !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(header.Parameter))
        {
            return false;
        }

        return FixedTimeEquals(header.Parameter, options.BearerToken);
    }

    private static bool FixedTimeEquals(string actual, string expected)
    {
        var actualBytes = Encoding.UTF8.GetBytes(actual);
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        return actualBytes.Length == expectedBytes.Length
            && CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
    }
}
