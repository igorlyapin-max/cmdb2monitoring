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
required(config, 'Auth.SessionCookieName');
required(config, 'Auth.MaxSamlPostBytes');
required(config, 'Idp.Provider');
required(config, 'Idp.SpEntityId');
required(config, 'Idp.AcsUrl');
required(config, 'Idp.SloCallbackUrl');
required(config, 'Idp.NameIdFormat');
required(config, 'Idp.AuthnRequestBinding');
required(config, 'Cmdbuild.BaseUrl');
required(config, 'Cmdbuild.ServiceAccount');
required(config, 'Zabbix.ApiEndpoint');
required(config, 'Zabbix.ServiceAccount');
required(config, 'Rules.RulesFilePath');
required(config, 'Services.HealthEndpoints');

if (!existsSync(join(repoRoot, config.Rules.RulesFilePath))) {
  errors.push(`Rules file does not exist: ${config.Rules.RulesFilePath}`);
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
