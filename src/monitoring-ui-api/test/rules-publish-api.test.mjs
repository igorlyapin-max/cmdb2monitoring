import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const serviceRoot = resolve(new URL('..', import.meta.url).pathname);
const repositoryRoot = resolve(serviceRoot, '../..');

test('publish rejects a stale active-rules revision without overwriting the file', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-publish-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const initialRules = await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.json'), 'utf8');
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, initialRules, 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const process = startServer(port, directory, activeRulesPath, usersPath);
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie);

    const endpointOverride = await request(port, '/api/auth/session-credentials', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        service: 'cmdbuild',
        username: 'operator',
        password: 'test-value',
        baseUrl: 'http://untrusted.example.local/cmdbuild/services/rest/v4'
      }
    });
    assert.equal(endpointOverride.status, 400);
    assert.equal(endpointOverride.body.error, 'integration_endpoint_override_not_allowed');

    const tooManyWebhookOperations = await request(port, '/api/cmdbuild/webhooks/apply', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        operations: Array.from({ length: 101 }, () => ({ selected: false }))
      }
    });
    assert.equal(tooManyWebhookOperations.status, 400);
    assert.equal(tooManyWebhookOperations.body.error, 'too_many_webhook_operations');
    assert.equal(tooManyWebhookOperations.body.limit, 100);

    const missingWebhookTarget = await request(port, '/api/cmdbuild/webhooks/apply', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        operations: [{
          action: 'create',
          desired: {
            code: 'cmdbwebhooks2kafka-test-update',
            url: 'https://monitoring-webhook.example.local/webhooks/cmdbuild',
            body: { managedIdentifier: 'cmdb2monitoring-zabbix-host-lifecycle' }
          }
        }]
      }
    });
    assert.equal(missingWebhookTarget.status, 400);
    assert.equal(missingWebhookTarget.body.error, 'webhook_target_url_not_configured');

    const savedRuntime = await request(port, '/api/settings/runtime', {
      method: 'PUT',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        cmdbuild: {
          webhookTargetUrl: 'https://monitoring-webhook.example.local/webhooks/cmdbuild'
        }
      }
    });
    assert.equal(savedRuntime.status, 200);
    assert.equal(savedRuntime.body.cmdbuild.webhookTargetUrl, 'https://monitoring-webhook.example.local/webhooks/cmdbuild');

    const tamperedWebhookTarget = await request(port, '/api/cmdbuild/webhooks/apply', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        operations: [{
          action: 'create',
          desired: {
            code: 'cmdbwebhooks2kafka-test-update',
            url: 'https://untrusted.example.local/webhooks/cmdbuild',
            body: { managedIdentifier: 'cmdb2monitoring-zabbix-host-lifecycle' }
          }
        }]
      }
    });
    assert.equal(tamperedWebhookTarget.status, 400);
    assert.equal(tamperedWebhookTarget.body.error, 'webhook_target_url_not_runtime_owned');

    const current = await request(port, '/api/rules/current', {
      headers: { cookie }
    });
    assert.equal(current.status, 200, JSON.stringify(current.body));

    const eventRoutes = await request(port, '/api/rules/event-routes', { headers: { cookie } });
    assert.equal(eventRoutes.status, 200);
    assert.deepEqual(eventRoutes.body.routes.map(route => route.eventType), ['create', 'update', 'delete']);
    assert.equal(eventRoutes.body.content, undefined);

    const invalidRoutes = structuredClone(current.body.content);
    for (const route of invalidRoutes.eventRoutingRules) route.publish = false;
    const invalidPublish = await request(port, '/api/rules/publish', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': login.body.csrfToken },
      body: { expectedRevision: current.body.revision, rules: invalidRoutes }
    });
    assert.equal(invalidPublish.status, 422);
    assert.equal(invalidPublish.body.error, 'rules_validation_failed');
    assert.equal(await readFile(activeRulesPath, 'utf8'), initialRules);

    const externalRules = JSON.parse(initialRules);
    externalRules.rulesVersion = 'external-change';
    const externalContent = JSON.stringify(externalRules, null, 2) + '\n';
    await writeFile(activeRulesPath, externalContent, 'utf8');

    const publish = await request(port, '/api/rules/publish', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        expectedRevision: current.body.revision,
        rules: current.body.content
      }
    });
    assert.equal(publish.status, 409);
    assert.equal(publish.body.error, 'rules_revision_conflict');
    assert.equal(await readFile(activeRulesPath, 'utf8'), externalContent);
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await rm(directory, { recursive: true, force: true });
  }
});

test('publish reports saved but not applied when converter reads a different rules artifact', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-rules-mismatch-'));
  const port = await reservePort();
  const converterPort = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'), 'utf8'), 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const converter = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/admin/reload-rules') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.url === '/admin/rules-status') {
      response.end(JSON.stringify({
        rules: {
          rulesVersion: 'same-version',
          schemaVersion: '0.2',
          contentSha256: '0'.repeat(64),
          location: '/app/rules/other.json'
        }
      }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await listen(converter, converterPort);

  const process = startServer(port, directory, activeRulesPath, usersPath, {
    MONITORING_UI_HEALTH_ENDPOINTS_JSON: JSON.stringify([{
      Name: 'cmdbkafka2zabbix',
      Url: `http://127.0.0.1:${converterPort}/health`,
      RulesReloadUrl: `http://127.0.0.1:${converterPort}/admin/reload-rules`,
      RulesReloadToken: 'test-rules-token',
      RulesStatusUrl: `http://127.0.0.1:${converterPort}/admin/rules-status`
    }])
  });
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    const current = await request(port, '/api/rules/current', { headers: { cookie: login.headers.get('set-cookie') } });
    const rules = structuredClone(current.body.content);
    rules.rulesVersion = 'same-version';
    const publish = await request(port, '/api/rules/publish', {
      method: 'POST',
      headers: {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      },
      body: { rules, expectedRevision: current.body.revision }
    });

    assert.equal(publish.status, 200, JSON.stringify(publish.body));
    assert.equal(publish.body.saved, true);
    assert.equal(publish.body.applied, false);
    assert.equal(publish.body.converterStatus.reason, 'content_sha256_mismatch');
    assert.notEqual(publish.body.converterStatus.expectedSha256, publish.body.converterStatus.actualSha256);

    const retry = await request(port, '/api/rules/retry-reload', {
      method: 'POST',
      headers: {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      },
      body: {}
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.applied, false);
    assert.equal(retry.body.converterStatus.reason, 'content_sha256_mismatch');
    assert.equal(retry.body.resolvedPath, activeRulesPath);
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await close(converter);
    await rm(directory, { recursive: true, force: true });
  }
});

test('health exposes a specific non-secret rules verification reason for each failed artifact state', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-rules-verification-'));
  const port = await reservePort();
  const converterPort = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'), 'utf8'), 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const converterState = { healthStatus: 200, statusStatus: 200, statusCode: '', contentSha256: '' };
  const converter = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.statusCode = converterState.healthStatus;
      response.end(JSON.stringify({ status: converterState.healthStatus === 200 ? 'ok' : 'failed' }));
      return;
    }
    if (request.url?.startsWith('/admin/rules-status')) {
      response.statusCode = converterState.statusStatus;
      response.end(JSON.stringify(converterState.statusStatus === 200 ? {
        rules: {
          contentSha256: converterState.contentSha256,
          location: '/app/rules/customer.json',
          repositoryUrl: 'https://viewer:must-not-leak@git.example.test/customer-rules.git'
        }
      } : {
        code: converterState.statusCode,
        detail: 'Internal mounted rules path must not be exposed by the BFF: /customer/private/rules.json'
      }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await listen(converter, converterPort);

  const process = startServer(port, directory, activeRulesPath, usersPath, {
    MONITORING_UI_HEALTH_ENDPOINTS_JSON: JSON.stringify([{
      Name: 'cmdbkafka2zabbix',
      Url: `http://127.0.0.1:${converterPort}/health`,
      RulesStatusUrl: `http://127.0.0.1:${converterPort}/admin/rules-status?token=not-for-ui`
    }])
  });
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    const cookie = login.headers.get('set-cookie');
    const current = await request(port, '/api/rules/current', { headers: { cookie } });
    converterState.contentSha256 = current.body.revision;

    const initialHealth = await request(port, '/api/services/health', { headers: { cookie } });
    assert.equal(initialHealth.status, 200, JSON.stringify(initialHealth.body));
    assert.equal(initialHealth.body.items[0].rulesStatus.rules.repositoryUrl, undefined);
    assert.equal(initialHealth.body.items[0].rulesVerification.rulesStatusErrorCode, undefined);
    assert.doesNotMatch(JSON.stringify(initialHealth.body), /must-not-leak/);

    const readVerification = async () => {
      const health = await request(port, '/api/services/health', { headers: { cookie } });
      assert.equal(health.status, 200, JSON.stringify(health.body));
      return health.body.items[0].rulesVerification;
    };

    converterState.healthStatus = 503;
    let verification = await readVerification();
    assert.equal(verification.reason, 'healthcheck_failed');
    assert.equal(verification.healthStatusCode, 503);

    converterState.healthStatus = 200;
    converterState.statusStatus = 401;
    verification = await readVerification();
    assert.equal(verification.reason, 'rules_status_unavailable');
    assert.equal(verification.rulesStatusCode, 401);
    assert.equal(verification.rulesStatusErrorCode, undefined);
    assert.doesNotMatch(JSON.stringify(verification), /not-for-ui/);

    converterState.statusStatus = 503;
    converterState.statusCode = 'rules_file_unreadable';
    verification = await readVerification();
    assert.equal(verification.reason, 'rules_status_unavailable');
    assert.equal(verification.rulesStatusErrorCode, 'rules_file_unreadable');
    assert.doesNotMatch(JSON.stringify(verification), /customer\/private/);

    converterState.statusCode = 'untrusted_converter_code';
    verification = await readVerification();
    assert.equal(verification.rulesStatusErrorCode, undefined);

    converterState.statusStatus = 200;
    converterState.statusCode = '';
    converterState.contentSha256 = '';
    verification = await readVerification();
    assert.equal(verification.reason, 'converter_does_not_report_sha256');

    converterState.contentSha256 = 'f'.repeat(64);
    verification = await readVerification();
    assert.equal(verification.reason, 'content_sha256_mismatch');
    assert.equal(verification.converterPath, '/app/rules/customer.json');

    await rm(activeRulesPath);
    verification = await readVerification();
    assert.equal(verification.reason, 'management_rules_unavailable');
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await close(converter);
    await rm(directory, { recursive: true, force: true });
  }
});

test('production permits a blank CMDBuild webhook target but rejects unsafe runtime values', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-webhook-target-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const baseOverrides = productionRuntimeOverrides();
  const password = 'test-local-admin-password';
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');
  await writeFile(
    activeRulesPath,
    await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'), 'utf8'),
    'utf8'
  );
  let process = null;

  try {
    process = startServer(port, directory, activeRulesPath, usersPath, baseOverrides);
    try {
      await waitForReady(port, process);
      const login = await request(port, '/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password }
      });
      assert.equal(login.status, 200);
      const headers = {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      };
      const initial = await request(port, '/api/settings/runtime', { headers: { cookie: headers.cookie } });
      assert.equal(initial.status, 200);
      assert.equal(initial.body.cmdbuild.webhookTargetUrl, '');

      for (const targetUrl of [
        'http://localhost./webhooks/cmdbuild',
        'http://127.0.0.1/webhooks/cmdbuild',
        'http://[::1]/webhooks/cmdbuild',
        'http://[::ffff:127.0.0.1]/webhooks/cmdbuild',
        'http://0.0.0.0/webhooks/cmdbuild',
        'http://[::]/webhooks/cmdbuild',
        'https://token@monitoring-webhook.example.local/webhooks/cmdbuild',
        'https://monitoring-webhook.example.local/webhooks/cmdbuild?token=value',
        'https://monitoring-webhook.example.local/webhooks/cmdbuild#fragment'
      ]) {
        const update = await request(port, '/api/settings/runtime', {
          method: 'PUT',
          headers,
          body: { cmdbuild: { webhookTargetUrl: targetUrl } }
        });
        assert.equal(update.status, 400);
        assert.equal(update.body.error, 'invalid_cmdbuild_webhook_target');
      }
      const saved = await request(port, '/api/settings/runtime', {
        method: 'PUT',
        headers,
        body: { cmdbuild: { webhookTargetUrl: 'https://monitoring-webhook.example.local/webhooks/cmdbuild/' } }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.cmdbuild.webhookTargetUrl, 'https://monitoring-webhook.example.local/webhooks/cmdbuild');
    } finally {
      process.kill('SIGTERM');
      await onceExit(process);
      process = null;
    }
    process = startServer(port, directory, activeRulesPath, usersPath, baseOverrides);
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    const restored = await request(port, '/api/settings/runtime', { headers: { cookie: login.headers.get('set-cookie') } });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.cmdbuild.webhookTargetUrl, 'https://monitoring-webhook.example.local/webhooks/cmdbuild');
    process.kill('SIGTERM');
    await onceExit(process);
    process = null;
  } finally {
    if (process?.exitCode === null) {
      process.kill('SIGTERM');
      await onceExit(process);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails startup with a clear error when persisted UI settings are invalid JSON', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-invalid-settings-'));
  const port = await reservePort();
  const settingsPath = join(directory, 'settings.json');
  let process = null;

  try {
    await writeFile(settingsPath, '{invalid json\n', 'utf8');
    process = startServer(port, directory, join(directory, 'rules.json'), join(directory, 'users.json'));
    const output = await waitForExitOutput(process);
    assert.notEqual(process.exitCode, 0);
    assert.match(output, /Persisted UI settings file is invalid JSON/);
  } finally {
    if (process?.exitCode === null) {
      process.kill('SIGTERM');
      await onceExit(process);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Event Browser API returns a diagnostic id that is written to structured logs', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-event-browser-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const rules = await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'), 'utf8');
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, rules, 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const process = startServer(port, directory, activeRulesPath, usersPath, {
    MONITORING_UI_EVENTS_ENABLED: 'true',
    MONITORING_UI_EVENTS_TOPICS: 'test.events',
    MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS: '127.0.0.1:1',
    MONITORING_UI_KAFKA_ALLOW_PLAINTEXT: 'true',
    MONITORING_UI_EVENTS_READ_TIMEOUT_MS: '500'
  });
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    const events = await request(port, '/api/events?topic=test.events&readTimeoutMs=500', {
      headers: { cookie: login.headers.get('set-cookie') }
    });
    assert.equal(events.status, 502);
    assert.equal(events.body.error, 'kafka_event_browser_error');
    assert.match(events.body.eventReadId, /^[0-9a-f-]{36}$/i);
    await waitFor(() => process.output.includes(events.body.eventReadId));
    assert.match(process.output, /Event Browser Kafka read failed/);
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await rm(directory, { recursive: true, force: true });
  }
});

test('production rules starter validates as a safe no-op', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-production-starter-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const starter = JSON.parse(await readFile(
    join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'),
    'utf8'));
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, `${JSON.stringify(starter, null, 2)}\n`, 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const process = startServer(port, directory, activeRulesPath, usersPath);
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    assert.equal(login.status, 200);

    const validation = await request(port, '/api/rules/validate', {
      method: 'POST',
      headers: {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      },
      body: { rules: starter }
    });
    assert.equal(validation.status, 200);
    assert.equal(validation.body.valid, true);
    assert.deepEqual(validation.body.errors, []);

    const legacyRules = structuredClone(starter);
    legacyRules.templateSelectionRules.push({
      when: { expression: { operator: 'always' } }
    });
    const legacyValidation = await request(port, '/api/rules/validate', {
      method: 'POST',
      headers: {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      },
      body: { rules: legacyRules }
    });
    assert.equal(legacyValidation.status, 200);
    assert.equal(legacyValidation.body.valid, false);
    assert.ok(legacyValidation.body.errors.includes(
      'templateSelectionRules[0] must declare one known hostProfile with root all/equals scope: host_profile_required.'));
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await rm(directory, { recursive: true, force: true });
  }
});

test('production rejects an insecure SAML metadata endpoint before settings are saved', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-production-saml-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const usersPath = join(directory, 'users.json');
  const rules = await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json'), 'utf8');
  const password = 'test-local-admin-password';
  await writeFile(activeRulesPath, rules, 'utf8');
  await writeFile(usersPath, JSON.stringify({
    version: 1,
    users: [{
      username: 'admin',
      displayName: 'Test Admin',
      role: 'admin',
      password: passwordHash(password),
      mustChangePassword: false
    }]
  }), 'utf8');

  const process = startServer(port, directory, activeRulesPath, usersPath, {
    NODE_ENV: 'Production',
    MONITORING_UI_TRANSPORT_ALLOW_PLAIN_HTTP: 'true',
    MONITORING_UI_EVENTS_ENABLED: 'false',
    MONITORING_UI_KAFKA_ALLOW_PLAINTEXT: 'true',
    MONITORING_UI_LOGS_ENABLED: 'false',
    CMDBUILD_BASE_URL: 'https://cmdbuild.example.local/cmdbuild/services/rest/v4',
    ZABBIX_API_ENDPOINT: 'https://zabbix.example.local/api_jsonrpc.php',
    MONITORING_UI_OUTBOUND_ALLOWED_HOSTS: 'cmdbuild.example.local,zabbix.example.local,idp.example.local',
    MONITORING_UI_HEALTH_ENDPOINTS_JSON: JSON.stringify([
      { Name: 'cmdbwebhooks2kafka', Url: 'http://cmdbwebhooks2kafka:8080/health' },
      {
        Name: 'cmdbkafka2zabbix',
        Url: 'http://cmdbkafka2zabbix:8080/health',
        RulesReloadUrl: 'http://cmdbkafka2zabbix:8080/admin/reload-rules',
        RulesReloadToken: 'test-rules-token',
        RulesStatusUrl: 'http://cmdbkafka2zabbix:8080/admin/rules-status'
      },
      { Name: 'zabbixrequests2api', Url: 'http://zabbixrequests2api:8080/health' },
      { Name: 'zabbixbindings2cmdbuild', Url: 'http://zabbixbindings2cmdbuild:8080/health' }
    ])
  });
  try {
    await waitForReady(port, process);
    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password }
    });
    assert.equal(login.status, 200);

    const capabilities = await request(port, '/api/settings/runtime-capabilities', {
      headers: { cookie: login.headers.get('set-cookie') }
    });
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.cmdbuild.webhookTargetUrl, '');

    const update = await request(port, '/api/settings/idp', {
      method: 'PUT',
      headers: {
        cookie: login.headers.get('set-cookie'),
        'x-csrf-token': login.body.csrfToken
      },
      body: {
        provider: 'SAML2',
        enabled: true,
        metadataUrl: 'http://idp.example.local/saml/metadata'
      }
    });
    assert.equal(update.status, 500);
    assert.equal(update.body.error, 'internal_error');
    assert.match(update.body.message, /Production SAML metadata endpoint requires HTTPS/);

    const settings = await request(port, '/api/settings/idp', {
      headers: { cookie: login.headers.get('set-cookie') }
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.metadataUrl, '');
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await rm(directory, { recursive: true, force: true });
  }
});

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: 210000,
    keyLength: 32,
    digest: 'sha256',
    salt,
    hash: pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')
  };
}

function startServer(port, directory, activeRulesPath, usersPath, overrides = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'Development',
      PORT: String(port),
      MONITORING_UI_HOST: '127.0.0.1',
      MONITORING_UI_SETTINGS_FILE: join(directory, 'settings.json'),
      MONITORING_UI_USERS_FILE: usersPath,
      MONITORING_UI_EVENTS_ENABLED: 'false',
      MONITORING_UI_LOGS_ENABLED: 'false',
      RULES_ACTIVE_BASE_DIRECTORY: directory,
      RULES_ACTIVE_FILE_PATH: activeRulesPath,
      RULES_ACTIVE_WRITE_ENABLED: 'true',
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk.toString(); });
  child.stderr.on('data', chunk => { child.output += chunk.toString(); });
  return child;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

async function listen(server, port) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
}

async function close(server) {
  await new Promise(resolvePromise => server.close(resolvePromise));
}

async function waitForReady(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('monitoring-ui-api exited before readiness: ' + child.output);
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/ready');
      if (response.ok && (await response.json()).ready === true) {
        return;
      }
    } catch {
      // Retry while the spawned BFF initializes its local state.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }

  throw new Error('monitoring-ui-api did not become ready: ' + child.output);
}

function productionRuntimeOverrides() {
  return {
    NODE_ENV: 'Production',
    MONITORING_UI_TRANSPORT_ALLOW_PLAIN_HTTP: 'true',
    MONITORING_UI_EVENTS_ENABLED: 'false',
    MONITORING_UI_KAFKA_ALLOW_PLAINTEXT: 'true',
    MONITORING_UI_LOGS_ENABLED: 'false',
    CMDBUILD_BASE_URL: 'https://cmdbuild.example.local/cmdbuild/services/rest/v4',
    ZABBIX_API_ENDPOINT: 'https://zabbix.example.local/api_jsonrpc.php',
    MONITORING_UI_OUTBOUND_ALLOWED_HOSTS: 'cmdbuild.example.local,zabbix.example.local,idp.example.local',
    MONITORING_UI_HEALTH_ENDPOINTS_JSON: JSON.stringify([
      { Name: 'cmdbwebhooks2kafka', Url: 'http://cmdbwebhooks2kafka:8080/health' },
      {
        Name: 'cmdbkafka2zabbix',
        Url: 'http://cmdbkafka2zabbix:8080/health',
        RulesReloadUrl: 'http://cmdbkafka2zabbix:8080/admin/reload-rules',
        RulesReloadToken: 'test-rules-token',
        RulesStatusUrl: 'http://cmdbkafka2zabbix:8080/admin/rules-status'
      },
      { Name: 'zabbixrequests2api', Url: 'http://zabbixrequests2api:8080/health' },
      { Name: 'zabbixbindings2cmdbuild', Url: 'http://zabbixbindings2cmdbuild:8080/health' }
    ])
  };
}

async function waitForExitOutput(child) {
  await Promise.race([
    onceExit(child),
    new Promise((_, reject) => setTimeout(() => reject(new Error('monitoring-ui-api did not fail fast')), 3000))
  ]);
  return child.output;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Condition was not met before timeout.');
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
}

async function request(port, path, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.headers ?? {}),
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

async function onceExit(child) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
}
