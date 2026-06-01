using System.Net;

namespace Cmdb2Monitoring.Http;

public sealed class HttpClientResilienceHandler(
    HttpClientResilienceOptions options,
    ILogger<HttpClientResilienceHandler> logger) : DelegatingHandler
{
    private readonly object gate = new();
    private int consecutiveFailures;
    private DateTimeOffset? circuitOpenUntil;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (!options.Enabled)
        {
            return await base.SendAsync(request, cancellationToken);
        }

        var bufferedContent = request.Content is null
            ? null
            : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var maxAttempts = Math.Max(1, options.MaxRetryAttempts);
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            ThrowIfCircuitOpen(request);

            HttpResponseMessage? response = null;
            using var attemptRequest = CloneRequest(request, bufferedContent);
            try
            {
                response = await base.SendAsync(attemptRequest, cancellationToken);
                if (!IsTransientStatus(response.StatusCode))
                {
                    ResetCircuit();
                    return response;
                }

                if (attempt >= maxAttempts)
                {
                    RegisterFailure(request, $"HTTP {(int)response.StatusCode} {response.StatusCode}");
                    return response;
                }

                var delay = CalculateDelay(attempt);
                logger.LogWarning(
                    "Transient HTTP status {StatusCode} from {Method} {Uri} on attempt {Attempt}/{MaxAttempts}; retrying after {DelayMs} ms",
                    (int)response.StatusCode,
                    request.Method,
                    request.RequestUri,
                    attempt,
                    maxAttempts,
                    delay.TotalMilliseconds);
                response.Dispose();
                await Task.Delay(delay, cancellationToken);
            }
            catch (Exception ex) when (IsTransientException(ex, cancellationToken) && attempt < maxAttempts)
            {
                var delay = CalculateDelay(attempt);
                logger.LogWarning(
                    ex,
                    "Transient HTTP exception from {Method} {Uri} on attempt {Attempt}/{MaxAttempts}; retrying after {DelayMs} ms",
                    request.Method,
                    request.RequestUri,
                    attempt,
                    maxAttempts,
                    delay.TotalMilliseconds);
                response?.Dispose();
                await Task.Delay(delay, cancellationToken);
            }
            catch (Exception ex) when (IsTransientException(ex, cancellationToken))
            {
                RegisterFailure(request, ex.GetType().Name);
                throw;
            }
        }

        throw new InvalidOperationException("HTTP resilience handler reached an unreachable branch.");
    }

    private static HttpRequestMessage CloneRequest(HttpRequestMessage request, byte[]? bufferedContent)
    {
        var clone = new HttpRequestMessage(request.Method, request.RequestUri)
        {
            Version = request.Version,
            VersionPolicy = request.VersionPolicy
        };

        foreach (var header in request.Headers)
        {
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        if (bufferedContent is not null)
        {
            clone.Content = new ByteArrayContent(bufferedContent);
            if (request.Content is not null)
            {
                foreach (var header in request.Content.Headers)
                {
                    clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
            }
        }

        return clone;
    }

    private void ThrowIfCircuitOpen(HttpRequestMessage request)
    {
        DateTimeOffset? openUntil;
        lock (gate)
        {
            openUntil = circuitOpenUntil;
            if (openUntil is not null && openUntil <= DateTimeOffset.UtcNow)
            {
                circuitOpenUntil = null;
                consecutiveFailures = 0;
                return;
            }
        }

        if (openUntil is not null)
        {
            throw new HttpRequestException(
                $"Circuit breaker is open for {request.Method} {request.RequestUri} until {openUntil:O}.");
        }
    }

    private void ResetCircuit()
    {
        lock (gate)
        {
            consecutiveFailures = 0;
            circuitOpenUntil = null;
        }
    }

    private void RegisterFailure(HttpRequestMessage request, string reason)
    {
        DateTimeOffset? openedUntil = null;
        lock (gate)
        {
            consecutiveFailures++;
            if (consecutiveFailures >= options.CircuitBreakerFailureThreshold)
            {
                openedUntil = DateTimeOffset.UtcNow.AddSeconds(options.CircuitBreakerBreakSeconds);
                circuitOpenUntil = openedUntil;
                consecutiveFailures = 0;
            }
        }

        if (openedUntil is not null)
        {
            logger.LogWarning(
                "Opened HTTP circuit breaker for {Method} {Uri} until {CircuitOpenUntil} after {Reason}",
                request.Method,
                request.RequestUri,
                openedUntil,
                reason);
        }
    }

    private TimeSpan CalculateDelay(int attempt)
    {
        var baseDelay = Math.Max(0, options.BaseDelayMs);
        var maxDelay = Math.Max(baseDelay, options.MaxDelayMs);
        var exponential = baseDelay * Math.Pow(2, Math.Max(0, attempt - 1));
        var capped = Math.Min(maxDelay, exponential);
        var jitterRatio = Math.Clamp(options.JitterRatio, 0, 1);
        if (jitterRatio > 0)
        {
            var jitterFactor = 1 + ((Random.Shared.NextDouble() * 2) - 1) * jitterRatio;
            capped *= jitterFactor;
        }

        return TimeSpan.FromMilliseconds(Math.Max(0, capped));
    }

    private static bool IsTransientStatus(HttpStatusCode statusCode)
    {
        return statusCode is HttpStatusCode.RequestTimeout
            or HttpStatusCode.TooManyRequests
            or HttpStatusCode.InternalServerError
            or HttpStatusCode.BadGateway
            or HttpStatusCode.ServiceUnavailable
            or HttpStatusCode.GatewayTimeout;
    }

    private static bool IsTransientException(Exception exception, CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            return false;
        }

        return exception is HttpRequestException or TaskCanceledException;
    }
}
