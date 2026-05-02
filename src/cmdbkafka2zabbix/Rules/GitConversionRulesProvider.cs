using System.Diagnostics;
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
    private bool startupPullAttempted;

    public async Task<ConversionRulesDocument> GetRulesAsync(CancellationToken cancellationToken)
    {
        return await LoadRulesAsync(forceReload: false, refreshStorage: false, cancellationToken);
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
            cachedLocation ?? ResolveRulesFilePath(),
            cachedVersion,
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
            var lastWriteTime = File.GetLastWriteTimeUtc(rulesFilePath);
            if (!forceReload && cachedRules is not null && cachedLastWriteTime == lastWriteTime)
            {
                return cachedRules;
            }

            await using var stream = File.OpenRead(rulesFilePath);
            var rules = await JsonSerializer.DeserializeAsync<ConversionRulesDocument>(stream, JsonOptions, cancellationToken)
                ?? throw new InvalidOperationException($"Conversion rules file '{rulesFilePath}' is empty.");

            cachedRules = rules;
            cachedLastWriteTime = lastWriteTime;

            var commit = await TryReadGitCommitAsync(cancellationToken);
            cachedLocation = rulesFilePath;
            cachedVersion = commit;
            logger.LogInformation(
                "Loaded conversion rules {RuleName} schema {SchemaVersion} from {RulesFilePath} at git commit {GitCommit}",
                rules.Name,
                rules.SchemaVersion,
                rulesFilePath,
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
        var repositoryPath = string.IsNullOrWhiteSpace(options.Value.RepositoryPath)
            ? "."
            : options.Value.RepositoryPath;
        var rulesFilePath = Path.IsPathRooted(options.Value.RulesFilePath)
            ? options.Value.RulesFilePath
            : Path.Combine(repositoryPath, options.Value.RulesFilePath);

        var fullPath = Path.GetFullPath(rulesFilePath);
        if (!File.Exists(fullPath))
        {
            throw new FileNotFoundException("Conversion rules file was not found.", fullPath);
        }

        return fullPath;
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
        var repositoryPath = string.IsNullOrWhiteSpace(options.Value.RepositoryPath)
            ? "."
            : options.Value.RepositoryPath;
        var startInfo = new ProcessStartInfo
        {
            FileName = options.Value.GitExecutablePath,
            Arguments = $"-C \"{Path.GetFullPath(repositoryPath)}\" {arguments}",
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
                Path.GetFullPath(string.IsNullOrWhiteSpace(options.Value.RepositoryPath) ? "." : options.Value.RepositoryPath));
        }
    }

    private sealed record ProcessResult(int ExitCode, string? Output);

    private static async Task<string?> ReadOutputAsync(Process process, CancellationToken cancellationToken)
    {
        return await process.StandardOutput.ReadToEndAsync(cancellationToken);
    }
}
