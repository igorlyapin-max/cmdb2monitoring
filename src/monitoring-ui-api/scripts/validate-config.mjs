import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const serviceRoot = resolve(new URL('..', import.meta.url).pathname);
const repoRoot = resolve(serviceRoot, '../..');
const errors = [];

for (const relativePath of ['config/appsettings.json', 'config/appsettings.Development.json']) {
  const fullPath = join(serviceRoot, relativePath);
  try {
    JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
  }
}

const config = JSON.parse(readFileSync(join(serviceRoot, 'config/appsettings.json'), 'utf8'));
required(config, 'Service.Name');
required(config, 'Service.HealthRoute');
required(config, 'Secrets.Provider');
required(config, 'UiSettings.FilePath');
required(config, 'Auth.UsersFilePath');
required(config, 'Auth.SessionCookieName');
required(config, 'Auth.MaxSamlPostBytes');
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
required(config, 'Cmdbuild.Catalog.MaxTraversalDepth');
required(config, 'Zabbix.ApiEndpoint');
required(config, 'Rules.ReadFromGit');
required(config, 'Rules.RepositoryPath');
required(config, 'Rules.RulesFilePath');
required(config, 'AuditStorage.Provider');
required(config, 'AuditStorage.CommandTimeoutSeconds');
required(config, 'EventBrowser.BootstrapServers');
required(config, 'EventBrowser.ClientId');
required(config, 'EventBrowser.SecurityProtocol');
required(config, 'EventBrowser.Topics');
required(config, 'Services.HealthEndpoints');

if (!existsSync(join(repoRoot, config.Rules.RulesFilePath))) {
  errors.push(`Rules file does not exist: ${config.Rules.RulesFilePath}`);
}

if (typeof config.Rules.ReadFromGit !== 'boolean') {
  errors.push('Rules.ReadFromGit must be boolean.');
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

for (const expectedTopic of ['zabbix.host.bindings', 'zabbixbindings2cmdbuild.logs']) {
  if (!config.EventBrowser.Topics.some(topic => topic?.Name === expectedTopic)) {
    errors.push(`EventBrowser.Topics must include ${expectedTopic}.`);
  }
}

if (!config.Services.HealthEndpoints.some(endpoint => endpoint?.Name === 'zabbixbindings2cmdbuild')) {
  errors.push('Services.HealthEndpoints must include zabbixbindings2cmdbuild.');
}

if (!['Plaintext', 'Ssl', 'SaslPlaintext', 'SaslSsl'].includes(config.EventBrowser.SecurityProtocol)) {
  errors.push(`EventBrowser.SecurityProtocol has unsupported value: ${config.EventBrowser.SecurityProtocol}`);
}

if (!intInRange(config.Cmdbuild?.Catalog?.MaxTraversalDepth, 2, 5)) {
  errors.push('Cmdbuild.Catalog.MaxTraversalDepth must be an integer from 2 to 5.');
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
