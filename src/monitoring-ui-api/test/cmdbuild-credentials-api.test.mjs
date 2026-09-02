import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const serviceRoot = resolve(new URL('..', import.meta.url).pathname);
const repositoryRoot = resolve(serviceRoot, '../..');

test('CMDBuild credentials are validated before they are saved and distinguish 401 from 403', async () => {
  const directory = await mkdtemp(join(serviceRoot, 'state', '.monitoring-ui-api-cmdbuild-credentials-'));
  const cmdbuild = await startCmdbuildStub();
  const port = await reservePort();
  const usersPath = join(directory, 'users.json');
  const activeRulesPath = join(repositoryRoot, 'rules/cmdbuild-to-zabbix-host-create.production-empty.json');
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

  const process = startServer(port, directory, activeRulesPath, usersPath, {
    CMDBUILD_BASE_URL: `${cmdbuild.baseUrl}/cmdbuild/services/rest/v4`,
    MONITORING_UI_OUTBOUND_ALLOWED_HOSTS: '127.0.0.1'
  });
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

    const rejected = await saveCmdbuildCredentials(port, headers, 'rejected', 'password');
    assert.equal(rejected.status, 428);
    assert.equal(rejected.body.error, 'credentials_required');
    assert.equal((await authStatus(port, headers.cookie)).body.user.cmdbuild.credentialsConfigured, false);

    const denied = await saveCmdbuildCredentials(port, headers, 'denied', 'password');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'cmdbuild_access_denied');
    assert.equal((await authStatus(port, headers.cookie)).body.user.cmdbuild.credentialsConfigured, false);

    const accepted = await saveCmdbuildCredentials(port, headers, 'reader', 'password');
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.user.cmdbuild.credentialsConfigured, true);

    cmdbuild.setReaderStatus(401);
    const staleCredentials = await request(port, '/api/cmdbuild/catalog/sync', {
      method: 'POST',
      headers
    });
    assert.equal(staleCredentials.status, 428);
    assert.equal(staleCredentials.body.error, 'credentials_required');

    cmdbuild.setReaderStatus(200);
    const refreshed = await saveCmdbuildCredentials(port, headers, 'reader', 'password');
    assert.equal(refreshed.status, 200);

    cmdbuild.setReaderStatus(403);
    const accessDenied = await request(port, '/api/cmdbuild/catalog/sync', {
      method: 'POST',
      headers
    });
    assert.equal(accessDenied.status, 403);
    assert.equal(accessDenied.body.error, 'cmdbuild_access_denied');
  } finally {
    process.kill('SIGTERM');
    await onceExit(process);
    await new Promise(resolvePromise => cmdbuild.server.close(resolvePromise));
    await rm(directory, { recursive: true, force: true });
  }
});

async function saveCmdbuildCredentials(port, headers, username, password) {
  return request(port, '/api/auth/session-credentials', {
    method: 'POST',
    headers,
    body: { service: 'cmdbuild', username, password }
  });
}

async function authStatus(port, cookie) {
  return request(port, '/api/auth/status', { headers: { cookie } });
}

async function startCmdbuildStub() {
  let readerStatus = 200;
  const server = createServer((request, response) => {
    if (request.url !== '/cmdbuild/services/rest/v4/classes') {
      response.writeHead(404).end();
      return;
    }

    const authorization = request.headers.authorization;
    const username = authorization ? Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':', 1)[0] : '';
    if (username === 'rejected') {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (username === 'denied') {
      response.writeHead(403, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (username === 'reader' && readerStatus !== 200) {
      response.writeHead(readerStatus, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    setReaderStatus: status => { readerStatus = status; }
  };
}

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
      RULES_ACTIVE_BASE_DIRECTORY: repositoryRoot,
      RULES_ACTIVE_FILE_PATH: activeRulesPath,
      RULES_ACTIVE_WRITE_ENABLED: 'false',
      ...overrides
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('monitoring-ui-api exited before readiness: ' + output);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
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
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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
