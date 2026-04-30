import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kafka, logLevel } from 'kafkajs';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { parseStringPromise } from 'xml2js';

const serviceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(serviceRoot, '../..');
const environment = process.env.NODE_ENV || 'Development';
const config = await loadConfig();
const sessions = new Map();
let samlMetadataCache = null;

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

  if (path.startsWith('/auth/saml2')) {
    await routeSaml(request, response, url, path);
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
        useIdp: isIdpEnabled(),
        requireCmdbuildCredentialsWhenIdpDisabled: Boolean(config.Auth.RequireCmdbuildCredentialsWhenIdpDisabled),
        requireZabbixCredentialsWhenIdpDisabled: Boolean(config.Auth.RequireZabbixCredentialsWhenIdpDisabled),
        localLoginDefaults: publicLocalLoginDefaults()
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
    sendJson(response, 200, await readKafkaEvents(url));
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

  if (request.method === 'POST' && path === '/api/rules/fix-mapping') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await fixRulesMapping(payload, session));
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

  if (request.method === 'GET' && path === '/api/zabbix/catalog/mapping') {
    const catalog = await readCatalogCache(config.Zabbix.Catalog.CacheFilePath);
    sendJson(response, 200, readZabbixMappingCatalog(catalog));
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

  if (request.method === 'GET' && path === '/api/settings/runtime') {
    sendJson(response, 200, publicRuntimeSettings());
    return;
  }

  if (request.method === 'PUT' && path === '/api/settings/runtime') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await saveRuntimeSettings(payload));
    return;
  }

  sendJson(response, 404, {
    error: 'not_found',
    path
  });
}

async function routeSaml(request, response, url, path) {
  if (request.method === 'GET' && path === '/auth/saml2/metadata') {
    const metadata = await buildSamlMetadata();
    response.writeHead(200, {
      'content-type': 'application/samlmetadata+xml; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(metadata);
    return;
  }

  if (request.method === 'GET' && path === '/auth/saml2/login') {
    assertSamlEnabled();
    const saml = await createSamlClient();
    const relayState = safeRelayState(url.searchParams.get('returnUrl') ?? '/');
    const redirectUrl = await saml.getAuthorizeUrlAsync(relayState, request.headers.host, {});
    sendRedirect(response, redirectUrl);
    return;
  }

  if (request.method === 'POST' && path === '/auth/saml2/acs') {
    assertSamlEnabled();
    const form = await readFormBody(request, config.Auth.MaxSamlPostBytes ?? 1048576);
    const saml = await createSamlClient();
    const validation = await saml.validatePostResponseAsync(form);
    if (validation.loggedOut) {
      sendRedirect(response, '/');
      return;
    }

    if (!validation.profile) {
      throw httpError(401, 'saml_profile_missing', 'SAML response did not contain a user profile.');
    }

    const session = createSamlSession(validation.profile);
    sessions.set(session.id, session);
    sendRedirect(response, safeRelayState(form.RelayState ?? '/'), {
      'Set-Cookie': buildSessionCookie(session.id)
    });
    return;
  }

  if (request.method === 'GET' && path === '/auth/saml2/logout') {
    const sessionId = readCookie(request, config.Auth.SessionCookieName);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (sessionId) {
      sessions.delete(sessionId);
    }

    const expiredCookie = `${config.Auth.SessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
    if (session?.saml?.profile && !isBlank(config.Idp.SloUrl || config.Idp.sloUrl)) {
      const saml = await createSamlClient();
      const redirectUrl = await saml.getLogoutUrlAsync(session.saml.profile, '/', {});
      sendRedirect(response, redirectUrl, { 'Set-Cookie': expiredCookie });
      return;
    }

    sendRedirect(response, '/', { 'Set-Cookie': expiredCookie });
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

  await applyPersistedUiSettings(merged);
  applyEnvOverrides(merged);
  return merged;
}

async function applyPersistedUiSettings(target) {
  const settingsPath = resolveUiSettingsFile(target);
  if (!existsSync(settingsPath)) {
    return;
  }

  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (persisted.idp) {
    Object.assign(target.Idp, persisted.idp, { Enabled: Boolean(persisted.idp.enabled) });
    target.Auth.UseIdp = Boolean(persisted.idp.enabled);
  }

  applyRuntimeSettings(target, persisted);
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
    SAML2_METADATA_URL: ['Idp', 'MetadataUrl'],
    SAML2_ENTITY_ID: ['Idp', 'EntityId'],
    SAML2_SSO_URL: ['Idp', 'SsoUrl'],
    SAML2_SLO_URL: ['Idp', 'SloUrl'],
    SAML2_IDP_CERT: ['Idp', 'IdpX509Certificate'],
    SAML2_IDP_CERT_PATH: ['Idp', 'IdpX509CertificatePath'],
    SAML2_SP_ENTITY_ID: ['Idp', 'SpEntityId'],
    SAML2_ACS_URL: ['Idp', 'AcsUrl'],
    SAML2_SP_CERT_PATH: ['Idp', 'SpCertificatePath'],
    SAML2_SP_PRIVATE_KEY_PATH: ['Idp', 'SpPrivateKeyPath'],
    CMDBUILD_BASE_URL: ['Cmdbuild', 'BaseUrl'],
    CMDBUILD_SERVICE_USERNAME: ['Cmdbuild', 'ServiceAccount', 'Username'],
    CMDBUILD_SERVICE_PASSWORD: ['Cmdbuild', 'ServiceAccount', 'Password'],
    ZABBIX_API_ENDPOINT: ['Zabbix', 'ApiEndpoint'],
    ZABBIX_SERVICE_USER: ['Zabbix', 'ServiceAccount', 'User'],
    ZABBIX_SERVICE_PASSWORD: ['Zabbix', 'ServiceAccount', 'Password'],
    ZABBIX_SERVICE_API_TOKEN: ['Zabbix', 'ServiceAccount', 'ApiToken'],
    RULES_FILE_PATH: ['Rules', 'RulesFilePath'],
    MONITORING_UI_SETTINGS_FILE: ['UiSettings', 'FilePath'],
    MONITORING_UI_EVENTS_ENABLED: ['EventBrowser', 'Enabled'],
    MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS: ['EventBrowser', 'BootstrapServers'],
    MONITORING_UI_KAFKA_SECURITY_PROTOCOL: ['EventBrowser', 'SecurityProtocol'],
    MONITORING_UI_KAFKA_SASL_MECHANISM: ['EventBrowser', 'SaslMechanism'],
    MONITORING_UI_KAFKA_USERNAME: ['EventBrowser', 'Username'],
    MONITORING_UI_KAFKA_PASSWORD: ['EventBrowser', 'Password'],
    MONITORING_UI_EVENTS_MAX_MESSAGES: ['EventBrowser', 'MaxMessages'],
    MONITORING_UI_EVENTS_READ_TIMEOUT_MS: ['EventBrowser', 'ReadTimeoutMs']
  };

  for (const [envName, path] of Object.entries(mapping)) {
    if (process.env[envName] === undefined) {
      continue;
    }

    setPath(target, path, parseEnvValue(process.env[envName]));
  }

  if (process.env.MONITORING_UI_EVENTS_TOPICS !== undefined) {
    target.EventBrowser.Topics = normalizeStringArray(process.env.MONITORING_UI_EVENTS_TOPICS)
      .map(name => ({ Name: name, Service: '', Direction: '', Description: '' }));
  }
}

async function ensureRuntimeDirectories() {
  for (const configuredPath of [
    config.Cmdbuild.Catalog.CacheFilePath,
    config.Zabbix.Catalog.CacheFilePath,
    config.UiSettings?.FilePath ?? 'state/ui-settings.json'
  ]) {
    await mkdir(resolveServicePath(configuredPath, true), { recursive: true });
  }
}

async function login(payload) {
  if (isIdpEnabled()) {
    throw httpError(409, 'idp_enabled', 'Use /auth/saml2/login when IdP mode is enabled.');
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

async function readKafkaEvents(url) {
  const eventBrowser = config.EventBrowser ?? {};
  const topics = publicEventTopics();
  if (!eventBrowser.Enabled) {
    return {
      items: [],
      topics,
      selectedTopic: null,
      source: 'disabled',
      message: 'Kafka event browsing is disabled.'
    };
  }

  if (topics.length === 0) {
    return {
      items: [],
      topics,
      selectedTopic: null,
      source: 'not_configured',
      message: 'Kafka event browsing has no configured topics.'
    };
  }

  const requestedTopic = url.searchParams.get('topic') || topics[0].name;
  const topic = topics.find(item => item.name === requestedTopic);
  if (!topic) {
    throw httpError(400, 'unknown_topic', `Topic '${requestedTopic}' is not configured for event browsing.`);
  }

  const maxMessages = clampInt(url.searchParams.get('maxMessages'), eventBrowser.MaxMessages ?? 50, 1, 500);
  const readTimeoutMs = clampInt(url.searchParams.get('readTimeoutMs'), eventBrowser.ReadTimeoutMs ?? 2500, 500, 30000);
  const items = await readKafkaTopicMessages(topic, maxMessages, readTimeoutMs);

  return {
    items,
    topics,
    selectedTopic: topic.name,
    source: 'kafka',
    settings: {
      bootstrapServers: eventBrowser.BootstrapServers,
      maxMessages,
      readTimeoutMs
    },
    message: items.length === 0 ? 'Topic has no readable messages in the selected offset window.' : ''
  };
}

async function readKafkaTopicMessages(topic, maxMessages, readTimeoutMs) {
  const kafka = createKafkaClient();
  const admin = kafka.admin();
  const consumer = kafka.consumer({
    groupId: `${config.EventBrowser.ClientId || 'monitoring-ui-api-events'}-${randomUUID()}`
  });
  const partitionTargets = new Map();
  const items = [];
  let done = false;
  let resolveDone = () => {};

  try {
    await admin.connect();
    const offsets = await admin.fetchTopicOffsets(topic.name);
    for (const partitionOffset of offsets) {
      const high = BigInt(partitionOffset.high ?? partitionOffset.offset ?? '0');
      const low = BigInt(partitionOffset.low ?? '0');
      if (high <= low) {
        continue;
      }

      const requestedStart = high - BigInt(maxMessages);
      const start = requestedStart > low ? requestedStart : low;
      partitionTargets.set(Number(partitionOffset.partition), {
        start,
        high,
        done: false
      });
    }
  } finally {
    await disconnectKafka(admin);
  }

  if (partitionTargets.size === 0) {
    return [];
  }

  const donePromise = new Promise(resolvePromise => {
    resolveDone = resolvePromise;
  });

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: topic.name, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ partition, message }) => {
        const target = partitionTargets.get(Number(partition));
        if (!target) {
          return;
        }

        const offset = BigInt(message.offset);
        if (offset < target.start || offset >= target.high) {
          return;
        }

        items.push({
          topic: topic.name,
          service: topic.service,
          direction: topic.direction,
          partition,
          offset: message.offset,
          timestamp: message.timestamp ? new Date(Number(message.timestamp)).toISOString() : '',
          key: message.key?.toString('utf8') ?? '',
          value: message.value?.toString('utf8') ?? '',
          headers: headersToObject(message.headers)
        });

        if (offset >= target.high - 1n) {
          target.done = true;
        }

        if (items.length >= maxMessages || [...partitionTargets.values()].every(item => item.done)) {
          done = true;
          resolveDone();
        }
      }
    });

    for (const [partition, target] of partitionTargets) {
      consumer.seek({
        topic: topic.name,
        partition,
        offset: target.start.toString()
      });
    }

    await Promise.race([donePromise, sleep(readTimeoutMs)]);
  } catch (error) {
    throw httpError(502, 'kafka_event_browser_error', error instanceof Error ? error.message : 'Kafka event browsing failed.');
  } finally {
    if (!done) {
      resolveDone();
    }

    await disconnectKafka(consumer);
  }

  return items
    .sort((left, right) => {
      if (left.topic !== right.topic) {
        return left.topic.localeCompare(right.topic);
      }

      if (left.partition !== right.partition) {
        return left.partition - right.partition;
      }

      return Number(BigInt(left.offset) - BigInt(right.offset));
    })
    .slice(-maxMessages);
}

function createKafkaClient() {
  const eventBrowser = config.EventBrowser ?? {};
  const brokers = normalizeStringArray(eventBrowser.BootstrapServers);
  if (brokers.length === 0) {
    throw httpError(500, 'kafka_event_browser_config_invalid', 'EventBrowser.BootstrapServers is not configured.');
  }

  return new Kafka({
    clientId: eventBrowser.ClientId || 'monitoring-ui-api-events',
    brokers,
    ssl: kafkaSslOptions(eventBrowser),
    sasl: kafkaSaslOptions(eventBrowser),
    logLevel: logLevel.NOTHING
  });
}

function kafkaSslOptions(eventBrowser) {
  const protocol = eventBrowser.SecurityProtocol ?? 'Plaintext';
  if (!String(protocol).toLowerCase().includes('ssl')) {
    return undefined;
  }

  return {
    rejectUnauthorized: eventBrowser.SslRejectUnauthorized !== false
  };
}

function kafkaSaslOptions(eventBrowser) {
  const protocol = eventBrowser.SecurityProtocol ?? 'Plaintext';
  if (!String(protocol).toLowerCase().includes('sasl')) {
    return undefined;
  }

  const mechanism = kafkaSaslMechanism(eventBrowser.SaslMechanism);
  if (!mechanism) {
    throw httpError(500, 'kafka_event_browser_config_invalid', 'EventBrowser.SaslMechanism is not supported by monitoring-ui-api.');
  }

  if (isBlank(eventBrowser.Username) || isBlank(eventBrowser.Password)) {
    throw httpError(500, 'kafka_event_browser_config_invalid', 'EventBrowser SASL username/password are required.');
  }

  return {
    mechanism,
    username: eventBrowser.Username,
    password: eventBrowser.Password
  };
}

function kafkaSaslMechanism(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    plain: 'plain',
    scramsha256: 'scram-sha-256',
    scramsha512: 'scram-sha-512'
  }[normalized];
}

async function disconnectKafka(client) {
  try {
    await client.disconnect();
  } catch {
    // Ignore cleanup errors after read timeout or failed connection attempts.
  }
}

function headersToObject(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    Array.isArray(value)
      ? value.map(item => item?.toString('utf8') ?? '')
      : value?.toString('utf8') ?? ''
  ]));
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
  requireArray(rules, 'interfaceAddressRules', errors);
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
  const normalized = normalizeSourcePayload(source, rules);
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

async function fixRulesMapping(payload, session) {
  if (!config.Rules.AllowUpload || !config.Rules.AllowSave) {
    throw httpError(403, 'rules_save_disabled', 'Rules save is disabled by configuration.');
  }

  const operations = normalizeRulesFixOperations(payload?.operations);
  if (operations.length === 0) {
    throw httpError(400, 'empty_rules_fix', 'No mapping fix operations were selected.');
  }

  const current = await readCurrentRules();
  const rules = structuredClone(current.content);
  const changes = applyRulesFixOperations(rules, operations);
  const validation = await validateRulesObject(rules);

  if (!validation.valid) {
    return {
      saved: false,
      path: config.Rules.RulesFilePath,
      validation,
      changes
    };
  }

  if (changes.length === 0) {
    return {
      saved: false,
      path: config.Rules.RulesFilePath,
      validation,
      changes
    };
  }

  const rulesPath = resolveRepoPath(config.Rules.RulesFilePath);
  const backupPath = await backupRulesFile(rulesPath);
  await writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');

  let git = null;
  if (config.Rules.AutoCommit) {
    git = await commitRules(session);
  }

  return {
    saved: true,
    path: config.Rules.RulesFilePath,
    backupPath: relative(repositoryRoot, backupPath),
    validation,
    changes,
    git
  };
}

function normalizeRulesFixOperations(value) {
  if (!Array.isArray(value)) {
    throw httpError(400, 'invalid_rules_fix', 'operations must be an array.');
  }

  return value.slice(0, 250).map(operation => ({
    scope: String(operation?.scope ?? ''),
    kind: String(operation?.kind ?? ''),
    id: String(operation?.id ?? ''),
    name: String(operation?.name ?? ''),
    className: String(operation?.className ?? ''),
    fieldKey: String(operation?.fieldKey ?? ''),
    source: String(operation?.source ?? '')
  })).filter(operation => operation.scope && operation.kind);
}

function applyRulesFixOperations(rules, operations) {
  const changes = [];
  for (const operation of operations) {
    if (operation.scope === 'zabbix' && operation.kind === 'hostGroup') {
      removeRuleItemReferences(rules, operation, {
        lookupPath: ['lookups', 'hostGroups'],
        defaultsPath: ['defaults', 'hostGroups'],
        rulesList: 'groupSelectionRules',
        itemProperty: 'hostGroups',
        idField: 'groupid'
      }, changes);
    } else if (operation.scope === 'zabbix' && operation.kind === 'template') {
      removeRuleItemReferences(rules, operation, {
        lookupPath: ['lookups', 'templates'],
        defaultsPath: ['defaults', 'templates'],
        rulesList: 'templateSelectionRules',
        itemProperty: 'templates',
        idField: 'templateid'
      }, changes);
    } else if (operation.scope === 'zabbix' && operation.kind === 'templateGroup') {
      removeRuleItemReferences(rules, operation, {
        lookupPath: ['lookups', 'templateGroups'],
        defaultsPath: ['defaults', 'templateGroups'],
        rulesList: 'templateGroupSelectionRules',
        itemProperty: 'templateGroups',
        idField: 'groupid'
      }, changes);
    } else if (operation.scope === 'cmdbuild' && operation.kind === 'class') {
      removeSourceClassReference(rules, operation, changes);
    } else if (operation.scope === 'cmdbuild' && operation.kind === 'attribute') {
      removeSourceFieldReference(rules, operation, changes);
    }
  }

  return changes;
}

function removeRuleItemReferences(rules, operation, spec, changes) {
  const matcher = item => sameRulesFixItem(item, spec.idField, operation.id, operation.name);
  let removed = 0;
  removed += removeItemsAtPath(rules, spec.lookupPath, matcher);
  removed += removeItemsAtPath(rules, spec.defaultsPath, matcher);
  for (const rule of rules[spec.rulesList] ?? []) {
    removed += removeItemsFromArray(rule[spec.itemProperty], matcher);
  }

  if (removed > 0) {
    changes.push({
      scope: operation.scope,
      kind: operation.kind,
      id: operation.id,
      name: operation.name,
      removed
    });
  }
}

function removeSourceClassReference(rules, operation, changes) {
  const removed = removeItemsFromArray(rules.source?.entityClasses, item => sameNormalized(item, operation.className));
  if (removed > 0) {
    changes.push({
      scope: operation.scope,
      kind: operation.kind,
      className: operation.className,
      removed
    });
  }
}

function removeSourceFieldReference(rules, operation, changes) {
  const fields = rules.source?.fields;
  if (!fields || !fields[operation.fieldKey]) {
    return;
  }

  const source = fields[operation.fieldKey]?.source;
  if (operation.source && !sameNormalized(source, operation.source)) {
    return;
  }

  delete fields[operation.fieldKey];
  changes.push({
    scope: operation.scope,
    kind: operation.kind,
    className: operation.className,
    fieldKey: operation.fieldKey,
    source: operation.source,
    removed: 1
  });
}

function removeItemsAtPath(root, path, matcher) {
  const items = path.reduce((current, part) => current?.[part], root);
  return removeItemsFromArray(items, matcher);
}

function removeItemsFromArray(items, matcher) {
  if (!Array.isArray(items)) {
    return 0;
  }

  const originalLength = items.length;
  const kept = items.filter(item => !matcher(item));
  items.splice(0, items.length, ...kept);
  return originalLength - kept.length;
}

function sameRulesFixItem(item, idField, id, name) {
  const wanted = [id, name].map(normalizeToken).filter(Boolean);
  if (wanted.length === 0) {
    return false;
  }

  return [item?.[idField], item?.name, item?.host]
    .map(normalizeToken)
    .some(candidate => wanted.includes(candidate));
}

function sameNormalized(left, right) {
  return normalizeToken(left) === normalizeToken(right);
}

async function backupRulesFile(rulesPath) {
  const backupDir = join(dirname(rulesPath), '.backup');
  await mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `${basename(rulesPath)}.${timestamp}.bak`);
  await copyFile(rulesPath, backupPath);
  return backupPath;
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
  const proxies = await zabbixCallOptional(apiEndpoint, token, 'proxy.get', {
    output: ['proxyid', 'name']
  });
  const proxyGroups = await zabbixCallOptional(apiEndpoint, token, 'proxygroup.get', {
    output: ['proxy_groupid', 'name']
  });
  const globalMacros = await zabbixCallOptional(apiEndpoint, token, 'globalmacro.get', {
    output: ['globalmacroid', 'macro', 'value', 'description', 'type']
  });
  const hostMacros = await zabbixCallOptional(apiEndpoint, token, 'usermacro.get', {
    output: ['hostmacroid', 'hostid', 'macro', 'value', 'description', 'type'],
    selectHosts: ['hostid', 'host', 'name']
  });
  const maintenances = await zabbixCallOptional(apiEndpoint, token, 'maintenance.get', {
    output: ['maintenanceid', 'name', 'maintenance_type']
  });
  const valueMaps = await zabbixCallOptional(apiEndpoint, token, 'valuemap.get', {
    output: ['valuemapid', 'name'],
    selectMappings: ['type', 'value', 'newvalue']
  });

  const catalog = {
    syncedAt: new Date().toISOString(),
    zabbixEndpoint: apiEndpoint,
    hostGroups,
    templateGroups,
    templates,
    tags,
    proxies,
    proxyGroups,
    globalMacros,
    hostMacros,
    inventoryFields: zabbixInventoryFields(),
    interfaceProfiles: zabbixInterfaceProfiles(),
    hostStatuses: zabbixHostStatuses(),
    maintenances,
    tlsPskModes: zabbixTlsPskModes(),
    valueMaps
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
  const persisted = await readPersistedUiSettings();
  const safePayload = {
    idp: {
      provider: 'SAML2',
      enabled: Boolean(payload?.enabled),
      metadataUrl: payload?.metadataUrl ?? '',
      entityId: payload?.entityId ?? '',
      ssoUrl: payload?.ssoUrl ?? '',
      sloUrl: payload?.sloUrl ?? '',
      sloCallbackUrl: payload?.sloCallbackUrl ?? configValue(config.Idp, 'SloCallbackUrl'),
      idpX509Certificate: secretSetting(payload?.idpX509Certificate, 'IdpX509Certificate'),
      spEntityId: payload?.spEntityId ?? configValue(config.Idp, 'SpEntityId'),
      acsUrl: payload?.acsUrl ?? configValue(config.Idp, 'AcsUrl'),
      spCertificate: secretSetting(payload?.spCertificate, 'SpCertificate'),
      spPrivateKey: secretSetting(payload?.spPrivateKey, 'SpPrivateKey'),
      nameIdFormat: payload?.nameIdFormat ?? configValue(config.Idp, 'NameIdFormat'),
      authnRequestBinding: payload?.authnRequestBinding ?? configValue(config.Idp, 'AuthnRequestBinding'),
      requireSignedAssertions: payload?.requireSignedAssertions ?? true,
      requireSignedResponses: payload?.requireSignedResponses ?? false,
      requireEncryptedAssertions: payload?.requireEncryptedAssertions ?? false,
      clockSkewSeconds: Number(payload?.clockSkewSeconds ?? configValue(config.Idp, 'ClockSkewSeconds') ?? 120),
      attributeMapping: payload?.attributeMapping ?? config.Idp.AttributeMapping,
      roleMapping: payload?.roleMapping ?? config.Idp.RoleMapping,
      savedAt: new Date().toISOString()
    }
  };

  Object.assign(persisted, safePayload);
  await writePersistedUiSettings(persisted);
  Object.assign(config.Idp, safePayload.idp, { Enabled: safePayload.idp.enabled });
  config.Auth.UseIdp = safePayload.idp.enabled;

  return publicIdpSettings();
}

async function saveRuntimeSettings(payload) {
  const persisted = await readPersistedUiSettings();
  const runtime = normalizeRuntimeSettingsPayload(payload);

  Object.assign(persisted, runtime);
  await writePersistedUiSettings(persisted);
  applyRuntimeSettings(config, runtime);

  return publicRuntimeSettings();
}

function normalizeRuntimeSettingsPayload(payload = {}) {
  const localDefaults = payload.auth?.localLoginDefaults ?? {};
  const cmdbuild = payload.cmdbuild ?? {};
  const zabbix = payload.zabbix ?? {};
  const serviceAccount = {
    cmdbuild: cmdbuild.serviceAccount ?? {},
    zabbix: zabbix.serviceAccount ?? {}
  };

  return {
    auth: {
      localLoginDefaults: {
        enabled: Boolean(localDefaults.enabled),
        cmdbuildBaseUrl: localDefaults.cmdbuildBaseUrl ?? cmdbuild.baseUrl ?? '',
        cmdbuildUsername: localDefaults.cmdbuildUsername ?? '',
        cmdbuildPassword: localDefaults.cmdbuildPassword ?? '',
        zabbixApiEndpoint: localDefaults.zabbixApiEndpoint ?? zabbix.apiEndpoint ?? '',
        zabbixUsername: localDefaults.zabbixUsername ?? '',
        zabbixPassword: localDefaults.zabbixPassword ?? '',
        zabbixApiToken: localDefaults.zabbixApiToken ?? ''
      }
    },
    cmdbuild: {
      baseUrl: cmdbuild.baseUrl ?? '',
      serviceAccount: {
        username: serviceAccount.cmdbuild.username ?? '',
        password: serviceAccount.cmdbuild.password ?? ''
      }
    },
    zabbix: {
      apiEndpoint: zabbix.apiEndpoint ?? '',
      serviceAccount: {
        user: serviceAccount.zabbix.user ?? '',
        password: serviceAccount.zabbix.password ?? '',
        apiToken: serviceAccount.zabbix.apiToken ?? ''
      }
    },
    eventBrowser: {
      enabled: Boolean(payload.eventBrowser?.enabled),
      bootstrapServers: payload.eventBrowser?.bootstrapServers ?? '',
      clientId: payload.eventBrowser?.clientId ?? 'monitoring-ui-api-events',
      securityProtocol: payload.eventBrowser?.securityProtocol ?? 'Plaintext',
      saslMechanism: payload.eventBrowser?.saslMechanism ?? '',
      username: payload.eventBrowser?.username ?? '',
      password: payload.eventBrowser?.password ?? '',
      sslRejectUnauthorized: payload.eventBrowser?.sslRejectUnauthorized !== false,
      maxMessages: clampInt(payload.eventBrowser?.maxMessages, config.EventBrowser?.MaxMessages ?? 50, 1, 500),
      readTimeoutMs: clampInt(payload.eventBrowser?.readTimeoutMs, config.EventBrowser?.ReadTimeoutMs ?? 2500, 500, 30000),
      topics: normalizeEventTopics(payload.eventBrowser?.topics)
    }
  };
}

function applyRuntimeSettings(target, persisted = {}) {
  if (persisted.auth?.localLoginDefaults) {
    const defaults = persisted.auth.localLoginDefaults;
    target.Auth.LocalLoginDefaults = {
      Enabled: Boolean(defaults.enabled),
      CmdbuildBaseUrl: defaults.cmdbuildBaseUrl ?? '',
      CmdbuildUsername: defaults.cmdbuildUsername ?? '',
      CmdbuildPassword: defaults.cmdbuildPassword ?? '',
      ZabbixApiEndpoint: defaults.zabbixApiEndpoint ?? '',
      ZabbixUsername: defaults.zabbixUsername ?? '',
      ZabbixPassword: defaults.zabbixPassword ?? '',
      ZabbixApiToken: defaults.zabbixApiToken ?? ''
    };
  }

  if (persisted.cmdbuild) {
    target.Cmdbuild.BaseUrl = persisted.cmdbuild.baseUrl ?? target.Cmdbuild.BaseUrl;
    target.Cmdbuild.ServiceAccount = {
      ...(target.Cmdbuild.ServiceAccount ?? {}),
      Username: persisted.cmdbuild.serviceAccount?.username ?? target.Cmdbuild.ServiceAccount?.Username ?? '',
      Password: persisted.cmdbuild.serviceAccount?.password ?? target.Cmdbuild.ServiceAccount?.Password ?? ''
    };
  }

  if (persisted.zabbix) {
    target.Zabbix.ApiEndpoint = persisted.zabbix.apiEndpoint ?? target.Zabbix.ApiEndpoint;
    target.Zabbix.ServiceAccount = {
      ...(target.Zabbix.ServiceAccount ?? {}),
      User: persisted.zabbix.serviceAccount?.user ?? target.Zabbix.ServiceAccount?.User ?? '',
      Password: persisted.zabbix.serviceAccount?.password ?? target.Zabbix.ServiceAccount?.Password ?? '',
      ApiToken: persisted.zabbix.serviceAccount?.apiToken ?? target.Zabbix.ServiceAccount?.ApiToken ?? ''
    };
  }

  if (persisted.eventBrowser) {
    const eventBrowser = persisted.eventBrowser;
    target.EventBrowser = {
      ...(target.EventBrowser ?? {}),
      Enabled: Boolean(eventBrowser.enabled),
      BootstrapServers: eventBrowser.bootstrapServers ?? target.EventBrowser?.BootstrapServers ?? '',
      ClientId: eventBrowser.clientId ?? target.EventBrowser?.ClientId ?? '',
      SecurityProtocol: eventBrowser.securityProtocol ?? target.EventBrowser?.SecurityProtocol ?? 'Plaintext',
      SaslMechanism: eventBrowser.saslMechanism ?? target.EventBrowser?.SaslMechanism ?? '',
      Username: eventBrowser.username ?? target.EventBrowser?.Username ?? '',
      Password: eventBrowser.password ?? target.EventBrowser?.Password ?? '',
      SslRejectUnauthorized: eventBrowser.sslRejectUnauthorized !== false,
      MaxMessages: clampInt(eventBrowser.maxMessages, target.EventBrowser?.MaxMessages ?? 50, 1, 500),
      ReadTimeoutMs: clampInt(eventBrowser.readTimeoutMs, target.EventBrowser?.ReadTimeoutMs ?? 2500, 500, 30000),
      Topics: normalizeEventTopics(eventBrowser.topics).map(topic => ({
        Name: topic.name,
        Service: topic.service,
        Direction: topic.direction,
        Description: topic.description
      }))
    };
  }
}

async function readPersistedUiSettings() {
  const settingsPath = resolveUiSettingsFile(config);
  if (!existsSync(settingsPath)) {
    return {};
  }

  return JSON.parse(await readFile(settingsPath, 'utf8'));
}

async function writePersistedUiSettings(settings) {
  const settingsPath = resolveUiSettingsFile(config);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function createSamlSession(profile) {
  const identity = samlIdentityFromProfile(profile);
  const roles = rolesFromSamlGroups(identity.groups);
  const cmdbuildServiceAccount = config.Cmdbuild.ServiceAccount ?? {};
  const zabbixServiceAccount = config.Zabbix.ServiceAccount ?? {};
  const session = {
    id: randomUUID(),
    authMethod: 'saml2',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    roles,
    identity,
    saml: {
      issuer: profile.issuer,
      nameID: profile.nameID,
      nameIDFormat: profile.nameIDFormat,
      sessionIndex: profile.sessionIndex,
      profile
    },
    cmdbuild: {
      baseUrl: config.Cmdbuild.BaseUrl,
      username: cmdbuildServiceAccount.Username ?? cmdbuildServiceAccount.username ?? '',
      password: cmdbuildServiceAccount.Password ?? cmdbuildServiceAccount.password ?? ''
    },
    zabbix: {
      apiEndpoint: config.Zabbix.ApiEndpoint,
      username: zabbixServiceAccount.User ?? zabbixServiceAccount.user ?? '',
      password: zabbixServiceAccount.Password ?? zabbixServiceAccount.password ?? '',
      apiToken: zabbixServiceAccount.ApiToken ?? zabbixServiceAccount.apiToken ?? ''
    }
  };

  return session;
}

function samlIdentityFromProfile(profile) {
  const mapping = config.Idp.AttributeMapping ?? config.Idp.attributeMapping ?? {};
  const login = firstProfileValue(profile, [
    mapping.Login,
    mapping.login,
    'uid',
    'username',
    'nameID'
  ]) ?? profile.nameID;
  const email = firstProfileValue(profile, [
    mapping.Email,
    mapping.email,
    'email',
    'mail',
    'urn:oid:0.9.2342.19200300.100.1.3'
  ]);
  const displayName = firstProfileValue(profile, [
    mapping.DisplayName,
    mapping.displayName,
    'displayName',
    'cn',
    'name'
  ]) ?? login;
  const groups = normalizeStringArray(firstProfileValue(profile, [
    mapping.Groups,
    mapping.groups,
    'groups',
    'memberOf',
    'roles'
  ]));

  return {
    login,
    email: email ?? '',
    displayName,
    groups
  };
}

function rolesFromSamlGroups(groups) {
  const normalizedGroups = new Set(groups.map(group => group.toLowerCase()));
  const roleMapping = config.Idp.RoleMapping ?? config.Idp.roleMapping ?? {};
  const roles = new Set();
  for (const [role, expectedGroups] of Object.entries(roleMapping)) {
    for (const expectedGroup of normalizeStringArray(expectedGroups)) {
      if (normalizedGroups.has(expectedGroup.toLowerCase())) {
        roles.add(role.toLowerCase());
      }
    }
  }

  if (roles.size === 0) {
    roles.add('readonly');
  }

  return [...roles].sort();
}

async function createSamlClient() {
  const settings = await resolveSamlSettings();
  const options = {
    callbackUrl: settings.acsUrl,
    entryPoint: settings.ssoUrl,
    issuer: settings.spEntityId,
    audience: settings.spEntityId,
    idpCert: settings.idpCerts,
    idpIssuer: settings.entityId || undefined,
    identifierFormat: settings.nameIdFormat || null,
    acceptedClockSkewMs: settings.clockSkewSeconds * 1000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: (config.Idp.RequestIdExpirationMinutes ?? 30) * 60 * 1000,
    wantAssertionsSigned: Boolean(settings.requireSignedAssertions),
    wantAuthnResponseSigned: Boolean(config.Idp.RequireSignedResponses ?? config.Idp.requireSignedResponses ?? false),
    signatureAlgorithm: config.Idp.SignatureAlgorithm ?? config.Idp.signatureAlgorithm ?? 'sha256',
    digestAlgorithm: config.Idp.DigestAlgorithm ?? config.Idp.digestAlgorithm ?? 'sha256',
    logoutUrl: settings.sloUrl || settings.ssoUrl,
    logoutCallbackUrl: settings.sloCallbackUrl || undefined,
    disableRequestedAuthnContext: Boolean(config.Idp.DisableRequestedAuthnContext ?? config.Idp.disableRequestedAuthnContext ?? false)
  };

  if (!isBlank(settings.authnRequestBinding)) {
    options.authnRequestBinding = settings.authnRequestBinding;
  }

  if (!isBlank(settings.spPrivateKey)) {
    options.privateKey = settings.spPrivateKey;
  }

  if (!isBlank(settings.spCertificate)) {
    options.publicCert = settings.spCertificate;
  }

  if (settings.requireEncryptedAssertions && !isBlank(settings.spPrivateKey)) {
    options.decryptionPvk = settings.spPrivateKey;
  }

  return new SAML(options);
}

async function buildSamlMetadata() {
  const settings = await resolveSamlSettings({ metadataOnly: true });
  return generateServiceProviderMetadata({
    issuer: settings.spEntityId,
    callbackUrl: settings.acsUrl,
    logoutCallbackUrl: settings.sloCallbackUrl || undefined,
    identifierFormat: settings.nameIdFormat || null,
    wantAssertionsSigned: Boolean(settings.requireSignedAssertions),
    privateKey: settings.spPrivateKey || undefined,
    publicCerts: settings.spCertificate || undefined,
    signatureAlgorithm: config.Idp.SignatureAlgorithm ?? config.Idp.signatureAlgorithm ?? 'sha256',
    digestAlgorithm: config.Idp.DigestAlgorithm ?? config.Idp.digestAlgorithm ?? 'sha256',
    signMetadata: Boolean(config.Idp.SignMetadata ?? config.Idp.signMetadata ?? false)
  });
}

async function resolveSamlSettings(options = {}) {
  const metadataUrl = configValue(config.Idp, 'MetadataUrl');
  const metadata = !isBlank(metadataUrl) ? await readIdpMetadata(metadataUrl) : {};
  const idpCertText = await readConfiguredPem(
    configValue(config.Idp, 'IdpX509Certificate'),
    configValue(config.Idp, 'IdpX509CertificatePath')
  );
  const spCertificate = await readConfiguredPem(
    configValue(config.Idp, 'SpCertificate'),
    configValue(config.Idp, 'SpCertificatePath')
  );
  const spPrivateKey = await readConfiguredPem(
    configValue(config.Idp, 'SpPrivateKey'),
    configValue(config.Idp, 'SpPrivateKeyPath')
  );
  const settings = {
    entityId: configValue(config.Idp, 'EntityId') || metadata.entityId || '',
    ssoUrl: configValue(config.Idp, 'SsoUrl') || metadata.ssoUrl || '',
    sloUrl: configValue(config.Idp, 'SloUrl') || metadata.sloUrl || '',
    spEntityId: configValue(config.Idp, 'SpEntityId') || 'cmdb2monitoring-monitoring-ui',
    acsUrl: configValue(config.Idp, 'AcsUrl') || 'http://localhost:5090/auth/saml2/acs',
    sloCallbackUrl: configValue(config.Idp, 'SloCallbackUrl') || 'http://localhost:5090/auth/saml2/logout',
    nameIdFormat: configValue(config.Idp, 'NameIdFormat') || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    requireSignedAssertions: Boolean(config.Idp.RequireSignedAssertions ?? config.Idp.requireSignedAssertions ?? true),
    requireEncryptedAssertions: Boolean(config.Idp.RequireEncryptedAssertions ?? config.Idp.requireEncryptedAssertions ?? false),
    clockSkewSeconds: Number(config.Idp.ClockSkewSeconds ?? config.Idp.clockSkewSeconds ?? 120),
    authnRequestBinding: configValue(config.Idp, 'AuthnRequestBinding'),
    idpCerts: normalizePemList(idpCertText || metadata.signingCertificates || []),
    spCertificate: normalizePem(spCertificate, 'CERTIFICATE'),
    spPrivateKey: normalizePem(spPrivateKey, 'PRIVATE KEY')
  };

  if (isBlank(settings.spEntityId)) {
    throw httpError(500, 'saml_config_invalid', 'SAML SP entity id is not configured.');
  }

  if (isBlank(settings.acsUrl)) {
    throw httpError(500, 'saml_config_invalid', 'SAML ACS URL is not configured.');
  }

  if (!options.metadataOnly) {
    if (isBlank(settings.ssoUrl)) {
      throw httpError(500, 'saml_config_invalid', 'SAML IdP SSO URL is not configured.');
    }

    if (settings.idpCerts.length === 0) {
      throw httpError(500, 'saml_config_invalid', 'SAML IdP signing certificate is not configured.');
    }
  }

  return settings;
}

async function readIdpMetadata(metadataUrl) {
  const now = Date.now();
  const ttlMs = Number(config.Idp.MetadataCacheTtlSeconds ?? config.Idp.metadataCacheTtlSeconds ?? 300) * 1000;
  if (samlMetadataCache?.url === metadataUrl && now - samlMetadataCache.loadedAt < ttlMs) {
    return samlMetadataCache.value;
  }

  const response = await fetch(metadataUrl, {
    headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw httpError(502, 'saml_metadata_error', `IdP metadata returned HTTP ${response.status}.`);
  }

  const value = await extractIdpMetadata(await response.text());
  samlMetadataCache = {
    url: metadataUrl,
    loadedAt: now,
    value
  };
  return value;
}

async function extractIdpMetadata(xml) {
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true
  });
  const entityDescriptor = findXmlNode(parsed, 'EntityDescriptor');
  const idpDescriptor = findXmlNode(entityDescriptor, 'IDPSSODescriptor');
  const ssoServices = xmlChildren(idpDescriptor, 'SingleSignOnService');
  const sloServices = xmlChildren(idpDescriptor, 'SingleLogoutService');
  const keyDescriptors = xmlChildren(idpDescriptor, 'KeyDescriptor');
  const signingCertificates = [];

  for (const keyDescriptor of keyDescriptors) {
    const use = xmlAttributes(keyDescriptor).use ?? 'signing';
    if (use !== 'signing') {
      continue;
    }

    const certificate = xmlText(findXmlNode(keyDescriptor, 'X509Certificate'));
    if (!isBlank(certificate)) {
      signingCertificates.push(certificate);
    }
  }

  return {
    entityId: xmlAttributes(entityDescriptor).entityID ?? '',
    ssoUrl: preferredSamlBindingLocation(ssoServices),
    sloUrl: preferredSamlBindingLocation(sloServices),
    signingCertificates
  };
}

function publicIdpSettings() {
  return {
    provider: 'SAML2',
    enabled: isIdpEnabled(),
    metadataUrl: configValue(config.Idp, 'MetadataUrl'),
    entityId: configValue(config.Idp, 'EntityId'),
    ssoUrl: configValue(config.Idp, 'SsoUrl'),
    sloUrl: configValue(config.Idp, 'SloUrl'),
    spEntityId: configValue(config.Idp, 'SpEntityId'),
    acsUrl: configValue(config.Idp, 'AcsUrl'),
    sloCallbackUrl: configValue(config.Idp, 'SloCallbackUrl'),
    metadataRoute: '/auth/saml2/metadata',
    loginRoute: '/auth/saml2/login',
    logoutRoute: '/auth/saml2/logout',
    nameIdFormat: configValue(config.Idp, 'NameIdFormat'),
    authnRequestBinding: configValue(config.Idp, 'AuthnRequestBinding'),
    requireSignedAssertions: Boolean(config.Idp.RequireSignedAssertions ?? config.Idp.requireSignedAssertions),
    requireSignedResponses: Boolean(config.Idp.RequireSignedResponses ?? config.Idp.requireSignedResponses ?? false),
    requireEncryptedAssertions: Boolean(config.Idp.RequireEncryptedAssertions ?? config.Idp.requireEncryptedAssertions),
    clockSkewSeconds: Number(config.Idp.ClockSkewSeconds ?? config.Idp.clockSkewSeconds ?? 120),
    attributeMapping: config.Idp.AttributeMapping || config.Idp.attributeMapping || {},
    roleMapping: config.Idp.RoleMapping || config.Idp.roleMapping || {},
    secretsConfigured: {
      idpX509Certificate: !isBlank(configValue(config.Idp, 'IdpX509Certificate') || configValue(config.Idp, 'IdpX509CertificatePath')),
      spCertificate: !isBlank(configValue(config.Idp, 'SpCertificate') || configValue(config.Idp, 'SpCertificatePath')),
      spPrivateKey: !isBlank(configValue(config.Idp, 'SpPrivateKey') || configValue(config.Idp, 'SpPrivateKeyPath'))
    }
  };
}

function publicLocalLoginDefaults() {
  const defaults = config.Auth.LocalLoginDefaults ?? {};
  if (!defaults.Enabled) {
    return {
      enabled: false
    };
  }

  return {
    enabled: true,
    cmdbuild: {
      baseUrl: defaults.CmdbuildBaseUrl ?? '',
      username: defaults.CmdbuildUsername ?? '',
      password: defaults.CmdbuildPassword ?? ''
    },
    zabbix: {
      apiEndpoint: defaults.ZabbixApiEndpoint ?? '',
      username: defaults.ZabbixUsername ?? '',
      password: defaults.ZabbixPassword ?? '',
      apiToken: defaults.ZabbixApiToken ?? ''
    }
  };
}

function publicRuntimeSettings() {
  const cmdbuildServiceAccount = config.Cmdbuild.ServiceAccount ?? {};
  const zabbixServiceAccount = config.Zabbix.ServiceAccount ?? {};
  const localDefaults = config.Auth.LocalLoginDefaults ?? {};
  const eventBrowser = config.EventBrowser ?? {};

  return {
    filePath: config.UiSettings?.FilePath ?? 'state/ui-settings.json',
    auth: {
      localLoginDefaults: {
        enabled: Boolean(localDefaults.Enabled),
        cmdbuildBaseUrl: localDefaults.CmdbuildBaseUrl ?? '',
        cmdbuildUsername: localDefaults.CmdbuildUsername ?? '',
        cmdbuildPassword: localDefaults.CmdbuildPassword ?? '',
        zabbixApiEndpoint: localDefaults.ZabbixApiEndpoint ?? '',
        zabbixUsername: localDefaults.ZabbixUsername ?? '',
        zabbixPassword: localDefaults.ZabbixPassword ?? '',
        zabbixApiToken: localDefaults.ZabbixApiToken ?? ''
      }
    },
    cmdbuild: {
      baseUrl: config.Cmdbuild.BaseUrl ?? '',
      serviceAccount: {
        username: cmdbuildServiceAccount.Username ?? cmdbuildServiceAccount.username ?? '',
        password: cmdbuildServiceAccount.Password ?? cmdbuildServiceAccount.password ?? ''
      }
    },
    zabbix: {
      apiEndpoint: config.Zabbix.ApiEndpoint ?? '',
      serviceAccount: {
        user: zabbixServiceAccount.User ?? zabbixServiceAccount.user ?? '',
        password: zabbixServiceAccount.Password ?? zabbixServiceAccount.password ?? '',
        apiToken: zabbixServiceAccount.ApiToken ?? zabbixServiceAccount.apiToken ?? ''
      }
    },
    eventBrowser: {
      enabled: Boolean(eventBrowser.Enabled),
      bootstrapServers: eventBrowser.BootstrapServers ?? '',
      clientId: eventBrowser.ClientId ?? '',
      securityProtocol: eventBrowser.SecurityProtocol ?? 'Plaintext',
      saslMechanism: eventBrowser.SaslMechanism ?? '',
      username: eventBrowser.Username ?? '',
      password: eventBrowser.Password ?? '',
      sslRejectUnauthorized: eventBrowser.SslRejectUnauthorized !== false,
      maxMessages: eventBrowser.MaxMessages ?? 50,
      readTimeoutMs: eventBrowser.ReadTimeoutMs ?? 2500,
      topics: publicEventTopics()
    }
  };
}

function publicEventTopics() {
  return normalizeEventTopics(config.EventBrowser?.Topics);
}

function normalizeEventTopics(topics) {
  return (Array.isArray(topics) ? topics : [])
    .map(topic => {
      if (typeof topic === 'string') {
        return {
          name: topic,
          service: '',
          direction: '',
          description: ''
        };
      }

      return {
        name: topic?.Name ?? topic?.name ?? '',
        service: topic?.Service ?? topic?.service ?? '',
        direction: topic?.Direction ?? topic?.direction ?? '',
        description: topic?.Description ?? topic?.description ?? ''
      };
    })
    .filter(topic => !isBlank(topic.name));
}

function buildDryRunModel(rules, source, route) {
  const className = source.className || source.entityType || 'unknown';
  const hostInput = source.code || source.id || source.entityId || 'unknown';
  const host = normalizeHostName(rules, className, hostInput, source);
  const fallbackForMethod = route?.requiresZabbixHostId && !source.zabbixHostId ? route.method : null;
  const model = {
    ClassName: className,
    EntityId: source.entityId || source.id,
    Code: source.code,
    IpAddress: source.ipAddress || source.ip_address,
    DnsName: source.dnsName || source.dns_name,
    OperatingSystem: source.os,
    ZabbixTag: source.zabbixTag,
    EventType: source.eventType,
    Host: host,
    VisibleName: `${className} ${source.code || source.id || source.entityId || ''}`.trim(),
    Fields: source
  };
  const hostStatus = selectSingleRuleItem(rules.hostStatusSelectionRules, rules, source, 'hostStatus', 'hostStatusRef')
    ?? rules.defaults?.hostStatus;
  const proxy = selectSingleRuleItem(rules.proxySelectionRules, rules, source, 'proxy', 'proxyRef');
  const proxyGroup = selectSingleRuleItem(rules.proxyGroupSelectionRules, rules, source, 'proxyGroup', 'proxyGroupRef');
  const tlsPsk = selectSingleRuleItem(rules.tlsPskSelectionRules, rules, source, 'tlsPsk', 'tlsPskRef')
    ?? selectSingleRuleItem(rules.tlsPskSelectionRules, rules, source, 'tlsPskMode', 'tlsPskModeRef')
    ?? rules.defaults?.tlsPsk;

  return {
    host,
    visibleName: model.VisibleName,
    method: fallbackForMethod ? route.fallbackMethod : route?.method,
    fallbackForMethod,
    status: hostStatus?.status ?? rules.defaults?.host?.status ?? 0,
    proxy,
    proxyGroup,
    tlsPsk,
    groups: selectLookupItems(rules.groupSelectionRules, rules, source, 'hostGroups', 'hostGroupsRef'),
    templates: selectLookupItems(rules.templateSelectionRules, rules, source, 'templates', 'templatesRef'),
    interface: selectInterface(rules, source),
    tags: selectTags(rules, source),
    macros: selectRenderedItems(rules.hostMacroSelectionRules, rules, source, 'hostMacros', 'hostMacrosRef', rules.defaults?.hostMacros ?? [], model, 'macro'),
    inventory: selectRenderedItems(rules.inventorySelectionRules, rules, source, 'inventoryFields', 'inventoryFieldsRef', rules.defaults?.inventoryFields ?? [], model, 'field'),
    maintenances: selectLookupItems(rules.maintenanceSelectionRules, rules, source, 'maintenances', 'maintenancesRef'),
    valueMaps: selectLookupItems(rules.valueMapSelectionRules, rules, source, 'valueMaps', 'valueMapsRef'),
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

    if (rule[propertyName] && typeof rule[propertyName] === 'object') {
      return [rule[propertyName]];
    }

    if (rule[refName] === `defaults.${propertyName}`) {
      const value = rules.defaults?.[propertyName];
      if (Array.isArray(value)) {
        return value;
      }

      return value && typeof value === 'object' ? [value] : [];
    }

    return [];
  });

  const unique = new Map();
  for (const item of items) {
    unique.set(
      item.groupid
        || item.templateid
        || item.proxyid
        || item.proxy_groupid
        || item.maintenanceid
        || item.valuemapid
        || item.macro
        || item.field
        || item.name,
      item);
  }

  return [...unique.values()];
}

function selectSingleRuleItem(rulesList = [], rules, source, propertyName, refName) {
  return selectLookupItems(rulesList, rules, source, `${propertyName}s`, `${propertyName}sRef`)[0]
    ?? selectLookupItems(rulesList, rules, source, propertyName, refName)[0]
    ?? null;
}

function selectRenderedItems(rulesList = [], rules, source, propertyName, refName, defaults, model, keyName) {
  const selected = selectLookupItems(rulesList, rules, source, propertyName, refName);
  const items = [...defaults, ...selected].map(item => ({
    ...item,
    value: item.value || renderSimple(item.valueTemplate, model)
  }));
  const unique = new Map();
  for (const item of items) {
    const key = item[keyName] || item.name || item.macro;
    if (key) {
      unique.set(key, item);
    }
  }

  return [...unique.values()];
}

function selectInterface(rules, source) {
  const profileRule = (rules.interfaceProfileSelectionRules ?? [])
    .filter(item => !item.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .find(item => matchesCondition(item.when, source))
    ?? (rules.interfaceProfileSelectionRules ?? []).find(item => item.fallback && matchesCondition(item.when, source));
  if (profileRule?.interfaceProfileRef && rules.defaults?.interfaceProfiles?.[profileRule.interfaceProfileRef]) {
    return applyInterfaceAddress(
      rules.defaults.interfaceProfiles[profileRule.interfaceProfileRef],
      selectInterfaceAddress(rules, source),
      source);
  }

  const rule = (rules.interfaceSelectionRules ?? [])
    .filter(item => !item.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .find(item => matchesCondition(item.when, source))
    ?? (rules.interfaceSelectionRules ?? []).find(item => item.fallback && matchesCondition(item.when, source));
  const profile = rule?.interfaceRef === 'snmpInterface'
    ? rules.defaults?.snmpInterface
    : rules.defaults?.agentInterface;
  return applyInterfaceAddress(profile, selectInterfaceAddress(rules, source), source);
}

function selectInterfaceAddress(rules, source) {
  const rulesList = rules.interfaceAddressRules ?? [];
  if (rulesList.length === 0) {
    if (!isBlank(readSourceField(source, 'ipAddress'))) {
      return { mode: 'ip', value: readSourceField(source, 'ipAddress') };
    }

    if (!isBlank(readSourceField(source, 'dnsName'))) {
      return { mode: 'dns', value: readSourceField(source, 'dnsName') };
    }

    return null;
  }

  const rule = rulesList
    .filter(item => !item.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .find(item => matchesCondition(item.when, source))
    ?? rulesList
      .filter(item => item.fallback)
      .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
      .find(item => matchesCondition(item.when, source));
  if (!rule) {
    return null;
  }

  const valueField = rule.valueField || rule.mode;
  const value = readSourceField(source, valueField);
  if (isBlank(value)) {
    return null;
  }

  return {
    mode: rule.mode || (canonicalSourceField(valueField) === 'dnsName' ? 'dns' : 'ip'),
    value
  };
}

function applyInterfaceAddress(profile = {}, address, source) {
  const useDns = equalsIgnoreCase(address?.mode, 'dns');
  return {
    ...profile,
    useip: address ? (useDns ? 0 : 1) : profile.useip,
    ip: useDns ? '' : address?.value ?? readSourceField(source, 'ipAddress') ?? '',
    dns: useDns ? address?.value ?? readSourceField(source, 'dnsName') ?? profile.dns ?? '' : profile.dns ?? ''
  };
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

  let hasConditions = false;
  if (condition.fieldExists) {
    hasConditions = true;
    if (isBlank(readSourceField(source, condition.fieldExists))) {
      return false;
    }
  }

  if (Array.isArray(condition.fieldsExist)
      && condition.fieldsExist.length > 0) {
    hasConditions = true;
    if (!condition.fieldsExist.every(field => !isBlank(readSourceField(source, field)))) {
      return false;
    }
  }

  if (Array.isArray(condition.allRegex) && condition.allRegex.length > 0) {
    hasConditions = true;
    if (!condition.allRegex.every(matcher => matchesRuleRegex(source, matcher))) {
      return false;
    }
  }

  if (Array.isArray(condition.anyRegex) && condition.anyRegex.length > 0) {
    hasConditions = true;
    if (!condition.anyRegex.some(matcher => matchesRuleRegex(source, matcher))) {
      return false;
    }
  }

  return hasConditions;
}

function matchesRuleRegex(source, matcher) {
  const value = readSourceField(source, matcher.field);
  return !isBlank(value) && compileRuleRegex(matcher.pattern).test(value);
}

function normalizeSourcePayload(payload, rules = null) {
  const data = payload.payload ?? payload;
  const normalized = {
    ...data,
    source: data.source ?? payload.source ?? 'cmdbuild',
    eventType: data.eventType ?? payload.eventType ?? 'create',
    entityType: data.entityType ?? payload.entityType ?? data.className,
    entityId: data.id ?? payload.entityId ?? payload.id,
    id: data.id ?? payload.id,
    code: data.code ?? payload.code,
    className: data.className ?? payload.className ?? payload.entityType,
    ip_address: data.ip_address ?? data.ipAddress ?? payload.ip_address ?? payload.ipAddress,
    ipAddress: data.ipAddress ?? data.ip_address ?? payload.ipAddress ?? payload.ip_address,
    dns_name: data.dns_name ?? data.dnsName ?? data.fqdn ?? data.host_dns ?? data.hostname
      ?? payload.dns_name ?? payload.dnsName ?? payload.fqdn ?? payload.host_dns ?? payload.hostname,
    dnsName: data.dnsName ?? data.dns_name ?? data.fqdn ?? data.host_dns ?? data.hostname
      ?? payload.dnsName ?? payload.dns_name ?? payload.fqdn ?? payload.host_dns ?? payload.hostname,
    description: data.description ?? payload.description,
    os: data.os ?? data.OS ?? payload.os ?? payload.OS,
    zabbixTag: data.zabbixTag ?? payload.zabbixTag,
    zabbixHostId: data.zabbix_hostid ?? data.zabbixHostId ?? payload.zabbix_hostid ?? payload.zabbixHostId
  };

  for (const [fieldName, fieldRule] of Object.entries(rules?.source?.fields ?? {})) {
    const value = sourceFieldSources(fieldRule)
      .map(sourceName => readPayloadProperty(data, sourceName) ?? readPayloadProperty(payload, sourceName))
      .find(value => !isBlank(value));
    if (!isBlank(value)) {
      normalized[fieldName] = value;
    }
  }

  normalized.ip_address = normalized.ipAddress ?? normalized.ip_address;
  normalized.ipAddress = normalized.ipAddress ?? normalized.ip_address;
  normalized.dns_name = normalized.dnsName ?? normalized.dns_name;
  normalized.dnsName = normalized.dnsName ?? normalized.dns_name;
  return normalized;
}

function readSourceField(source, field) {
  const canonical = canonicalSourceField(field);
  if (source[canonical] !== undefined) {
    return source[canonical];
  }

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
    ipaddress: source.ipAddress ?? source.ip_address,
    ip_address: source.ipAddress ?? source.ip_address,
    dnsname: source.dnsName ?? source.dns_name,
    dns_name: source.dnsName ?? source.dns_name,
    fqdn: source.dnsName ?? source.dns_name,
    hostname: source.dnsName ?? source.dns_name,
    host_dns: source.dnsName ?? source.dns_name,
    os: source.os,
    operatingsystem: source.os,
    zabbixtag: source.zabbixTag,
    zabbix_tag: source.zabbixTag,
    zabbixhostid: source.zabbixHostId,
    zabbix_hostid: source.zabbixHostId
  }[normalized] ?? source[field] ?? source[normalized];
}

function readPayloadProperty(payload, propertyName) {
  if (!payload || isBlank(propertyName)) {
    return null;
  }

  if (payload[propertyName] !== undefined) {
    return payload[propertyName];
  }

  const wanted = String(propertyName).toLowerCase();
  const key = Object.keys(payload).find(item => item.toLowerCase() === wanted);
  return key ? payload[key] : null;
}

function sourceFieldSources(fieldRule = {}) {
  return [
    fieldRule.source,
    ...(Array.isArray(fieldRule.sources) ? fieldRule.sources : [])
  ].filter(value => !isBlank(value));
}

function canonicalSourceField(field) {
  const normalized = String(field ?? '').replaceAll('_', '').toLowerCase();
  return {
    entityid: 'entityId',
    id: 'entityId',
    classname: 'className',
    class: 'className',
    ipaddress: 'ipAddress',
    dnsname: 'dnsName',
    fqdn: 'dnsName',
    hostname: 'dnsName',
    hostdns: 'dnsName',
    zabbixhostid: 'zabbixHostId',
    os: 'os',
    operatingsystem: 'os',
    zabbixtag: 'zabbixTag',
    eventtype: 'eventType'
  }[normalized] ?? field;
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
  response.end(await readFile(fullPath));
}

async function readJsonBody(request, maxBytes) {
  const text = await readBodyText(request, maxBytes);
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(400, 'invalid_json', error instanceof Error ? error.message : 'Invalid JSON');
  }
}

async function readFormBody(request, maxBytes) {
  const text = await readBodyText(request, maxBytes);
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

async function readBodyText(request, maxBytes) {
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
    return '';
  }

  return Buffer.concat(chunks).toString('utf8');
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
    authMethod: session.authMethod ?? 'local',
    roles: session.roles,
    createdAt: session.createdAt,
    identity: session.identity ? {
      login: session.identity.login,
      email: session.identity.email,
      displayName: session.identity.displayName,
      groups: session.identity.groups
    } : null,
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

  return withCatalogDefaults(JSON.parse(await readFile(fullPath, 'utf8')));
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

function withCatalogDefaults(catalog) {
  if (!catalog || (!catalog.zabbixEndpoint && !catalog.hostGroups && !catalog.templates)) {
    return catalog;
  }

  return {
    ...catalog,
    inventoryFields: catalog.inventoryFields ?? zabbixInventoryFields(),
    interfaceProfiles: catalog.interfaceProfiles ?? zabbixInterfaceProfiles(),
    hostStatuses: catalog.hostStatuses ?? zabbixHostStatuses(),
    tlsPskModes: catalog.tlsPskModes ?? zabbixTlsPskModes()
  };
}

function readCatalogCollection(catalog, name) {
  const mapping = {
    templates: 'templates',
    'host-groups': 'hostGroups',
    'template-groups': 'templateGroups',
    tags: 'tags',
    proxies: 'proxies',
    'proxy-groups': 'proxyGroups',
    'global-macros': 'globalMacros',
    'host-macros': 'hostMacros',
    'inventory-fields': 'inventoryFields',
    'interface-profiles': 'interfaceProfiles',
    'host-statuses': 'hostStatuses',
    maintenances: 'maintenances',
    'tls-psk-modes': 'tlsPskModes',
    'value-maps': 'valueMaps',
    classes: 'classes',
    lookups: 'lookups',
    attributes: 'attributes'
  };
  return {
    items: catalog?.[mapping[name] ?? name] ?? []
  };
}

function readZabbixMappingCatalog(catalog) {
  const collection = name => Array.isArray(catalog?.[name]) ? catalog[name] : [];
  const compactTemplates = collection('templates').map(template => ({
    templateid: template.templateid,
    host: template.host,
    name: template.name,
    groups: template.groups
  }));

  return {
    syncedAt: catalog?.syncedAt ?? null,
    zabbixEndpoint: catalog?.zabbixEndpoint ?? null,
    hostGroups: collection('hostGroups'),
    templateGroups: collection('templateGroups'),
    templates: compactTemplates,
    tags: collection('tags'),
    proxies: [],
    proxyGroups: [],
    globalMacros: [],
    inventoryFields: [],
    interfaceProfiles: [],
    hostStatuses: [],
    maintenances: [],
    tlsPskModes: [],
    hostMacros: [],
    valueMaps: [],
    counts: {
      hostGroups: collection('hostGroups').length,
      templateGroups: collection('templateGroups').length,
      templates: collection('templates').length,
      tags: collection('tags').length,
      proxies: collection('proxies').length,
      proxyGroups: collection('proxyGroups').length,
      globalMacros: collection('globalMacros').length,
      hostMacros: collection('hostMacros').length,
      inventoryFields: collection('inventoryFields').length,
      interfaceProfiles: collection('interfaceProfiles').length,
      hostStatuses: collection('hostStatuses').length,
      maintenances: collection('maintenances').length,
      tlsPskModes: collection('tlsPskModes').length,
      valueMaps: collection('valueMaps').length
    }
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

function zabbixInventoryFields() {
  return [
    'type',
    'type_full',
    'name',
    'alias',
    'os',
    'os_full',
    'os_short',
    'serialno_a',
    'serialno_b',
    'tag',
    'asset_tag',
    'macaddress_a',
    'macaddress_b',
    'hardware',
    'hardware_full',
    'software',
    'software_full',
    'software_app_a',
    'software_app_b',
    'software_app_c',
    'software_app_d',
    'software_app_e',
    'contact',
    'location',
    'location_lat',
    'location_lon',
    'notes',
    'chassis',
    'model',
    'hw_arch',
    'vendor',
    'contract_number',
    'installer_name',
    'deployment_status',
    'url_a',
    'url_b',
    'url_c',
    'host_networks',
    'host_netmask',
    'host_router',
    'oob_ip',
    'oob_netmask',
    'oob_router',
    'date_hw_purchase',
    'date_hw_install',
    'date_hw_expiry',
    'date_hw_decomm',
    'site_address_a',
    'site_address_b',
    'site_address_c',
    'site_city',
    'site_state',
    'site_country',
    'site_zip',
    'site_rack',
    'site_notes',
    'poc_1_name',
    'poc_1_email',
    'poc_1_phone_a',
    'poc_1_phone_b',
    'poc_1_cell',
    'poc_1_screen',
    'poc_1_notes',
    'poc_2_name',
    'poc_2_email',
    'poc_2_phone_a',
    'poc_2_phone_b',
    'poc_2_cell',
    'poc_2_screen',
    'poc_2_notes'
  ].map(name => ({ name }));
}

function zabbixInterfaceProfiles() {
  return [
    { name: 'agent', type: 1, defaultPort: '10050', payload: 'interfaces[]' },
    { name: 'snmp', type: 2, defaultPort: '161', payload: 'interfaces[]' },
    { name: 'ipmi', type: 3, defaultPort: '623', payload: 'interfaces[]' },
    { name: 'jmx', type: 4, defaultPort: '12345', payload: 'interfaces[]' }
  ];
}

function zabbixHostStatuses() {
  return [
    { status: 0, name: 'monitored' },
    { status: 1, name: 'unmonitored' }
  ];
}

function zabbixTlsPskModes() {
  return [
    { name: 'none', tls_connect: 1, tls_accept: 1 },
    { name: 'psk', tls_connect: 2, tls_accept: 2 },
    { name: 'certificate', tls_connect: 4, tls_accept: 4 }
  ];
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
    .replaceAll('<#= Model.Code #>', model.Code ?? '')
    .replaceAll('<#= Model.Host #>', model.Host ?? '')
    .replaceAll('<#= Model.VisibleName #>', model.VisibleName ?? '')
    .replaceAll('<#= Model.IpAddress #>', model.IpAddress ?? '')
    .replaceAll('<#= Model.DnsName #>', model.DnsName ?? '')
    .replaceAll('<#= Model.Interface.Ip #>', model.Interface?.ip ?? model.Interface?.Ip ?? '')
    .replaceAll('<#= Model.Interface.Dns #>', model.Interface?.dns ?? model.Interface?.Dns ?? '')
    .replaceAll('<#= Model.OperatingSystem #>', model.OperatingSystem ?? '')
    .replaceAll('<#= Model.ZabbixTag #>', model.ZabbixTag ?? '')
    .replaceAll('<#= Model.EventType #>', model.EventType ?? '')
    .replace(/<#=\s*Model\.Field\(["']([^"']+)["']\)\s*#>/g, (_, name) => readSourceField(model.Fields ?? {}, name) ?? '');
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

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, {
    location,
    'cache-control': 'no-store',
    ...headers
  });
  response.end();
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

function safeRelayState(value) {
  const fallback = '/';
  if (isBlank(value)) {
    return fallback;
  }

  const text = String(value);
  if (text.startsWith('/') && !text.startsWith('//')) {
    return text;
  }

  return fallback;
}

function assertSamlEnabled() {
  if (!isIdpEnabled()) {
    throw httpError(409, 'idp_disabled', 'SAML2 IdP mode is disabled.');
  }
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

function resolveUiSettingsFile(target) {
  return resolve(serviceRoot, target.UiSettings?.FilePath ?? 'state/ui-settings.json');
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

function isIdpEnabled() {
  return Boolean(config.Auth.UseIdp || config.Idp.Enabled || config.Idp.enabled);
}

function configValue(section, pascalName) {
  const camelName = `${pascalName[0].toLowerCase()}${pascalName.slice(1)}`;
  return !isBlank(section?.[pascalName]) ? section[pascalName] : (section?.[camelName] ?? '');
}

function secretSetting(payloadValue, existingPascalName) {
  return isBlank(payloadValue) ? configValue(config.Idp, existingPascalName) : payloadValue;
}

async function readConfiguredPem(value, path) {
  if (!isBlank(value)) {
    return String(value).replaceAll('\\n', '\n');
  }

  if (isBlank(path)) {
    return '';
  }

  const fullPath = resolveServiceFile(path);
  return (await readFile(fullPath, 'utf8')).replaceAll('\\n', '\n');
}

function normalizePemList(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap(item => normalizeStringArray(item))
    .map(item => normalizePem(item, 'CERTIFICATE'))
    .filter(item => !isBlank(item));
}

function normalizePem(value, label) {
  if (isBlank(value)) {
    return '';
  }

  const text = String(value).replaceAll('\\n', '\n').trim();
  if (text.includes('-----BEGIN ')) {
    return text;
  }

  const compact = text.replace(/\s+/g, '');
  const lines = compact.match(/.{1,64}/g) ?? [compact];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

function firstProfileValue(profile, names) {
  for (const name of names.filter(item => !isBlank(item))) {
    if (name === 'nameID') {
      return profile.nameID;
    }

    const value = profile[name];
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }

    if (!isBlank(value)) {
      return value;
    }
  }

  return null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeStringArray(item));
  }

  if (isBlank(value)) {
    return [];
  }

  return String(value)
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function findXmlNode(node, wantedName) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findXmlNode(item, wantedName);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const [key, value] of Object.entries(node)) {
    if (localXmlName(key) === wantedName) {
      return value;
    }
  }

  for (const value of Object.values(node)) {
    const found = findXmlNode(value, wantedName);
    if (found) {
      return found;
    }
  }

  return null;
}

function xmlChildren(node, wantedName) {
  if (!node || typeof node !== 'object') {
    return [];
  }

  const items = [];
  for (const [key, value] of Object.entries(node)) {
    if (localXmlName(key) === wantedName) {
      items.push(...(Array.isArray(value) ? value : [value]));
    }
  }

  return items;
}

function xmlAttributes(node) {
  return node?.$ ?? {};
}

function xmlText(node) {
  if (typeof node === 'string') {
    return node;
  }

  if (Array.isArray(node)) {
    return xmlText(node[0]);
  }

  return node?._ ?? '';
}

function localXmlName(name) {
  return String(name).includes(':') ? String(name).split(':').pop() : String(name);
}

function preferredSamlBindingLocation(services) {
  const preferred = services.find(service => String(xmlAttributes(service).Binding ?? '').includes('HTTP-Redirect'))
    ?? services.find(service => String(xmlAttributes(service).Binding ?? '').includes('HTTP-POST'))
    ?? services[0];
  return xmlAttributes(preferred).Location ?? '';
}

function equalsIgnoreCase(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

function normalizeToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function sleep(ms) {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms);
  });
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
