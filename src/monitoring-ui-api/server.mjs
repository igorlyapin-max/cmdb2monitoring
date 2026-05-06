import { createServer } from 'node:http';
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kafka, logLevel } from 'kafkajs';
import { Client as LdapClient } from 'ldapts';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { parseStringPromise } from 'xml2js';

const serviceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(serviceRoot, '../..');
const environment = process.env.NODE_ENV || 'Development';
const resolvedSecretReferences = new Map();
const config = await loadConfig();
const sessions = new Map();
const oauthStates = new Map();
let samlMetadataCache = null;

const roles = {
  viewer: {
    key: 'viewer',
    label: 'Просмотр',
    legacy: ['readonly'],
    views: ['dashboard', 'events']
  },
  editor: {
    key: 'editor',
    label: 'Редактирование правил',
    legacy: ['operator'],
    views: ['dashboard', 'events', 'systemAudit', 'rules', 'mapping', 'validateMapping', 'webhooks', 'zabbix', 'zabbixMetadata', 'cmdbuild', 'about', 'help']
  },
  admin: {
    key: 'admin',
    label: 'Администрирование',
    legacy: ['administrator'],
    views: ['dashboard', 'events', 'systemAudit', 'rules', 'mapping', 'validateMapping', 'webhooks', 'zabbix', 'zabbixMetadata', 'cmdbuild', 'authSettings', 'runtimeSettings', 'gitSettings', 'about', 'help']
  }
};

const managedCmdbuildWebhookPrefix = 'cmdbwebhooks2kafka-';
const auditMainHostIdAttributeName = 'zabbix_main_hostid';
const auditBindingClassName = 'ZabbixHostBinding';
const auditBindingAttributes = [
  { name: 'OwnerClass', description: 'CMDBuild owner class', maxLength: 100 },
  { name: 'OwnerCardId', description: 'CMDBuild owner card id', maxLength: 64 },
  { name: 'OwnerCode', description: 'CMDBuild owner code', maxLength: 100 },
  { name: 'HostProfile', description: 'cmdb2monitoring hostProfile name', maxLength: 128 },
  { name: 'ZabbixHostId', description: 'Zabbix hostid', maxLength: 64 },
  { name: 'ZabbixHostName', description: 'Zabbix host technical name', maxLength: 255 },
  { name: 'BindingStatus', description: 'Binding status', maxLength: 32 },
  { name: 'RulesVersion', description: 'Conversion rules version', maxLength: 128 },
  { name: 'LastSyncAt', description: 'Last sync timestamp', maxLength: 64 }
];

const defaultLocalUsers = [
  { username: 'viewer', password: 'viewer', role: 'viewer', displayName: 'Просмотр' },
  { username: 'editor', password: 'editor', role: 'editor', displayName: 'Редактирование правил' },
  { username: 'admin', password: 'admin', role: 'admin', displayName: 'Администрирование' }
];

const passwordHashSettings = {
  algorithm: 'pbkdf2-sha256',
  iterations: 210000,
  keyLength: 32,
  digest: 'sha256'
};

await ensureRuntimeDirectories();
await ensureUsersFile();

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
      message: error instanceof Error ? error.message : 'Unexpected error',
      ...(error?.details ? error.details : {})
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

  if (path.startsWith('/auth/oauth2')) {
    await routeOauth2(request, response, url, path);
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
        provider: idpProvider(),
        roles: publicRoles(),
        usersFilePath: publicUsersFilePath()
      },
      runtime: publicRuntimeCapabilities()
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

  if (request.method === 'POST' && path === '/api/auth/change-password') {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await changeOwnPassword(session, payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/auth/session-credentials') {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await saveSessionCredentials(session, payload));
    return;
  }

  const session = requireSession(request, response);
  if (!session) {
    return;
  }

  if (request.method === 'GET' && path === '/api/users') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readPublicUsers());
    return;
  }

  if (request.method === 'POST' && path === '/api/users/reset-password') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await resetUserPassword(payload));
    return;
  }

  if (request.method === 'GET' && path === '/api/services/health') {
    requireRole(session, response, ['viewer', 'editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readServicesHealth());
    return;
  }

  if (request.method === 'POST' && path.startsWith('/api/services/') && path.endsWith('/reload-rules')) {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const serviceName = decodeURIComponent(path.slice('/api/services/'.length, -'/reload-rules'.length));
    sendJson(response, 200, await reloadServiceRules(serviceName));
    return;
  }

  if (request.method === 'GET' && path === '/api/events') {
    requireRole(session, response, ['viewer', 'editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readKafkaEvents(url));
    return;
  }

  if (request.method === 'GET' && path === '/api/rules/current') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCurrentRules());
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/validate') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await validateRulesPayload(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/dry-run') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await dryRunRules(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/starter') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await createStarterRules());
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/upload') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await uploadRules(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/rules/fix-mapping') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await fixRulesMapping(payload));
    return;
  }

  if (request.method === 'GET' && path === '/api/rules/history') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 410, {
      error: 'rules_history_disabled',
      message: 'Git history is managed outside monitoring-ui-api.'
    });
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/catalog/status') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCatalogStatus(config.Zabbix.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/catalog') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCatalogCache(config.Zabbix.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/catalog/mapping') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const catalog = await readCatalogCache(config.Zabbix.Catalog.CacheFilePath);
    sendJson(response, 200, readZabbixMappingCatalog(catalog));
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/zabbix/catalog/')) {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const catalog = await readCatalogCache(config.Zabbix.Catalog.CacheFilePath);
    sendJson(response, 200, readCatalogCollection(catalog, path.split('/').pop()));
    return;
  }

  if (request.method === 'POST' && path === '/api/zabbix/catalog/sync') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await syncZabbixCatalog(session));
    return;
  }

  if (request.method === 'GET' && path === '/api/zabbix/metadata') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const catalog = await readCatalogCache(config.Zabbix.Catalog.CacheFilePath);
    sendJson(response, 200, readZabbixMetadata(catalog));
    return;
  }

  if (request.method === 'POST' && path === '/api/zabbix/metadata/sync') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const catalog = await syncZabbixCatalog(session);
    sendJson(response, 200, readZabbixMetadata(catalog));
    return;
  }

  if (request.method === 'GET' && path === '/api/cmdbuild/catalog/status') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCatalogStatus(config.Cmdbuild.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path === '/api/cmdbuild/catalog') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCatalogCache(config.Cmdbuild.Catalog.CacheFilePath));
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/cmdbuild/catalog/')) {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const catalog = await readCatalogCache(config.Cmdbuild.Catalog.CacheFilePath);
    sendJson(response, 200, readCatalogCollection(catalog, path.split('/').pop()));
    return;
  }

  if (request.method === 'POST' && path === '/api/cmdbuild/catalog/sync') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await syncCmdbuildCatalog(session));
    return;
  }

  if (request.method === 'GET' && path === '/api/cmdbuild/webhooks') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await readCmdbuildWebhooks(session));
    return;
  }

  if (request.method === 'POST' && path === '/api/cmdbuild/webhooks/apply') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await applyCmdbuildWebhookOperations(session, payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/cmdbuild/audit-model/plan') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await analyzeCmdbuildAuditModel(session, payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/cmdbuild/audit-model/apply') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await applyCmdbuildAuditModel(session, payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/audit/quick') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await runQuickAudit(session, payload));
    return;
  }

  if (request.method === 'GET' && path === '/api/settings/idp') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

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

  if (request.method === 'GET' && path === '/api/settings/runtime-capabilities') {
    requireRole(session, response, ['editor', 'admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, publicRuntimeCapabilities());
    return;
  }

  if (request.method === 'GET' && path === '/api/settings/runtime') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

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

  if (request.method === 'GET' && path === '/api/settings/git') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    sendJson(response, 200, await publicGitSettings());
    return;
  }

  if (request.method === 'PUT' && path === '/api/settings/git') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await saveGitSettings(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/settings/git/check') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await checkGitSettings(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/settings/git/load') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await loadGitRulesCopy(payload));
    return;
  }

  if (request.method === 'POST' && path === '/api/settings/git/export') {
    requireRole(session, response, ['admin']);
    if (response.writableEnded) {
      return;
    }

    const payload = await readJsonBody(request, config.Rules.MaxUploadBytes);
    sendJson(response, 200, await exportGitRulesCopy(payload));
    return;
  }

  sendJson(response, 404, {
    error: 'not_found',
    path
  });
}

async function routeSaml(request, response, url, path) {
  if (request.method === 'GET' && path === '/auth/saml2/metadata') {
    assertIdpProvider('saml2');
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
    assertIdpProvider('saml2');
    const saml = await createSamlClient();
    const relayState = safeRelayState(url.searchParams.get('returnUrl') ?? '/');
    const redirectUrl = await saml.getAuthorizeUrlAsync(relayState, request.headers.host, {});
    sendRedirect(response, redirectUrl);
    return;
  }

  if (request.method === 'POST' && path === '/auth/saml2/acs') {
    assertSamlEnabled();
    assertIdpProvider('saml2');
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

    const session = await createSamlSession(validation.profile);
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

async function routeOauth2(request, response, url, path) {
  if (request.method === 'GET' && path === '/auth/oauth2/login') {
    assertOauth2Enabled();
    const settings = resolveOauth2Settings();
    const state = randomBytes(24).toString('hex');
    oauthStates.set(state, {
      returnUrl: safeRelayState(url.searchParams.get('returnUrl') ?? '/'),
      createdAt: Date.now()
    });

    pruneOauthStates();
    const redirectUrl = new URL(settings.authorizationUrl);
    redirectUrl.searchParams.set('response_type', 'code');
    redirectUrl.searchParams.set('client_id', settings.clientId);
    redirectUrl.searchParams.set('redirect_uri', settings.redirectUri);
    redirectUrl.searchParams.set('scope', settings.scopes);
    redirectUrl.searchParams.set('state', state);
    sendRedirect(response, redirectUrl.toString());
    return;
  }

  if (request.method === 'GET' && path === '/auth/oauth2/callback') {
    assertOauth2Enabled();
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const error = url.searchParams.get('error') ?? '';
    const stateRecord = oauthStates.get(state);
    oauthStates.delete(state);

    if (!isBlank(error)) {
      throw httpError(401, 'oauth2_error', url.searchParams.get('error_description') || error);
    }

    if (!stateRecord || isBlank(code)) {
      throw httpError(401, 'oauth2_state_invalid', 'OAuth2 state or code is invalid.');
    }

    const tokenSet = await exchangeOauth2Code(code);
    const claims = await readOauth2UserInfo(tokenSet);
    const session = await createOauth2Session(claims, tokenSet);
    sessions.set(session.id, session);
    sendRedirect(response, stateRecord.returnUrl, {
      'Set-Cookie': buildSessionCookie(session.id)
    });
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
  applyPamCompatibilityEnvironment(merged);
  applySecretCompanionReferences(merged);
  await resolveSecretReferences(merged, 'monitoring-ui-api');
  return merged;
}

async function resolveSecretReferences(target, serviceName) {
  const references = [];
  collectSecretReferences(target, [], references);
  if (references.length === 0) {
    return;
  }

  const provider = String(target.Secrets?.Provider ?? target.Secrets?.provider ?? 'None');
  if (provider.toLowerCase() !== 'indeedpamaapm') {
    throw new Error(`Configuration contains secret:// references, but Secrets.Provider is '${provider}'.`);
  }

  for (const reference of references) {
    const secret = await readIndeedPamAapmSecret(target, serviceName, reference.secretId);
    setPath(target, reference.path, secret);
    resolvedSecretReferences.set(reference.path.join('.'), reference.originalValue);
  }
}

function collectSecretReferences(value, path, references) {
  if (path[0] === 'Secrets') {
    return;
  }

  if (typeof value === 'string') {
    const secretId = readSecretReferenceId(value);
    if (secretId) {
      references.push({ path, secretId, originalValue: value.trim() });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSecretReferences(item, [...path, index], references));
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      collectSecretReferences(nested, [...path, key], references);
    }
  }
}

function readSecretReferenceId(value) {
  const trimmed = String(value ?? '').trim();
  for (const prefix of ['secret://', 'aapm://']) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      const secretId = trimmed.slice(prefix.length).trim();
      return secretId || null;
    }
  }

  return null;
}

async function readIndeedPamAapmSecret(target, serviceName, secretId) {
  const aapm = target.Secrets?.IndeedPamAapm ?? target.Secrets?.indeedPamAapm ?? {};
  const references = target.Secrets?.References ?? target.Secrets?.references ?? {};
  const reference = references[secretId] ?? references[String(secretId).toLowerCase()] ?? null;
  const parsed = parseAapmSecretId(secretId);

  const baseUrl = requiredSecretSetting(aapm.BaseUrl ?? aapm.baseUrl, 'Secrets.IndeedPamAapm.BaseUrl');
  const endpointPath = aapm.PasswordEndpointPath ?? aapm.passwordEndpointPath ?? '/sc_aapm_ui/rest/aapm/password';
  const applicationCredentials = await readAapmApplicationCredentials(aapm);
  const accountPath = requiredSecretSetting(
    firstNonBlank(reference?.AccountPath, reference?.accountPath, parsed.accountPath, aapm.DefaultAccountPath, aapm.defaultAccountPath),
    `Secrets.References.${secretId}.AccountPath`);
  const accountName = requiredSecretSetting(
    firstNonBlank(reference?.AccountName, reference?.accountName, parsed.accountName),
    `Secrets.References.${secretId}.AccountName`);
  const responseType = reference?.ResponseType ?? reference?.responseType ?? aapm.ResponseType ?? aapm.responseType ?? 'json';
  const valueJsonPath = reference?.ValueJsonPath ?? reference?.valueJsonPath ?? aapm.ValueJsonPath ?? aapm.valueJsonPath ?? 'password';
  const timeoutMs = clampInt(aapm.TimeoutMs ?? aapm.timeoutMs, 10000, 1000, 120000);
  const url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/${String(endpointPath).replace(/^\/+/, '')}`);

  for (const [key, value] of Object.entries({
    token: applicationCredentials.token,
    sapmaccountpath: accountPath,
    sapmaccountname: accountName,
    responsetype: responseType,
    passwordexpirationinminute: reference?.PasswordExpirationInMinute ?? reference?.passwordExpirationInMinute ?? aapm.PasswordExpirationInMinute ?? aapm.passwordExpirationInMinute,
    passwordchangerequired: boolQueryValue(reference?.PasswordChangeRequired ?? reference?.passwordChangeRequired ?? aapm.PasswordChangeRequired ?? aapm.passwordChangeRequired),
    comment: formatSecretComment(
      reference?.Comment ?? reference?.comment ?? aapm.Comment ?? aapm.comment ?? `cmdb2monitoring ${serviceName} ${secretId}`,
      serviceName,
      secretId),
    tenantid: reference?.TenantId ?? reference?.tenantId ?? aapm.TenantId ?? aapm.tenantId,
    pin: reference?.Pin ?? reference?.pin ?? aapm.Pin ?? aapm.pin
  })) {
    if (!isBlank(value)) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {};
  if (!isBlank(applicationCredentials.username) && !isBlank(applicationCredentials.password)) {
    headers.Authorization = `Basic ${Buffer.from(`${applicationCredentials.username}:${applicationCredentials.password}`).toString('base64')}`;

    if (aapm.SendApplicationCredentialsInQuery === true || aapm.sendApplicationCredentialsInQuery === true) {
      url.searchParams.set('username', applicationCredentials.username);
      url.searchParams.set('password', applicationCredentials.password);
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Indeed PAM AAPM secret '${secretId}' request failed with HTTP ${response.status}.`);
  }

  const secret = extractAapmSecretValue(body, responseType, valueJsonPath);
  if (isBlank(secret)) {
    throw new Error(`Indeed PAM AAPM secret '${secretId}' returned an empty value.`);
  }

  return secret;
}

async function readAapmApplicationCredentials(aapm) {
  const token = aapm.ApplicationToken ?? aapm.applicationToken;
  if (!isBlank(token)) {
    return { token: String(token).trim(), username: '', password: '' };
  }

  const tokenFile = aapm.ApplicationTokenFile ?? aapm.applicationTokenFile;
  if (!isBlank(tokenFile)) {
    const fullPath = isAbsolute(String(tokenFile)) ? String(tokenFile) : resolve(serviceRoot, String(tokenFile));
    return { token: (await readFile(fullPath, 'utf8')).trim(), username: '', password: '' };
  }

  const username = aapm.ApplicationUsername ?? aapm.applicationUsername;
  const password = aapm.ApplicationPassword ?? aapm.applicationPassword;
  if (!isBlank(username) && !isBlank(password)) {
    return { token: '', username: String(username).trim(), password: String(password).trim() };
  }

  throw new Error('Indeed PAM AAPM credentials are not configured. Set Secrets.IndeedPamAapm.ApplicationToken, ApplicationTokenFile, or ApplicationUsername/ApplicationPassword.');
}

function parseAapmSecretId(secretId) {
  const value = String(secretId ?? '').trim();
  for (const separator of ['.', '/']) {
    const index = value.lastIndexOf(separator);
    if (index > 0 && index < value.length - 1) {
      return {
        accountPath: value.slice(0, index),
        accountName: value.slice(index + 1)
      };
    }
  }

  return { accountPath: '', accountName: '' };
}

function requiredSecretSetting(value, path) {
  if (isBlank(value)) {
    throw new Error(`Required Indeed PAM AAPM configuration value is missing: ${path}.`);
  }

  return String(value).trim();
}

function boolQueryValue(value) {
  return typeof value === 'boolean' ? String(value) : value;
}

function formatSecretComment(comment, serviceName, secretId) {
  return String(comment)
    .replaceAll('{service}', serviceName)
    .replaceAll('{secretId}', secretId);
}

function extractAapmSecretValue(body, responseType, valueJsonPath) {
  if (String(responseType).toLowerCase() !== 'json') {
    return body.trim();
  }

  const parsed = JSON.parse(body);
  if (typeof parsed === 'string') {
    return parsed;
  }

  for (const path of [valueJsonPath, 'password', 'value', 'secret', 'Password']) {
    const value = readJsonPath(parsed, path);
    if (!isBlank(value)) {
      return String(value);
    }
  }

  return '';
}

function readJsonPath(value, path) {
  let current = value;
  for (const part of String(path ?? '').split(/[.:]/).filter(Boolean)) {
    current = current?.[part];
  }

  return ['string', 'number', 'boolean'].includes(typeof current) ? current : '';
}

async function applyPersistedUiSettings(target) {
  const settingsPath = resolveUiSettingsFile(target);
  if (!existsSync(settingsPath)) {
    return;
  }

  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (persisted.idp) {
    applyIdpSettings(target, persisted.idp);
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
    IDP_PROVIDER: ['Idp', 'Provider'],
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
    OAUTH2_AUTHORIZATION_URL: ['Idp', 'OAuth2', 'AuthorizationUrl'],
    OAUTH2_TOKEN_URL: ['Idp', 'OAuth2', 'TokenUrl'],
    OAUTH2_USERINFO_URL: ['Idp', 'OAuth2', 'UserInfoUrl'],
    OAUTH2_CLIENT_ID: ['Idp', 'OAuth2', 'ClientId'],
    OAUTH2_CLIENT_SECRET: ['Idp', 'OAuth2', 'ClientSecret'],
    OAUTH2_REDIRECT_URI: ['Idp', 'OAuth2', 'RedirectUri'],
    OAUTH2_SCOPES: ['Idp', 'OAuth2', 'Scopes'],
    OAUTH2_LOGIN_CLAIM: ['Idp', 'OAuth2', 'LoginClaim'],
    OAUTH2_EMAIL_CLAIM: ['Idp', 'OAuth2', 'EmailClaim'],
    OAUTH2_DISPLAY_NAME_CLAIM: ['Idp', 'OAuth2', 'DisplayNameClaim'],
    OAUTH2_GROUPS_CLAIM: ['Idp', 'OAuth2', 'GroupsClaim'],
    LDAP_PROTOCOL: ['Idp', 'Ldap', 'Protocol'],
    LDAP_HOST: ['Idp', 'Ldap', 'Host'],
    LDAP_PORT: ['Idp', 'Ldap', 'Port'],
    LDAP_BASE_DN: ['Idp', 'Ldap', 'BaseDn'],
    LDAP_BIND_DN: ['Idp', 'Ldap', 'BindDn'],
    LDAP_BIND_PASSWORD: ['Idp', 'Ldap', 'BindPassword'],
    LDAP_USER_DN_TEMPLATE: ['Idp', 'Ldap', 'UserDnTemplate'],
    LDAP_USER_SEARCH_BASE: ['Idp', 'Ldap', 'UserSearchBase'],
    LDAP_USER_FILTER: ['Idp', 'Ldap', 'UserFilter'],
    LDAP_GROUP_SEARCH_BASE: ['Idp', 'Ldap', 'GroupSearchBase'],
    LDAP_GROUP_FILTER: ['Idp', 'Ldap', 'GroupFilter'],
    LDAP_GROUP_NAME_ATTRIBUTE: ['Idp', 'Ldap', 'GroupNameAttribute'],
    LDAP_LOGIN_ATTRIBUTE: ['Idp', 'Ldap', 'LoginAttribute'],
    LDAP_EMAIL_ATTRIBUTE: ['Idp', 'Ldap', 'EmailAttribute'],
    LDAP_DISPLAY_NAME_ATTRIBUTE: ['Idp', 'Ldap', 'DisplayNameAttribute'],
    LDAP_GROUPS_ATTRIBUTE: ['Idp', 'Ldap', 'GroupsAttribute'],
    LDAP_TLS_REJECT_UNAUTHORIZED: ['Idp', 'Ldap', 'TlsRejectUnauthorized'],
    CMDBUILD_BASE_URL: ['Cmdbuild', 'BaseUrl'],
    ZABBIX_API_ENDPOINT: ['Zabbix', 'ApiEndpoint'],
    ZABBIX_API_TOKEN: ['Zabbix', 'ApiToken'],
    RULES_READ_FROM_GIT: ['Rules', 'ReadFromGit'],
    RULES_REPOSITORY_URL: ['Rules', 'RepositoryUrl'],
    RULES_REPOSITORY_PATH: ['Rules', 'RepositoryPath'],
    RULES_FILE_PATH: ['Rules', 'RulesFilePath'],
    AUDIT_STORAGE_PROVIDER: ['AuditStorage', 'Provider'],
    AUDIT_STORAGE_CONNECTION_STRING: ['AuditStorage', 'ConnectionString'],
    AUDIT_STORAGE_SCHEMA: ['AuditStorage', 'Schema'],
    AUDIT_STORAGE_AUTO_MIGRATE: ['AuditStorage', 'AutoMigrate'],
    AUDIT_STORAGE_COMMAND_TIMEOUT_SECONDS: ['AuditStorage', 'CommandTimeoutSeconds'],
    MONITORING_UI_SETTINGS_FILE: ['UiSettings', 'FilePath'],
    MONITORING_UI_USERS_FILE: ['Auth', 'UsersFilePath'],
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

function applyPamCompatibilityEnvironment(target) {
  target.Secrets ??= {};
  target.Secrets.IndeedPamAapm ??= {};

  setIfBlank(target, ['Secrets', 'IndeedPamAapm', 'BaseUrl'], process.env.PAMURL);
  setIfBlank(target, ['Secrets', 'IndeedPamAapm', 'ApplicationUsername'], process.env.PAMUSERNAME);
  setIfBlank(target, ['Secrets', 'IndeedPamAapm', 'ApplicationPassword'], process.env.PAMPASSWORD);
  setIfBlank(target, ['Secrets', 'IndeedPamAapm', 'ApplicationToken'], process.env.PAMTOKEN);
  setIfBlank(target, ['Secrets', 'IndeedPamAapm', 'DefaultAccountPath'], process.env.PAMDEFAULTACCOUNTPATH);

  const hasPamCompatibility =
    !isBlank(process.env.PAMURL)
    || !isBlank(process.env.PAMTOKEN)
    || (!isBlank(process.env.PAMUSERNAME) && !isBlank(process.env.PAMPASSWORD));
  if (hasPamCompatibility && String(target.Secrets.Provider ?? 'None').toLowerCase() === 'none') {
    target.Secrets.Provider = 'IndeedPamAapm';
  }

  applyCommonSaslCompatibility(target);
}

function applyCommonSaslCompatibility(target) {
  const username = process.env.SASLUSERNAME;
  const password = process.env.SASLPASSWORD;
  const passwordSecret = process.env.SASLPASSWORDSECRET;
  const sectionPaths = [
    ['Kafka'],
    ['Kafka', 'Input'],
    ['Kafka', 'Output'],
    ['Kafka', 'BindingOutput'],
    ['ElkLogging', 'Kafka'],
    ['EventBrowser']
  ];

  for (const sectionPath of sectionPaths) {
    const section = readPath(target, sectionPath);
    if (!isPlainObject(section)) {
      continue;
    }

    if (!isBlank(username) && isBlank(section.Username)) {
      section.Username = username;
    }

    if (!isBlank(section.Password)) {
      continue;
    }

    if (!isBlank(password)) {
      section.Password = password;
    } else if (!isBlank(passwordSecret)) {
      section.Password = ensureSecretReference(passwordSecret);
    }
  }
}

function applySecretCompanionReferences(target) {
  applySecretCompanionReferencesInner(target, []);
}

function applySecretCompanionReferencesInner(value, path) {
  if (path[0] === 'Secrets') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => applySecretCompanionReferencesInner(item, [...path, index]));
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string'
      && key.endsWith('Secret')
      && key.length > 'Secret'.length) {
      const targetKey = key.slice(0, -'Secret'.length);
      if (Object.prototype.hasOwnProperty.call(value, targetKey) && isBlank(value[targetKey])) {
        value[targetKey] = ensureSecretReference(nested);
      }
    }

    applySecretCompanionReferencesInner(nested, [...path, key]);
  }
}

function ensureSecretReference(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.toLowerCase().startsWith('secret://') || trimmed.toLowerCase().startsWith('aapm://')
    ? trimmed
    : `secret://${trimmed}`;
}

function setIfBlank(target, path, value) {
  if (!isBlank(value) && isBlank(readPath(target, path))) {
    setPath(target, path, String(value));
  }
}

function readPath(target, path) {
  let current = target;
  for (const part of path) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

async function ensureRuntimeDirectories() {
  for (const configuredPath of [
    config.Cmdbuild.Catalog.CacheFilePath,
    config.Zabbix.Catalog.CacheFilePath,
    config.UiSettings?.FilePath ?? 'state/ui-settings.json',
    config.Auth?.UsersFilePath ?? join(dirname(config.UiSettings?.FilePath ?? 'state/ui-settings.json'), 'users.json')
  ]) {
    await mkdir(resolveServicePath(configuredPath, true), { recursive: true });
  }
}

async function login(payload) {
  if (isIdpEnabled()) {
    if (idpProvider() === 'ldap') {
      const session = await loginWithLdap(payload);
      sessions.set(session.id, session);
      return session;
    }

    throw httpError(409, 'idp_enabled', `Use ${idpLoginRoute()} when IdP mode is enabled.`);
  }

  const username = String(payload?.username ?? '').trim();
  const password = String(payload?.password ?? '');
  if (isBlank(username) || isBlank(password)) {
    throw httpError(400, 'missing_local_credentials', 'Local username and password are required.');
  }

  const store = await readUsersStore();
  const user = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.password)) {
    throw httpError(401, 'invalid_local_credentials', 'Invalid username or password.');
  }

  const role = normalizeRoleKey(user.role);

  const session = {
    id: randomUUID(),
    authMethod: 'local',
    localUsername: user.username,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    roles: [role],
    passwordChangeRequired: Boolean(user.mustChangePassword),
    identity: {
      login: user.username,
      email: user.email ?? '',
      displayName: user.displayName || user.username,
      groups: []
    },
    cmdbuild: buildLocalCmdbuildSessionCredentials(),
    zabbix: buildLocalZabbixSessionCredentials()
  };

  sessions.set(session.id, session);
  return session;
}

async function ensureUsersFile() {
  const usersPath = resolveUsersFile(config);
  await mkdir(dirname(usersPath), { recursive: true });

  if (!existsSync(usersPath)) {
    const now = new Date().toISOString();
    const store = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      users: defaultLocalUsers.map(user => ({
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        password: hashPassword(user.password),
        mustChangePassword: false,
        createdAt: now,
        updatedAt: now
      }))
    };
    await writeUsersStore(store);
    return;
  }

  const store = await readUsersStore();
  let changed = false;
  for (const defaultUser of defaultLocalUsers) {
    if (store.users.some(user => user.username.toLowerCase() === defaultUser.username)) {
      continue;
    }

    const now = new Date().toISOString();
    store.users.push({
      username: defaultUser.username,
      displayName: defaultUser.displayName,
      role: defaultUser.role,
      password: hashPassword(defaultUser.password),
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now
    });
    changed = true;
  }

  if (changed) {
    store.updatedAt = new Date().toISOString();
    await writeUsersStore(store);
  }
}

async function readUsersStore() {
  const usersPath = resolveUsersFile(config);
  if (!existsSync(usersPath)) {
    await ensureUsersFile();
  }

  const store = JSON.parse(await readFile(usersPath, 'utf8'));
  return {
    version: Number(store.version ?? 1),
    createdAt: store.createdAt ?? '',
    updatedAt: store.updatedAt ?? '',
    users: Array.isArray(store.users) ? store.users.map(normalizeStoredUser) : []
  };
}

async function writeUsersStore(store) {
  const usersPath = resolveUsersFile(config);
  await mkdir(dirname(usersPath), { recursive: true });
  await writeFile(usersPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function normalizeStoredUser(user) {
  return {
    username: String(user.username ?? '').trim(),
    displayName: user.displayName ?? user.username ?? '',
    email: user.email ?? '',
    role: normalizeRoleKey(user.role),
    password: normalizePasswordHash(user.password),
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt ?? '',
    updatedAt: user.updatedAt ?? ''
  };
}

function normalizePasswordHash(password) {
  if (password?.algorithm === passwordHashSettings.algorithm && password.hash && password.salt) {
    return {
      algorithm: passwordHashSettings.algorithm,
      iterations: Number(password.iterations ?? passwordHashSettings.iterations),
      keyLength: Number(password.keyLength ?? passwordHashSettings.keyLength),
      digest: password.digest ?? passwordHashSettings.digest,
      salt: String(password.salt),
      hash: String(password.hash)
    };
  }

  return {
    ...passwordHashSettings,
    salt: '',
    hash: ''
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(
    String(password),
    salt,
    passwordHashSettings.iterations,
    passwordHashSettings.keyLength,
    passwordHashSettings.digest
  ).toString('hex');

  return {
    ...passwordHashSettings,
    salt,
    hash
  };
}

function verifyPassword(password, hashSettings) {
  const settings = normalizePasswordHash(hashSettings);
  if (isBlank(settings.salt) || isBlank(settings.hash)) {
    return false;
  }

  const calculated = pbkdf2Sync(
    String(password),
    settings.salt,
    settings.iterations,
    settings.keyLength,
    settings.digest
  );
  const expected = Buffer.from(settings.hash, 'hex');
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
}

async function changeOwnPassword(session, payload) {
  if (session.authMethod !== 'local' || isBlank(session.localUsername)) {
    throw httpError(400, 'password_change_not_supported', 'Password change is supported only for local users.');
  }

  const currentPassword = String(payload?.currentPassword ?? '');
  const newPassword = String(payload?.newPassword ?? '');
  assertNewPassword(newPassword);

  const store = await readUsersStore();
  const user = store.users.find(item => item.username.toLowerCase() === session.localUsername.toLowerCase());
  if (!user || !verifyPassword(currentPassword, user.password)) {
    throw httpError(401, 'invalid_current_password', 'Current password is invalid.');
  }

  user.password = hashPassword(newPassword);
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  store.updatedAt = user.updatedAt;
  await writeUsersStore(store);

  session.passwordChangeRequired = false;
  return {
    success: true,
    user: publicUser(session)
  };
}

async function readPublicUsers() {
  const store = await readUsersStore();
  return {
    usersFilePath: publicUsersFilePath(),
    roles: publicRoles(),
    users: store.users
      .filter(user => !isBlank(user.username))
      .map(publicStoredUser)
      .sort((left, right) => left.username.localeCompare(right.username))
  };
}

async function resetUserPassword(payload) {
  const username = String(payload?.username ?? '').trim();
  const newPassword = String(payload?.newPassword ?? '');
  assertNewPassword(newPassword);

  const store = await readUsersStore();
  const user = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    throw httpError(404, 'user_not_found', `User "${username}" was not found.`);
  }

  user.password = hashPassword(newPassword);
  user.mustChangePassword = payload?.mustChangePassword !== false;
  user.updatedAt = new Date().toISOString();
  store.updatedAt = user.updatedAt;
  await writeUsersStore(store);

  for (const activeSession of sessions.values()) {
    if (activeSession.localUsername?.toLowerCase() === username.toLowerCase()) {
      activeSession.passwordChangeRequired = Boolean(user.mustChangePassword);
    }
  }

  return await readPublicUsers();
}

async function saveSessionCredentials(session, payload) {
  const service = String(payload?.service ?? '').toLowerCase();
  if (!['cmdbuild', 'zabbix'].includes(service)) {
    throw httpError(400, 'invalid_service', 'Credential service must be cmdbuild or zabbix.');
  }

  const username = String(payload?.username ?? '').trim();
  const password = String(payload?.password ?? '');
  if (isBlank(username) || isBlank(password)) {
    throw httpError(400, 'missing_integration_credentials', 'Integration username and password are required.');
  }

  if (service === 'cmdbuild') {
    session.cmdbuild = {
      baseUrl: String(payload?.baseUrl || session.cmdbuild?.baseUrl || config.Cmdbuild.BaseUrl || '').trim(),
      username,
      password
    };
  } else {
    session.zabbix = {
      apiEndpoint: String(payload?.apiEndpoint || session.zabbix?.apiEndpoint || config.Zabbix.ApiEndpoint || '').trim(),
      username,
      password,
      apiToken: session.zabbix?.apiToken ?? ''
    };
  }

  return {
    success: true,
    user: publicUser(session)
  };
}

function assertNewPassword(password) {
  if (isBlank(password) || String(password).length < 5) {
    throw httpError(400, 'weak_password', 'Password must contain at least 5 characters.');
  }
}

async function readServicesHealth() {
  const items = [];
  const managementRulesPromise = readManagementRulesStatus();
  await Promise.all((config.Services.HealthEndpoints ?? []).map(async endpoint => {
    const startedAt = Date.now();
    const rulesStatusSupported = !isBlank(endpoint.RulesStatusUrl ?? endpoint.rulesStatusUrl);
    const rulesStatusPromise = rulesStatusSupported
      ? readServiceRulesStatus(endpoint)
      : Promise.resolve(null);
    try {
      const result = await fetch(endpoint.Url, { signal: AbortSignal.timeout(2000) });
      items.push({
        name: endpoint.Name,
        url: endpoint.Url,
        ok: result.ok,
        statusCode: result.status,
        latencyMs: Date.now() - startedAt,
        rulesReloadSupported: !isBlank(endpoint.RulesReloadUrl ?? endpoint.rulesReloadUrl),
        rulesStatusSupported,
        rulesStatus: await rulesStatusPromise,
        body: await safeJson(result)
      });
    } catch (error) {
      items.push({
        name: endpoint.Name,
        url: endpoint.Url,
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        rulesReloadSupported: !isBlank(endpoint.RulesReloadUrl ?? endpoint.rulesReloadUrl),
        rulesStatusSupported,
        rulesStatus: await rulesStatusPromise,
        error: error instanceof Error ? error.message : 'request_failed'
      });
    }
  }));

  items.sort((left, right) => left.name.localeCompare(right.name));
  return {
    items,
    managementRules: await managementRulesPromise
  };
}

async function readServiceRulesStatus(endpoint) {
  const statusUrl = endpoint.RulesStatusUrl ?? endpoint.rulesStatusUrl ?? '';
  if (isBlank(statusUrl)) {
    return null;
  }

  const token = endpoint.RulesStatusToken
    ?? endpoint.rulesStatusToken
    ?? endpoint.RulesReloadToken
    ?? endpoint.rulesReloadToken
    ?? '';
  const startedAt = Date.now();
  try {
    const result = await fetch(statusUrl, {
      headers: {
        accept: 'application/json',
        ...(isBlank(token) ? {} : { authorization: `Bearer ${token}` })
      },
      signal: AbortSignal.timeout(3000)
    });
    const payload = await safeJson(result);
    return {
      url: statusUrl,
      ok: result.ok,
      statusCode: result.status,
      latencyMs: Date.now() - startedAt,
      rules: payload?.rules ?? null,
      body: payload,
      error: result.ok ? null : (payload?.detail || payload?.title || payload?.message || `Rules status returned HTTP ${result.status}.`)
    };
  } catch (error) {
    return {
      url: statusUrl,
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      rules: null,
      error: error instanceof Error ? error.message : 'request_failed'
    };
  }
}

async function readManagementRulesStatus() {
  try {
    const rules = await readCurrentRules();
    return {
      ok: true,
      source: rules.source,
      path: rules.path,
      resolvedPath: rules.resolvedPath,
      name: rules.name,
      schemaVersion: rules.schemaVersion,
      rulesVersion: rules.rulesVersion,
      valid: Boolean(rules.validation?.valid)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'rules_read_failed'
    };
  }
}

async function reloadServiceRules(serviceName) {
  const endpoint = (config.Services.HealthEndpoints ?? [])
    .find(item => String(item.Name ?? item.name ?? '').toLowerCase() === String(serviceName ?? '').toLowerCase());
  if (!endpoint) {
    throw httpError(404, 'service_not_found', `Service '${serviceName}' is not configured.`);
  }

  const reloadUrl = endpoint.RulesReloadUrl ?? endpoint.rulesReloadUrl ?? '';
  if (isBlank(reloadUrl)) {
    throw httpError(404, 'rules_reload_not_supported', `Service '${serviceName}' does not support rules reload.`);
  }

  const token = endpoint.RulesReloadToken ?? endpoint.rulesReloadToken ?? '';
  const startedAt = Date.now();
  const response = await fetch(reloadUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(isBlank(token) ? {} : { authorization: `Bearer ${token}` })
    },
    signal: AbortSignal.timeout(10000)
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    throw httpError(502, 'rules_reload_failed', payload?.detail || payload?.title || payload?.message || `Rules reload returned HTTP ${response.status}.`, {
      service: endpoint.Name,
      statusCode: response.status,
      body: payload
    });
  }

  return {
    service: endpoint.Name,
    ok: true,
    statusCode: response.status,
    latencyMs: Date.now() - startedAt,
    response: payload
  };
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
  const settings = publicRulesSettings();
  const path = resolveRulesStoragePath(settings);
  const content = await readFile(path, 'utf8');
  const rules = JSON.parse(content);
  return {
    path: settings.rulesFilePath,
    resolvedPath: path,
    source: settings.readFromGit ? 'git' : 'disk',
    fileName: basename(path),
    schemaVersion: rules.schemaVersion,
    rulesVersion: rules.rulesVersion ?? '',
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
  requireString(rules, 'rulesVersion', errors);
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
  for (const marker of ['cmdb2monitoring', 'fallbackForMethod', 'fallbackUpdateParams', 'fallbackCreateParams', 'createOnUpdateWhenMissing', 'selectInterfaces']) {
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
  const ruleReferences = {
    ...rules,
    catalog: undefined
  };
  const zabbixCatalog = await tryReadCatalogCache(config.Zabbix.Catalog.CacheFilePath);
  if (zabbixCatalog?.templates?.length) {
    const templateIds = new Set(zabbixCatalog.templates.map(template => String(template.templateid)));
    for (const templateId of collectLookupIds(ruleReferences, 'templateid')) {
      if (!templateIds.has(templateId)) {
        errors.push(`Zabbix templateid '${templateId}' is not present in catalog cache.`);
      }
    }
  } else if (config.Zabbix.Catalog.ValidateRulesAgainstCatalog) {
    warnings.push('Zabbix catalog cache is empty; template/group validation against catalog was skipped.');
  }

  if (zabbixCatalog?.hostGroups?.length) {
    const groupIds = new Set(zabbixCatalog.hostGroups.map(group => String(group.groupid)));
    for (const groupId of collectLookupIds(ruleReferences, 'groupid')) {
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
  const cmdbuildCatalog = await tryReadCatalogCache(config.Cmdbuild.Catalog.CacheFilePath);
  const normalized = resolveLookupFieldsFromCatalog(normalizeSourcePayload(source, rules), rules, cmdbuildCatalog);
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

async function createStarterRules() {
  const templatePath = 'rules/cmdbuild-to-zabbix-host-create.production-empty.json';
  const template = JSON.parse(await readFile(resolveRepoPath(templatePath), 'utf8'));
  const current = await readCurrentRules();
  const cmdbuildCatalog = await tryReadCatalogCache(config.Cmdbuild.Catalog.CacheFilePath);
  const zabbixCatalog = await tryReadCatalogCache(config.Zabbix.Catalog.CacheFilePath);
  assertStarterCatalogCaches(cmdbuildCatalog, zabbixCatalog);
  const rules = structuredClone(template);
  const generatedAt = new Date().toISOString();
  const hostGroups = normalizeStarterHostGroups(zabbixCatalog?.hostGroups);
  const templates = normalizeStarterTemplates(zabbixCatalog?.templates);
  const templateGroups = normalizeStarterTemplateGroups(zabbixCatalog?.templateGroups);

  rules.name = 'cmdbuild-to-zabbix-host-create-production-starter';
  rules.rulesVersion = `starter-${generatedAt.replace(/[:.]/g, '-')}`;
  rules.description = `Clean production starter generated from current monitoring-ui-api environment at ${generatedAt}. Routes remain publish=false until an operator completes and validates rules.`;
  rules.source = {
    ...(rules.source ?? {}),
    topic: selectCmdbuildEventsTopic()
  };
  rules.zabbix = {
    ...(rules.zabbix ?? {}),
    apiEndpoint: config.Zabbix?.ApiEndpoint ?? zabbixCatalog?.zabbixEndpoint ?? ''
  };
  rules.catalog = {
    ...(rules.catalog ?? {}),
    generatedAt,
    hostGroups,
    templateGroups,
    templates,
    proxies: normalizeStarterByFields(zabbixCatalog?.proxies, ['proxyid', 'name', 'operating_mode']),
    proxyGroups: normalizeStarterByFields(zabbixCatalog?.proxyGroups, ['proxy_groupid', 'name', 'failover_delay']),
    globalMacros: normalizeStarterByFields(zabbixCatalog?.globalMacros, ['globalmacroid', 'macro', 'description', 'type']),
    hostMacros: normalizeStarterHostMacros(zabbixCatalog?.hostMacros),
    inventoryFields: normalizeStarterByFields(zabbixCatalog?.inventoryFields ?? zabbixInventoryFields(), ['name']),
    interfaceProfiles: normalizeStarterByFields(zabbixCatalog?.interfaceProfiles ?? zabbixInterfaceProfiles(), ['name', 'type', 'defaultPort', 'payload']),
    hostStatuses: normalizeStarterByFields(zabbixCatalog?.hostStatuses ?? zabbixHostStatuses(), ['status', 'name']),
    tlsPskModes: normalizeStarterByFields(zabbixCatalog?.tlsPskModes ?? zabbixTlsPskModes(), ['name', 'tls_connect', 'tls_accept']),
    maintenances: normalizeStarterByFields(zabbixCatalog?.maintenances, ['maintenanceid', 'name', 'maintenance_type']),
    valueMaps: normalizeStarterValueMaps(zabbixCatalog?.valueMaps),
    cmdbuild: normalizeStarterCmdbuildCatalog(cmdbuildCatalog)
  };
  rules.lookups = {
    ...(rules.lookups ?? {}),
    hostGroups,
    templates
  };
  delete rules.lookups.templateGroups;

  if (!hasCompleteT4Templates(rules) && hasCompleteT4Templates(current.content)) {
    rules.t4Templates = structuredClone(current.content.t4Templates);
  }

  const validation = await validateRulesObject(rules);
  return {
    generatedAt,
    templatePath,
    targetPath: config.Rules.RulesFilePath,
    saved: false,
    note: 'Starter was generated in memory only. Save it through the browser, review it locally, then publish it to the rules git repository outside monitoring-ui-api.',
    source: {
      topic: rules.source.topic,
      zabbixApiEndpoint: rules.zabbix.apiEndpoint,
      catalogSyncedAt: zabbixCatalog?.syncedAt ?? null,
      cmdbuildCatalogSyncedAt: cmdbuildCatalog?.syncedAt ?? null,
      zabbixCatalogSyncedAt: zabbixCatalog?.syncedAt ?? null,
      cmdbuildCatalogCounts: {
        classes: rules.catalog.cmdbuild.classes.length,
        attributes: rules.catalog.cmdbuild.attributes.length,
        lookups: rules.catalog.cmdbuild.lookups.length,
        domains: rules.catalog.cmdbuild.domains.length
      },
      catalogCounts: {
        hostGroups: rules.catalog.hostGroups.length,
        templates: rules.catalog.templates.length,
        templateGroups: rules.catalog.templateGroups.length,
        proxies: rules.catalog.proxies.length,
        proxyGroups: rules.catalog.proxyGroups.length,
        globalMacros: rules.catalog.globalMacros.length,
        hostMacros: rules.catalog.hostMacros.length,
        inventoryFields: rules.catalog.inventoryFields.length,
        maintenances: rules.catalog.maintenances.length,
        valueMaps: rules.catalog.valueMaps.length
      }
    },
    validation,
    content: rules
  };
}

function assertStarterCatalogCaches(cmdbuildCatalog, zabbixCatalog) {
  const catalogs = [
    starterCatalogStatus('cmdbuild', config.Cmdbuild.Catalog.CacheFilePath, cmdbuildCatalog, ['classes', 'attributes']),
    starterCatalogStatus('zabbix', config.Zabbix.Catalog.CacheFilePath, zabbixCatalog, ['hostGroups', 'templates'])
  ];
  const missing = catalogs.filter(item => !item.ready);
  if (missing.length === 0) {
    return;
  }

  throw httpError(
    409,
    'starter_catalog_cache_empty',
    'CMDBuild and Zabbix catalog caches must be loaded before creating an empty rules starter.',
    { catalogs, missing: missing.map(item => item.system) }
  );
}

function starterCatalogStatus(system, path, catalog, requiredCollections) {
  const collectionCounts = Object.fromEntries(requiredCollections.map(collection => [
    collection,
    Array.isArray(catalog?.[collection]) ? catalog[collection].length : 0
  ]));
  const emptyCollections = Object.entries(collectionCounts)
    .filter(([, count]) => count === 0)
    .map(([collection]) => collection);
  const exists = Boolean(catalog) && catalog.exists !== false;

  return {
    system,
    path,
    exists,
    syncedAt: catalog?.syncedAt ?? null,
    requiredCollections,
    collectionCounts,
    emptyCollections,
    ready: exists && emptyCollections.length === 0
  };
}

function selectCmdbuildEventsTopic() {
  const topics = publicEventTopics();
  return topics.find(topic =>
    equalsIgnoreCase(topic.service, 'cmdbwebhooks2kafka')
    && equalsIgnoreCase(topic.direction, 'output'))?.name
    ?? topics.find(topic => topic.name.includes('cmdbuild.webhooks'))?.name
    ?? '';
}

function hasCompleteT4Templates(rules) {
  return [
    'hostCreateJsonRpcRequestLines',
    'hostUpdateJsonRpcRequestLines',
    'hostDeleteJsonRpcRequestLines',
    'hostGetByHostJsonRpcRequestLines'
  ].every(templateName => Array.isArray(rules?.t4Templates?.[templateName]) && rules.t4Templates[templateName].length > 0);
}

function normalizeStarterHostGroups(items = []) {
  return normalizeStarterByFields(items, ['name', 'groupid']);
}

function normalizeStarterTemplateGroups(items = []) {
  return normalizeStarterByFields(items, ['name', 'groupid']);
}

function normalizeStarterTemplates(items = []) {
  return normalizeStarterByFields(items, ['name', 'templateid', 'host']);
}

function normalizeStarterHostMacros(items = []) {
  return normalizeStarterByFields(items, ['hostmacroid', 'hostid', 'macro', 'description', 'type', 'host']);
}

function normalizeStarterValueMaps(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      ...pickFields(item, ['valuemapid', 'name']),
      mappings: Array.isArray(item?.mappings)
        ? item.mappings.map(mapping => pickFields(mapping, ['type', 'value', 'newvalue']))
        : []
    }))
    .filter(item => Object.keys(item).some(key => key !== 'mappings' || item.mappings.length > 0));
}

function normalizeStarterCmdbuildCatalog(catalog = {}) {
  return {
    syncedAt: catalog?.syncedAt ?? null,
    cmdbuildEndpoint: catalog?.cmdbuildEndpoint ?? null,
    classes: normalizeStarterByFields(catalog?.classes, ['name', 'description', 'active', 'parent']),
    attributes: (Array.isArray(catalog?.attributes) ? catalog.attributes : [])
      .map(item => ({
        className: item.className,
        items: normalizeStarterByFields(item.items, [
          'name',
          'description',
          'type',
          'lookupType',
          'targetClass',
          'domain',
          'direction',
          'index'
        ])
      }))
      .filter(item => item.className && item.items.length > 0),
    lookups: (Array.isArray(catalog?.lookups) ? catalog.lookups : [])
      .map(item => ({
        ...pickFields(item, ['name', 'description', '_id']),
        values: normalizeStarterByFields(item.values, ['code', 'description', '_id', 'active'])
      }))
      .filter(item => Object.keys(item).some(key => key !== 'values' || item.values.length > 0)),
    domains: normalizeStarterByFields(catalog?.domains, ['name', 'description', 'source', 'destination', 'cardinality'])
  };
}

function normalizeStarterByFields(items = [], fields = []) {
  return (Array.isArray(items) ? items : [])
    .map(item => pickFields(item, fields))
    .filter(item => Object.keys(item).length > 0);
}

function pickFields(item, fields) {
  const result = {};
  for (const field of fields) {
    if (item?.[field] !== undefined && item[field] !== null && item[field] !== '') {
      result[field] = item[field];
    }
  }
  return result;
}

async function uploadRules(payload) {
  if (!config.Rules.AllowUpload) {
    throw httpError(403, 'rules_local_file_disabled', 'Local rules file processing is disabled by configuration.');
  }

  const rules = normalizeRulesPayload(payload);
  const validation = await validateRulesObject(rules);
  if (!validation.valid) {
    return {
      saved: false,
      validation,
      content: rules
    };
  }

  return {
    saved: false,
    path: config.Rules.RulesFilePath,
    note: 'monitoring-ui-api does not write or commit conversion rules. Save the JSON through the browser and publish it to git outside the application.',
    validation,
    content: rules
  };
}

async function fixRulesMapping(payload) {
  if (!config.Rules.AllowUpload) {
    throw httpError(403, 'rules_local_file_disabled', 'Local rules file processing is disabled by configuration.');
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
      changes,
      content: rules
    };
  }

  if (changes.length === 0) {
    return {
      saved: false,
      path: config.Rules.RulesFilePath,
      validation,
      changes,
      content: rules
    };
  }

  return {
    saved: false,
    path: config.Rules.RulesFilePath,
    note: 'Rules were changed in memory only. Save the returned JSON through the browser and publish it to git outside monitoring-ui-api.',
    validation,
    changes,
    content: rules
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

async function syncZabbixCatalog(session) {
  const credentials = requireZabbixSessionCredentials(session);
  const apiEndpoint = credentials.apiEndpoint || config.Zabbix.ApiEndpoint;
  const token = await resolveZabbixToken(apiEndpoint, credentials);
  const zabbixVersion = await readZabbixVersion(apiEndpoint);
  const hostGroups = await zabbixCall(apiEndpoint, token, 'hostgroup.get', {
    output: ['groupid', 'name']
  });
  const templateGroups = await zabbixCallOptional(apiEndpoint, token, 'templategroup.get', {
    output: ['groupid', 'name']
  });
  const templates = await zabbixCall(apiEndpoint, token, 'template.get', {
    output: ['templateid', 'host', 'name'],
    selectTemplateGroups: ['groupid', 'name'],
    selectParentTemplates: ['templateid', 'host', 'name'],
    selectItems: ['itemid', 'key_', 'name', 'inventory_link'],
    selectDiscoveryRules: ['itemid', 'key_', 'name']
  });
  const hosts = await zabbixCallOptional(apiEndpoint, token, 'host.get', {
    output: ['hostid', 'host', 'name'],
    selectTags: ['tag', 'value'],
    selectParentTemplates: ['templateid', 'host', 'name']
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
    zabbixVersion,
    hostGroups,
    templateGroups,
    templates,
    hosts,
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
  catalog.templateCompatibility = buildZabbixTemplateCompatibility(catalog);
  await writeCatalogCache(config.Zabbix.Catalog.CacheFilePath, catalog);

  return catalog;
}

async function readZabbixVersion(apiEndpoint) {
  try {
    const result = await zabbixRawCall(apiEndpoint, null, {
      jsonrpc: '2.0',
      method: 'apiinfo.version',
      params: {},
      id: Date.now()
    });
    return result.result ?? '';
  } catch {
    return '';
  }
}

async function syncCmdbuildCatalog(session) {
  const credentials = requireCmdbuildSessionCredentials(session);
  const baseUrl = withoutTrailingSlash(credentials.baseUrl || config.Cmdbuild.BaseUrl);
  const classesResult = await cmdbuildGet(baseUrl, '/classes', credentials);
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
      const attributesResult = await cmdbuildGet(baseUrl, `/classes/${encodeURIComponent(cmdbClass.name)}/attributes`, credentials);
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
      const lookupTypes = normalizeCmdbuildList(await cmdbuildGet(baseUrl, '/lookup_types', credentials));
      for (const lookup of lookupTypes.slice(0, 500)) {
        const lookupName = lookup.name ?? lookup._id ?? lookup.id;
        if (isBlank(lookupName)) {
          continue;
        }

        try {
          const valuesResult = await cmdbuildGet(baseUrl, `/lookup_types/${encodeURIComponent(lookupName)}/values`, credentials);
          lookups.push({
            ...lookup,
            name: lookup.name ?? lookupName,
            values: normalizeCmdbuildList(valuesResult)
          });
        } catch (error) {
          lookups.push({
            ...lookup,
            name: lookup.name ?? lookupName,
            values: [],
            valuesError: error instanceof Error ? error.message : 'request_failed'
          });
        }
      }
    } catch {
      lookups = [];
    }
  }

  let domains = [];
  try {
    const domainSummaries = normalizeCmdbuildList(await cmdbuildGet(baseUrl, '/domains', credentials));
    for (const summary of domainSummaries.slice(0, 500)) {
      const domainName = summary.name ?? summary._id ?? summary.id ?? '';
      let item = summary;
      if (!isBlank(domainName)) {
        try {
          item = normalizeCmdbuildItem(await cmdbuildGet(baseUrl, `/domains/${encodeURIComponent(domainName)}`, credentials)) ?? summary;
        } catch (error) {
          item = {
            ...summary,
            detailError: error instanceof Error ? error.message : 'request_failed'
          };
        }
      }

      domains.push(normalizeCmdbuildDomain(item));
    }

    domains = domains.filter(item => !isBlank(item.name) || !isBlank(item.source) || !isBlank(item.destination));
  } catch {
    domains = [];
  }

  const catalog = {
    syncedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    maxTraversalDepth: cmdbuildTraversalMaxDepth(config.Cmdbuild?.Catalog?.MaxTraversalDepth),
    classes: selectedClasses,
    attributes,
    lookups,
    domains
  };
  await writeCatalogCache(config.Cmdbuild.Catalog.CacheFilePath, catalog);

  return catalog;
}

function normalizeCmdbuildDomain(item = {}) {
  return {
    name: item.name ?? item._id ?? item.id ?? '',
    description: item.description ?? item.label ?? item._description ?? '',
    source: item.source ?? item.sourceClass ?? item._sourceType ?? item.sourceType ?? null,
    destination: item.destination ?? item.destinationClass ?? item._destinationType ?? item.destinationType
      ?? item.target ?? item.targetClass ?? item._targetType ?? item.targetType ?? null,
    cardinality: item.cardinality ?? item.type ?? '',
    raw: item
  };
}

async function readCmdbuildWebhooks(session) {
  const credentials = requireCmdbuildSessionCredentials(session);
  const baseUrl = withoutTrailingSlash(credentials.baseUrl || config.Cmdbuild.BaseUrl);
  const result = await cmdbuildGet(baseUrl, '/etl/webhook/?detailed=true', credentials, {
    'CMDBuild-View': 'admin'
  });

  return {
    loadedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    managedPrefix: managedCmdbuildWebhookPrefix,
    items: normalizeCmdbuildList(result).map(normalizeCmdbuildWebhook).filter(item => item.code)
  };
}

async function applyCmdbuildWebhookOperations(session, payload) {
  const operations = Array.isArray(payload?.operations)
    ? payload.operations.filter(operation => operation?.selected !== false)
    : [];
  if (operations.length === 0) {
    throw httpError(400, 'empty_webhook_operations', 'No selected CMDBuild webhook operations were provided.');
  }

  const credentials = requireCmdbuildSessionCredentials(session);
  const baseUrl = withoutTrailingSlash(credentials.baseUrl || config.Cmdbuild.BaseUrl);
  const results = [];
  for (const operation of operations) {
    const action = String(operation?.action ?? '').trim().toLowerCase();
    const desiredInput = isPlainObject(operation?.desired) ? operation.desired : {};
    const current = normalizeCmdbuildWebhook(operation?.current ?? {});
    const code = firstNonBlank(desiredInput.code, desiredInput._id, desiredInput.id, current.code, operation?.code);
    if (!String(code).startsWith(managedCmdbuildWebhookPrefix)) {
      throw httpError(400, 'unsafe_webhook_operation', `Webhook '${code}' is outside managed prefix '${managedCmdbuildWebhookPrefix}'.`);
    }

    if (action === 'create') {
      const desired = normalizeCmdbuildWebhookPayload(desiredInput);
      await cmdbuildRequest(baseUrl, '/etl/webhook/', credentials, {
        method: 'POST',
        body: desired,
        headers: { 'CMDBuild-View': 'admin' }
      });
      results.push({ action, code, status: 'applied' });
      continue;
    }

    if (action === 'update') {
      const desired = normalizeCmdbuildWebhookPayload(desiredInput);
      const id = encodeURIComponent(current._id || current.id || code);
      await cmdbuildRequest(baseUrl, `/etl/webhook/${id}/`, credentials, {
        method: 'PUT',
        body: desired,
        headers: { 'CMDBuild-View': 'admin' }
      });
      results.push({ action, code, status: 'applied' });
      continue;
    }

    if (action === 'delete') {
      const id = encodeURIComponent(current._id || current.id || code);
      await cmdbuildRequest(baseUrl, `/etl/webhook/${id}/`, credentials, {
        method: 'DELETE',
        headers: { 'CMDBuild-View': 'admin' }
      });
      results.push({ action, code, status: 'applied' });
      continue;
    }

    throw httpError(400, 'unsupported_webhook_operation', `Unsupported webhook operation '${action}'.`);
  }

  return {
    appliedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    count: results.length,
    results
  };
}

async function analyzeCmdbuildAuditModel(session, payload = {}) {
  const credentials = requireCmdbuildSessionCredentials(session);
  const baseUrl = withoutTrailingSlash(credentials.baseUrl || config.Cmdbuild.BaseUrl);
  const rules = await readCurrentRules();
  const catalog = await syncCmdbuildCatalog(session);
  const parentClass = stringOrDefault(payload.parentClass, defaultAuditBindingParentClass(catalog));
  const plan = buildCmdbuildAuditModelPlan(rules.content ?? rules, catalog, parentClass);

  return {
    analyzedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    catalogSyncedAt: catalog.syncedAt ?? '',
    rulesVersion: plan.rulesVersion,
    schemaVersion: plan.schemaVersion,
    parentClass,
    mainAttributeName: auditMainHostIdAttributeName,
    bindingClassName: auditBindingClassName,
    classes: catalog.classes ?? [],
    ...plan
  };
}

async function applyCmdbuildAuditModel(session, payload = {}) {
  const credentials = requireCmdbuildSessionCredentials(session);
  const baseUrl = withoutTrailingSlash(credentials.baseUrl || config.Cmdbuild.BaseUrl);
  const rules = await readCurrentRules();
  let catalog = await syncCmdbuildCatalog(session);
  const parentClass = stringOrDefault(payload.parentClass, defaultAuditBindingParentClass(catalog));
  const before = buildCmdbuildAuditModelPlan(rules.content ?? rules, catalog, parentClass);
  const results = [];

  for (const item of before.classChecks) {
    if (!item.exists) {
      results.push({
        action: 'skip_main_attribute',
        className: item.className,
        status: 'skipped',
        reason: 'class_missing'
      });
      continue;
    }
    if (item.hasMainHostId) {
      continue;
    }

    await createCmdbuildStringAttribute(baseUrl, credentials, item.className, {
      name: auditMainHostIdAttributeName,
      description: 'Zabbix main host ID',
      maxLength: 64,
      showInGrid: false
    });
    results.push({
      action: 'create_main_attribute',
      className: item.className,
      attribute: auditMainHostIdAttributeName,
      status: 'applied'
    });
  }

  if (!before.bindingClass.exists) {
    await createCmdbuildClass(baseUrl, credentials, parentClass, {
      name: auditBindingClassName,
      description: 'Zabbix Host Binding'
    });
    results.push({
      action: 'create_binding_class',
      className: auditBindingClassName,
      parentClass,
      status: 'applied'
    });
  }

  for (const attribute of before.bindingAttributes) {
    if (attribute.exists) {
      continue;
    }
    const definition = auditBindingAttributes.find(item => sameNormalized(item.name, attribute.name));
    await createCmdbuildStringAttribute(baseUrl, credentials, auditBindingClassName, {
      name: definition?.name ?? attribute.name,
      description: definition?.description ?? attribute.name,
      maxLength: definition?.maxLength ?? 128,
      showInGrid: ['OwnerClass', 'OwnerCardId', 'HostProfile', 'ZabbixHostId'].some(item => sameNormalized(item, attribute.name))
    });
    results.push({
      action: 'create_binding_attribute',
      className: auditBindingClassName,
      attribute: definition?.name ?? attribute.name,
      status: 'applied'
    });
  }

  catalog = await syncCmdbuildCatalog(session);
  const after = buildCmdbuildAuditModelPlan(rules.content ?? rules, catalog, parentClass);
  return {
    appliedAt: new Date().toISOString(),
    cmdbuildEndpoint: baseUrl,
    catalogSyncedAt: catalog.syncedAt ?? '',
    rulesVersion: after.rulesVersion,
    schemaVersion: after.schemaVersion,
    parentClass,
    mainAttributeName: auditMainHostIdAttributeName,
    bindingClassName: auditBindingClassName,
    count: results.length,
    results,
    classes: catalog.classes ?? [],
    ...after
  };
}

async function runQuickAudit(session, payload = {}) {
  const cmdbuildCredentials = requireCmdbuildSessionCredentials(session);
  const zabbixCredentials = requireZabbixSessionCredentials(session);
  const cmdbuildBaseUrl = withoutTrailingSlash(cmdbuildCredentials.baseUrl || config.Cmdbuild.BaseUrl);
  const zabbixEndpoint = zabbixCredentials.apiEndpoint || config.Zabbix.ApiEndpoint;
  const rulesDocument = await readCurrentRules();
  const rules = rulesDocument.content ?? rulesDocument;
  const cmdbuildCatalog = await syncCmdbuildCatalog(session);
  const zabbixToken = await resolveZabbixToken(zabbixEndpoint, zabbixCredentials);
  const scope = quickAuditScope(cmdbuildCatalog, rules, payload);
  const maxCardsPerClass = clampInt(payload.maxCards, 100, 1, 500);
  const cardsOffset = clampInt(payload.offset, 0, 0, 1000000000);
  const bindingCards = await readAuditBindingCards(cmdbuildBaseUrl, cmdbuildCredentials, cmdbuildCatalog);
  const bindingMap = buildAuditBindingMap(bindingCards);
  const pendingItems = [];
  const fetchErrors = [];
  let cardCount = 0;

  for (const cmdbClass of scope.selectedClasses) {
    let cards = [];
    try {
      cards = await readCmdbuildCards(cmdbuildBaseUrl, cmdbuildCredentials, cmdbClass.name, maxCardsPerClass, cardsOffset);
    } catch (error) {
      fetchErrors.push({
        className: cmdbClass.name,
        severity: 'error',
        reason: 'cmdbuild_cards_read_failed',
        notes: [error instanceof Error ? error.message : 'CMDBuild cards read failed.']
      });
      continue;
    }

    cardCount += cards.length;
    for (const card of cards) {
      pendingItems.push(...buildQuickAuditItemsForCard({
        rules,
        catalog: cmdbuildCatalog,
        cmdbClass,
        card,
        bindingMap
      }));
    }
  }

  const zabbixHosts = await readZabbixHostsForQuickAudit(
    zabbixEndpoint,
    zabbixToken,
    pendingItems.map(item => item.expected ?? {})
  );
  const items = [
    ...fetchErrors,
    ...pendingItems.map(item => compareQuickAuditItem(item, zabbixHosts))
  ];

  return {
    auditedAt: new Date().toISOString(),
    cmdbuildEndpoint: cmdbuildBaseUrl,
    zabbixEndpoint,
    catalogSyncedAt: cmdbuildCatalog.syncedAt ?? '',
    rulesVersion: rules.rulesVersion ?? '',
    schemaVersion: rules.schemaVersion ?? '',
    classes: cmdbuildCatalog.classes ?? [],
    scope: {
      className: scope.className,
      includeDescendants: scope.includeDescendants,
      onlyRulesClasses: scope.onlyRulesClasses,
      maxCardsPerClass,
      offset: cardsOffset,
      nextOffset: cardsOffset + maxCardsPerClass,
      participatingClasses: scope.participatingClasses,
      selectedClasses: scope.selectedClasses.map(item => item.name)
    },
    summary: quickAuditSummary(items, scope.selectedClasses.length, cardCount),
    items
  };
}

function buildCmdbuildAuditModelPlan(rules = {}, catalog = {}, parentClass = 'Class') {
  const participatingClasses = conversionParticipatingClasses(rules, catalog);
  const classChecks = participatingClasses.map(className => {
    const catalogClass = findCmdbuildCatalogClass(catalog, className);
    const attributes = catalogAttributesForClass(catalog, catalogClass?.name ?? className);
    const mainAttribute = findCmdbuildCatalogAttribute(attributes, auditMainHostIdAttributeName);
    return {
      className,
      description: catalogClass?.description ?? '',
      exists: Boolean(catalogClass),
      hasMainHostId: Boolean(mainAttribute),
      inherited: Boolean(mainAttribute?.inherited),
      attributeType: mainAttribute?.type ?? '',
      action: !catalogClass
        ? 'class_missing'
        : mainAttribute
          ? 'none'
          : 'create_attribute'
    };
  });

  const bindingClass = findCmdbuildCatalogClass(catalog, auditBindingClassName);
  const bindingAttributes = auditBindingAttributes.map(attribute => {
    const existing = bindingClass
      ? findCmdbuildCatalogAttribute(catalogAttributesForClass(catalog, bindingClass.name), attribute.name)
      : null;
    return {
      name: attribute.name,
      description: attribute.description,
      exists: Boolean(existing),
      type: existing?.type ?? 'string',
      action: existing ? 'none' : 'create_attribute'
    };
  });
  const operations = [
    ...classChecks
      .filter(item => item.action === 'create_attribute')
      .map(item => ({
        action: 'create_main_attribute',
        className: item.className,
        attribute: auditMainHostIdAttributeName
      })),
    ...(!bindingClass ? [{
      action: 'create_binding_class',
      className: auditBindingClassName,
      parentClass
    }] : []),
    ...bindingAttributes
      .filter(item => item.action === 'create_attribute')
      .map(item => ({
        action: 'create_binding_attribute',
        className: auditBindingClassName,
        attribute: item.name
      }))
  ];

  return {
    schemaVersion: rules.schemaVersion ?? '',
    rulesVersion: rules.rulesVersion ?? '',
    participatingClasses,
    classChecks,
    bindingClass: {
      name: auditBindingClassName,
      parentClass: bindingClass?.parent ?? parentClass,
      exists: Boolean(bindingClass),
      description: bindingClass?.description ?? ''
    },
    bindingAttributes,
    operations,
    ready: operations.length === 0
  };
}

function uniqueTokens(values = []) {
  const result = [];
  for (const value of values) {
    if (isBlank(value) || result.some(item => auditSameValue(item, value))) {
      continue;
    }
    result.push(String(value).trim());
  }
  return result;
}

function auditComparableKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function auditSameValue(left, right) {
  return auditComparableKey(left) === auditComparableKey(right);
}

function quickAuditScope(catalog = {}, rules = {}, payload = {}) {
  const className = stringOrDefault(payload.className, 'Class');
  const includeDescendants = payload.includeDescendants !== false;
  const onlyRulesClasses = payload.onlyRulesClasses !== false;
  const participatingClasses = conversionParticipatingClasses(rules, catalog);
  const catalogByName = new Map((catalog.classes ?? [])
    .filter(item => item?.name)
    .map(item => [auditComparableKey(item.name), item]));
  let selectedNames;

  if (auditSameValue(className, 'Class')) {
    selectedNames = onlyRulesClasses
      ? participatingClasses
      : [...catalogByName.values()].map(item => item.name);
  } else {
    selectedNames = includeDescendants
      ? cmdbuildClassWithDescendants(catalog, className)
      : [className];
    if (onlyRulesClasses) {
      selectedNames = selectedNames.filter(name => participatingClasses.some(item => auditSameValue(item, name)));
    }
  }

  const selectedClasses = [];
  for (const name of uniqueTokens(selectedNames)) {
    if (auditSameValue(name, auditBindingClassName)) {
      continue;
    }
    const catalogClass = catalogByName.get(auditComparableKey(name));
    selectedClasses.push({
      name: catalogClass?.name ?? name,
      description: catalogClass?.description ?? ''
    });
  }

  return {
    className,
    includeDescendants,
    onlyRulesClasses,
    participatingClasses,
    selectedClasses: selectedClasses.sort((left, right) => compareText(left.name, right.name))
  };
}

function cmdbuildClassWithDescendants(catalog = {}, className = '') {
  const byName = new Map((catalog.classes ?? [])
    .filter(item => item?.name)
    .map(item => [auditComparableKey(item.name), item]));
  const selected = byName.get(auditComparableKey(className));
  if (!selected) {
    return [className];
  }

  const childrenByParent = new Map();
  for (const item of byName.values()) {
    const parent = cmdbuildCatalogClassParent(item);
    if (isBlank(parent)) {
      continue;
    }
    const key = auditComparableKey(parent);
    const items = childrenByParent.get(key) ?? [];
    items.push(item);
    childrenByParent.set(key, items);
  }

  const result = [];
  const visit = item => {
    if (!item?.name || result.some(name => auditSameValue(name, item.name))) {
      return;
    }
    result.push(item.name);
    for (const child of childrenByParent.get(auditComparableKey(item.name)) ?? []) {
      visit(child);
    }
  };
  visit(selected);
  return result;
}

function cmdbuildCatalogClassParent(item = {}) {
  if (typeof item.parent === 'string') {
    return item.parent;
  }
  if (isPlainObject(item.parent)) {
    return item.parent.name ?? item.parent._id ?? item.parent.id ?? '';
  }
  const raw = item.raw ?? {};
  if (typeof raw.parent === 'string') {
    return raw.parent;
  }
  if (isPlainObject(raw.parent)) {
    return raw.parent.name ?? raw.parent._id ?? raw.parent.id ?? '';
  }
  return raw.superclass ?? raw.prototype ?? '';
}

async function readCmdbuildCards(baseUrl, credentials, className, limit, offset = 0) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  });
  const result = await cmdbuildGet(baseUrl, `/classes/${encodeURIComponent(className)}/cards?${params}`, credentials);
  return normalizeCmdbuildList(result);
}

async function readAuditBindingCards(baseUrl, credentials, catalog = {}) {
  if (!findCmdbuildCatalogClass(catalog, auditBindingClassName)) {
    return [];
  }

  try {
    return await readCmdbuildCards(baseUrl, credentials, auditBindingClassName, 5000);
  } catch {
    return [];
  }
}

function buildAuditBindingMap(cards = []) {
  const result = new Map();
  for (const card of cards) {
    const status = readCmdbuildCardField(card, 'BindingStatus');
    if (equalsIgnoreCase(status, 'deleted')) {
      continue;
    }
    const key = auditBindingKey(
      readCmdbuildCardField(card, 'OwnerClass'),
      readCmdbuildCardField(card, 'OwnerCardId'),
      readCmdbuildCardField(card, 'HostProfile')
    );
    if (!isBlank(key)) {
      result.set(key, card);
    }
  }
  return result;
}

function auditBindingKey(className, cardId, hostProfile) {
  const parts = [className, cardId, hostProfile].map(value => String(value ?? '').trim());
  return parts.some(isBlank) ? '' : parts.map(auditComparableKey).join(':');
}

function buildQuickAuditItemsForCard({ rules, catalog, cmdbClass, card, bindingMap }) {
  const source = normalizeAuditCardSource(card, rules, catalog, cmdbClass.name);
  const cardId = source.entityId || source.id || readCmdbuildCardField(card, 'id');
  const code = source.code || readCmdbuildCardField(card, 'code');
  const suppression = auditSuppressionForSource(rules, source);
  const profiles = auditHostProfilesForSource(rules, source);
  if (profiles.length === 0) {
    return [{
      className: cmdbClass.name,
      cardId,
      code,
      profileName: '',
      profileRole: '',
      severity: suppression ? 'ok' : 'warning',
      reason: suppression ? 'suppressed_no_profile' : 'no_host_profile_matched',
      checks: [suppression ? 'suppressed_by_rule' : 'no_host_profile_matched'],
      notes: [suppression
        ? `Monitoring is suppressed by ${suppression.reason || suppression.name}.`
        : 'No hostProfiles[] rule matched the CMDBuild card.'],
      suppression,
      expected: null,
      actual: null
    }];
  }

  return profiles.map((profile, index) => {
    const isMainProfile = index === 0;
    const profileName = stringOrDefault(profile.name, isMainProfile ? 'main' : `profile-${index + 1}`);
    const profileSource = {
      ...source,
      hostProfile: profileName,
      outputProfile: profile.outputProfile ?? profileName
    };
    const expected = buildQuickAuditExpectation({
      rules,
      card,
      source: profileSource,
      profile,
      profileName,
      isMainProfile,
      bindingMap
    });
    return {
      className: cmdbClass.name,
      cardId,
      code,
      profileName,
      profileRole: isMainProfile ? 'main' : 'additional',
      suppression,
      expected,
      actual: null,
      severity: 'info',
      checks: [],
      notes: []
    };
  });
}

function normalizeAuditCardSource(card = {}, rules = {}, catalog = {}, className = '') {
  const normalizedCard = {};
  for (const [key, value] of Object.entries(card)) {
    normalizedCard[key] = normalizeCmdbuildCardValue(value);
  }

  const id = firstNonBlank(
    readCmdbuildCardField(card, '_id'),
    readCmdbuildCardField(card, 'id'),
    normalizedCard._id,
    normalizedCard.id
  );
  const code = firstNonBlank(
    readCmdbuildCardField(card, 'code'),
    readCmdbuildCardField(card, 'Code'),
    readCmdbuildCardField(card, '_code'),
    normalizedCard.code,
    normalizedCard.Code,
    id
  );
  const payload = {
    ...normalizedCard,
    id,
    entityId: id,
    code,
    className,
    entityType: className,
    eventType: 'update'
  };
  return resolveLookupFieldsFromCatalog(normalizeSourcePayload(payload, rules), rules, catalog);
}

function normalizeCmdbuildCardValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCmdbuildCardValue).filter(item => !isBlank(item)).join(',');
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return firstNonBlank(
    value.code,
    value._code,
    value.name,
    value._description_translation,
    value.description,
    value._id,
    value.id
  );
}

function readCmdbuildCardField(card = {}, fieldName = '') {
  if (!card || isBlank(fieldName)) {
    return '';
  }
  const variants = [fieldName, `_${fieldName}`, fieldName.replace(/^_/, '')];
  for (const variant of variants) {
    if (card[variant] !== undefined) {
      return normalizeCmdbuildCardValue(card[variant]);
    }
  }
  const wanted = normalizeToken(fieldName);
  const key = Object.keys(card).find(item => normalizeToken(item) === wanted || normalizeToken(item.replace(/^_/, '')) === wanted);
  return key ? normalizeCmdbuildCardValue(card[key]) : '';
}

function auditSuppressionForSource(rules = {}, source = {}) {
  return (rules.monitoringSuppressionRules ?? [])
    .filter(rule => rule?.enabled !== false)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .find(rule => auditRuleMatches(rule, source, false)) ?? null;
}

function auditHostProfilesForSource(rules = {}, source = {}) {
  return (rules.hostProfiles ?? [])
    .filter(profile => profile?.enabled !== false)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .filter(profile => auditRuleMatches(profile, source, true));
}

function auditRuleMatches(rule = {}, source = {}, emptyMatches = true) {
  const when = rule.when;
  if (!isPlainObject(when) || Object.keys(when).length === 0) {
    return emptyMatches;
  }
  return matchesCondition(when, source);
}

function buildQuickAuditExpectation({ rules, card, source, profile, profileName, isMainProfile, bindingMap }) {
  const interfaces = auditProfileInterfaces(rules, profile, source);
  const model = quickAuditTemplateModel(rules, source, profileName, interfaces[0]);
  const host = stringOrDefault(
    profile.hostNameTemplate ? renderSimple(profile.hostNameTemplate, model) : '',
    normalizeHostName(rules, source.className, source.code || source.entityId || source.id || 'unknown', source)
  );
  const visibleName = stringOrDefault(
    profile.visibleNameTemplate ? renderSimple(profile.visibleNameTemplate, { ...model, Host: host }) : '',
    `${source.className} ${source.code || source.entityId || source.id || ''}`.trim()
  );
  const bindingCard = isMainProfile
    ? null
    : bindingMap.get(auditBindingKey(source.className, source.entityId || source.id, profileName));
  const bindingHostId = isMainProfile
    ? readCmdbuildCardField(card, auditMainHostIdAttributeName)
    : readCmdbuildCardField(bindingCard, 'ZabbixHostId');
  const groupModel = { ...model, Host: host, VisibleName: visibleName };
  const hostStatus = selectSingleRuleItem(rules.hostStatusSelectionRules, rules, source, 'hostStatus', 'hostStatusRef')
    ?? rules.defaults?.hostStatus
    ?? rules.defaults?.host;

  return {
    host,
    visibleName,
    bindingHostId,
    bindingSource: isMainProfile ? auditMainHostIdAttributeName : auditBindingClassName,
    bindingStatus: isMainProfile ? (isBlank(bindingHostId) ? 'missing' : 'active') : readCmdbuildCardField(bindingCard, 'BindingStatus'),
    interfaces,
    groups: auditLookupItems(rules.groupSelectionRules, rules, source, 'hostGroups', 'hostGroupsRef', groupModel),
    templates: auditLookupItems(rules.templateSelectionRules, rules, source, 'templates', 'templatesRef', groupModel),
    maintenances: auditLookupItems(rules.maintenanceSelectionRules, rules, source, 'maintenances', 'maintenancesRef', groupModel),
    status: hostStatus?.status ?? rules.defaults?.host?.status ?? 0
  };
}

function quickAuditTemplateModel(rules, source, profileName, firstInterface = {}) {
  const className = source.className || source.entityType || 'unknown';
  const hostInput = source.code || source.id || source.entityId || 'unknown';
  const host = normalizeHostName(rules, className, hostInput, source);
  return {
    ClassName: className,
    EntityId: source.entityId || source.id,
    Code: source.code,
    IpAddress: source.ipAddress || source.ip_address,
    DnsName: source.dnsName || source.dns_name,
    OperatingSystem: source.os,
    ZabbixTag: source.zabbixTag,
    EventType: source.eventType,
    HostProfileName: profileName,
    OutputProfileName: source.outputProfile ?? profileName,
    Host: host,
    VisibleName: `${className} ${source.code || source.id || source.entityId || ''}`.trim(),
    Interface: firstInterface,
    Fields: source
  };
}

function auditProfileInterfaces(rules = {}, profile = {}, source = {}) {
  const profileRules = Array.isArray(profile.interfaces) ? profile.interfaces : [];
  if (profileRules.length === 0) {
    const fallback = selectInterface(rules, source);
    return fallback ? [fallback] : [];
  }

  const matched = profileRules
    .filter(rule => !rule.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .filter(rule => auditRuleMatches(rule, source, true));
  const selected = matched.length > 0
    ? matched
    : profileRules
      .filter(rule => rule.fallback)
      .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
      .filter(rule => auditRuleMatches(rule, source, true));
  return selected
    .map(rule => auditInterfaceFromProfileRule(rules, rule, source))
    .filter(Boolean);
}

function auditInterfaceFromProfileRule(rules = {}, rule = {}, source = {}) {
  const valueField = rule.valueField || rule.field || rule.mode;
  const value = readSourceField(source, valueField);
  if (isBlank(value)) {
    return null;
  }
  const mode = rule.mode || (canonicalSourceField(valueField) === 'dnsName' ? 'dns' : 'ip');
  const profile = resolveAuditInterfaceProfile(rules, rule.interfaceProfileRef || rule.interfaceRef);
  return {
    ...applyInterfaceAddress(profile, { mode, value }, source),
    name: rule.name ?? '',
    sourceField: valueField,
    mode,
    address: value
  };
}

function resolveAuditInterfaceProfile(rules = {}, profileRef = '') {
  if (!isBlank(profileRef)) {
    const key = String(profileRef).trim();
    if (rules.defaults?.interfaceProfiles?.[key]) {
      return rules.defaults.interfaceProfiles[key];
    }
    if (equalsIgnoreCase(key, 'agent') || equalsIgnoreCase(key, 'agentInterface')) {
      return rules.defaults?.agentInterface ?? {};
    }
    if (equalsIgnoreCase(key, 'snmp') || equalsIgnoreCase(key, 'snmpInterface')) {
      return rules.defaults?.snmpInterface ?? {};
    }
  }
  return rules.defaults?.agentInterface ?? {};
}

function auditLookupItems(rulesList = [], rules = {}, source = {}, propertyName, refName, model = {}) {
  const matched = rulesList
    .filter(rule => rule?.enabled !== false && !rule.fallback)
    .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
    .filter(rule => auditRuleMatches(rule, source, false));
  const selected = matched.length > 0
    ? matched
    : rulesList
      .filter(rule => rule?.enabled !== false && rule.fallback)
      .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
      .filter(rule => auditRuleMatches(rule, source, true));
  const items = selected.flatMap(rule => {
    if (Array.isArray(rule[propertyName]) && rule[propertyName].length > 0) {
      return rule[propertyName];
    }
    if (rule[propertyName] && typeof rule[propertyName] === 'object') {
      return [rule[propertyName]];
    }
    if (rule[refName] === `defaults.${propertyName}`) {
      const value = rules.defaults?.[propertyName];
      return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    }
    return [];
  });

  const unique = new Map();
  for (const item of items) {
    const rendered = {
      ...item,
      name: item.name ?? (item.nameTemplate ? renderSimple(item.nameTemplate, model) : undefined),
      host: item.host ?? (item.hostTemplate ? renderSimple(item.hostTemplate, model) : undefined),
      value: item.value ?? (item.valueTemplate ? renderSimple(item.valueTemplate, model) : undefined)
    };
    const key = rendered.groupid
      || rendered.templateid
      || rendered.maintenanceid
      || rendered.maintenanceId
      || rendered.host
      || rendered.name
      || rendered.value;
    if (!isBlank(key)) {
      unique.set(String(key), rendered);
    }
  }

  return [...unique.values()];
}

async function readZabbixHostsForQuickAudit(apiEndpoint, token, expectedItems = []) {
  const hostids = uniqueTokens(expectedItems.map(item => item.bindingHostId).filter(value => !isBlank(value)));
  const hosts = uniqueTokens(expectedItems.map(item => item.host).filter(value => !isBlank(value)));
  const byHostId = new Map();
  const byHost = new Map();
  const add = item => {
    if (!item) {
      return;
    }
    if (!isBlank(item.hostid)) {
      byHostId.set(String(item.hostid), item);
    }
    if (!isBlank(item.host)) {
      byHost.set(auditComparableKey(item.host), item);
    }
  };

  const params = {
    output: ['hostid', 'host', 'name', 'status'],
    selectInterfaces: ['interfaceid', 'type', 'main', 'useip', 'ip', 'dns', 'port'],
    selectGroups: ['groupid', 'name'],
    selectParentTemplates: ['templateid', 'host', 'name'],
    selectTags: ['tag', 'value']
  };
  if (hostids.length > 0) {
    for (const item of await zabbixCall(apiEndpoint, token, 'host.get', {
      ...params,
      hostids
    })) {
      add(item);
    }
  }
  if (hosts.length > 0) {
    for (const item of await zabbixCall(apiEndpoint, token, 'host.get', {
      ...params,
      filter: { host: hosts }
    })) {
      add(item);
    }
  }

  const maintenancesByHostId = await readZabbixMaintenanceMembershipsForQuickAudit(apiEndpoint, token, expectedItems);
  return { byHostId, byHost, maintenancesByHostId };
}

async function readZabbixMaintenanceMembershipsForQuickAudit(apiEndpoint, token, expectedItems = []) {
  const expectedMaintenances = expectedItems.flatMap(item => item.maintenances ?? []);
  if (expectedMaintenances.length === 0) {
    return new Map();
  }

  const maintenanceIds = uniqueTokens(expectedMaintenances
    .map(item => item.maintenanceid ?? item.maintenanceId)
    .filter(value => !isBlank(value)));
  const maintenanceNames = uniqueTokens(expectedMaintenances
    .map(item => item.name)
    .filter(value => !isBlank(value)));
  const params = {
    output: ['maintenanceid', 'name', 'maintenance_type'],
    selectHosts: ['hostid', 'host', 'name'],
    ...(maintenanceIds.length > 0 ? { maintenanceids: maintenanceIds } : {})
  };
  const maintenances = await zabbixCall(apiEndpoint, token, 'maintenance.get', params);
  const wanted = maintenanceIds.length > 0
    ? maintenances
    : maintenances.filter(item => maintenanceNames.some(name => auditSameValue(name, item.name)));
  const result = new Map();
  for (const maintenance of wanted) {
    for (const host of maintenance.hosts ?? []) {
      if (isBlank(host.hostid)) {
        continue;
      }
      const items = result.get(String(host.hostid)) ?? [];
      items.push({
        maintenanceid: maintenance.maintenanceid ?? '',
        name: maintenance.name ?? '',
        maintenance_type: maintenance.maintenance_type ?? ''
      });
      result.set(String(host.hostid), items);
    }
  }

  return result;
}

function compareQuickAuditItem(item = {}, zabbixHosts = {}) {
  if (!item.expected) {
    return item;
  }

  const expected = item.expected;
  const actual = !isBlank(expected.bindingHostId)
    ? zabbixHosts.byHostId.get(String(expected.bindingHostId))
    : null;
  const actualByHost = !actual && !isBlank(expected.host)
    ? zabbixHosts.byHost.get(auditComparableKey(expected.host))
    : null;
  const zabbixHost = actual ?? actualByHost ?? null;
  if (zabbixHost && !zabbixHost.maintenances) {
    zabbixHost.maintenances = zabbixHosts.maintenancesByHostId?.get(String(zabbixHost.hostid)) ?? [];
  }
  const checks = [];
  const notes = [];

  if (item.suppression) {
    if (zabbixHost) {
      checks.push({ severity: 'error', code: 'suppressed_host_exists', message: `Object is marked "не ставить на мониторинг", but Zabbix host ${zabbixHost.host} exists.` });
    } else {
      checks.push({ severity: 'ok', code: 'suppressed_host_absent', message: `Object is marked "не ставить на мониторинг" by ${item.suppression.reason || item.suppression.name}.` });
    }
    return finalizeQuickAuditItem(item, zabbixHost, checks, notes);
  }

  if (isBlank(expected.host)) {
    checks.push({ severity: 'error', code: 'expected_host_empty', message: 'Expected Zabbix host name is empty.' });
  }
  if (!zabbixHost) {
    checks.push({ severity: 'error', code: 'zabbix_host_missing', message: `Zabbix host ${expected.host || expected.bindingHostId || '-'} was not found.` });
    return finalizeQuickAuditItem(item, zabbixHost, checks, notes);
  }
  if (isBlank(expected.bindingHostId)) {
    checks.push({ severity: 'warning', code: 'binding_missing', message: `Binding ${expected.bindingSource} is empty; host was found by name.` });
  }
  if (!auditSameValue(zabbixHost.host, expected.host)) {
    checks.push({ severity: 'warning', code: 'host_name_mismatch', message: `Expected host ${expected.host}, actual ${zabbixHost.host}.` });
  }

  const missingInterfaces = expected.interfaces.filter(expectedInterface => !zabbixInterfaceExists(zabbixHost.interfaces ?? [], expectedInterface));
  if (expected.interfaces.length === 0) {
    checks.push({ severity: 'warning', code: 'expected_interface_empty', message: 'Expected interface set is empty.' });
  } else if (missingInterfaces.length > 0) {
    checks.push({ severity: 'error', code: 'interface_missing', message: `Missing interface address: ${missingInterfaces.map(formatAuditInterface).join(', ')}.` });
  }

  const missingGroups = expected.groups.filter(group => !zabbixCollectionContains(zabbixHost.groups ?? [], group, 'groupid'));
  if (missingGroups.length > 0) {
    checks.push({ severity: 'error', code: 'host_group_missing', message: `Missing host groups: ${missingGroups.map(auditLookupItemName).join(', ')}.` });
  }
  const missingTemplates = expected.templates.filter(template => !zabbixCollectionContains(zabbixHost.parentTemplates ?? [], template, 'templateid'));
  if (missingTemplates.length > 0) {
    checks.push({ severity: 'error', code: 'template_missing', message: `Missing templates: ${missingTemplates.map(auditLookupItemName).join(', ')}.` });
  }
  const missingMaintenances = expected.maintenances.filter(maintenance => !zabbixCollectionContains(zabbixHost.maintenances ?? [], maintenance, 'maintenanceid'));
  if (missingMaintenances.length > 0) {
    checks.push({ severity: 'warning', code: 'maintenance_missing', message: `Missing maintenances: ${missingMaintenances.map(auditLookupItemName).join(', ')}.` });
  }
  if (!isBlank(expected.status) && String(zabbixHost.status) !== String(expected.status)) {
    checks.push({ severity: 'warning', code: 'status_mismatch', message: `Expected status ${expected.status}, actual ${zabbixHost.status}.` });
  }
  if (checks.length === 0) {
    checks.push({ severity: 'ok', code: 'matched', message: 'Main audited parameters match.' });
  }

  return finalizeQuickAuditItem(item, zabbixHost, checks, notes);
}

function finalizeQuickAuditItem(item = {}, zabbixHost, checks = [], notes = []) {
  const severity = checks.reduce((current, check) => worstQuickAuditSeverity(current, check.severity), 'ok');
  return {
    ...item,
    actual: zabbixHost ? {
      hostid: zabbixHost.hostid ?? '',
      host: zabbixHost.host ?? '',
      name: zabbixHost.name ?? '',
      status: zabbixHost.status ?? '',
      interfaces: zabbixHost.interfaces ?? [],
      groups: zabbixHost.groups ?? [],
      templates: zabbixHost.parentTemplates ?? [],
      maintenances: zabbixHost.maintenances ?? []
    } : null,
    severity,
    checks: checks.map(check => check.code),
    notes: [...notes, ...checks.map(check => check.message)]
  };
}

function worstQuickAuditSeverity(current, next) {
  const order = { ok: 0, info: 0, warning: 1, error: 2 };
  return (order[next] ?? 0) > (order[current] ?? 0) ? next : current;
}

function zabbixInterfaceExists(actualInterfaces = [], expected = {}) {
  const expectedUseIp = Number(expected.useip ?? 1);
  const expectedAddress = expectedUseIp === 1 ? expected.ip : expected.dns;
  if (isBlank(expectedAddress)) {
    return false;
  }
  return actualInterfaces.some(item => {
    if (!isBlank(expected.type) && String(item.type) !== String(expected.type)) {
      return false;
    }
    const actualAddress = Number(item.useip ?? 1) === 1 ? item.ip : item.dns;
    return auditSameValue(actualAddress, expectedAddress);
  });
}

function zabbixCollectionContains(actualItems = [], expected = {}, idField = '') {
  const candidates = [
    expected[idField],
    idField === 'maintenanceid' ? expected.maintenanceId : null,
    expected.name,
    expected.host,
    expected.value
  ].filter(value => !isBlank(value)).map(auditComparableKey);
  return actualItems.some(item => [item[idField], idField === 'maintenanceid' ? item.maintenanceId : null, item.name, item.host, item.value]
    .filter(value => !isBlank(value))
    .map(auditComparableKey)
    .some(value => candidates.includes(value)));
}

function auditLookupItemName(item = {}) {
  return firstNonBlank(item.name, item.host, item.value, item.groupid, item.templateid, '-');
}

function formatAuditInterface(item = {}) {
  const address = Number(item.useip ?? 1) === 1 ? item.ip : item.dns;
  return [item.name, `type=${item.type ?? ''}`, address].filter(value => !isBlank(value)).join(' ');
}

function quickAuditSummary(items = [], classCount = 0, cardCount = 0) {
  const summary = {
    classes: classCount,
    cards: cardCount,
    profiles: items.length,
    ok: 0,
    warning: 0,
    error: 0
  };
  for (const item of items) {
    const severity = ['ok', 'warning', 'error'].includes(item.severity) ? item.severity : 'warning';
    summary[severity] += 1;
  }
  return summary;
}

function conversionParticipatingClasses(rules = {}, catalog = {}) {
  const result = [];
  const add = value => {
    const className = String(value ?? '').trim();
    if (!className || result.some(item => sameNormalized(item, className))) {
      return;
    }
    result.push(className);
  };

  for (const className of (rules.source?.entityClasses ?? [])) {
    add(className);
  }
  for (const field of Object.values(rules.source?.fields ?? {})) {
    const root = cmdbPathRootClass(field?.cmdbPath);
    if (root && findCmdbuildCatalogClass(catalog, root)) {
      add(root);
    }
  }
  collectClassNameConditions(rules, add);

  return result;
}

function cmdbPathRootClass(cmdbPath) {
  const first = String(cmdbPath ?? '').split('.').map(item => item.trim()).find(Boolean);
  if (!first || first.startsWith('{')) {
    return '';
  }
  return first;
}

function collectClassNameConditions(value, add) {
  if (Array.isArray(value)) {
    value.forEach(item => collectClassNameConditions(item, add));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }

  if (sameNormalized(value.field, 'className') && !isBlank(value.pattern)) {
    classNamesFromRegex(value.pattern).forEach(add);
  }
  Object.values(value).forEach(item => collectClassNameConditions(item, add));
}

function classNamesFromRegex(pattern) {
  let value = String(pattern ?? '').trim();
  value = value.replace(/^\(\?i\)/i, '');
  value = value.replace(/^\^/, '').replace(/\$$/, '');
  if (value.startsWith('(') && value.endsWith(')')) {
    value = value.slice(1, -1);
  }

  return value
    .split('|')
    .map(item => item.trim())
    .filter(item => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item));
}

function findCmdbuildCatalogClass(catalog = {}, className = '') {
  return (catalog.classes ?? []).find(item => sameNormalized(item.name, className) || sameNormalized(item.description, className));
}

function catalogAttributesForClass(catalog = {}, className = '') {
  return (catalog.attributes ?? [])
    .find(item => sameNormalized(item.className, className))
    ?.items ?? [];
}

function findCmdbuildCatalogAttribute(attributes = [], name = '') {
  return attributes.find(item => sameNormalized(item.name, name) || sameNormalized(item._id, name));
}

function defaultAuditBindingParentClass(catalog = {}) {
  const ci = findCmdbuildCatalogClass(catalog, 'CI');
  return ci?.name ?? 'Class';
}

async function createCmdbuildClass(baseUrl, credentials, parentClass, definition) {
  const body = {
    name: definition.name,
    description: definition.description ?? definition.name,
    type: 'standard',
    prototype: false,
    active: true,
    parent: stringOrDefault(parentClass, 'Class')
  };
  await cmdbuildRequest(baseUrl, '/classes?scope=service', credentials, {
    method: 'POST',
    body,
    headers: { 'CMDBuild-View': 'admin' }
  });
}

async function createCmdbuildStringAttribute(baseUrl, credentials, className, definition) {
  const body = {
    name: definition.name,
    description: definition.description ?? definition.name,
    mode: 'write',
    type: 'string',
    maxLength: clampInt(definition.maxLength, 128, 1, 1024),
    active: true,
    showInGrid: Boolean(definition.showInGrid),
    showInReducedGrid: false,
    unique: false,
    mandatory: false
  };
  await cmdbuildRequest(baseUrl, `/classes/${encodeURIComponent(className)}/attributes`, credentials, {
    method: 'POST',
    body,
    headers: { 'CMDBuild-View': 'admin' }
  });
}

function normalizeCmdbuildWebhook(item = {}) {
  const code = firstNonBlank(item.code, item._id, item.id, item.name);
  return {
    _id: firstNonBlank(item._id, item.id, code),
    id: firstNonBlank(item.id, item._id, code),
    code,
    description: item.description ?? '',
    event: item.event ?? '',
    target: item.target ?? '',
    method: String(item.method ?? 'post').toLowerCase(),
    url: item.url ?? '',
    headers: parseJsonObject(item.headers),
    body: parseJsonObject(item.body),
    language: item.language ?? '',
    active: item.active !== false,
    raw: item
  };
}

function normalizeCmdbuildWebhookPayload(item = {}) {
  const code = firstNonBlank(item.code, item._id, item.id, item.name);
  if (isBlank(code)) {
    throw httpError(400, 'invalid_webhook_payload', 'Webhook code is required.');
  }

  return {
    code,
    description: item.description ?? '',
    event: item.event ?? '',
    target: item.target ?? '',
    method: String(item.method ?? 'post').toLowerCase(),
    url: item.url ?? '',
    headers: parseJsonObject(item.headers),
    body: parseJsonObject(item.body),
    language: item.language ?? '',
    active: item.active !== false
  };
}

function parseJsonObject(value) {
  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value === 'string' && !isBlank(value)) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function firstNonBlank(...values) {
  return values.find(value => !isBlank(value)) ?? '';
}

async function resolveZabbixToken(apiEndpoint, credentials) {
  if (!isBlank(credentials.apiToken)) {
    return credentials.apiToken;
  }

  let result;
  try {
    result = await zabbixRawCall(apiEndpoint, null, {
      jsonrpc: '2.0',
      method: 'user.login',
      params: {
        username: credentials.username,
        password: credentials.password
      },
      id: 1
    });
  } catch (error) {
    if (isZabbixAuthenticationError(error)) {
      throw httpError(
        428,
        'credentials_required',
        'Zabbix credentials were rejected. Re-enter Zabbix login/password; the default dev login is case-sensitive: Admin/zabbix.',
        {
          service: 'zabbix',
          apiEndpoint
        });
    }
    throw error;
  }

  if (!result.result) {
    throw httpError(502, 'zabbix_login_failed', 'Zabbix login did not return a token.');
  }

  return result.result;
}

function isZabbixAuthenticationError(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'zabbix_api_error'
    && /incorrect user name|password|account is temporarily blocked/i.test(message);
}

function requireZabbixSessionCredentials(session) {
  session.zabbix = {
    ...(session.zabbix ?? {}),
    apiEndpoint: session.zabbix?.apiEndpoint || config.Zabbix.ApiEndpoint || ''
  };

  const configuredToken = currentZabbixApiToken(session);
  if (!isBlank(configuredToken)) {
    session.zabbix.apiToken = configuredToken;
    return session.zabbix;
  }

  if (!isBlank(session.zabbix.username) && !isBlank(session.zabbix.password)) {
    return session.zabbix;
  }

  throw httpError(428, 'credentials_required', 'Zabbix credentials are required for this operation.', {
    service: 'zabbix',
    apiEndpoint: session.zabbix.apiEndpoint || config.Zabbix.ApiEndpoint
  });
}

function requireCmdbuildSessionCredentials(session) {
  session.cmdbuild = {
    ...(session.cmdbuild ?? {}),
    baseUrl: session.cmdbuild?.baseUrl || config.Cmdbuild.BaseUrl || ''
  };

  if (!isBlank(session.cmdbuild.username) && !isBlank(session.cmdbuild.password)) {
    return session.cmdbuild;
  }

  throw httpError(428, 'credentials_required', 'CMDBuild credentials are required for this operation.', {
    service: 'cmdbuild',
    baseUrl: session.cmdbuild.baseUrl || config.Cmdbuild.BaseUrl
  });
}

function currentZabbixApiToken(session) {
  const serviceAccount = config.Zabbix.ServiceAccount ?? {};
  return [config.Zabbix.ApiToken, config.Zabbix.apiToken, serviceAccount.ApiToken, serviceAccount.apiToken]
    .find(value => !isBlank(value)) ?? '';
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

async function cmdbuildGet(baseUrl, path, credentials, headers = {}) {
  return cmdbuildRequest(baseUrl, path, credentials, { headers });
}

async function cmdbuildRequest(baseUrl, path, credentials, options = {}) {
  const authorization = !isBlank(credentials.accessToken)
    ? `Bearer ${credentials.accessToken}`
    : `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
      authorization
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw httpError(502, 'cmdbuild_api_error', `CMDBuild returned HTTP ${response.status} for ${path}.`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (isBlank(text)) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function saveIdpSettings(payload) {
  const persisted = await readPersistedUiSettings();
  const provider = normalizeIdpProvider(payload?.provider ?? configValue(config.Idp, 'Provider') ?? 'SAML2');
  const safePayload = {
    idp: {
      provider,
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
      roleMapping: normalizeRoleMappingPayload(payload?.roleMapping ?? config.Idp.RoleMapping),
      oauth2: normalizeOauth2SettingsPayload(payload?.oauth2),
      ldap: normalizeLdapSettingsPayload(payload?.ldap),
      savedAt: new Date().toISOString()
    }
  };

  Object.assign(persisted, safePayload);
  await writePersistedUiSettings(persisted);
  clearResolvedSecretReferences([
    'Idp.IdpX509Certificate',
    'Idp.SpCertificate',
    'Idp.SpPrivateKey',
    'Idp.OAuth2.ClientSecret',
    'Idp.Ldap.BindPassword'
  ]);
  applyIdpSettings(config, safePayload.idp);
  await resolveSecretReferences(config, 'monitoring-ui-api');

  return publicIdpSettings();
}

function applyIdpSettings(targetConfig, idp = {}) {
  const current = targetConfig.Idp ?? {};
  const oauth2 = normalizeOauth2SettingsPayload(idp.oauth2 ?? idp.OAuth2 ?? {}, current.OAuth2 ?? current.oauth2 ?? {});
  const ldap = normalizeLdapSettingsPayload(idp.ldap ?? idp.Ldap ?? {}, current.Ldap ?? current.ldap ?? {});
  const provider = normalizeIdpProvider(idp.provider ?? idp.Provider ?? current.Provider ?? current.provider ?? 'SAML2');

  targetConfig.Idp = {
    ...current,
    Provider: provider === 'oauth2' ? 'OAuth2' : provider === 'ldap' ? 'LDAP' : 'SAML2',
    Enabled: Boolean(idp.enabled ?? idp.Enabled),
    MetadataUrl: idp.metadataUrl ?? idp.MetadataUrl ?? current.MetadataUrl ?? current.metadataUrl ?? '',
    EntityId: idp.entityId ?? idp.EntityId ?? current.EntityId ?? current.entityId ?? '',
    SsoUrl: idp.ssoUrl ?? idp.SsoUrl ?? current.SsoUrl ?? current.ssoUrl ?? '',
    SloUrl: idp.sloUrl ?? idp.SloUrl ?? current.SloUrl ?? current.sloUrl ?? '',
    SloCallbackUrl: idp.sloCallbackUrl ?? idp.SloCallbackUrl ?? current.SloCallbackUrl ?? current.sloCallbackUrl ?? '',
    IdpX509Certificate: idp.idpX509Certificate ?? idp.IdpX509Certificate ?? current.IdpX509Certificate ?? current.idpX509Certificate ?? '',
    SpEntityId: idp.spEntityId ?? idp.SpEntityId ?? current.SpEntityId ?? current.spEntityId ?? '',
    AcsUrl: idp.acsUrl ?? idp.AcsUrl ?? current.AcsUrl ?? current.acsUrl ?? '',
    SpCertificate: idp.spCertificate ?? idp.SpCertificate ?? current.SpCertificate ?? current.spCertificate ?? '',
    SpPrivateKey: idp.spPrivateKey ?? idp.SpPrivateKey ?? current.SpPrivateKey ?? current.spPrivateKey ?? '',
    NameIdFormat: idp.nameIdFormat ?? idp.NameIdFormat ?? current.NameIdFormat ?? current.nameIdFormat ?? '',
    AuthnRequestBinding: idp.authnRequestBinding ?? idp.AuthnRequestBinding ?? current.AuthnRequestBinding ?? current.authnRequestBinding ?? 'HTTP-Redirect',
    RequireSignedAssertions: idp.requireSignedAssertions ?? idp.RequireSignedAssertions ?? current.RequireSignedAssertions ?? current.requireSignedAssertions ?? true,
    RequireSignedResponses: idp.requireSignedResponses ?? idp.RequireSignedResponses ?? current.RequireSignedResponses ?? current.requireSignedResponses ?? false,
    RequireEncryptedAssertions: idp.requireEncryptedAssertions ?? idp.RequireEncryptedAssertions ?? current.RequireEncryptedAssertions ?? current.requireEncryptedAssertions ?? false,
    ClockSkewSeconds: Number(idp.clockSkewSeconds ?? idp.ClockSkewSeconds ?? current.ClockSkewSeconds ?? current.clockSkewSeconds ?? 120),
    AttributeMapping: idp.attributeMapping ?? idp.AttributeMapping ?? current.AttributeMapping ?? current.attributeMapping ?? {},
    RoleMapping: normalizeRoleMappingPayload(idp.roleMapping ?? idp.RoleMapping ?? current.RoleMapping ?? current.roleMapping ?? {}),
    OAuth2: {
      AuthorizationUrl: oauth2.authorizationUrl,
      TokenUrl: oauth2.tokenUrl,
      UserInfoUrl: oauth2.userInfoUrl,
      ClientId: oauth2.clientId,
      ClientSecret: oauth2.clientSecret,
      RedirectUri: oauth2.redirectUri,
      Scopes: oauth2.scopes,
      LoginClaim: oauth2.loginClaim,
      EmailClaim: oauth2.emailClaim,
      DisplayNameClaim: oauth2.displayNameClaim,
      GroupsClaim: oauth2.groupsClaim
    },
    Ldap: {
      Protocol: ldap.protocol,
      Host: ldap.host,
      Port: ldap.port,
      BaseDn: ldap.baseDn,
      BindDn: ldap.bindDn,
      BindPassword: ldap.bindPassword,
      UserDnTemplate: ldap.userDnTemplate,
      UserSearchBase: ldap.userSearchBase,
      UserFilter: ldap.userFilter,
      GroupSearchBase: ldap.groupSearchBase,
      GroupFilter: ldap.groupFilter,
      GroupNameAttribute: ldap.groupNameAttribute,
      LoginAttribute: ldap.loginAttribute,
      EmailAttribute: ldap.emailAttribute,
      DisplayNameAttribute: ldap.displayNameAttribute,
      GroupsAttribute: ldap.groupsAttribute,
      TlsRejectUnauthorized: ldap.tlsRejectUnauthorized
    }
  };
  targetConfig.Auth.UseIdp = targetConfig.Idp.Enabled;
}

function normalizeOauth2SettingsPayload(payload = {}, existingSettings = null) {
  const existing = existingSettings ?? config.Idp.OAuth2 ?? config.Idp.oauth2 ?? {};
  return {
    authorizationUrl: payload.authorizationUrl ?? existing.AuthorizationUrl ?? existing.authorizationUrl ?? '',
    tokenUrl: payload.tokenUrl ?? existing.TokenUrl ?? existing.tokenUrl ?? '',
    userInfoUrl: payload.userInfoUrl ?? existing.UserInfoUrl ?? existing.userInfoUrl ?? '',
    clientId: payload.clientId ?? existing.ClientId ?? existing.clientId ?? '',
    clientSecret: isBlank(payload.clientSecret)
      ? existing.ClientSecret ?? existing.clientSecret ?? ''
      : payload.clientSecret,
    redirectUri: payload.redirectUri ?? existing.RedirectUri ?? existing.redirectUri ?? 'http://localhost:5090/auth/oauth2/callback',
    scopes: payload.scopes ?? existing.Scopes ?? existing.scopes ?? 'openid profile email',
    loginClaim: payload.loginClaim ?? existing.LoginClaim ?? existing.loginClaim ?? 'preferred_username',
    emailClaim: payload.emailClaim ?? existing.EmailClaim ?? existing.emailClaim ?? 'email',
    displayNameClaim: payload.displayNameClaim ?? existing.DisplayNameClaim ?? existing.displayNameClaim ?? 'name',
    groupsClaim: payload.groupsClaim ?? existing.GroupsClaim ?? existing.groupsClaim ?? 'groups'
  };
}

function normalizeLdapSettingsPayload(payload = {}, existingSettings = null) {
  const existing = existingSettings ?? config.Idp.Ldap ?? config.Idp.ldap ?? {};
  const protocol = normalizeLdapProtocol(payload.protocol ?? existing.Protocol ?? existing.protocol ?? 'ldap');
  const defaultPort = protocol === 'ldaps' ? 636 : 389;
  const port = Number(payload.port ?? existing.Port ?? existing.port ?? defaultPort);
  return {
    protocol,
    host: payload.host ?? existing.Host ?? existing.host ?? '',
    port: Number.isFinite(port) && port > 0 ? port : defaultPort,
    baseDn: payload.baseDn ?? existing.BaseDn ?? existing.baseDn ?? '',
    bindDn: payload.bindDn ?? existing.BindDn ?? existing.bindDn ?? '',
    bindPassword: isBlank(payload.bindPassword)
      ? existing.BindPassword ?? existing.bindPassword ?? ''
      : payload.bindPassword,
    userDnTemplate: payload.userDnTemplate ?? existing.UserDnTemplate ?? existing.userDnTemplate ?? '',
    userSearchBase: payload.userSearchBase ?? existing.UserSearchBase ?? existing.userSearchBase ?? '',
    userFilter: payload.userFilter ?? existing.UserFilter ?? existing.userFilter ?? '(|(sAMAccountName={login})(userPrincipalName={login})(uid={login}))',
    groupSearchBase: payload.groupSearchBase ?? existing.GroupSearchBase ?? existing.groupSearchBase ?? '',
    groupFilter: payload.groupFilter ?? existing.GroupFilter ?? existing.groupFilter ?? '(|(member={dn})(memberUid={login}))',
    groupNameAttribute: payload.groupNameAttribute ?? existing.GroupNameAttribute ?? existing.groupNameAttribute ?? 'cn',
    loginAttribute: payload.loginAttribute ?? existing.LoginAttribute ?? existing.loginAttribute ?? 'sAMAccountName',
    emailAttribute: payload.emailAttribute ?? existing.EmailAttribute ?? existing.emailAttribute ?? 'mail',
    displayNameAttribute: payload.displayNameAttribute ?? existing.DisplayNameAttribute ?? existing.displayNameAttribute ?? 'displayName',
    groupsAttribute: payload.groupsAttribute ?? existing.GroupsAttribute ?? existing.groupsAttribute ?? 'memberOf',
    tlsRejectUnauthorized: payload.tlsRejectUnauthorized !== false
  };
}

async function saveRuntimeSettings(payload) {
  const persisted = await readPersistedUiSettings();
  const runtime = normalizeRuntimeSettingsPayload(payload);

  delete persisted.auth;
  Object.assign(persisted, runtime);
  await writePersistedUiSettings(persisted);
  clearResolvedSecretReferences([
    'Zabbix.ApiToken',
    'Zabbix.ServiceAccount.ApiToken',
    'AuditStorage.ConnectionString',
    'EventBrowser.Password'
  ]);
  applyRuntimeSettings(config, runtime);
  await resolveSecretReferences(config, 'monitoring-ui-api');

  return publicRuntimeSettings();
}

async function publicGitSettings() {
  return {
    filePath: config.UiSettings?.FilePath ?? 'state/ui-settings.json',
    rules: publicRulesSettings(),
    status: await checkGitSettings({ rules: publicRulesSettings() })
  };
}

function publicRulesSettings() {
  const rules = config.Rules ?? {};
  return {
    rulesFilePath: rules.RulesFilePath ?? 'rules/cmdbuild-to-zabbix-host-create.json',
    readFromGit: Boolean(rules.ReadFromGit),
    repositoryUrl: rules.RepositoryUrl ?? '',
    repositoryPath: rules.RepositoryPath ?? ''
  };
}

async function saveGitSettings(payload = {}) {
  const persisted = await readPersistedUiSettings();
  const rules = normalizeRulesSettingsPayload(payload.rules ?? payload);

  delete persisted.auth;
  persisted.rules = rules;
  await writePersistedUiSettings(persisted);
  applyRuntimeSettings(config, { rules });

  return publicGitSettings();
}

async function checkGitSettings(payload = {}) {
  const rules = normalizeRulesSettingsPayload(payload.rules ?? payload);
  const result = {
    ok: false,
    readMode: rules.readFromGit ? 'git' : 'disk',
    rulesFilePath: rules.rulesFilePath,
    repositoryUrl: rules.repositoryUrl,
    repositoryPath: rules.repositoryPath,
    resolvedRepositoryPath: '',
    resolvedPath: '',
    fileExists: false,
    schemaVersion: '',
    rulesVersion: '',
    name: '',
    message: ''
  };

  try {
    const fullPath = resolveRulesStoragePath(rules);
    result.resolvedRepositoryPath = resolveRulesStorageRoot(rules);
    result.resolvedPath = fullPath;
    result.fileExists = existsSync(fullPath);
    if (!result.fileExists) {
      result.message = `Rules file does not exist: ${rules.rulesFilePath}`;
      return result;
    }

    const rulesDocument = JSON.parse(await readFile(fullPath, 'utf8'));
    result.schemaVersion = rulesDocument.schemaVersion ?? '';
    result.rulesVersion = rulesDocument.rulesVersion ?? '';
    result.name = rulesDocument.name ?? '';
    if (rules.readFromGit && isBlank(rules.repositoryUrl)) {
      result.message = 'Git mode is enabled, but repository URL is empty.';
      return result;
    }

    result.ok = true;
    result.message = rules.readFromGit
      ? 'Git settings are syntactically valid. The operator still publishes rules to git outside monitoring-ui-api.'
      : 'Disk rules file is available.';
    return result;
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
    return result;
  }
}

async function loadGitRulesCopy(payload = {}) {
  const rules = normalizeRulesSettingsPayload(payload.rules ?? payload);
  const status = await checkGitSettings({ rules });
  if (!status.fileExists) {
    return {
      ...status,
      content: null
    };
  }

  const content = JSON.parse(await readFile(status.resolvedPath, 'utf8'));
  return {
    ...status,
    content
  };
}

async function exportGitRulesCopy(payload = {}) {
  const rules = normalizeRulesSettingsPayload(payload.rules ?? payload);
  const content = payload.content ?? payload.rulesDocument ?? null;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw httpError(400, 'rules_content_required', 'Rules content is required for git export.');
  }

  const rulesPath = resolveRulesStoragePath(rules);
  await mkdir(dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');

  const webhooksPath = webhookArtifactPathForRulesPath(rulesPath);
  const webhooks = redactWebhookSecrets(payload.webhooks ?? {
    generatedAt: new Date().toISOString(),
    note: 'Webhook artifact was not supplied by the UI.'
  });
  await writeFile(webhooksPath, `${JSON.stringify(webhooks, null, 2)}\n`, 'utf8');

  return {
    ...(await checkGitSettings({ rules })),
    written: {
      rulesPath,
      webhooksPath
    },
    note: 'Files were written to the configured local copy. Commit and push are intentionally not performed by monitoring-ui-api.'
  };
}

function normalizeRuntimeSettingsPayload(payload = {}) {
  const cmdbuild = payload.cmdbuild ?? {};
  const zabbix = payload.zabbix ?? {};
  const auditStorage = payload.auditStorage ?? {};
  const currentMaxTraversalDepth = cmdbuildTraversalMaxDepth(config.Cmdbuild?.Catalog?.MaxTraversalDepth);
  const result = {
    cmdbuild: {
      baseUrl: cmdbuild.baseUrl ?? '',
      maxTraversalDepth: cmdbuildTraversalMaxDepth(cmdbuild.maxTraversalDepth ?? currentMaxTraversalDepth)
    },
    zabbix: {
      apiEndpoint: zabbix.apiEndpoint ?? '',
      apiToken: zabbix.apiToken ?? zabbix.serviceAccount?.apiToken ?? '',
      allowDynamicTagsFromCmdbLeaf: booleanSettingOrDefault(
        zabbix,
        'allowDynamicTagsFromCmdbLeaf',
        Boolean(config.Zabbix.AllowDynamicTagsFromCmdbLeaf)),
      allowDynamicHostGroupsFromCmdbLeaf: booleanSettingOrDefault(
        zabbix,
        'allowDynamicHostGroupsFromCmdbLeaf',
        Boolean(config.Zabbix.AllowDynamicHostGroupsFromCmdbLeaf))
    },
    auditStorage: normalizeAuditStorageSettingsPayload(auditStorage, config.AuditStorage ?? {}),
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
  if (payload.rules !== undefined) {
    result.rules = normalizeRulesSettingsPayload(payload.rules);
  }
  return result;
}

function normalizeAuditStorageSettingsPayload(auditStorage = {}, current = {}) {
  const provider = normalizeAuditStorageProvider(
    auditStorage.provider ?? auditStorage.Provider ?? current.Provider ?? current.provider ?? 'sqlite');
  return {
    provider,
    connectionString: auditStorage.connectionString
      ?? auditStorage.ConnectionString
      ?? current.ConnectionString
      ?? current.connectionString
      ?? '',
    schema: provider === 'sqlite'
      ? ''
      : String(auditStorage.schema ?? auditStorage.Schema ?? current.Schema ?? current.schema ?? 'public').trim(),
    autoMigrate: booleanSettingOrDefault(
      auditStorage,
      'autoMigrate',
      current.AutoMigrate ?? current.autoMigrate ?? false),
    commandTimeoutSeconds: clampInt(
      auditStorage.commandTimeoutSeconds ?? auditStorage.CommandTimeoutSeconds,
      current.CommandTimeoutSeconds ?? current.commandTimeoutSeconds ?? 30,
      1,
      300)
  };
}

function normalizeAuditStorageProvider(value) {
  const normalized = String(value ?? 'sqlite').trim().toLowerCase();
  if (['postgres', 'postgresql', 'pgsql'].includes(normalized)) {
    return 'postgresql';
  }

  return 'sqlite';
}

function normalizeRulesSettingsPayload(rules = {}) {
  return {
    rulesFilePath: stringOrDefault(rules.rulesFilePath, config.Rules?.RulesFilePath ?? 'rules/cmdbuild-to-zabbix-host-create.json'),
    readFromGit: Boolean(rules.readFromGit),
    repositoryUrl: rules.repositoryUrl ?? '',
    repositoryPath: stringOrDefault(rules.repositoryPath, config.Rules?.RepositoryPath ?? '')
  };
}

function resolveRulesStorageRoot(rules) {
  if (!rules.readFromGit || isBlank(rules.repositoryPath)) {
    return repositoryRoot;
  }

  return resolveRepoPath(rules.repositoryPath);
}

function resolveRulesStoragePath(rules) {
  const root = resolveRulesStorageRoot(rules);
  const fullPath = resolve(root, rules.rulesFilePath);
  if (!isPathInside(root, fullPath)) {
    throw httpError(400, 'invalid_rules_path', 'Rules file path escapes configured storage root.');
  }

  return fullPath;
}

function webhookArtifactPathForRulesPath(rulesPath) {
  const extension = extname(rulesPath) || '.json';
  return join(dirname(rulesPath), `${basename(rulesPath, extension)}.webhooks.json`);
}

function redactWebhookSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactWebhookSecrets);
  }
  if (!value || typeof value !== 'object') {
    return redactSecretString(value);
  }

  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    isSecretKey(key) ? 'XXXXX' : redactWebhookSecrets(nested)
  ]));
}

function redactSecretString(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/Bearer\s+[-._~+/=A-Za-z0-9]+/gi, 'Bearer XXXXX');
}

function isSecretKey(key) {
  const normalized = normalizeToken(key);
  return normalized.includes('authorization')
    || normalized.includes('token')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('apikey');
}

function applyRuntimeSettings(target, persisted = {}) {
  if (persisted.cmdbuild) {
    target.Cmdbuild ??= {};
    target.Cmdbuild.Catalog ??= {};
    target.Cmdbuild.BaseUrl = persisted.cmdbuild.baseUrl ?? target.Cmdbuild.BaseUrl;
    target.Cmdbuild.Catalog.MaxTraversalDepth = cmdbuildTraversalMaxDepth(
      persisted.cmdbuild.maxTraversalDepth ?? target.Cmdbuild.Catalog.MaxTraversalDepth);
    delete target.Cmdbuild.UseIdp;
    delete target.Cmdbuild.ServiceAccount;
  }

  if (persisted.zabbix) {
    target.Zabbix.ApiEndpoint = persisted.zabbix.apiEndpoint ?? target.Zabbix.ApiEndpoint;
    target.Zabbix.ApiToken = persisted.zabbix.apiToken
      ?? persisted.zabbix.serviceAccount?.apiToken
      ?? target.Zabbix.ApiToken
      ?? target.Zabbix.ServiceAccount?.ApiToken
      ?? '';
    target.Zabbix.AllowDynamicTagsFromCmdbLeaf = booleanSettingOrDefault(
      persisted.zabbix,
      'allowDynamicTagsFromCmdbLeaf',
      target.Zabbix.AllowDynamicTagsFromCmdbLeaf);
    target.Zabbix.AllowDynamicHostGroupsFromCmdbLeaf = booleanSettingOrDefault(
      persisted.zabbix,
      'allowDynamicHostGroupsFromCmdbLeaf',
      target.Zabbix.AllowDynamicHostGroupsFromCmdbLeaf);
    delete target.Zabbix.UseIdp;
    delete target.Zabbix.ServiceAccount;
  }

  if (persisted.rules) {
    target.Rules ??= {};
    target.Rules.RulesFilePath = stringOrDefault(
      persisted.rules.rulesFilePath,
      target.Rules.RulesFilePath ?? 'rules/cmdbuild-to-zabbix-host-create.json');
    target.Rules.ReadFromGit = Boolean(persisted.rules.readFromGit);
    target.Rules.RepositoryUrl = persisted.rules.repositoryUrl ?? target.Rules.RepositoryUrl ?? '';
    target.Rules.RepositoryPath = persisted.rules.repositoryPath ?? target.Rules.RepositoryPath ?? '';
  }

  if (persisted.auditStorage) {
    const auditStorage = normalizeAuditStorageSettingsPayload(persisted.auditStorage, target.AuditStorage ?? {});
    target.AuditStorage = {
      ...(target.AuditStorage ?? {}),
      Provider: auditStorage.provider,
      ConnectionString: auditStorage.connectionString,
      Schema: auditStorage.schema,
      AutoMigrate: auditStorage.autoMigrate,
      CommandTimeoutSeconds: auditStorage.commandTimeoutSeconds
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

async function createSamlSession(profile) {
  const identity = await enrichIdentityWithLdapGroups(samlIdentityFromProfile(profile));
  const roles = rolesFromSamlGroups(identity.groups);
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
    cmdbuild: buildLocalCmdbuildSessionCredentials(),
    zabbix: buildLocalZabbixSessionCredentials()
  };

  return session;
}

async function createOauth2Session(claims, tokenSet) {
  const settings = resolveOauth2Settings();
  const identity = {
    login: firstClaimValue(claims, [settings.loginClaim, 'preferred_username', 'upn', 'email', 'sub']) ?? '',
    email: firstClaimValue(claims, [settings.emailClaim, 'email', 'mail']) ?? '',
    displayName: firstClaimValue(claims, [settings.displayNameClaim, 'name', 'displayName', 'cn']) ?? '',
    groups: normalizeStringArray(firstClaimRawValue(claims, [settings.groupsClaim, 'groups', 'roles', 'memberOf']))
  };
  identity.displayName ||= identity.login;
  const identityWithGroups = await enrichIdentityWithLdapGroups(identity);

  return {
    id: randomUUID(),
    authMethod: 'oauth2',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    roles: rolesFromSamlGroups(identityWithGroups.groups),
    identity: identityWithGroups,
    oauth2: {
      accessToken: tokenSet.access_token ?? '',
      refreshToken: tokenSet.refresh_token ?? '',
      tokenType: tokenSet.token_type ?? 'Bearer',
      expiresAt: tokenSet.expires_in ? new Date(Date.now() + Number(tokenSet.expires_in) * 1000).toISOString() : ''
    },
    cmdbuild: buildLocalCmdbuildSessionCredentials(),
    zabbix: buildLocalZabbixSessionCredentials()
  };
}

async function loginWithLdap(payload) {
  const username = String(payload?.username ?? '').trim();
  const password = String(payload?.password ?? '');
  if (isBlank(username) || isBlank(password)) {
    throw httpError(400, 'missing_ldap_credentials', 'AD/LDAP username and password are required.');
  }

  const identity = await authenticateLdapUser(username, password);
  return {
    id: randomUUID(),
    authMethod: 'ldap',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    roles: rolesFromSamlGroups(identity.groups),
    identity,
    cmdbuild: buildLocalCmdbuildSessionCredentials(),
    zabbix: buildLocalZabbixSessionCredentials()
  };
}

async function enrichIdentityWithLdapGroups(identity) {
  const login = String(identity?.login ?? '').trim();
  if (isBlank(login)) {
    return identity;
  }

  const settings = normalizeLdapSettingsPayload(config.Idp.Ldap ?? config.Idp.ldap ?? {});
  if (!isLdapGroupLookupConfigured(settings)) {
    return identity;
  }

  const groups = await readLdapGroupsForIdentity(login, settings);
  return {
    ...identity,
    groups
  };
}

function isLdapGroupLookupConfigured(settings) {
  return !isBlank(settings.host)
    && !isBlank(settings.userSearchBase || settings.baseDn)
    && !isBlank(settings.groupSearchBase || settings.baseDn)
    && !isBlank(settings.bindDn)
    && !isBlank(settings.bindPassword);
}

async function readLdapGroupsForIdentity(username, settings) {
  const client = new LdapClient({
    url: `${settings.protocol}://${settings.host}:${settings.port}`,
    timeout: 10000,
    connectTimeout: 10000,
    tlsOptions: {
      rejectUnauthorized: settings.tlsRejectUnauthorized
    }
  });

  try {
    await client.bind(settings.bindDn, settings.bindPassword);
    const userEntry = await findLdapUser(client, settings, username);
    const userDn = ldapEntryDn(userEntry) || renderTemplate(settings.userDnTemplate, { login: username });
    return await readLdapGroups(client, settings, userEntry, username, userDn);
  } finally {
    try {
      await client.unbind();
    } catch {
      // ignore LDAP disconnect errors
    }
  }
}

function buildLocalCmdbuildSessionCredentials() {
  return {
    baseUrl: config.Cmdbuild.BaseUrl ?? '',
    username: '',
    password: ''
  };
}

function buildLocalZabbixSessionCredentials() {
  return {
    apiEndpoint: config.Zabbix.ApiEndpoint ?? '',
    username: '',
    password: '',
    apiToken: config.Zabbix.ApiToken ?? config.Zabbix.apiToken ?? config.Zabbix.ServiceAccount?.ApiToken ?? config.Zabbix.ServiceAccount?.apiToken ?? ''
  };
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
  const roleMapping = normalizeRoleMappingPayload(config.Idp.RoleMapping ?? config.Idp.roleMapping ?? {});
  const roles = new Set();
  for (const [role, expectedGroups] of Object.entries(roleMapping)) {
    for (const expectedGroup of normalizeStringArray(expectedGroups)) {
      if (normalizedGroups.has(expectedGroup.toLowerCase())) {
        roles.add(normalizeRoleKey(role));
      }
    }
  }

  if (roles.size === 0) {
    roles.add('viewer');
  }

  return [...roles].sort();
}

async function exchangeOauth2Code(code) {
  const settings = resolveOauth2Settings();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId
  });
  if (!isBlank(settings.clientSecret)) {
    body.set('client_secret', settings.clientSecret);
  }

  const response = await fetch(settings.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body,
    signal: AbortSignal.timeout(10000)
  });
  const payload = await safeJson(response);
  if (!response.ok || !payload?.access_token) {
    throw httpError(502, 'oauth2_token_error', payload?.error_description || payload?.error || `OAuth2 token endpoint returned HTTP ${response.status}.`);
  }

  return payload;
}

async function readOauth2UserInfo(tokenSet) {
  const settings = resolveOauth2Settings();
  if (isBlank(settings.userInfoUrl)) {
    return decodeJwtPayload(tokenSet.id_token) ?? {};
  }

  const response = await fetch(settings.userInfoUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${tokenSet.access_token}`
    },
    signal: AbortSignal.timeout(10000)
  });
  const payload = await safeJson(response);
  if (!response.ok || !payload) {
    throw httpError(502, 'oauth2_userinfo_error', payload?.error_description || payload?.error || `OAuth2 userinfo endpoint returned HTTP ${response.status}.`);
  }

  return payload;
}

async function authenticateLdapUser(username, password) {
  const settings = resolveLdapSettings();
  const client = new LdapClient({
    url: `${settings.protocol}://${settings.host}:${settings.port}`,
    timeout: 10000,
    connectTimeout: 10000,
    tlsOptions: {
      rejectUnauthorized: settings.tlsRejectUnauthorized
    }
  });

  try {
    const serviceBound = !isBlank(settings.bindDn) && !isBlank(settings.bindPassword);
    if (serviceBound) {
      await client.bind(settings.bindDn, settings.bindPassword);
    }

    const userEntry = serviceBound
      ? await findLdapUser(client, settings, username)
      : await bindAndFindUserWithoutServiceAccount(client, settings, username, password);
    const userDn = ldapEntryDn(userEntry) || renderTemplate(settings.userDnTemplate, { login: username });

    if (serviceBound) {
      await client.bind(userDn, password);
      await client.bind(settings.bindDn, settings.bindPassword);
    }

    const groups = await readLdapGroups(client, settings, userEntry, username, userDn);
    return {
      login: ldapFirstValue(userEntry[settings.loginAttribute]) || username,
      email: ldapFirstValue(userEntry[settings.emailAttribute]) || '',
      displayName: ldapFirstValue(userEntry[settings.displayNameAttribute]) || username,
      groups
    };
  } finally {
    try {
      await client.unbind();
    } catch {
      // ignore LDAP disconnect errors
    }
  }
}

async function bindAndFindUserWithoutServiceAccount(client, settings, username, password) {
  if (isBlank(settings.userDnTemplate)) {
    throw httpError(400, 'ldap_bind_dn_required', 'LDAP bindDn/bindPassword or userDnTemplate is required.');
  }

  const userDn = renderTemplate(settings.userDnTemplate, { login: username });
  await client.bind(userDn, password);
  return await findLdapUser(client, settings, username, userDn);
}

async function findLdapUser(client, settings, username, knownDn = '') {
  const searchBase = settings.userSearchBase || settings.baseDn;
  if (isBlank(searchBase)) {
    throw httpError(400, 'ldap_base_dn_required', 'LDAP base DN is required.');
  }

  const filter = renderTemplate(settings.userFilter, {
    login: ldapEscape(username),
    dn: ldapEscape(knownDn)
  });
  const result = await client.search(searchBase, {
    scope: 'sub',
    filter,
    attributes: [
      settings.loginAttribute,
      settings.emailAttribute,
      settings.displayNameAttribute,
      settings.groupsAttribute,
      'dn',
      'distinguishedName',
      'memberOf',
      'cn'
    ]
  });
  const user = result.searchEntries?.[0];
  if (!user) {
    throw httpError(401, 'ldap_user_not_found', 'LDAP user was not found.');
  }

  return user;
}

async function readLdapGroups(client, settings, userEntry, username, userDn) {
  const directGroups = normalizeStringArray(userEntry[settings.groupsAttribute] ?? userEntry.memberOf);
  const searchBase = settings.groupSearchBase || settings.baseDn;
  if (isBlank(searchBase) || isBlank(settings.groupFilter)) {
    return directGroups;
  }

  const filter = renderTemplate(settings.groupFilter, {
    login: ldapEscape(username),
    dn: ldapEscape(userDn)
  });
  const result = await client.search(searchBase, {
    scope: 'sub',
    filter,
    attributes: [settings.groupNameAttribute, 'cn', 'distinguishedName']
  });

  const searchGroups = (result.searchEntries ?? [])
    .flatMap(entry => [
      ldapFirstValue(entry[settings.groupNameAttribute]),
      ldapFirstValue(entry.cn),
      ldapFirstValue(entry.distinguishedName),
      ldapEntryDn(entry)
    ])
    .filter(Boolean);

  return [...new Set([...directGroups, ...searchGroups])];
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
  const oauth2 = normalizeOauth2SettingsPayload(config.Idp.OAuth2 ?? config.Idp.oauth2 ?? {});
  const ldap = normalizeLdapSettingsPayload(config.Idp.Ldap ?? config.Idp.ldap ?? {});
  return {
    provider: idpProvider(),
    enabled: isIdpEnabled(),
    metadataUrl: configValue(config.Idp, 'MetadataUrl'),
    entityId: configValue(config.Idp, 'EntityId'),
    ssoUrl: configValue(config.Idp, 'SsoUrl'),
    sloUrl: configValue(config.Idp, 'SloUrl'),
    spEntityId: configValue(config.Idp, 'SpEntityId'),
    acsUrl: configValue(config.Idp, 'AcsUrl'),
    sloCallbackUrl: configValue(config.Idp, 'SloCallbackUrl'),
    metadataRoute: '/auth/saml2/metadata',
    loginRoute: idpLoginRoute(),
    logoutRoute: '/auth/saml2/logout',
    nameIdFormat: configValue(config.Idp, 'NameIdFormat'),
    authnRequestBinding: configValue(config.Idp, 'AuthnRequestBinding'),
    requireSignedAssertions: Boolean(config.Idp.RequireSignedAssertions ?? config.Idp.requireSignedAssertions),
    requireSignedResponses: Boolean(config.Idp.RequireSignedResponses ?? config.Idp.requireSignedResponses ?? false),
    requireEncryptedAssertions: Boolean(config.Idp.RequireEncryptedAssertions ?? config.Idp.requireEncryptedAssertions),
    clockSkewSeconds: Number(config.Idp.ClockSkewSeconds ?? config.Idp.clockSkewSeconds ?? 120),
    attributeMapping: config.Idp.AttributeMapping || config.Idp.attributeMapping || {},
    roleMapping: normalizeRoleMappingPayload(config.Idp.RoleMapping || config.Idp.roleMapping || {}),
    oauth2: {
      ...oauth2,
      clientSecret: ''
    },
    ldap: {
      ...ldap,
      bindPassword: ''
    },
    secretsConfigured: {
      idpX509Certificate: !isBlank(configValue(config.Idp, 'IdpX509Certificate') || configValue(config.Idp, 'IdpX509CertificatePath')),
      spCertificate: !isBlank(configValue(config.Idp, 'SpCertificate') || configValue(config.Idp, 'SpCertificatePath')),
      spPrivateKey: !isBlank(configValue(config.Idp, 'SpPrivateKey') || configValue(config.Idp, 'SpPrivateKeyPath')),
      oauth2ClientSecret: !isBlank(oauth2.clientSecret),
      ldapBindPassword: !isBlank(ldap.bindPassword)
    }
  };
}

function publicRoles() {
  return Object.values(roles).map(role => ({
    key: role.key,
    label: role.label,
    views: role.views
  }));
}

function publicUsersFilePath() {
  return relative(serviceRoot, resolveUsersFile(config)) || basename(resolveUsersFile(config));
}

function publicStoredUser(user) {
  const role = roles[normalizeRoleKey(user.role)] ?? roles.viewer;
  return {
    username: user.username,
    displayName: user.displayName,
    role: role.key,
    roleLabel: role.label,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function normalizeRoleKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (roles[normalized]) {
    return normalized;
  }

  for (const role of Object.values(roles)) {
    if (role.legacy.includes(normalized)) {
      return role.key;
    }
  }

  return 'viewer';
}

function publicRuntimeSettings() {
  const eventBrowser = config.EventBrowser ?? {};
  const rules = config.Rules ?? {};
  const auditStorage = normalizeAuditStorageSettingsPayload(config.AuditStorage ?? {}, config.AuditStorage ?? {});
  auditStorage.connectionString = secretDisplayValue('AuditStorage.ConnectionString', auditStorage.connectionString);

  return {
    filePath: config.UiSettings?.FilePath ?? 'state/ui-settings.json',
    usersFilePath: publicUsersFilePath(),
    cmdbuild: {
      baseUrl: config.Cmdbuild.BaseUrl ?? '',
      maxTraversalDepth: cmdbuildTraversalMaxDepth(config.Cmdbuild?.Catalog?.MaxTraversalDepth)
    },
    zabbix: {
      apiEndpoint: config.Zabbix.ApiEndpoint ?? '',
      apiToken: secretDisplayValue(
        ['Zabbix.ApiToken', 'Zabbix.ServiceAccount.ApiToken'],
        currentZabbixApiToken(null)),
      allowDynamicTagsFromCmdbLeaf: Boolean(config.Zabbix.AllowDynamicTagsFromCmdbLeaf),
      allowDynamicHostGroupsFromCmdbLeaf: Boolean(config.Zabbix.AllowDynamicHostGroupsFromCmdbLeaf)
    },
    rules: {
      rulesFilePath: rules.RulesFilePath ?? 'rules/cmdbuild-to-zabbix-host-create.json',
      readFromGit: Boolean(rules.ReadFromGit),
      repositoryUrl: rules.RepositoryUrl ?? ''
    },
    auditStorage,
    eventBrowser: {
      enabled: Boolean(eventBrowser.Enabled),
      bootstrapServers: eventBrowser.BootstrapServers ?? '',
      clientId: eventBrowser.ClientId ?? '',
      securityProtocol: eventBrowser.SecurityProtocol ?? 'Plaintext',
      saslMechanism: eventBrowser.SaslMechanism ?? '',
      username: eventBrowser.Username ?? '',
      password: secretDisplayValue('EventBrowser.Password', eventBrowser.Password ?? ''),
      sslRejectUnauthorized: eventBrowser.SslRejectUnauthorized !== false,
      maxMessages: eventBrowser.MaxMessages ?? 50,
      readTimeoutMs: eventBrowser.ReadTimeoutMs ?? 2500,
      topics: publicEventTopics()
    }
  };
}

function secretDisplayValue(path, fallback) {
  const paths = Array.isArray(path) ? path : [path];
  for (const item of paths) {
    if (resolvedSecretReferences.has(item)) {
      return resolvedSecretReferences.get(item);
    }
  }

  return fallback ?? '';
}

function clearResolvedSecretReferences(paths) {
  for (const path of paths) {
    resolvedSecretReferences.delete(path);
  }
}

function publicRuntimeCapabilities() {
  return {
    zabbix: {
      allowDynamicTagsFromCmdbLeaf: Boolean(config.Zabbix.AllowDynamicTagsFromCmdbLeaf),
      allowDynamicHostGroupsFromCmdbLeaf: Boolean(config.Zabbix.AllowDynamicHostGroupsFromCmdbLeaf)
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

function resolveLookupFieldsFromCatalog(source, rules = null, catalog = null) {
  if (!rules?.source?.fields || !Array.isArray(catalog?.lookups) || catalog.lookups.length === 0) {
    return source;
  }

  const resolved = { ...source };
  for (const [fieldName, fieldRule] of Object.entries(rules.source.fields)) {
    if (!isLookupSourceRule(fieldRule)) {
      continue;
    }

    const rawValue = readSourceField(resolved, fieldName);
    if (isBlank(rawValue)) {
      continue;
    }

    const lookupType = fieldRule.resolve?.lookupType ?? fieldRule.lookupType;
    const resolvedValue = resolveLookupValueFromCatalog(
      catalog,
      lookupType,
      rawValue,
      fieldRule.resolve?.valueMode ?? 'code');
    if (isBlank(resolvedValue)) {
      continue;
    }

    resolved[fieldName] = resolvedValue;
    const canonical = canonicalSourceField(fieldName);
    resolved[canonical] = resolvedValue;
    if (canonical === 'os') {
      resolved.OS = resolvedValue;
    }
    if (canonical === 'zabbixTag') {
      resolved.zabbixTag = resolvedValue;
    }
  }

  return resolved;
}

function isLookupSourceRule(fieldRule = {}) {
  return equalsIgnoreCase(fieldRule.type, 'lookup')
    || equalsIgnoreCase(fieldRule.resolve?.leafType, 'lookup')
    || !isBlank(fieldRule.lookupType)
    || !isBlank(fieldRule.resolve?.lookupType);
}

function resolveLookupValueFromCatalog(catalog, lookupType, rawValue, valueMode = 'code') {
  if (isBlank(lookupType)) {
    return rawValue;
  }

  const lookup = (catalog.lookups ?? []).find(item => equalsIgnoreCase(item.name, lookupType) || equalsIgnoreCase(item._id, lookupType));
  const values = normalizeCmdbuildList(lookup?.values ?? []);
  const match = values.find(item => [item._id, item.id, item.code, item.description, item._description_translation]
    .some(value => equalsIgnoreCase(value, rawValue)));
  if (!match) {
    return rawValue;
  }

  const id = match._id ?? match.id;
  return String(valueMode).toLowerCase() === 'id'
    ? id
    : String(valueMode).toLowerCase() === 'description'
      ? (match.description ?? match.code ?? id)
      : String(valueMode).toLowerCase() === 'translation'
        ? (match._description_translation ?? match.description ?? match.code ?? id)
        : (match.code ?? match.description ?? id);
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
    profileipaddress: source.profileIpAddress ?? source.profile,
    profile: source.profileIpAddress ?? source.profile,
    profile2ipaddress: source.profile2IpAddress ?? source.profile2,
    profile2: source.profile2IpAddress ?? source.profile2,
    interfaceipaddress: source.interfaceIpAddress ?? source.interface,
    interface: source.interfaceIpAddress ?? source.interface,
    interface2ipaddress: source.interface2IpAddress ?? source.interface2,
    interface2: source.interface2IpAddress ?? source.interface2,
    dnsname: source.dnsName ?? source.dns_name,
    dns_name: source.dnsName ?? source.dns_name,
    fqdn: source.dnsName ?? source.dns_name,
    hostname: source.dnsName ?? source.dns_name,
    host_dns: source.dnsName ?? source.dns_name,
    profilednsname: source.profileDnsName ?? source.profile_dns,
    profiledns: source.profileDnsName ?? source.profile_dns,
    profile_dns: source.profileDnsName ?? source.profile_dns,
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
    profileipaddress: 'profileIpAddress',
    profile: 'profileIpAddress',
    profile2ipaddress: 'profile2IpAddress',
    profile2: 'profile2IpAddress',
    interfaceipaddress: 'interfaceIpAddress',
    interface: 'interfaceIpAddress',
    interface2ipaddress: 'interface2IpAddress',
    interface2: 'interface2IpAddress',
    dnsname: 'dnsName',
    fqdn: 'dnsName',
    hostname: 'dnsName',
    hostdns: 'dnsName',
    profilednsname: 'profileDnsName',
    profiledns: 'profileDnsName',
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
  const normalizedAllowed = allowedRoles.map(normalizeRoleKey);
  const normalizedSessionRoles = (session.roles ?? []).map(normalizeRoleKey);
  if (!normalizedAllowed.some(role => normalizedSessionRoles.includes(role))) {
    sendJson(response, 403, {
      error: 'forbidden'
    });
  }
}

function publicUser(session) {
  const primaryRole = normalizeRoleKey(session.roles?.[0]);
  const role = roles[primaryRole] ?? roles.viewer;
  return {
    authMethod: session.authMethod ?? 'local',
    role: role.key,
    roleLabel: role.label,
    roles: (session.roles ?? []).map(normalizeRoleKey),
    passwordChangeRequired: Boolean(session.passwordChangeRequired),
    createdAt: session.createdAt,
    identity: session.identity ? {
      login: session.identity.login,
      email: session.identity.email,
      displayName: session.identity.displayName,
      groups: session.identity.groups
    } : null,
    cmdbuild: {
      baseUrl: session.cmdbuild?.baseUrl ?? config.Cmdbuild.BaseUrl ?? '',
      username: session.cmdbuild?.username ?? '',
      credentialsConfigured: !isBlank(session.cmdbuild?.username) && !isBlank(session.cmdbuild?.password)
    },
    zabbix: {
      apiEndpoint: session.zabbix?.apiEndpoint ?? config.Zabbix.ApiEndpoint ?? '',
      username: session.zabbix?.username ?? '',
      apiTokenConfigured: !isBlank(currentZabbixApiToken(session))
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

  const withDefaults = {
    ...catalog,
    inventoryFields: catalog.inventoryFields ?? zabbixInventoryFields(),
    interfaceProfiles: catalog.interfaceProfiles ?? zabbixInterfaceProfiles(),
    hostStatuses: catalog.hostStatuses ?? zabbixHostStatuses(),
    tlsPskModes: catalog.tlsPskModes ?? zabbixTlsPskModes()
  };
  withDefaults.templateCompatibility ??= buildZabbixTemplateCompatibility(withDefaults);
  return withDefaults;
}

function readZabbixMetadata(catalog) {
  const normalized = withCatalogDefaults(catalog) ?? {};
  const templates = normalizeZabbixTemplateMetadata(normalized.templates ?? []);
  const hosts = normalizeZabbixHostTemplateMetadata(normalized.hosts ?? []);
  const compatibility = normalized.templateCompatibility ?? buildZabbixTemplateCompatibility(normalized);
  return {
    syncedAt: normalized.syncedAt ?? null,
    zabbixEndpoint: normalized.zabbixEndpoint ?? null,
    zabbixVersion: normalized.zabbixVersion ?? '',
    templateCount: templates.length,
    hostCount: hosts.length,
    hostGroupCount: Array.isArray(normalized.hostGroups) ? normalized.hostGroups.length : 0,
    conflictCount: compatibility.conflicts?.length ?? 0,
    templates,
    hosts,
    conflicts: compatibility.conflicts ?? [],
    indexes: compatibility.indexes ?? {}
  };
}

function buildZabbixTemplateCompatibility(catalog = {}) {
  const templates = normalizeZabbixTemplateMetadata(catalog.templates ?? []);
  const conflicts = [
    ...duplicateTemplateMetadataConflicts(templates, 'itemKey', template => template.itemKeys),
    ...duplicateTemplateMetadataConflicts(templates, 'discoveryRuleKey', template => template.discoveryRuleKeys),
    ...duplicateTemplateInventoryConflicts(templates)
  ].sort((left, right) => compareText(left.type, right.type) || compareText(left.key, right.key));

  return {
    generatedAt: new Date().toISOString(),
    conflicts,
    indexes: {
      templatesByItemKey: metadataIndexByTemplateKeys(templates, template => template.itemKeys),
      templatesByDiscoveryRuleKey: metadataIndexByTemplateKeys(templates, template => template.discoveryRuleKeys),
      templatesByInventoryLink: metadataIndexByTemplateInventory(templates)
    }
  };
}

function normalizeZabbixTemplateMetadata(templates) {
  return (Array.isArray(templates) ? templates : [])
    .map(template => {
      const itemInfos = normalizeZabbixItems(template.items);
      return {
        templateid: template.templateid ?? '',
        host: template.host ?? '',
        name: template.name ?? template.host ?? template.templateid ?? '',
        groups: template.templategroups ?? template.groups ?? [],
        parentTemplates: template.parentTemplates ?? [],
        itemKeys: uniqueStrings(itemInfos.map(item => item.key)),
        discoveryRuleKeys: uniqueStrings(normalizeZabbixItems(template.discoveryRules).map(item => item.key)),
        inventoryLinks: itemInfos
          .filter(item => !isBlank(item.inventoryLink) && item.inventoryLink !== '0')
          .map(item => ({
            inventoryLink: item.inventoryLink,
            itemKey: item.key,
            itemName: item.name
          }))
      };
    })
    .filter(template => !isBlank(template.templateid));
}

function normalizeZabbixItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      key: item.key_ ?? item.key ?? '',
      name: item.name ?? '',
      inventoryLink: String(item.inventory_link ?? item.inventoryLink ?? '0')
    }))
    .filter(item => !isBlank(item.key));
}

function normalizeZabbixHostTemplateMetadata(hosts) {
  return (Array.isArray(hosts) ? hosts : [])
    .map(host => ({
      hostid: host.hostid ?? '',
      host: host.host ?? '',
      name: host.name ?? host.host ?? host.hostid ?? '',
      parentTemplates: (host.parentTemplates ?? []).map(templateConflictOwner)
    }))
    .filter(host => !isBlank(host.hostid));
}

function duplicateTemplateMetadataConflicts(templates, type, keySelector) {
  const ownersByKey = new Map();
  for (const template of templates) {
    for (const key of keySelector(template)) {
      if (isBlank(key)) {
        continue;
      }
      const owners = ownersByKey.get(key) ?? [];
      owners.push(templateConflictOwner(template));
      ownersByKey.set(key, owners);
    }
  }

  return [...ownersByKey.entries()]
    .filter(([, owners]) => uniqueStrings(owners.map(owner => owner.templateid)).length > 1)
    .map(([key, owners]) => ({
      type,
      key,
      templates: uniqueTemplateOwners(owners),
      message: templateConflictMessage(type, key, owners)
    }));
}

function duplicateTemplateInventoryConflicts(templates) {
  const ownersByInventoryLink = new Map();
  for (const template of templates) {
    for (const link of template.inventoryLinks ?? []) {
      const owners = ownersByInventoryLink.get(link.inventoryLink) ?? [];
      owners.push({
        ...templateConflictOwner(template),
        itemKey: link.itemKey,
        itemName: link.itemName
      });
      ownersByInventoryLink.set(link.inventoryLink, owners);
    }
  }

  return [...ownersByInventoryLink.entries()]
    .filter(([, owners]) => uniqueStrings(owners.map(owner => owner.templateid)).length > 1)
    .map(([key, owners]) => ({
      type: 'inventoryLink',
      key,
      templates: uniqueTemplateOwners(owners),
      items: owners.map(owner => ({
        templateid: owner.templateid,
        templateName: owner.name,
        itemKey: owner.itemKey,
        itemName: owner.itemName
      })),
      message: templateConflictMessage('inventoryLink', key, owners)
    }));
}

function templateConflictOwner(template) {
  return {
    templateid: template.templateid,
    name: template.name || template.host || template.templateid,
    host: template.host
  };
}

function uniqueTemplateOwners(owners) {
  const seen = new Set();
  const result = [];
  for (const owner of owners) {
    const key = normalizeToken(owner.templateid);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      templateid: owner.templateid,
      name: owner.name,
      host: owner.host
    });
  }
  return result;
}

function templateConflictMessage(type, key, owners) {
  const names = uniqueTemplateOwners(owners)
    .map(owner => `${owner.name || owner.host || owner.templateid} (${owner.templateid})`)
    .join(', ');
  const label = {
    itemKey: 'duplicate item key',
    discoveryRuleKey: 'duplicate LLD rule key',
    inventoryLink: 'duplicate inventory link'
  }[type] ?? type;
  return `${label} ${key}: ${names}`;
}

function metadataIndexByTemplateKeys(templates, keySelector) {
  const index = {};
  for (const template of templates) {
    for (const key of keySelector(template)) {
      if (isBlank(key)) {
        continue;
      }
      index[key] ??= [];
      index[key].push(templateConflictOwner(template));
    }
  }
  return index;
}

function metadataIndexByTemplateInventory(templates) {
  const index = {};
  for (const template of templates) {
    for (const link of template.inventoryLinks ?? []) {
      if (isBlank(link.inventoryLink)) {
        continue;
      }
      index[link.inventoryLink] ??= [];
      index[link.inventoryLink].push({
        ...templateConflictOwner(template),
        itemKey: link.itemKey
      });
    }
  }
  return index;
}

function uniqueStrings(values) {
  return [...new Set(values
    .map(value => String(value ?? '').trim())
    .filter(Boolean))];
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
    domains: 'domains',
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
    groups: template.templategroups ?? template.groups ?? [],
    itemKeys: normalizeZabbixItems(template.items).map(item => item.key),
    discoveryRuleKeys: normalizeZabbixItems(template.discoveryRules).map(item => item.key),
    inventoryLinks: normalizeZabbixItems(template.items)
      .filter(item => !isBlank(item.inventoryLink) && item.inventoryLink !== '0')
      .map(item => ({ inventoryLink: item.inventoryLink, itemKey: item.key }))
  }));

  return {
    syncedAt: catalog?.syncedAt ?? null,
    zabbixEndpoint: catalog?.zabbixEndpoint ?? null,
    zabbixVersion: catalog?.zabbixVersion ?? '',
    templateCompatibility: catalog?.templateCompatibility ?? buildZabbixTemplateCompatibility(catalog ?? {}),
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

function normalizeCmdbuildItem(result) {
  if (Array.isArray(result)) {
    return result[0] ?? null;
  }

  if (isPlainObject(result?.data)) {
    return result.data;
  }

  if (isPlainObject(result?.item)) {
    return result.item;
  }

  return isPlainObject(result) ? result : null;
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
    .replaceAll('<#= Model.HostProfileName #>', model.HostProfileName ?? '')
    .replaceAll('<#= Model.OutputProfileName #>', model.OutputProfileName ?? '')
    .replaceAll('<#= Model.IpAddress #>', model.IpAddress ?? '')
    .replaceAll('<#= Model.DnsName #>', model.DnsName ?? '')
    .replaceAll('<#= Model.Interface.Ip #>', model.Interface?.ip ?? model.Interface?.Ip ?? '')
    .replaceAll('<#= Model.Interface.Dns #>', model.Interface?.dns ?? model.Interface?.Dns ?? '')
    .replaceAll('<#= Model.OperatingSystem #>', model.OperatingSystem ?? '')
    .replaceAll('<#= Model.ZabbixTag #>', model.ZabbixTag ?? '')
    .replaceAll('<#= Model.EventType #>', model.EventType ?? '')
    .replace(/<#=\s*Model\.Source\(["']([^"']+)["']\)\s*#>/g, (_, name) => readSourceField(model.Fields ?? {}, name) ?? '')
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

function httpError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) {
    error.details = details;
  }
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
    '.mjs': 'text/javascript; charset=utf-8',
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
  if (!isPathInside(repositoryRoot, fullPath)) {
    throw httpError(400, 'invalid_path', 'Configured path escapes repository root.');
  }

  return fullPath;
}

function isPathInside(root, path) {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function resolveUiSettingsFile(target) {
  return resolve(serviceRoot, target.UiSettings?.FilePath ?? 'state/ui-settings.json');
}

function resolveUsersFile(target) {
  const settingsPath = target.UiSettings?.FilePath ?? 'state/ui-settings.json';
  const usersPath = target.Auth?.UsersFilePath ?? join(dirname(settingsPath), 'users.json');
  return resolve(serviceRoot, usersPath);
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

function booleanSettingOrDefault(source, key, defaultValue) {
  return Object.prototype.hasOwnProperty.call(source ?? {}, key)
    ? Boolean(source[key])
    : Boolean(defaultValue);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isIdpEnabled() {
  return Boolean(config.Auth.UseIdp || config.Idp.Enabled || config.Idp.enabled);
}

function idpProvider() {
  return normalizeIdpProvider(config.Idp.Provider ?? config.Idp.provider ?? 'SAML2');
}

function normalizeIdpProvider(value) {
  const normalized = String(value ?? 'SAML2').trim().toLowerCase();
  if (['oauth2', 'oauth', 'oidc', 'openidconnect'].includes(normalized)) {
    return 'oauth2';
  }
  if (['ldap', 'ldaps', 'msad', 'ad', 'active-directory', 'activedirectory'].includes(normalized)) {
    return 'ldap';
  }
  return 'saml2';
}

function idpLoginRoute() {
  return {
    saml2: '/auth/saml2/login',
    oauth2: '/auth/oauth2/login',
    ldap: '/api/auth/login'
  }[idpProvider()] ?? '/auth/saml2/login';
}

function assertIdpProvider(provider) {
  if (idpProvider() !== provider) {
    throw httpError(409, 'idp_provider_mismatch', `Configured IdP provider is ${idpProvider()}.`);
  }
}

function assertOauth2Enabled() {
  if (!isIdpEnabled()) {
    throw httpError(409, 'idp_disabled', 'IdP mode is disabled.');
  }
  assertIdpProvider('oauth2');
  const settings = resolveOauth2Settings();
  for (const [field, value] of Object.entries({
    authorizationUrl: settings.authorizationUrl,
    tokenUrl: settings.tokenUrl,
    clientId: settings.clientId,
    redirectUri: settings.redirectUri
  })) {
    if (isBlank(value)) {
      throw httpError(500, 'oauth2_not_configured', `OAuth2 ${field} is not configured.`);
    }
  }
}

function resolveOauth2Settings() {
  return normalizeOauth2SettingsPayload(config.Idp.OAuth2 ?? config.Idp.oauth2 ?? {});
}

function resolveLdapSettings() {
  const settings = normalizeLdapSettingsPayload(config.Idp.Ldap ?? config.Idp.ldap ?? {});
  if (isBlank(settings.host)) {
    throw httpError(500, 'ldap_not_configured', 'LDAP host is not configured.');
  }
  if (isBlank(settings.baseDn) && isBlank(settings.userDnTemplate)) {
    throw httpError(500, 'ldap_not_configured', 'LDAP baseDn or userDnTemplate is not configured.');
  }

  return settings;
}

function normalizeLdapProtocol(value) {
  return String(value ?? 'ldap').trim().toLowerCase() === 'ldaps' ? 'ldaps' : 'ldap';
}

function normalizeRoleMappingPayload(value = {}) {
  return {
    admin: normalizeStringArray(value.admin ?? value.Admin ?? value.administrator ?? value.Administrator),
    editor: normalizeStringArray(value.editor ?? value.Editor ?? value.operator ?? value.Operator),
    viewer: normalizeStringArray(value.viewer ?? value.Viewer ?? value.readonly ?? value.Readonly)
  };
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

function firstClaimValue(claims, names) {
  for (const name of names.filter(Boolean)) {
    const value = claims?.[name];
    if (!isBlank(value)) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return null;
}

function firstClaimRawValue(claims, names) {
  for (const name of names.filter(Boolean)) {
    const value = claims?.[name];
    if (!isBlank(value)) {
      return value;
    }
  }

  return null;
}

function decodeJwtPayload(token) {
  if (isBlank(token)) {
    return null;
  }

  try {
    const [, payload] = String(token).split('.');
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => values[key] ?? '');
}

function ldapEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

function ldapFirstValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function ldapEntryDn(entry) {
  return ldapFirstValue(entry?.dn) || ldapFirstValue(entry?.distinguishedName) || ldapFirstValue(entry?.objectName);
}

function pruneOauthStates() {
  const maxAgeMs = 10 * 60 * 1000;
  for (const [state, record] of oauthStates.entries()) {
    if (Date.now() - record.createdAt > maxAgeMs) {
      oauthStates.delete(state);
    }
  }
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

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
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

function stringOrDefault(value, fallback) {
  return isBlank(value) ? fallback : String(value).trim();
}

function cmdbuildTraversalMaxDepth(value) {
  return clampInt(value, 2, 2, 5);
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
