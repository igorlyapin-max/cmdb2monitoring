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

    const current = await request(port, '/api/rules/current', {
      headers: { cookie }
    });
    assert.equal(current.status, 200, JSON.stringify(current.body));

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

function startServer(port, directory, activeRulesPath, usersPath) {
  return spawn(process.execPath, ['server.mjs'], {
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
      RULES_ACTIVE_WRITE_ENABLED: 'true'
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
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('monitoring-ui-api exited before readiness: ' + output);
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

  throw new Error('monitoring-ui-api did not become ready: ' + output);
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
