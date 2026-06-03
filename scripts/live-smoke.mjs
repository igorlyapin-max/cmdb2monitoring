#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.execute) {
  printDryRun(args);
  process.exit(0);
}

validateExecuteGuards(args);
const report = await runLiveSmoke(args);
await writeReport(args, report);
printSummary(report);

function parseArgs(argv) {
  const environment = value(argv, '--environment', process.env.C2M_SMOKE_ENVIRONMENT ?? 'dev');
  const isDev = String(environment).toLowerCase() === 'dev';
  const codeProvided = hasValue(argv, '--code') || Boolean(process.env.C2M_SMOKE_CODE);
  const code = value(argv, '--code', process.env.C2M_SMOKE_CODE ?? defaultCode());
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    execute: argv.includes('--execute'),
    environment,
    codeProvided,
    code,
    confirm: value(argv, '--confirm', process.env.C2M_SMOKE_CONFIRM ?? ''),
    allowedPrefix: value(argv, '--allowed-prefix', process.env.C2M_SMOKE_ALLOWED_PREFIX ?? 'C2M-SMOKE-'),
    className: value(argv, '--class-name', process.env.C2M_SMOKE_CLASS_NAME ?? 'C2MTestCI'),
    entityId: value(argv, '--entity-id', process.env.C2M_SMOKE_ENTITY_ID ?? code),
    createIp: value(argv, '--create-ip', process.env.C2M_SMOKE_CREATE_IP ?? '10.255.10.10'),
    updateIp: value(argv, '--update-ip', process.env.C2M_SMOKE_UPDATE_IP ?? '10.255.10.11'),
    webhookUrl: value(argv, '--webhook-url', process.env.C2M_SMOKE_WEBHOOK_URL ?? 'http://localhost:5080/webhooks/cmdbuild'),
    webhookAuthorization: authorizationValue(
      value(argv, '--webhook-authorization', process.env.C2M_SMOKE_WEBHOOK_AUTHORIZATION ?? ''),
      value(argv, '--webhook-token', process.env.C2M_SMOKE_WEBHOOK_TOKEN ?? '')),
    webhookReadyUrl: value(argv, '--webhook-ready-url', process.env.C2M_SMOKE_WEBHOOK_READY_URL ?? 'http://localhost:5080/ready'),
    converterReadyUrl: value(argv, '--converter-ready-url', process.env.C2M_SMOKE_CONVERTER_READY_URL ?? 'http://localhost:5081/ready'),
    zabbixWorkerReadyUrl: value(argv, '--zabbix-worker-ready-url', process.env.C2M_SMOKE_ZABBIX_WORKER_READY_URL ?? 'http://localhost:5082/ready'),
    bindingWorkerReadyUrl: value(argv, '--binding-worker-ready-url', process.env.C2M_SMOKE_BINDING_WORKER_READY_URL ?? 'http://localhost:5083/ready'),
    converterReloadUrl: value(argv, '--converter-reload-url', process.env.C2M_SMOKE_CONVERTER_RELOAD_URL ?? 'http://localhost:5081/admin/reload-rules'),
    converterReloadToken: value(argv, '--converter-reload-token', process.env.C2M_SMOKE_RULES_RELOAD_TOKEN ?? (isDev ? 'dev-rules-reload-token' : '')),
    skipRulesReload: argv.includes('--skip-rules-reload') || process.env.C2M_SMOKE_SKIP_RULES_RELOAD === 'true',
    zabbixUrl: value(argv, '--zabbix-url', process.env.C2M_SMOKE_ZABBIX_URL ?? 'http://localhost:8081/api_jsonrpc.php'),
    zabbixApiToken: value(argv, '--zabbix-api-token', process.env.C2M_SMOKE_ZABBIX_API_TOKEN ?? ''),
    zabbixUser: value(argv, '--zabbix-user', process.env.C2M_SMOKE_ZABBIX_USER ?? (isDev ? 'Admin' : '')),
    zabbixPassword: value(argv, '--zabbix-password', process.env.C2M_SMOKE_ZABBIX_PASSWORD ?? (isDev ? 'zabbix' : '')),
    timeoutMs: numberValue(argv, '--timeout-ms', process.env.C2M_SMOKE_TIMEOUT_MS ?? '120000'),
    pollMs: numberValue(argv, '--poll-ms', process.env.C2M_SMOKE_POLL_MS ?? '3000'),
    reportDir: value(argv, '--report-dir', process.env.C2M_SMOKE_REPORT_DIR ?? 'reports')
  };
}

function value(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }

  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }

  return next;
}

function hasValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && Boolean(argv[index + 1]) && !argv[index + 1].startsWith('--');
}

function numberValue(argv, name, fallback) {
  const parsed = Number(value(argv, name, fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return Math.floor(parsed);
}

function authorizationValue(explicitAuthorization, token) {
  if (explicitAuthorization) {
    return explicitAuthorization;
  }

  return token ? `Bearer ${token}` : '';
}

function defaultCode() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `C2M-SMOKE-${stamp}`;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/live-smoke.mjs --dry-run
  node scripts/live-smoke.mjs --execute --code C2M-SMOKE-001 --confirm C2M-SMOKE-001

Runs a guarded create -> update -> delete live smoke through cmdbwebhooks2kafka,
cmdbkafka2zabbix and zabbixrequests2api, then verifies the Zabbix host state.

Defaults target the local dev environment. Production-like runs must provide:
  --environment prod --code <test-code> --confirm <same-code>
  --zabbix-api-token or --zabbix-user/--zabbix-password
  --webhook-token or --webhook-authorization when webhook auth is enabled
`);
}

function printDryRun(options) {
  const host = expectedHostName(options);
  console.log('DRY-RUN live smoke plan. Add --execute and --confirm <code> to run.');
  console.log(`environment=${options.environment}`);
  console.log(`class=${options.className}`);
  console.log(`code=${options.code}`);
  console.log(`entityId=${options.entityId}`);
  console.log(`expectedHost=${host}`);
  console.log(`createIp=${options.createIp}`);
  console.log(`updateIp=${options.updateIp}`);
  console.log(`webhook=${options.webhookUrl}`);
  console.log(`zabbix=${options.zabbixUrl}`);
  console.log('steps=ready checks, rules reload, cleanup existing test host, create webhook, verify host, update webhook, verify IP, delete webhook, verify host absence');
}

function validateExecuteGuards(options) {
  if (options.confirm !== options.code) {
    throw new Error(`Refusing to execute: --confirm must equal smoke code '${options.code}'.`);
  }

  if (!options.code.startsWith(options.allowedPrefix)) {
    throw new Error(`Refusing to execute: code '${options.code}' must start with '${options.allowedPrefix}'.`);
  }

  if (String(options.environment).toLowerCase() !== 'dev' && !options.codeProvided) {
    throw new Error('Production-like smoke requires an explicit --code or C2M_SMOKE_CODE.');
  }

  if (!options.zabbixApiToken && (!options.zabbixUser || !options.zabbixPassword)) {
    throw new Error('Zabbix credentials are required: provide --zabbix-api-token or --zabbix-user/--zabbix-password.');
  }

  if (!options.skipRulesReload && !options.converterReloadToken && String(options.environment).toLowerCase() !== 'dev') {
    throw new Error('Production-like rules reload requires --converter-reload-token, or use --skip-rules-reload intentionally.');
  }
}

async function runLiveSmoke(options) {
  const report = {
    generatedAt: new Date().toISOString(),
    environment: options.environment,
    className: options.className,
    code: options.code,
    entityId: options.entityId,
    host: expectedHostName(options),
    checks: []
  };

  await recordCheck(report, 'cmdbwebhooks2kafka ready', () => assertReady(options.webhookReadyUrl));
  await recordCheck(report, 'cmdbkafka2zabbix ready', () => assertReady(options.converterReadyUrl));
  await recordCheck(report, 'zabbixrequests2api ready', () => assertReady(options.zabbixWorkerReadyUrl));
  if (options.bindingWorkerReadyUrl) {
    await recordCheck(report, 'zabbixbindings2cmdbuild ready', () => assertReady(options.bindingWorkerReadyUrl));
  }
  if (!options.skipRulesReload) {
    await recordCheck(report, 'conversion rules reload', () => reloadRules(options));
  }

  const auth = await recordCheck(report, 'zabbix auth', () => zabbixAuth(options));
  await recordCheck(report, 'cleanup existing smoke host', () => deleteHostIfExists(options, auth, report.host));
  await recordCheck(report, 'create webhook accepted', () => postWebhook(options, 'create', options.createIp));
  await recordCheck(report, 'zabbix host created', () => waitForHost(options, auth, report.host, options.createIp));
  await recordCheck(report, 'update webhook accepted', () => postWebhook(options, 'update', options.updateIp));
  await recordCheck(report, 'zabbix host updated', () => waitForHost(options, auth, report.host, options.updateIp));
  await recordCheck(report, 'delete webhook accepted', () => postWebhook(options, 'delete', ''));
  await recordCheck(report, 'zabbix host deleted', () => waitForHostAbsent(options, auth, report.host));

  report.ok = report.checks.every(check => check.ok);
  return report;
}

async function recordCheck(report, name, operation) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    report.checks.push({
      name,
      ok: true,
      latencyMs: Date.now() - startedAt,
      result: summarizeResult(result)
    });
    return result;
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function summarizeResult(result) {
  if (result === undefined || result === null) {
    return null;
  }

  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return result;
  }

  if (Array.isArray(result)) {
    return { count: result.length };
  }

  if (typeof result === 'object') {
    return Object.fromEntries(Object.entries(result)
      .filter(([key]) => !['auth', 'token', 'password'].includes(key.toLowerCase()))
      .slice(0, 8));
  }

  return String(result);
}

async function assertReady(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${body}`);
  }

  return { url, statusCode: response.status };
}

async function reloadRules(options) {
  const response = await fetch(options.converterReloadUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(options.converterReloadToken ? { authorization: `Bearer ${options.converterReloadToken}` } : {})
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`rules reload returned HTTP ${response.status}: ${body}`);
  }

  return { statusCode: response.status };
}

async function postWebhook(options, eventType, ipAddress) {
  const payload = {
    source: 'live-smoke',
    eventType,
    className: options.className,
    entityType: options.className,
    id: options.entityId,
    code: options.code,
    description: `${options.code} ${eventType} smoke`,
    ip_address: ipAddress || undefined,
    PrimaryIp: ipAddress || undefined,
    MonitoringPolicy: 'always',
    LifecycleState: 'active'
  };

  const response = await fetch(options.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.webhookAuthorization ? { authorization: options.webhookAuthorization } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`webhook ${eventType} returned HTTP ${response.status}: ${body}`);
  }

  return { eventType, statusCode: response.status };
}

async function zabbixAuth(options) {
  if (options.zabbixApiToken) {
    return { token: options.zabbixApiToken };
  }

  const token = await zabbixCall(options, null, 'user.login', {
    username: options.zabbixUser,
    password: options.zabbixPassword
  });
  return { token };
}

async function zabbixCall(options, auth, method, params) {
  const response = await fetch(options.zabbixUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json-rpc',
      ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now()
    })
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    throw new Error(`Zabbix ${method} returned HTTP ${response.status}: ${text}`);
  }
  if (payload.error) {
    throw new Error(`Zabbix ${method} failed: ${JSON.stringify(payload.error)}`);
  }

  return payload.result;
}

async function deleteHostIfExists(options, auth, host) {
  const hosts = await getHosts(options, auth, host);
  const ids = hosts.map(item => item.hostid).filter(Boolean);
  if (ids.length === 0) {
    return { deleted: 0 };
  }

  await zabbixCall(options, auth, 'host.delete', ids);
  return { deleted: ids.length };
}

async function waitForHost(options, auth, host, expectedIp) {
  const deadline = Date.now() + options.timeoutMs;
  let lastHosts = [];
  while (Date.now() < deadline) {
    lastHosts = await getHosts(options, auth, host);
    const matched = lastHosts.find(item => hostInterfaces(item).includes(expectedIp));
    if (matched) {
      return {
        hostid: matched.hostid,
        host: matched.host,
        ip: expectedIp
      };
    }

    await sleep(options.pollMs);
  }

  throw new Error(`Zabbix host '${host}' with interface '${expectedIp}' was not found. Last result: ${JSON.stringify(lastHosts)}`);
}

async function waitForHostAbsent(options, auth, host) {
  const deadline = Date.now() + options.timeoutMs;
  let lastHosts = [];
  while (Date.now() < deadline) {
    lastHosts = await getHosts(options, auth, host);
    if (lastHosts.length === 0) {
      return { host, absent: true };
    }

    await sleep(options.pollMs);
  }

  throw new Error(`Zabbix host '${host}' is still present: ${JSON.stringify(lastHosts)}`);
}

async function getHosts(options, auth, host) {
  return await zabbixCall(options, auth, 'host.get', {
    output: ['hostid', 'host', 'name', 'status'],
    selectInterfaces: ['interfaceid', 'ip', 'dns', 'useip', 'type'],
    filter: {
      host: [host]
    }
  });
}

function hostInterfaces(host) {
  return (host?.interfaces ?? [])
    .flatMap(item => [item.ip, item.dns])
    .filter(Boolean);
}

function expectedHostName(options) {
  return sanitizeHostName(`cmdb-${options.className}-${options.code}`);
}

function sanitizeHostName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function writeReport(options, report) {
  await fs.mkdir(options.reportDir, { recursive: true });
  const filename = `live-smoke-${sanitizeHostName(options.code)}.json`;
  const fullPath = path.join(options.reportDir, filename);
  await fs.writeFile(fullPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.reportPath = fullPath;
}

function printSummary(report) {
  console.log(`live smoke ${report.ok ? 'passed' : 'failed'} for ${report.host}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name} ${check.latencyMs}ms`);
  }
  if (report.reportPath) {
    console.log(`report=${report.reportPath}`);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
