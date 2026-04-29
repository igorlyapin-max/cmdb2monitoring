using System.Text.Json;
using System.Text.RegularExpressions;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbToZabbixConverter(
    T4TemplateRenderer templateRenderer,
    IOptions<ConversionRulesOptions> options)
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(500);

    public async Task<ZabbixConversionResult> ConvertAsync(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        CancellationToken cancellationToken)
    {
        var route = ResolveRoute(source, rules);
        if (route is null || !route.Publish)
        {
            var method = string.IsNullOrWhiteSpace(rules.Zabbix.Method) ? "host.create" : rules.Zabbix.Method;
            return ZabbixConversionResult.Skipped(source, method, $"event_type_not_configured:{source.EventType}");
        }

        var methodName = route.Method;
        var templateName = route.TemplateName;
        string? fallbackForMethod = null;
        if (route.RequiresZabbixHostId && string.IsNullOrWhiteSpace(source.ZabbixHostId))
        {
            if (string.IsNullOrWhiteSpace(route.FallbackMethod) || string.IsNullOrWhiteSpace(route.FallbackTemplateName))
            {
                return ZabbixConversionResult.Skipped(source, methodName, "missing_zabbix_hostid");
            }

            fallbackForMethod = methodName;
            methodName = route.FallbackMethod;
            templateName = route.FallbackTemplateName;
        }

        var validationError = Validate(source, rules, route.RequiredFields);
        if (!string.IsNullOrWhiteSpace(validationError))
        {
            return ZabbixConversionResult.Skipped(source, methodName, validationError);
        }

        var model = BuildModel(source, rules, methodName, fallbackForMethod);
        var templateLines = ResolveTemplateLines(rules, templateName);
        if (templateLines.Length == 0)
        {
            throw new InvalidOperationException($"Conversion rules do not contain '{templateName}' T4 template.");
        }

        var request = await templateRenderer.RenderAsync(templateLines, model, cancellationToken);

        using (JsonDocument.Parse(request))
        {
        }

        return new ZabbixConversionResult(
            ShouldPublish: true,
            Key: source.EntityId ?? model.Host,
            Value: request,
            Method: methodName,
            EntityId: source.EntityId,
            EventType: source.EventType,
            Host: model.Host,
            SkipReason: null);
    }

    private ZabbixHostCreateModel BuildModel(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        string currentMethod,
        string? fallbackForMethod)
    {
        var initialModel = new ZabbixHostCreateModel
        {
            ClassName = source.ClassName ?? source.EntityType ?? "unknown",
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            ZabbixHostId = source.ZabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType,
            CurrentMethod = currentMethod,
            FallbackForMethod = fallbackForMethod,
            Status = rules.Defaults.Host.Status,
            InventoryMode = rules.Defaults.Host.InventoryMode
        };

        var host = BuildHostName(source, rules, initialModel);
        var visibleName = BuildVisibleName(source, rules, initialModel);

        return new ZabbixHostCreateModel
        {
            Host = host,
            VisibleName = visibleName,
            ClassName = initialModel.ClassName,
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            ZabbixHostId = source.ZabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType,
            CurrentMethod = currentMethod,
            FallbackForMethod = fallbackForMethod,
            Status = rules.Defaults.Host.Status,
            InventoryMode = rules.Defaults.Host.InventoryMode,
            Interface = MapInterface(SelectInterface(source, rules)),
            Groups = SelectGroups(source, rules),
            Templates = SelectTemplates(source, rules),
            Tags = BuildTags(source, rules),
            RequestId = BuildRequestId(source.EntityId ?? host)
        };
    }

    private string Validate(CmdbSourceEvent source, ConversionRulesDocument rules, string[] requiredFields)
    {
        foreach (var requiredField in requiredFields)
        {
            if (string.IsNullOrWhiteSpace(ReadField(source, requiredField)))
            {
                return $"missing_{requiredField.ToLowerInvariant()}";
            }
        }

        foreach (var (fieldName, fieldRule) in rules.Source.Fields)
        {
            if (string.IsNullOrWhiteSpace(fieldRule.ValidationRegex))
            {
                continue;
            }

            var value = ReadField(source, fieldName);
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (!Regex.IsMatch(value, fieldRule.ValidationRegex, RegexOptions.CultureInvariant, RegexTimeout))
            {
                return $"invalid_{ToSnakeCase(fieldName)}";
            }
        }

        return string.Empty;
    }

    private EventRoutingRule? ResolveRoute(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var route = rules.EventRoutingRules
            .FirstOrDefault(route => string.Equals(route.EventType, source.EventType, StringComparison.OrdinalIgnoreCase));
        if (route is not null)
        {
            return route;
        }

        if (rules.Source.HostCreateEvents.Length == 0
            || rules.Source.HostCreateEvents.Contains(source.EventType, StringComparer.OrdinalIgnoreCase))
        {
            return new EventRoutingRule
            {
                EventType = source.EventType,
                Method = string.IsNullOrWhiteSpace(rules.Zabbix.Method) ? "host.create" : rules.Zabbix.Method,
                TemplateName = options.Value.TemplateName,
                RequiredFields = ["entityId", "className", "ipAddress"]
            };
        }

        return null;
    }

    private string BuildHostName(CmdbSourceEvent source, ConversionRulesDocument rules, ZabbixHostCreateModel model)
    {
        var selectedInput = rules.Normalization.HostName.InputPriority
            .Select(field => ReadField(source, field))
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

        var rawHost = !string.IsNullOrWhiteSpace(selectedInput)
            ? templateRenderer.RenderSimple(rules.Normalization.HostName.PrefixTemplate, model) + selectedInput
            : templateRenderer.RenderSimple(rules.Normalization.HostName.FallbackTemplate, model);

        foreach (var replacement in rules.Normalization.HostName.RegexReplacements)
        {
            if (string.IsNullOrWhiteSpace(replacement.Pattern))
            {
                continue;
            }

            rawHost = Regex.Replace(
                rawHost,
                replacement.Pattern,
                replacement.Replacement,
                RegexOptions.CultureInvariant,
                RegexTimeout);
        }

        if (rules.Normalization.HostName.Lowercase)
        {
            rawHost = rawHost.ToLowerInvariant();
        }

        return string.IsNullOrWhiteSpace(rawHost)
            ? $"cmdb-{source.EntityId}"
            : rawHost;
    }

    private string BuildVisibleName(CmdbSourceEvent source, ConversionRulesDocument rules, ZabbixHostCreateModel model)
    {
        if (!string.IsNullOrWhiteSpace(rules.Normalization.VisibleName.Template))
        {
            return templateRenderer.RenderSimple(rules.Normalization.VisibleName.Template, model);
        }

        return $"{source.ClassName ?? source.EntityType ?? "Host"} {source.Code ?? source.EntityId}".Trim();
    }

    private List<ZabbixGroupModel> SelectGroups(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var matched = new List<LookupItem>();
        foreach (var rule in rules.GroupSelectionRules.Where(rule => !rule.Fallback).OrderBy(rule => rule.Priority))
        {
            if (Matches(source, rule.When))
            {
                matched.AddRange(ResolveGroups(rule, rules));
            }
        }

        if (matched.Count == 0)
        {
            foreach (var rule in rules.GroupSelectionRules.Where(rule => rule.Fallback).OrderBy(rule => rule.Priority))
            {
                if (Matches(source, rule.When))
                {
                    matched.AddRange(ResolveGroups(rule, rules));
                }
            }
        }

        return matched
            .Where(item => !string.IsNullOrWhiteSpace(item.GroupId))
            .GroupBy(item => item.GroupId, StringComparer.OrdinalIgnoreCase)
            .Select(group => new ZabbixGroupModel(group.First().Name, group.Key))
            .ToList();
    }

    private List<ZabbixTemplateModel> SelectTemplates(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var matched = new List<LookupItem>();
        foreach (var rule in rules.TemplateSelectionRules.Where(rule => !rule.Fallback).OrderBy(rule => rule.Priority))
        {
            if (Matches(source, rule.When))
            {
                matched.AddRange(ResolveTemplates(rule, rules));
            }
        }

        if (matched.Count == 0)
        {
            foreach (var rule in rules.TemplateSelectionRules.Where(rule => rule.Fallback).OrderBy(rule => rule.Priority))
            {
                if (Matches(source, rule.When))
                {
                    matched.AddRange(ResolveTemplates(rule, rules));
                }
            }
        }

        return matched
            .Where(item => !string.IsNullOrWhiteSpace(item.TemplateId))
            .GroupBy(item => item.TemplateId, StringComparer.OrdinalIgnoreCase)
            .Select(group => new ZabbixTemplateModel(group.First().Name, group.Key))
            .ToList();
    }

    private InterfaceSettings SelectInterface(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var matchedRule = rules.InterfaceSelectionRules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        matchedRule ??= rules.InterfaceSelectionRules
            .Where(rule => rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        return ResolveInterface(matchedRule?.InterfaceRef, rules);
    }

    private List<ZabbixTagModel> BuildTags(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var model = new ZabbixHostCreateModel
        {
            ClassName = source.ClassName ?? source.EntityType ?? "unknown",
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            ZabbixHostId = source.ZabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType
        };

        var tags = new List<TagDefinition>();
        tags.AddRange(rules.Defaults.Tags);

        var matched = rules.TagSelectionRules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .Where(rule => Matches(source, rule.When))
            .SelectMany(rule => ResolveTags(rule, rules))
            .ToArray();
        if (matched.Length > 0)
        {
            tags.AddRange(matched);
        }
        else
        {
            tags.AddRange(rules.TagSelectionRules
                .Where(rule => rule.Fallback)
                .OrderBy(rule => rule.Priority)
                .Where(rule => Matches(source, rule.When))
                .SelectMany(rule => ResolveTags(rule, rules)));
        }

        return tags
            .Where(tag => !string.IsNullOrWhiteSpace(tag.Tag))
            .Select(tag => new ZabbixTagModel(
                tag.Tag,
                !string.IsNullOrWhiteSpace(tag.Value)
                    ? tag.Value
                    : templateRenderer.RenderSimple(tag.ValueTemplate, model)))
            .GroupBy(tag => tag.Tag, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.Last())
            .ToList();
    }

    private static bool Matches(CmdbSourceEvent source, RuleCondition condition)
    {
        if (condition.Always)
        {
            return true;
        }

        foreach (var regex in condition.AnyRegex)
        {
            var value = ReadField(source, regex.Field);
            if (!string.IsNullOrWhiteSpace(value)
                && !string.IsNullOrWhiteSpace(regex.Pattern)
                && Regex.IsMatch(value, regex.Pattern, RegexOptions.CultureInvariant, RegexTimeout))
            {
                return true;
            }
        }

        return false;
    }

    private static string? ReadField(CmdbSourceEvent source, string field)
    {
        return field.ToLowerInvariant() switch
        {
            "source" => source.Source,
            "eventtype" => source.EventType,
            "entitytype" => source.EntityType,
            "entityid" or "id" => source.EntityId,
            "code" => source.Code,
            "classname" or "class" => source.ClassName,
            "ipaddress" or "ip_address" => source.IpAddress,
            "zabbixhostid" or "zabbix_hostid" => source.ZabbixHostId,
            "description" => source.Description,
            "os" or "operatingsystem" or "operating_system" => source.OperatingSystem,
            "zabbixtag" or "zabbix_tag" => source.ZabbixTag,
            _ => null
        };
    }

    private static string ToSnakeCase(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "field";
        }

        var builder = new System.Text.StringBuilder(value.Length + 4);
        for (var i = 0; i < value.Length; i++)
        {
            var character = value[i];
            if (char.IsUpper(character))
            {
                if (i > 0)
                {
                    builder.Append('_');
                }

                builder.Append(char.ToLowerInvariant(character));
                continue;
            }

            builder.Append(character == '-' ? '_' : character);
        }

        return builder.ToString();
    }

    private static LookupItem[] ResolveGroups(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.HostGroups.Length > 0)
        {
            return rule.HostGroups;
        }

        return string.Equals(rule.HostGroupsRef, "defaults.hostGroups", StringComparison.OrdinalIgnoreCase)
            ? rules.Defaults.HostGroups
            : [];
    }

    private static LookupItem[] ResolveTemplates(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.Templates.Length > 0)
        {
            return rule.Templates;
        }

        return string.Equals(rule.TemplatesRef, "defaults.templates", StringComparison.OrdinalIgnoreCase)
            ? rules.Defaults.Templates
            : [];
    }

    private static InterfaceSettings ResolveInterface(string? interfaceRef, ConversionRulesDocument rules)
    {
        return interfaceRef?.ToLowerInvariant() switch
        {
            "snmpinterface" => rules.Defaults.SnmpInterface,
            _ => rules.Defaults.AgentInterface
        };
    }

    private static TagDefinition[] ResolveTags(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.Tags.Length > 0)
        {
            return rule.Tags;
        }

        return string.Equals(rule.TagsRef, "defaults.tags", StringComparison.OrdinalIgnoreCase)
            ? rules.Defaults.Tags
            : [];
    }

    private static ZabbixInterfaceModel MapInterface(InterfaceSettings settings)
    {
        return new ZabbixInterfaceModel
        {
            Type = settings.Type,
            Main = settings.Main,
            UseIp = settings.UseIp,
            Dns = settings.Dns,
            Port = settings.Port
        };
    }

    private static int BuildRequestId(string value)
    {
        unchecked
        {
            var hash = 17;
            foreach (var character in value)
            {
                hash = (hash * 31) + character;
            }

            return hash == int.MinValue ? 0 : Math.Abs(hash);
        }
    }

    private string[] ResolveTemplateLines(ConversionRulesDocument rules, string templateName)
    {
        return templateName.ToLowerInvariant() switch
        {
            "hostcreatejsonrpcrequestlines" => rules.T4Templates.HostCreateJsonRpcRequestLines,
            "hostupdatejsonrpcrequestlines" => rules.T4Templates.HostUpdateJsonRpcRequestLines,
            "hostdeletejsonrpcrequestlines" => rules.T4Templates.HostDeleteJsonRpcRequestLines,
            "hostgetbyhostjsonrpcrequestlines" => rules.T4Templates.HostGetByHostJsonRpcRequestLines,
            _ => throw new InvalidOperationException($"Unsupported T4 template name '{templateName}'.")
        };
    }
}
