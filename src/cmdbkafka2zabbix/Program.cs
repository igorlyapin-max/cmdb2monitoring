using CmdbKafka2Zabbix.Configuration;
using CmdbKafka2Zabbix.Conversion;
using CmdbKafka2Zabbix.Kafka;
using CmdbKafka2Zabbix.Logging;
using CmdbKafka2Zabbix.Processing;
using CmdbKafka2Zabbix.Rules;
using Confluent.Kafka;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using System.Security.Cryptography;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<ServiceOptions>()
    .Bind(builder.Configuration.GetSection(ServiceOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Name), "Service name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.HealthRoute), "Service health route is required.")
    .Validate(options => string.IsNullOrWhiteSpace(options.RulesReloadRoute) || options.RulesReloadRoute.StartsWith('/'), "Rules reload route must start with '/'.")
    .Validate(options => string.IsNullOrWhiteSpace(options.RulesStatusRoute) || options.RulesStatusRoute.StartsWith('/'), "Rules status route must start with '/'.")
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
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.MethodHeaderName), "Kafka output method header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.EventTypeHeaderName), "Kafka output event type header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.EntityIdHeaderName), "Kafka output entity id header name is required.")
    .ValidateOnStart();

builder.Services.AddOptions<ConversionRulesOptions>()
    .Bind(builder.Configuration.GetSection(ConversionRulesOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.RepositoryPath), "Conversion rules repository path is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.RulesFilePath), "Conversion rules file path is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.GitExecutablePath), "Git executable path is required.")
    .Validate(options => string.Equals(options.TemplateEngine, "Mono.TextTemplating", StringComparison.OrdinalIgnoreCase), "Only Mono.TextTemplating template engine is supported.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.TemplateName), "Conversion template name is required.")
    .ValidateOnStart();

builder.Services.AddOptions<CmdbuildOptions>()
    .Bind(builder.Configuration.GetSection(CmdbuildOptions.SectionName))
    .Validate(options => options.RequestTimeoutMs > 0, "CMDBuild request timeout must be greater than zero.")
    .Validate(options => options.MaxPathDepth is >= 2 and <= 5, "CMDBuild max path depth must be from 2 to 5.")
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

builder.Services.AddSingleton<IConversionRulesProvider, GitConversionRulesProvider>();
builder.Services.AddSingleton<CmdbEventReader>();
builder.Services.AddHttpClient<CmdbSourceFieldResolver>();
builder.Services.AddSingleton<T4TemplateRenderer>();
builder.Services.AddSingleton<CmdbToZabbixConverter>();
builder.Services.AddSingleton<IZabbixRequestPublisher, ZabbixRequestPublisher>();
builder.Services.AddSingleton<IProcessingStateStore, FileProcessingStateStore>();
builder.Services.AddHostedService<KafkaConversionWorker>();

var app = builder.Build();
var serviceOptions = app.Services.GetRequiredService<IOptions<ServiceOptions>>().Value;

app.MapGet(serviceOptions.HealthRoute, () => Results.Ok(new
{
    service = serviceOptions.Name,
    status = "ok"
}));

if (!string.IsNullOrWhiteSpace(serviceOptions.RulesReloadRoute))
{
    app.MapPost(
        serviceOptions.RulesReloadRoute,
        async (HttpContext context, IConversionRulesProvider rulesProvider, IOptions<ServiceOptions> options, CancellationToken cancellationToken) =>
        {
            var currentOptions = options.Value;
            if (string.IsNullOrWhiteSpace(currentOptions.RulesReloadToken))
            {
                return Results.Problem(
                    "Rules reload token is not configured.",
                    statusCode: StatusCodes.Status503ServiceUnavailable,
                    title: "Rules reload is not configured");
            }

            if (!IsBearerTokenValid(context.Request, currentOptions.RulesReloadToken))
            {
                return Results.Unauthorized();
            }

            var result = await rulesProvider.ReloadAsync(cancellationToken);
            return Results.Ok(new
            {
                service = currentOptions.Name,
                status = "ok",
                rules = new
                {
                    name = result.RuleName,
                    schemaVersion = result.SchemaVersion,
                    rulesVersion = result.RulesVersion,
                    location = result.Location,
                    version = result.Version,
                    storageRefreshed = result.StorageRefreshed,
                    reloadedAt = result.ReloadedAt
                }
            });
        });
}

if (!string.IsNullOrWhiteSpace(serviceOptions.RulesStatusRoute))
{
    app.MapGet(
        serviceOptions.RulesStatusRoute,
        async (HttpContext context, IConversionRulesProvider rulesProvider, IOptions<ServiceOptions> options, CancellationToken cancellationToken) =>
        {
            var currentOptions = options.Value;
            var statusToken = string.IsNullOrWhiteSpace(currentOptions.RulesStatusToken)
                ? currentOptions.RulesReloadToken
                : currentOptions.RulesStatusToken;
            if (!string.IsNullOrWhiteSpace(statusToken) && !IsBearerTokenValid(context.Request, statusToken))
            {
                return Results.Unauthorized();
            }

            var result = await rulesProvider.GetStatusAsync(cancellationToken);
            return Results.Ok(new
            {
                service = currentOptions.Name,
                status = "ok",
                rules = new
                {
                    name = result.RuleName,
                    schemaVersion = result.SchemaVersion,
                    rulesVersion = result.RulesVersion,
                    location = result.Location,
                    version = result.Version,
                    readFromGit = result.ReadFromGit,
                    lastWriteTime = result.LastWriteTime,
                    checkedAt = result.CheckedAt
                }
            });
        });
}

app.Run();

static bool IsBearerTokenValid(HttpRequest request, string expectedToken)
{
    var authorization = request.Headers.Authorization.ToString();
    const string prefix = "Bearer ";
    if (!authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    var actualToken = authorization[prefix.Length..].Trim();
    var expectedBytes = Encoding.UTF8.GetBytes(expectedToken);
    var actualBytes = Encoding.UTF8.GetBytes(actualToken);
    return expectedBytes.Length == actualBytes.Length
        && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
}
