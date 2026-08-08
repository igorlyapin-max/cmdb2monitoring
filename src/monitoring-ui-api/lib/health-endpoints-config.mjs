const tokenEnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const productionServiceNames = [
  'cmdbwebhooks2kafka',
  'cmdbkafka2zabbix',
  'zabbixrequests2api',
  'zabbixbindings2cmdbuild'
];
const productionServiceNameSet = new Set(productionServiceNames);
const converterServiceName = 'cmdbkafka2zabbix';

export function applyHealthEndpointsConfig(target, {
  environment = 'Development',
  environmentVariables = process.env
} = {}) {
  const rawOverride = environmentVariables.MONITORING_UI_HEALTH_ENDPOINTS_JSON;
  const endpoints = rawOverride === undefined
    ? target.Services?.HealthEndpoints
    : parseHealthEndpointsJson(rawOverride);

  target.Services ??= {};
  target.Services.HealthEndpoints = normalizeHealthEndpoints(endpoints, {
    environment,
    environmentVariables
  });
}

export function parseHealthEndpointsJson(value) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error('MONITORING_UI_HEALTH_ENDPOINTS_JSON must be valid JSON: ' + error.message);
  }
}

export function normalizeHealthEndpoints(endpoints, {
  environment = 'Development',
  environmentVariables = process.env
} = {}) {
  if (!Array.isArray(endpoints)) {
    throw new Error('Services.HealthEndpoints must be a JSON array.');
  }

  const production = String(environment).toLowerCase() === 'production';
  const names = new Set();
  const normalizedEndpoints = endpoints.map((rawEndpoint, index) => {
    if (!isPlainObject(rawEndpoint)) {
      throw new Error('Services.HealthEndpoints[' + index + '] must be an object.');
    }

    const label = 'Services.HealthEndpoints[' + index + ']';
    const name = requiredString(rawEndpoint.Name ?? rawEndpoint.name, label + '.Name');
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(label + '.Name duplicates ' + JSON.stringify(name) + '.');
    }
    names.add(normalizedName);

    const endpoint = {
      Name: name,
      Url: normalizeUrl(rawEndpoint.Url ?? rawEndpoint.url, label + '.Url', environment, name)
    };

    copyOptionalUrl(rawEndpoint, endpoint, 'RulesReloadUrl', label, environment, name);
    copyOptionalUrl(rawEndpoint, endpoint, 'RulesStatusUrl', label, environment, name);

    const reloadToken = resolveToken(rawEndpoint, 'RulesReloadToken', label, environmentVariables);
    if (endpoint.RulesReloadUrl && !reloadToken) {
      throw new Error(label + '.RulesReloadUrl requires RulesReloadToken or RulesReloadTokenEnv.');
    }
    if (reloadToken) {
      endpoint.RulesReloadToken = reloadToken;
    }

    const statusToken = resolveToken(rawEndpoint, 'RulesStatusToken', label, environmentVariables);
    if (statusToken) {
      endpoint.RulesStatusToken = statusToken;
    }

    return endpoint;
  });

  if (production) {
    validateProductionEndpointSet(normalizedEndpoints);
  }

  return normalizedEndpoints;
}

function copyOptionalUrl(source, target, field, label, environment, serviceName) {
  const value = source[field] ?? source[lowercaseFirst(field)];
  if (isBlank(value)) {
    return;
  }

  target[field] = normalizeUrl(value, label + '.' + field, environment, serviceName);
}

function resolveToken(source, field, label, environmentVariables) {
  const directValue = source[field] ?? source[lowercaseFirst(field)];
  const environmentField = field + 'Env';
  const environmentName = source[environmentField] ?? source[lowercaseFirst(environmentField)];
  if (isBlank(environmentName)) {
    return isBlank(directValue) ? '' : String(directValue);
  }

  const normalizedEnvironmentName = String(environmentName).trim();
  if (!tokenEnvironmentNamePattern.test(normalizedEnvironmentName)) {
    throw new Error(label + '.' + environmentField + ' must be an environment variable name.');
  }

  const value = environmentVariables[normalizedEnvironmentName];
  return value === undefined || isBlank(value) ? '' : String(value);
}

function normalizeUrl(value, field, environment, serviceName) {
  const url = requiredString(value, field);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(field + ' must be an absolute HTTP(S) URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(field + ' must be an absolute HTTP(S) URL without embedded credentials.');
  }

  if (String(environment).toLowerCase() === 'production') {
    validateProductionServiceUrl(parsed, field, serviceName);
  }

  return parsed.toString();
}

function validateProductionServiceUrl(parsed, field, serviceName) {
  const normalizedServiceName = String(serviceName).toLowerCase();
  if (!productionServiceNameSet.has(normalizedServiceName)) {
    throw new Error(field + ' must use a declared Compose service name in Production.');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== normalizedServiceName || parsed.port !== '8080') {
    throw new Error(field + ' must use http://' + normalizedServiceName + ':8080 Compose DNS in Production.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error(field + ' must not include query or fragment data in Production.');
  }
}

function validateProductionEndpointSet(endpoints) {
  if (endpoints.length !== productionServiceNames.length) {
    throw new Error('Services.HealthEndpoints must contain exactly: ' + productionServiceNames.join(', ') + ' in Production.');
  }

  const endpointByName = new Map(endpoints.map(endpoint => [endpoint.Name.toLowerCase(), endpoint]));
  for (const name of productionServiceNames) {
    if (!endpointByName.has(name)) {
      throw new Error('Services.HealthEndpoints must include ' + name + ' in Production.');
    }
  }

  const converter = endpointByName.get(converterServiceName);
  if (!converter.RulesReloadUrl || !converter.RulesStatusUrl) {
    throw new Error(converterServiceName + ' must configure RulesReloadUrl and RulesStatusUrl in Production.');
  }
  for (const endpoint of endpoints) {
    if (endpoint.Name.toLowerCase() !== converterServiceName && (endpoint.RulesReloadUrl || endpoint.RulesStatusUrl)) {
      throw new Error('Only ' + converterServiceName + ' may configure rules reload or status URLs in Production.');
    }
  }
}

function requiredString(value, field) {
  if (isBlank(value)) {
    throw new Error(field + ' is required.');
  }

  return String(value).trim();
}

function lowercaseFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
