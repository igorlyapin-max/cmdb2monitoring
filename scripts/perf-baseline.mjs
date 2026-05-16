#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = parseArgs(process.argv.slice(2));
const config = {
  samples: readInt(args.samples ?? process.env.PERF_SAMPLES, 10),
  cmdbBaseUrl: trimTrailingSlash(args.cmdbUrl ?? process.env.CMDBUILD_BASE_URL ?? 'http://localhost:8090/cmdbuild/services/rest/v3'),
  cmdbUser: args.cmdbUser ?? process.env.CMDBUILD_USERNAME ?? 'admin',
  cmdbPassword: args.cmdbPassword ?? process.env.CMDBUILD_PASSWORD ?? 'admin',
  cmdbClass: args.cmdbClass ?? process.env.PERF_CMDB_CLASS ?? 'NTbook',
  cmdbCardId: args.cmdbCardId ?? process.env.PERF_CMDB_CARD_ID ?? '',
  cmdbLookupType: args.cmdbLookupType ?? process.env.PERF_CMDB_LOOKUP_TYPE ?? 'GKMOS',
  zabbixEndpoint: args.zabbixEndpoint ?? process.env.ZABBIX_API_ENDPOINT ?? 'http://localhost:8081/api_jsonrpc.php',
  zabbixUser: args.zabbixUser ?? process.env.ZABBIX_USER ?? 'Admin',
  zabbixPassword: args.zabbixPassword ?? process.env.ZABBIX_PASSWORD ?? 'zabbix',
  zabbixHostId: args.zabbixHostId ?? process.env.PERF_ZABBIX_HOST_ID ?? '',
  reportDir: args.reportDir ?? process.env.PERF_REPORT_DIR ?? 'reports'
};

if (config.samples <= 0) {
  throw new Error('--samples must be greater than zero.');
}

const context = {
  generatedAt: new Date().toISOString(),
  gitCommit: git(['rev-parse', '--short', 'HEAD']),
  gitDirty: git(['status', '--porcelain']).length > 0,
  config: redactConfig(config)
};

const cmdbAuth = `Basic ${Buffer.from(`${config.cmdbUser}:${config.cmdbPassword}`).toString('base64')}`;
const cmdbCard = await resolveCmdbCard();
const bindingSeed = await resolveBindingSeed();
const zabbixLogin = await detectZabbixLogin();
const zabbixGroup = await resolveZabbixHostGroup(zabbixLogin.token);
const zabbixTemplate = await resolveZabbixTemplate(zabbixLogin.token);
const zabbixHost = await resolveZabbixHost(zabbixLogin.token);

const measurements = [];
measurements.push(await measure('cmdbuild.attributes', () => cmdbGet(`/classes/${encodeURIComponent(config.cmdbClass)}/attributes`)));
if (cmdbCard) {
  measurements.push(await measure('cmdbuild.card', () => cmdbGet(`/classes/${encodeURIComponent(config.cmdbClass)}/cards/${encodeURIComponent(cmdbCard.id)}`)));
  measurements.push(await measure('cmdbuild.relations', () => cmdbGet(`/classes/${encodeURIComponent(config.cmdbClass)}/cards/${encodeURIComponent(cmdbCard.id)}/relations`)));
}
measurements.push(await measure('cmdbuild.lookupValues', () => cmdbGet(`/lookup_types/${encodeURIComponent(config.cmdbLookupType)}/values`)));
measurements.push(await measure('cmdbuild.bindingFullScan', () => cmdbGet('/classes/ZabbixHostBinding/cards?limit=1000')));
if (bindingSeed) {
  measurements.push(await measure('cmdbuild.bindingExactFilter', () => cmdbGet(bindingLookupPath(bindingSeed))));
}
measurements.push(await measure('zabbix.userLogin', () => zabbixRpc('user.login', zabbixLogin.params, { authenticated: false })));
if (zabbixGroup) {
  measurements.push(await measure('zabbix.hostgroupGetById', () => zabbixRpc('hostgroup.get', {
    output: ['groupid', 'name'],
    groupids: [zabbixGroup.groupid]
  }, { token: zabbixLogin.token })));
  measurements.push(await measure('zabbix.hostgroupGetByName', () => zabbixRpc('hostgroup.get', {
    output: ['groupid', 'name'],
    filter: { name: [zabbixGroup.name] }
  }, { token: zabbixLogin.token })));
}
if (zabbixTemplate) {
  measurements.push(await measure('zabbix.templateGetRich', () => zabbixRpc('template.get', {
    output: ['templateid', 'host', 'name'],
    templateids: [zabbixTemplate.templateid],
    selectTemplateGroups: ['groupid', 'name'],
    selectItems: ['itemid', 'key_', 'name', 'inventory_link'],
    selectDiscoveryRules: ['itemid', 'key_', 'name']
  }, { token: zabbixLogin.token })));
}
if (zabbixHost) {
  measurements.push(await measure('zabbix.hostGetOne', () => zabbixRpc('host.get', {
    output: ['hostid', 'host', 'name'],
    hostids: [zabbixHost.hostid]
  }, { token: zabbixLogin.token })));
}

const report = {
  ...context,
  resolvedTargets: {
    cmdbCard,
    bindingSeed,
    zabbixLoginField: zabbixLogin.field,
    zabbixGroup,
    zabbixTemplate,
    zabbixHost
  },
  measurements
};

mkdirSync(config.reportDir, { recursive: true });
const reportPath = join(config.reportDir, `perf-baseline-${formatTimestamp(new Date())}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`Perf baseline report: ${reportPath}`);
for (const item of measurements) {
  const errorSuffix = item.errors > 0 ? `, errors ${item.errors}` : '';
  console.log(`${item.name}: avg ${item.avgMs.toFixed(1)} ms, p50 ${item.p50Ms.toFixed(1)} ms, p95 ${item.p95Ms.toFixed(1)} ms, bytes ${item.avgSizeBytes.toFixed(0)}${errorSuffix}`);
}

async function measure(name, fn) {
  const samples = [];
  for (let index = 0; index < config.samples; index += 1) {
    const start = performance.now();
    try {
      const result = await fn();
      samples.push({
        ok: true,
        ms: performance.now() - start,
        bytes: result.bytes
      });
    } catch (error) {
      samples.push({
        ok: false,
        ms: performance.now() - start,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const durations = samples.map((sample) => sample.ms).sort((left, right) => left - right);
  const success = samples.filter((sample) => sample.ok);
  return {
    name,
    samples: samples.length,
    success: success.length,
    errors: samples.length - success.length,
    avgMs: average(durations),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    minMs: durations[0] ?? 0,
    maxMs: durations.at(-1) ?? 0,
    avgSizeBytes: average(success.map((sample) => sample.bytes)),
    firstError: samples.find((sample) => !sample.ok)?.error ?? null
  };
}

async function cmdbGet(path) {
  const response = await fetch(`${config.cmdbBaseUrl}${path}`, {
    headers: { Authorization: cmdbAuth }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CMDBuild HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return { json: parseJson(text), bytes: Buffer.byteLength(text) };
}

async function zabbixRpc(method, params, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (options.authenticated !== false && options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(config.zabbixEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: 1
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zabbix HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = parseJson(text);
  if (json.error) {
    throw new Error(`Zabbix ${method} error: ${json.error.message ?? 'unknown'} ${json.error.data ?? ''}`.trim());
  }

  return { json, bytes: Buffer.byteLength(text) };
}

async function resolveCmdbCard() {
  if (config.cmdbCardId) {
    return { className: config.cmdbClass, id: config.cmdbCardId, source: 'configured' };
  }

  try {
    const response = await cmdbGet(`/classes/${encodeURIComponent(config.cmdbClass)}/cards?limit=1`);
    const first = response.json?.data?.[0];
    const id = readScalar(first?._id ?? first?.Id ?? first?.id);
    return id ? { className: config.cmdbClass, id, source: 'first-card' } : null;
  } catch {
    return null;
  }
}

async function resolveBindingSeed() {
  try {
    const response = await cmdbGet('/classes/ZabbixHostBinding/cards?limit=1');
    const first = response.json?.data?.[0];
    const ownerClass = readScalar(first?.OwnerClass);
    const ownerCardId = readScalar(first?.OwnerCardId);
    const hostProfile = readScalar(first?.HostProfile);
    if (ownerClass && ownerCardId && hostProfile) {
      return { ownerClass, ownerCardId, hostProfile };
    }
  } catch {
    return null;
  }

  return null;
}

async function detectZabbixLogin() {
  const usernameParams = { username: config.zabbixUser, password: config.zabbixPassword };
  try {
    const response = await zabbixRpc('user.login', usernameParams, { authenticated: false });
    return { field: 'username', params: usernameParams, token: readScalar(response.json.result) ?? '' };
  } catch {
    const userParams = { user: config.zabbixUser, password: config.zabbixPassword };
    const response = await zabbixRpc('user.login', userParams, { authenticated: false });
    return { field: 'user', params: userParams, token: readScalar(response.json.result) ?? '' };
  }
}

async function resolveZabbixHostGroup(token) {
  try {
    const response = await zabbixRpc('hostgroup.get', {
      output: ['groupid', 'name'],
      limit: 1
    }, { token });
    const first = response.json.result?.[0];
    const groupid = readScalar(first?.groupid);
    const name = readScalar(first?.name);
    return groupid && name ? { groupid, name } : null;
  } catch {
    return null;
  }
}

async function resolveZabbixTemplate(token) {
  try {
    const response = await zabbixRpc('template.get', {
      output: ['templateid', 'host', 'name'],
      limit: 1
    }, { token });
    const first = response.json.result?.[0];
    const templateid = readScalar(first?.templateid);
    return templateid
      ? {
          templateid,
          host: readScalar(first?.host) ?? '',
          name: readScalar(first?.name) ?? ''
        }
      : null;
  } catch {
    return null;
  }
}

async function resolveZabbixHost(token) {
  try {
    const params = {
      output: ['hostid', 'host', 'name'],
      limit: 1
    };
    if (config.zabbixHostId) {
      params.hostids = [config.zabbixHostId];
    }

    const response = await zabbixRpc('host.get', params, { token });
    const first = response.json.result?.[0];
    const hostid = readScalar(first?.hostid);
    return hostid
      ? {
          hostid,
          host: readScalar(first?.host) ?? '',
          name: readScalar(first?.name) ?? ''
        }
      : null;
  } catch {
    return null;
  }
}

function bindingLookupPath(seed) {
  const filter = {
    attribute: {
      and: [
        { simple: { attribute: 'OwnerClass', operator: 'equal', value: [seed.ownerClass] } },
        { simple: { attribute: 'OwnerCardId', operator: 'equal', value: [seed.ownerCardId] } },
        { simple: { attribute: 'HostProfile', operator: 'equal', value: [seed.hostProfile] } }
      ]
    }
  };

  return `/classes/ZabbixHostBinding/cards?limit=1&filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1);
  return values[index];
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      continue;
    }

    const [key, inlineValue] = item.slice(2).split('=', 2);
    parsed[key] = inlineValue ?? argv[index + 1] ?? '';
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readScalar(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function redactConfig(source) {
  return {
    ...source,
    cmdbPassword: source.cmdbPassword ? '<redacted>' : '',
    zabbixPassword: source.zabbixPassword ? '<redacted>' : ''
  };
}
