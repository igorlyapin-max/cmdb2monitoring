namespace CmdbKafka2Zabbix.Processing;

public interface IProcessingStateStore
{
    Task<ProcessingStateDocument?> ReadAsync(CancellationToken cancellationToken);

    Task WriteAsync(ProcessingStateDocument state, CancellationToken cancellationToken);
}
