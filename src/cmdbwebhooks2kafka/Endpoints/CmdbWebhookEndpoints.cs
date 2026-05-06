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

            var envelope = CmdbWebhookEnvelope.FromPayload(payload, cmdbWebhookOptions.Value);
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
}
