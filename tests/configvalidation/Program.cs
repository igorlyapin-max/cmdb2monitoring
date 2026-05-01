using System.Text.Json;
using System.Text.Json.Nodes;
using CmdbKafka2Zabbix.Conversion;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;

var repositoryRoot = args.Length > 0
    ? Path.GetFullPath(args[0])
    : FindRepositoryRoot(Directory.GetCurrentDirectory());

var errors = new List<string>();
var warnings = new List<string>();

var services = new[]
{
    new ServiceDefinition("cmdbwebhooks2kafka", "src/cmdbwebhooks2kafka", ServiceKind.Webhook),
    new ServiceDefinition("cmdbkafka2zabbix", "src/cmdbkafka2zabbix", ServiceKind.Converter),
    new ServiceDefinition("zabbixrequests2api", "src/zabbixrequests2api", ServiceKind.ZabbixApi)
};

var configs = new Dictionary<(string Service, string Environment), JsonObject>();
foreach (var service in services)
{
    var baseConfig = LoadJsonObject(Path.Combine(repositoryRoot, service.RelativePath, "appsettings.json"), errors);
    var developmentConfig = LoadJsonObject(Path.Combine(repositoryRoot, service.RelativePath, "appsettings.Development.json"), errors);
    if (baseConfig is null || developmentConfig is null)
    {
        continue;
    }

    configs[(service.Name, "base")] = baseConfig;
    configs[(service.Name, "development")] = Merge(baseConfig, developmentConfig);

    ValidateServiceConfig(service, "base", baseConfig, repositoryRoot, errors, warnings);
    ValidateServiceConfig(service, "development", configs[(service.Name, "development")], repositoryRoot, errors, warnings);
    ValidateNoProductionSecrets(service, baseConfig, errors);
}

ValidateTopicChain(configs, "base", errors);
ValidateTopicChain(configs, "development", errors);
ValidateRulesFile(repositoryRoot, errors);
await ValidateRulesT4Rendering(repositoryRoot, errors);
await ValidateServerMultiProfileConversion(repositoryRoot, errors);
ValidateArchitectureArtifacts(repositoryRoot, errors);

foreach (var warning in warnings)
{
    Console.WriteLine($"WARN: {warning}");
}

if (errors.Count > 0)
{
    Console.Error.WriteLine("Configuration validation failed:");
    foreach (var error in errors)
    {
        Console.Error.WriteLine($"- {error}");
    }

    return 1;
}

Console.WriteLine("Configuration validation passed.");
return 0;

static string FindRepositoryRoot(string startDirectory)
{
    var current = new DirectoryInfo(startDirectory);
    while (current is not null)
    {
        if (File.Exists(Path.Combine(current.FullName, "cmdb2monitoring.slnx")))
        {
            return current.FullName;
        }

        current = current.Parent;
    }

    throw new DirectoryNotFoundException("Cannot find repository root with cmdb2monitoring.slnx.");
}

static JsonObject? LoadJsonObject(string path, List<string> errors)
{
    if (!File.Exists(path))
    {
        errors.Add($"Missing JSON config: {Relative(path)}");
        return null;
    }

    try
    {
        var node = JsonNode.Parse(File.ReadAllText(path));
        if (node is JsonObject jsonObject)
        {
            return jsonObject;
        }

        errors.Add($"JSON root must be an object: {Relative(path)}");
        return null;
    }
    catch (JsonException ex)
    {
        errors.Add($"Invalid JSON in {Relative(path)}: {ex.Message}");
        return null;
    }
}

static JsonObject Merge(JsonObject baseConfig, JsonObject overrideConfig)
{
    var result = (JsonObject)baseConfig.DeepClone();
    foreach (var (key, overrideValue) in overrideConfig)
    {
        if (overrideValue is JsonObject overrideObject
            && result[key] is JsonObject baseObject)
        {
            result[key] = Merge(baseObject, overrideObject);
            continue;
        }

        result[key] = overrideValue?.DeepClone();
    }

    return result;
}

static void ValidateServiceConfig(
    ServiceDefinition service,
    string environment,
    JsonObject config,
    string repositoryRoot,
    List<string> errors,
    List<string> warnings)
{
    var context = $"{service.Name}:{environment}";
    RequireNonEmpty(config, "Service:Name", context, errors);
    RequireRoute(config, "Service:HealthRoute", context, errors);
    ValidateElkLogging(config, context, errors);

    switch (service.Kind)
    {
        case ServiceKind.Webhook:
            RequireRoute(config, "CmdbWebhook:Route", context, errors);
            RequireNonEmpty(config, "CmdbWebhook:Source", context, errors);
            ValidateStringArray(config, "CmdbWebhook:EventTypeFields", context, errors);
            ValidateStringArray(config, "CmdbWebhook:EntityTypeFields", context, errors);
            ValidateStringArray(config, "CmdbWebhook:EntityIdFields", context, errors);
            ValidateKafkaClient(config, "Kafka", context, errors, requireGroup: false);
            ValidateTopicSuffix(config, "Kafka:Topic", environment, context, errors);
            break;
        case ServiceKind.Converter:
            ValidateKafkaClient(config, "Kafka:Input", context, errors, requireGroup: true);
            ValidateKafkaClient(config, "Kafka:Output", context, errors, requireGroup: false);
            ValidateTopicSuffix(config, "Kafka:Input:Topic", environment, context, errors);
            ValidateTopicSuffix(config, "Kafka:Output:Topic", environment, context, errors);
            ValidateConversionRules(config, service, repositoryRoot, context, errors);
            ValidateProcessingState(config, context, errors);
            break;
        case ServiceKind.ZabbixApi:
            ValidateKafkaClient(config, "Kafka:Input", context, errors, requireGroup: true);
            ValidateKafkaClient(config, "Kafka:Output", context, errors, requireGroup: false);
            ValidateTopicSuffix(config, "Kafka:Input:Topic", environment, context, errors);
            ValidateTopicSuffix(config, "Kafka:Output:Topic", environment, context, errors);
            ValidateZabbix(config, context, errors, warnings);
            ValidateProcessing(config, context, errors);
            ValidateProcessingState(config, context, errors);
            break;
    }
}

static void ValidateKafkaClient(
    JsonObject config,
    string sectionPath,
    string context,
    List<string> errors,
    bool requireGroup)
{
    RequireNonEmpty(config, $"{sectionPath}:BootstrapServers", context, errors);
    RequireNonEmpty(config, $"{sectionPath}:Topic", context, errors);
    RequireNonEmpty(config, $"{sectionPath}:ClientId", context, errors);
    if (requireGroup)
    {
        RequireNonEmpty(config, $"{sectionPath}:GroupId", context, errors);
    }

    var protocol = GetString(config, $"{sectionPath}:SecurityProtocol");
    if (string.IsNullOrWhiteSpace(protocol))
    {
        errors.Add($"{context} {sectionPath}:SecurityProtocol is required.");
    }
    else if (!IsOneOf(protocol, "Plaintext", "Ssl", "SaslPlaintext", "SaslSsl"))
    {
        errors.Add($"{context} {sectionPath}:SecurityProtocol has unsupported value '{protocol}'.");
    }

    var saslMechanism = GetString(config, $"{sectionPath}:SaslMechanism");
    if (!string.IsNullOrWhiteSpace(saslMechanism)
        && !IsOneOf(saslMechanism, "Gssapi", "Plain", "ScramSha256", "ScramSha512", "OAuthBearer"))
    {
        errors.Add($"{context} {sectionPath}:SaslMechanism has unsupported value '{saslMechanism}'.");
    }

    if (protocol?.Contains("Sasl", StringComparison.OrdinalIgnoreCase) == true)
    {
        RequireNonEmpty(config, $"{sectionPath}:Username", context, errors);
        RequireNonEmpty(config, $"{sectionPath}:Password", context, errors);
    }
}

static void ValidateElkLogging(JsonObject config, string context, List<string> errors)
{
    var enabled = GetBool(config, "ElkLogging:Enabled");
    if (enabled != true)
    {
        return;
    }

    var mode = GetString(config, "ElkLogging:Mode");
    if (string.IsNullOrWhiteSpace(mode)
        || !IsOneOf(mode, "Kafka", "Elk", "Both", "Elasticsearch"))
    {
        errors.Add($"{context} ElkLogging:Mode has unsupported value '{mode}'.");
    }

    var kafkaEnabled = GetBool(config, "ElkLogging:Kafka:Enabled");
    if (kafkaEnabled == true || string.Equals(mode, "Kafka", StringComparison.OrdinalIgnoreCase))
    {
        ValidateKafkaClient(config, "ElkLogging:Kafka", context, errors, requireGroup: false);
        RequireNonEmpty(config, "ElkLogging:Kafka:MinimumLevel", context, errors);
        RequireNonEmpty(config, "ElkLogging:Kafka:ServiceName", context, errors);
        RequireNonEmpty(config, "ElkLogging:Kafka:Environment", context, errors);
    }
}

static void ValidateConversionRules(
    JsonObject config,
    ServiceDefinition service,
    string repositoryRoot,
    string context,
    List<string> errors)
{
    RequireNonEmpty(config, "ConversionRules:RepositoryPath", context, errors);
    RequireNonEmpty(config, "ConversionRules:RulesFilePath", context, errors);
    RequireNonEmpty(config, "ConversionRules:TemplateEngine", context, errors);
    RequireNonEmpty(config, "ConversionRules:TemplateName", context, errors);

    var serviceDirectory = Path.Combine(repositoryRoot, service.RelativePath);
    var configuredRepository = GetString(config, "ConversionRules:RepositoryPath") ?? ".";
    var rulesFilePath = GetString(config, "ConversionRules:RulesFilePath") ?? string.Empty;
    var rulesFullPath = Path.GetFullPath(Path.Combine(serviceDirectory, configuredRepository, rulesFilePath));
    if (!File.Exists(rulesFullPath))
    {
        errors.Add($"{context} ConversionRules file does not exist: {Relative(rulesFullPath)}");
    }
}

static void ValidateZabbix(JsonObject config, string context, List<string> errors, List<string> warnings)
{
    RequireNonEmpty(config, "Zabbix:ApiEndpoint", context, errors);
    var authMode = GetString(config, "Zabbix:AuthMode");
    if (string.IsNullOrWhiteSpace(authMode)
        || !IsOneOf(authMode, "None", "Token", "Login", "LoginOrToken"))
    {
        errors.Add($"{context} Zabbix:AuthMode has unsupported value '{authMode}'.");
    }

    RequirePositiveInt(config, "Zabbix:RequestTimeoutMs", context, errors);

    if (IsOneOf(authMode ?? string.Empty, "Token")
        && string.IsNullOrWhiteSpace(GetString(config, "Zabbix:ApiToken")))
    {
        warnings.Add($"{context} uses Token auth but Zabbix:ApiToken is empty; provide it through env/secret storage.");
    }
}

static void ValidateProcessing(JsonObject config, string context, List<string> errors)
{
    RequireNonNegativeInt(config, "Processing:DelayBetweenObjectsMs", context, errors);
    RequirePositiveInt(config, "Processing:MaxRetryAttempts", context, errors);
    RequireNonNegativeInt(config, "Processing:RetryDelayMs", context, errors);
}

static void ValidateProcessingState(JsonObject config, string context, List<string> errors)
{
    RequireNonEmpty(config, "ProcessingState:FilePath", context, errors);
    var filePath = GetString(config, "ProcessingState:FilePath") ?? string.Empty;
    if (!filePath.StartsWith("state/", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"{context} ProcessingState:FilePath should be under state/: {filePath}");
    }
}

static void ValidateTopicChain(
    Dictionary<(string Service, string Environment), JsonObject> configs,
    string environment,
    List<string> errors)
{
    if (!configs.TryGetValue(("cmdbwebhooks2kafka", environment), out var webhook)
        || !configs.TryGetValue(("cmdbkafka2zabbix", environment), out var converter)
        || !configs.TryGetValue(("zabbixrequests2api", environment), out var zabbixApi))
    {
        return;
    }

    RequireEqual(
        GetString(webhook, "Kafka:Topic"),
        GetString(converter, "Kafka:Input:Topic"),
        $"{environment} cmdbwebhooks2kafka output topic",
        $"{environment} cmdbkafka2zabbix input topic",
        errors);
    RequireEqual(
        GetString(converter, "Kafka:Output:Topic"),
        GetString(zabbixApi, "Kafka:Input:Topic"),
        $"{environment} cmdbkafka2zabbix output topic",
        $"{environment} zabbixrequests2api input topic",
        errors);
}

static void ValidateRulesFile(string repositoryRoot, List<string> errors)
{
    var rulesPath = Path.Combine(repositoryRoot, "rules/cmdbuild-to-zabbix-host-create.json");
    var rules = LoadJsonObject(rulesPath, errors);
    if (rules is null)
    {
        return;
    }

    var routes = GetArray(rules, "eventRoutingRules");
    foreach (var eventType in new[] { "create", "update", "delete" })
    {
        if (!routes.Any(route => string.Equals(GetString(route, "eventType"), eventType, StringComparison.OrdinalIgnoreCase)))
        {
            errors.Add($"Rules file must contain eventRoutingRules entry for '{eventType}'.");
        }
    }

    RequireArray(rules, "t4Templates:hostCreateJsonRpcRequestLines", "rules", errors);
    RequireArray(rules, "t4Templates:hostUpdateJsonRpcRequestLines", "rules", errors);
    RequireArray(rules, "t4Templates:hostDeleteJsonRpcRequestLines", "rules", errors);
    RequireArray(rules, "hostProfiles", "rules", errors);
    RequireObject(rules, "source:fields:profileIpAddress", "rules", errors);
    RequireObject(rules, "source:fields:profile2IpAddress", "rules", errors);
    RequireObject(rules, "source:fields:profileDnsName", "rules", errors);
    RequireObject(rules, "source:fields:interfaceIpAddress", "rules", errors);
    RequireObject(rules, "source:fields:interface2IpAddress", "rules", errors);
    RequireArray(rules, "templateConflictRules", "rules", errors);
    ValidateNoLegacyServerFieldAliases(rules, errors);

    var hostProfiles = GetArray(rules, "hostProfiles");
    if (hostProfiles.Count == 0)
    {
        errors.Add("Rules file must contain at least one hostProfiles entry.");
    }

    foreach (var profile in hostProfiles.OfType<JsonObject>())
    {
        if (string.IsNullOrWhiteSpace(GetString(profile, "name")))
        {
            errors.Add("Each hostProfiles entry must contain name.");
        }

        RequireArray(profile, "interfaces", $"hostProfile:{GetString(profile, "name") ?? "<unknown>"}", errors);
    }

    foreach (var profileName in new[] { "main", "profile", "profile2" })
    {
        if (!hostProfiles.OfType<JsonObject>().Any(profile => string.Equals(GetString(profile, "name"), profileName, StringComparison.Ordinal)))
        {
            errors.Add($"Rules file must contain hostProfiles entry for '{profileName}'.");
        }
    }

    foreach (var profileName in new[] { "profile", "profile2" })
    {
        var profile = hostProfiles.OfType<JsonObject>()
            .FirstOrDefault(item => string.Equals(GetString(item, "name"), profileName, StringComparison.Ordinal));
        if (profile is not null && GetBool(profile, "createOnUpdateWhenMissing") != true)
        {
            errors.Add($"Rules file hostProfile '{profileName}' must enable createOnUpdateWhenMissing.");
        }
    }

    var templateConflictRules = GetArray(rules, "templateConflictRules");
    foreach (var templateId in new[] { "10256", "10563" })
    {
        var conflictRule = templateConflictRules.OfType<JsonObject>().FirstOrDefault(rule =>
            GetArray(rule, "whenTemplateIds").Any(item => string.Equals(item?.GetValue<string>(), templateId, StringComparison.OrdinalIgnoreCase)));
        if (conflictRule is null)
        {
            errors.Add($"Rules file must contain template conflict rule for template {templateId}.");
            continue;
        }

        foreach (var removeTemplateId in new[] { "10564", "10001", "10081", "10561", "10562" })
        {
            if (!GetArray(conflictRule, "removeTemplateIds").Any(item => string.Equals(item?.GetValue<string>(), removeTemplateId, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add($"Rules file must remove conflicting template {removeTemplateId} when template {templateId} is selected.");
            }
        }
    }

    var createTemplate = string.Join('\n', GetArray(rules, "t4Templates:hostCreateJsonRpcRequestLines").Select(item => item?.GetValue<string>() ?? string.Empty));
    var updateTemplate = string.Join('\n', GetArray(rules, "t4Templates:hostUpdateJsonRpcRequestLines").Select(item => item?.GetValue<string>() ?? string.Empty));
    foreach (var template in new[] { createTemplate, updateTemplate })
    {
        if (!template.Contains("Model.Interfaces", StringComparison.Ordinal))
        {
            errors.Add("host.create and host.update T4 templates must render Model.Interfaces.");
        }
    }

    var hostGetTemplate = string.Join('\n', GetArray(rules, "t4Templates:hostGetByHostJsonRpcRequestLines").Select(item => item?.GetValue<string>() ?? string.Empty));
    foreach (var marker in new[] { "cmdb2monitoring", "hostProfile", "fallbackForMethod", "fallbackUpdateParams", "fallbackCreateParams", "createOnUpdateWhenMissing", "selectInterfaces", "selectParentTemplates", "Model.Interfaces", "Model.TemplatesToClear", "templates_clear" })
    {
        if (!hostGetTemplate.Contains(marker, StringComparison.Ordinal))
        {
            errors.Add($"hostGetByHostJsonRpcRequestLines must include '{marker}' for update/delete fallback.");
        }
    }
}

static async Task ValidateRulesT4Rendering(string repositoryRoot, List<string> errors)
{
    var rulesPath = Path.Combine(repositoryRoot, "rules/cmdbuild-to-zabbix-host-create.json");
    ConversionRulesDocument? rules;
    try
    {
        rules = JsonSerializer.Deserialize<ConversionRulesDocument>(
            File.ReadAllText(rulesPath),
            new JsonSerializerOptions(JsonSerializerDefaults.Web)
            {
                PropertyNameCaseInsensitive = true
            });
    }
    catch (Exception ex)
    {
        errors.Add($"Rules T4 validation cannot read rules document: {ex.Message}");
        return;
    }

    if (rules is null)
    {
        errors.Add("Rules T4 validation cannot read rules document.");
        return;
    }

    var renderer = new T4TemplateRenderer(Options.Create(new ConversionRulesOptions
    {
        AddDefaultDirectives = true
    }));
    var model = new ZabbixHostCreateModel
    {
        Host = "cmdb-server-s1",
        VisibleName = "Server s1",
        HostProfileName = "main",
        ClassName = "Server",
        EntityId = "1001",
        Code = "s1",
        IpAddress = "192.168.202.2",
        DnsName = "s1.example.local",
        ZabbixHostId = "12345",
        OperatingSystem = "Windows server",
        ZabbixTag = "tag1",
        EventType = "update",
        CurrentMethod = "host.update",
        FallbackForMethod = "host.update",
        SourceFields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["entityId"] = "1001",
            ["code"] = "s1",
            ["className"] = "Server",
            ["ipAddress"] = "192.168.202.2",
            ["profileIpAddress"] = "192.168.202.102",
            ["hostProfile"] = "main"
        },
        Status = 0,
        InventoryMode = 0,
        Interface = new ZabbixInterfaceModel
        {
            Type = 1,
            Main = 1,
            UseIp = 1,
            Ip = "192.168.202.2",
            Port = "10050"
        },
        Interfaces =
        [
            new ZabbixInterfaceModel
            {
                Type = 1,
                Main = 1,
                UseIp = 1,
                Ip = "192.168.202.2",
                Port = "10050"
            },
            new ZabbixInterfaceModel
            {
                Type = 2,
                Main = 1,
                UseIp = 1,
                Ip = "192.168.202.102",
                Port = "161"
            }
        ],
        Groups = [new ZabbixGroupModel("Linux servers", "2")],
        Templates = [new ZabbixTemplateModel("ICMP Ping", "10564")],
        Tags = [new ZabbixTagModel("cmdb.hostProfile", "main")],
        RequestId = 1001
    };

    foreach (var (name, lines) in new Dictionary<string, string[]>
    {
        ["hostCreateJsonRpcRequestLines"] = rules.T4Templates.HostCreateJsonRpcRequestLines,
        ["hostUpdateJsonRpcRequestLines"] = rules.T4Templates.HostUpdateJsonRpcRequestLines,
        ["hostDeleteJsonRpcRequestLines"] = rules.T4Templates.HostDeleteJsonRpcRequestLines,
        ["hostGetByHostJsonRpcRequestLines"] = rules.T4Templates.HostGetByHostJsonRpcRequestLines
    })
    {
        try
        {
            var rendered = await renderer.RenderAsync(lines, model, CancellationToken.None);
            using var _ = JsonDocument.Parse(rendered);
        }
        catch (Exception ex)
        {
            errors.Add($"Rules T4 template '{name}' failed to render valid JSON: {ex.Message}");
        }
    }
}

static async Task ValidateServerMultiProfileConversion(string repositoryRoot, List<string> errors)
{
    var rulesPath = Path.Combine(repositoryRoot, "rules/cmdbuild-to-zabbix-host-create.json");
    ConversionRulesDocument? rules;
    try
    {
        rules = JsonSerializer.Deserialize<ConversionRulesDocument>(
            File.ReadAllText(rulesPath),
            new JsonSerializerOptions(JsonSerializerDefaults.Web)
            {
                PropertyNameCaseInsensitive = true
            });
    }
    catch (Exception ex)
    {
        errors.Add($"Rules Server multi-profile validation cannot read rules document: {ex.Message}");
        return;
    }

    if (rules is null)
    {
        errors.Add("Rules Server multi-profile validation cannot read rules document.");
        return;
    }

    var message = JsonSerializer.Serialize(new
    {
        source = "cmdbuild",
        eventType = "create",
        entityType = "Server",
        entityId = "2001",
        payload = new Dictionary<string, object?>
        {
            ["source"] = "cmdbuild",
            ["eventType"] = "create",
            ["className"] = "Server",
            ["id"] = "2001",
            ["code"] = "srv-interface",
            ["ip_address"] = "192.168.202.10",
            ["interface"] = "192.168.202.101",
            ["interface2"] = "192.168.202.102",
            ["profile"] = "192.168.202.201",
            ["profile2"] = "192.168.202.202",
            ["description"] = "server with main additional interfaces and additional profiles",
            ["os"] = "105152",
            ["zabbixTag"] = "106857"
        }
    });

    var reader = new CmdbEventReader();
    var source = reader.Read(message, rules);
    var renderer = new T4TemplateRenderer(Options.Create(new ConversionRulesOptions
    {
        AddDefaultDirectives = true
    }));
    var converter = new CmdbToZabbixConverter(
        renderer,
        Options.Create(new ConversionRulesOptions
        {
            AddDefaultDirectives = true
        }));
    var results = await converter.ConvertAsync(source, rules, CancellationToken.None);
    var publishedProfiles = results
        .Where(result => result.ShouldPublish)
        .Select(result => result.ProfileName ?? string.Empty)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    foreach (var profileName in new[] { "main", "profile", "profile2" })
    {
        if (!publishedProfiles.Contains(profileName))
        {
            errors.Add($"Rules Server multi-profile validation expected published host profile '{profileName}'.");
        }
    }

    var mainResult = results.FirstOrDefault(result => result.ShouldPublish && string.Equals(result.ProfileName, "main", StringComparison.OrdinalIgnoreCase));
    if (mainResult?.Value is null)
    {
        errors.Add("Rules Server multi-profile validation expected main profile request.");
        return;
    }

    if (!mainResult.Value.Contains("\"templateid\": \"10256\"", StringComparison.Ordinal))
    {
        errors.Add("Rules Server multi-profile validation expected main profile with interface/interface2 IPs to use template HP iLO by SNMP (10256).");
    }

    if (mainResult.Value.Contains("\"templateid\": \"10564\"", StringComparison.Ordinal))
    {
        errors.Add("Rules Server multi-profile validation expected template conflict rules to remove ICMP Ping (10564) from main profile when HP iLO by SNMP is selected.");
    }

    if (mainResult.Value.Contains("\"templateid\": \"10081\"", StringComparison.Ordinal))
    {
        errors.Add("Rules Server multi-profile validation expected template conflict rules to remove Windows by Zabbix agent (10081) from main profile when HP iLO by SNMP is selected.");
    }

    using var mainDocument = JsonDocument.Parse(mainResult.Value);
    if (!mainDocument.RootElement.TryGetProperty("params", out var mainParams)
        || !mainParams.TryGetProperty("interfaces", out var interfaces)
        || interfaces.ValueKind != JsonValueKind.Array
        || interfaces.GetArrayLength() != 3)
    {
        errors.Add("Rules Server multi-profile validation expected main profile to render exactly three interfaces: ipAddress, interface, interface2.");
    }
    else
    {
        var mainSnmpInterfaces = interfaces.EnumerateArray()
            .Where(item => item.TryGetProperty("type", out var type)
                && type.GetInt32() == 2
                && item.TryGetProperty("main", out var main)
                && main.GetInt32() == 1)
            .Count();
        if (mainSnmpInterfaces != 1)
        {
            errors.Add("Rules Server multi-profile validation expected exactly one main SNMP interface among interface/interface2.");
        }
    }

    foreach (var expectedIp in new[] { "192.168.202.10", "192.168.202.101", "192.168.202.102" })
    {
        if (!mainResult.Value.Contains($"\"ip\": \"{expectedIp}\"", StringComparison.Ordinal))
        {
            errors.Add($"Rules Server multi-profile validation expected main profile interface IP {expectedIp}.");
        }
    }

    var updateMessage = JsonSerializer.Serialize(new
    {
        source = "cmdbuild",
        eventType = "update",
        entityType = "Server",
        entityId = "2002",
        payload = new Dictionary<string, object?>
        {
            ["source"] = "cmdbuild",
            ["eventType"] = "update",
            ["className"] = "Server",
            ["id"] = "2002",
            ["code"] = "srv-upsert",
            ["ip_address"] = "192.168.203.10",
            ["profile"] = "192.168.203.201",
            ["description"] = "server update with newly added profile address",
            ["os"] = "105152",
            ["zabbixTag"] = "106857"
        }
    });
    var updateSource = reader.Read(updateMessage, rules);
    var updateResults = await converter.ConvertAsync(updateSource, rules, CancellationToken.None);
    var profileUpdate = updateResults.FirstOrDefault(result => result.ShouldPublish && string.Equals(result.ProfileName, "profile", StringComparison.OrdinalIgnoreCase));
    if (profileUpdate?.Value is null)
    {
        errors.Add("Rules Server multi-profile validation expected profile update fallback request.");
        return;
    }

    using var profileUpdateDocument = JsonDocument.Parse(profileUpdate.Value);
    var profileRoot = profileUpdateDocument.RootElement;
    if (!profileRoot.TryGetProperty("method", out var method) || method.GetString() != "host.get")
    {
        errors.Add("Rules Server multi-profile validation expected profile update without hostid to render host.get fallback.");
    }

    if (!profileRoot.TryGetProperty("cmdb2monitoring", out var metadata)
        || metadata.ValueKind != JsonValueKind.Object
        || !metadata.TryGetProperty("createOnUpdateWhenMissing", out var createOnUpdateWhenMissing)
        || createOnUpdateWhenMissing.ValueKind != JsonValueKind.True
        || !metadata.TryGetProperty("fallbackCreateParams", out var createParams)
        || createParams.ValueKind != JsonValueKind.Object)
    {
        errors.Add("Rules Server multi-profile validation expected profile update fallback metadata with createOnUpdateWhenMissing and fallbackCreateParams.");
    }
    else
    {
        if (!createParams.TryGetProperty("host", out var host) || host.GetString() != "cmdb-server-srv-upsert-profile")
        {
            errors.Add("Rules Server multi-profile validation expected fallbackCreateParams.host for profile hostProfile.");
        }

        if (!createParams.TryGetProperty("interfaces", out var createInterfaces)
            || createInterfaces.ValueKind != JsonValueKind.Array
            || createInterfaces.GetArrayLength() != 1
            || !createInterfaces[0].TryGetProperty("ip", out var profileIp)
            || profileIp.GetString() != "192.168.203.201")
        {
            errors.Add("Rules Server multi-profile validation expected fallbackCreateParams with one profile interface IP.");
        }

        if (createParams.GetRawText().Contains("\"templateid\":\"10564\"", StringComparison.Ordinal)
            || createParams.GetRawText().Contains("\"templateid\": \"10564\"", StringComparison.Ordinal))
        {
            errors.Add("Rules Server multi-profile validation expected template conflict rules to remove ICMP Ping (10564) from profile fallback create params when Generic by SNMP is selected.");
        }

        if (createParams.GetRawText().Contains("\"templateid\":\"10081\"", StringComparison.Ordinal)
            || createParams.GetRawText().Contains("\"templateid\": \"10081\"", StringComparison.Ordinal))
        {
            errors.Add("Rules Server multi-profile validation expected template conflict rules to remove Windows by Zabbix agent (10081) from profile fallback create params when Generic by SNMP is selected.");
        }
    }

    if (!profileRoot.TryGetProperty("cmdb2monitoring", out var profileMetadata)
        || !profileMetadata.TryGetProperty("fallbackUpdateParams", out var updateParams)
        || updateParams.ValueKind != JsonValueKind.Object
        || !updateParams.TryGetProperty("templates_clear", out var templatesClear)
        || templatesClear.ValueKind != JsonValueKind.Array
        || !templatesClear.EnumerateArray().Any(item =>
            item.TryGetProperty("templateid", out var templateId)
            && templateId.GetString() == "10081"))
    {
        errors.Add("Rules Server multi-profile validation expected fallbackUpdateParams.templates_clear to include Windows by Zabbix agent (10081) for SNMP update conflict cleanup.");
    }
}

static void ValidateNoLegacyServerFieldAliases(JsonObject rules, List<string> errors)
{
    foreach (var oldFieldName in new[] { "managementIpAddress", "management2IpAddress", "managementDnsName", "iloIpAddress", "ilo2IpAddress" })
    {
        if (GetNode(rules, $"source:fields:{oldFieldName}") is not null)
        {
            errors.Add($"Rules file must not contain legacy source field '{oldFieldName}'.");
        }
    }

    foreach (var (fieldName, oldNames) in new Dictionary<string, string[]>
    {
        ["profileIpAddress"] = ["mgmt", "management_ip", "mgmt_ip", "oob_ip", "idrac_ip", "managementIpAddress"],
        ["profile2IpAddress"] = ["mgmt2", "management2_ip", "mgmt2_ip", "oob2_ip", "idrac2_ip", "management2IpAddress"],
        ["profileDnsName"] = ["management_dns", "mgmt_dns", "oob_dns", "ilo_dns", "idrac_dns", "managementDnsName"],
        ["interfaceIpAddress"] = ["iLo", "ilo", "ilo_ip", "iloIpAddress"],
        ["interface2IpAddress"] = ["iLo2", "ilo2", "ilo2_ip", "ilo2IpAddress"]
    })
    {
        if (GetArray(rules, $"source:fields:{fieldName}:sources").Count > 0)
        {
            errors.Add($"Rules file source field '{fieldName}' must not define aliases in sources[].");
        }

        var configuredNames = new[]
            {
                GetString(rules, $"source:fields:{fieldName}:source") ?? string.Empty
            }
            .Concat(GetArray(rules, $"source:fields:{fieldName}:sources")
                .Select(item => item?.GetValue<string>() ?? string.Empty))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();

        foreach (var oldName in oldNames)
        {
            if (configuredNames.Any(name => string.Equals(name, oldName, StringComparison.Ordinal)))
            {
                errors.Add($"Rules file source field '{fieldName}' must not accept legacy alias '{oldName}'.");
            }
        }
    }

    foreach (var (fieldName, expectedAttribute) in new Dictionary<string, string>
    {
        ["profileIpAddress"] = "mgmt",
        ["profile2IpAddress"] = "mgmt2",
        ["interfaceIpAddress"] = "iLo",
        ["interface2IpAddress"] = "iLo2"
    })
    {
        var actualAttribute = GetString(rules, $"source:fields:{fieldName}:cmdbAttribute");
        if (!string.Equals(actualAttribute, expectedAttribute, StringComparison.Ordinal))
        {
            errors.Add($"Rules file source field '{fieldName}' must define cmdbAttribute '{expectedAttribute}' for Mapping/CMDBuild Body generation.");
        }
    }
}

static void ValidateArchitectureArtifacts(string repositoryRoot, List<string> errors)
{
    var requiredFiles = new[]
    {
        "aa/README.md",
        "PROJECT_DOCUMENTATION.md",
        "aa/business-process.md",
        "aa/business-process.mmd",
        "aa/information-model.md",
        "aa/information-model.mmd",
        "aa/deployment.md",
        "aa/deployment-test.mmd",
        "aa/configuration-files.md",
        "aa/asyncapi/cmdb2monitoring.asyncapi.yaml",
        "aa/openapi/cmdbwebhooks2kafka.openapi.yaml",
        "aa/openapi/health.openapi.yaml",
        "aa/openapi/monitoring-ui-api.openapi.yaml",
        "aa/maps/healthcheck-map.md",
        "aa/maps/kafka-access-map.md",
        "aa/maps/metrics-map.md",
        "aa/maps/secrets-map.md",
        "aa/maps/event-registration-map.md"
    };

    foreach (var relativeFile in requiredFiles)
    {
        var fullPath = Path.Combine(repositoryRoot, relativeFile);
        if (!File.Exists(fullPath))
        {
            errors.Add($"Missing architecture artifact: {relativeFile}");
            continue;
        }

        if (new FileInfo(fullPath).Length == 0)
        {
            errors.Add($"Architecture artifact is empty: {relativeFile}");
        }
    }
}

static void ValidateNoProductionSecrets(ServiceDefinition service, JsonObject baseConfig, List<string> errors)
{
    foreach (var path in new[]
    {
        "Kafka:Password",
        "Kafka:Input:Password",
        "Kafka:Output:Password",
        "ElkLogging:Kafka:Password",
        "ElkLogging:Elk:ApiKey",
        "Zabbix:ApiToken",
        "Zabbix:Password"
    })
    {
        var value = GetString(baseConfig, path);
        if (!string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"{service.Name}:base must not contain production secret in {path}; use env/secret storage.");
        }
    }
}

static void ValidateStringArray(JsonObject config, string path, string context, List<string> errors)
{
    var array = GetArray(config, path);
    if (array.Count == 0 || array.Any(item => string.IsNullOrWhiteSpace(item?.GetValue<string>())))
    {
        errors.Add($"{context} {path} must be a non-empty string array.");
    }
}

static void ValidateTopicSuffix(JsonObject config, string path, string environment, string context, List<string> errors)
{
    var topic = GetString(config, path);
    if (string.IsNullOrWhiteSpace(topic))
    {
        return;
    }

    if (environment == "development" && !topic.EndsWith(".dev", StringComparison.Ordinal))
    {
        errors.Add($"{context} {path} should use .dev suffix: {topic}");
    }

    if (environment == "base" && topic.EndsWith(".dev", StringComparison.Ordinal))
    {
        errors.Add($"{context} {path} must not use .dev suffix in base config: {topic}");
    }
}

static void RequireRoute(JsonObject config, string path, string context, List<string> errors)
{
    var value = GetString(config, path);
    if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("/", StringComparison.Ordinal))
    {
        errors.Add($"{context} {path} must be a non-empty route starting with '/'.");
    }
}

static void RequireNonEmpty(JsonObject config, string path, string context, List<string> errors)
{
    if (string.IsNullOrWhiteSpace(GetString(config, path)))
    {
        errors.Add($"{context} {path} is required.");
    }
}

static void RequireArray(JsonObject config, string path, string context, List<string> errors)
{
    if (GetArray(config, path).Count == 0)
    {
        errors.Add($"{context} {path} must be a non-empty array.");
    }
}

static void RequireObject(JsonObject config, string path, string context, List<string> errors)
{
    if (GetNode(config, path) is not JsonObject)
    {
        errors.Add($"{context} {path} must be an object.");
    }
}

static void RequirePositiveInt(JsonObject config, string path, string context, List<string> errors)
{
    var value = GetInt(config, path);
    if (value is null or <= 0)
    {
        errors.Add($"{context} {path} must be greater than zero.");
    }
}

static void RequireNonNegativeInt(JsonObject config, string path, string context, List<string> errors)
{
    var value = GetInt(config, path);
    if (value is null or < 0)
    {
        errors.Add($"{context} {path} must be non-negative.");
    }
}

static void RequireEqual(string? left, string? right, string leftName, string rightName, List<string> errors)
{
    if (!string.Equals(left, right, StringComparison.Ordinal))
    {
        errors.Add($"{leftName} must match {rightName}: '{left}' != '{right}'.");
    }
}

static JsonArray GetArray(JsonObject config, string path)
{
    return GetNode(config, path) as JsonArray ?? [];
}

static string? GetString(JsonNode? node, string path)
{
    var value = GetNode(node, path);
    return value switch
    {
        null => null,
        JsonValue jsonValue when jsonValue.TryGetValue<string>(out var stringValue) => stringValue,
        JsonValue jsonValue when jsonValue.TryGetValue<int>(out var intValue) => intValue.ToString(System.Globalization.CultureInfo.InvariantCulture),
        JsonValue jsonValue when jsonValue.TryGetValue<bool>(out var boolValue) => boolValue.ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => null
    };
}

static bool? GetBool(JsonObject config, string path)
{
    var value = GetNode(config, path);
    return value is JsonValue jsonValue && jsonValue.TryGetValue<bool>(out var boolValue)
        ? boolValue
        : null;
}

static int? GetInt(JsonObject config, string path)
{
    var value = GetNode(config, path);
    if (value is JsonValue jsonValue && jsonValue.TryGetValue<int>(out var intValue))
    {
        return intValue;
    }

    return null;
}

static JsonNode? GetNode(JsonNode? node, string path)
{
    var current = node;
    foreach (var segment in path.Split(':', StringSplitOptions.RemoveEmptyEntries))
    {
        if (current is not JsonObject currentObject)
        {
            return null;
        }

        currentObject.TryGetPropertyValue(segment, out current);
    }

    return current;
}

static bool IsOneOf(string value, params string[] allowed)
{
    return allowed.Any(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase));
}

static string Relative(string path)
{
    return Path.GetRelativePath(Directory.GetCurrentDirectory(), path);
}

internal enum ServiceKind
{
    Webhook,
    Converter,
    ZabbixApi
}

internal sealed record ServiceDefinition(string Name, string RelativePath, ServiceKind Kind);
