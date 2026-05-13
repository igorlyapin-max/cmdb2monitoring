using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Cmdb2Monitoring.Logging;
using CmdbKafka2Zabbix.Configuration;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class CmdbSourceFieldResolver(
    HttpClient httpClient,
    IOptions<CmdbuildOptions> options,
    IOptions<ExtendedDebugLoggingOptions> debugLoggingOptions,
    ILogger<CmdbSourceFieldResolver> logger)
{
    private readonly Dictionary<string, IReadOnlyDictionary<string, CmdbAttributeInfo>> attributeCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly AsyncLocal<RuntimeResolveCache?> runtimeCache = new();
    private bool missingConfigurationWarningLogged;

    public async Task<CmdbSourceEvent> ResolveAsync(
        CmdbSourceEvent source,
        ConversionRulesDocument rules,
        CancellationToken cancellationToken)
    {
        var previousCache = runtimeCache.Value;
        runtimeCache.Value = new RuntimeResolveCache();
        try
        {
            var resolvedFields = new Dictionary<string, string>(source.SourceFields, StringComparer.OrdinalIgnoreCase);
            foreach (var (fieldName, fieldRule) in rules.Source.Fields)
            {
                if (!ShouldResolve(fieldRule))
                {
                    continue;
                }

                if (!CmdbPathAppliesToSource(source, fieldName, fieldRule, resolvedFields))
                {
                    resolvedFields.Remove(fieldName);
                    logger.LogBasic(
                        debugLoggingOptions,
                        "Skipping CMDBuild source field {FieldName}: path {CmdbPath} does not apply to event class {ClassName}",
                        fieldName,
                        fieldRule.CmdbPath,
                        FirstNonEmpty(source.ClassName, source.EntityType, "<unknown>"));
                    continue;
                }

                var isDomainPath = IsDomainPath(fieldRule.CmdbPath);
                var sourceValue = ReadSourceValue(fieldName, fieldRule, resolvedFields);
                if (string.IsNullOrWhiteSpace(sourceValue) && isDomainPath)
                {
                    sourceValue = source.EntityId;
                }

                if (string.IsNullOrWhiteSpace(sourceValue))
                {
                    continue;
                }

                try
                {
                    logger.LogBasic(
                        debugLoggingOptions,
                        "Resolving CMDBuild field {FieldName} through path {CmdbPath} with source value {SourceValue}",
                        fieldName,
                        string.IsNullOrWhiteSpace(fieldRule.CmdbPath) ? "<lookup>" : fieldRule.CmdbPath,
                        sourceValue);
                    var resolvedValue = await ResolveFieldAsync(source, fieldName, fieldRule, sourceValue, cancellationToken);
                    if (!string.IsNullOrWhiteSpace(resolvedValue))
                    {
                        resolvedFields[fieldName] = resolvedValue;
                        logger.LogBasic(
                            debugLoggingOptions,
                            "Resolved CMDBuild field {FieldName}: {SourceValue} -> {ResolvedValue}",
                            fieldName,
                            sourceValue,
                            resolvedValue);
                    }
                    else if (isDomainPath)
                    {
                        resolvedFields.Remove(fieldName);
                        logger.LogBasic(
                            debugLoggingOptions,
                            "Dropped unresolved CMDBuild domain field {FieldName} for path {CmdbPath}",
                            fieldName,
                            fieldRule.CmdbPath);
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    if (isDomainPath)
                    {
                        resolvedFields.Remove(fieldName);
                    }

                    logger.LogWarning(
                        ex,
                        isDomainPath
                            ? "Failed to resolve CMDBuild source field {FieldName} with domain path {CmdbPath}; dropping unresolved relation id"
                            : "Failed to resolve CMDBuild source field {FieldName} with path {CmdbPath}; keeping original value",
                        fieldName,
                        fieldRule.CmdbPath);
                }
            }

            return UpdateSourceFields(source, resolvedFields);
        }
        finally
        {
            runtimeCache.Value = previousCache;
        }
    }

    private static bool ShouldResolve(SourceFieldRule rule)
    {
        return !string.IsNullOrWhiteSpace(rule.CmdbPath)
            || !string.IsNullOrWhiteSpace(rule.Resolve.Mode)
            || string.Equals(rule.Type, "lookup", StringComparison.OrdinalIgnoreCase);
    }

    private static bool CmdbPathAppliesToSource(
        CmdbSourceEvent source,
        string fieldName,
        SourceFieldRule fieldRule,
        IReadOnlyDictionary<string, string> sourceFields)
    {
        var path = SplitPath(fieldRule.CmdbPath);
        if (path.Length == 0)
        {
            return true;
        }

        var root = path[0];
        if (TryReadDomainSegment(root, out _))
        {
            return true;
        }

        var sourceClass = FirstNonEmpty(source.ClassName, source.EntityType);
        if (string.IsNullOrWhiteSpace(sourceClass) || string.Equals(root, sourceClass, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return SourceValueFieldCandidates(fieldName, fieldRule).Contains(root, StringComparer.OrdinalIgnoreCase)
            || sourceFields.ContainsKey(root);
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
                    "CMDBuild field resolution is configured, but Cmdbuild:BaseUrl/Username/Password are not set; lookup/reference/domain path values will stay unresolved");
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

        if (TryReadDomainSegment(path[index], out var domainTargetClass))
        {
            return await ResolveDomainPathAsync(
                source,
                rule,
                currentClass,
                FirstNonEmpty(source.EntityId, sourceValue),
                domainTargetClass,
                path[(index + 1)..],
                cancellationToken);
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

    private async Task<string?> ResolveDomainPathAsync(
        CmdbSourceEvent source,
        SourceFieldRule rule,
        string sourceClass,
        string sourceCardId,
        string targetClass,
        string[] targetPath,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(sourceClass) || string.IsNullOrWhiteSpace(sourceCardId))
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(source.ClassName)
            && !string.Equals(source.ClassName, sourceClass, StringComparison.OrdinalIgnoreCase))
        {
            logger.LogDebug(
                "Skipping CMDBuild domain path {CmdbPath}: source class {SourceClass} does not match event class {EventClass}",
                rule.CmdbPath,
                sourceClass,
                source.ClassName);
            return null;
        }

        var relatedCards = await GetRelatedCardsAsync(sourceClass, sourceCardId, targetClass, cancellationToken);
        logger.LogBasic(
            debugLoggingOptions,
            "Resolved CMDBuild domain path {CmdbPath}: found {RelatedCount} related card(s) from {SourceClass}/{SourceCardId} to {TargetClass}",
            rule.CmdbPath,
            relatedCards.Count,
            sourceClass,
            sourceCardId,
            targetClass);
        if (relatedCards.Count == 0)
        {
            return null;
        }

        var values = new List<string>();
        foreach (var relatedCard in relatedCards)
        {
            var value = await ResolveCardPathAsync(
                relatedCard.ClassName,
                relatedCard.CardId,
                targetPath,
                rule,
                cancellationToken);
            if (!string.IsNullOrWhiteSpace(value))
            {
                values.Add(value);
            }
        }

        return FormatCollectionValues(values, rule);
    }

    private async Task<string?> ResolveCardPathAsync(
        string className,
        string cardId,
        string[] path,
        SourceFieldRule rule,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(className) || string.IsNullOrWhiteSpace(cardId))
        {
            return null;
        }

        if (path.Length == 0)
        {
            var card = await GetCardAsync(className, cardId, cancellationToken);
            return ReadCardValue(card, "Code")
                ?? ReadCardValue(card, "Description")
                ?? cardId;
        }

        var maxDepth = rule.Resolve.MaxDepth ?? options.Value.MaxPathDepth;
        var depth = 0;
        var currentClass = className;
        var currentCardId = cardId;
        var currentCard = await GetCardAsync(currentClass, currentCardId, cancellationToken);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            $"{currentClass}:{currentCardId}"
        };

        for (var i = 0; i < path.Length; i++)
        {
            var attributeName = path[i];
            var attribute = await GetAttributeAsync(currentClass, attributeName, cancellationToken);
            if (attribute is null)
            {
                return ReadCardValue(currentCard, attributeName);
            }

            var attributeValue = ReadCardValue(currentCard, attribute.Name);
            if (string.Equals(attribute.Type, "reference", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(attribute.TargetClass) || string.IsNullOrWhiteSpace(attributeValue))
                {
                    return null;
                }

                depth++;
                if (depth > maxDepth)
                {
                    throw new InvalidOperationException($"CMDBuild path '{rule.CmdbPath}' exceeds max depth {maxDepth}.");
                }

                currentClass = attribute.TargetClass;
                currentCardId = attributeValue;
                var visitKey = $"{currentClass}:{currentCardId}";
                if (!visited.Add(visitKey))
                {
                    throw new InvalidOperationException($"CMDBuild path '{rule.CmdbPath}' contains a reference cycle at {visitKey}.");
                }

                currentCard = await GetCardAsync(currentClass, currentCardId, cancellationToken);
                if (i == path.Length - 1)
                {
                    return ReadCardValue(currentCard, "Code")
                        ?? ReadCardValue(currentCard, "Description")
                        ?? currentCardId;
                }

                continue;
            }

            if (string.Equals(attribute.Type, "lookup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rule.Resolve.LeafType, "lookup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rule.Type, "lookup", StringComparison.OrdinalIgnoreCase))
            {
                return await ResolveLookupValueAsync(
                    FirstNonEmpty(rule.Resolve.LookupType, rule.LookupType, attribute.LookupType),
                    attributeValue ?? string.Empty,
                    ResolveValueMode(rule),
                    cancellationToken,
                    currentCard,
                    attribute.Name);
            }

            return attributeValue;
        }

        return null;
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
        var cache = runtimeCache.Value;
        if (cache?.CardCache.TryGetValue(cacheKey, out var cached) == true)
        {
            return cached;
        }

        using var document = await GetJsonAsync(
            $"/classes/{Uri.EscapeDataString(className)}/cards/{Uri.EscapeDataString(cardId)}",
            cancellationToken);
        var data = ReadDataObject(document.RootElement);
        if (cache is not null)
        {
            cache.CardCache[cacheKey] = data;
        }
        return data;
    }

    private async Task<IReadOnlyList<CmdbLookupValue>> GetLookupValuesAsync(
        string lookupType,
        CancellationToken cancellationToken)
    {
        var cache = runtimeCache.Value;
        if (cache?.LookupCache.TryGetValue(lookupType, out var cached) == true)
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
        if (cache is not null)
        {
            cache.LookupCache[lookupType] = values;
        }
        return values;
    }

    private async Task<IReadOnlyList<CmdbRelationEndpoint>> GetRelatedCardsAsync(
        string sourceClass,
        string sourceCardId,
        string targetClass,
        CancellationToken cancellationToken)
    {
        using var document = await GetJsonAsync(
            $"/classes/{Uri.EscapeDataString(sourceClass)}/cards/{Uri.EscapeDataString(sourceCardId)}/relations",
            cancellationToken);
        return ReadDataArray(document.RootElement)
            .Select(item => ReadRelatedEndpoint(item, sourceClass, sourceCardId, targetClass))
            .Where(item => item is not null)
            .Select(item => item!)
            .GroupBy(item => $"{item.ClassName}:{item.CardId}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();
    }

    private static CmdbRelationEndpoint? ReadRelatedEndpoint(
        JsonElement relation,
        string sourceClass,
        string sourceCardId,
        string targetClass)
    {
        var sourceEndpoint = ReadRelationEndpoint(relation, "source");
        var destinationEndpoint = ReadRelationEndpoint(relation, "destination");

        if (IsSameEndpoint(sourceEndpoint, sourceClass, sourceCardId)
            && IsSameClass(destinationEndpoint.ClassName, targetClass)
            && !string.IsNullOrWhiteSpace(destinationEndpoint.CardId))
        {
            return destinationEndpoint;
        }

        if (IsSameEndpoint(destinationEndpoint, sourceClass, sourceCardId)
            && IsSameClass(sourceEndpoint.ClassName, targetClass)
            && !string.IsNullOrWhiteSpace(sourceEndpoint.CardId))
        {
            return sourceEndpoint;
        }

        if (IsSameClass(destinationEndpoint.ClassName, targetClass)
            && !IsSameClass(destinationEndpoint.ClassName, sourceClass)
            && !string.IsNullOrWhiteSpace(destinationEndpoint.CardId))
        {
            return destinationEndpoint;
        }

        if (IsSameClass(sourceEndpoint.ClassName, targetClass)
            && !IsSameClass(sourceEndpoint.ClassName, sourceClass)
            && !string.IsNullOrWhiteSpace(sourceEndpoint.CardId))
        {
            return sourceEndpoint;
        }

        return null;
    }

    private static CmdbRelationEndpoint ReadRelationEndpoint(JsonElement relation, string side)
    {
        var isSource = string.Equals(side, "source", StringComparison.OrdinalIgnoreCase);
        var shortPrefix = isSource ? "src" : "dst";
        var className = FirstNonEmpty(
            ReadString(relation, isSource ? "_sourceType" : "_destinationType"),
            ReadString(relation, isSource ? "sourceType" : "destinationType"),
            ReadString(relation, isSource ? "sourceClass" : "destinationClass"),
            ReadString(relation, isSource ? "_sourceClass" : "_destinationClass"),
            isSource ? null : ReadString(relation, "_targetType"),
            isSource ? null : ReadString(relation, "targetType"),
            isSource ? null : ReadString(relation, "targetClass"),
            isSource ? null : ReadString(relation, "_targetClass"),
            ReadString(relation, $"{shortPrefix}Type"),
            ReadString(relation, $"{shortPrefix}Class"),
            ReadNestedString(relation, isSource ? "_source" : "_destination", "_type", "type", "className", "class", "name", "_id"),
            ReadNestedString(relation, side, "_type", "type", "className", "class", "name", "_id"),
            isSource ? null : ReadNestedString(relation, "target", "_type", "type", "className", "class", "name", "_id"),
            isSource ? null : ReadNestedString(relation, "_target", "_type", "type", "className", "class", "name", "_id"),
            ReadNestedString(relation, shortPrefix, "_type", "type", "className", "class", "name", "_id"));
        var cardId = FirstNonEmpty(
            ReadString(relation, isSource ? "_sourceId" : "_destinationId"),
            ReadString(relation, isSource ? "sourceId" : "destinationId"),
            isSource ? null : ReadString(relation, "_targetId"),
            isSource ? null : ReadString(relation, "targetId"),
            ReadString(relation, $"{shortPrefix}Id"),
            ReadNestedString(relation, isSource ? "_source" : "_destination", "_id", "id", "cardId"),
            ReadNestedString(relation, side, "_id", "id", "cardId"),
            isSource ? null : ReadNestedString(relation, "target", "_id", "id", "cardId"),
            isSource ? null : ReadNestedString(relation, "_target", "_id", "id", "cardId"),
            ReadNestedString(relation, shortPrefix, "_id", "id", "cardId"));

        return new CmdbRelationEndpoint(className, cardId);
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
        logger.LogVerbose(
            debugLoggingOptions,
            "CMDBuild GET {Path} returned HTTP {StatusCode}",
            path,
            (int)response.StatusCode);
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

    private static string? ReadNestedString(JsonElement element, string propertyName, params string[] nestedPropertyNames)
    {
        if (element.ValueKind != JsonValueKind.Object || !TryGetPropertyIgnoreCase(element, propertyName, out var property))
        {
            return null;
        }

        if (property.ValueKind != JsonValueKind.Object)
        {
            return ReadScalar(property);
        }

        foreach (var nestedPropertyName in nestedPropertyNames)
        {
            var value = ReadString(property, nestedPropertyName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (TryGetPropertyIgnoreCase(element, propertyName, out var property))
        {
            return ReadScalar(property);
        }

        return null;
    }

    private static bool TryGetPropertyIgnoreCase(JsonElement element, string propertyName, out JsonElement property)
    {
        if (element.TryGetProperty(propertyName, out property))
        {
            return true;
        }

        foreach (var item in element.EnumerateObject())
        {
            if (string.Equals(item.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                property = item.Value;
                return true;
            }
        }

        return false;
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

    private static bool IsDomainPath(string path)
    {
        return SplitPath(path).Any(segment => TryReadDomainSegment(segment, out _));
    }

    private static bool TryReadDomainSegment(string segment, out string targetClass)
    {
        targetClass = string.Empty;
        var text = segment.Trim();
        if (!text.StartsWith("{domain:", StringComparison.OrdinalIgnoreCase) || !text.EndsWith('}'))
        {
            return false;
        }

        targetClass = text["{domain:".Length..^1].Trim();
        return !string.IsNullOrWhiteSpace(targetClass);
    }

    private static string? FormatCollectionValues(IReadOnlyList<string> values, SourceFieldRule rule)
    {
        var distinctValues = values
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (distinctValues.Length == 0)
        {
            return null;
        }

        if (distinctValues.Length == 1)
        {
            return distinctValues[0];
        }

        return rule.Resolve.CollectionMode.ToLowerInvariant() switch
        {
            "first" => distinctValues[0],
            "json" => JsonSerializer.Serialize(distinctValues),
            _ => string.Join(
                string.IsNullOrEmpty(rule.Resolve.CollectionSeparator) ? "; " : rule.Resolve.CollectionSeparator,
                distinctValues)
        };
    }

    private static bool IsSameEndpoint(CmdbRelationEndpoint endpoint, string className, string cardId)
    {
        return IsSameClass(endpoint.ClassName, className)
            && string.Equals(endpoint.CardId, cardId, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsSameClass(string left, string right)
    {
        return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
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

        foreach (var candidate in SourceValueFieldCandidates(fieldName, fieldRule))
        {
            if (sourceFields.TryGetValue(candidate, out var value))
            {
                return value;
            }
        }

        return null;
    }

    private static IEnumerable<string> SourceValueFieldCandidates(string fieldName, SourceFieldRule fieldRule)
    {
        var candidates = new[]
        {
            fieldName,
            fieldRule.Source,
            CanonicalSourceFieldName(fieldRule.Source)
        }.Concat(fieldRule.Sources.SelectMany(source => new[] { source, CanonicalSourceFieldName(source) }));

        return candidates
            .Where(candidate => !string.IsNullOrWhiteSpace(candidate))
            .Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static string CanonicalSourceFieldName(string? fieldName)
    {
        var value = fieldName ?? string.Empty;
        return value.Replace("_", string.Empty, StringComparison.Ordinal).ToLowerInvariant() switch
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
            _ => value
        };
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

    private sealed record CmdbRelationEndpoint(
        string ClassName,
        string CardId);

    private sealed class RuntimeResolveCache
    {
        public Dictionary<string, IReadOnlyDictionary<string, string>> CardCache { get; } = new(StringComparer.OrdinalIgnoreCase);

        public Dictionary<string, IReadOnlyList<CmdbLookupValue>> LookupCache { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

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
