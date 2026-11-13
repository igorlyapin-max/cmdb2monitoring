import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright';

const serviceRoot = resolve(new URL('..', import.meta.url).pathname);
const repositoryRoot = resolve(serviceRoot, '../..');
const chromeExecutable = process.env.BROWSER_EXECUTABLE_PATH
  ?? ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

test('mapping editor keeps the profile-bound condition flow usable in Russian and English', async () => {
  assert.ok(chromeExecutable, 'Set BROWSER_EXECUTABLE_PATH to a Chrome or Chromium executable.');
  const directory = await mkdtemp(join(serviceRoot, 'state', '.mapping-editor-browser-'));
  const port = await reservePort();
  const activeRulesPath = join(directory, 'rules.json');
  const rules = JSON.parse(await readFile(join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.json'), 'utf8'));
  const cmdbuildCatalog = browserTestCmdbuildCatalog();
  const zabbixCatalog = browserTestZabbixCatalog();
  const runtimeScenario = {};
  addBrowserTemplateRule(rules);
  await writeFile(activeRulesPath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');

  const server = startServer(port, directory, activeRulesPath);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromeExecutable,
    args: ['--no-sandbox']
  });

  try {
    await waitForReady(port, server);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.setDefaultTimeout(10000);
    await mockApi(page, rules, cmdbuildCatalog, zabbixCatalog, {
      eventBrowserFailure: 'event-read-browser-test',
      role: 'admin',
      runtimeScenario
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    await page.locator('[data-view="profiles"]').click();
    await page.locator('#profiles.active #mappingProfilesPanel').waitFor({ state: 'visible' });
    assert.deepEqual(await rulesNavigationOrder(page), ['profiles', 'mapping']);
    await assertVisible(page, '#mappingProfilesPanel');

    await page.locator('[data-view="mapping"]').click();
    await page.locator('#mappingEditor').waitFor({ state: 'visible' });
    await page.locator('#mappingRuleProfile').selectOption('arm-main');
    await assertVisible(page, '#mappingConditionEditor');
    assert.equal(await page.locator('#mappingConditionProfileConstraint').textContent(), 'hostProfile = arm-main');
    assert.equal(await page.locator('#mappingEditClassRow').isVisible(), false);
    assert.equal(await page.locator('#mappingConditionBuilder option[value="hostProfile"]').count(), 0);

    await page.getByLabel('Оператор условия').first().selectOption('any');
    await page.getByRole('button', { name: '+ Группа' }).first().click();
    await page.locator('[data-condition-action="add-leaf"][data-condition-path="root/1"]').click();
    await setLeaf(page, 'root/0', 'aRMCritical', 'regex', '(?i)^3$');
    await setLeaf(page, 'root/1/0', 'aRMCritical', 'equals', '1');
    await setLeaf(page, 'root/1/1', 'aRMCritical', 'notEquals', '2');
    await assertVisible(page, '[data-condition-path="root/1/1"][data-condition-property="value"]');

    await page.locator('#mappingEditAction').selectOption('modify');
    await page.locator('#mappingRuleProfile').selectOption('arm-main');
    const templateRule = page.locator('#mappingModifyRule option', { hasText: 'browser-template-rule' });
    assert.equal(await templateRule.count(), 1);
    await page.locator('#mappingModifyRule').selectOption(await templateRule.getAttribute('value'));
    const selectedTemplate = JSON.parse(await page.locator('#mappingEditZabbixObject').inputValue());
    assert.equal(selectedTemplate.templateid, '90001');
    assert.equal(selectedTemplate.parentTemplates[0].templateid, '90000');
    assert.doesNotMatch(await page.locator('#mappingEditZabbixObject option:checked').textContent(), /Текущий target rule/);
    await page.locator('#mappingEditPriority').fill('101');
    await assertVisible(page, '#mappingAddRule');
    assert.equal(await page.locator('#mappingAddRule').isEnabled(), true);

    await page.locator('[data-view="webhooks"]').click();
    await page.locator('#webhooksAnalyze').click();
    await page.locator('[data-webhook-detail-kind="operation"]').first().click();
    await assertVisible(page, '#webhooksDetails');
    assert.match(await page.locator('#webhooksDetails').textContent(), /http:\/\/cmdbwebhooks2kafka:8080\/webhooks\/cmdbuild/);

    await page.locator('[data-view="runtimeSettings"]').click();
    await assertVisible(page, '#runtimeSettingsForm input[name="cmdbuildWebhookTargetUrl"]');
    await page.locator('#runtimeSettingsForm input[name="cmdbuildWebhookTargetUrl"]').fill('https://monitoring-webhook.example.local/webhooks/cmdbuild');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#saveRuntimeSettings').click();
    await page.locator('#webhooks.active').waitFor({ state: 'visible' });
    await page.locator('#webhooksOperationsTable').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#webhooksOperationsTable tr').count()) > 0);
    await page.locator('[data-webhook-detail-kind="operation"]').first().click();
    assert.match(await page.locator('#webhooksDetails').textContent(), /https:\/\/monitoring-webhook\.example\.local\/webhooks\/cmdbuild/);
    assert.doesNotMatch(await page.locator('#webhooksDetails').textContent(), /cmdbwebhooks2kafka:8080/);
    assert.equal(runtimeScenario.savedWebhookTargetUrl, 'https://monitoring-webhook.example.local/webhooks/cmdbuild');
    assert.ok(runtimeScenario.webhookLoadCount >= 2);
    assert.equal(runtimeScenario.applyCount ?? 0, 0);

    await page.locator('[data-view="events"]').click();
    await page.locator('#refreshEvents').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('event-read-browser-test'));
    assert.match(await page.locator('#toast').textContent(), /Идентификатор диагностики: event-read-browser-test/);

    await page.locator('[data-view="mapping"]').click();

    const missingTemplateRule = page.locator('#mappingModifyRule option', { hasText: 'browser-missing-template-rule' });
    assert.equal(await missingTemplateRule.count(), 1);
    await page.locator('#mappingModifyRule').selectOption(await missingTemplateRule.getAttribute('value'));
    assert.match(await page.locator('#mappingEditZabbixObject option:checked').textContent(), /Текущий target rule/);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertUsableMobileGeometry(page);
    await page.screenshot({ path: '/tmp/c2m-mapping-editor-browser.png', fullPage: true });

    await page.evaluate(() => {
      document.cookie = 'c2m_lang=en; path=/; max-age=31536000';
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-view="mapping"]').click();
    await page.locator('#mappingRuleProfile').selectOption('arm-main');
    await page.getByLabel('Condition operator').first().selectOption('any');
    assert.equal(await page.locator('[data-condition-path="root"][data-condition-property="operator"] option:checked').textContent(), 'OR');
    assert.ok(await page.getByLabel('Condition field').count() > 0);

    await page.locator('[data-view="events"]').click();
    await page.locator('#refreshEvents').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('event-read-browser-test'));
    await assertVisible(page, '#toast');
    assert.match(await page.locator('#toast').textContent(), /Diagnostic ID: event-read-browser-test/);

    const credentialsScenario = {};
    await page.unroute('**/api/**');
    await mockApi(page, rules, cmdbuildCatalog, zabbixCatalog, {
      requireCmdbuildCredentials: true,
      credentialsScenario
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#credentialsDialog').waitFor({ state: 'visible' });
    await assertVisible(page, '#credentialsBaseUrl');
    assert.equal(await page.locator('#credentialsBaseUrl').textContent(), 'http://localhost:8090/cmdbuild/services/rest/v4');
    assert.equal(await page.locator('input[name="baseUrl"]').count(), 0);
    assert.equal(await page.locator('input[name="apiEndpoint"]').count(), 0);
    await page.locator('#credentialsForm input[name="username"]').fill('operator');
    await page.locator('#credentialsForm input[name="password"]').fill('test-value');
    await page.locator('#credentialsForm button[type="submit"]').click();
    await page.locator('#credentialsDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(credentialsScenario.body, {
      service: 'cmdbuild',
      username: 'operator',
      password: 'test-value'
    });
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await onceExit(server);
    await rm(directory, { recursive: true, force: true });
  }
});

async function mockApi(page, rules, cmdbuildCatalog, zabbixCatalog, options = {}) {
  let cmdbuildCredentialsRequested = false;
  const role = options.role ?? 'editor';
  const runtimeScenario = options.runtimeScenario ?? {};
  const runtimeSettings = {
    filePath: 'state/ui-settings.json',
    usersFilePath: 'state/users.json',
    cmdbuild: {
      baseUrl: 'http://localhost:8090/cmdbuild/services/rest/v4',
      webhookTargetUrl: 'http://cmdbwebhooks2kafka:8080/webhooks/cmdbuild',
      maxTraversalDepth: 2,
      catalogSyncTimeoutSeconds: 300
    },
    zabbix: { apiEndpoint: '', apiToken: '', allowDynamicTagsFromCmdbLeaf: false, allowDynamicHostGroupsFromCmdbLeaf: false },
    auditStorage: { provider: 'sqlite', connectionString: '', schema: '', autoMigrate: false, commandTimeoutSeconds: 30 },
    eventBrowser: { enabled: false, bootstrapServers: '', clientId: '', securityProtocol: 'Plaintext', saslMechanism: '', username: '', password: '', sslRejectUnauthorized: true, maxMessages: 50, readTimeoutMs: 2500, topics: [] }
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/settings/runtime' && route.request().method() === 'PUT') {
      const submitted = JSON.parse(route.request().postData() ?? '{}');
      runtimeSettings.cmdbuild = { ...runtimeSettings.cmdbuild, ...(submitted.cmdbuild ?? {}) };
      runtimeScenario.savedWebhookTargetUrl = runtimeSettings.cmdbuild.webhookTargetUrl;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(runtimeSettings) });
      return;
    }
    if (path === '/api/cmdbuild/webhooks/apply') {
      runtimeScenario.applyCount = (runtimeScenario.applyCount ?? 0) + 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ count: 0 }) });
      return;
    }
    if (path === '/api/cmdbuild/webhooks') {
      runtimeScenario.webhookLoadCount = (runtimeScenario.webhookLoadCount ?? 0) + 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) });
      return;
    }
    if (path === '/api/cmdbuild/catalog'
      && options.requireCmdbuildCredentials
      && !cmdbuildCredentialsRequested) {
      cmdbuildCredentialsRequested = true;
      await route.fulfill({
        status: 428,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'credentials_required',
          service: 'cmdbuild',
          baseUrl: 'http://localhost:8090/cmdbuild/services/rest/v4'
        })
      });
      return;
    }
    if (path === '/api/auth/session-credentials') {
      options.credentialsScenario.body = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ user: { role, roleLabel: role } })
      });
      return;
    }
    if (path === '/api/events' && options.eventBrowserFailure) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'kafka_event_browser_error',
          message: 'Kafka event browsing failed. Use the diagnostic ID in service logs.',
          eventReadId: options.eventBrowserFailure
        })
      });
      return;
    }
    const payload = path === '/api/auth/status'
      ? {
        authenticated: true,
        user: {
          identity: { login: 'browser-test', displayName: 'Browser Test' },
          role,
          roleLabel: role,
          authMethod: 'local'
        },
        csrfToken: 'browser-test'
      }
      : path === '/api/services/health'
        ? { items: [], managementRules: {} }
        : path === '/api/queue/status'
          ? { enabled: false, refreshIntervalMs: 0 }
          : path === '/api/settings/runtime'
            ? runtimeSettings
            : path === '/api/settings/runtime-capabilities'
            ? {
              cmdbuild: { webhookTargetUrl: runtimeSettings.cmdbuild.webhookTargetUrl },
              zabbix: { allowDynamicTagsFromCmdbLeaf: false, allowDynamicHostGroupsFromCmdbLeaf: false }
            }
            : path === '/api/rules/current'
              ? { source: 'active', rulesVersion: rules.rulesVersion, content: rules }
              : path === '/api/cmdbuild/catalog'
                ? cmdbuildCatalog
                : path === '/api/zabbix/catalog' || path === '/api/zabbix/catalog/mapping'
                  ? zabbixCatalog
                  : path === '/api/zabbix/metadata'
                    ? {}
                    : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

function browserTestCmdbuildCatalog() {
  return {
    classes: [{ name: 'ARM', description: 'ARM', active: true }],
    attributes: [{
      className: 'ARM',
      items: [{ name: 'aRMCritical', type: 'lookup', active: true, readable: true }]
    }],
    lookups: [],
    domains: []
  };
}

function browserTestZabbixCatalog() {
  return {
    hostGroups: [],
    templates: [{
      templateid: '90001',
      name: 'Template browser catalog match',
      host: 'Template browser catalog match',
      parentTemplates: [{ templateid: '90000', name: 'Parent template' }],
      templategroups: [{ groupid: '1', name: 'Templates' }],
      items: [{ itemid: '1', key_: 'agent.ping' }]
    }],
    templateGroups: [],
    proxies: [],
    proxyGroups: [],
    globalMacros: [],
    hostMacros: [],
    inventoryFields: [],
    interfaceProfiles: [],
    hostStatuses: [],
    tlsPskModes: [],
    maintenances: [],
    valueMaps: []
  };
}

function addBrowserTemplateRule(rules) {
  rules.templateSelectionRules = [
    ...(rules.templateSelectionRules ?? []),
    {
      name: 'browser-template-rule',
      priority: 100,
      when: {
        expression: {
          operator: 'all',
          items: [
            { operator: 'equals', field: 'hostProfile', value: 'arm-main' },
            { operator: 'equals', field: 'aRMCritical', value: '1' }
          ]
        }
      },
      templates: [{
        templateid: '90001',
        name: 'Template browser catalog match'
      }]
    },
    {
      name: 'browser-missing-template-rule',
      priority: 100,
      when: {
        expression: {
          operator: 'all',
          items: [
            { operator: 'equals', field: 'hostProfile', value: 'arm-main' },
            { operator: 'equals', field: 'aRMCritical', value: '2' }
          ]
        }
      },
      templates: [{
        templateid: '90002',
        name: 'Template browser missing'
      }]
    }
  ];
}

async function setLeaf(page, path, field, operator, value) {
  await page.locator(`[data-condition-path="${path}"][data-condition-property="operator"]`).selectOption(operator);
  await page.locator(`[data-condition-path="${path}"][data-condition-property="field"]`).selectOption(field);
  const property = operator === 'regex' || operator === 'notRegex' ? 'pattern' : 'value';
  await page.locator(`[data-condition-path="${path}"][data-condition-property="${property}"]`).fill(value);
}

async function rulesNavigationOrder(page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-view="profiles"]')?.closest('.nav-section');
    return [...(section?.querySelectorAll('.nav-item[data-view]') ?? [])].map(item => item.dataset.view);
  });
}

async function assertVisible(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${selector} must be visibly usable.`);
}

async function assertUsableMobileGeometry(page) {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('#mappingConditionBuilder button, #mappingConditionBuilder select, #mappingConditionBuilder input')]
      .map(control => {
        const box = control.getBoundingClientRect();
        return { width: box.width, height: box.height, right: box.right };
      }),
    overflowing: [...document.querySelectorAll('body *')]
      .map(element => {
        const box = element.getBoundingClientRect();
        return {
          selector: element.id ? `#${element.id}` : element.className || element.tagName,
          right: Math.round(box.right),
          width: Math.round(box.width)
        };
      })
      .filter(element => element.right > window.innerWidth + 1)
      .slice(0, 10)
  }));

  assert.ok(geometry.scrollWidth <= geometry.viewport,
    `Mapping editor must not create horizontal overflow on mobile: ${JSON.stringify(geometry)}`);
  for (const control of geometry.controls) {
    assert.ok(control.width > 0 && control.height > 0 && control.right <= geometry.viewport,
      `Condition control must fit inside the mobile viewport: ${JSON.stringify(control)}`);
  }
}

function startServer(port, directory, activeRulesPath) {
  return spawn(process.execPath, ['server.mjs'], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'Development',
      PORT: String(port),
      MONITORING_UI_HOST: '127.0.0.1',
      MONITORING_UI_SETTINGS_FILE: join(directory, 'settings.json'),
      MONITORING_UI_USERS_FILE: join(directory, 'users.json'),
      MONITORING_UI_EVENTS_ENABLED: 'false',
      MONITORING_UI_LOGS_ENABLED: 'false',
      RULES_ACTIVE_BASE_DIRECTORY: directory,
      RULES_ACTIVE_FILE_PATH: activeRulesPath,
      RULES_ACTIVE_WRITE_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
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

async function waitForReady(port, child) {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`monitoring-ui-api exited before readiness: ${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok && (await response.json()).ready === true) {
        return;
      }
    } catch {
      // Wait for the BFF to initialize its state directory.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`monitoring-ui-api did not become ready: ${output}`);
}

async function onceExit(child) {
  if (child.exitCode === null) {
    await new Promise(resolvePromise => child.once('exit', resolvePromise));
  }
}
