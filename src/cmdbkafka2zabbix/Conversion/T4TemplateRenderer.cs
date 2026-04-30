using System.CodeDom.Compiler;
using System.Text;
using System.Text.RegularExpressions;
using CmdbKafka2Zabbix.Rules;
using Microsoft.VisualStudio.TextTemplating;
using Microsoft.Extensions.Options;
using Mono.TextTemplating;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class T4TemplateRenderer(IOptions<ConversionRulesOptions> options)
{
    public async Task<string> RenderAsync(
        string[] templateLines,
        ZabbixHostCreateModel model,
        CancellationToken cancellationToken)
    {
        var templateContent = BuildTemplateContent(templateLines);
        var generator = new TemplateGenerator();
        var sessionHost = (ITextTemplatingSessionHost)generator;
        sessionHost.Session = sessionHost.CreateSession();
        sessionHost.Session["Model"] = model;

        var tempDirectory = Path.Combine(Path.GetTempPath(), "cmdbkafka2zabbix-t4");
        Directory.CreateDirectory(tempDirectory);

        var inputFileName = Path.Combine(tempDirectory, $"zabbix-host-create-{Guid.NewGuid():N}.tt");
        var outputFileName = Path.ChangeExtension(inputFileName, ".json");

        try
        {
            var parsedTemplate = generator.ParseTemplate(inputFileName, templateContent);
            var settings = TemplatingEngine.GetSettings(generator, parsedTemplate);
            settings.CompilerOptions = "-nullable:enable";

            var (_, generatedContent) = await generator.ProcessTemplateAsync(
                parsedTemplate,
                inputFileName,
                templateContent,
                outputFileName,
                settings);

            ThrowIfTemplateErrors(generator.Errors);

            return generatedContent;
        }
        finally
        {
            TryDelete(inputFileName);
            TryDelete(outputFileName);
        }
    }

    public string RenderSimple(string template, ZabbixHostCreateModel model)
    {
        var rendered = template
            .Replace("<#= Model.Host #>", model.Host, StringComparison.Ordinal)
            .Replace("<#= Model.VisibleName #>", model.VisibleName, StringComparison.Ordinal)
            .Replace("<#= Model.HostProfileName #>", model.HostProfileName, StringComparison.Ordinal)
            .Replace("<#= Model.ClassName #>", model.ClassName, StringComparison.Ordinal)
            .Replace("<#= Model.EntityId #>", model.EntityId ?? string.Empty, StringComparison.Ordinal)
            .Replace("<#= Model.Code #>", model.Code ?? string.Empty, StringComparison.Ordinal)
            .Replace("<#= Model.IpAddress #>", model.IpAddress, StringComparison.Ordinal)
            .Replace("<#= Model.DnsName #>", model.DnsName, StringComparison.Ordinal)
            .Replace("<#= Model.Interface.Ip #>", model.Interface.Ip, StringComparison.Ordinal)
            .Replace("<#= Model.Interface.Dns #>", model.Interface.Dns, StringComparison.Ordinal)
            .Replace("<#= Model.OperatingSystem #>", model.OperatingSystem ?? string.Empty, StringComparison.Ordinal)
            .Replace("<#= Model.ZabbixTag #>", model.ZabbixTag ?? string.Empty, StringComparison.Ordinal)
            .Replace("<#= Model.EventType #>", model.EventType, StringComparison.Ordinal)
            .Replace("<#= Model.ZabbixHostId #>", model.ZabbixHostId ?? string.Empty, StringComparison.Ordinal)
            .Replace("<#= Model.Code ?? Model.EntityId #>", model.Code ?? model.EntityId ?? string.Empty, StringComparison.Ordinal);

        return Regex.Replace(
            rendered,
            "<#=\\s*Model\\.Field\\([\"'](?<name>[^\"']+)[\"']\\)\\s*#>",
            match => model.Field(match.Groups["name"].Value),
            RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(500));
    }

    private string BuildTemplateContent(string[] templateLines)
    {
        var content = string.Join(Environment.NewLine, templateLines);
        if (HasTemplateDirective(templateLines) || !options.Value.AddDefaultDirectives)
        {
            return content;
        }

        var builder = new StringBuilder();
        builder.AppendLine("<#@ template language=\"C#\" hostspecific=\"false\" #>");
        builder.AppendLine($"<#@ assembly name=\"{typeof(ZabbixHostCreateModel).Assembly.Location}\" #>");
        builder.AppendLine("<#@ assembly name=\"System.Runtime\" #>");
        builder.AppendLine("<#@ assembly name=\"System.Collections\" #>");
        builder.AppendLine("<#@ import namespace=\"System\" #>");
        builder.AppendLine("<#@ import namespace=\"System.Collections.Generic\" #>");
        builder.AppendLine("<#@ import namespace=\"System.Linq\" #>");
        builder.AppendLine("<#@ import namespace=\"CmdbKafka2Zabbix.Conversion\" #>");
        builder.AppendLine("<#@ parameter name=\"Model\" type=\"CmdbKafka2Zabbix.Conversion.ZabbixHostCreateModel\" #>");
        builder.Append(content);

        return builder.ToString();
    }

    private static bool HasTemplateDirective(string[] templateLines)
    {
        return templateLines.Any(line => line.TrimStart().StartsWith("<#@ template", StringComparison.OrdinalIgnoreCase));
    }

    private static void ThrowIfTemplateErrors(CompilerErrorCollection errors)
    {
        if (!errors.HasErrors)
        {
            return;
        }

        var messages = errors
            .Cast<CompilerError>()
            .Where(error => !error.IsWarning)
            .Select(error => $"{error.FileName}({error.Line},{error.Column}): {error.ErrorNumber} {error.ErrorText}");

        throw new InvalidOperationException($"T4 template processing failed: {string.Join("; ", messages)}");
    }

    private static void TryDelete(string filePath)
    {
        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
