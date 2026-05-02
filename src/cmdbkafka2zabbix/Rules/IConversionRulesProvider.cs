namespace CmdbKafka2Zabbix.Rules;

public interface IConversionRulesProvider
{
    Task<ConversionRulesDocument> GetRulesAsync(CancellationToken cancellationToken);

    Task<ConversionRulesReloadResult> ReloadAsync(CancellationToken cancellationToken);
}
