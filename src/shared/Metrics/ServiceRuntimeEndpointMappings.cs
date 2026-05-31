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

        app.MapGet("/ready", () => Results.Ok(new
        {
            service = serviceName,
            status = "ready"
        }));

        app.MapGet("/metrics", (IServiceMetrics metrics) => Results.Text(
            metrics.ToPrometheusText(serviceName),
            "text/plain; version=0.0.4; charset=utf-8"));
    }
}
