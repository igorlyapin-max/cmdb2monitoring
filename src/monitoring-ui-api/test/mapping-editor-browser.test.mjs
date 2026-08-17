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
  const cmdbuildCatalog = JSON.parse(await readFile(join(serviceRoot, 'data/cmdbuild-catalog-cache.json'), 'utf8'));
  const zabbixCatalog = JSON.parse(await readFile(join(serviceRoot, 'data/zabbix-catalog-cache.json'), 'utf8'));
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
    await mockApi(page, rules, cmdbuildCatalog, zabbixCatalog);
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
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
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
        body: JSON.stringify({ user: { role: 'editor', roleLabel: 'Editor' } })
      });
      return;
    }
    const payload = path === '/api/auth/status'
      ? {
        authenticated: true,
        user: {
          identity: { login: 'browser-test', displayName: 'Browser Test' },
          role: 'editor',
          roleLabel: 'Editor',
          authMethod: 'local'
        },
        csrfToken: 'browser-test'
      }
      : path === '/api/services/health'
        ? { items: [], managementRules: {} }
        : path === '/api/queue/status'
          ? { enabled: false, refreshIntervalMs: 0 }
          : path === '/api/settings/runtime-capabilities'
            ? { zabbix: { allowDynamicTagsFromCmdbLeaf: false, allowDynamicHostGroupsFromCmdbLeaf: false } }
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
