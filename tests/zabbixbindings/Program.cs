using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CmdbKafka2Zabbix.Conversion;
using Confluent.Kafka;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Cmdbuild;
using ZabbixBindings2Cmdbuild.Models;
using ZabbixRequests2Api.Kafka;
using ZabbixRequests2Api.Zabbix;
using BindingCmdbuildOptions = ZabbixBindings2Cmdbuild.Cmdbuild.CmdbuildOptions;
using ConverterCmdbuildOptions = CmdbKafka2Zabbix.Configuration.CmdbuildOptions;

var tests = new (string Name, Func<Task> Run)[]
{
    ("binding event reader applies defaults", BindingEventReaderAppliesDefaults),
    ("binding event reader rejects missing required fields", BindingEventReaderRejectsMissingRequiredFields),
    ("binding client writes main zabbix_main_hostid", BindingClientWritesMainHostId),
    ("binding client clears main zabbix_main_hostid on delete", BindingClientClearsMainHostIdOnDelete),
    ("binding client creates additional profile card", BindingClientCreatesAdditionalProfileCard),
    ("binding client updates existing additional profile card", BindingClientUpdatesExistingAdditionalProfileCard),
    ("host binding resolver reads main zabbix_main_hostid", HostBindingResolverReadsMainHostId),
    ("host binding resolver reads active additional profile binding", HostBindingResolverReadsAdditionalBinding),
    ("host binding resolver ignores deleted additional profile binding", HostBindingResolverIgnoresDeletedAdditionalBinding),
    ("host binding resolver disabled makes no CMDB call", HostBindingResolverDisabledMakesNoCall),
    ("host binding resolver falls back on CMDB error", HostBindingResolverFallsBackOnCmdbError),
    ("zabbix processing result extracts create hostid", ZabbixProcessingResultExtractsCreateHostId),
    ("zabbix processing result keeps update hostid from request", ZabbixProcessingResultKeepsUpdateHostId),
    ("binding publisher contract renders delete payload", BindingPublisherContractRendersDeletePayload),
    ("binding publisher contract renders configured headers", BindingPublisherContractRendersConfiguredHeaders),
    ("binding publisher contract only publishes successful host writes", BindingPublisherContractOnlyPublishesSuccessfulHostWrites)
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
    Console.Error.WriteLine("Zabbix binding regression tests failed:");
    foreach (var failure in failures)
    {
        Console.Error.WriteLine($"- {failure}");
    }

    return 1;
}

Console.WriteLine("Zabbix binding regression tests passed.");
return 0;

static Task BindingEventReaderAppliesDefaults()
{
    var bindingEvent = new ZabbixBindingEventReader().Read(
        """
        {
          "eventType": "zabbix.host.binding.created",
          "operation": "host.create",
          "sourceClass": "CIClass",
          "sourceCardId": 101,
          "isMainProfile": "true",
          "zabbixHostId": 501
        }
        """);

    AssertEqual("zabbixrequests2api", bindingEvent.Source, "source");
    AssertEqual("101", bindingEvent.SourceCardId, "sourceCardId");
    AssertEqual("main", bindingEvent.HostProfile, "hostProfile");
    AssertEqual("active", bindingEvent.BindingStatus, "bindingStatus");
    AssertEqual("501", bindingEvent.ZabbixHostId, "zabbixHostId");
    AssertTrue(bindingEvent.IsMainProfile, "isMainProfile");
    return Task.CompletedTask;
}

static Task BindingEventReaderRejectsMissingRequiredFields()
{
    AssertThrows<JsonException>(() => new ZabbixBindingEventReader().Read(
        """
        {
          "eventType": "zabbix.host.binding.created",
          "sourceClass": "CIClass",
          "sourceCardId": "101"
        }
        """));
    return Task.CompletedTask;
}

static async Task BindingClientWritesMainHostId()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Put,
        "/classes/CIClass/cards/101",
        request =>
        {
            AssertCmdbHeaders(request);
            AssertJsonBody(request, body =>
            {
                AssertEqual("501", ReadString(body, "zabbix_main_hostid"), "zabbix_main_hostid");
            });
        },
        """{"data":{}}""");

    var client = CreateBindingClient(handler);
    await client.ApplyAsync(BindingEvent(isMainProfile: true, operation: "host.create", status: "active"), CancellationToken.None);

    handler.AssertAllRequestsConsumed();
}

static async Task BindingClientClearsMainHostIdOnDelete()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Put,
        "/classes/CIClass/cards/101",
        request => AssertJsonBody(request, body =>
        {
            AssertTrue(body.ContainsKey("zabbix_main_hostid"), "delete body must include zabbix_main_hostid");
            AssertTrue(body["zabbix_main_hostid"] is null, "delete must clear zabbix_main_hostid");
        }),
        """{"data":{}}""");

    var client = CreateBindingClient(handler);
    await client.ApplyAsync(BindingEvent(isMainProfile: true, operation: "host.delete", status: "deleted"), CancellationToken.None);

    handler.AssertAllRequestsConsumed();
}

static async Task BindingClientCreatesAdditionalProfileCard()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(HttpMethod.Get, "/classes/ZabbixHostBinding/cards?limit=1000", _ => { }, """{"data":[]}""");
    handler.ExpectJson(
        HttpMethod.Post,
        "/classes/ZabbixHostBinding/cards",
        request => AssertJsonBody(request, body =>
        {
            AssertEqual("CIClass", ReadString(body, "OwnerClass"), "OwnerClass");
            AssertEqual("101", ReadString(body, "OwnerCardId"), "OwnerCardId");
            AssertEqual("CI-101", ReadString(body, "OwnerCode"), "OwnerCode");
            AssertEqual("management", ReadString(body, "HostProfile"), "HostProfile");
            AssertEqual("501", ReadString(body, "ZabbixHostId"), "ZabbixHostId");
            AssertEqual("cmdb-ci-101-management", ReadString(body, "ZabbixHostName"), "ZabbixHostName");
            AssertEqual("active", ReadString(body, "BindingStatus"), "BindingStatus");
            AssertEqual("rv-1", ReadString(body, "RulesVersion"), "RulesVersion");
            AssertTrue(DateTimeOffset.TryParse(ReadString(body, "LastSyncAt"), out _), "LastSyncAt must be ISO timestamp");
        }),
        """{"data":{"_id":"binding-1"}}""");

    var client = CreateBindingClient(handler);
    await client.ApplyAsync(BindingEvent(isMainProfile: false, profile: "management"), CancellationToken.None);

    handler.AssertAllRequestsConsumed();
}

static async Task BindingClientUpdatesExistingAdditionalProfileCard()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Get,
        "/classes/ZabbixHostBinding/cards?limit=1000",
        _ => { },
        """
        {
          "data": [
            { "_id": "other", "OwnerClass": "Other", "OwnerCardId": "101", "HostProfile": "management" },
            { "_id": "binding-9", "OwnerClass": "CIClass", "OwnerCardId": "101", "HostProfile": "management" }
          ]
        }
        """);
    handler.ExpectJson(
        HttpMethod.Put,
        "/classes/ZabbixHostBinding/cards/binding-9",
        request => AssertJsonBody(request, body =>
        {
            AssertEqual("CIClass", ReadString(body, "OwnerClass"), "OwnerClass");
            AssertEqual("101", ReadString(body, "OwnerCardId"), "OwnerCardId");
            AssertEqual("management", ReadString(body, "HostProfile"), "HostProfile");
            AssertEqual("501", ReadString(body, "ZabbixHostId"), "ZabbixHostId");
        }),
        """{"data":{"_id":"binding-9"}}""");

    var client = CreateBindingClient(handler);
    await client.ApplyAsync(BindingEvent(isMainProfile: false, profile: "management"), CancellationToken.None);

    handler.AssertAllRequestsConsumed();
}

static async Task HostBindingResolverReadsMainHostId()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Get,
        "/classes/CIClass/cards/101",
        AssertCmdbHeaders,
        """{"data":{"zabbix_main_hostid":"701"}}""");

    var resolver = CreateHostBindingResolver(handler);
    var hostId = await resolver.ResolveHostIdAsync(SourceEvent(), "main", isMainProfile: true, CancellationToken.None);

    AssertEqual("701", hostId, "hostId");
    handler.AssertAllRequestsConsumed();
}

static async Task HostBindingResolverReadsAdditionalBinding()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Get,
        "/classes/ZabbixHostBinding/cards?limit=1000",
        _ => { },
        """
        {
          "data": [
            { "OwnerClass": "Other", "OwnerCardId": "101", "HostProfile": "management", "ZabbixHostId": "wrong" },
            { "OwnerClass": "CIClass", "OwnerCardId": "101", "HostProfile": "management", "BindingStatus": "active", "ZabbixHostId": "702" }
          ]
        }
        """);

    var resolver = CreateHostBindingResolver(handler);
    var hostId = await resolver.ResolveHostIdAsync(SourceEvent(), "management", isMainProfile: false, CancellationToken.None);

    AssertEqual("702", hostId, "hostId");
    handler.AssertAllRequestsConsumed();
}

static async Task HostBindingResolverIgnoresDeletedAdditionalBinding()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Get,
        "/classes/ZabbixHostBinding/cards?limit=1000",
        _ => { },
        """
        {
          "data": [
            { "OwnerClass": "CIClass", "OwnerCardId": "101", "HostProfile": "management", "BindingStatus": "deleted", "ZabbixHostId": "old" },
            { "OwnerClass": "CIClass", "OwnerCardId": "101", "HostProfile": "management", "BindingStatus": "active", "ZabbixHostId": "703" }
          ]
        }
        """);

    var resolver = CreateHostBindingResolver(handler);
    var hostId = await resolver.ResolveHostIdAsync(SourceEvent(), "management", isMainProfile: false, CancellationToken.None);

    AssertEqual("703", hostId, "hostId");
    handler.AssertAllRequestsConsumed();
}

static async Task HostBindingResolverDisabledMakesNoCall()
{
    var handler = new FakeHttpMessageHandler();
    var resolver = CreateHostBindingResolver(handler, new ConverterCmdbuildOptions
    {
        BaseUrl = "http://cmdb.example",
        Username = "svc",
        Password = "secret",
        HostBindingLookupEnabled = false
    });

    var hostId = await resolver.ResolveHostIdAsync(SourceEvent(), "main", isMainProfile: true, CancellationToken.None);

    AssertNull(hostId, "hostId");
    AssertEqual(0, handler.Requests.Count, "HTTP call count");
}

static async Task HostBindingResolverFallsBackOnCmdbError()
{
    var handler = new FakeHttpMessageHandler();
    handler.ExpectJson(
        HttpMethod.Get,
        "/classes/CIClass/cards/101",
        _ => { },
        """{"error":"unavailable"}""",
        HttpStatusCode.InternalServerError);

    var resolver = CreateHostBindingResolver(handler);
    var hostId = await resolver.ResolveHostIdAsync(SourceEvent(), "main", isMainProfile: true, CancellationToken.None);

    AssertNull(hostId, "hostId");
    handler.AssertAllRequestsConsumed();
}

static Task ZabbixProcessingResultExtractsCreateHostId()
{
    var request = RequestDocument(
        method: "host.create",
        host: "cmdb-ci-101",
        hostProfile: "main",
        isMainProfile: true,
        paramsJson: """{"host":"cmdb-ci-101"}""");
    var result = ZabbixProcessingResult.FromApiResult(
        request,
        new ZabbixApiCallResult(true, """{"result":{"hostids":["901"]}}""", null, null));

    AssertEqual("901", result.ZabbixHostId, "ZabbixHostId");
    AssertEqual("CIClass", result.SourceClass, "SourceClass");
    AssertEqual("101", result.SourceCardId, "SourceCardId");
    AssertTrue(result.IsMainProfile, "IsMainProfile");
    return Task.CompletedTask;
}

static Task ZabbixProcessingResultKeepsUpdateHostId()
{
    var request = RequestDocument(
        method: "host.update",
        host: "cmdb-ci-101",
        hostProfile: "management",
        isMainProfile: false,
        paramsJson: """{"hostid":"902","host":"cmdb-ci-101-management"}""");
    var result = ZabbixProcessingResult.FromApiResult(
        request,
        new ZabbixApiCallResult(true, """{"result":{"hostids":[]}}""", null, null));

    AssertEqual("902", result.ZabbixHostId, "ZabbixHostId");
    AssertEqual("management", result.HostProfileName, "HostProfileName");
    AssertTrue(!result.IsMainProfile, "IsMainProfile");
    return Task.CompletedTask;
}

static Task BindingPublisherContractRendersDeletePayload()
{
    var result = ProcessingResult(method: "host.delete", isMainProfile: false, hostProfile: "management");
    var payload = InvokePrivate<string>(
        typeof(ZabbixBindingEventPublisher),
        "BuildPayload",
        result,
        ConsumeResult(),
        "zabbix.host.binding.deleted",
        "deleted");
    var bindingEvent = new ZabbixBindingEventReader().Read(payload);

    AssertEqual("zabbix.host.binding.deleted", bindingEvent.EventType, "EventType");
    AssertEqual("host.delete", bindingEvent.Operation, "Operation");
    AssertEqual("CIClass", bindingEvent.SourceClass, "SourceClass");
    AssertEqual("101", bindingEvent.SourceCardId, "SourceCardId");
    AssertEqual("management", bindingEvent.HostProfile, "HostProfile");
    AssertEqual("deleted", bindingEvent.BindingStatus, "BindingStatus");
    AssertEqual("902", bindingEvent.ZabbixHostId, "ZabbixHostId");
    AssertTrue(!bindingEvent.IsMainProfile, "IsMainProfile");

    using var document = JsonDocument.Parse(payload);
    var input = document.RootElement.GetProperty("input");
    AssertEqual("zabbix.host.requests.dev", input.GetProperty("topic").GetString(), "input.topic");
    AssertEqual(7, input.GetProperty("partition").GetInt32(), "input.partition");
    AssertEqual(42, input.GetProperty("offset").GetInt64(), "input.offset");
    AssertEqual("CIClass:101:management", input.GetProperty("key").GetString(), "input.key");
    return Task.CompletedTask;
}

static Task BindingPublisherContractRendersConfiguredHeaders()
{
    var result = ProcessingResult(method: "host.update", isMainProfile: false, hostProfile: "management");
    var options = new KafkaBindingOutputOptions
    {
        EventTypeHeaderName = "x-event",
        HostProfileHeaderName = "x-profile",
        BindingStatusHeaderName = "x-status"
    };
    var headers = InvokePrivate<Headers>(
        typeof(ZabbixBindingEventPublisher),
        "BuildHeaders",
        result,
        options,
        "zabbix.host.binding.updated",
        "active");

    AssertEqual("zabbix.host.binding.updated", HeaderString(headers, "x-event"), "x-event");
    AssertEqual("management", HeaderString(headers, "x-profile"), "x-profile");
    AssertEqual("active", HeaderString(headers, "x-status"), "x-status");
    return Task.CompletedTask;
}

static Task BindingPublisherContractOnlyPublishesSuccessfulHostWrites()
{
    AssertTrue(ShouldPublish(ProcessingResult(method: "host.create")), "host.create should publish");
    AssertTrue(ShouldPublish(ProcessingResult(method: "host.update")), "host.update should publish");
    AssertTrue(ShouldPublish(ProcessingResult(method: "host.delete")), "host.delete should publish");
    AssertTrue(!ShouldPublish(ProcessingResult(method: "host.get")), "host.get should not publish");
    AssertTrue(!ShouldPublish(ProcessingResult(method: "host.create", success: false)), "failed host.create should not publish");
    AssertTrue(!ShouldPublish(ProcessingResult(method: "host.create", sent: false)), "unsent host.create should not publish");
    return Task.CompletedTask;
}

static CmdbuildBindingClient CreateBindingClient(FakeHttpMessageHandler handler)
{
    var constructor = typeof(CmdbuildBindingClient).GetConstructors().Single();
    return (CmdbuildBindingClient)constructor.Invoke([
        new HttpClient(handler),
        Options.Create(new BindingCmdbuildOptions
        {
            BaseUrl = "http://cmdb.example",
            Username = "svc",
            Password = "secret",
            MainHostIdAttributeName = "zabbix_main_hostid",
            BindingClassName = "ZabbixHostBinding",
            BindingLookupLimit = 1000
        }),
        CreateDefaultOptions(constructor.GetParameters()[2].ParameterType),
        NullLogger<CmdbuildBindingClient>.Instance
    ])!;
}

static object CreateDefaultOptions(Type optionsInterfaceType)
{
    var optionsType = optionsInterfaceType.GenericTypeArguments.Single();
    var optionsValue = Activator.CreateInstance(optionsType)!;
    var wrapperType = typeof(OptionsWrapper<>).MakeGenericType(optionsType);
    return Activator.CreateInstance(wrapperType, optionsValue)!;
}

static CmdbZabbixHostBindingResolver CreateHostBindingResolver(
    FakeHttpMessageHandler handler,
    ConverterCmdbuildOptions? options = null)
{
    return new CmdbZabbixHostBindingResolver(
        new HttpClient(handler),
        Options.Create(options ?? new ConverterCmdbuildOptions
        {
            BaseUrl = "http://cmdb.example",
            Username = "svc",
            Password = "secret",
            HostBindingLookupEnabled = true,
            MainHostIdAttributeName = "zabbix_main_hostid",
            BindingClassName = "ZabbixHostBinding",
            BindingLookupLimit = 1000
        }),
        NullLogger<CmdbZabbixHostBindingResolver>.Instance);
}

static ZabbixBindingEvent BindingEvent(
    bool isMainProfile,
    string operation = "host.create",
    string status = "active",
    string profile = "main")
{
    return new ZabbixBindingEvent(
        Source: "zabbixrequests2api",
        EventType: operation switch
        {
            "host.delete" => "zabbix.host.binding.deleted",
            "host.update" => "zabbix.host.binding.updated",
            _ => "zabbix.host.binding.created"
        },
        Operation: operation,
        SourceClass: "CIClass",
        SourceCardId: "101",
        SourceCode: "CI-101",
        HostProfile: profile,
        IsMainProfile: isMainProfile,
        ZabbixHostId: "501",
        ZabbixHostName: profile == "main" ? "cmdb-ci-101" : $"cmdb-ci-101-{profile}",
        BindingStatus: status,
        RulesVersion: "rv-1",
        SchemaVersion: "sv-1",
        RequestId: "req-1",
        OccurredAt: DateTimeOffset.Parse("2026-05-05T12:00:00Z"));
}

static CmdbSourceEvent SourceEvent()
{
    return new CmdbSourceEvent(
        Source: "cmdbuild",
        EventType: "update",
        EntityType: "CIClass",
        EntityId: "101",
        Code: "CI-101",
        ClassName: "CIClass",
        IpAddress: null,
        DnsName: null,
        ZabbixHostId: null,
        Description: null,
        OperatingSystem: null,
        ZabbixTag: null,
        SourceFields: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
        ReceivedAt: DateTimeOffset.Parse("2026-05-05T12:00:00Z"),
        Payload: JsonDocument.Parse("""{"id":"101","className":"CIClass"}""").RootElement.Clone());
}

static ZabbixRequestDocument RequestDocument(
    string method,
    string host,
    string hostProfile,
    bool isMainProfile,
    string paramsJson)
{
    using var paramsDocument = JsonDocument.Parse(paramsJson);
    using var rootDocument = JsonDocument.Parse($$"""
        {
          "jsonrpc": "2.0",
          "method": "{{method}}",
          "params": {{paramsJson}},
          "id": 1
        }
        """);

    return new ZabbixRequestDocument
    {
        RawJson = rootDocument.RootElement.GetRawText(),
        ZabbixJson = rootDocument.RootElement.GetRawText(),
        Root = rootDocument.RootElement.Clone(),
        Params = paramsDocument.RootElement.Clone(),
        Id = rootDocument.RootElement.GetProperty("id").Clone(),
        Method = method,
        RequestId = "req-1",
        EntityId = "101",
        Host = host,
        HostProfileName = hostProfile,
        SourceClass = "CIClass",
        SourceCardId = "101",
        SourceCode = "CI-101",
        IsMainProfile = isMainProfile,
        RulesVersion = "rv-1",
        SchemaVersion = "sv-1"
    };
}

static ZabbixProcessingResult ProcessingResult(
    string method,
    bool success = true,
    bool sent = true,
    bool isMainProfile = true,
    string hostProfile = "main")
{
    return new ZabbixProcessingResult(
        Success: success,
        EntityId: "101",
        Method: method,
        RequestId: "req-1",
        Host: hostProfile == "main" ? "cmdb-ci-101" : $"cmdb-ci-101-{hostProfile}",
        HostProfileName: hostProfile,
        SourceClass: "CIClass",
        SourceCardId: "101",
        SourceCode: "CI-101",
        IsMainProfile: isMainProfile,
        RulesVersion: "rv-1",
        SchemaVersion: "sv-1",
        ZabbixHostId: method == "host.create" ? "901" : "902",
        ErrorCode: null,
        ErrorMessage: null,
        MissingHostGroups: [],
        MissingTemplates: [],
        MissingTemplateGroups: [],
        ZabbixRequestSent: sent,
        ZabbixResponseJson: """{"result":{"hostids":["902"]}}""",
        ProcessedAt: DateTimeOffset.Parse("2026-05-05T12:00:00Z"));
}

static ConsumeResult<string, string> ConsumeResult()
{
    return new ConsumeResult<string, string>
    {
        Topic = "zabbix.host.requests.dev",
        Partition = new Partition(7),
        Offset = new Offset(42),
        Message = new Message<string, string>
        {
            Key = "CIClass:101:management",
            Value = "{}"
        }
    };
}

static bool ShouldPublish(ZabbixProcessingResult result)
{
    return InvokePrivate<bool>(typeof(ZabbixBindingEventPublisher), "ShouldPublish", result);
}

static T InvokePrivate<T>(Type type, string methodName, params object?[] args)
{
    var method = type.GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new MissingMethodException(type.FullName, methodName);
    return (T)(method.Invoke(null, args) ?? throw new InvalidOperationException($"{methodName} returned null."));
}

static string HeaderString(Headers headers, string name)
{
    if (!headers.TryGetLastBytes(name, out var bytes) || bytes is null)
    {
        throw new InvalidOperationException($"Header '{name}' was not found.");
    }

    return Encoding.UTF8.GetString(bytes);
}

static void AssertCmdbHeaders(HttpRequestMessage request)
{
    AssertEqual("Basic", request.Headers.Authorization?.Scheme, "Authorization scheme");
    AssertEqual(
        Convert.ToBase64String(Encoding.UTF8.GetBytes("svc:secret")),
        request.Headers.Authorization?.Parameter,
        "Authorization parameter");
    AssertTrue(request.Headers.TryGetValues("CMDBuild-View", out var values), "CMDBuild-View header is missing");
    var viewValues = values?.ToArray() ?? [];
    AssertEqual(1, viewValues.Length, "CMDBuild-View value count");
    AssertEqual("admin", viewValues[0], "CMDBuild-View");
}

static void AssertJsonBody(HttpRequestMessage request, Action<JsonObject> assert)
{
    var contentText = RequestBodyStore.Get(request);
    if (string.IsNullOrWhiteSpace(contentText))
    {
        throw new InvalidOperationException("Expected JSON request body.");
    }

    var node = JsonNode.Parse(contentText);
    if (node is not JsonObject body)
    {
        throw new InvalidOperationException("Expected JSON object request body.");
    }

    assert(body);
}

static string? ReadString(JsonObject body, string propertyName)
{
    var node = body[propertyName];
    return node switch
    {
        null => null,
        JsonValue value when value.TryGetValue<string>(out var stringValue) => stringValue,
        JsonValue value when value.TryGetValue<int>(out var intValue) => intValue.ToString(),
        JsonValue value when value.TryGetValue<long>(out var longValue) => longValue.ToString(),
        JsonValue value when value.TryGetValue<bool>(out var boolValue) => boolValue.ToString(),
        _ => node.ToJsonString()
    };
}

static void AssertEqual<T>(T expected, T actual, string label)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{label}: expected '{expected}', got '{actual}'.");
    }
}

static void AssertTrue(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static void AssertNull(object? value, string label)
{
    if (value is not null)
    {
        throw new InvalidOperationException($"{label}: expected null, got '{value}'.");
    }
}

static void AssertThrows<TException>(Action action)
    where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }

    throw new InvalidOperationException($"Expected exception {typeof(TException).Name} was not thrown.");
}

sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<ExpectedRequest> expectedRequests = new();

    public List<HttpRequestMessage> Requests { get; } = [];

    public void ExpectJson(
        HttpMethod method,
        string pathAndQuery,
        Action<HttpRequestMessage> assertRequest,
        string responseJson,
        HttpStatusCode statusCode = HttpStatusCode.OK)
    {
        expectedRequests.Enqueue(new ExpectedRequest(method, pathAndQuery, assertRequest, responseJson, statusCode));
    }

    public void AssertAllRequestsConsumed()
    {
        if (expectedRequests.Count != 0)
        {
            throw new InvalidOperationException($"Expected {expectedRequests.Count} more HTTP request(s).");
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var contentText = request.Content is null
            ? string.Empty
            : await request.Content.ReadAsStringAsync(cancellationToken);
        RequestBodyStore.Set(request, contentText);
        Requests.Add(request);

        if (expectedRequests.Count == 0)
        {
            throw new InvalidOperationException($"Unexpected HTTP request {request.Method} {request.RequestUri?.PathAndQuery}.");
        }

        var expected = expectedRequests.Dequeue();
        AssertSame(expected.Method, request.Method, "HTTP method");
        AssertSame(expected.PathAndQuery, request.RequestUri?.PathAndQuery, "HTTP path");
        expected.AssertRequest(request);

        return new HttpResponseMessage(expected.StatusCode)
        {
            Content = new StringContent(expected.ResponseJson, Encoding.UTF8, "application/json")
        };
    }

    private sealed record ExpectedRequest(
        HttpMethod Method,
        string PathAndQuery,
        Action<HttpRequestMessage> AssertRequest,
        string ResponseJson,
        HttpStatusCode StatusCode);

    private static void AssertSame<T>(T expected, T actual, string label)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{label}: expected '{expected}', got '{actual}'.");
        }
    }
}

static class RequestBodyStore
{
    private static readonly HttpRequestOptionsKey<string> Key = new("ZabbixBindingsTests.ContentText");

    public static string Get(HttpRequestMessage request)
    {
        return request.Options.TryGetValue(Key, out var value) ? value : string.Empty;
    }

    public static void Set(HttpRequestMessage request, string value)
    {
        request.Options.Set(Key, value);
    }
}
