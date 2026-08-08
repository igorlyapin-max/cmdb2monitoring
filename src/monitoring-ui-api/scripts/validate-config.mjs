import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeHealthEndpoints } from '../lib/health-endpoints-config.mjs';

const serviceRoot = resolve(new URL('..', import.meta.url).pathname);
const repoRoot = resolve(serviceRoot, '../..');
const errors = [];
const parsedConfigs = new Map();

for (const relativePath of ['config/appsettings.json', 'config/appsettings.Development.json']) {
  const fullPath = join(serviceRoot, relativePath);
  try {
    parsedConfigs.set(relativePath, JSON.parse(readFileSync(fullPath, 'utf8')));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
  }
}

const config = parsedConfigs.get('config/appsettings.json') ?? {};
const developmentConfig = parsedConfigs.get('config/appsettings.Development.json') ?? {};
required(config, 'Service.Name');
required(config, 'Service.HealthRoute');
required(config, 'Transport.Mode');
required(config, 'Transport.AllowPlainHttp');
required(config, 'Secrets.Provider');
required(config, 'UiSettings.FilePath');
required(config, 'Auth.UsersFilePath');
required(config, 'Auth.SessionCookieName');
required(config, 'Auth.SessionTimeoutMinutes');
required(config, 'Auth.SessionAbsoluteLifetimeMinutes');
required(config, 'Auth.SessionStore.Mode');
required(config, 'Auth.MaxSamlPostBytes');
required(config, 'RateLimit.Enabled');
required(config, 'RateLimit.WindowSeconds');
required(config, 'RateLimit.AuthPermitLimit');
required(config, 'RateLimit.ApiPermitLimit');
required(config, 'Logging.MinimumLevel');
required(config, 'DebugLogging.Enabled');
required(config, 'DebugLogging.Level');
required(config, 'ElkLogging.Enabled');
required(config, 'ElkLogging.Mode');
required(config, 'ElkLogging.Kafka.Enabled');
required(config, 'ElkLogging.Kafka.Topic');
required(config, 'ElkLogging.Kafka.ClientId');
required(config, 'ElkLogging.Kafka.SecurityProtocol');
required(config, 'ElkLogging.Kafka.MinimumLevel');
required(config, 'ElkLogging.Kafka.ServiceName');
required(config, 'ElkLogging.Kafka.Environment');
required(config, 'ElkLogging.Kafka.FlushTimeoutMs');
required(config, 'Idp.Provider');
required(config, 'Idp.SpEntityId');
required(config, 'Idp.AcsUrl');
required(config, 'Idp.SloCallbackUrl');
required(config, 'Idp.NameIdFormat');
required(config, 'Idp.AuthnRequestBinding');
required(config, 'Idp.OAuth2.RedirectUri');
required(config, 'Idp.OAuth2.Scopes');
required(config, 'Idp.OAuth2.LoginClaim');
required(config, 'Idp.OAuth2.GroupsClaim');
required(config, 'Idp.Ldap.Protocol');
required(config, 'Idp.Ldap.Port');
required(config, 'Idp.Ldap.UserFilter');
required(config, 'Idp.Ldap.GroupFilter');
required(config, 'Idp.Ldap.LoginAttribute');
required(config, 'Idp.Ldap.GroupsAttribute');
required(config, 'Cmdbuild.BaseUrl');
required(config, 'Cmdbuild.ApiVersion');
required(config, 'Cmdbuild.Catalog.MaxTraversalDepth');
required(config, 'Zabbix.ApiEndpoint');
required(config, 'Rules.ReadFromGit');
required(config, 'Rules.RepositoryPath');
required(config, 'Rules.RulesFilePath');
required(config, 'Rules.ActiveBaseDirectory');
required(config, 'Rules.ActiveFilePath');
required(config, 'Rules.ActiveWriteEnabled');
required(config, 'AuditStorage.Provider');
required(config, 'AuditStorage.CommandTimeoutSeconds');
required(config, 'EventBrowser.BootstrapServers');
required(config, 'EventBrowser.ClientId');
required(config, 'EventBrowser.SecurityProtocol');
required(config, 'EventBrowser.Topics');
required(config, 'QueueMonitor.Enabled');
required(config, 'QueueMonitor.RefreshIntervalMs');
required(config, 'QueueMonitor.Pipelines');
required(config, 'Services.HealthEndpoints');

if (!existsSync(join(repoRoot, config.Rules.RulesFilePath))) {
  errors.push(`Rules file does not exist: ${config.Rules.RulesFilePath}`);
}

const activeRulesBaseDirectory = resolve(serviceRoot, config.Rules.ActiveBaseDirectory);
const activeRulesFilePath = resolve(activeRulesBaseDirectory, config.Rules.ActiveFilePath);
if (!activeRulesFilePath.startsWith(`${activeRulesBaseDirectory}/`) && activeRulesFilePath !== activeRulesBaseDirectory) {
  errors.push('Rules.ActiveFilePath must stay inside Rules.ActiveBaseDirectory.');
} else if (!existsSync(activeRulesFilePath)) {
  errors.push(`Active rules file does not exist: ${config.Rules.ActiveFilePath}`);
}

if (typeof config.Rules.ReadFromGit !== 'boolean') {
  errors.push('Rules.ReadFromGit must be boolean.');
}

if (typeof config.Rules.ActiveWriteEnabled !== 'boolean') {
  errors.push('Rules.ActiveWriteEnabled must be boolean.');
}

if (!['Http', 'Https'].includes(config.Transport?.Mode)) {
  errors.push(`Transport.Mode has unsupported value: ${config.Transport?.Mode}`);
}

if (typeof config.Transport?.AllowPlainHttp !== 'boolean') {
  errors.push('Transport.AllowPlainHttp must be boolean.');
}

if (config.Transport?.Mode === 'Https') {
  required(config, 'Transport.Certificate.Path');
  required(config, 'Transport.Certificate.KeyPath');
}

if (!intInRange(config.Auth?.SessionTimeoutMinutes, 1, 480)) {
  errors.push('Auth.SessionTimeoutMinutes must be an integer from 1 to 480.');
}

if (!intInRange(config.Auth?.SessionAbsoluteLifetimeMinutes, 1, 1440)) {
  errors.push('Auth.SessionAbsoluteLifetimeMinutes must be an integer from 1 to 1440.');
}

if (!['Memory', 'Redis'].includes(config.Auth?.SessionStore?.Mode)) {
  errors.push(`Auth.SessionStore.Mode has unsupported value: ${config.Auth?.SessionStore?.Mode}`);
}

if (typeof config.RateLimit?.Enabled !== 'boolean') {
  errors.push('RateLimit.Enabled must be boolean.');
}

if (!validLogLevel(config.Logging?.MinimumLevel)) {
  errors.push(`Logging.MinimumLevel has unsupported value: ${config.Logging?.MinimumLevel}`);
}

if (typeof config.DebugLogging?.Enabled !== 'boolean') {
  errors.push('DebugLogging.Enabled must be boolean.');
}

if (!['Basic', 'Verbose'].includes(config.DebugLogging?.Level)) {
  errors.push(`DebugLogging.Level has unsupported value: ${config.DebugLogging?.Level}`);
}

if (!['Kafka', 'Elasticsearch'].includes(config.ElkLogging?.Mode)) {
  errors.push(`ElkLogging.Mode has unsupported value: ${config.ElkLogging?.Mode}`);
}

if (typeof config.ElkLogging?.Enabled !== 'boolean') {
  errors.push('ElkLogging.Enabled must be boolean.');
}

if (typeof config.ElkLogging?.Kafka?.Enabled !== 'boolean') {
  errors.push('ElkLogging.Kafka.Enabled must be boolean.');
}

if (config.ElkLogging?.Enabled && config.ElkLogging?.Kafka?.Enabled) {
  required(config, 'ElkLogging.Kafka.BootstrapServers');
  if (!['Plaintext', 'Ssl', 'SaslPlaintext', 'SaslSsl'].includes(config.ElkLogging.Kafka.SecurityProtocol)) {
    errors.push(`ElkLogging.Kafka.SecurityProtocol has unsupported value: ${config.ElkLogging.Kafka.SecurityProtocol}`);
  }
  if (!['', 'Plain', 'ScramSha256', 'ScramSha512'].includes(config.ElkLogging.Kafka.SaslMechanism ?? '')) {
    errors.push(`ElkLogging.Kafka.SaslMechanism has unsupported value: ${config.ElkLogging.Kafka.SaslMechanism}`);
  }
  if (!['All', 'Leader', 'None', -1, 1, 0].includes(config.ElkLogging.Kafka.Acks)) {
    errors.push(`ElkLogging.Kafka.Acks has unsupported value: ${config.ElkLogging.Kafka.Acks}`);
  }
  if (!validLogLevel(config.ElkLogging.Kafka.MinimumLevel)) {
    errors.push(`ElkLogging.Kafka.MinimumLevel has unsupported value: ${config.ElkLogging.Kafka.MinimumLevel}`);
  }
  if (!intInRange(config.ElkLogging.Kafka.MessageTimeoutMs, 1, 120000)) {
    errors.push('ElkLogging.Kafka.MessageTimeoutMs must be an integer from 1 to 120000.');
  }
  if (!intInRange(config.ElkLogging.Kafka.FlushTimeoutMs, 250, 30000)) {
    errors.push('ElkLogging.Kafka.FlushTimeoutMs must be an integer from 250 to 30000.');
  }
}

if (!intInRange(config.RateLimit?.WindowSeconds, 1, 3600)) {
  errors.push('RateLimit.WindowSeconds must be an integer from 1 to 3600.');
}

if (!intInRange(config.RateLimit?.AuthPermitLimit, 1, 1000000)) {
  errors.push('RateLimit.AuthPermitLimit must be an integer from 1 to 1000000.');
}

if (!intInRange(config.RateLimit?.ApiPermitLimit, 1, 1000000)) {
  errors.push('RateLimit.ApiPermitLimit must be an integer from 1 to 1000000.');
}

if (config.Auth?.SessionStore?.Mode === 'Redis') {
  required(config, 'Auth.SessionStore.Redis.Url');
  required(config, 'Auth.SessionEncryptionKey');
}

const secretsProvider = String(config.Secrets?.Provider ?? '').toLowerCase();
if (!['none', 'indeedpamaapm'].includes(secretsProvider)) {
  errors.push(`Secrets.Provider has unsupported value: ${config.Secrets?.Provider}`);
}

if (secretsProvider === 'indeedpamaapm') {
  required(config, 'Secrets.IndeedPamAapm.BaseUrl');
  required(config, 'Secrets.IndeedPamAapm.PasswordEndpointPath');
  if (!intInRange(config.Secrets?.IndeedPamAapm?.TimeoutMs, 1000, 120000)) {
    errors.push('Secrets.IndeedPamAapm.TimeoutMs must be an integer from 1000 to 120000.');
  }
}

if (!['sqlite', 'postgresql', 'postgres'].includes(String(config.AuditStorage?.Provider ?? '').toLowerCase())) {
  errors.push(`AuditStorage.Provider has unsupported value: ${config.AuditStorage?.Provider}`);
}

if (!intInRange(config.AuditStorage?.CommandTimeoutSeconds, 1, 300)) {
  errors.push('AuditStorage.CommandTimeoutSeconds must be an integer from 1 to 300.');
}

if (!Array.isArray(config.EventBrowser.Topics) || config.EventBrowser.Topics.length === 0) {
  errors.push('EventBrowser.Topics must contain at least one topic.');
}

if (!intInRange(config.QueueMonitor?.RefreshIntervalMs, 5000, 10000)) {
  errors.push('QueueMonitor.RefreshIntervalMs must be an integer from 5000 to 10000.');
}

if (!Array.isArray(config.QueueMonitor?.Pipelines) || config.QueueMonitor.Pipelines.length === 0) {
  errors.push('QueueMonitor.Pipelines must contain at least one pipeline.');
}

for (const pipeline of config.QueueMonitor?.Pipelines ?? []) {
  if (!pipeline?.Topic) {
    errors.push('QueueMonitor.Pipelines items must include Topic.');
  }
  if (!['Lag', 'TopicDepth', undefined].includes(pipeline?.Mode)) {
    errors.push(`QueueMonitor.Pipelines item ${pipeline?.Name ?? pipeline?.Topic ?? '<unknown>'} has unsupported Mode.`);
  }
  if (pipeline?.Mode !== 'TopicDepth' && !pipeline?.StateFilePath) {
    errors.push('QueueMonitor.Pipelines items must include StateFilePath.');
  }
}

for (const expectedTopic of ['zabbix.host.bindings', 'cmdbuild.webhooks.dlq', 'zabbix.host.requests.dlq', 'zabbixbindings2cmdbuild.logs', 'monitoring-ui-api.logs']) {
  if (!config.EventBrowser.Topics.some(topic => topic?.Name === expectedTopic)) {
    errors.push(`EventBrowser.Topics must include ${expectedTopic}.`);
  }
}

try {
  normalizeHealthEndpoints(config.Services?.HealthEndpoints, { environment: 'Base' });
} catch (error) {
  errors.push(`Services.HealthEndpoints: ${error.message}`);
}

let developmentHealthEndpoints = [];
try {
  developmentHealthEndpoints = normalizeHealthEndpoints(developmentConfig.Services?.HealthEndpoints, {
    environment: 'Development'
  });
} catch (error) {
  errors.push(`Development Services.HealthEndpoints: ${error.message}`);
}

if (!developmentHealthEndpoints.some(endpoint => endpoint.Name === 'zabbixbindings2cmdbuild')) {
  errors.push('Services.HealthEndpoints must include zabbixbindings2cmdbuild.');
}

if (!['Plaintext', 'Ssl', 'SaslPlaintext', 'SaslSsl'].includes(config.EventBrowser.SecurityProtocol)) {
  errors.push(`EventBrowser.SecurityProtocol has unsupported value: ${config.EventBrowser.SecurityProtocol}`);
}

if (!intInRange(config.Cmdbuild?.Catalog?.MaxTraversalDepth, 2, 5)) {
  errors.push('Cmdbuild.Catalog.MaxTraversalDepth must be an integer from 2 to 5.');
}

if (String(config.Cmdbuild?.ApiVersion ?? '').toLowerCase() !== 'v4') {
  errors.push('Cmdbuild.ApiVersion must be v4.');
}

if (!String(config.Cmdbuild?.BaseUrl ?? '').includes('/services/rest/v4')) {
  errors.push('Cmdbuild.BaseUrl must point to REST API v4.');
}

for (const relativePath of ['package.json', 'package-lock.json', 'server.mjs', 'public/index.html', 'public/styles.css', 'public/app.js']) {
  if (!existsSync(join(serviceRoot, relativePath))) {
    errors.push(`Missing file: ${relativePath}`);
  }
}

if (errors.length > 0) {
  console.error('monitoring-ui-api config validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('monitoring-ui-api config validation passed.');

function required(object, path) {
  let current = object;
  for (const part of path.split('.')) {
    current = current?.[part];
  }

  if (current === undefined || current === null || current === '') {
    errors.push(`Missing required config value: ${path}`);
  }
}

function intInRange(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max;
}

function validLogLevel(value) {
  return ['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical'].includes(value);
}
