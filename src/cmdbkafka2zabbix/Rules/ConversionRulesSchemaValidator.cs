using System.Text.Json;

namespace CmdbKafka2Zabbix.Rules;

public static class ConversionRulesSchemaValidator
{
    private static readonly string[] LegacyConditionProperties =
    [
        "allRegex",
        "anyRegex",
        "fieldExists",
        "fieldsExist",
        "fallback"
    ];

    private static readonly string[] ProfileScopedRuleCollections =
    [
        "groupSelectionRules",
        "templateSelectionRules",
        "interfaceSelectionRules",
        "tagSelectionRules",
        "proxySelectionRules",
        "proxyGroupSelectionRules",
        "hostMacroSelectionRules",
        "inventorySelectionRules",
        "interfaceProfileSelectionRules",
        "hostStatusSelectionRules",
        "maintenanceSelectionRules",
        "tlsPskSelectionRules",
        "valueMapSelectionRules"
    ];

    public static IReadOnlyList<string> Validate(string json, ConversionRulesDocument rules)
    {
        var errors = new List<string>();
        using var document = JsonDocument.Parse(json);
        RejectLegacyProperties(document.RootElement, "$", errors);
        ValidateConditionRules(rules, errors);
        return errors;
    }

    private static void RejectLegacyProperties(JsonElement element, string path, List<string> errors)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                var propertyPath = $"{path}.{property.Name}";
                if (LegacyConditionProperties.Contains(property.Name, StringComparer.OrdinalIgnoreCase))
                {
                    errors.Add($"{propertyPath} is not supported; use when.expression.");
                }

                if (string.Equals(path, "$.defaults", StringComparison.Ordinal)
                    && string.Equals(property.Name, "templates", StringComparison.OrdinalIgnoreCase))
                {
                    errors.Add("$.defaults.templates is not supported; declare every monitoring template in templateSelectionRules.");
                }

                if (property.Value.ValueKind == JsonValueKind.String
                    && string.Equals(property.Name, "templatesRef", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(property.Value.GetString(), "defaults.templates", StringComparison.OrdinalIgnoreCase))
                {
                    errors.Add($"{propertyPath} is not supported; declare every monitoring template in templateSelectionRules.");
                }

                RejectLegacyProperties(property.Value, propertyPath, errors);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var item in element.EnumerateArray())
            {
                RejectLegacyProperties(item, $"{path}[{index}]", errors);
                index++;
            }
        }
    }

    private static void ValidateConditionRules(ConversionRulesDocument rules, List<string> errors)
    {
        ValidateConditions(rules.MonitoringSuppressionRules, "monitoringSuppressionRules", rule => rule.When, errors);
        ValidateConditions(rules.HostProfiles, "hostProfiles", rule => rule.When, errors);
        foreach (var profile in rules.HostProfiles)
        {
            ValidateConditions(profile.Interfaces, $"hostProfiles[{profile.Name}].interfaces", rule => rule.When, errors);
        }

        ValidateConditions(rules.GroupSelectionRules, "groupSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.TemplateSelectionRules, "templateSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.InterfaceSelectionRules, "interfaceSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.InterfaceAddressRules, "interfaceAddressRules", rule => rule.When, errors);
        ValidateConditions(rules.TagSelectionRules, "tagSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.ProxySelectionRules, "proxySelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.ProxyGroupSelectionRules, "proxyGroupSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.HostMacroSelectionRules, "hostMacroSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.InventorySelectionRules, "inventorySelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.InterfaceProfileSelectionRules, "interfaceProfileSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.HostStatusSelectionRules, "hostStatusSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.MaintenanceSelectionRules, "maintenanceSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.TlsPskSelectionRules, "tlsPskSelectionRules", rule => rule.When, errors);
        ValidateConditions(rules.ValueMapSelectionRules, "valueMapSelectionRules", rule => rule.When, errors);
        ValidateProfileScopedRules(rules, errors);
    }

    private static void ValidateConditions<TRule>(
        IEnumerable<TRule> rules,
        string collection,
        Func<TRule, RuleCondition> condition,
        List<string> errors)
    {
        var index = 0;
        foreach (var rule in rules)
        {
            ValidateExpression(condition(rule).Expression, $"{collection}[{index}].when.expression", errors);
            index++;
        }
    }

    private static void ValidateProfileScopedRules(ConversionRulesDocument rules, List<string> errors)
    {
        ValidateProfileScopedRules(rules.GroupSelectionRules, ProfileScopedRuleCollections[0], rules, errors);
        ValidateProfileScopedRules(rules.TemplateSelectionRules, ProfileScopedRuleCollections[1], rules, errors);
        ValidateProfileScopedRules(rules.InterfaceSelectionRules, ProfileScopedRuleCollections[2], rules, errors);
        ValidateProfileScopedRules(rules.TagSelectionRules, ProfileScopedRuleCollections[3], rules, errors);
        ValidateProfileScopedRules(rules.ProxySelectionRules, ProfileScopedRuleCollections[4], rules, errors);
        ValidateProfileScopedRules(rules.ProxyGroupSelectionRules, ProfileScopedRuleCollections[5], rules, errors);
        ValidateProfileScopedRules(rules.HostMacroSelectionRules, ProfileScopedRuleCollections[6], rules, errors);
        ValidateProfileScopedRules(rules.InventorySelectionRules, ProfileScopedRuleCollections[7], rules, errors);
        ValidateProfileScopedRules(rules.InterfaceProfileSelectionRules, ProfileScopedRuleCollections[8], rules, errors);
        ValidateProfileScopedRules(rules.HostStatusSelectionRules, ProfileScopedRuleCollections[9], rules, errors);
        ValidateProfileScopedRules(rules.MaintenanceSelectionRules, ProfileScopedRuleCollections[10], rules, errors);
        ValidateProfileScopedRules(rules.TlsPskSelectionRules, ProfileScopedRuleCollections[11], rules, errors);
        ValidateProfileScopedRules(rules.ValueMapSelectionRules, ProfileScopedRuleCollections[12], rules, errors);
    }

    private static void ValidateProfileScopedRules(
        IEnumerable<SelectionRule> selectionRules,
        string collection,
        ConversionRulesDocument rules,
        List<string> errors)
    {
        var index = 0;
        foreach (var rule in selectionRules)
        {
            ValidateProfileScopedRule(rule, $"{collection}[{index}]", rules, errors);
            index++;
        }
    }

    private static void ValidateProfileScopedRule(
        SelectionRule rule,
        string path,
        ConversionRulesDocument rules,
        List<string> errors)
    {
        if (!ProfileScopedRulePolicy.TryGetKnownProfileName(rule, rules, out var profileName, out _))
        {
            return;
        }
        var fields = CollectConditionFields(rule.When.Expression).ToArray();

        foreach (var field in fields.Where(field => SameField(field, "className") || SameField(field, "outputProfile")))
        {
            errors.Add($"{path} cannot use '{field}' when scoped to hostProfile; derive the class from the profile.");
        }

        var profile = rules.HostProfiles.First(item => string.Equals(item.Name, profileName, StringComparison.OrdinalIgnoreCase));

        var profileClasses = CollectRequiredClassValues(profile.When.Expression)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (profileClasses.Length != 1)
        {
            errors.Add($"{path}.when.expression cannot derive exactly one CMDBuild class from hostProfile '{profile.Name}'.");
            return;
        }

        foreach (var field in fields.Append(rule.ValueField).Where(field => !string.IsNullOrWhiteSpace(field)))
        {
            if (SameField(field, "eventType") || SameField(field, "hostProfile"))
            {
                continue;
            }
            if (SameField(field, "className") || SameField(field, "outputProfile"))
            {
                continue;
            }

            var sourceField = rules.Source.Fields.FirstOrDefault(item => SameField(item.Key, field)).Value;
            var sourceClass = CmdbPathClassName(sourceField?.CmdbPath);
            if (!string.IsNullOrWhiteSpace(sourceClass)
                && !string.Equals(sourceClass, profileClasses[0], StringComparison.OrdinalIgnoreCase))
            {
                errors.Add($"{path} field '{field}' belongs to CMDBuild class '{sourceClass}', not hostProfile '{profile.Name}' class '{profileClasses[0]}'.");
            }
        }
    }

    private static IEnumerable<string> CollectConditionFields(ConditionExpression expression)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation is "all" or "any" or "not")
        {
            return expression.Items.SelectMany(CollectConditionFields);
        }

        return operation == "always" || string.IsNullOrWhiteSpace(expression.Field)
            ? []
            : [expression.Field];
    }

    private static IEnumerable<string> CollectRequiredEqualsValues(ConditionExpression expression, string fieldName)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation == "all")
        {
            return expression.Items.SelectMany(item => CollectRequiredEqualsValues(item, fieldName));
        }

        return operation == "equals"
            && SameField(expression.Field, fieldName)
            && !string.IsNullOrWhiteSpace(expression.Value)
            ? [expression.Value]
            : [];
    }

    private static IEnumerable<string> CollectRequiredProfileValues(ConditionExpression expression, string fieldName)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation == "all")
        {
            return expression.Items.SelectMany(item => CollectRequiredProfileValues(item, fieldName));
        }
        if (!SameField(expression.Field, fieldName))
        {
            return [];
        }
        if (operation == "equals" && !string.IsNullOrWhiteSpace(expression.Value))
        {
            return [expression.Value];
        }
        if (operation == "regex" && TryGetRegexLiteral(expression.Pattern, out var value))
        {
            return [value];
        }

        return [];
    }

    private static IEnumerable<string> CollectRequiredClassValues(ConditionExpression expression)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation == "all")
        {
            return expression.Items.SelectMany(CollectRequiredClassValues);
        }

        if (!SameField(expression.Field, "className"))
        {
            return [];
        }
        if (operation == "equals" && !string.IsNullOrWhiteSpace(expression.Value))
        {
            return [expression.Value];
        }
        if (operation == "regex" && TryGetRegexLiteral(expression.Pattern, out var value))
        {
            return [value];
        }

        return [];
    }

    private static bool TryGetRegexLiteral(string pattern, out string value)
    {
        value = pattern.Replace("(?i)", string.Empty, StringComparison.Ordinal).Trim();
        if (value.StartsWith('^') && value.EndsWith('$'))
        {
            value = value[1..^1];
        }
        if (string.IsNullOrWhiteSpace(value) || value.IndexOfAny(['[', ']', '(', ')', '{', '}', '|', '*', '+', '?']) >= 0)
        {
            value = string.Empty;
            return false;
        }

        value = value.Replace("\\", string.Empty, StringComparison.Ordinal).Trim();
        return !string.IsNullOrWhiteSpace(value);
    }

    private static string CmdbPathClassName(string? cmdbPath)
    {
        return cmdbPath?.Split('.', 2)[0].Trim() ?? string.Empty;
    }

    private static bool SameField(string? left, string? right)
    {
        return string.Equals(
            new string((left ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()),
            new string((right ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()),
            StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateExpression(ConditionExpression expression, string path, List<string> errors)
    {
        var operation = expression.Operator.Trim().ToLowerInvariant();
        if (operation is "all" or "any")
        {
            if (expression.Items.Length == 0)
            {
                errors.Add($"{path}.items must contain at least one condition.");
            }

            for (var index = 0; index < expression.Items.Length; index++)
            {
                ValidateExpression(expression.Items[index], $"{path}.items[{index}]", errors);
            }

            return;
        }

        if (operation == "not")
        {
            if (expression.Items.Length != 1)
            {
                errors.Add($"{path}.items must contain exactly one condition for operator 'not'.");
            }

            for (var index = 0; index < expression.Items.Length; index++)
            {
                ValidateExpression(expression.Items[index], $"{path}.items[{index}]", errors);
            }

            return;
        }

        if (operation == "always")
        {
            return;
        }

        if (operation is not ("equals" or "notequals" or "regex" or "notregex" or "exists" or "empty"))
        {
            errors.Add($"{path}.operator '{expression.Operator}' is unsupported.");
            return;
        }

        if (string.IsNullOrWhiteSpace(expression.Field))
        {
            errors.Add($"{path}.field is required for operator '{expression.Operator}'.");
        }

        if (operation is "equals" or "notequals")
        {
            if (string.IsNullOrWhiteSpace(expression.Value))
            {
                errors.Add($"{path}.value is required for operator '{expression.Operator}'. Use 'empty' for blank values.");
            }
        }

        if (operation is "regex" or "notregex")
        {
            if (string.IsNullOrWhiteSpace(expression.Pattern))
            {
                errors.Add($"{path}.pattern is required for operator '{expression.Operator}'.");
            }
            else
            {
                try
                {
                    _ = new System.Text.RegularExpressions.Regex(expression.Pattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(500));
                }
                catch (ArgumentException ex)
                {
                    errors.Add($"{path}.pattern is invalid: {ex.Message}");
                }
            }
        }
    }
}
