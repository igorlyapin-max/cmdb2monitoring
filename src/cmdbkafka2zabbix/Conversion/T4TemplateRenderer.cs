using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CmdbKafka2Zabbix.Rules;
using Microsoft.Extensions.Options;
using Microsoft.VisualStudio.TextTemplating;
using Mono.TextTemplating;

namespace CmdbKafka2Zabbix.Conversion;

public sealed class T4TemplateRenderer(IOptions<ConversionRulesOptions> options)
{
    public async Task<string> RenderAsync(
        string[] templateLines,
        ZabbixHostCreateModel model,
        CancellationToken cancellationToken,
        string? templateName = null)
    {
        if (TryRenderStandardJsonRpc(templateLines, model, templateName, out var rendered))
        {
            return rendered;
        }

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

    private static bool TryRenderStandardJsonRpc(
        string[] templateLines,
        ZabbixHostCreateModel model,
        string? templateName,
        out string rendered)
    {
        var standardTemplate = ResolveStandardTemplateName(templateLines, templateName);
        if (standardTemplate is null)
        {
            rendered = string.Empty;
            return false;
        }

        var root = standardTemplate switch
        {
            "hostCreateJsonRpcRequestLines" => BuildHostMutationRequest(model, "host.create", BuildHostCreateParams(model)),
            "hostUpdateJsonRpcRequestLines" => BuildHostMutationRequest(model, "host.update", BuildHostUpdateParams(model)),
            "hostDeleteJsonRpcRequestLines" => BuildHostDeleteRequest(model),
            "hostGetByHostJsonRpcRequestLines" => BuildHostGetRequest(model),
            _ => null
        };

        if (root is null)
        {
            rendered = string.Empty;
            return false;
        }

        rendered = root.ToJsonString();
        return true;
    }

    private static string? ResolveStandardTemplateName(string[] templateLines, string? templateName)
    {
        if (IsStandardTemplateName(templateName))
        {
            return templateName;
        }

        var content = string.Join('\n', templateLines);
        if (content.Contains("\"method\": \"host.create\"", StringComparison.Ordinal)
            && content.Contains("\"params\"", StringComparison.Ordinal)
            && content.Contains("Model.Interfaces", StringComparison.Ordinal))
        {
            return "hostCreateJsonRpcRequestLines";
        }

        if (content.Contains("\"method\": \"host.update\"", StringComparison.Ordinal)
            && content.Contains("\"hostid\"", StringComparison.Ordinal)
            && content.Contains("Model.TemplatesToClear", StringComparison.Ordinal))
        {
            return "hostUpdateJsonRpcRequestLines";
        }

        if (content.Contains("\"method\": \"host.delete\"", StringComparison.Ordinal)
            && content.Contains("\"params\": [", StringComparison.Ordinal))
        {
            return "hostDeleteJsonRpcRequestLines";
        }

        if (content.Contains("\"method\": \"host.get\"", StringComparison.Ordinal)
            && content.Contains("fallbackUpdateParams", StringComparison.Ordinal)
            && content.Contains("selectInterfaces", StringComparison.Ordinal))
        {
            return "hostGetByHostJsonRpcRequestLines";
        }

        return null;
    }

    private static bool IsStandardTemplateName(string? templateName)
    {
        return string.Equals(templateName, "hostCreateJsonRpcRequestLines", StringComparison.Ordinal)
            || string.Equals(templateName, "hostUpdateJsonRpcRequestLines", StringComparison.Ordinal)
            || string.Equals(templateName, "hostDeleteJsonRpcRequestLines", StringComparison.Ordinal)
            || string.Equals(templateName, "hostGetByHostJsonRpcRequestLines", StringComparison.Ordinal);
    }

    private static JsonObject BuildHostMutationRequest(
        ZabbixHostCreateModel model,
        string method,
        JsonObject parameters)
    {
        return BuildBaseRequest(model, method, parameters);
    }

    private static JsonObject BuildHostDeleteRequest(ZabbixHostCreateModel model)
    {
        return BuildBaseRequest(
            model,
            "host.delete",
            new JsonArray(model.ZabbixHostId ?? string.Empty));
    }

    private static JsonObject BuildHostGetRequest(ZabbixHostCreateModel model)
    {
        var metadata = BuildMetadata(model);
        metadata["fallbackForMethod"] = model.FallbackForMethod ?? string.Empty;
        metadata["createOnUpdateWhenMissing"] = model.CreateOnUpdateWhenMissing;
        if (model.CreateOnUpdateWhenMissing)
        {
            metadata["fallbackCreateParams"] = BuildHostCreateParams(model);
        }

        metadata["fallbackUpdateParams"] = BuildHostUpdateParams(model, includeHostId: false);

        return new JsonObject
        {
            ["cmdb2monitoring"] = metadata,
            ["jsonrpc"] = "2.0",
            ["method"] = "host.get",
            ["params"] = new JsonObject
            {
                ["output"] = new JsonArray("hostid", "host", "name"),
                ["selectInterfaces"] = new JsonArray("interfaceid", "type", "main", "useip", "ip", "dns", "port"),
                ["selectGroups"] = new JsonArray("groupid", "name"),
                ["selectParentTemplates"] = new JsonArray("templateid"),
                ["selectTags"] = new JsonArray("tag", "value"),
                ["selectMacros"] = new JsonArray("hostmacroid", "macro", "value", "description", "type"),
                ["selectInventory"] = "extend",
                ["filter"] = new JsonObject
                {
                    ["host"] = new JsonArray(model.Host)
                }
            },
            ["id"] = model.RequestId
        };
    }

    private static JsonObject BuildBaseRequest(
        ZabbixHostCreateModel model,
        string method,
        JsonNode? parameters)
    {
        return new JsonObject
        {
            ["cmdb2monitoring"] = BuildMetadata(model),
            ["jsonrpc"] = "2.0",
            ["method"] = method,
            ["params"] = parameters,
            ["id"] = model.RequestId
        };
    }

    private static JsonObject BuildMetadata(ZabbixHostCreateModel model)
    {
        return new JsonObject
        {
            ["eventType"] = model.EventType,
            ["entityId"] = model.EntityId ?? string.Empty,
            ["host"] = model.Host,
            ["hostProfile"] = model.HostProfileName
        };
    }

    private static JsonObject BuildHostCreateParams(ZabbixHostCreateModel model)
    {
        var parameters = BuildCommonHostParams(model);
        parameters["inventory_mode"] = model.InventoryMode;
        return parameters;
    }

    private static JsonObject BuildHostUpdateParams(ZabbixHostCreateModel model, bool includeHostId = true)
    {
        var parameters = BuildCommonHostParams(model);
        if (includeHostId)
        {
            parameters.Insert(0, "hostid", model.ZabbixHostId ?? string.Empty);
        }

        if (model.TemplatesToClear.Count > 0)
        {
            parameters["templates_clear"] = BuildTemplates(model.TemplatesToClear);
        }

        return parameters;
    }

    private static JsonObject BuildCommonHostParams(ZabbixHostCreateModel model)
    {
        var parameters = new JsonObject
        {
            ["host"] = model.Host,
            ["name"] = model.VisibleName,
            ["status"] = model.Status
        };

        if (!string.IsNullOrWhiteSpace(model.ProxyId))
        {
            parameters["proxyid"] = model.ProxyId;
        }

        if (!string.IsNullOrWhiteSpace(model.ProxyGroupId))
        {
            parameters["proxy_groupid"] = model.ProxyGroupId;
        }

        if (model.TlsPsk.Enabled)
        {
            parameters["tls_connect"] = model.TlsPsk.TlsConnect ?? 1;
            parameters["tls_accept"] = model.TlsPsk.TlsAccept ?? 1;
        }

        if (model.TlsPsk.HasIdentity)
        {
            parameters["tls_psk_identity"] = model.TlsPsk.TlsPskIdentity;
        }

        if (model.TlsPsk.HasPsk)
        {
            parameters["tls_psk"] = model.TlsPsk.TlsPsk;
        }

        parameters["interfaces"] = BuildInterfaces(model.Interfaces);
        parameters["groups"] = BuildGroups(model.Groups);
        parameters["templates"] = BuildTemplates(model.Templates);
        parameters["tags"] = BuildTags(model.Tags);

        if (model.Macros.Count > 0)
        {
            parameters["macros"] = BuildMacros(model.Macros);
        }

        if (model.InventoryFields.Count > 0)
        {
            parameters["inventory"] = BuildInventory(model.InventoryFields);
        }

        return parameters;
    }

    private static JsonArray BuildInterfaces(IEnumerable<ZabbixInterfaceModel> interfaces)
    {
        var array = new JsonArray();
        foreach (var zabbixInterface in interfaces)
        {
            var item = new JsonObject
            {
                ["type"] = zabbixInterface.Type,
                ["main"] = zabbixInterface.Main,
                ["useip"] = zabbixInterface.UseIp,
                ["ip"] = zabbixInterface.Ip,
                ["dns"] = zabbixInterface.Dns,
                ["port"] = zabbixInterface.Port
            };

            if (zabbixInterface.Details.Enabled)
            {
                var details = new JsonObject();
                if (zabbixInterface.Details.Version.HasValue)
                {
                    details["version"] = zabbixInterface.Details.Version.Value;
                }

                if (zabbixInterface.Details.Bulk.HasValue)
                {
                    details["bulk"] = zabbixInterface.Details.Bulk.Value;
                }

                if (!string.IsNullOrWhiteSpace(zabbixInterface.Details.Community))
                {
                    details["community"] = zabbixInterface.Details.Community;
                }

                item["details"] = details;
            }

            array.Add(item);
        }

        return array;
    }

    private static JsonArray BuildGroups(IEnumerable<ZabbixGroupModel> groups)
    {
        var array = new JsonArray();
        foreach (var group in groups)
        {
            var item = new JsonObject();
            if (!string.IsNullOrWhiteSpace(group.GroupId))
            {
                item["groupid"] = group.GroupId;
            }
            else
            {
                item["name"] = group.Name;
                item["createIfMissing"] = group.CreateIfMissing;
            }

            array.Add(item);
        }

        return array;
    }

    private static JsonArray BuildTemplates(IEnumerable<ZabbixTemplateModel> templates)
    {
        var array = new JsonArray();
        foreach (var template in templates)
        {
            array.Add(new JsonObject
            {
                ["templateid"] = template.TemplateId
            });
        }

        return array;
    }

    private static JsonArray BuildTags(IEnumerable<ZabbixTagModel> tags)
    {
        var array = new JsonArray();
        foreach (var tag in tags)
        {
            array.Add(new JsonObject
            {
                ["tag"] = tag.Tag,
                ["value"] = tag.Value
            });
        }

        return array;
    }

    private static JsonArray BuildMacros(IEnumerable<ZabbixMacroModel> macros)
    {
        var array = new JsonArray();
        foreach (var macro in macros)
        {
            var item = new JsonObject
            {
                ["macro"] = macro.Macro,
                ["value"] = macro.Value
            };
            if (!string.IsNullOrWhiteSpace(macro.Description))
            {
                item["description"] = macro.Description;
            }

            array.Add(item);
        }

        return array;
    }

    private static JsonObject BuildInventory(IEnumerable<ZabbixInventoryFieldModel> fields)
    {
        var inventory = new JsonObject();
        foreach (var field in fields)
        {
            inventory[field.Field] = field.Value;
        }

        return inventory;
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

        rendered = Regex.Replace(
            rendered,
            "<#=\\s*Model\\.(?<function>Regex|RegexReplace)\\((?<args>.*?)\\)\\s*#>",
            match => RenderRegexFunction(match, model),
            RegexOptions.CultureInvariant | RegexOptions.Singleline,
            TimeSpan.FromMilliseconds(500));

        return Regex.Replace(
            rendered,
            "<#=\\s*Model\\.(?:Field|Source)\\([\"'](?<name>[^\"']+)[\"']\\)\\s*#>",
            match => model.Field(match.Groups["name"].Value),
            RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(500));
    }

    private static string RenderRegexFunction(Match match, ZabbixHostCreateModel model)
    {
        var args = ParseQuotedArguments(match.Groups["args"].Value);
        if (args.Count < 2)
        {
            return string.Empty;
        }

        var value = model.Field(args[0]);
        var pattern = args[1];
        if (args.Count >= 3 || string.Equals(match.Groups["function"].Value, "RegexReplace", StringComparison.Ordinal))
        {
            var replacement = args.Count >= 3 ? args[2] : string.Empty;
            return Regex.Replace(value, pattern, replacement, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(500));
        }

        var regexMatch = Regex.Match(value, pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(500));
        if (!regexMatch.Success)
        {
            return string.Empty;
        }

        return regexMatch.Groups.Count > 1 ? regexMatch.Groups[1].Value : regexMatch.Value;
    }

    private static List<string> ParseQuotedArguments(string args)
    {
        var result = new List<string>();
        var index = 0;
        while (index < args.Length)
        {
            while (index < args.Length && (char.IsWhiteSpace(args[index]) || args[index] == ','))
            {
                index++;
            }

            if (index >= args.Length)
            {
                break;
            }

            var quote = args[index];
            if (quote is not ('"' or '\''))
            {
                break;
            }

            index++;
            var builder = new StringBuilder();
            while (index < args.Length)
            {
                var current = args[index++];
                if (current == quote)
                {
                    break;
                }

                if (current == '\\' && index < args.Length)
                {
                    var escaped = args[index++];
                    switch (escaped)
                    {
                        case 'n':
                            builder.Append('\n');
                            break;
                        case 'r':
                            builder.Append('\r');
                            break;
                        case 't':
                            builder.Append('\t');
                            break;
                        case '\\':
                            builder.Append('\\');
                            break;
                        case '"':
                            builder.Append('"');
                            break;
                        case '\'':
                            builder.Append('\'');
                            break;
                        default:
                            builder.Append('\\');
                            builder.Append(escaped);
                            break;
                    }
                    continue;
                }

                builder.Append(current);
            }

            result.Add(builder.ToString());
        }

        return result;
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
