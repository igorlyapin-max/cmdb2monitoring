using Confluent.Kafka;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using ZabbixRequests2Api.Configuration;
using ZabbixRequests2Api.Kafka;
using ZabbixRequests2Api.Logging;
using ZabbixRequests2Api.Processing;
using ZabbixRequests2Api.Zabbix;

var builder = WebApplication.CreateBuilder(args);

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
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.BootstrapServers), "Kafka output bootstrap servers are required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.Topic), "Kafka output topic is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.ClientId), "Kafka output client id is required.")
    .Validate(options => options.Output.HasValidSecurityProtocol(), "Kafka output security protocol is invalid.")
    .Validate(options => options.Output.HasValidSaslMechanism(), "Kafka output SASL mechanism is invalid.")
    .Validate(options => options.Output.HasValidAcks(), "Kafka output acks value is invalid.")
    .Validate(options => options.Output.MessageTimeoutMs > 0, "Kafka output message timeout must be greater than zero.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.SuccessHeaderName), "Kafka output success header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.MethodHeaderName), "Kafka output method header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.ErrorCodeHeaderName), "Kafka output error code header name is required.")
    .ValidateOnStart();

builder.Services.AddOptions<ZabbixOptions>()
    .Bind(builder.Configuration.GetSection(ZabbixOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.ApiEndpoint), "Zabbix API endpoint is required.")
    .Validate(options => options.HasValidAuthMode(), "Zabbix auth mode is invalid.")
    .Validate(options => options.RequestTimeoutMs > 0, "Zabbix request timeout must be greater than zero.")
    .ValidateOnStart();

builder.Services.AddOptions<ProcessingOptions>()
    .Bind(builder.Configuration.GetSection(ProcessingOptions.SectionName))
    .Validate(options => options.DelayBetweenObjectsMs >= 0, "Delay between objects cannot be negative.")
    .Validate(options => options.MaxRetryAttempts > 0, "Max retry attempts must be greater than zero.")
    .Validate(options => options.RetryDelayMs >= 0, "Retry delay cannot be negative.")
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

builder.Services.AddSingleton<IProducer<string, string>>(services =>
{
    var options = services.GetRequiredService<IOptions<KafkaOptions>>().Value;

    return new ProducerBuilder<string, string>(options.Output.BuildProducerConfig()).Build();
});

builder.Logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, KafkaElkLoggerProvider>());

builder.Services.AddHttpClient<IZabbixClient, ZabbixClient>((services, client) =>
{
    var options = services.GetRequiredService<IOptions<ZabbixOptions>>().Value;
    client.Timeout = TimeSpan.FromMilliseconds(options.RequestTimeoutMs);
});
builder.Services.AddSingleton<ZabbixRequestReader>();
builder.Services.AddSingleton<ZabbixRequestValidator>();
builder.Services.AddSingleton<IZabbixResponsePublisher, ZabbixResponsePublisher>();
builder.Services.AddSingleton<IProcessingStateStore, FileProcessingStateStore>();
builder.Services.AddHostedService<KafkaZabbixRequestWorker>();

var app = builder.Build();
var serviceOptions = app.Services.GetRequiredService<IOptions<ServiceOptions>>().Value;

app.MapGet(serviceOptions.HealthRoute, () => Results.Ok(new
{
    service = serviceOptions.Name,
    status = "ok"
}));

app.Run();
