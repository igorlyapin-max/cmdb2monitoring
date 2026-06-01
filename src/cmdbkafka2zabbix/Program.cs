using CmdbKafka2Zabbix.Configuration;
using CmdbKafka2Zabbix.Conversion;
using CmdbKafka2Zabbix.Kafka;
using CmdbKafka2Zabbix.Logging;
using CmdbKafka2Zabbix.Processing;
using CmdbKafka2Zabbix.Rules;
using Cmdb2Monitoring.Http;
using Cmdb2Monitoring.Kafka;
using Cmdb2Monitoring.Logging;
using Cmdb2Monitoring.Metrics;
using Cmdb2Monitoring.Security;
using Cmdb2Monitoring.Secrets;
using Cmdb2Monitoring.Transport;
using Cmdb2Monitoring.Workers;
using Confluent.Kafka;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

var builder = WebApplication.CreateBuilder(args);
TransportConfigurator.UseConfiguredUrls(builder.WebHost, builder.Configuration, "http://localhost:5081");
await builder.Configuration.ResolveSecretReferencesAsync("cmdbkafka2zabbix");

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
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.MethodHeaderName), "Kafka output method header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.EventTypeHeaderName), "Kafka output event type header name is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.Output.EntityIdHeaderName), "Kafka output entity id header name is required.")
    .ValidateOnStart();

builder.Services.AddOptions<ConversionRulesOptions>()
    .Bind(builder.Configuration.GetSection(ConversionRulesOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.RepositoryPath), "Conversion rules repository path is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.BaseDirectory), "Conversion rules base directory is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.RulesFilePath), "Conversion rules file path is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.GitExecutablePath), "Git executable path is required.")
    .Validate(options => !builder.Environment.IsProduction() || !options.ReadFromGit || options.AllowRuntimeGitInProduction, "Production runtime git access requires ConversionRules:AllowRuntimeGitInProduction=true.")
    .Validate(options => !builder.Environment.IsProduction() || IsSafeProductionGitExecutable(options.GitExecutablePath), "Production git executable must be 'git' or '/usr/bin/git'.")
    .Validate(options => string.Equals(options.TemplateEngine, "Mono.TextTemplating", StringComparison.OrdinalIgnoreCase), "Only Mono.TextTemplating template engine is supported.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.TemplateName), "Conversion template name is required.")
    .Validate(options => !builder.Environment.IsProduction() || !options.RequireTrustedArtifactInProduction || !string.IsNullOrWhiteSpace(options.TrustedArtifactPath), "Production trusted rules artifact is required when ConversionRules:RequireTrustedArtifactInProduction=true.")
    .ValidateOnStart();

builder.Services.AddOptions<KafkaDeadLetterOptions>()
    .Bind(builder.Configuration.GetSection(KafkaDeadLetterOptions.SectionName))
    .Validate(options => !options.Enabled || !string.IsNullOrWhiteSpace(options.Topic), "DeadLetter topic is required when DeadLetter is enabled.")
    .ValidateOnStart();

builder.Services.AddOptions<CmdbuildOptions>()
    .Bind(builder.Configuration.GetSection(CmdbuildOptions.SectionName))
    .Validate(options => options.RequestTimeoutMs > 0, "CMDBuild request timeout must be greater than zero.")
    .Validate(options => options.MaxPathDepth is >= 2 and <= 5, "CMDBuild max path depth must be from 2 to 5.")
    .Validate(options => !options.HostBindingLookupEnabled || !string.IsNullOrWhiteSpace(options.MainHostIdAttributeName), "CMDBuild main host id attribute name is required when host binding lookup is enabled.")
    .Validate(options => !options.HostBindingLookupEnabled || !string.IsNullOrWhiteSpace(options.BindingClassName), "CMDBuild binding class name is required when host binding lookup is enabled.")
    .Validate(options => !options.HostBindingLookupEnabled || options.BindingLookupLimit > 0, "CMDBuild binding lookup limit must be greater than zero when host binding lookup is enabled.")
    .Validate(options => ProductionSecurityGuards.AllowsHttpEndpoint(builder.Environment, options.BaseUrl, options.Tls.AllowInsecureHttp), "Production CMDBuild BaseUrl requires https unless Cmdbuild:Tls:AllowInsecureHttp is true.")
    .Validate(options => !builder.Environment.IsProduction() || options.Tls.RejectUnauthorized, "Production CMDBuild TLS must reject unauthorized certificates.")
    .Validate(options => options.LookupCacheTtlSeconds >= 0, "CMDBuild lookup cache TTL cannot be negative.")
    .Validate(options => options.Resilience.HasValidValues(), "CMDBuild resilience settings are invalid.")
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

    return new ProducerBuilder<string, string>(options.Output.BuildProducerConfig()).Build();
});

builder.Logging.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, KafkaElkLoggerProvider>());

builder.Services.AddSingleton<IConversionRulesProvider, GitConversionRulesProvider>();
builder.Services.AddSingleton<CmdbEventReader>();
builder.Services.AddHttpClient<CmdbSourceFieldResolver>()
    .ConfigurePrimaryHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<CmdbuildOptions>>().Value;
        return HttpClientTlsConfigurator.CreateHandler(options.Tls);
    })
    .AddHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<CmdbuildOptions>>().Value;
        var logger = services.GetRequiredService<ILogger<HttpClientResilienceHandler>>();
        return new HttpClientResilienceHandler(options.Resilience, logger);
    });
builder.Services.AddHttpClient<CmdbZabbixHostBindingResolver>()
    .ConfigurePrimaryHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<CmdbuildOptions>>().Value;
        return HttpClientTlsConfigurator.CreateHandler(options.Tls);
    })
    .AddHttpMessageHandler(services =>
    {
        var options = services.GetRequiredService<IOptions<CmdbuildOptions>>().Value;
        var logger = services.GetRequiredService<ILogger<HttpClientResilienceHandler>>();
        return new HttpClientResilienceHandler(options.Resilience, logger);
    });
builder.Services.AddSingleton<ICmdbZabbixHostBindingResolver>(services => services.GetRequiredService<CmdbZabbixHostBindingResolver>());
builder.Services.AddSingleton<T4TemplateRenderer>();
builder.Services.AddSingleton<CmdbToZabbixConverter>();
builder.Services.AddSingleton<IZabbixRequestPublisher, ZabbixRequestPublisher>();
builder.Services.AddSingleton<IKafkaDeadLetterPublisher, KafkaDeadLetterPublisher>();
builder.Services.AddSingleton<IProcessingStateStore, FileProcessingStateStore>();
builder.Services.AddSingleton<IServiceMetrics, ServiceMetrics>();
builder.Services.AddHostedService<KafkaConversionWorker>();

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
                    repositoryPath = result.RepositoryPath,
                    repositoryUrl = result.RepositoryUrl,
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
                    repositoryPath = result.RepositoryPath,
                    repositoryUrl = result.RepositoryUrl,
                    readFromGit = result.ReadFromGit,
                    pullOnStartup = result.PullOnStartup,
                    pullOnReload = result.PullOnReload,
                    runtimeGitEnabled = result.ReadFromGit && (result.PullOnStartup || result.PullOnReload),
                    templateEngine = result.TemplateEngine,
                    templateName = result.TemplateName,
                    trustedArtifactPath = result.TrustedArtifactPath,
                    requireTrustedArtifactInProduction = result.RequireTrustedArtifactInProduction,
                    lastWriteTime = result.LastWriteTime,
                    checkedAt = result.CheckedAt
                }
            });
        });
}

app.Run();

static bool IsSafeProductionGitExecutable(string gitExecutablePath)
{
    return string.Equals(gitExecutablePath, "git", StringComparison.Ordinal)
        || string.Equals(gitExecutablePath, "/usr/bin/git", StringComparison.Ordinal);
}

static bool IsBearerTokenValid(HttpRequest request, string expectedToken)
{
    if (!AuthenticationHeaderValue.TryParse(request.Headers.Authorization.ToString(), out var header)
        || !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase)
        || string.IsNullOrWhiteSpace(header.Parameter))
    {
        return false;
    }

    var expectedBytes = Encoding.UTF8.GetBytes(expectedToken);
    var actualBytes = Encoding.UTF8.GetBytes(header.Parameter);
    return expectedBytes.Length == actualBytes.Length
        && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
}
