using System.Collections.Concurrent;
using System.Text;

namespace Cmdb2Monitoring.Metrics;

public interface IServiceMetrics
{
    DateTimeOffset StartedAt { get; }

    void Increment(string name, long value = 1);

    IReadOnlyDictionary<string, long> Snapshot();

    string ToPrometheusText(string serviceName);
}

public sealed class ServiceMetrics : IServiceMetrics
{
    private readonly ConcurrentDictionary<string, long> counters = new(StringComparer.OrdinalIgnoreCase);

    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    public void Increment(string name, long value = 1)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        counters.AddOrUpdate(NormalizeName(name), value, (_, current) => current + value);
    }

    public IReadOnlyDictionary<string, long> Snapshot()
    {
        return counters
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    }

    public string ToPrometheusText(string serviceName)
    {
        var normalizedService = NormalizeLabelValue(serviceName);
        var builder = new StringBuilder();
        builder.AppendLine("# TYPE cmdb2monitoring_service_started_at_seconds gauge");
        builder.Append("cmdb2monitoring_service_started_at_seconds{service=\"")
            .Append(normalizedService)
            .Append("\"} ")
            .AppendLine(StartedAt.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture));

        builder.AppendLine("# TYPE cmdb2monitoring_events_total counter");
        foreach (var (name, value) in Snapshot())
        {
            builder.Append("cmdb2monitoring_events_total{service=\"")
                .Append(normalizedService)
                .Append("\",name=\"")
                .Append(NormalizeLabelValue(name))
                .Append("\"} ")
                .AppendLine(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    private static string NormalizeName(string name)
    {
        return name.Trim().Replace('-', '_').Replace('.', '_').Replace(' ', '_');
    }

    private static string NormalizeLabelValue(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
