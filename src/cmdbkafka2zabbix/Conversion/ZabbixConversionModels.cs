namespace CmdbKafka2Zabbix.Conversion;

public sealed record ZabbixConversionResult(
    bool ShouldPublish,
    string? Key,
    string? Value,
    string Method,
    string? EntityId,
    string EventType,
    string? Host,
    string? SkipReason)
{
    public static ZabbixConversionResult Skipped(CmdbSourceEvent source, string method, string reason)
    {
        return new ZabbixConversionResult(
            ShouldPublish: false,
            Key: null,
            Value: null,
            Method: method,
            EntityId: source.EntityId,
            EventType: source.EventType,
            Host: null,
            SkipReason: reason);
    }
}

public sealed class ZabbixHostCreateModel
{
    public string Host { get; init; } = string.Empty;

    public string VisibleName { get; init; } = string.Empty;

    public int Status { get; init; }

    public int InventoryMode { get; init; }

    public string IpAddress { get; init; } = string.Empty;

    public string ClassName { get; init; } = string.Empty;

    public string? EntityId { get; init; }

    public string? Code { get; init; }

    public string? ZabbixHostId { get; init; }

    public string? OperatingSystem { get; init; }

    public string? ZabbixTag { get; init; }

    public ZabbixInterfaceModel Interface { get; init; } = new();

    public List<ZabbixGroupModel> Groups { get; init; } = [];

    public List<ZabbixTemplateModel> Templates { get; init; } = [];

    public List<ZabbixTagModel> Tags { get; init; } = [];

    public int RequestId { get; init; }
}

public sealed class ZabbixInterfaceModel
{
    public int Type { get; init; }

    public int Main { get; init; }

    public int UseIp { get; init; }

    public string Dns { get; init; } = string.Empty;

    public string Port { get; init; } = string.Empty;
}

public sealed record ZabbixGroupModel(string Name, string GroupId);

public sealed record ZabbixTemplateModel(string Name, string TemplateId);

public sealed record ZabbixTagModel(string Tag, string Value);
