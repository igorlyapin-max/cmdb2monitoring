namespace ZabbixBindings2Cmdbuild.Processing;

public interface IProcessingStateStore
{
    Task<ProcessingStateDocument?> ReadAsync(CancellationToken cancellationToken);

    Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken);
}
