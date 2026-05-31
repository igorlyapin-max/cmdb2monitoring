using System.Collections.Concurrent;
using CmdbWebhooks2Kafka.Configuration;

namespace CmdbWebhooks2Kafka.Endpoints;

public sealed class WebhookRateLimiter
{
    private readonly ConcurrentDictionary<string, WindowCounter> counters = new();

    public bool TryAcquire(string key, WebhookRateLimitOptions options)
    {
        if (!options.Enabled)
        {
            return true;
        }

        var now = DateTimeOffset.UtcNow;
        var window = TimeSpan.FromSeconds(options.WindowSeconds);
        var counter = counters.AddOrUpdate(
            key,
            _ => new WindowCounter(now, 1),
            (_, current) => now - current.StartedAt >= window
                ? new WindowCounter(now, 1)
                : current with { Count = current.Count + 1 });

        return counter.Count <= options.PermitLimit;
    }

    private sealed record WindowCounter(DateTimeOffset StartedAt, int Count);
}
