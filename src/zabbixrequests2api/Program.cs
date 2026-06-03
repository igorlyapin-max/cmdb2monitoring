using Confluent.Kafka;
using Cmdb2Monitoring.Http;
using Cmdb2Monitoring.Kafka;
using Cmdb2Monitoring.Logging;
using Cmdb2Monitoring.Metrics;
using Cmdb2Monitoring.Security;
using Cmdb2Monitoring.Secrets;
using Cmdb2Monitoring.Transport;
using Cmdb2Monitoring.Workers;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using ZabbixRequests2Api.Configuration;
using ZabbixRequests2Api.Kafka;
using ZabbixRequests2Api.Logging;
using ZabbixRequests2Api.Processing;
using ZabbixRequests2Api.Zabbix;

var builder = WebApplication.CreateBuilder(args);
TransportConfigurator.UseConfiguredUrls(builder.WebHost, builder.Configuration, "http://localhost:5082");
await builder.Configuration.ResolveSecretReferencesAsync("zabbixrequests2api");

builder.Services.AddOptions<TransportOptions>()
    .Bind(builder.Configuration.GetSection(TransportOptions.SectionName))
    .Validate(options => options.HasValidMode(), "Transport mode must be Http or Https.")
    .Validate(options => ProductionSecurityGuards.AllowsPlainHttp(builder.Environment, options), "Production transport requires Https unless Transport:AllowPlainHttp is true.")
    .ValidateOnStart();

builder.Services.AddOptions<HostSecurityOptions>()
    .Bind(builder.Configuration.GetSection(HostSecurityOptions.SectionName))
    .Validate(options => ProductionSecurityGuards.AllowsWildcardAllowedHosts(builder.Environment, builder.Configuration["AllowedHosts"], options.AllowWildcardAllowedHosts), "Production AllowedHosts='*' requires HostSecurity:AllowWildcardAllowedHosts=true.")
    .ValidateOnStart();

builder.Services.AddOptions<WorkerRuntimeOptions>()
    .Bind(builder.Configuration.GetSection(WorkerRuntimeOptions.SectionName))
    .Validate(options => options.HasValidReplicaMode(), "Worker replica mode must be SingleActive or ExternalState.")
    .Validate(options => options.ExpectedReplicas > 0, "Worker expected replicas must be greater than zero.")
    .Validate(options => options.AllowsConfiguredReplicaCount(), "Worker ReplicaMode=SingleActive allows only one expected replica unless Worker:AllowMultipleActiveReplicas=true.")
    .Validate(options => options.ShutdownTimeoutSeconds > 0, "Worker shutdown timeout must be greater than zero.")
    .ValidateOnStart();

builder.Services.AddOptions<ServiceOptions>()
    .Bind(builder.Configuration.GetSection(ServiceOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Name), "Service name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.HealthRoute), "Service health route is required.")
    .ValidateOnStart();

builder.Services.AddOptions<KafkaOptions>()
    .Bind(builder.Configuration.GetSection(KafkaOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Input.BootstrapServers), "Kafka input bootstrap servers are required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Input.Topic), "Kafka input topic is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Input.GroupId), "Kafka input group id is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Input.ClientId), "Kafka input client id is required.")
    .Validate(options => options.Input.HasValidSecurityProtocol(), "Kafka input security protocol is invalid.")
    .Validate(options => options.Input.HasValidSaslMechanism(), "Kafka input SASL mechanism is invalid.")
    .Validate(options => options.Input.HasValidSslEndpointIdentificationAlgorithm(), "Kafka input SSL endpoint identification algorithm is invalid.")
    .Validate(options => ProductionSecurityGuards.AllowsKafkaProtocol(builder.Environment, options.Input.SecurityProtocol, options.Input.AllowPlaintextKafka), "Production Kafka input requires Ssl/SaslSsl unless AllowPlaintextKafka is true.")
    .Validate(options => options.Input.HasValidAutoOffsetReset(), "Kafka input auto offset reset is invalid.")
    .Validate(options => options.Input.PollTimeoutMs > 0, "Kafka input poll timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.BootstrapServers), "Kafka output bootstrap servers are required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.Topic), "Kafka output topic is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.ClientId), "Kafka output client id is required.")
    .Validate(options => options.Output.HasValidSecurityProtocol(), "Kafka output security protocol is invalid.")
    .Validate(options => options.Output.HasValidSaslMechanism(), "Kafka output SASL mechanism is invalid.")
    .Validate(options => options.Output.HasValidSslEndpointIdentificationAlgorithm(), "Kafka output SSL endpoint identification algorithm is invalid.")
    .Validate(options => ProductionSecurityGuards.AllowsKafkaProtocol(builder.Environment, options.Output.SecurityProtocol, options.Output.AllowPlaintextKafka), "Production Kafka output requires Ssl/SaslSsl unless AllowPlaintextKafka is true.")
    .Validate(options => options.Output.HasValidAcks(), "Kafka output acks value is invalid.")
    .Validate(options => options.Output.MessageTimeoutMs > 0, "Kafka output message timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.SuccessHeaderName), "Kafka output success header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.MethodHeaderName), "Kafka output method header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.ErrorCodeHeaderName), "Kafka output error code header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.BootstrapServers), "Kafka binding output bootstrap servers are required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.Topic), "Kafka binding output topic is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.ClientId), "Kafka binding output client id is required.")
    .Validate(options => options.BindingOutput.HasValidSecurityProtocol(), "Kafka binding output security protocol is invalid.")
    .Validate(options => options.BindingOutput.HasValidSaslMechanism(), "Kafka binding output SASL mechanism is invalid.")
    .Validate(options => options.BindingOutput.HasValidSslEndpointIdentificationAlgorithm(), "Kafka binding output SSL endpoint identification algorithm is invalid.")
    .Validate(options => ProductionSecurityGuards.AllowsKafkaProtocol(builder.Environment, options.BindingOutput.SecurityProtocol, options.BindingOutput.AllowPlaintextKafka), "Production Kafka binding output requires Ssl/SaslSsl unless AllowPlaintextKafka is true.")
    .Validate(options => options.BindingOutput.HasValidAcks(), "Kafka binding output acks value is invalid.")
    .Validate(options => options.BindingOutput.MessageTimeoutMs > 0, "Kafka binding output message timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.EventTypeHeaderName), "Kafka binding output event type header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.HostProfileHeaderName), "Kafka binding output host profile header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingOutput.BindingStatusHeaderName), "Kafka binding output status header name is required.")
    .ValidateOnStart();

builder.Services.AddOptions<ZabbixOptions>()
    .Bind(builder.Configuration.GetSection(ZabbixOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.ApiEndpoint), "Zabbix API endpoint is required.")
    .Validate(options => ProductionSecurityGuards.AllowsHttpEndpoint(builder.Environment, options.ApiEndpoint, options.Tls.AllowInsecureHttp), "Production Zabbix ApiEndpoint requires https unless Zabbix:Tls:AllowInsecureHttp is true.")
    .Validate(options => !builder.Environment.IsProduction() || options.Tls.RejectUnauthorized, "Production Zabbix TLS must reject unauthorized certificates.")
    .Validate(options => options.HasValidAuthMode(), "Zabbix auth mode is invalid.")
    .Validate(options => options.RequestTimeoutMs > 0, "Zabbix request timeout must be greater than zero.")
    .Validate(options => options.HostGroupCacheTtlSeconds >= 0, "Zabbix host group cache TTL cannot be negative.")
    .Validate(options => options.TemplateCacheTtlSeconds >= 0, "Zabbix template cache TTL cannot be negative.")
    .Validate(options => options.Resilience.HasValidValues(), "Zabbix resilience settings are invalid.")
    .ValidateOnStart();

builder.Services.AddOptions<ProcessingOptions>()
    .Bind(builder.Configuration.GetSection(ProcessingOptions.SectionName))
    .Validate(options => options.DelayBetweenObjectsMs >= 0, "Delay between objects cannot be negative.")
    .Validate(options => options.MaxRetryAttempts > 0, "Max retry attempts must be greater than zero.")
    .Validate(options => options.RetryDelayMs >= 0, "Retry delay cannot be negative.")
    .Validate(options => options.HasValidRetryBackoffValues(), "Retry backoff settings are invalid.")
    .Validate(options => !options.ProtectManagedAggregateHosts || options.HasProtectedHostMarkers(), "Protected aggregate host guard requires at least one protected host name or tag.")
    .ValidateOnStart();

builder.Services.AddOptions<ProcessingStateOptions>()
    .Bind(builder.Configuration.GetSection(ProcessingStateOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.FilePath), "Processing state file path is required.")
    .ValidateOnStart();

builder.Services.AddOptions<KafkaDeadLetterOptions>()
    .Bind(builder.Configuration.GetSection(KafkaDeadLetterOptions.SectionName))
    .Validate(options => !options.Enabled || !string.IsNullOrWhiteSpace(options.Topic), "DeadLetter topic is required when DeadLetter is enabled.")
    .ValidateOnStart();

builder.Services.AddOptions<ElkLoggingOptions>()
    .Bind(builder.Configuration.GetSection(ElkLoggingOptions.SectionName))
    .Validate(options => options.HasValidMode(), "ELK logging mode is invalid.")
    .Validate(options => !options.Enabled || options.Kafka.Enabled || options.Elk.Enabled, "At least one ELK logging destination must be enabled.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || !string.IsNullOrWhiteSpace(options.Kafka.BootstrapServers), "ELK Kafka bootstrap servers are required.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || !string.IsNullOrWhiteSpace(options.Kafka.Topic), "ELK Kafka topic is required.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || !string.IsNullOrWhiteSpace(options.Kafka.ClientId), "ELK Kafka client id is required.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.HasValidSecurityProtocol(), "ELK Kafka security protocol is invalid.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.HasValidSaslMechanism(), "ELK Kafka SASL mechanism is invalid.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.HasValidAcks(), "ELK Kafka acks value is invalid.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.MessageTimeoutMs > 0, "ELK Kafka message timeout must be greater than zero.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.HasValidMinimumLevel(), "ELK Kafka minimum log level is invalid.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || !string.IsNullOrWhiteSpace(options.Kafka.ServiceName), "ELK Kafka service name is required.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || !string.IsNullOrWhiteSpace(options.Kafka.Environment), "ELK Kafka environment is required.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.FlushTimeoutMs > 0, "ELK Kafka flush timeout must be greater than zero.")
    .ValidateOnStart();

builder.Services.AddOptions<ExtendedDebugLoggingOptions>()
    .Bind(builder.Configuration.GetSection(ExtendedDebugLoggingOptions.SectionName))
    .Validate(options => options.HasValidLevel(), "Debug logging level must be Basic or Verbose.")
    .ValidateOnStart();

builder.Services.AddSingleton<IProducer<string, string>>(services =>
{
    var options = services.GetRequiredService<IOptions<KafkaOptions>>().Value;

    return new ProducerBuilder<string, string>(options.Output.BuildProducerConfig()).Build();
});

builder.Logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, KafkaElkLoggerProvider>());

builder.Services.AddHttpClient<ZabbixClient>((services, client) =>
{
    var options = services.GetRequiredService<IOptions<ZabbixOptions>>().Value;
    client.Timeout = TimeSpan.FromMilliseconds(options.RequestTimeoutMs);
})
    .ConfigurePrimaryHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<ZabbixOptions>>().Value;
        return HttpClientTlsConfigurator.CreateHandler(options.Tls);
    })
    .AddHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<ZabbixOptions>>().Value;
        var logger = services.GetRequiredService<ILogger<HttpClientResilienceHandler>>();
        return new HttpClientResilienceHandler(options.Resilience, logger);
    });
builder.Services.AddSingleton<IZabbixClient>(services => services.GetRequiredService<ZabbixClient>());
builder.Services.AddSingleton<ZabbixRequestReader>();
builder.Services.AddSingleton<ZabbixRequestValidator>();
builder.Services.AddSingleton<ZabbixDynamicHostGroupResolver>();
builder.Services.AddSingleton<IZabbixResponsePublisher, ZabbixResponsePublisher>();
builder.Services.AddSingleton<IZabbixBindingEventPublisher, ZabbixBindingEventPublisher>();
builder.Services.AddSingleton<IKafkaDeadLetterPublisher, KafkaDeadLetterPublisher>();
builder.Services.AddSingleton<IProcessingStateStore, FileProcessingStateStore>();
builder.Services.AddSingleton<IServiceMetrics, ServiceMetrics>();
builder.Services.AddSingleton<IReadinessCheck>(services =>
{
    var options = services.GetRequiredService<IOptions<ProcessingStateOptions>>();
    return ReadinessChecks.WritableStateFile(
        "processing-state",
        () => (options.Value.FilePath, options.Value.BaseDirectory));
});
builder.Services.AddHostedService<KafkaZabbixRequestWorker>();

var app = builder.Build();
var serviceOptions = app.Services.GetRequiredService<IOptions<ServiceOptions>>().Value;
var debugLoggingOptions = app.Services.GetRequiredService<IOptions<ExtendedDebugLoggingOptions>>();
app.Logger.LogBasic(
    debugLoggingOptions,
    "Service {ServiceName} started with extended debug logging level {DebugLoggingLevel}",
    serviceOptions.Name,
    debugLoggingOptions.Value.Level);

app.UseServiceSecurityHeaders();
app.MapServiceRuntimeEndpoints(serviceOptions.Name, serviceOptions.HealthRoute);

app.Run();
