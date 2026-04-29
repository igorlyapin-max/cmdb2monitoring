namespace CmdbKafka2Zabbix.Configuration;

public sealed class ServiceOptions
{
    public const string SectionName = "Service";

    public string Name { get; init; } = string.Empty;

    public string HealthRoute { get; init; } = string.Empty;
}
