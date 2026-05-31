using CmdbWebhooks2Kafka.Configuration;
using CmdbWebhooks2Kafka.Endpoints;
using CmdbWebhooks2Kafka.Kafka;
using CmdbWebhooks2Kafka.Logging;
using Cmdb2Monitoring.Logging;
using Cmdb2Monitoring.Metrics;
using Cmdb2Monitoring.Security;
using Cmdb2Monitoring.Secrets;
using Cmdb2Monitoring.Transport;
using Confluent.Kafka;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
TransportConfigurator.UseConfiguredUrls(builder.WebHost, builder.Configuration, "http://0.0.0.0:5080");
await builder.Configuration.ResolveSecretReferencesAsync("cmdbwebhooks2kafka");

builder.Services.AddOptions<TransportOptions>()
    .Bind(builder.Configuration.GetSection(TransportOptions.SectionName))
    .Validate(options => options.HasValidMode(), "Transport mode must be Http or Https.")
    .Validate(options => ProductionSecurityGuards.AllowsPlainHttp(builder.Environment, options), "Production transport requires Https unless Transport:AllowPlainHttp is true.")
    .ValidateOnStart();

builder.Services.AddOptions<HostSecurityOptions>()
    .Bind(builder.Configuration.GetSection(HostSecurityOptions.SectionName))
    .Validate(options => ProductionSecurityGuards.AllowsWildcardAllowedHosts(builder.Environment, builder.Configuration["AllowedHosts"], options.AllowWildcardAllowedHosts), "Production AllowedHosts='*' requires HostSecurity:AllowWildcardAllowedHosts=true.")
    .ValidateOnStart();

builder.Services.AddOptions<ServiceOptions>()
    .Bind(builder.Configuration.GetSection(ServiceOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Name), "Service name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.HealthRoute), "Service health route is required.")
    .ValidateOnStart();

builder.Services.AddOptions<CmdbWebhookOptions>()
    .Bind(builder.Configuration.GetSection(CmdbWebhookOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Route), "CMDB webhook route is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.EndpointTag), "CMDB webhook endpoint tag is required.")
    .Validate(options => options.HasValidAuthorizationMode(), "CMDB webhook authorization mode must be Static or Disabled.")
    .Validate(options => !options.RequiresBearerToken() || !string.IsNullOrWhiteSpace(options.BearerToken), "CMDB webhook bearer token is required when authorization mode is Static.")
    .Validate(options => !builder.Environment.IsProduction() || !options.RequiresBearerToken() || ProductionSecurityGuards.IsStrongSecret(options.BearerToken), "Production CMDB webhook bearer token must be at least 32 characters and not a known weak token.")
    .Validate(options => !builder.Environment.IsProduction() || options.RequiresBearerToken() || options.AllowDisabledAuthorizationInProduction, "Production CMDB webhook disabled authorization requires AllowDisabledAuthorizationInProduction=true.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Source), "CMDB webhook source is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.UnknownEventType), "CMDB webhook unknown event type is required.")
    .Validate(options => options.EventTypeFields.Length > 0, "CMDB webhook event type fields are required.")
    .Validate(options => options.EntityTypeFields.Length > 0, "CMDB webhook entity type fields are required.")
    .Validate(options => options.EntityIdFields.Length > 0, "CMDB webhook entity id fields are required.")
    .Validate(options => options.SearchContainers.Length > 0, "CMDB webhook search containers are required.")
    .Validate(options => options.RateLimit.HasValidValues(), "CMDB webhook rate limit values are invalid.")
    .ValidateOnStart();

builder.Services.AddOptions<KafkaOptions>()
    .Bind(builder.Configuration.GetSection(KafkaOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.BootstrapServers), "Kafka bootstrap servers are required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Topic), "Kafka topic is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.ClientId), "Kafka client id is required.")
    .Validate(options => options.HasValidSecurityProtocol(), "Kafka security protocol is invalid.")
    .Validate(options => options.HasValidSaslMechanism(), "Kafka SASL mechanism is invalid.")
    .Validate(options => options.HasValidSslEndpointIdentificationAlgorithm(), "Kafka SSL endpoint identification algorithm is invalid.")
    .Validate(options => ProductionSecurityGuards.AllowsKafkaProtocol(builder.Environment, options.SecurityProtocol, options.AllowPlaintextKafka), "Production Kafka requires Ssl/SaslSsl unless Kafka:AllowPlaintextKafka is true.")
    .Validate(options => options.HasValidAcks(), "Kafka acks value is invalid.")
    .Validate(options => options.MessageTimeoutMs > 0, "Kafka message timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.SourceHeaderName), "Kafka source header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.EventTypeHeaderName), "Kafka event type header name is required.")
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
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || options.Kafka.HasValidSslEndpointIdentificationAlgorithm(), "ELK Kafka SSL endpoint identification algorithm is invalid.")
    .Validate(options => !options.Enabled || !options.Kafka.Enabled || ProductionSecurityGuards.AllowsKafkaProtocol(builder.Environment, options.Kafka.SecurityProtocol, options.Kafka.AllowPlaintextKafka), "Production ELK Kafka requires Ssl/SaslSsl unless AllowPlaintextKafka is true.")
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

    return new ProducerBuilder<string, string>(options.BuildProducerConfig()).Build();
});

builder.Logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, KafkaElkLoggerProvider>());

builder.Services.AddSingleton<IKafkaEventPublisher, KafkaEventPublisher>();
builder.Services.AddSingleton<WebhookRateLimiter>();
builder.Services.AddSingleton<IServiceMetrics, ServiceMetrics>();

var app = builder.Build();
var serviceOptions = app.Services.GetRequiredService<IOptions<ServiceOptions>>().Value;
var debugLoggingOptions = app.Services.GetRequiredService<IOptions<ExtendedDebugLoggingOptions>>();
app.Logger.LogBasic(
    debugLoggingOptions,
    "Service {ServiceName} started with extended debug logging level {DebugLoggingLevel}",
    serviceOptions.Name,
    debugLoggingOptions.Value.Level);

app.MapServiceRuntimeEndpoints(serviceOptions.Name, serviceOptions.HealthRoute);
app.MapCmdbWebhookEndpoints();

app.Run();
