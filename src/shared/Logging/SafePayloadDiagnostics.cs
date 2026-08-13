using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Cmdb2Monitoring.Logging;

public sealed record SafePayloadSummary(int ByteCount, string Sha256, string FieldNames);

public static class SafePayloadDiagnostics
{
    public static SafePayloadSummary DescribeJson(string? payload)
    {
        var value = payload ?? string.Empty;
        var fieldNames = Array.Empty<string>();

        try
        {
            using var document = JsonDocument.Parse(value);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                fieldNames = document.RootElement
                    .EnumerateObject()
                    .Select(property => property.Name)
                    .ToArray();
            }
        }
        catch (JsonException)
        {
            // A malformed input remains diagnostically identifiable by byte count and hash.
        }

        return new SafePayloadSummary(
            Encoding.UTF8.GetByteCount(value),
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant(),
            DescribeFieldNames(fieldNames));
    }

    public static string DescribeFieldNames(IEnumerable<string?> fieldNames)
    {
        return string.Join(",", fieldNames
            .Where(field => !string.IsNullOrWhiteSpace(field))
            .Select(field => field!.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(field => field, StringComparer.OrdinalIgnoreCase));
    }
}
