import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(serviceRoot, '../..');
const environment = process.env.NODE_ENV || 'Development';
const config = await loadConfig();
const sessions = new Map();

await ensureRuntimeDirectories();

if (config.Zabbix?.Catalog?.SyncOnStartup) {
  console.warn('Zabbix catalog SyncOnStartup is configured but requires user credentials; skipping startup sync.');
}

if (config.Cmdbuild?.Catalog?.SyncOnStartup) {
  console.warn('CMDBuild catalog SyncOnStartup is configured but requires user credentials; skipping startup sync.');
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const statusCode = error?.statusCode ?? 500;
    if (statusCode >= 500) {
      console.error(error);
    }

    sendJson(response, statusCode, {
      error: error?.code ?? 'internal_error',
      message: error instanceof Error ? error.message : 'Unexpected error'
    });
  }
});

server.listen(config.Service.Port, config.Service.Host, () => {
  console.log(`${config.Service.Name} listening on http://${config.Service.Host}:${config.Service.Port}`);
});

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = trimTrailingSlash(url.pathname);

  if (request.method === 'GET' && path === config.Service.HealthRoute) {
    sendJson(response, 200, {
      service: config.Service.Name,
      status: 'ok'
    });
    return;
  }

  if (path.startsWith('/api/')) {
    await routeApi(request, response, url, path);
    return;
  }

  await serveStatic(response, path);
}

async function routeApi(request, response, url, path) {
  if (request.method === 'GET' && path === '/api/auth/status') {
    const session = getSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      user: session ? publicUser(session) : null,
      idp: publicIdpSettings(),
      auth: {
        useIdp: Boolean(config.Auth.UseIdp),
        requireCmdbuildCredentialsWhenIdpDisabled: Boolean(config.Auth.RequireCmdbuildCredentialsWhenIdpDisabled),
        requireZabbixCredentialsWhenIdpDisabled: Boolean(config.Auth.RequireZabbixCredentialsWhenIdpDisabled)
      }
    });
    return;
  }

  if (request.method === 'POST' && path === '/api/auth/login') {
    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    const session = await login(payload);
    const cookie = buildSessionCookie(session.id);
    sendJson(response, 200, {
      authenticated: true,
      user: publicUser(session)
    }, {
      'Set-Cookie': cookie
    });
    return;
  }

  if (request.method === 'POST' && path === '/api/auth/logout') {
    const sessionId = readCookie(request, config.Auth.SessionCookieName);
    if (sessionId) {
      sessions.delete(sessionId);
    }

    sendJson(response, 200, { success: true }, {
      'Set-Cookie': `${config.Auth.SessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
    });
    return;
  }

  const session = requireSession(request, response);
  if (!session) {
    return;
  }

  if (request.method === 'GET' && path === '/api/services/health') {
    sendJson(response, 200, await readServicesHealth());
    return;
  }

  if (request.method === 'GET' && path === '/api/events') {
    sendJson(response, 200, {
      items: [],
      source: 'not_configured',
      message: 'Kafka event browsing requires a Kafka adapter in monitoring-ui-api.'
    });
    return;
  }

  if (request.method === 'GET' && path === '/api/rules/current') {
    sendJson(response, 200, await readCurrentRules());
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/validate') {
    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await validateRulesPayload(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/dry-run') {
    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await dryRunRules(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/upload') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await uploadRules(payload, session));
    return;
  }

  if (request.method === 'GET' && path === '/api/rules/history') {
    sendJson(response, 200, await readRulesHistory());
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/catalog/status') {
    sendJson(response, 200, await readCatalogStatus(config.Zabbix.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/catalog') {
    sendJson(response, 200, await readCatalogCache(config.Zabbix.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/zabbix/catalog/')) {
    const catalog = await readCatalogCache(config.Zabbix.Catalog.CacheFilePath);
    sendJson(response, 200, readCatalogCollection(catalog, path.split('/').pop()));
    return;
  }

  if (request.method === 'POST' && path === '/api/zabbix/catalog/sync') {
    requireRole(session, response, ['admin', 'operator']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await syncZabbixCatalog(session));
    return;
  }

  if (request.method === 'GET' && path === '/api/cmdbuild/catalog/status') {
    sendJson(response, 200, await readCatalogStatus(config.Cmdbuild.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path === '/api/cmdbuild/catalog') {
    sendJson(response, 200, await readCatalogCache(config.Cmdbuild.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/cmdbuild/catalog/')) {
    const catalog = await readCatalogCache(config.Cmdbuild.Catalog.CacheFilePath);
    sendJson(response, 200, readCatalogCollection(catalog, path.split('/').pop()));
    return;
  }

  if (request.method === 'POST' && path === '/api/cmdbuild/catalog/sync') {
    requireRole(session, response, ['admin', 'operator']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await syncCmdbuildCatalog(session));
    return;
  }

  if (request.method === 'GET' && path === '/api/settings/idp') {
    sendJson(response, 200, publicIdpSettings());
    return;
  }

  if (request.method === 'PUT' && path === '/api/settings/idp') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await saveIdpSettings(payload));
    return;
  }

  sendJson(response, 404, {
    error: 'not_found',
    path
  });
}

async function loadConfig() {
  const base = JSON.parse(await readFile(join(serviceRoot, 'config/appsettings.json'), 'utf8'));
  const environmentConfigPath = join(serviceRoot, `config/appsettings.${environment}.json`);
  const merged = existsSync(environmentConfigPath)
    ? mergeObjects(base, JSON.parse(await readFile(environmentConfigPath, 'utf8')))
    : base;

  applyEnvOverrides(merged);
  return merged;
}

function mergeObjects(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeObjects(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function applyEnvOverrides(target) {
  const mapping = {
    PORT: ['Service', 'Port'],
    MONITORING_UI_HOST: ['Service', 'Host'],
    MONITORING_UI_USE_IDP: ['Auth', 'UseIdp'],
    CMDBUILD_BASE_URL: ['Cmdbuild', 'BaseUrl'],
    ZABBIX_API_ENDPOINT: ['Zabbix', 'ApiEndpoint'],
    RULES_FILE_PATH: ['Rules', 'RulesFilePath']
  };

  for (const [envName, path] of Object.entries(mapping)) {
    if (process.env[envName] === undefined) {
      continue;
    }

    setPath(target, path, parseEnvValue(process.env[envName]));
  }
}

async function ensureRuntimeDirectories() {
  for (const configuredPath of [
    config.Cmdbuild.Catalog.CacheFilePath,
    config.Zabbix.Catalog.CacheFilePath,
    'state/ui-settings.json'
  ]) {
    await mkdir(resolveServicePath(configuredPath, true), { recursive: true });
  }
}

async function login(payload) {
  if (config.Auth.UseIdp || config.Idp.Enabled) {
    throw httpError(501, 'idp_not_implemented', 'SAML2 login flow is not implemented in this first UI slice.');
  }

  const cmdbuild = payload?.cmdbuild ?? {};
  const zabbix = payload?.zabbix ?? {};
  if (config.Auth.RequireCmdbuildCredentialsWhenIdpDisabled
      && (isBlank(cmdbuild.username) || isBlank(cmdbuild.password))) {
    throw httpError(400, 'missing_cmdbuild_credentials', 'CMDBuild login/password are required when IdP is disabled.');
  }

  if (config.Auth.RequireZabbixCredentialsWhenIdpDisabled
      && isBlank(zabbix.apiToken)
      && (isBlank(zabbix.username) || isBlank(zabbix.password))) {
    throw httpError(400, 'missing_zabbix_credentials', 'Zabbix login/password or API token are required when IdP is disabled.');
  }

  const session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    roles: ['admin', 'operator', 'readonly'],
    cmdbuild: {
      baseUrl: cmdbuild.baseUrl || config.Cmdbuild.BaseUrl,
      username: cmdbuild.username,
      password: cmdbuild.password
    },
    zabbix: {
      apiEndpoint: zabbix.apiEndpoint || config.Zabbix.ApiEndpoint,
      username: zabbix.username,
      password: zabbix.password,
      apiToken: zabbix.apiToken
    }
  };

  sessions.set(session.id, session);
  return session;
}

async function readServicesHealth() {
  const items = [];
  await Promise.all((config.Services.HealthEndpoints ?? []).map(async endpoint => {
    const startedAt = Date.now();
    try {
      const result = await fetch(endpoint.Url, { signal: AbortSignal.timeout(2000) });
      items.push({
        name: endpoint.Name,
        url: endpoint.Url,
        ok: result.ok,
        statusCode: result.status,
        latencyMs: Date.now() - startedAt,
        body: await safeJson(result)
      });
    } catch (error) {
      items.push({
        name: endpoint.Name,
        url: endpoint.Url,
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'request_failed'
      });
    }
  }));

  items.sort((left, right) => left.name.localeCompare(right.name));
  return { items };
}

async function readCurrentRules() {
  const path = resolveRepoPath(config.Rules.RulesFilePath);
  const content = await readFile(path, 'utf8');
  const rules = JSON.parse(content);
  return {
    path: config.Rules.RulesFilePath,
    fileName: basename(path),
    schemaVersion: rules.schemaVersion,
    name: rules.name,
    validation: await validateRulesObject(rules),
    content: rules
  };
}

async function validateRulesPayload(payload) {
  const rules = isEmptyObject(payload) ? (await readCurrentRules()).content : normalizeRulesPayload(payload);
  return validateRulesObject(rules);
}

async function validateRulesObject(rules) {
  const errors = [];
  const warnings = [];

  requireString(rules, 'schemaVersion', errors);
  requireString(rules, 'name', errors);
  requireObject(rules, 'source', errors);
  requireObject(rules, 'zabbix', errors);
  requireObject(rules, 'defaults', errors);
  requireArray(rules, 'eventRoutingRules', errors);
  requireArray(rules, 'groupSelectionRules', errors);
  requireArray(rules, 'templateSelectionRules', errors);
  requireArray(rules, 'interfaceSelectionRules', errors);
  requireArray(rules, 'tagSelectionRules', errors);

  for (const eventType of ['create', 'update', 'delete']) {
    if (!rules.eventRoutingRules?.some(route => equalsIgnoreCase(route.eventType, eventType))) {
      errors.push(`eventRoutingRules must contain '${eventType}'.`);
    }
  }

  for (const templateName of [
    'hostCreateJsonRpcRequestLines',
    'hostUpdateJsonRpcRequestLines',
    'hostDeleteJsonRpcRequestLines',
    'hostGetByHostJsonRpcRequestLines'
  ]) {
    if (!Array.isArray(rules.t4Templates?.[templateName]) || rules.t4Templates[templateName].length === 0) {
      errors.push(`t4Templates.${templateName} must be a non-empty array.`);
    }
  }

  const hostGetTemplate = (rules.t4Templates?.hostGetByHostJsonRpcRequestLines ?? []).join('\n');
  for (const marker of ['cmdb2monitoring', 'fallbackForMethod', 'fallbackUpdateParams', 'selectInterfaces']) {
    if (!hostGetTemplate.includes(marker)) {
      errors.push(`hostGetByHostJsonRpcRequestLines must contain '${marker}'.`);
    }
  }

  await validateRulesAgainstCatalogs(rules, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

async function validateRulesAgainstCatalogs(rules, errors, warnings) {
  const zabbixCatalog = await tryReadCatalogCache(config.Zabbix.Catalog.CacheFilePath);
  if (zabbixCatalog?.templates?.length) {
    const templateIds = new Set(zabbixCatalog.templates.map(template => String(template.templateid)));
    for (const templateId of collectLookupIds(rules, 'templateid')) {
      if (!templateIds.has(templateId)) {
        errors.push(`Zabbix templateid '${templateId}' is not present in catalog cache.`);
      }
    }
  } else if (config.Zabbix.Catalog.ValidateRulesAgainstCatalog) {
    warnings.push('Zabbix catalog cache is empty; template/group validation against catalog was skipped.');
  }

  if (zabbixCatalog?.hostGroups?.length) {
    const groupIds = new Set(zabbixCatalog.hostGroups.map(group => String(group.groupid)));
    for (const groupId of collectLookupIds(rules, 'groupid')) {
      if (!groupIds.has(groupId)) {
        errors.push(`Zabbix host groupid '${groupId}' is not present in catalog cache.`);
      }
    }
  }

  const cmdbuildCatalog = await tryReadCatalogCache(config.Cmdbuild.Catalog.CacheFilePath);
  if (cmdbuildCatalog?.classes?.length && Array.isArray(rules.source?.entityClasses)) {
    const classNames = new Set(cmdbuildCatalog.classes.map(item => String(item.name).toLowerCase()));
    for (const className of rules.source.entityClasses) {
      if (!classNames.has(String(className).toLowerCase())) {
        errors.push(`CMDBuild class '${className}' is not present in catalog cache.`);
      }
    }
  } else if (config.Cmdbuild.Catalog.ValidateRulesAgainstCatalog) {
    warnings.push('CMDBuild catalog cache is empty; class/attribute validation against catalog was skipped.');
  }
}

async function dryRunRules(payload) {
  const rules = payload?.rules ? normalizeRulesPayload({ content: payload.rules }) : (await readCurrentRules()).content;
  const source = payload?.payload ?? payload?.source ?? {};
  const validation = await validateRulesObject(rules);
  const normalized = normalizeSourcePayload(source);
  const route = (rules.eventRoutingRules ?? []).find(item => equalsIgnoreCase(item.eventType, normalized.eventType));
  const model = buildDryRunModel(rules, normalized, route);

  return {
    validation,
    source: normalized,
    route: route ? {
      eventType: route.eventType,
      method: route.method,
      requiresZabbixHostId: Boolean(route.requiresZabbixHostId),
      fallbackMethod: route.fallbackMethod || null,
      fallbackForMethod: route.requiresZabbixHostId && !normalized.zabbixHostId ? route.method : null
    } : null,
    result: model
  };
}

async function uploadRules(payload, session) {
  if (!config.Rules.AllowUpload) {
    throw httpError(403, 'rules_upload_disabled', 'Rules upload is disabled by configuration.');
  }

  const rules = normalizeRulesPayload(payload);
  const validation = await validateRulesObject(rules);
  if (!validation.valid) {
    return {
      saved: false,
      validation
    };
  }

  const save = payload?.save !== false && config.Rules.AllowSave;
  if (!save) {
    return {
      saved: false,
      validation
    };
  }

  const rulesPath = resolveRepoPath(config.Rules.RulesFilePath);
  await writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');

  let git = null;
  if (config.Rules.AutoCommit) {
    git = await commitRules(session);
  }

  return {
    saved: true,
    path: config.Rules.RulesFilePath,
    validation,
    git
  };
}

async function readRulesHistory() {
  const result = await runGit(['log', '--oneline', '--', config.Rules.RulesFilePath]);
  return {
    available: result.exitCode === 0,
    items: result.exitCode === 0
      ? result.stdout.trim().split('\n').filter(Boolean).map(line => {
        const [commit, ...message] = line.split(' ');
        return { commit, message: message.join(' ') };
      })
      : [],
    error: result.exitCode === 0 ? null : result.stderr
  };
}

async function commitRules(session) {
  const add = await runGit(['add', config.Rules.RulesFilePath]);
  if (add.exitCode !== 0) {
    return { committed: false, error: add.stderr };
  }

  const message = `${config.Rules.CommitMessage}\n\nUser: ${session.cmdbuild?.username ?? 'unknown'}\nTimestamp: ${new Date().toISOString()}`;
  const commit = await runGit(['commit', '-m', message]);
  return {
    committed: commit.exitCode === 0,
    stdout: commit.stdout,
    stderr: commit.stderr
  };
}

async function syncZabbixCatalog(session) {
  const apiEndpoint = session.zabbix.apiEndpoint || config.Zabbix.ApiEndpoint;
  const token = await resolveZabbixToken(apiEndpoint, session.zabbix);
  const hostGroups = await zabbixCall(apiEndpoint, token, 'hostgroup.get', {
    output: ['groupid', 'name']
  });
  const templateGroups = await zabbixCallOptional(apiEndpoint, token, 'templategroup.get', {
    output: ['groupid', 'name']
  });
  const templates = await zabbixCall(apiEndpoint, token, 'template.get', {
    output: ['templateid', 'host', 'name'],
    selectGroups: ['groupid', 'name']
  });
  const hosts = await zabbixCallOptional(apiEndpoint, token, 'host.get', {
    output: ['hostid', 'host', 'name'],
    selectTags: ['tag', 'value']
  });
  const tags = collectZabbixTags(hosts);

  const catalog = {
    syncedAt: new Date().toISOString(),
    zabbixEndpoint: apiEndpoint,
    hostGroups,
    templateGroups,
    templates,
    tags
  };
  await writeCatalogCache(config.Zabbix.Catalog.CacheFilePath, catalog);

  return catalog;
}

async function syncCmdbuildCatalog(session) {
  const baseUrl = withoutTrailingSlash(session.cmdbuild.baseUrl || config.Cmdbuild.BaseUrl);
  const classesResult = await cmdbuildGet(baseUrl, '/classes', session.cmdbuild);
  const classes = normalizeCmdbuildList(classesResult).map(item => ({
    name: item.name ?? item._id ?? item.id,
    description: item.description ?? item.label ?? '',
    active: item.active ?? item.isActive ?? true,
    parent: item.parent ?? item.superclass ?? item.prototype ?? null,
    raw: item
  })).filter(item => item.name);

  const selectedClasses = config.Cmdbuild.Catalog.IncludeInactiveClasses
    ? classes
    : classes.filter(item => item.active !== false);
  const attributes = [];
  for (const cmdbClass of selectedClasses.slice(0, 250)) {
    try {
      const attributesResult = await cmdbuildGet(baseUrl, `/classes/${encodeURIComponent(cmdbClass.name)}/attributes`, session.cmdbuild);
      attributes.push({
        className: cmdbClass.name,
        items: normalizeCmdbuildList(attributesResult)
      });
    } catch (error) {
      attributes.push({
        className: cmdbClass.name,
        error: error instanceof Error ? error.message : 'request_failed',
        items: []
      });
    }
  }

  let lookups = [];
  if (config.Cmdbuild.Catalog.IncludeLookupValues) {
    try {
      lookups = normalizeCmdbuildList(await cmdbuildGet(baseUrl, '/lookup_types', session.cmdbuild));
    } catch {
      lookups = [];
    }
  }

  const catalog = {
    syncedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    classes: selectedClasses,
    attributes,
    lookups
  };
  await writeCatalogCache(config.Cmdbuild.Catalog.CacheFilePath, catalog);

  return catalog;
}

async function resolveZabbixToken(apiEndpoint, credentials) {
  if (!isBlank(credentials.apiToken)) {
    return credentials.apiToken;
  }

  const result = await zabbixRawCall(apiEndpoint, null, {
    jsonrpc: '2.0',
    method: 'user.login',
    params: {
      username: credentials.username,
      password: credentials.password
    },
    id: 1
  });

  if (!result.result) {
    throw httpError(502, 'zabbix_login_failed', 'Zabbix login did not return a token.');
  }

  return result.result;
}

async function zabbixCall(apiEndpoint, token, method, params) {
  const result = await zabbixRawCall(apiEndpoint, token, {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now()
  });
  return result.result ?? [];
}

async function zabbixCallOptional(apiEndpoint, token, method, params) {
  try {
    return await zabbixCall(apiEndpoint, token, method, params);
  } catch {
    return [];
  }
}

async function zabbixRawCall(apiEndpoint, token, body) {
  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const json = await response.json();
  if (!response.ok || json.error) {
    throw httpError(502, 'zabbix_api_error', json.error?.data || json.error?.message || `HTTP ${response.status}`);
  }

  return json;
}

async function cmdbuildGet(baseUrl, path, credentials) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw httpError(502, 'cmdbuild_api_error', `CMDBuild returned HTTP ${response.status} for ${path}.`);
  }

  return response.json();
}

async function saveIdpSettings(payload) {
  const statePath = resolveServiceFile('state/ui-settings.json');
  const safePayload = {
    idp: {
      provider: 'SAML2',
      enabled: Boolean(payload?.enabled),
      metadataUrl: payload?.metadataUrl ?? '',
      entityId: payload?.entityId ?? '',
      ssoUrl: payload?.ssoUrl ?? '',
      sloUrl: payload?.sloUrl ?? '',
      idpX509Certificate: payload?.idpX509Certificate ?? '',
      spEntityId: payload?.spEntityId ?? config.Idp.SpEntityId,
      acsUrl: payload?.acsUrl ?? config.Idp.AcsUrl,
      spCertificate: payload?.spCertificate ?? '',
      spPrivateKey: payload?.spPrivateKey ?? '',
      nameIdFormat: payload?.nameIdFormat ?? config.Idp.NameIdFormat,
      requireSignedAssertions: payload?.requireSignedAssertions ?? true,
      requireEncryptedAssertions: payload?.requireEncryptedAssertions ?? false,
      clockSkewSeconds: Number(payload?.clockSkewSeconds ?? config.Idp.ClockSkewSeconds ?? 120),
      attributeMapping: payload?.attributeMapping ?? config.Idp.AttributeMapping,
      roleMapping: payload?.roleMapping ?? config.Idp.RoleMapping,
      savedAt: new Date().toISOString()
    }
  };

  await mkdir(resolveServicePath('state', false), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(safePayload, null, 2)}\n`, 'utf8');
  Object.assign(config.Idp, safePayload.idp, { Enabled: safePayload.idp.enabled });
  config.Auth.UseIdp = safePayload.idp.enabled;

  return publicIdpSettings();
}

function publicIdpSettings() {
  return {
    provider: 'SAML2',
    enabled: Boolean(config.Idp.Enabled || config.Auth.UseIdp),
    metadataUrl: config.Idp.MetadataUrl || config.Idp.metadataUrl || '',
    entityId: config.Idp.EntityId || config.Idp.entityId || '',
    ssoUrl: config.Idp.SsoUrl || config.Idp.ssoUrl || '',
    sloUrl: config.Idp.SloUrl || config.Idp.sloUrl || '',
    spEntityId: config.Idp.SpEntityId || config.Idp.spEntityId || '',
    acsUrl: config.Idp.AcsUrl || config.Idp.acsUrl || '',
    nameIdFormat: config.Idp.NameIdFormat || config.Idp.nameIdFormat || '',
    requireSignedAssertions: Boolean(config.Idp.RequireSignedAssertions ?? config.Idp.requireSignedAssertions),
    requireEncryptedAssertions: Boolean(config.Idp.RequireEncryptedAssertions ?? config.Idp.requireEncryptedAssertions),
    clockSkewSeconds: Number(config.Idp.ClockSkewSeconds ?? config.Idp.clockSkewSeconds ?? 120),
    attributeMapping: config.Idp.AttributeMapping || config.Idp.attributeMapping || {},
    roleMapping: config.Idp.RoleMapping || config.Idp.roleMapping || {},
    secretsConfigured: {
      idpX509Certificate: !isBlank(config.Idp.IdpX509Certificate || config.Idp.idpX509Certificate),
      spCertificate: !isBlank(config.Idp.SpCertificate || config.Idp.spCertificate),
      spPrivateKey: !isBlank(config.Idp.SpPrivateKey || config.Idp.spPrivateKey)
    }
  };
}

function buildDryRunModel(rules, source, route) {
  const className = source.className || source.entityType || 'unknown';
  const hostInput = source.code || source.id || source.entityId || 'unknown';
  const host = normalizeHostName(rules, className, hostInput, source);
  const fallbackForMethod = route?.requiresZabbixHostId && !source.zabbixHostId ? route.method : null;

  return {
    host,
    visibleName: `${className} ${source.code || source.id || source.entityId || ''}`.trim(),
    method: fallbackForMethod ? route.fallbackMethod : route?.method,
    fallbackForMethod,
    groups: selectLookupItems(rules.groupSelectionRules, rules, source, 'hostGroups', 'hostGroupsRef'),
    templates: selectLookupItems(rules.templateSelectionRules, rules, source, 'templates', 'templatesRef'),
    interface: selectInterface(rules, source),
    tags: selectTags(rules, source),
    requestId: buildRequestId(source.entityId || source.id || host)
  };
}

function normalizeHostName(rules, className, hostInput, source) {
  let value = `${renderSimple(rules.normalization?.hostName?.prefixTemplate ?? 'cmdb-<#= Model.ClassName #>-', {
    ClassName: className,
    EntityId: source.entityId || source.id,
    Code: source.code
  })}${hostInput}`;

  for (const replacement of rules.normalization?.hostName?.regexReplacements ?? []) {
    value = value.replace(new RegExp(replacement.pattern, 'g'), replacement.replacement ?? '');
  }

  return rules.normalization?.hostName?.lowercase ? value.toLowerCase() : value;
}

function selectLookupItems(rulesList = [], rules, source, propertyName, refName) {
  const matches = rulesList
    .filter(rule => !rule.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .filter(rule => matchesCondition(rule.when, source));
  const selected = matches.length > 0
    ? matches
    : rulesList.filter(rule => rule.fallback).filter(rule => matchesCondition(rule.when, source));
  const items = selected.flatMap(rule => {
    if (Array.isArray(rule[propertyName]) && rule[propertyName].length > 0) {
      return rule[propertyName];
    }

    if (rule[refName] === `defaults.${propertyName}`) {
      return rules.defaults?.[propertyName] ?? [];
    }

    return [];
  });

  const unique = new Map();
  for (const item of items) {
    unique.set(item.groupid || item.templateid || item.name, item);
  }

  return [...unique.values()];
}

function selectInterface(rules, source) {
  const rule = (rules.interfaceSelectionRules ?? [])
    .filter(item => !item.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .find(item => matchesCondition(item.when, source))
    ?? (rules.interfaceSelectionRules ?? []).find(item => item.fallback && matchesCondition(item.when, source));
  return rule?.interfaceRef === 'snmpInterface'
    ? rules.defaults?.snmpInterface
    : rules.defaults?.agentInterface;
}

function selectTags(rules, source) {
  const defaults = rules.defaults?.tags ?? [];
  const matched = (rules.tagSelectionRules ?? [])
    .filter(item => !item.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .filter(item => matchesCondition(item.when, source));
  const selected = matched.length > 0
    ? matched
    : (rules.tagSelectionRules ?? []).filter(item => item.fallback && matchesCondition(item.when, source));
  const tags = [...defaults, ...selected.flatMap(item => item.tags ?? [])]
    .map(tag => ({
      tag: tag.tag,
      value: tag.value || renderSimple(tag.valueTemplate, {
        ClassName: source.className,
        EntityId: source.entityId || source.id,
        Code: source.code
      })
    }));
  const unique = new Map();
  for (const tag of tags) {
    unique.set(tag.tag, tag);
  }

  return [...unique.values()];
}

function matchesCondition(condition = {}, source) {
  if (condition.always) {
    return true;
  }

  for (const matcher of condition.anyRegex ?? []) {
    const value = readSourceField(source, matcher.field);
    if (!isBlank(value) && compileRuleRegex(matcher.pattern).test(value)) {
      return true;
    }
  }

  return false;
}

function normalizeSourcePayload(payload) {
  const data = payload.payload ?? payload;
  return {
    source: data.source ?? payload.source ?? 'cmdbuild',
    eventType: data.eventType ?? payload.eventType ?? 'create',
    entityType: data.entityType ?? payload.entityType ?? data.className,
    entityId: data.id ?? payload.entityId ?? payload.id,
    id: data.id ?? payload.id,
    code: data.code ?? payload.code,
    className: data.className ?? payload.className ?? payload.entityType,
    ip_address: data.ip_address ?? data.ipAddress ?? payload.ip_address ?? payload.ipAddress,
    description: data.description ?? payload.description,
    os: data.os ?? payload.os,
    zabbixTag: data.zabbixTag ?? payload.zabbixTag,
    zabbixHostId: data.zabbix_hostid ?? data.zabbixHostId ?? payload.zabbix_hostid ?? payload.zabbixHostId
  };
}

function readSourceField(source, field) {
  const normalized = field?.toLowerCase();
  return {
    source: source.source,
    eventtype: source.eventType,
    entitytype: source.entityType,
    entityid: source.entityId ?? source.id,
    id: source.id ?? source.entityId,
    code: source.code,
    classname: source.className,
    class: source.className,
    ipaddress: source.ip_address,
    ip_address: source.ip_address,
    os: source.os,
    operatingsystem: source.os,
    zabbixtag: source.zabbixTag,
    zabbix_tag: source.zabbixTag,
    zabbixhostid: source.zabbixHostId,
    zabbix_hostid: source.zabbixHostId
  }[normalized];
}

function normalizeRulesPayload(payload) {
  if (payload?.content && typeof payload.content === 'string') {
    return JSON.parse(payload.content);
  }

  if (payload?.content && typeof payload.content === 'object') {
    return payload.content;
  }

  if (payload?.rules && typeof payload.rules === 'object') {
    return payload.rules;
  }

  if (payload && typeof payload === 'object') {
    return payload;
  }

  throw httpError(400, 'invalid_rules_payload', 'Rules payload must contain JSON object or content string.');
}

function isEmptyObject(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

async function serveStatic(response, path) {
  const publicDir = resolveServicePath(config.Service.PublicDir, false);
  const requestedPath = path === '/' ? '/index.html' : path;
  const fullPath = normalize(resolve(publicDir, `.${requestedPath}`));
  if (!fullPath.startsWith(publicDir) || !existsSync(fullPath)) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }

  response.writeHead(200, {
    'content-type': contentTypeFor(fullPath),
    'cache-control': 'no-store'
  });
  createReadStream(fullPath).pipe(response);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw httpError(413, 'payload_too_large', 'Request body is too large.');
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw httpError(400, 'invalid_json', error instanceof Error ? error.message : 'Invalid JSON');
  }
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, {
      error: 'not_authenticated'
    });
    return null;
  }

  return session;
}

function getSession(request) {
  const sessionId = readCookie(request, config.Auth.SessionCookieName);
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  const expiresAt = Date.parse(session.lastSeenAt) + (config.Auth.SessionTimeoutMinutes * 60 * 1000);
  if (Date.now() > expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  session.lastSeenAt = new Date().toISOString();
  return session;
}

function requireRole(session, response, allowedRoles) {
  if (!allowedRoles.some(role => session.roles.includes(role))) {
    sendJson(response, 403, {
      error: 'forbidden'
    });
  }
}

function publicUser(session) {
  return {
    roles: session.roles,
    createdAt: session.createdAt,
    cmdbuild: {
      baseUrl: session.cmdbuild.baseUrl,
      username: session.cmdbuild.username
    },
    zabbix: {
      apiEndpoint: session.zabbix.apiEndpoint,
      username: session.zabbix.username,
      apiTokenConfigured: !isBlank(session.zabbix.apiToken)
    }
  };
}

async function readCatalogStatus(cachePath) {
  const fullPath = resolveServiceFile(cachePath);
  if (!existsSync(fullPath)) {
    return {
      exists: false,
      path: cachePath
    };
  }

  const info = await stat(fullPath);
  const cache = await readCatalogCache(cachePath);
  return {
    exists: true,
    path: cachePath,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    syncedAt: cache.syncedAt ?? null
  };
}

async function readCatalogCache(cachePath) {
  const fullPath = resolveServiceFile(cachePath);
  if (!existsSync(fullPath)) {
    return {
      exists: false,
      items: []
    };
  }

  return JSON.parse(await readFile(fullPath, 'utf8'));
}

async function tryReadCatalogCache(cachePath) {
  try {
    return await readCatalogCache(cachePath);
  } catch {
    return null;
  }
}

async function writeCatalogCache(cachePath, catalog) {
  const fullPath = resolveServiceFile(cachePath);
  await mkdir(resolveServicePath(cachePath, true), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

function readCatalogCollection(catalog, name) {
  const mapping = {
    templates: 'templates',
    'host-groups': 'hostGroups',
    'template-groups': 'templateGroups',
    tags: 'tags',
    classes: 'classes',
    lookups: 'lookups',
    attributes: 'attributes'
  };
  return {
    items: catalog?.[mapping[name] ?? name] ?? []
  };
}

function collectZabbixTags(hosts) {
  const tags = new Map();
  for (const host of hosts ?? []) {
    for (const tag of host.tags ?? []) {
      const key = `${tag.tag}\u0000${tag.value ?? ''}`;
      tags.set(key, {
        tag: tag.tag,
        value: tag.value ?? ''
      });
    }
  }

  return [...tags.values()].sort((left, right) => `${left.tag}:${left.value}`.localeCompare(`${right.tag}:${right.value}`));
}

function normalizeCmdbuildList(result) {
  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  if (Array.isArray(result?.items)) {
    return result.items;
  }

  return [];
}

function collectLookupIds(value, idPropertyName, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLookupIds(item, idPropertyName, result);
    }
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === idPropertyName.toLowerCase() && !isBlank(item)) {
        result.add(String(item));
      } else {
        collectLookupIds(item, idPropertyName, result);
      }
    }
  }

  return [...result];
}

function buildRequestId(value) {
  let hash = 17;
  for (const character of String(value)) {
    hash = ((hash * 31) + character.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

function renderSimple(template = '', model) {
  return template
    .replaceAll('<#= Model.ClassName #>', model.ClassName ?? '')
    .replaceAll('<#= Model.EntityId #>', model.EntityId ?? '')
    .replaceAll('<#= Model.Code ?? Model.EntityId #>', model.Code ?? model.EntityId ?? '')
    .replaceAll('<#= Model.Code #>', model.Code ?? '');
}

function compileRuleRegex(pattern) {
  let source = String(pattern ?? '');
  let flags = '';
  if (source.startsWith('(?i)')) {
    flags = 'i';
    source = source.slice(4);
  }

  return new RegExp(source, flags);
}

function runGit(args) {
  return new Promise(resolvePromise => {
    const child = spawn(config.Rules.GitExecutablePath, ['-C', repositoryRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', exitCode => {
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readCookie(request, name) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (rawName === name) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}

function buildSessionCookie(sessionId) {
  const maxAge = Math.max(60, Number(config.Auth.SessionTimeoutMinutes) * 60);
  return `${config.Auth.SessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function contentTypeFor(path) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extname(path)] ?? 'application/octet-stream';
}

function resolveServiceFile(path) {
  return resolve(serviceRoot, path);
}

function resolveServicePath(path, directoryOnly) {
  const fullPath = resolve(serviceRoot, path);
  return directoryOnly ? resolve(fullPath, '..') : fullPath;
}

function resolveRepoPath(path) {
  const fullPath = resolve(repositoryRoot, path);
  if (!fullPath.startsWith(repositoryRoot)) {
    throw httpError(400, 'invalid_path', 'Configured path escapes repository root.');
  }

  return fullPath;
}

function trimTrailingSlash(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function withoutTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function equalsIgnoreCase(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

function requireString(object, property, errors) {
  if (isBlank(object?.[property])) {
    errors.push(`${property} is required.`);
  }
}

function requireObject(object, property, errors) {
  if (!isPlainObject(object?.[property])) {
    errors.push(`${property} object is required.`);
  }
}

function requireArray(object, property, errors) {
  if (!Array.isArray(object?.[property]) || object[property].length === 0) {
    errors.push(`${property} array is required.`);
  }
}

function setPath(target, path, value) {
  let current = target;
  for (const part of path.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[path.at(-1)] = value;
}

function parseEnvValue(value) {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  return value;
}

process.on('unhandledRejection', error => {
  console.error(error);
});
