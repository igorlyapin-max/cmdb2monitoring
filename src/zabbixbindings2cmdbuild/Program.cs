using Cmdb2Monitoring.Secrets;
using Cmdb2Monitoring.Logging;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using ZabbixBindings2Cmdbuild.Cmdbuild;
using ZabbixBindings2Cmdbuild.Configuration;
using ZabbixBindings2Cmdbuild.Kafka;
using ZabbixBindings2Cmdbuild.Logging;
using ZabbixBindings2Cmdbuild.Models;
using ZabbixBindings2Cmdbuild.Processing;

var builder = WebApplication.CreateBuilder(args);
await builder.Configuration.ResolveSecretReferencesAsync("zabbixbindings2cmdbuild");

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
    .Validate(options => options.Input.HasValidAutoOffsetReset(), "Kafka input auto offset reset is invalid.")
    .Validate(options => options.Input.PollTimeoutMs > 0, "Kafka input poll timeout must be greater than zero.")
    .ValidateOnStart();

builder.Services.AddOptions<CmdbuildOptions>()
    .Bind(builder.Configuration.GetSection(CmdbuildOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.BaseUrl), "CMDBuild base URL is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Username), "CMDBuild username is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Password), "CMDBuild password is required.")
    .Validate(options => options.RequestTimeoutMs > 0, "CMDBuild request timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.MainHostIdAttributeName), "CMDBuild main host id attribute name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BindingClassName), "CMDBuild binding class name is required.")
    .Validate(options => options.BindingLookupLimit > 0, "CMDBuild binding lookup limit must be greater than zero.")
    .ValidateOnStart();

builder.Services.AddOptions<ProcessingStateOptions>()
    .Bind(builder.Configuration.GetSection(ProcessingStateOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.FilePath), "Processing state file path is required.")
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

builder.Logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, KafkaElkLoggerProvider>());

builder.Services.AddHttpClient<ICmdbuildBindingClient, CmdbuildBindingClient>((services, client) =>
{
    var options = services.GetRequiredService<IOptions<CmdbuildOptions>>().Value;
    client.Timeout = TimeSpan.FromMilliseconds(options.RequestTimeoutMs);
});
builder.Services.AddSingleton<ZabbixBindingEventReader>();
builder.Services.AddSingleton<IProcessingStateStore, FileProcessingStateStore>();
builder.Services.AddHostedService<KafkaBindingWorker>();

var app = builder.Build();
var serviceOptions = app.Services.GetRequiredService<IOptions<ServiceOptions>>().Value;
var debugLoggingOptions = app.Services.GetRequiredService<IOptions<ExtendedDebugLoggingOptions>>();
app.Logger.LogBasic(
    debugLoggingOptions,
    "Service {ServiceName} started with extended debug logging level {DebugLoggingLevel}",
    serviceOptions.Name,
    debugLoggingOptions.Value.Level);

app.MapGet(serviceOptions.HealthRoute, () => Results.Ok(new
{
    service = serviceOptions.Name,
    status = "ok"
}));

app.Run();
