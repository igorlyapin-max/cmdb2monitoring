using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbToZabbixConverter(
    T4TemplateRenderer templateRenderer,
    IOptions<ConversionRulesOptions> options,
    ICmdbZabbixHostBindingResolver hostBindingResolver)
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(500);

    public CmdbToZabbixConverter(
        T4TemplateRenderer templateRenderer,
        IOptions<ConversionRulesOptions> options)
        : this(templateRenderer, options, NullCmdbZabbixHostBindingResolver.Instance)
    {
    }

    public async Task<IReadOnlyList<ZabbixConversionResult>> ConvertAsync(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        CancellationToken cancellationToken)
    {
        var route = ResolveRoute(source, rules);
        if (route is null || !route.Publish)
        {
            var method = string.IsNullOrWhiteSpace(rules.Zabbix.Method) ? "host.create" : rules.Zabbix.Method;
            return [ZabbixConversionResult.Skipped(source, method, $"event_type_not_configured:{source.EventType}")];
        }

        var suppressionRule = ResolveSuppressionRule(source, rules);
        if (suppressionRule is not null)
        {
            var method = string.IsNullOrWhiteSpace(route.Method) ? rules.Zabbix.Method : route.Method;
            return [ZabbixConversionResult.Skipped(source, method, BuildSuppressionReason(suppressionRule))];
        }

        var results = new List<ZabbixConversionResult>();
        var profiles = ResolveHostProfiles(source, rules);
        foreach (var profile in profiles)
        {
            var profileName = ProfileName(profile);
            var isMainProfile = IsMainProfile(profile);
            var profiledSource = AddHostProfileFields(source, profileName);
            var zabbixHostId = ResolveProfileZabbixHostId(
                profiledSource,
                profile,
                allowSourceHostId: profiles.Count == 1);
            if (route.RequiresZabbixHostId && string.IsNullOrWhiteSpace(zabbixHostId))
            {
                zabbixHostId = await hostBindingResolver.ResolveHostIdAsync(
                    profiledSource,
                    profileName,
                    isMainProfile,
                    cancellationToken);
            }

            var methodName = route.Method;
            var templateName = route.TemplateName;
            string? fallbackForMethod = null;

            if (route.RequiresZabbixHostId && string.IsNullOrWhiteSpace(zabbixHostId))
            {
                if (string.IsNullOrWhiteSpace(route.FallbackMethod) || string.IsNullOrWhiteSpace(route.FallbackTemplateName))
                {
                    results.Add(ZabbixConversionResult.Skipped(
                        profiledSource,
                        methodName,
                        "missing_zabbix_hostid",
                        profileName));
                    continue;
                }

                fallbackForMethod = methodName;
                methodName = route.FallbackMethod;
                templateName = route.FallbackTemplateName;
            }

            var model = BuildModel(profiledSource, rules, methodName, fallbackForMethod, profile, zabbixHostId);
            var validationError = Validate(profiledSource, rules, route.RequiredFields, model.Interfaces, profile);
            if (!string.IsNullOrWhiteSpace(validationError))
            {
                results.Add(ZabbixConversionResult.Skipped(profiledSource, methodName, validationError, profileName));
                continue;
            }

            var templateLines = ResolveTemplateLines(rules, templateName);
            if (templateLines.Length == 0)
            {
                throw new InvalidOperationException($"Conversion rules do not contain '{templateName}' T4 template.");
            }

            var request = await templateRenderer.RenderAsync(templateLines, model, cancellationToken);
            request = EnrichCmdb2MonitoringMetadata(request, model, rules, isMainProfile);

            using (JsonDocument.Parse(request))
            {
            }

            results.Add(new ZabbixConversionResult(
                ShouldPublish: true,
                Key: BuildKafkaKey(source, model),
                Value: request,
                Method: methodName,
                EntityId: source.EntityId,
                EventType: source.EventType,
                Host: model.Host,
                ProfileName: profileName,
                SkipReason: null));
        }

        if (results.Count == 0)
        {
            var method = string.IsNullOrWhiteSpace(rules.Zabbix.Method) ? "host.create" : rules.Zabbix.Method;
            return [ZabbixConversionResult.Skipped(source, method, "no_host_profile_matched")];
        }

        return results;
    }

    private static SuppressionRule? ResolveSuppressionRule(
        CmdbSourceEvent source,
        ConversionRulesDocument rules)
    {
        return rules.MonitoringSuppressionRules
            .Where(rule => rule.Enabled && Matches(source, rule.When))
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault();
    }

    private static string BuildSuppressionReason(SuppressionRule rule)
    {
        var name = string.IsNullOrWhiteSpace(rule.Name) ? "unnamed" : rule.Name;
        var reason = string.IsNullOrWhiteSpace(rule.Reason) ? "matched" : rule.Reason;
        return $"monitoring_suppressed:{name}:{reason}";
    }

    private ZabbixHostCreateModel BuildModel(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        string currentMethod,
        string? fallbackForMethod,
        HostProfileRule profile,
        string? zabbixHostId)
    {
        var profileName = ProfileName(profile);
        var initialModel = new ZabbixHostCreateModel
        {
            HostProfileName = profileName,
            ClassName = source.ClassName ?? source.EntityType ?? "unknown",
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            DnsName = source.DnsName ?? string.Empty,
            ZabbixHostId = zabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType,
            RulesVersion = rules.RulesVersion,
            SchemaVersion = rules.SchemaVersion,
            CurrentMethod = currentMethod,
            FallbackForMethod = fallbackForMethod,
            CreateOnUpdateWhenMissing = profile.CreateOnUpdateWhenMissing
                && string.Equals(fallbackForMethod, "host.update", StringComparison.OrdinalIgnoreCase),
            SourceFields = source.SourceFields,
            Status = rules.Defaults.Host.Status,
            InventoryMode = rules.Defaults.Host.InventoryMode
        };

        var host = BuildHostName(source, rules, initialModel, profile);
        var visibleName = BuildVisibleName(source, rules, initialModel, profile);
        var status = SelectHostStatus(source, rules) ?? rules.Defaults.Host.Status;
        var proxy = SelectProxy(source, rules);
        var proxyGroup = SelectProxyGroup(source, rules);
        var tlsPsk = SelectTlsPsk(source, rules);
        var interfaces = SelectInterfaces(source, rules, profile);
        var templateSelection = SelectTemplateSelection(source, rules);
        var firstInterface = interfaces.FirstOrDefault() ?? new ZabbixInterfaceModel();
        var renderModel = new ZabbixHostCreateModel
        {
            Host = host,
            VisibleName = visibleName,
            HostProfileName = profileName,
            ClassName = initialModel.ClassName,
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            DnsName = source.DnsName ?? string.Empty,
            ZabbixHostId = zabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType,
            RulesVersion = rules.RulesVersion,
            SchemaVersion = rules.SchemaVersion,
            CurrentMethod = currentMethod,
            FallbackForMethod = fallbackForMethod,
            CreateOnUpdateWhenMissing = profile.CreateOnUpdateWhenMissing
                && string.Equals(fallbackForMethod, "host.update", StringComparison.OrdinalIgnoreCase),
            SourceFields = source.SourceFields,
            Status = status,
            InventoryMode = rules.Defaults.Host.InventoryMode,
            ProxyId = proxy?.ProxyId,
            ProxyGroupId = proxyGroup?.ProxyGroupId,
            TlsPsk = MapTlsPsk(tlsPsk),
            Interface = firstInterface,
            Interfaces = interfaces
        };

        return new ZabbixHostCreateModel
        {
            Host = host,
            VisibleName = visibleName,
            HostProfileName = profileName,
            ClassName = initialModel.ClassName,
            EntityId = source.EntityId,
            Code = source.Code,
            IpAddress = source.IpAddress ?? string.Empty,
            DnsName = source.DnsName ?? string.Empty,
            ZabbixHostId = zabbixHostId,
            OperatingSystem = source.OperatingSystem,
            ZabbixTag = source.ZabbixTag,
            EventType = source.EventType,
            RulesVersion = rules.RulesVersion,
            SchemaVersion = rules.SchemaVersion,
            CurrentMethod = currentMethod,
            FallbackForMethod = fallbackForMethod,
            CreateOnUpdateWhenMissing = profile.CreateOnUpdateWhenMissing
                && string.Equals(fallbackForMethod, "host.update", StringComparison.OrdinalIgnoreCase),
            SourceFields = source.SourceFields,
            ProxyId = proxy?.ProxyId,
            ProxyGroupId = proxyGroup?.ProxyGroupId,
            TlsPsk = MapTlsPsk(tlsPsk),
            Status = status,
            InventoryMode = rules.Defaults.Host.InventoryMode,
            Interface = firstInterface,
            Interfaces = interfaces,
            Groups = SelectGroups(source, rules, renderModel),
            Templates = templateSelection.Templates,
            TemplatesToClear = templateSelection.TemplatesToClear,
            Tags = BuildTags(source, rules, renderModel),
            Macros = BuildHostMacros(source, rules, renderModel),
            InventoryFields = BuildInventoryFields(source, rules, renderModel),
            Maintenances = SelectMaintenances(source, rules),
            ValueMaps = SelectValueMaps(source, rules),
            RequestId = BuildRequestId($"{source.EntityId ?? host}:{profileName}")
        };
    }

    private string Validate(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        string[] requiredFields,
        IReadOnlyCollection<ZabbixInterfaceModel> interfaces,
        HostProfileRule profile)
    {
        foreach (var requiredField in requiredFields)
        {
            if (string.Equals(requiredField, "interfaceAddress", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(ReadField(source, requiredField)))
            {
                return $"missing_{requiredField.ToLowerInvariant()}";
            }

            var requiredFieldValidationError = ValidateSourceField(source, rules, requiredField);
            if (!string.IsNullOrWhiteSpace(requiredFieldValidationError))
            {
                return requiredFieldValidationError;
            }
        }

        foreach (var fieldName in ProfileInterfaceValueFields(source, profile))
        {
            var profileFieldValidationError = ValidateSourceField(source, rules, fieldName);
            if (!string.IsNullOrWhiteSpace(profileFieldValidationError))
            {
                return profileFieldValidationError;
            }
        }

        foreach (var zabbixInterface in interfaces)
        {
            if (zabbixInterface.UseIp == 1
                && !string.IsNullOrWhiteSpace(zabbixInterface.Ip)
                && !IsValidInterfaceIp(zabbixInterface.Ip))
            {
                return "invalid_interface_ip";
            }
        }

        if (RequiresInterfaceAddress(requiredFields) && !interfaces.Any(HasAddress))
        {
            return "missing_interface_address";
        }

        return string.Empty;
    }

    private static string ValidateSourceField(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        string fieldName)
    {
        if (!rules.Source.Fields.TryGetValue(fieldName, out var fieldRule)
            || string.IsNullOrWhiteSpace(fieldRule.ValidationRegex))
        {
            return string.Empty;
        }

        var value = ReadField(source, fieldName);
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        return Regex.IsMatch(value, fieldRule.ValidationRegex, RegexOptions.CultureInvariant, RegexTimeout)
            ? string.Empty
            : $"invalid_{ToSnakeCase(fieldName)}";
    }

    private static IEnumerable<string> ProfileInterfaceValueFields(CmdbSourceEvent source, HostProfileRule profile)
    {
        var profileInterfaces = SelectProfileInterfaceRules(source, profile);
        if (profileInterfaces.Count > 0)
        {
            foreach (var profileInterface in profileInterfaces)
            {
                var valueField = string.IsNullOrWhiteSpace(profileInterface.ValueField)
                    ? profile.ValueField
                    : profileInterface.ValueField;
                if (!string.IsNullOrWhiteSpace(valueField))
                {
                    yield return valueField;
                }
            }

            yield break;
        }

        if (!string.IsNullOrWhiteSpace(profile.ValueField))
        {
            yield return profile.ValueField;
        }
    }

    private static bool IsValidInterfaceIp(string value)
    {
        const string ipv4Pattern = "^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$";
        return Regex.IsMatch(value, ipv4Pattern, RegexOptions.CultureInvariant, RegexTimeout)
            || (value.Contains(':', StringComparison.Ordinal) && IPAddress.TryParse(value, out _));
    }

    private static bool RequiresInterfaceAddress(string[] requiredFields)
    {
        return requiredFields.Contains("interfaceAddress", StringComparer.OrdinalIgnoreCase)
            || requiredFields.Contains("ipAddress", StringComparer.OrdinalIgnoreCase)
            || requiredFields.Contains("dnsName", StringComparer.OrdinalIgnoreCase);
    }

    private static bool HasAddress(ZabbixInterfaceModel zabbixInterface)
    {
        return !string.IsNullOrWhiteSpace(zabbixInterface.Ip)
            || !string.IsNullOrWhiteSpace(zabbixInterface.Dns);
    }

    private static IReadOnlyList<HostProfileRule> ResolveHostProfiles(
        CmdbSourceEvent source,
        ConversionRulesDocument rules)
    {
        if (rules.HostProfiles.Length == 0)
        {
            return [DefaultHostProfile()];
        }

        var matched = rules.HostProfiles
            .Where(profile => profile.Enabled && !profile.Fallback && MatchesProfile(source, profile.When))
            .OrderBy(profile => profile.Priority)
            .ToArray();
        if (matched.Length > 0)
        {
            return matched;
        }

        var fallback = rules.HostProfiles
            .Where(profile => profile.Enabled && profile.Fallback && MatchesProfile(source, profile.When))
            .OrderBy(profile => profile.Priority)
            .ToArray();

        return fallback.Length > 0 ? fallback : [];
    }

    private static HostProfileRule DefaultHostProfile()
    {
        return new HostProfileRule
        {
            Name = "default",
            Enabled = true,
            When = new RuleCondition { Always = true }
        };
    }

    private static bool MatchesProfile(CmdbSourceEvent source, RuleCondition condition)
    {
        return IsEmptyCondition(condition) || Matches(source, condition);
    }

    private static bool IsEmptyCondition(RuleCondition condition)
    {
        return !condition.Always
            && string.IsNullOrWhiteSpace(condition.FieldExists)
            && condition.FieldsExist.Length == 0
            && condition.AnyRegex.Length == 0
            && condition.AllRegex.Length == 0;
    }

    private static string ProfileName(HostProfileRule profile)
    {
        return string.IsNullOrWhiteSpace(profile.Name) ? "default" : profile.Name;
    }

    private static bool IsMainProfile(HostProfileRule profile)
    {
        if (profile.IsMainProfile.HasValue)
        {
            return profile.IsMainProfile.Value;
        }

        if (IsMainProfileName(profile.Name))
        {
            return true;
        }

        return !string.IsNullOrWhiteSpace(profile.HostNameTemplate)
            && !profile.HostNameTemplate.Contains("HostProfileName", StringComparison.OrdinalIgnoreCase);
    }

    private static CmdbSourceEvent AddHostProfileFields(CmdbSourceEvent source, string profileName)
    {
        var sourceFields = new Dictionary<string, string>(source.SourceFields, StringComparer.OrdinalIgnoreCase)
        {
            ["hostProfile"] = profileName,
            ["outputProfile"] = profileName
        };

        return source with { SourceFields = sourceFields };
    }

    private static string? ResolveProfileZabbixHostId(
        CmdbSourceEvent source,
        HostProfileRule profile,
        bool allowSourceHostId)
    {
        if (!string.IsNullOrWhiteSpace(profile.ZabbixHostIdField))
        {
            return ReadField(source, profile.ZabbixHostIdField);
        }

        return allowSourceHostId || IsMainProfile(profile) ? source.ZabbixHostId : null;
    }

    private static string EnrichCmdb2MonitoringMetadata(
        string requestJson,
        ZabbixHostCreateModel model,
        ConversionRulesDocument rules,
        bool isMainProfile)
    {
        var root = JsonNode.Parse(requestJson) as JsonObject
            ?? throw new JsonException("Rendered Zabbix request must be a JSON object.");
        if (root["cmdb2monitoring"] is not JsonObject metadata)
        {
            metadata = new JsonObject();
            root["cmdb2monitoring"] = metadata;
        }

        WriteMetadata(metadata, "entityId", model.EntityId);
        WriteMetadata(metadata, "sourceCardId", model.EntityId);
        WriteMetadata(metadata, "sourceClass", model.ClassName);
        WriteMetadata(metadata, "sourceCode", model.Code);
        WriteMetadata(metadata, "host", model.Host);
        WriteMetadata(metadata, "hostProfile", model.HostProfileName);
        WriteMetadata(metadata, "eventType", model.EventType);
        WriteMetadata(metadata, "rulesVersion", rules.RulesVersion);
        WriteMetadata(metadata, "schemaVersion", rules.SchemaVersion);
        metadata["isMainProfile"] = isMainProfile;

        return root.ToJsonString();
    }

    private static void WriteMetadata(JsonObject metadata, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            metadata[name] = value;
        }
    }

    private static bool IsMainProfileName(string? profileName)
    {
        return string.IsNullOrWhiteSpace(profileName)
            || string.Equals(profileName, "default", StringComparison.OrdinalIgnoreCase)
            || string.Equals(profileName, "main", StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildKafkaKey(CmdbSourceEvent source, ZabbixHostCreateModel model)
    {
        return string.IsNullOrWhiteSpace(model.HostProfileName)
            || string.Equals(model.HostProfileName, "default", StringComparison.OrdinalIgnoreCase)
                ? source.EntityId ?? model.Host
                : $"{source.EntityId ?? model.Host}:{model.HostProfileName}";
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
                RequiredFields = ["entityId", "className", "interfaceAddress"]
            };
        }

        return null;
    }

    private string BuildHostName(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model,
        HostProfileRule profile)
    {
        if (!string.IsNullOrWhiteSpace(profile.HostNameTemplate))
        {
            return NormalizeHostName(templateRenderer.RenderSimple(profile.HostNameTemplate, model), rules, source);
        }

        var selectedInput = rules.Normalization.HostName.InputPriority
            .Select(field => ReadField(source, field))
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

        var rawHost = !string.IsNullOrWhiteSpace(selectedInput)
            ? templateRenderer.RenderSimple(rules.Normalization.HostName.PrefixTemplate, model) + selectedInput
            : templateRenderer.RenderSimple(rules.Normalization.HostName.FallbackTemplate, model);

        return NormalizeHostName(rawHost, rules, source);
    }

    private static string NormalizeHostName(string rawHost, ConversionRulesDocument rules, CmdbSourceEvent source)
    {
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

    private string BuildVisibleName(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model,
        HostProfileRule profile)
    {
        if (!string.IsNullOrWhiteSpace(profile.VisibleNameTemplate))
        {
            return templateRenderer.RenderSimple(profile.VisibleNameTemplate, model);
        }

        if (!string.IsNullOrWhiteSpace(rules.Normalization.VisibleName.Template))
        {
            return templateRenderer.RenderSimple(rules.Normalization.VisibleName.Template, model);
        }

        return $"{source.ClassName ?? source.EntityType ?? "Host"} {source.Code ?? source.EntityId}".Trim();
    }

    private List<ZabbixGroupModel> SelectGroups(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model)
    {
        var matched = new List<ZabbixGroupModel>();
        foreach (var rule in rules.GroupSelectionRules.Where(rule => !rule.Fallback).OrderBy(rule => rule.Priority))
        {
            if (Matches(source, rule.When))
            {
                matched.AddRange(ResolveGroups(rule, rules, source, model));
            }
        }

        if (matched.Count == 0)
        {
            foreach (var rule in rules.GroupSelectionRules.Where(rule => rule.Fallback).OrderBy(rule => rule.Priority))
            {
                if (Matches(source, rule.When))
                {
                    matched.AddRange(ResolveGroups(rule, rules, source, model));
                }
            }
        }

        return matched
            .Where(item => !string.IsNullOrWhiteSpace(item.GroupId) || !string.IsNullOrWhiteSpace(item.Name))
            .GroupBy(GroupKey, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.Last())
            .ToList();
    }

    private TemplateSelectionResult SelectTemplateSelection(CmdbSourceEvent source, ConversionRulesDocument rules)
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

        var templatesWithIds = matched
            .Where(item => !string.IsNullOrWhiteSpace(item.TemplateId))
            .ToList();
        var conflictResult = ApplyTemplateConflictRules(templatesWithIds, rules.TemplateConflictRules);
        var selectedTemplates = conflictResult.Templates
            .GroupBy(item => item.TemplateId, StringComparer.OrdinalIgnoreCase)
            .Select(group => new ZabbixTemplateModel(group.First().Name, group.Key))
            .ToList();
        var templatesToClear = conflictResult.TemplateIdsToClear
            .Where(templateId => !selectedTemplates.Any(template => string.Equals(template.TemplateId, templateId, StringComparison.OrdinalIgnoreCase)))
            .Select(templateId => new ZabbixTemplateModel(FindTemplateName(templateId, rules), templateId))
            .ToList();

        return new TemplateSelectionResult(selectedTemplates, templatesToClear);
    }

    private static TemplateConflictResult ApplyTemplateConflictRules(
        IReadOnlyCollection<LookupItem> templates,
        IEnumerable<TemplateConflictRule> conflictRules)
    {
        var selectedIds = templates
            .Where(item => !string.IsNullOrWhiteSpace(item.TemplateId))
            .Select(item => item.TemplateId)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var idsToRemove = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var rule in conflictRules)
        {
            if (rule.WhenTemplateIds.Length == 0 || rule.RemoveTemplateIds.Length == 0)
            {
                continue;
            }

            if (rule.WhenTemplateIds.Any(selectedIds.Contains))
            {
                foreach (var templateId in rule.RemoveTemplateIds.Where(id => !string.IsNullOrWhiteSpace(id)))
                {
                    idsToRemove.Add(templateId);
                }
            }
        }

        var selectedTemplates = idsToRemove.Count == 0
            ? templates.ToList()
            : templates.Where(item => !idsToRemove.Contains(item.TemplateId)).ToList();

        return new TemplateConflictResult(selectedTemplates, idsToRemove.ToList());
    }

    private static string FindTemplateName(string templateId, ConversionRulesDocument rules)
    {
        return rules.Defaults.Templates
            .Concat(rules.TemplateSelectionRules.SelectMany(rule => rule.Templates))
            .FirstOrDefault(template => string.Equals(template.TemplateId, templateId, StringComparison.OrdinalIgnoreCase))
            ?.Name ?? string.Empty;
    }

    private sealed record TemplateSelectionResult(
        List<ZabbixTemplateModel> Templates,
        List<ZabbixTemplateModel> TemplatesToClear);

    private sealed record TemplateConflictResult(
        List<LookupItem> Templates,
        List<string> TemplateIdsToClear);

    private InterfaceSettings SelectInterface(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        var matchedProfileRule = rules.InterfaceProfileSelectionRules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        matchedProfileRule ??= rules.InterfaceProfileSelectionRules
            .Where(rule => rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        if (!string.IsNullOrWhiteSpace(matchedProfileRule?.InterfaceProfileRef))
        {
            return ResolveInterface(matchedProfileRule.InterfaceProfileRef, rules);
        }

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

    private List<ZabbixInterfaceModel> SelectInterfaces(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        HostProfileRule profile)
    {
        var profileInterfaces = SelectProfileInterfaceRules(source, profile);
        var interfaces = new List<ZabbixInterfaceModel>();

        if (profileInterfaces.Count > 0)
        {
            foreach (var rule in profileInterfaces)
            {
                var mappedInterface = MapInterface(
                    ResolveInterfaceForProfileRule(rule, profile, source, rules),
                    SelectInterfaceAddress(source, rules, profile, rule),
                    source);
                if (!HasAddress(mappedInterface))
                {
                    continue;
                }

                if (rule.Fallback && interfaces.Any(item => item.Type == mappedInterface.Type))
                {
                    continue;
                }

                interfaces.Add(mappedInterface);
            }
        }
        else if (HasProfileInterfaceSettings(profile))
        {
            interfaces.Add(MapInterface(
                ResolveInterfaceForProfile(profile, source, rules),
                SelectInterfaceAddress(source, rules, profile, null),
                source));
        }
        else
        {
            interfaces.Add(MapInterface(SelectInterface(source, rules), SelectInterfaceAddress(source, rules), source));
        }

        return interfaces
            .Where(HasAddress)
            .GroupBy(item => $"{item.Type}|{item.UseIp}|{item.Ip}|{item.Dns}|{item.Port}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .GroupBy(item => item.Type)
            .SelectMany(NormalizeInterfaceMainFlags)
            .ToList();
    }

    private static IEnumerable<ZabbixInterfaceModel> NormalizeInterfaceMainFlags(IGrouping<int, ZabbixInterfaceModel> interfacesByType)
    {
        var items = interfacesByType.ToList();
        var hasConfiguredMain = items.Any(candidate => candidate.Main == 1);
        var mainSelected = false;
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            var main = !mainSelected && (item.Main == 1 || !hasConfiguredMain);
            if (main)
            {
                mainSelected = true;
            }

            yield return item.Main == (main ? 1 : 0)
                ? item
                : CopyInterface(item, main ? 1 : 0);
        }
    }

    private static ZabbixInterfaceModel CopyInterface(ZabbixInterfaceModel item, int main)
    {
        return new ZabbixInterfaceModel
        {
            Type = item.Type,
            Main = main,
            UseIp = item.UseIp,
            Ip = item.Ip,
            Dns = item.Dns,
            Port = item.Port,
            Details = item.Details
        };
    }

    private static List<HostProfileInterfaceRule> SelectProfileInterfaceRules(
        CmdbSourceEvent source,
        HostProfileRule profile)
    {
        return profile.Interfaces
            .Where(rule => rule.Enabled && MatchesProfile(source, rule.When))
            .OrderBy(rule => rule.Fallback ? 1 : 0)
            .ThenBy(rule => rule.Priority)
            .ToList();
    }

    private static bool HasProfileInterfaceSettings(HostProfileRule profile)
    {
        return !string.IsNullOrWhiteSpace(profile.InterfaceProfileRef)
            || !string.IsNullOrWhiteSpace(profile.InterfaceRef)
            || !string.IsNullOrWhiteSpace(profile.ValueField)
            || !string.IsNullOrWhiteSpace(profile.Mode);
    }

    private InterfaceSettings ResolveInterfaceForProfileRule(
        HostProfileInterfaceRule rule,
        HostProfileRule profile,
        CmdbSourceEvent source,
        ConversionRulesDocument rules)
    {
        if (!string.IsNullOrWhiteSpace(rule.InterfaceProfileRef))
        {
            return ResolveInterface(rule.InterfaceProfileRef, rules);
        }

        if (!string.IsNullOrWhiteSpace(rule.InterfaceRef))
        {
            return ResolveInterface(rule.InterfaceRef, rules);
        }

        return ResolveInterfaceForProfile(profile, source, rules);
    }

    private InterfaceSettings ResolveInterfaceForProfile(
        HostProfileRule profile,
        CmdbSourceEvent source,
        ConversionRulesDocument rules)
    {
        if (!string.IsNullOrWhiteSpace(profile.InterfaceProfileRef))
        {
            return ResolveInterface(profile.InterfaceProfileRef, rules);
        }

        if (!string.IsNullOrWhiteSpace(profile.InterfaceRef))
        {
            return ResolveInterface(profile.InterfaceRef, rules);
        }

        return SelectInterface(source, rules);
    }

    private static InterfaceAddressSelection? SelectInterfaceAddress(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        if (rules.InterfaceAddressRules.Length == 0)
        {
            if (!string.IsNullOrWhiteSpace(source.IpAddress))
            {
                return new InterfaceAddressSelection("ip", source.IpAddress);
            }

            return !string.IsNullOrWhiteSpace(source.DnsName)
                ? new InterfaceAddressSelection("dns", source.DnsName)
                : null;
        }

        var matchedRule = rules.InterfaceAddressRules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        matchedRule ??= rules.InterfaceAddressRules
            .Where(rule => rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .FirstOrDefault(rule => Matches(source, rule.When));

        if (matchedRule is null)
        {
            return null;
        }

        var valueField = string.IsNullOrWhiteSpace(matchedRule.ValueField)
            ? matchedRule.Mode
            : matchedRule.ValueField;
        var value = ReadField(source, valueField);
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var mode = string.IsNullOrWhiteSpace(matchedRule.Mode)
            ? InferAddressMode(valueField)
            : matchedRule.Mode;
        return new InterfaceAddressSelection(mode, value);
    }

    private static InterfaceAddressSelection? SelectInterfaceAddress(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        HostProfileRule profile,
        HostProfileInterfaceRule? profileInterface)
    {
        var mode = profileInterface?.Mode;
        var valueField = profileInterface?.ValueField;
        if (string.IsNullOrWhiteSpace(valueField))
        {
            mode = profile.Mode;
            valueField = profile.ValueField;
        }

        if (string.IsNullOrWhiteSpace(valueField))
        {
            return SelectInterfaceAddress(source, rules);
        }

        var value = ReadField(source, valueField);
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return new InterfaceAddressSelection(
            string.IsNullOrWhiteSpace(mode) ? InferAddressMode(valueField) : mode,
            value);
    }

    private static string InferAddressMode(string valueField)
    {
        return CanonicalFieldName(valueField).Equals("dnsName", StringComparison.OrdinalIgnoreCase)
            ? "dns"
            : "ip";
    }

    private List<ZabbixTagModel> BuildTags(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model)
    {
        var tags = new List<TagDefinition>();
        tags.AddRange(rules.Defaults.Tags);

        var matched = rules.TagSelectionRules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .Where(rule => Matches(source, rule.When))
            .SelectMany(rule => ResolveTags(rule, rules, source, model))
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
                .SelectMany(rule => ResolveTags(rule, rules, source, model)));
        }

        return tags
            .Where(tag => !string.IsNullOrWhiteSpace(tag.Tag))
            .Select(tag => new
            {
                tag.AllowMultipleValues,
                Model = new ZabbixTagModel(
                    tag.Tag,
                    !string.IsNullOrWhiteSpace(tag.Value)
                        ? tag.Value
                        : templateRenderer.RenderSimple(tag.ValueTemplate, model))
            })
            .GroupBy(tag => tag.AllowMultipleValues ? $"{tag.Model.Tag}\u001f{tag.Model.Value}" : tag.Model.Tag, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.Last().Model)
            .ToList();
    }

    private List<ZabbixMacroModel> BuildHostMacros(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model)
    {
        var macros = new List<HostMacroDefinition>();
        macros.AddRange(rules.Defaults.HostMacros);
        macros.AddRange(SelectManyFromRules(
            source,
            rules.HostMacroSelectionRules,
            rule => ResolveHostMacros(rule, rules)));

        return macros
            .Where(macro => !string.IsNullOrWhiteSpace(macro.Macro))
            .Select(macro => new ZabbixMacroModel(
                macro.Macro,
                !string.IsNullOrWhiteSpace(macro.Value)
                    ? macro.Value
                    : templateRenderer.RenderSimple(macro.ValueTemplate, model),
                macro.Description,
                macro.Type))
            .GroupBy(macro => macro.Macro, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.Last())
            .ToList();
    }

    private List<ZabbixInventoryFieldModel> BuildInventoryFields(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        ZabbixHostCreateModel model)
    {
        var fields = new List<InventoryFieldDefinition>();
        fields.AddRange(rules.Defaults.InventoryFields);
        fields.AddRange(SelectManyFromRules(
            source,
            rules.InventorySelectionRules,
            rule => ResolveInventoryFields(rule, rules)));

        return fields
            .Select(field => new
            {
                Field = string.IsNullOrWhiteSpace(field.Field) ? field.Name : field.Field,
                Value = !string.IsNullOrWhiteSpace(field.Value)
                    ? field.Value
                    : templateRenderer.RenderSimple(field.ValueTemplate, model)
            })
            .Where(field => !string.IsNullOrWhiteSpace(field.Field) && !string.IsNullOrWhiteSpace(field.Value))
            .GroupBy(field => field.Field, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.Last())
            .Select(field => new ZabbixInventoryFieldModel(field.Field, field.Value))
            .ToList();
    }

    private ProxyDefinition? SelectProxy(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectFirstFromRules(source, rules.ProxySelectionRules, rule => ResolveProxies(rule, rules))
            ?? (HasProxy(rules.Defaults.Proxy) ? rules.Defaults.Proxy : null);
    }

    private ProxyGroupDefinition? SelectProxyGroup(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectFirstFromRules(source, rules.ProxyGroupSelectionRules, rule => ResolveProxyGroups(rule, rules))
            ?? (HasProxyGroup(rules.Defaults.ProxyGroup) ? rules.Defaults.ProxyGroup : null);
    }

    private int? SelectHostStatus(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectFirstFromRules(source, rules.HostStatusSelectionRules, rule => ResolveHostStatuses(rule, rules))?.Status
            ?? rules.Defaults.HostStatus.Status;
    }

    private TlsPskDefinition? SelectTlsPsk(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectFirstFromRules(source, rules.TlsPskSelectionRules, rule => ResolveTlsPsk(rule, rules))
            ?? (HasTlsPsk(rules.Defaults.TlsPsk) ? rules.Defaults.TlsPsk : null);
    }

    private List<ZabbixMaintenanceModel> SelectMaintenances(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectManyFromRules(source, rules.MaintenanceSelectionRules, rule => ResolveMaintenances(rule, rules))
            .Where(item => !string.IsNullOrWhiteSpace(item.MaintenanceId) || !string.IsNullOrWhiteSpace(item.Name))
            .GroupBy(item => !string.IsNullOrWhiteSpace(item.MaintenanceId) ? item.MaintenanceId : item.Name, StringComparer.OrdinalIgnoreCase)
            .Select(group => new ZabbixMaintenanceModel(group.Last().Name, group.Last().MaintenanceId))
            .ToList();
    }

    private List<ZabbixValueMapModel> SelectValueMaps(CmdbSourceEvent source, ConversionRulesDocument rules)
    {
        return SelectManyFromRules(source, rules.ValueMapSelectionRules, rule => ResolveValueMaps(rule, rules))
            .Where(item => !string.IsNullOrWhiteSpace(item.ValueMapId) || !string.IsNullOrWhiteSpace(item.Name))
            .GroupBy(item => !string.IsNullOrWhiteSpace(item.ValueMapId) ? item.ValueMapId : item.Name, StringComparer.OrdinalIgnoreCase)
            .Select(group => new ZabbixValueMapModel(group.Last().Name, group.Last().ValueMapId))
            .ToList();
    }

    private static List<T> SelectManyFromRules<T>(
        CmdbSourceEvent source,
        IEnumerable<SelectionRule> rules,
        Func<SelectionRule, T[]> resolve)
    {
        var matched = rules
            .Where(rule => !rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .Where(rule => Matches(source, rule.When))
            .SelectMany(resolve)
            .ToList();

        if (matched.Count > 0)
        {
            return matched;
        }

        return rules
            .Where(rule => rule.Fallback)
            .OrderBy(rule => rule.Priority)
            .Where(rule => Matches(source, rule.When))
            .SelectMany(resolve)
            .ToList();
    }

    private static T? SelectFirstFromRules<T>(
        CmdbSourceEvent source,
        IEnumerable<SelectionRule> rules,
        Func<SelectionRule, T[]> resolve)
    {
        return SelectManyFromRules(source, rules, resolve).FirstOrDefault();
    }

    private static bool Matches(CmdbSourceEvent source, RuleCondition condition)
    {
        if (condition.Always)
        {
            return true;
        }

        var hasConditions = false;
        if (!string.IsNullOrWhiteSpace(condition.FieldExists))
        {
            hasConditions = true;
            if (string.IsNullOrWhiteSpace(ReadField(source, condition.FieldExists)))
            {
                return false;
            }
        }

        if (condition.FieldsExist.Length > 0)
        {
            hasConditions = true;
            if (!condition.FieldsExist.All(field => !string.IsNullOrWhiteSpace(ReadField(source, field))))
            {
                return false;
            }
        }

        if (condition.AllRegex.Length > 0)
        {
            hasConditions = true;
            if (!condition.AllRegex.All(regex => MatchesRegex(source, regex)))
            {
                return false;
            }
        }

        if (condition.AnyRegex.Length > 0)
        {
            hasConditions = true;
            if (!condition.AnyRegex.Any(regex => MatchesRegex(source, regex)))
            {
                return false;
            }
        }

        return hasConditions;
    }

    private static bool MatchesRegex(CmdbSourceEvent source, RegexCondition regex)
    {
        var value = ReadField(source, regex.Field);
        return !string.IsNullOrWhiteSpace(value)
            && !string.IsNullOrWhiteSpace(regex.Pattern)
            && Regex.IsMatch(value, regex.Pattern, RegexOptions.CultureInvariant, RegexTimeout);
    }

    private static string? ReadField(CmdbSourceEvent source, string field)
    {
        if (source.SourceFields.TryGetValue(field, out var configuredValue))
        {
            return configuredValue;
        }

        var canonicalField = CanonicalFieldName(field);
        if (source.SourceFields.TryGetValue(canonicalField, out configuredValue))
        {
            return configuredValue;
        }

        return field.ToLowerInvariant() switch
        {
            "source" => source.Source,
            "eventtype" => source.EventType,
            "entitytype" => source.EntityType,
            "entityid" or "id" => source.EntityId,
            "code" => source.Code,
            "classname" or "class" => source.ClassName,
            "ipaddress" or "ip_address" => source.IpAddress,
            "dnsname" or "dns_name" or "fqdn" or "hostname" or "host_dns" => source.DnsName,
            "zabbixhostid" or "zabbix_hostid" => source.ZabbixHostId,
            "description" => source.Description,
            "os" or "operatingsystem" or "operating_system" => source.OperatingSystem,
            "zabbixtag" or "zabbix_tag" => source.ZabbixTag,
            _ => null
        };
    }

    private static string CanonicalFieldName(string field)
    {
        return field.Replace("_", string.Empty, StringComparison.Ordinal).ToLowerInvariant() switch
        {
            "entityid" or "id" => "entityId",
            "classname" or "class" => "className",
            "ipaddress" => "ipAddress",
            "dnsname" or "fqdn" or "hostname" or "hostdns" => "dnsName",
            "profileipaddress" or "profileip" or "profile" => "profileIpAddress",
            "profile2ipaddress" or "profile2ip" or "profile2" => "profile2IpAddress",
            "interfaceipaddress" or "interfaceip" or "interface" => "interfaceIpAddress",
            "interface2ipaddress" or "interface2ip" or "interface2" => "interface2IpAddress",
            "profilednsname" or "profiledns" => "profileDnsName",
            "zabbixhostid" => "zabbixHostId",
            "os" or "operatingsystem" => "os",
            "zabbixtag" => "zabbixTag",
            _ => field
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

    private ZabbixGroupModel[] ResolveGroups(
        SelectionRule rule,
        ConversionRulesDocument rules,
        CmdbSourceEvent source,
        ZabbixHostCreateModel model)
    {
        if (IsDynamicFromLeaf(rule))
        {
            return ResolveDynamicGroups(rule, source, model);
        }

        var groups = rule.HostGroups.Length > 0
            ? rule.HostGroups
            : string.Equals(rule.HostGroupsRef, "defaults.hostGroups", StringComparison.OrdinalIgnoreCase)
            ? rules.Defaults.HostGroups
            : [];

        return groups.Select(group => new ZabbixGroupModel(
                group.Name,
                group.GroupId,
                group.CreateIfMissing || rule.CreateIfMissing))
            .ToArray();
    }

    private ZabbixGroupModel[] ResolveDynamicGroups(
        SelectionRule rule,
        CmdbSourceEvent source,
        ZabbixHostCreateModel model)
    {
        var valueField = DynamicValueField(rule);
        var template = rule.HostGroups.FirstOrDefault()?.NameTemplate;
        var rawValue = !string.IsNullOrWhiteSpace(template)
            ? templateRenderer.RenderSimple(template, model)
            : ReadField(source, valueField);

        return SplitDynamicLeafValues(rawValue)
            .Select(value => new ZabbixGroupModel(
                value,
                string.Empty,
                rule.CreateIfMissing || rule.HostGroups.Any(group => group.CreateIfMissing)))
            .ToArray();
    }

    private static bool IsDynamicFromLeaf(SelectionRule rule)
    {
        return string.Equals(rule.TargetMode, "dynamicFromLeaf", StringComparison.OrdinalIgnoreCase);
    }

    private static string DynamicValueField(SelectionRule rule)
    {
        if (!string.IsNullOrWhiteSpace(rule.ValueField))
        {
            return rule.ValueField;
        }

        return rule.When.AllRegex
            .Concat(rule.When.AnyRegex)
            .Select(regex => regex.Field)
            .FirstOrDefault(field => !string.IsNullOrWhiteSpace(field)
                && !string.Equals(CanonicalFieldName(field), "className", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(CanonicalFieldName(field), "eventType", StringComparison.OrdinalIgnoreCase))
            ?? string.Empty;
    }

    private static string[] SplitDynamicLeafValues(string? value)
    {
        return (value ?? string.Empty)
            .Split(new[] { '\n', ';', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string GroupKey(ZabbixGroupModel group)
    {
        return !string.IsNullOrWhiteSpace(group.GroupId)
            ? $"id:{group.GroupId}"
            : $"name:{group.Name}";
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
        if (!string.IsNullOrWhiteSpace(interfaceRef)
            && rules.Defaults.InterfaceProfiles.TryGetValue(interfaceRef, out var profile))
        {
            return profile;
        }

        return interfaceRef?.ToLowerInvariant() switch
        {
            "snmpinterface" => rules.Defaults.SnmpInterface,
            _ => rules.Defaults.AgentInterface
        };
    }

    private TagDefinition[] ResolveTags(
        SelectionRule rule,
        ConversionRulesDocument rules,
        CmdbSourceEvent source,
        ZabbixHostCreateModel model)
    {
        if (IsDynamicFromLeaf(rule))
        {
            return ResolveDynamicTags(rule, source, model);
        }

        if (rule.Tags.Length > 0)
        {
            return rule.Tags;
        }

        return string.Equals(rule.TagsRef, "defaults.tags", StringComparison.OrdinalIgnoreCase)
            ? rules.Defaults.Tags
            : [];
    }

    private TagDefinition[] ResolveDynamicTags(
        SelectionRule rule,
        CmdbSourceEvent source,
        ZabbixHostCreateModel model)
    {
        var valueField = DynamicValueField(rule);
        var configuredTag = rule.Tags.FirstOrDefault();
        var tagName = configuredTag?.Tag;
        if (string.IsNullOrWhiteSpace(tagName))
        {
            var suffix = ToSnakeCase(valueField).Replace('_', '.');
            tagName = $"cmdb.{(string.IsNullOrWhiteSpace(suffix) ? "value" : suffix)}";
        }

        var rawValue = !string.IsNullOrWhiteSpace(configuredTag?.Value)
            ? configuredTag.Value
            : !string.IsNullOrWhiteSpace(configuredTag?.ValueTemplate)
                ? templateRenderer.RenderSimple(configuredTag.ValueTemplate, model)
                : ReadField(source, valueField);

        return SplitDynamicLeafValues(rawValue)
            .Select(value => new TagDefinition
            {
                Tag = tagName,
                Value = value,
                AllowMultipleValues = true
            })
            .ToArray();
    }

    private static ProxyDefinition[] ResolveProxies(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.Proxies.Length > 0)
        {
            return rule.Proxies;
        }

        if (HasProxy(rule.Proxy))
        {
            return [rule.Proxy];
        }

        return string.Equals(rule.ProxyRef, "defaults.proxy", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.ProxiesRef, "defaults.proxy", StringComparison.OrdinalIgnoreCase)
                ? HasProxy(rules.Defaults.Proxy) ? [rules.Defaults.Proxy] : []
                : [];
    }

    private static ProxyGroupDefinition[] ResolveProxyGroups(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.ProxyGroups.Length > 0)
        {
            return rule.ProxyGroups;
        }

        if (HasProxyGroup(rule.ProxyGroup))
        {
            return [rule.ProxyGroup];
        }

        return string.Equals(rule.ProxyGroupRef, "defaults.proxyGroup", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.ProxyGroupsRef, "defaults.proxyGroup", StringComparison.OrdinalIgnoreCase)
                ? HasProxyGroup(rules.Defaults.ProxyGroup) ? [rules.Defaults.ProxyGroup] : []
                : [];
    }

    private static HostMacroDefinition[] ResolveHostMacros(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.HostMacros.Length > 0)
        {
            return rule.HostMacros;
        }

        if (HasHostMacro(rule.HostMacro))
        {
            return [rule.HostMacro];
        }

        return string.Equals(rule.HostMacrosRef, "defaults.hostMacros", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.HostMacroRef, "defaults.hostMacros", StringComparison.OrdinalIgnoreCase)
                ? rules.Defaults.HostMacros
                : [];
    }

    private static InventoryFieldDefinition[] ResolveInventoryFields(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.InventoryFields.Length > 0)
        {
            return rule.InventoryFields;
        }

        if (HasInventoryField(rule.InventoryField))
        {
            return [rule.InventoryField];
        }

        return string.Equals(rule.InventoryFieldsRef, "defaults.inventoryFields", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.InventoryFieldRef, "defaults.inventoryFields", StringComparison.OrdinalIgnoreCase)
                ? rules.Defaults.InventoryFields
                : [];
    }

    private static HostStatusDefinition[] ResolveHostStatuses(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.HostStatus.Status.HasValue)
        {
            return [rule.HostStatus];
        }

        return string.Equals(rule.HostStatusRef, "defaults.hostStatus", StringComparison.OrdinalIgnoreCase)
            && rules.Defaults.HostStatus.Status.HasValue
                ? [rules.Defaults.HostStatus]
                : [];
    }

    private static TlsPskDefinition[] ResolveTlsPsk(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (HasTlsPsk(rule.TlsPsk))
        {
            return [rule.TlsPsk];
        }

        if (HasTlsPsk(rule.TlsPskMode))
        {
            return [rule.TlsPskMode];
        }

        return (string.Equals(rule.TlsPskRef, "defaults.tlsPsk", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.TlsPskModeRef, "defaults.tlsPsk", StringComparison.OrdinalIgnoreCase))
            && HasTlsPsk(rules.Defaults.TlsPsk)
                ? [rules.Defaults.TlsPsk]
                : [];
    }

    private static MaintenanceDefinition[] ResolveMaintenances(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.Maintenances.Length > 0)
        {
            return rule.Maintenances;
        }

        if (HasMaintenance(rule.Maintenance))
        {
            return [rule.Maintenance];
        }

        return string.Equals(rule.MaintenancesRef, "defaults.maintenances", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.MaintenanceRef, "defaults.maintenances", StringComparison.OrdinalIgnoreCase)
                ? rules.Defaults.Maintenances
                : [];
    }

    private static ValueMapDefinition[] ResolveValueMaps(SelectionRule rule, ConversionRulesDocument rules)
    {
        if (rule.ValueMaps.Length > 0)
        {
            return rule.ValueMaps;
        }

        if (HasValueMap(rule.ValueMap))
        {
            return [rule.ValueMap];
        }

        return string.Equals(rule.ValueMapsRef, "defaults.valueMaps", StringComparison.OrdinalIgnoreCase)
            || string.Equals(rule.ValueMapRef, "defaults.valueMaps", StringComparison.OrdinalIgnoreCase)
                ? rules.Defaults.ValueMaps
                : [];
    }

    private static bool HasProxy(ProxyDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.ProxyId) || !string.IsNullOrWhiteSpace(item.Name);
    }

    private static bool HasProxyGroup(ProxyGroupDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.ProxyGroupId) || !string.IsNullOrWhiteSpace(item.Name);
    }

    private static bool HasHostMacro(HostMacroDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.Macro);
    }

    private static bool HasInventoryField(InventoryFieldDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.Field) || !string.IsNullOrWhiteSpace(item.Name);
    }

    private static bool HasTlsPsk(TlsPskDefinition item)
    {
        return item.TlsConnect.HasValue
            || item.TlsAccept.HasValue
            || !string.IsNullOrWhiteSpace(item.TlsPskIdentity)
            || !string.IsNullOrWhiteSpace(item.TlsPsk);
    }

    private static bool HasMaintenance(MaintenanceDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.MaintenanceId) || !string.IsNullOrWhiteSpace(item.Name);
    }

    private static bool HasValueMap(ValueMapDefinition item)
    {
        return !string.IsNullOrWhiteSpace(item.ValueMapId) || !string.IsNullOrWhiteSpace(item.Name);
    }

    private static ZabbixInterfaceModel MapInterface(
        InterfaceSettings settings,
        InterfaceAddressSelection? address,
        CmdbSourceEvent source)
    {
        var useDns = string.Equals(address?.Mode, "dns", StringComparison.OrdinalIgnoreCase);
        var ip = useDns
            ? string.Empty
            : address?.Value ?? source.IpAddress ?? string.Empty;
        var dns = useDns
            ? address?.Value ?? source.DnsName ?? settings.Dns
            : settings.Dns;
        return new ZabbixInterfaceModel
        {
            Type = settings.Type,
            Main = settings.Main,
            UseIp = address is null ? settings.UseIp : useDns ? 0 : 1,
            Ip = ip,
            Dns = dns,
            Port = settings.Port,
            Details = MapInterfaceDetails(settings.Details)
        };
    }

    private static ZabbixInterfaceDetailsModel MapInterfaceDetails(InterfaceDetailsSettings settings)
    {
        return new ZabbixInterfaceDetailsModel
        {
            Version = settings.Version,
            Bulk = settings.Bulk,
            Community = settings.Community
        };
    }

    private static ZabbixTlsPskModel MapTlsPsk(TlsPskDefinition? settings)
    {
        return settings is null
            ? new ZabbixTlsPskModel()
            : new ZabbixTlsPskModel
            {
                TlsConnect = settings.TlsConnect,
                TlsAccept = settings.TlsAccept,
                TlsPskIdentity = settings.TlsPskIdentity,
                TlsPsk = settings.TlsPsk
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
        var knownTemplate = templateName.ToLowerInvariant() switch
        {
            "hostcreatejsonrpcrequestlines" => rules.T4Templates.HostCreateJsonRpcRequestLines,
            "hostupdatejsonrpcrequestlines" => rules.T4Templates.HostUpdateJsonRpcRequestLines,
            "hostdeletejsonrpcrequestlines" => rules.T4Templates.HostDeleteJsonRpcRequestLines,
            "hostgetbyhostjsonrpcrequestlines" => rules.T4Templates.HostGetByHostJsonRpcRequestLines,
            _ => []
        };
        if (knownTemplate.Length > 0)
        {
            return knownTemplate;
        }

        if (rules.T4Templates.AdditionalTemplates.TryGetValue(templateName, out var value)
            && value is JsonElement element
            && element.ValueKind == JsonValueKind.Array)
        {
            return element.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString() ?? string.Empty)
                .ToArray();
        }

        throw new InvalidOperationException($"Unsupported T4 template name '{templateName}'.");
    }
}

internal sealed record InterfaceAddressSelection(string Mode, string Value);
