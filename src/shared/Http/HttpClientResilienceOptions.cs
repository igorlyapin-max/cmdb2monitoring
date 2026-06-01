namespace Cmdb2Monitoring.Http;

public sealed class HttpClientResilienceOptions
{
    public bool Enabled { get; init; } = true;

    public int MaxRetryAttempts { get; init; } = 3;

    public int BaseDelayMs { get; init; } = 500;

    public int MaxDelayMs { get; init; } = 5000;

    public double JitterRatio { get; init; } = 0.2;

    public int CircuitBreakerFailureThreshold { get; init; } = 5;

    public int CircuitBreakerBreakSeconds { get; init; } = 30;

    public bool HasValidValues()
    {
        return MaxRetryAttempts > 0
            && BaseDelayMs >= 0
            && MaxDelayMs >= BaseDelayMs
            && JitterRatio is >= 0 and <= 1
            && CircuitBreakerFailureThreshold > 0
            && CircuitBreakerBreakSeconds > 0;
    }
}
