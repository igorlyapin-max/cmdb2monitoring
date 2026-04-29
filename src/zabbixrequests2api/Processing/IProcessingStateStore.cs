namespace ZabbixRequests2Api.Processing;

public interface IProcessingStateStore
{
    Task<ProcessingStateDocument?> ReadAsync(CancellationToken cancellationToken);

    Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken);
}
