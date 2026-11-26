using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace CmdbKafka2Zabbix.Rules;

public sealed class GitConversionRulesProvider(
    IOptions<ConversionRulesOptions> options,
    ILogger<GitConversionRulesProvider> logger) : IConversionRulesProvider
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly SemaphoreSlim reloadLock = new(1, 1);
    private ConversionRulesDocument? cachedRules;
    private DateTimeOffset? cachedLastWriteTime;
    private string? cachedLocation;
    private string? cachedVersion;
    private string? cachedContentSha256;
    private bool startupPullAttempted;

    public async Task<ConversionRulesDocument> GetRulesAsync(CancellationToken cancellationToken)
    {
        return await LoadRulesAsync(forceReload: false, refreshStorage: false, cancellationToken);
    }

    public async Task<ConversionRulesStatusResult> GetStatusAsync(CancellationToken cancellationToken)
    {
        var rules = await LoadRulesAsync(forceReload: false, refreshStorage: false, cancellationToken);
        return new ConversionRulesStatusResult(
            rules.Name,
            rules.SchemaVersion,
            rules.RulesVersion,
            cachedContentSha256 ?? string.Empty,
            cachedLocation ?? ResolveRulesFilePath(),
            cachedVersion,
            ResolveRepositoryPath(),
            options.Value.RepositoryUrl,
            options.Value.ReadFromGit,
            options.Value.PullOnStartup,
            options.Value.PullOnReload,
            options.Value.TemplateEngine,
            options.Value.TemplateName,
            options.Value.TrustedArtifactPath,
            options.Value.RequireTrustedArtifactInProduction,
            cachedLastWriteTime,
            DateTimeOffset.UtcNow);
    }

    public async Task<ConversionRulesReloadResult> ReloadAsync(CancellationToken cancellationToken)
    {
        var rules = await LoadRulesAsync(
            forceReload: true,
            refreshStorage: options.Value.ReadFromGit && options.Value.PullOnReload,
            cancellationToken);
        return new ConversionRulesReloadResult(
            rules.Name,
            rules.SchemaVersion,
            rules.RulesVersion,
            cachedContentSha256 ?? string.Empty,
            cachedLocation ?? ResolveRulesFilePath(),
            cachedVersion,
            ResolveRepositoryPath(),
            options.Value.RepositoryUrl,
            options.Value.ReadFromGit && options.Value.PullOnReload,
            DateTimeOffset.UtcNow);
    }

    private async Task<ConversionRulesDocument> LoadRulesAsync(
        bool forceReload,
        bool refreshStorage,
        CancellationToken cancellationToken)
    {
        await reloadLock.WaitAsync(cancellationToken);
        try
        {
            await PullOnStartupAsync(cancellationToken);
            if (refreshStorage)
            {
                await PullForReloadAsync(cancellationToken);
            }

            var rulesFilePath = ResolveRulesFilePath();
            DateTime lastWriteTime;
            string rulesJson;
            string contentSha256;
            try
            {
                byte[]? stableBytes = null;
                for (var attempt = 0; attempt < 3; attempt++)
                {
                    var first = await File.ReadAllBytesAsync(rulesFilePath, cancellationToken);
                    var second = await File.ReadAllBytesAsync(rulesFilePath, cancellationToken);
                    if (first.AsSpan().SequenceEqual(second))
                    {
                        stableBytes = second;
                        break;
                    }
                }
                if (stableBytes is null)
                {
                    throw new RulesArtifactException(RulesArtifactFailureCodes.FileUnreadable, "read_unstable", options.Value.RulesFilePath, rulesFilePath);
                }
                contentSha256 = Convert.ToHexString(SHA256.HashData(stableBytes)).ToLowerInvariant();
                lastWriteTime = File.GetLastWriteTimeUtc(rulesFilePath);
                if (!forceReload && cachedRules is not null && cachedContentSha256 == contentSha256)
                {
                    return cachedRules;
                }
                using var reader = new StreamReader(new MemoryStream(stableBytes), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                rulesJson = await reader.ReadToEndAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
            {
                throw new RulesArtifactException(
                    RulesArtifactFailureCodes.FileMissing,
                    "read_file",
                    options.Value.RulesFilePath,
                    rulesFilePath,
                    ex);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                throw new RulesArtifactException(
                    RulesArtifactFailureCodes.FileUnreadable,
                    "read_file",
                    options.Value.RulesFilePath,
                    rulesFilePath,
                    ex);
            }

            ConversionRulesDocument rules;
            try
            {
                rules = JsonSerializer.Deserialize<ConversionRulesDocument>(rulesJson, JsonOptions)
                    ?? throw new JsonException("Conversion rules document is empty.");
            }
            catch (JsonException ex)
            {
                throw new RulesArtifactException(
                    RulesArtifactFailureCodes.Invalid,
                    "parse_json",
                    options.Value.RulesFilePath,
                    rulesFilePath,
                    ex);
            }

            var validationErrors = ConversionRulesSchemaValidator.Validate(rulesJson, rules);
            if (validationErrors.Count > 0)
            {
                throw new RulesArtifactException(
                    RulesArtifactFailureCodes.Invalid,
                    "validate_schema",
                    options.Value.RulesFilePath,
                    rulesFilePath,
                    new InvalidOperationException(string.Join(" ", validationErrors)));
            }
            foreach (var ignoredRule in ProfileScopedRulePolicy.FindIgnoredRules(rules))
            {
                logger.LogWarning(
                    "Ignoring conversion rule {Collection}[{Index}] because {Reason}{ProfileSuffix}",
                    ignoredRule.Collection,
                    ignoredRule.Index,
                    ignoredRule.Reason,
                    string.IsNullOrWhiteSpace(ignoredRule.ProfileName) ? string.Empty : $":{ignoredRule.ProfileName}");
            }

            cachedRules = rules;
            cachedLastWriteTime = lastWriteTime;
            cachedContentSha256 = contentSha256;

            var commit = await TryReadGitCommitAsync(cancellationToken);
            cachedLocation = rulesFilePath;
            cachedVersion = commit;
            logger.LogInformation(
                "Loaded conversion rules {RuleName} schema {SchemaVersion} from {RulesFilePath} with SHA-256 {ContentSha256} at git commit {GitCommit}",
                rules.Name,
                rules.SchemaVersion,
                rulesFilePath,
                cachedContentSha256,
                commit ?? "<unknown>");

            return rules;
        }
        finally
        {
            reloadLock.Release();
        }
    }

    private async Task PullOnStartupAsync(CancellationToken cancellationToken)
    {
        if (startupPullAttempted || !options.Value.ReadFromGit || !options.Value.PullOnStartup)
        {
            return;
        }

        startupPullAttempted = true;
        LogGitRepository();
        var exitCode = await RunGitAsync("pull --ff-only", cancellationToken);
        if (exitCode != 0)
        {
            logger.LogWarning("Git pull for conversion rules finished with exit code {ExitCode}", exitCode);
        }
    }

    private async Task PullForReloadAsync(CancellationToken cancellationToken)
    {
        LogGitRepository();
        var exitCode = await RunGitAsync("pull --ff-only", cancellationToken);
        if (exitCode != 0)
        {
            throw new InvalidOperationException($"Git pull for conversion rules failed with exit code {exitCode}.");
        }
    }

    private string ResolveRulesFilePath()
    {
        try
        {
            var repositoryPath = ResolveRepositoryPath();
            var rulesFilePath = Path.IsPathRooted(options.Value.RulesFilePath)
                ? options.Value.RulesFilePath
                : Path.Combine(repositoryPath, options.Value.RulesFilePath);

            var fullPath = Path.GetFullPath(rulesFilePath);
            EnsurePathInsideBase(fullPath);
            return fullPath;
        }
        catch (RulesArtifactException)
        {
            throw;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or InvalidOperationException)
        {
            throw new RulesArtifactException(
                RulesArtifactFailureCodes.PathInvalid,
                "resolve_path",
                options.Value.RulesFilePath,
                innerException: ex);
        }
    }

    private async Task<string?> TryReadGitCommitAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.ReadFromGit)
        {
            return null;
        }

        try
        {
            var output = await RunGitForOutputAsync("rev-parse --short HEAD", cancellationToken);
            return string.IsNullOrWhiteSpace(output) ? null : output.Trim();
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            logger.LogDebug(ex, "Failed to read git commit for conversion rules");
            return null;
        }
    }

    private Task<int> RunGitAsync(string arguments, CancellationToken cancellationToken)
    {
        return RunGitCoreAsync(arguments, cancellationToken);
    }

    private async Task<int> RunGitCoreAsync(string arguments, CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(arguments, captureOutput: false, cancellationToken);
        return result.ExitCode;
    }

    private async Task<string?> RunGitForOutputAsync(string arguments, CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(arguments, captureOutput: true, cancellationToken);
        return result.ExitCode == 0 ? result.Output : null;
    }

    private async Task<ProcessResult> RunProcessAsync(string arguments, bool captureOutput, CancellationToken cancellationToken)
    {
        var repositoryPath = ResolveRepositoryPath();
        var startInfo = new ProcessStartInfo
        {
            FileName = options.Value.GitExecutablePath,
            Arguments = $"-C \"{repositoryPath}\" {arguments}",
            UseShellExecute = false,
            RedirectStandardOutput = captureOutput,
            RedirectStandardError = true
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start git executable '{options.Value.GitExecutablePath}'.");

        Task<string?> outputTask = captureOutput
            ? ReadOutputAsync(process, cancellationToken)
            : Task.FromResult<string?>(null);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);

        await process.WaitForExitAsync(cancellationToken);

        var output = await outputTask;
        var error = await errorTask;
        if (!string.IsNullOrWhiteSpace(error))
        {
            logger.LogDebug("Git command stderr: {GitError}", error.Trim());
        }

        return new ProcessResult(process.ExitCode, output);
    }

    private void LogGitRepository()
    {
        if (!string.IsNullOrWhiteSpace(options.Value.RepositoryUrl))
        {
            logger.LogInformation(
                "Reading conversion rules from git repository {RepositoryUrl} at {RepositoryPath}",
                options.Value.RepositoryUrl,
                ResolveRepositoryPath());
        }
    }

    private string ResolveRepositoryPath()
    {
        var repositoryPath = string.IsNullOrWhiteSpace(options.Value.RepositoryPath)
            ? "."
            : options.Value.RepositoryPath;
        var basePath = ResolveBaseDirectory();
        var fullPath = Path.IsPathRooted(repositoryPath)
            ? Path.GetFullPath(repositoryPath)
            : Path.GetFullPath(repositoryPath);
        EnsurePathInsideBase(fullPath);
        return fullPath;
    }

    private void EnsurePathInsideBase(string path)
    {
        var basePath = ResolveBaseDirectory();
        var normalizedBase = basePath.EndsWith(Path.DirectorySeparatorChar)
            ? basePath
            : $"{basePath}{Path.DirectorySeparatorChar}";
        var normalizedPath = Path.GetFullPath(path);
        if (!normalizedPath.StartsWith(normalizedBase, StringComparison.Ordinal)
            && !string.Equals(normalizedPath.TrimEnd(Path.DirectorySeparatorChar), normalizedBase.TrimEnd(Path.DirectorySeparatorChar), StringComparison.Ordinal))
        {
            throw new RulesArtifactException(
                RulesArtifactFailureCodes.PathInvalid,
                "resolve_path",
                options.Value.RulesFilePath,
                normalizedPath,
                new InvalidOperationException("Conversion rules path escapes base directory."));
        }
    }

    private string ResolveBaseDirectory()
    {
        return Path.GetFullPath(string.IsNullOrWhiteSpace(options.Value.BaseDirectory) ? "." : options.Value.BaseDirectory);
    }

    private sealed record ProcessResult(int ExitCode, string? Output);

    private static async Task<string?> ReadOutputAsync(Process process, CancellationToken cancellationToken)
    {
        return await process.StandardOutput.ReadToEndAsync(cancellationToken);
    }
}
