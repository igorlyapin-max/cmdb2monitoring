using System.Text.Json;
using CmdbWebhooks2Kafka.Configuration;

namespace CmdbWebhooks2Kafka.Models;

public sealed record CmdbWebhookEnvelope(
    string Source,
    string EventType,
    string? EntityType,
    string? EntityId,
    DateTimeOffset ReceivedAt,
    JsonElement Payload)
{
    public static CmdbWebhookEnvelope FromPayload(JsonElement payload, CmdbWebhookOptions options)
    {
        return new CmdbWebhookEnvelope(
            Source: options.Source,
            EventType: ReadString(payload, options.EventTypeFields, options.SearchContainers) ?? options.UnknownEventType,
            EntityType: ReadString(payload, options.EntityTypeFields, options.SearchContainers),
            EntityId: ReadString(payload, options.EntityIdFields, options.SearchContainers),
            ReceivedAt: DateTimeOffset.UtcNow,
            Payload: payload.Clone());
    }

    private static string? ReadString(JsonElement element, string[] propertyNames, string[] searchContainers)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var propertyName in propertyNames)
        {
            if (element.TryGetProperty(propertyName, out var value))
            {
                var result = ConvertToString(value);
                if (!string.IsNullOrWhiteSpace(result))
                {
                    return result;
                }
            }
        }

        foreach (var containerName in searchContainers)
        {
            if (element.TryGetProperty(containerName, out var child))
            {
                var result = ReadString(child, propertyNames, searchContainers);
                if (!string.IsNullOrWhiteSpace(result))
                {
                    return result;
                }
            }
        }

        return null;
    }

    private static string? ConvertToString(JsonElement value)
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
}
