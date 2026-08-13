namespace CmdbKafka2Zabbix.Rules;

public sealed record IgnoredProfileScopedRule(string Collection, int Index, string Reason, string? ProfileName = null);

public static class ProfileScopedRulePolicy
{
    private static readonly (string Collection, Func<ConversionRulesDocument, IEnumerable<SelectionRule>> Select)[] Collections =
    [
        ("groupSelectionRules", rules => rules.GroupSelectionRules),
        ("templateSelectionRules", rules => rules.TemplateSelectionRules),
        ("interfaceSelectionRules", rules => rules.InterfaceSelectionRules),
        ("tagSelectionRules", rules => rules.TagSelectionRules),
        ("proxySelectionRules", rules => rules.ProxySelectionRules),
        ("proxyGroupSelectionRules", rules => rules.ProxyGroupSelectionRules),
        ("hostMacroSelectionRules", rules => rules.HostMacroSelectionRules),
        ("inventorySelectionRules", rules => rules.InventorySelectionRules),
        ("interfaceProfileSelectionRules", rules => rules.InterfaceProfileSelectionRules),
        ("hostStatusSelectionRules", rules => rules.HostStatusSelectionRules),
        ("maintenanceSelectionRules", rules => rules.MaintenanceSelectionRules),
        ("tlsPskSelectionRules", rules => rules.TlsPskSelectionRules),
        ("valueMapSelectionRules", rules => rules.ValueMapSelectionRules)
    ];

    public static bool MatchesProfile(SelectionRule rule, ConversionRulesDocument rules, string? profileName)
    {
        return !string.IsNullOrWhiteSpace(profileName)
            && TryGetKnownProfileName(rule, rules, out var configuredProfileName, out _)
            && string.Equals(configuredProfileName, profileName, StringComparison.OrdinalIgnoreCase);
    }

    public static bool TryGetKnownProfileName(
        SelectionRule rule,
        ConversionRulesDocument rules,
        out string profileName,
        out string reason)
    {
        profileName = RequiredHostProfileName(rule);
        if (string.IsNullOrWhiteSpace(profileName))
        {
            reason = "host_profile_required";
            return false;
        }

        var requiredProfileName = profileName;
        if (!rules.HostProfiles.Any(profile =>
                string.Equals(profile.Name, requiredProfileName, StringComparison.OrdinalIgnoreCase)))
        {
            reason = "host_profile_unknown";
            return false;
        }

        reason = string.Empty;
        return true;
    }

    public static string RequiredHostProfileName(SelectionRule rule)
    {
        if (!string.Equals(rule.When.Expression.Operator, "all", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        var values = new List<string>();
        CollectRequiredHostProfileValues(rule.When.Expression, values);
        var unique = values
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return unique.Length == 1 ? unique[0] : string.Empty;
    }

    public static IReadOnlyList<IgnoredProfileScopedRule> FindIgnoredRules(ConversionRulesDocument rules)
    {
        var result = new List<IgnoredProfileScopedRule>();
        foreach (var (collection, select) in Collections)
        {
            var index = 0;
            foreach (var rule in select(rules))
            {
                if (!TryGetKnownProfileName(rule, rules, out var profileName, out var reason))
                {
                    result.Add(new IgnoredProfileScopedRule(
                        collection,
                        index,
                        reason,
                        string.Equals(reason, "host_profile_unknown", StringComparison.Ordinal) ? profileName : null));
                }
                index++;
            }
        }

        return result;
    }

    private static void CollectRequiredHostProfileValues(ConditionExpression expression, List<string> values)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation == "all")
        {
            foreach (var item in expression.Items)
            {
                CollectRequiredHostProfileValues(item, values);
            }
            return;
        }

        if (operation == "equals"
            && SameField(expression.Field, "hostProfile")
            && !string.IsNullOrWhiteSpace(expression.Value))
        {
            values.Add(expression.Value);
        }
    }

    private static bool SameField(string left, string right)
    {
        return string.Equals(left.Replace("_", string.Empty, StringComparison.Ordinal),
            right.Replace("_", string.Empty, StringComparison.Ordinal),
            StringComparison.OrdinalIgnoreCase);
    }
}
