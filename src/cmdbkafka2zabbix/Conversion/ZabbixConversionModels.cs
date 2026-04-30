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

    public string EventType { get; init; } = string.Empty;

    public string CurrentMethod { get; init; } = string.Empty;

    public string? FallbackForMethod { get; init; }

    public IReadOnlyDictionary<string, string> SourceFields { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public string? ProxyId { get; init; }

    public string? ProxyGroupId { get; init; }

    public ZabbixTlsPskModel TlsPsk { get; init; } = new();

    public ZabbixInterfaceModel Interface { get; init; } = new();

    public List<ZabbixGroupModel> Groups { get; init; } = [];

    public List<ZabbixTemplateModel> Templates { get; init; } = [];

    public List<ZabbixTagModel> Tags { get; init; } = [];

    public List<ZabbixMacroModel> Macros { get; init; } = [];

    public List<ZabbixInventoryFieldModel> InventoryFields { get; init; } = [];

    public List<ZabbixMaintenanceModel> Maintenances { get; init; } = [];

    public List<ZabbixValueMapModel> ValueMaps { get; init; } = [];

    public int RequestId { get; init; }

    public string Field(string name)
    {
        return SourceFields.TryGetValue(name, out var value) ? value : string.Empty;
    }
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

public sealed record ZabbixMacroModel(string Macro, string Value, string Description, int Type);

public sealed record ZabbixInventoryFieldModel(string Field, string Value);

public sealed record ZabbixMaintenanceModel(string Name, string MaintenanceId);

public sealed record ZabbixValueMapModel(string Name, string ValueMapId);

public sealed class ZabbixTlsPskModel
{
    public int? TlsConnect { get; init; }

    public int? TlsAccept { get; init; }

    public string TlsPskIdentity { get; init; } = string.Empty;

    public string TlsPsk { get; init; } = string.Empty;

    public bool Enabled => TlsConnect.HasValue || TlsAccept.HasValue;

    public bool HasIdentity => !string.IsNullOrWhiteSpace(TlsPskIdentity);

    public bool HasPsk => !string.IsNullOrWhiteSpace(TlsPsk);
}
