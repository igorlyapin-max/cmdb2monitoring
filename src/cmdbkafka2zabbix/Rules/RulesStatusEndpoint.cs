using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using CmdbKafka2Zabbix.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Rules;

public sealed class RulesStatusEndpoint
{
    public static async Task<IResult> HandleAsync(
        HttpContext context,
        IConversionRulesProvider rulesProvider,
        IOptions<ServiceOptions> serviceOptions,
        IOptions<ConversionRulesOptions> conversionRulesOptions,
        ILogger<RulesStatusEndpoint> logger,
        CancellationToken cancellationToken)
    {
        var service = serviceOptions.Value;
        var statusToken = string.IsNullOrWhiteSpace(service.RulesStatusToken)
            ? service.RulesReloadToken
            : service.RulesStatusToken;
        if (string.IsNullOrWhiteSpace(statusToken))
        {
            return Results.Problem(
                "Rules status token is not configured.",
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Rules status is not configured");
        }

        if (!IsBearerTokenValid(context.Request, statusToken))
        {
            return Results.StatusCode(StatusCodes.Status401Unauthorized);
        }

        try
        {
            var result = await rulesProvider.GetStatusAsync(cancellationToken);
            return Results.Ok(new
            {
                service = service.Name,
                status = "ok",
                rules = new
                {
                    name = result.RuleName,
                    schemaVersion = result.SchemaVersion,
                    rulesVersion = result.RulesVersion,
                    contentSha256 = result.ContentSha256,
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
        }
        catch (RulesArtifactException ex)
        {
            LogFailure(logger, ex.FailureCode, ex.Stage, ex.ConfiguredPath, ex.ResolvedPath, conversionRulesOptions.Value.ReadFromGit, ex, ex.InnerException?.GetType().Name ?? ex.GetType().Name);
            return CreateProblem(ex.FailureCode);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            LogFailure(logger, RulesArtifactFailureCodes.StatusFailed, "status", conversionRulesOptions.Value.RulesFilePath, null, conversionRulesOptions.Value.ReadFromGit, ex, ex.GetType().Name);
            return CreateProblem(RulesArtifactFailureCodes.StatusFailed);
        }
    }

    public static bool IsBearerTokenValid(HttpRequest request, string expectedToken)
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

    public static void LogFailure(
        ILogger logger,
        string failureCode,
        string stage,
        string configuredPath,
        string? resolvedPath,
        bool readFromGit,
        Exception exception,
        string exceptionType)
    {
        logger.LogError(
            "Rules artifact status check failed with {RulesArtifactFailureCode} at {RulesArtifactFailureStage}; configured path {RulesArtifactConfiguredPath}; resolved path {RulesArtifactResolvedPath}; ReadFromGit {RulesArtifactReadFromGit}; exception type {RulesArtifactExceptionType}",
            failureCode,
            stage,
            configuredPath,
            resolvedPath ?? "<unresolved>",
            readFromGit,
            exceptionType);
    }

    public static IResult CreateProblem(string failureCode)
    {
        return Results.Problem(
            type: $"urn:cmdb2monitoring:rules-status:{failureCode}",
            title: "Rules artifact status is unavailable.",
            detail: "The converter cannot inspect the active rules artifact.",
            statusCode: StatusCodes.Status503ServiceUnavailable,
            extensions: new Dictionary<string, object?>
            {
                ["code"] = RulesArtifactFailureCodes.IsKnown(failureCode)
                    ? failureCode
                    : RulesArtifactFailureCodes.StatusFailed
            });
    }
}
