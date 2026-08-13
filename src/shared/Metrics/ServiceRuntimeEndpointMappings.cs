using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace Cmdb2Monitoring.Metrics;

public static class ServiceRuntimeEndpointMappings
{
    public static void MapServiceRuntimeEndpoints(
        this WebApplication app,
        string serviceName,
        string healthRoute)
    {
        var identity = RuntimeIdentity();
        app.MapGet(healthRoute, (IServiceMetrics metrics) => Results.Ok(new
        {
            service = serviceName,
            status = "ok",
            identity.ApplicationVersion,
            identity.GitRevision,
            identity.BuildProvenance,
            identity.SourceState,
            startedAt = metrics.StartedAt
        }));

        app.MapGet("/ready", async (
            IEnumerable<IReadinessCheck> checks,
            IServiceMetrics metrics,
            CancellationToken cancellationToken) =>
        {
            var readiness = await ReadinessProbe.CheckAsync(checks, cancellationToken);
            var payload = new
            {
                service = serviceName,
                status = readiness.Ready ? "ready" : "not_ready",
                identity.ApplicationVersion,
                identity.GitRevision,
                identity.BuildProvenance,
                identity.SourceState,
                startedAt = metrics.StartedAt,
                checkedAt = readiness.CheckedAt,
                checks = readiness.Checks.Select(check => new
                {
                    name = check.Name,
                    status = check.Ready ? "ready" : "not_ready",
                    message = check.Message
                })
            };

            return readiness.Ready
                ? Results.Ok(payload)
                : Results.Json(payload, statusCode: StatusCodes.Status503ServiceUnavailable);
        });

        app.MapGet("/metrics", (IServiceMetrics metrics) => Results.Text(
            metrics.ToPrometheusText(serviceName),
            "text/plain; version=0.0.4; charset=utf-8"));
    }

    private static RuntimeBuildIdentity RuntimeIdentity()
    {
        return new RuntimeBuildIdentity(
            SafeEnvironmentValue("APPLICATION_VERSION", "0.0.0.0"),
            SafeEnvironmentValue("GIT_REVISION", "unknown"),
            SafeEnvironmentValue("BUILD_PROVENANCE", "unverified-local"),
            SafeEnvironmentValue("SOURCE_STATE", "dirty-or-unverified"));
    }

    private static string SafeEnvironmentValue(string variable, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(variable)?.Trim();
        return string.IsNullOrWhiteSpace(value) || value.Length > 128
            ? fallback
            : value;
    }

    private sealed record RuntimeBuildIdentity(
        string ApplicationVersion,
        string GitRevision,
        string BuildProvenance,
        string SourceState);
}
