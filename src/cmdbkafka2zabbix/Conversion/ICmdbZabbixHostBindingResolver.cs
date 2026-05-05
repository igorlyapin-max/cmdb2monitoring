namespace CmdbKafka2Zabbix.Conversion;

public interface ICmdbZabbixHostBindingResolver
{
    Task<string?> ResolveHostIdAsync(
        CmdbSourceEvent source,
        string hostProfile,
        bool isMainProfile,
        CancellationToken cancellationToken);
}

public sealed class NullCmdbZabbixHostBindingResolver : ICmdbZabbixHostBindingResolver
{
    public static NullCmdbZabbixHostBindingResolver Instance { get; } = new();

    private NullCmdbZabbixHostBindingResolver()
    {
    }

    public Task<string?> ResolveHostIdAsync(
        CmdbSourceEvent source,
        string hostProfile,
        bool isMainProfile,
        CancellationToken cancellationToken)
    {
        return Task.FromResult<string?>(null);
    }
}
