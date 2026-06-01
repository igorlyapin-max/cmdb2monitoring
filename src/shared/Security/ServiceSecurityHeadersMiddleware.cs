using Microsoft.AspNetCore.Builder;

namespace Cmdb2Monitoring.Security;

public static class ServiceSecurityHeadersMiddleware
{
    public static void UseServiceSecurityHeaders(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            context.Response.OnStarting(() =>
            {
                var headers = context.Response.Headers;
                headers["X-Content-Type-Options"] = "nosniff";
                headers["X-Frame-Options"] = "DENY";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
                return Task.CompletedTask;
            });

            await next();
        });
    }
}
