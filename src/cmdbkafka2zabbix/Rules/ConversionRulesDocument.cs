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

    public SelectionRule[] GroupSelectionRules { get; init; } = [];

    public SelectionRule[] TemplateSelectionRules { get; init; } = [];

    public SelectionRule[] InterfaceSelectionRules { get; init; } = [];

    public SelectionRule[] TagSelectionRules { get; init; } = [];

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

public sealed class SourceRules
{
    public string[] SupportedEvents { get; init; } = [];

    public string[] HostCreateEvents { get; init; } = [];

    public Dictionary<string, SourceFieldRule> Fields { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class SourceFieldRule
{
    public string Source { get; init; } = string.Empty;

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

    public TagDefinition[] Tags { get; init; } = [];
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

public sealed class TagDefinition
{
    public string Tag { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;

    public string ValueTemplate { get; init; } = string.Empty;
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
}

public sealed class RuleCondition
{
    public bool Always { get; init; }

    public RegexCondition[] AnyRegex { get; init; } = [];
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
}
