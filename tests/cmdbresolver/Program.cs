using System.Net;
using System.Text;
using System.Text.Json;
using Cmdb2Monitoring.Logging;
using CmdbKafka2Zabbix.Configuration;
using CmdbKafka2Zabbix.Conversion;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var tests = new (string Name, Func<Task> Run)[]
{
    ("update rereads lookup values when ttl disabled", UpdateRereadsLookupValuesWhenTtlDisabled),
    ("lookup values cache honors ttl", LookupValuesCacheHonorsTtl),
    ("update rereads reference leaf cards", UpdateRereadsReferenceLeafCards),
    ("update skips foreign class-prefixed cmdb paths", UpdateSkipsForeignClassPrefixedCmdbPaths),
    ("update resolves unrooted reference leaf cards", UpdateResolvesUnrootedReferenceLeafCards),
    ("reference leaf payload key resolves before interface validation", UpdateMapsReferenceLeafPayloadKeyIntoProfileInterface),
    ("update rereads domain leaf cards", UpdateRereadsDomainLeafCards),
    ("update maps reread domain leaf into dynamic host groups", UpdateMapsRereadDomainLeafIntoDynamicHostGroups)
};

var failures = new List<string>();
foreach (var test in tests)
{
    try
    {
        await test.Run();
        Console.WriteLine($"PASS {test.Name}");
    }
    catch (Exception ex)
    {
        failures.Add($"{test.Name}: {ex.Message}");
        Console.Error.WriteLine($"FAIL {test.Name}: {ex}");
    }
}

if (failures.Count > 0)
{
    Console.Error.WriteLine("CMDB resolver tests failed:");
    foreach (var failure in failures)
    {
        Console.Error.WriteLine($"- {failure}");
    }

    return 1;
}

Console.WriteLine("CMDB resolver tests passed.");
return 0;

static async Task UpdateRereadsLookupValuesWhenTtlDisabled()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb, lookupCacheTtlSeconds: 0);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["lifecycle"] = new()
        {
            Source = "lifecycle",
            Type = "lookup",
            LookupType = "LifecycleState",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "lookup",
                ValueMode = "code"
            }
        }
    });

    cmdb.Revision = 1;
    var first = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["lifecycle"] = "1"
    }), rules, CancellationToken.None);
    AssertField(first, "lifecycle", "active");

    cmdb.Revision = 2;
    var second = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["lifecycle"] = "2"
    }), rules, CancellationToken.None);
    AssertField(second, "lifecycle", "business-hours");
}

static async Task LookupValuesCacheHonorsTtl()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb, lookupCacheTtlSeconds: 300);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["lifecycle"] = new()
        {
            Source = "lifecycle",
            Type = "lookup",
            LookupType = "LifecycleState",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "lookup",
                ValueMode = "code"
            }
        }
    });

    cmdb.Revision = 1;
    var first = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["lifecycle"] = "2"
    }), rules, CancellationToken.None);
    AssertField(first, "lifecycle", "standby-old");

    cmdb.Revision = 2;
    var second = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["lifecycle"] = "2"
    }), rules, CancellationToken.None);
    AssertField(second, "lifecycle", "standby-old");
    AssertEqual(
        1,
        cmdb.RequestPaths.Count(path => path == "/lookup_types/LifecycleState/values"),
        "lookup values request count");
}

static async Task UpdateRereadsReferenceLeafCards()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["referenceIp"] = new()
        {
            Source = "addressRef",
            CmdbPath = "Server.addressRef.Ip",
            Type = "ipAddress",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "cmdbPath",
                ValueMode = "leaf",
                MaxDepth = 2
            }
        }
    });

    cmdb.Revision = 1;
    var first = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["referenceIp"] = "address-1"
    }), rules, CancellationToken.None);
    AssertField(first, "referenceIp", "10.20.0.10");

    cmdb.Revision = 2;
    var second = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["referenceIp"] = "address-1"
    }), rules, CancellationToken.None);
    AssertField(second, "referenceIp", "10.20.0.20");
}

static async Task UpdateSkipsForeignClassPrefixedCmdbPaths()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["serveriIp"] = new()
        {
            Source = "ipaddress",
            CmdbPath = "serveri.ipaddress.ipAddr",
            Type = "ipAddress",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "cmdbPath",
                ValueMode = "leaf",
                MaxDepth = 2
            }
        },
        ["ntbookHostname"] = new()
        {
            Source = "hostname",
            CmdbPath = "NTbook.hostname",
            Type = "string",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "none"
            }
        }
    });

    var resolved = await resolver.ResolveAsync(new CmdbSourceEvent(
        Source: "cmdbuild",
        EventType: "update",
        EntityType: "NTbook",
        EntityId: "ntbook-1",
        Code: "ntbook-1",
        ClassName: "NTbook",
        IpAddress: null,
        DnsName: null,
        ZabbixHostId: null,
        Description: null,
        OperatingSystem: null,
        ZabbixTag: null,
        SourceFields: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["serveriIp"] = "192.168.202.1",
            ["ntbookHostname"] = "ntbook-1.gkm.ru"
        },
        ReceivedAt: DateTimeOffset.UtcNow,
        Payload: JsonDocument.Parse("{}").RootElement.Clone()), rules, CancellationToken.None);

    AssertFieldMissing(resolved, "serveriIp");
    AssertField(resolved, "ntbookHostname", "ntbook-1.gkm.ru");
    AssertNoRequests(cmdb);
}

static async Task UpdateResolvesUnrootedReferenceLeafCards()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["referenceIp"] = new()
        {
            Source = "addressRef",
            CmdbPath = "addressRef.Ip",
            Type = "ipAddress",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "cmdbPath",
                ValueMode = "leaf",
                MaxDepth = 2
            }
        }
    });

    var resolved = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["referenceIp"] = "address-1"
    }), rules, CancellationToken.None);

    AssertField(resolved, "referenceIp", "10.20.0.10");
}

static async Task UpdateMapsReferenceLeafPayloadKeyIntoProfileInterface()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var converter = CreateConverter();
    var rules = new ConversionRulesDocument
    {
        SchemaVersion = "test",
        RulesVersion = "test",
        Name = "cmdb-resolver-reference-ip-tests",
        Source = new SourceRules
        {
            Fields = new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
            {
                ["entityId"] = new() { Source = "id", Required = true },
                ["className"] = new() { Source = "className", Required = true },
                ["code"] = new() { Source = "code" },
                ["ipAddress"] = new()
                {
                    Source = "ip_address",
                    ValidationRegex = "^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$"
                },
                ["referenceIp"] = new()
                {
                    Source = "ipaddress",
                    CmdbPath = "Server.addressRef.Ip",
                    Type = "ipAddress",
                    Resolve = new SourceFieldResolveRule
                    {
                        Mode = "cmdbPath",
                        ValueMode = "leaf",
                        MaxDepth = 2
                    }
                }
            }
        },
        Zabbix = new ZabbixRules
        {
            Method = "host.update"
        },
        EventRoutingRules =
        [
            new EventRoutingRule
            {
                EventType = "update",
                Method = "host.update",
                TemplateName = "hostUpdateJsonRpcRequestLines",
                RequiredFields = ["entityId", "className", "interfaceAddress"],
                Publish = true
            }
        ],
        HostProfiles =
        [
            new HostProfileRule
            {
                Name = "server-main",
                Priority = 10,
                Enabled = true,
                When = new RuleCondition
                {
                    AllRegex =
                    [
                        new RegexCondition { Field = "className", Pattern = "(?i)^Server$" }
                    ]
                },
                HostNameTemplate = "cmdb-<#= Model.ClassName #>-<#= Model.Code ?? Model.EntityId #>",
                VisibleNameTemplate = "<#= Model.ClassName #> <#= Model.Code ?? Model.EntityId #>",
                Interfaces =
                [
                    new HostProfileInterfaceRule
                    {
                        Name = "server-main-agent-ip",
                        Priority = 10,
                        Mode = "ip",
                        ValueField = "referenceIp",
                        When = new RuleCondition { FieldExists = "referenceIp" }
                    }
                ]
            }
        ],
        T4Templates = new T4TemplateSet
        {
            HostUpdateJsonRpcRequestLines =
            [
                "{",
                "  \"jsonrpc\": \"2.0\",",
                "  \"method\": \"<#= Model.CurrentMethod #>\",",
                "  \"params\": {",
                "    \"interfaces\": [",
                "<# for (var i = 0; i < Model.Interfaces.Count; i++) { var item = Model.Interfaces[i]; #>",
                "      { \"ip\": \"<#= item.Ip #>\", \"dns\": \"<#= item.Dns #>\" }<#= i == Model.Interfaces.Count - 1 ? \"\" : \",\" #>",
                "<# } #>",
                "    ]",
                "  },",
                "  \"id\": <#= Model.RequestId #>",
                "}"
            ]
        }
    };

    var source = new CmdbEventReader().Read(JsonSerializer.Serialize(new
    {
        payload = new Dictionary<string, string>
        {
            ["id"] = "server-1",
            ["eventType"] = "update",
            ["className"] = "Server",
            ["code"] = "server-1",
            ["ip_address"] = "address-1"
        }
    }), rules);

    if (source.SourceFields.ContainsKey("referenceIp"))
    {
        throw new InvalidOperationException("referenceIp must not require an ip_address alias in source field rules.");
    }

    var resolved = await resolver.ResolveAsync(source, rules, CancellationToken.None);
    AssertField(resolved, "referenceIp", "10.20.0.10");

    var converted = await converter.ConvertAsync(resolved, rules, CancellationToken.None);
    AssertInterfaceIp(converted, "10.20.0.10");
    AssertMainProfileMetadata(converted, expected: true);
}

static async Task UpdateRereadsDomainLeafCards()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var rules = RulesWithFields(new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
    {
        ["domainServiceName"] = new()
        {
            Source = "id",
            CmdbPath = "Server.{domain:Service}.Name",
            Type = "string",
            Resolve = new SourceFieldResolveRule
            {
                Mode = "cmdbPath",
                ValueMode = "leaf",
                CollectionMode = "join",
                CollectionSeparator = "; ",
                MaxDepth = 2
            }
        }
    });

    cmdb.Revision = 1;
    var first = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server"
    }), rules, CancellationToken.None);
    AssertField(first, "domainServiceName", "Payments old");

    cmdb.Revision = 2;
    var second = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server"
    }), rules, CancellationToken.None);
    AssertField(second, "domainServiceName", "Payments new");
}

static async Task UpdateMapsRereadDomainLeafIntoDynamicHostGroups()
{
    var cmdb = new FakeCmdbuild();
    var resolver = CreateResolver(cmdb);
    var converter = CreateConverter();
    var rules = new ConversionRulesDocument
    {
        SchemaVersion = "test",
        RulesVersion = "test",
        Name = "cmdb-resolver-update-tests",
        Source = new SourceRules
        {
            Fields = new Dictionary<string, SourceFieldRule>(StringComparer.OrdinalIgnoreCase)
            {
                ["domainServiceName"] = new()
                {
                    Source = "id",
                    CmdbPath = "Server.{domain:Service}.Name",
                    Type = "string",
                    Resolve = new SourceFieldResolveRule
                    {
                        Mode = "cmdbPath",
                        ValueMode = "leaf",
                        CollectionMode = "join",
                        CollectionSeparator = "; ",
                        MaxDepth = 2
                    }
                }
            }
        },
        Zabbix = new ZabbixRules
        {
            Method = "host.update"
        },
        EventRoutingRules =
        [
            new EventRoutingRule
            {
                EventType = "update",
                Method = "host.update",
                TemplateName = "hostUpdateJsonRpcRequestLines",
                Publish = true
            }
        ],
        HostProfiles =
        [
            new HostProfileRule
            {
                Name = "main",
                Priority = 10,
                Enabled = true,
                When = new RuleCondition { Always = true },
                HostNameTemplate = "cmdb-<#= Model.ClassName #>-<#= Model.Code ?? Model.EntityId #>",
                VisibleNameTemplate = "<#= Model.ClassName #> <#= Model.Code ?? Model.EntityId #>"
            }
        ],
        GroupSelectionRules =
        [
            new SelectionRule
            {
                Name = "dynamic-domain-service-group",
                Priority = 10,
                TargetMode = "dynamicFromLeaf",
                ValueField = "domainServiceName",
                CreateIfMissing = true,
                When = new RuleCondition
                {
                    FieldExists = "domainServiceName"
                },
                HostGroups =
                [
                    new LookupItem
                    {
                        NameTemplate = "<#= Model.Field(\"domainServiceName\") #>",
                        CreateIfMissing = true
                    }
                ]
            }
        ],
        T4Templates = new T4TemplateSet
        {
            HostUpdateJsonRpcRequestLines =
            [
                "{",
                "  \"jsonrpc\": \"2.0\",",
                "  \"method\": \"<#= Model.CurrentMethod #>\",",
                "  \"params\": {",
                "    \"host\": \"<#= Model.Host #>\",",
                "    \"groups\": [",
                "<# for (var i = 0; i < Model.Groups.Count; i++) { var group = Model.Groups[i]; #>",
                "      { \"name\": \"<#= group.Name #>\", \"createIfMissing\": <#= group.CreateIfMissing ? \"true\" : \"false\" #> }<#= i == Model.Groups.Count - 1 ? \"\" : \",\" #>",
                "<# } #>",
                "    ]",
                "  },",
                "  \"id\": <#= Model.RequestId #>",
                "}"
            ]
        }
    };

    cmdb.Revision = 1;
    var firstSource = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["code"] = "server-1"
    }), rules, CancellationToken.None);
    var first = await converter.ConvertAsync(firstSource, rules, CancellationToken.None);
    AssertDynamicGroup(first, "Payments old");

    cmdb.Revision = 2;
    var secondSource = await resolver.ResolveAsync(UpdateEvent(new()
    {
        ["id"] = "server-1",
        ["className"] = "Server",
        ["code"] = "server-1"
    }), rules, CancellationToken.None);
    var second = await converter.ConvertAsync(secondSource, rules, CancellationToken.None);
    AssertDynamicGroup(second, "Payments new");
}

static CmdbSourceFieldResolver CreateResolver(FakeCmdbuild cmdb, int lookupCacheTtlSeconds = 0)
{
    var httpClient = new HttpClient(cmdb)
    {
        BaseAddress = new Uri("http://cmdbuild.test")
    };
    return new CmdbSourceFieldResolver(
        httpClient,
        Options.Create(new CmdbuildOptions
        {
            BaseUrl = "http://cmdbuild.test",
            Username = "admin",
            Password = "admin",
            RequestTimeoutMs = 5000,
            MaxPathDepth = 2,
            Enabled = true,
            LookupCacheTtlSeconds = lookupCacheTtlSeconds
        }),
        Options.Create(new ExtendedDebugLoggingOptions()),
        NullLogger<CmdbSourceFieldResolver>.Instance);
}

static CmdbToZabbixConverter CreateConverter()
{
    return new CmdbToZabbixConverter(
        new T4TemplateRenderer(Options.Create(new ConversionRulesOptions
        {
            AddDefaultDirectives = true
        })),
        Options.Create(new ConversionRulesOptions
        {
            AddDefaultDirectives = true
        }));
}

static ConversionRulesDocument RulesWithFields(Dictionary<string, SourceFieldRule> fields)
{
    return new ConversionRulesDocument
    {
        SchemaVersion = "test",
        RulesVersion = "test",
        Name = "cmdb-resolver-update-tests",
        Source = new SourceRules
        {
            Fields = fields
        }
    };
}

static CmdbSourceEvent UpdateEvent(Dictionary<string, string> fields)
{
    return new CmdbSourceEvent(
        Source: "cmdbuild",
        EventType: "update",
        EntityType: "Server",
        EntityId: fields.GetValueOrDefault("id"),
        Code: "server-1",
        ClassName: fields.GetValueOrDefault("className"),
        IpAddress: null,
        DnsName: null,
        ZabbixHostId: null,
        Description: null,
        OperatingSystem: null,
        ZabbixTag: null,
        SourceFields: fields,
        ReceivedAt: DateTimeOffset.UtcNow,
        Payload: JsonDocument.Parse("{}").RootElement.Clone());
}

static void AssertField(CmdbSourceEvent source, string fieldName, string expected)
{
    if (!source.SourceFields.TryGetValue(fieldName, out var actual))
    {
        throw new InvalidOperationException($"Expected field '{fieldName}' to be present with value '{expected}'.");
    }

    if (!string.Equals(actual, expected, StringComparison.Ordinal))
    {
        throw new InvalidOperationException($"Expected field '{fieldName}' to be '{expected}', got '{actual}'.");
    }
}

static void AssertFieldMissing(CmdbSourceEvent source, string fieldName)
{
    if (source.SourceFields.ContainsKey(fieldName))
    {
        throw new InvalidOperationException($"Expected field '{fieldName}' to be removed.");
    }
}

static void AssertNoRequests(FakeCmdbuild cmdb)
{
    if (cmdb.RequestPaths.Count != 0)
    {
        throw new InvalidOperationException($"Expected no CMDBuild requests, got [{string.Join(", ", cmdb.RequestPaths)}].");
    }
}

static void AssertEqual<T>(T expected, T actual, string label)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{label}: expected '{expected}', got '{actual}'.");
    }
}

static void AssertDynamicGroup(IReadOnlyList<ZabbixConversionResult> results, string expectedName)
{
    if (results.Count != 1)
    {
        throw new InvalidOperationException($"Expected one conversion result, got {results.Count}.");
    }

    var result = results[0];
    if (!result.ShouldPublish || string.IsNullOrWhiteSpace(result.Value))
    {
        throw new InvalidOperationException($"Expected publishable conversion result, got skip '{result.SkipReason}'.");
    }

    using var document = JsonDocument.Parse(result.Value);
    var groups = document.RootElement.GetProperty("params").GetProperty("groups");
    var names = groups.EnumerateArray()
        .Select(item => item.GetProperty("name").GetString())
        .Where(item => !string.IsNullOrWhiteSpace(item))
        .ToArray();
    if (!names.Contains(expectedName, StringComparer.Ordinal))
    {
        throw new InvalidOperationException(
            $"Expected dynamic host group '{expectedName}', got [{string.Join(", ", names)}].");
    }
}

static void AssertInterfaceIp(IReadOnlyList<ZabbixConversionResult> results, string expectedIp)
{
    if (results.Count != 1)
    {
        throw new InvalidOperationException($"Expected one conversion result, got {results.Count}.");
    }

    var result = results[0];
    if (!result.ShouldPublish || string.IsNullOrWhiteSpace(result.Value))
    {
        throw new InvalidOperationException($"Expected publishable conversion result, got skip '{result.SkipReason}'.");
    }

    using var document = JsonDocument.Parse(result.Value);
    var interfaces = document.RootElement.GetProperty("params").GetProperty("interfaces");
    var ips = interfaces.EnumerateArray()
        .Select(item => item.GetProperty("ip").GetString())
        .Where(item => !string.IsNullOrWhiteSpace(item))
        .ToArray();
    if (!ips.Contains(expectedIp, StringComparer.Ordinal))
    {
        throw new InvalidOperationException(
            $"Expected interface IP '{expectedIp}', got [{string.Join(", ", ips)}].");
    }
}

static void AssertMainProfileMetadata(IReadOnlyList<ZabbixConversionResult> results, bool expected)
{
    if (results.Count != 1)
    {
        throw new InvalidOperationException($"Expected one conversion result, got {results.Count}.");
    }

    var result = results[0];
    if (!result.ShouldPublish || string.IsNullOrWhiteSpace(result.Value))
    {
        throw new InvalidOperationException($"Expected publishable conversion result, got skip '{result.SkipReason}'.");
    }

    using var document = JsonDocument.Parse(result.Value);
    var actual = document.RootElement
        .GetProperty("cmdb2monitoring")
        .GetProperty("isMainProfile")
        .GetBoolean();
    if (actual != expected)
    {
        throw new InvalidOperationException($"Expected isMainProfile={expected}, got {actual}.");
    }
}

sealed class FakeCmdbuild : HttpMessageHandler
{
    public int Revision { get; set; } = 1;

    public List<string> RequestPaths { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri?.AbsolutePath ?? string.Empty;
        RequestPaths.Add(path);
        var json = path switch
        {
            "/classes/Server/attributes" => DataArray(
                new { name = "addressRef", type = "reference", targetClass = "Address" }),
            "/classes/Address/attributes" => DataArray(
                new { name = "Ip", type = "string" }),
            "/classes/Address/cards/address-1" => DataObject(new
            {
                _id = "address-1",
                Ip = Revision == 1 ? "10.20.0.10" : "10.20.0.20"
            }),
            "/classes/Server/cards/server-1/relations" => DataArray(new
            {
                source = new { _type = "Server", _id = "server-1" },
                destination = new { _type = "Service", _id = "service-1" }
            }),
            "/classes/Service/attributes" => DataArray(
                new { name = "Name", type = "string" }),
            "/classes/Service/cards/service-1" => DataObject(new
            {
                _id = "service-1",
                Name = Revision == 1 ? "Payments old" : "Payments new"
            }),
            "/lookup_types/LifecycleState/values" => Revision == 1
                ? DataArray(
                    new { _id = "1", code = "active", description = "Active" },
                    new { _id = "2", code = "standby-old", description = "Standby old" })
                : DataArray(
                    new { _id = "1", code = "active", description = "Active" },
                    new { _id = "2", code = "business-hours", description = "Business hours" }),
            _ => throw new InvalidOperationException($"Unexpected CMDBuild request: {path}")
        };

        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        });
    }

    private static string DataArray(params object[] items)
    {
        return JsonSerializer.Serialize(new { success = true, data = items });
    }

    private static string DataObject(object item)
    {
        return JsonSerializer.Serialize(new { success = true, data = item });
    }
}
