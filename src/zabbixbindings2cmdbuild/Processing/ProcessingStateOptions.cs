namespace ZabbixBindings2Cmdbuild.Processing;

public sealed class ProcessingStateOptions
{
    public const string SectionName = "ProcessingState";

    public string FilePath { get; init; } = "state/zabbixbindings2cmdbuild-state.json";
}
