using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using CmdbKafka2Zabbix.Configuration;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbSourceFieldResolver(
    HttpClient httpClient,
    IOptions<CmdbuildOptions> options,
    ILogger<CmdbSourceFieldResolver> logger)
{
    private readonly Dictionary<string, IReadOnlyDictionary<string, CmdbAttributeInfo>> attributeCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, IReadOnlyDictionary<string, string>> cardCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, IReadOnlyList<CmdbLookupValue>> lookupCache = new(StringComparer.OrdinalIgnoreCase);
    private bool missingConfigurationWarningLogged;

    public async Task<CmdbSourceEvent> ResolveAsync(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        CancellationToken cancellationToken)
    {
        var resolvedFields = new Dictionary<string, string>(source.SourceFields, StringComparer.OrdinalIgnoreCase);
        foreach (var (fieldName, fieldRule) in rules.Source.Fields)
        {
            if (!ShouldResolve(fieldRule))
            {
                continue;
            }

            var sourceValue = ReadSourceValue(fieldName, fieldRule, resolvedFields);
            if (string.IsNullOrWhiteSpace(sourceValue))
            {
                continue;
            }

            try
            {
                var resolvedValue = await ResolveFieldAsync(source, fieldName, fieldRule, sourceValue, cancellationToken);
                if (!string.IsNullOrWhiteSpace(resolvedValue))
                {
                    resolvedFields[fieldName] = resolvedValue;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(
                    ex,
                    "Failed to resolve CMDBuild source field {FieldName} with path {CmdbPath}; keeping original value",
                    fieldName,
                    fieldRule.CmdbPath);
            }
        }

        return UpdateSourceFields(source, resolvedFields);
    }

    private static bool ShouldResolve(SourceFieldRule rule)
    {
        return !string.IsNullOrWhiteSpace(rule.CmdbPath)
            || !string.IsNullOrWhiteSpace(rule.Resolve.Mode)
            || string.Equals(rule.Type, "lookup", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<string?> ResolveFieldAsync(
        CmdbSourceEvent source,
        string fieldName,
        SourceFieldRule rule,
        string sourceValue,
        CancellationToken cancellationToken)
    {
        var mode = ResolveMode(rule);
        if (string.Equals(mode, "none", StringComparison.OrdinalIgnoreCase))
        {
            return sourceValue;
        }

        if (!options.Value.Enabled)
        {
            return null;
        }

        if (!options.Value.CanResolve)
        {
            if (!missingConfigurationWarningLogged)
            {
                missingConfigurationWarningLogged = true;
                logger.LogWarning(
                    "CMDBuild field resolution is configured, but Cmdbuild:BaseUrl/Username/Password are not set; lookup/reference path values will stay unresolved");
            }
            return null;
        }

        if (string.Equals(mode, "lookup", StringComparison.OrdinalIgnoreCase))
        {
            var lookupType = FirstNonEmpty(rule.Resolve.LookupType, rule.LookupType);
            if (string.IsNullOrWhiteSpace(lookupType) && !string.IsNullOrWhiteSpace(rule.CmdbPath))
            {
                lookupType = await ResolveLookupTypeFromPathAsync(source, rule.CmdbPath, cancellationToken);
            }

            return await ResolveLookupValueAsync(lookupType, sourceValue, ResolveValueMode(rule), cancellationToken);
        }

        if (string.Equals(mode, "cmdbPath", StringComparison.OrdinalIgnoreCase)
            || string.Equals(mode, "referenceLeaf", StringComparison.OrdinalIgnoreCase)
            || string.Equals(mode, "referenceLookupLeaf", StringComparison.OrdinalIgnoreCase))
        {
            return await ResolvePathAsync(source, rule, sourceValue, cancellationToken);
        }

        return sourceValue;
    }

    private static string ResolveMode(SourceFieldRule rule)
    {
        if (!string.IsNullOrWhiteSpace(rule.Resolve.Mode))
        {
            return rule.Resolve.Mode;
        }

        if (!string.IsNullOrWhiteSpace(rule.CmdbPath))
        {
            return "cmdbPath";
        }

        if (string.Equals(rule.Type, "lookup", StringComparison.OrdinalIgnoreCase))
        {
            return "lookup";
        }

        return "none";
    }

    private async Task<string?> ResolvePathAsync(
        CmdbSourceEvent source,
        SourceFieldRule rule,
        string sourceValue,
        CancellationToken cancellationToken)
    {
        var path = SplitPath(rule.CmdbPath);
        if (path.Length == 0)
        {
            return sourceValue;
        }

        var currentClass = FirstNonEmpty(source.ClassName, source.EntityType);
        var index = 0;
        if (!string.IsNullOrWhiteSpace(currentClass)
            && string.Equals(path[0], currentClass, StringComparison.OrdinalIgnoreCase))
        {
            index = 1;
        }
        else if (!string.IsNullOrWhiteSpace(path[0])
            && path.Length > 1
            && !await HasAttributeAsync(currentClass, path[0], cancellationToken))
        {
            currentClass = path[0];
            index = 1;
        }

        if (string.IsNullOrWhiteSpace(currentClass) || index >= path.Length)
        {
            return sourceValue;
        }

        var maxDepth = rule.Resolve.MaxDepth ?? options.Value.MaxPathDepth;
        var depth = 0;
        var currentValue = sourceValue;
        IReadOnlyDictionary<string, string>? currentCard = null;
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var i = index; i < path.Length; i++)
        {
            var attributeName = path[i];
            var attribute = await GetAttributeAsync(currentClass, attributeName, cancellationToken);
            if (attribute is null)
            {
                return currentValue;
            }

            if (string.Equals(attribute.Type, "reference", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(attribute.TargetClass) || string.IsNullOrWhiteSpace(currentValue))
                {
                    return null;
                }

                depth++;
                if (depth > maxDepth)
                {
                    throw new InvalidOperationException($"CMDBuild path '{rule.CmdbPath}' exceeds max depth {maxDepth}.");
                }

                var visitKey = $"{attribute.TargetClass}:{currentValue}";
                if (!visited.Add(visitKey))
                {
                    throw new InvalidOperationException($"CMDBuild path '{rule.CmdbPath}' contains a reference cycle at {visitKey}.");
                }

                currentClass = attribute.TargetClass;
                currentCard = await GetCardAsync(currentClass, currentValue, cancellationToken);
                if (i == path.Length - 1)
                {
                    return ReadCardValue(currentCard, "Code")
                        ?? ReadCardValue(currentCard, "Description")
                        ?? currentValue;
                }

                currentValue = ReadCardValue(currentCard, path[i + 1]) ?? string.Empty;
                continue;
            }

            if (string.Equals(attribute.Type, "lookup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rule.Resolve.LeafType, "lookup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rule.Type, "lookup", StringComparison.OrdinalIgnoreCase))
            {
                return await ResolveLookupValueAsync(
                    FirstNonEmpty(rule.Resolve.LookupType, rule.LookupType, attribute.LookupType),
                    currentValue,
                    ResolveValueMode(rule),
                    cancellationToken,
                    currentCard,
                    attribute.Name);
            }

            return currentValue;
        }

        return currentValue;
    }

    private async Task<string> ResolveLookupTypeFromPathAsync(
        CmdbSourceEvent source,
        string cmdbPath,
        CancellationToken cancellationToken)
    {
        var path = SplitPath(cmdbPath);
        if (path.Length == 0)
        {
            return string.Empty;
        }

        var currentClass = FirstNonEmpty(source.ClassName, source.EntityType);
        var index = string.Equals(path[0], currentClass, StringComparison.OrdinalIgnoreCase) ? 1 : 0;
        for (var i = index; i < path.Length; i++)
        {
            var attribute = await GetAttributeAsync(currentClass, path[i], cancellationToken);
            if (attribute is null)
            {
                return string.Empty;
            }

            if (string.Equals(attribute.Type, "lookup", StringComparison.OrdinalIgnoreCase))
            {
                return attribute.LookupType;
            }

            if (string.Equals(attribute.Type, "reference", StringComparison.OrdinalIgnoreCase))
            {
                currentClass = attribute.TargetClass;
            }
        }

        return string.Empty;
    }

    private async Task<string?> ResolveLookupValueAsync(
        string lookupType,
        string rawValue,
        string valueMode,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, string>? card = null,
        string attributeName = "")
    {
        if (card is not null && !string.IsNullOrWhiteSpace(attributeName))
        {
            var companion = valueMode.ToLowerInvariant() switch
            {
                "id" => ReadCardValue(card, attributeName),
                "description" => ReadCardValue(card, $"_{attributeName}_description"),
                "translation" => ReadCardValue(card, $"_{attributeName}_description_translation"),
                _ => ReadCardValue(card, $"_{attributeName}_code")
            };
            if (!string.IsNullOrWhiteSpace(companion))
            {
                return companion;
            }
        }

        if (string.IsNullOrWhiteSpace(lookupType))
        {
            return rawValue;
        }

        var values = await GetLookupValuesAsync(lookupType, cancellationToken);
        var match = values.FirstOrDefault(item => item.Matches(rawValue));
        if (match is null)
        {
            return rawValue;
        }

        return valueMode.ToLowerInvariant() switch
        {
            "id" => match.Id,
            "description" => FirstNonEmpty(match.Description, match.Code, match.Id),
            "translation" => FirstNonEmpty(match.DescriptionTranslation, match.Description, match.Code, match.Id),
            _ => FirstNonEmpty(match.Code, match.Description, match.Id)
        };
    }

    private async Task<bool> HasAttributeAsync(string? className, string attributeName, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(className))
        {
            return false;
        }

        var attributes = await GetAttributesAsync(className, cancellationToken);
        return attributes.ContainsKey(attributeName);
    }

    private async Task<CmdbAttributeInfo?> GetAttributeAsync(
        string? className,
        string attributeName,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(className))
        {
            return null;
        }

        var attributes = await GetAttributesAsync(className, cancellationToken);
        return attributes.TryGetValue(attributeName, out var attribute) ? attribute : null;
    }

    private async Task<IReadOnlyDictionary<string, CmdbAttributeInfo>> GetAttributesAsync(
        string className,
        CancellationToken cancellationToken)
    {
        if (attributeCache.TryGetValue(className, out var cached))
        {
            return cached;
        }

        using var document = await GetJsonAsync($"/classes/{Uri.EscapeDataString(className)}/attributes", cancellationToken);
        var attributes = new Dictionary<string, CmdbAttributeInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in ReadDataArray(document.RootElement))
        {
            var name = ReadString(item, "name") ?? ReadString(item, "_id");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            attributes[name] = new CmdbAttributeInfo(
                Name: name,
                Type: ReadString(item, "type") ?? string.Empty,
                TargetClass: ReadString(item, "targetClass") ?? string.Empty,
                LookupType: ReadString(item, "lookupType") ?? string.Empty);
        }

        attributeCache[className] = attributes;
        return attributes;
    }

    private async Task<IReadOnlyDictionary<string, string>> GetCardAsync(
        string className,
        string cardId,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"{className}:{cardId}";
        if (cardCache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        using var document = await GetJsonAsync(
            $"/classes/{Uri.EscapeDataString(className)}/cards/{Uri.EscapeDataString(cardId)}",
            cancellationToken);
        var data = ReadDataObject(document.RootElement);
        cardCache[cacheKey] = data;
        return data;
    }

    private async Task<IReadOnlyList<CmdbLookupValue>> GetLookupValuesAsync(
        string lookupType,
        CancellationToken cancellationToken)
    {
        if (lookupCache.TryGetValue(lookupType, out var cached))
        {
            return cached;
        }

        using var document = await GetJsonAsync($"/lookup_types/{Uri.EscapeDataString(lookupType)}/values", cancellationToken);
        var values = ReadDataArray(document.RootElement)
            .Select(item => new CmdbLookupValue(
                Id: ReadString(item, "_id") ?? string.Empty,
                Code: ReadString(item, "code") ?? string.Empty,
                Description: ReadString(item, "description") ?? string.Empty,
                DescriptionTranslation: ReadString(item, "_description_translation") ?? string.Empty))
            .Where(item => !string.IsNullOrWhiteSpace(item.Id)
                || !string.IsNullOrWhiteSpace(item.Code)
                || !string.IsNullOrWhiteSpace(item.Description))
            .ToArray();
        lookupCache[lookupType] = values;
        return values;
    }

    private async Task<JsonDocument> GetJsonAsync(string path, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(options.Value.RequestTimeoutMs));

        using var request = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl()}{path}");
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.Value.Username}:{options.Value.Password}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await httpClient.SendAsync(request, timeout.Token);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        return await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
    }

    private string BaseUrl()
    {
        return options.Value.BaseUrl.TrimEnd('/');
    }

    private static JsonElement[] ReadDataArray(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Array)
        {
            return data.EnumerateArray().Select(item => item.Clone()).ToArray();
        }

        return [];
    }

    private static IReadOnlyDictionary<string, string> ReadDataObject(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Object)
        {
            return data.EnumerateObject()
                .Select(property => new KeyValuePair<string, string?>(property.Name, ReadScalar(property.Value)))
                .Where(item => !string.IsNullOrWhiteSpace(item.Value))
                .ToDictionary(item => item.Key, item => item.Value!, StringComparer.OrdinalIgnoreCase);
        }

        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    private static string? ReadCardValue(IReadOnlyDictionary<string, string> card, string attributeName)
    {
        return card.TryGetValue(attributeName, out var value) ? value : null;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (element.TryGetProperty(propertyName, out var property))
        {
            return ReadScalar(property);
        }

        foreach (var item in element.EnumerateObject())
        {
            if (string.Equals(item.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                return ReadScalar(item.Value);
            }
        }

        return null;
    }

    private static string? ReadScalar(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => bool.TrueString,
            JsonValueKind.False => bool.FalseString,
            JsonValueKind.Object => ReadString(value, "_id")
                ?? ReadString(value, "id")
                ?? ReadString(value, "name")
                ?? ReadString(value, "value")
                ?? ReadString(value, "code")
                ?? ReadString(value, "description"),
            _ => null
        };
    }

    private static string[] SplitPath(string path)
    {
        return path
            .Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(segment => !string.IsNullOrWhiteSpace(segment))
            .ToArray();
    }

    private static string ResolveValueMode(SourceFieldRule rule)
    {
        return FirstNonEmpty(rule.Resolve.ValueMode, "code");
    }

    private static string? ReadSourceValue(
        string fieldName,
        SourceFieldRule fieldRule,
        IReadOnlyDictionary<string, string> sourceFields)
    {
        if (!string.IsNullOrWhiteSpace(fieldRule.Resolve.SourceField)
            && sourceFields.TryGetValue(fieldRule.Resolve.SourceField, out var sourceFieldValue))
        {
            return sourceFieldValue;
        }

        return sourceFields.TryGetValue(fieldName, out var value) ? value : null;
    }

    private static CmdbSourceEvent UpdateSourceFields(
        CmdbSourceEvent source,
        IReadOnlyDictionary<string, string> resolvedFields)
    {
        string? Read(string fieldName)
        {
            return resolvedFields.TryGetValue(fieldName, out var value) ? value : null;
        }

        return source with
        {
            SourceFields = resolvedFields,
            EntityId = Read("entityId") ?? source.EntityId,
            Code = Read("code") ?? source.Code,
            ClassName = Read("className") ?? source.ClassName,
            IpAddress = Read("ipAddress") ?? source.IpAddress,
            DnsName = Read("dnsName") ?? source.DnsName,
            ZabbixHostId = Read("zabbixHostId") ?? source.ZabbixHostId,
            Description = Read("description") ?? source.Description,
            OperatingSystem = Read("os") ?? source.OperatingSystem,
            ZabbixTag = Read("zabbixTag") ?? source.ZabbixTag
        };
    }

    private static string FirstNonEmpty(params string?[] values)
    {
        return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;
    }

    private sealed record CmdbAttributeInfo(
        string Name,
        string Type,
        string TargetClass,
        string LookupType);

    private sealed record CmdbLookupValue(
        string Id,
        string Code,
        string Description,
        string DescriptionTranslation)
    {
        public bool Matches(string value)
        {
            return string.Equals(Id, value, StringComparison.OrdinalIgnoreCase)
                || string.Equals(Code, value, StringComparison.OrdinalIgnoreCase)
                || string.Equals(Description, value, StringComparison.OrdinalIgnoreCase)
                || string.Equals(DescriptionTranslation, value, StringComparison.OrdinalIgnoreCase);
        }
    }
}
