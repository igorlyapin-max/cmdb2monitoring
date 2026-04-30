using System.Text.Json.Serialization;

namespace CmdbKafka2Zabbix.Rules;

public sealed class ConversionRulesDocument
{
    public string SchemaVersion { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public SourceRules Source { get; init; } = new();

    public ZabbixRules Zabbix { get; init; } = new();

    public ConversionDefaults Defaults { get; init; } = new();

    public NormalizationRules Normalization { get; init; } = new();

    public EventRoutingRule[] EventRoutingRules { get; init; } = [];

    public HostProfileRule[] HostProfiles { get; init; } = [];

    public SelectionRule[] GroupSelectionRules { get; init; } = [];

    public SelectionRule[] TemplateSelectionRules { get; init; } = [];

    public SelectionRule[] InterfaceSelectionRules { get; init; } = [];

    public InterfaceAddressRule[] InterfaceAddressRules { get; init; } = [];

    public SelectionRule[] TagSelectionRules { get; init; } = [];

    public SelectionRule[] ProxySelectionRules { get; init; } = [];

    public SelectionRule[] ProxyGroupSelectionRules { get; init; } = [];

    public SelectionRule[] HostMacroSelectionRules { get; init; } = [];

    public SelectionRule[] InventorySelectionRules { get; init; } = [];

    public SelectionRule[] InterfaceProfileSelectionRules { get; init; } = [];

    public SelectionRule[] HostStatusSelectionRules { get; init; } = [];

    public SelectionRule[] MaintenanceSelectionRules { get; init; } = [];

    public SelectionRule[] TlsPskSelectionRules { get; init; } = [];

    public SelectionRule[] ValueMapSelectionRules { get; init; } = [];

    public T4TemplateSet T4Templates { get; init; } = new();
}

public sealed class EventRoutingRule
{
    public string EventType { get; init; } = string.Empty;

    public string Method { get; init; } = string.Empty;

    public string TemplateName { get; init; } = string.Empty;

    public bool RequiresZabbixHostId { get; init; }

    public string FallbackMethod { get; init; } = string.Empty;

    public string FallbackTemplateName { get; init; } = string.Empty;

    public string[] RequiredFields { get; init; } = [];

    public bool Publish { get; init; } = true;
}

public sealed class HostProfileRule
{
    public string Name { get; init; } = string.Empty;

    public int Priority { get; init; } = 1000;

    public bool Fallback { get; init; }

    public bool Enabled { get; init; } = true;

    public RuleCondition When { get; init; } = new();

    public string HostNameTemplate { get; init; } = string.Empty;

    public string VisibleNameTemplate { get; init; } = string.Empty;

    public string ZabbixHostIdField { get; init; } = string.Empty;

    public string InterfaceRef { get; init; } = string.Empty;

    public string InterfaceProfileRef { get; init; } = string.Empty;

    public string Mode { get; init; } = string.Empty;

    public string ValueField { get; init; } = string.Empty;

    public HostProfileInterfaceRule[] Interfaces { get; init; } = [];
}

public sealed class HostProfileInterfaceRule
{
    public string Name { get; init; } = string.Empty;

    public int Priority { get; init; } = 1000;

    public bool Fallback { get; init; }

    public bool Enabled { get; init; } = true;

    public RuleCondition When { get; init; } = new();

    public string InterfaceRef { get; init; } = string.Empty;

    public string InterfaceProfileRef { get; init; } = string.Empty;

    public string Mode { get; init; } = string.Empty;

    public string ValueField { get; init; } = string.Empty;
}

public sealed class SourceRules
{
    public string[] SupportedEvents { get; init; } = [];

    public string[] HostCreateEvents { get; init; } = [];

    public Dictionary<string, SourceFieldRule> Fields { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class SourceFieldRule
{
    public string Source { get; init; } = string.Empty;

    public string[] Sources { get; init; } = [];

    public bool Required { get; init; }

    public string ValidationRegex { get; init; } = string.Empty;
}

public sealed class ZabbixRules
{
    public string Method { get; init; } = "host.create";
}

public sealed class ConversionDefaults
{
    public HostDefaults Host { get; init; } = new();

    public LookupItem[] HostGroups { get; init; } = [];

    public LookupItem[] Templates { get; init; } = [];

    public InterfaceSettings AgentInterface { get; init; } = new();

    public InterfaceSettings SnmpInterface { get; init; } = new();

    public Dictionary<string, InterfaceSettings> InterfaceProfiles { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    public TagDefinition[] Tags { get; init; } = [];

    public ProxyDefinition Proxy { get; init; } = new();

    public ProxyGroupDefinition ProxyGroup { get; init; } = new();

    public HostMacroDefinition[] HostMacros { get; init; } = [];

    public InventoryFieldDefinition[] InventoryFields { get; init; } = [];

    public HostStatusDefinition HostStatus { get; init; } = new();

    public TlsPskDefinition TlsPsk { get; init; } = new();

    public MaintenanceDefinition[] Maintenances { get; init; } = [];

    public ValueMapDefinition[] ValueMaps { get; init; } = [];
}

public sealed class HostDefaults
{
    public int Status { get; init; }

    [JsonPropertyName("inventory_mode")]
    public int InventoryMode { get; init; } = -1;
}

public sealed class LookupItem
{
    public string Name { get; init; } = string.Empty;

    public string GroupId { get; init; } = string.Empty;

    public string TemplateId { get; init; } = string.Empty;
}

public sealed class InterfaceSettings
{
    public int Type { get; init; }

    public int Main { get; init; }

    public int UseIp { get; init; }

    public string Dns { get; init; } = string.Empty;

    public string Port { get; init; } = string.Empty;
}

public sealed class InterfaceAddressRule
{
    public string Name { get; init; } = string.Empty;

    public int Priority { get; init; } = 1000;

    public bool Fallback { get; init; }

    public RuleCondition When { get; init; } = new();

    public string Mode { get; init; } = string.Empty;

    public string ValueField { get; init; } = string.Empty;
}

public sealed class TagDefinition
{
    public string Tag { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;

    public string ValueTemplate { get; init; } = string.Empty;
}

public sealed class ProxyDefinition
{
    public string Name { get; init; } = string.Empty;

    public string ProxyId { get; init; } = string.Empty;
}

public sealed class ProxyGroupDefinition
{
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("proxy_groupid")]
    public string ProxyGroupId { get; init; } = string.Empty;
}

public sealed class HostMacroDefinition
{
    public string Macro { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;

    public string ValueTemplate { get; init; } = string.Empty;

    public string Description { get; init; } = string.Empty;

    public int Type { get; init; }
}

public sealed class InventoryFieldDefinition
{
    public string Field { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;

    public string ValueTemplate { get; init; } = string.Empty;
}

public sealed class HostStatusDefinition
{
    public int? Status { get; init; }

    public string Name { get; init; } = string.Empty;
}

public sealed class TlsPskDefinition
{
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("tls_connect")]
    public int? TlsConnect { get; init; }

    [JsonPropertyName("tls_accept")]
    public int? TlsAccept { get; init; }

    [JsonPropertyName("tls_psk_identity")]
    public string TlsPskIdentity { get; init; } = string.Empty;

    [JsonPropertyName("tls_psk")]
    public string TlsPsk { get; init; } = string.Empty;
}

public sealed class MaintenanceDefinition
{
    public string Name { get; init; } = string.Empty;

    public string MaintenanceId { get; init; } = string.Empty;
}

public sealed class ValueMapDefinition
{
    public string Name { get; init; } = string.Empty;

    public string ValueMapId { get; init; } = string.Empty;
}

public sealed class NormalizationRules
{
    public HostNameNormalization HostName { get; init; } = new();

    public VisibleNameNormalization VisibleName { get; init; } = new();
}

public sealed class HostNameNormalization
{
    public string[] InputPriority { get; init; } = [];

    public string PrefixTemplate { get; init; } = string.Empty;

    public RegexReplacement[] RegexReplacements { get; init; } = [];

    public bool Lowercase { get; init; }

    public string FallbackTemplate { get; init; } = string.Empty;
}

public sealed class VisibleNameNormalization
{
    public string Template { get; init; } = string.Empty;
}

public sealed class RegexReplacement
{
    public string Pattern { get; init; } = string.Empty;

    public string Replacement { get; init; } = string.Empty;
}

public sealed class SelectionRule
{
    public string Name { get; init; } = string.Empty;

    public int Priority { get; init; } = 1000;

    public bool Fallback { get; init; }

    public RuleCondition When { get; init; } = new();

    public LookupItem[] HostGroups { get; init; } = [];

    public string HostGroupsRef { get; init; } = string.Empty;

    public LookupItem[] Templates { get; init; } = [];

    public string TemplatesRef { get; init; } = string.Empty;

    public string InterfaceRef { get; init; } = string.Empty;

    public TagDefinition[] Tags { get; init; } = [];

    public string TagsRef { get; init; } = string.Empty;

    public ProxyDefinition[] Proxies { get; init; } = [];

    public ProxyDefinition Proxy { get; init; } = new();

    public string ProxiesRef { get; init; } = string.Empty;

    public string ProxyRef { get; init; } = string.Empty;

    public ProxyGroupDefinition[] ProxyGroups { get; init; } = [];

    public ProxyGroupDefinition ProxyGroup { get; init; } = new();

    public string ProxyGroupsRef { get; init; } = string.Empty;

    public string ProxyGroupRef { get; init; } = string.Empty;

    public HostMacroDefinition[] HostMacros { get; init; } = [];

    public HostMacroDefinition HostMacro { get; init; } = new();

    public string HostMacrosRef { get; init; } = string.Empty;

    public string HostMacroRef { get; init; } = string.Empty;

    public InventoryFieldDefinition[] InventoryFields { get; init; } = [];

    public InventoryFieldDefinition InventoryField { get; init; } = new();

    public string InventoryFieldsRef { get; init; } = string.Empty;

    public string InventoryFieldRef { get; init; } = string.Empty;

    public string InterfaceProfileRef { get; init; } = string.Empty;

    public HostStatusDefinition HostStatus { get; init; } = new();

    public string HostStatusRef { get; init; } = string.Empty;

    public MaintenanceDefinition[] Maintenances { get; init; } = [];

    public MaintenanceDefinition Maintenance { get; init; } = new();

    public string MaintenancesRef { get; init; } = string.Empty;

    public string MaintenanceRef { get; init; } = string.Empty;

    public TlsPskDefinition TlsPsk { get; init; } = new();

    public TlsPskDefinition TlsPskMode { get; init; } = new();

    public string TlsPskRef { get; init; } = string.Empty;

    public string TlsPskModeRef { get; init; } = string.Empty;

    public ValueMapDefinition[] ValueMaps { get; init; } = [];

    public ValueMapDefinition ValueMap { get; init; } = new();

    public string ValueMapsRef { get; init; } = string.Empty;

    public string ValueMapRef { get; init; } = string.Empty;
}

public sealed class RuleCondition
{
    public bool Always { get; init; }

    public string FieldExists { get; init; } = string.Empty;

    public string[] FieldsExist { get; init; } = [];

    public RegexCondition[] AnyRegex { get; init; } = [];

    public RegexCondition[] AllRegex { get; init; } = [];
}

public sealed class RegexCondition
{
    public string Field { get; init; } = string.Empty;

    public string Pattern { get; init; } = string.Empty;
}

public sealed class T4TemplateSet
{
    public string Engine { get; init; } = string.Empty;

    public string ModelParameter { get; init; } = "Model";

    public string[] HostCreateJsonRpcRequestLines { get; init; } = [];

    public string[] HostUpdateJsonRpcRequestLines { get; init; } = [];

    public string[] HostDeleteJsonRpcRequestLines { get; init; } = [];

    public string[] HostGetByHostJsonRpcRequestLines { get; init; } = [];

    [JsonExtensionData]
    public Dictionary<string, object> AdditionalTemplates { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}
