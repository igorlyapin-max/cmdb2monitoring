namespace Cmdb2Monitoring.Workers;

public sealed class WorkerRuntimeOptions
{
    public const string SectionName = "Worker";

    public string ReplicaMode { get; init; } = "SingleActive";

    public int ExpectedReplicas { get; init; } = 1;

    public bool AllowMultipleActiveReplicas { get; init; }

    public bool HasValidReplicaMode()
    {
        return string.Equals(ReplicaMode, "SingleActive", StringComparison.OrdinalIgnoreCase)
            || string.Equals(ReplicaMode, "ExternalState", StringComparison.OrdinalIgnoreCase);
    }

    public bool AllowsConfiguredReplicaCount()
    {
        return string.Equals(ReplicaMode, "ExternalState", StringComparison.OrdinalIgnoreCase)
            || ExpectedReplicas <= 1
            || AllowMultipleActiveReplicas;
    }
}
