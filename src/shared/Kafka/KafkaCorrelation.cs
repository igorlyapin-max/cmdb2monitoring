using System.Text;
using Confluent.Kafka;

namespace Cmdb2Monitoring.Kafka;

public static class KafkaCorrelation
{
    public const string HeaderName = "correlationId";

    public static string Ensure(string? correlationId)
    {
        return string.IsNullOrWhiteSpace(correlationId)
            ? Guid.NewGuid().ToString("N")
            : correlationId.Trim();
    }

    public static string Ensure(Headers? headers)
    {
        return Ensure(Read(headers));
    }

    public static string? Read(Headers? headers)
    {
        if (headers is null || !headers.TryGetLastBytes(HeaderName, out var value))
        {
            return null;
        }

        var text = Encoding.UTF8.GetString(value);
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }

    public static void Add(Headers headers, string? correlationId)
    {
        var value = Ensure(correlationId);
        headers.Add(HeaderName, Encoding.UTF8.GetBytes(value));
    }
}
