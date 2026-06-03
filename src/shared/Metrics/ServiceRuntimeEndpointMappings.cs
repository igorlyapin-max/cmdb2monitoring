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
        app.MapGet(healthRoute, (IServiceMetrics metrics) => Results.Ok(new
        {
            service = serviceName,
            status = "ok",
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
}
