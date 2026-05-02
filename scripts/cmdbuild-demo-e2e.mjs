#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CmdbuildClient,
  className,
  parseCommonArgs,
  statusLine
} from './lib/cmdbuild-rest.mjs';

const args = parseArgs(process.argv.slice(2));
const cmdb = new CmdbuildClient(args);
const names = {
  ci: className(args.prefix, 'CI')
};

const allExpected = [
  mainHost('C2M-DEMO-001-SCALAR', 'scalar source field'),
  mainHost('C2M-DEMO-002-LOOKUP', 'lookup source field and business-hours policy tag'),
  mainHost('C2M-DEMO-003-REFERENCE-LEAF', 'reference leaf interface'),
  mainHost('C2M-DEMO-004-DEEP-REFERENCE', 'deep reference leaf and lookup tag'),
  mainHost('C2M-DEMO-005-DOMAIN-SINGLE', 'single domain relation leaf'),
  mainHost('C2M-DEMO-006-DOMAIN-MULTI', 'domain relation collection with collectionMode=first'),
  mainHost('C2M-DEMO-007-MULTI-IP-SAME-HOST', 'multiple IPs as interfaces[] in one host'),
  mainHost('C2M-DEMO-008-SEPARATE-PROFILES', 'base host for separate monitoring profiles'),
  suffixedHost('C2M-DEMO-008-SEPARATE-PROFILES', 'separate-profile-1', 'first separate Zabbix host profile'),
  suffixedHost('C2M-DEMO-008-SEPARATE-PROFILES', 'separate-profile-2', 'second separate Zabbix host profile'),
  mainHost('C2M-DEMO-010-BUSINESS-HOURS', 'business-hours policy tag'),
  mainHost('C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR', 'domain leaf do_not_monitor does not become interface'),
  mainHost('C2M-DEMO-012-DISABLED-STATUS', 'host status assignment from conversion rules'),
  mainHost('C2M-DEMO-013-DNS-ONLY', 'DNS-only hostname interface')
];
const allSuppressed = [
  mainHost('C2M-DEMO-009-DONT-MONITOR-INSTANCE', 'suppressed by monitoringPolicy=do_not_monitor')
];
const expected = filterScenarioRows(allExpected);
const suppressed = filterScenarioRows(allSuppressed);

if (args.help) {
  console.log(`
Usage:
  node scripts/cmdbuild-demo-e2e.mjs --apply [--cleanup-zabbix] [--code C2M-DEMO-013-DNS-ONLY]

Runs the abstract CI / КЕ end-to-end demo:
  1. reads C2MTestCI cards from CMDBuild;
  2. asks cmdbkafka2zabbix to reload conversion rules;
  3. optionally deletes old cmdb-c2mtestci-* demo hosts from Zabbix;
  4. posts create events to cmdbwebhooks2kafka;
  5. waits for Zabbix hosts and writes a report under reports/.

Dry-run is the default. Use --apply to send events and modify Zabbix.
`);
  process.exit(0);
}

console.log(statusLine(args));
console.log(`webhook=${args.webhookUrl}`);
console.log(`converterReload=${args.converterReloadUrl}`);
console.log(`zabbix=${args.zabbixUrl}`);

const cards = await loadCards();
if (cards.length === 0) {
  const filter = args.codes.size > 0 ? ` for code(s) ${[...args.codes].join(', ')}` : '';
  throw new Error(`No C2MTestCI demo card(s) found${filter}. Run scripts/cmdbuild-demo-instances.mjs --apply first.`);
}
if (!args.apply) {
  console.log(`dry-run: would send ${cards.length} C2MTestCI create event(s)`);
  for (const card of cards) {
    console.log(`  ${card.Code} -> ${hostName(card.Code)}`);
  }
  process.exit(0);
}

await assertServiceHealth(args.webhookHealthUrl, 'cmdbwebhooks2kafka');
await assertServiceHealth(args.converterHealthUrl, 'cmdbkafka2zabbix');
await assertServiceHealth(args.zabbixWorkerHealthUrl, 'zabbixrequests2api');
await reloadRules();

const zabbixToken = await zabbixLogin();
if (args.cleanupZabbix) {
  await deleteHosts(zabbixToken, [...expected, ...suppressed].map(item => item.host));
}

for (const card of cards) {
  await postWebhook(card);
}

const report = await waitForExpectedHosts(zabbixToken);
const reportPath = await writeReport(report);
printSummary(report, reportPath);

function parseArgs(argv) {
  const common = parseCommonArgs(commonArgs(argv));
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : process.env[nameToEnv(name)] ?? fallback;
  };
  const values = name => argv
    .map((item, index) => item === name ? argv[index + 1] : null)
    .filter(item => item && !item.startsWith('--'));
  const codes = [
    ...values('--code'),
    ...String(process.env.C2M_DEMO_CODE ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  ];

  return {
    ...common,
    webhookUrl: value('--webhook-url', 'http://localhost:5080/webhooks/cmdbuild'),
    webhookHealthUrl: value('--webhook-health-url', 'http://localhost:5080/health'),
    converterReloadUrl: value('--converter-reload-url', 'http://localhost:5081/admin/reload-rules'),
    converterHealthUrl: value('--converter-health-url', 'http://localhost:5081/health'),
    converterReloadToken: value('--converter-reload-token', 'dev-rules-reload-token'),
    zabbixWorkerHealthUrl: value('--zabbix-worker-health-url', 'http://localhost:5082/health'),
    zabbixUrl: value('--zabbix-url', 'http://localhost:8081/api_jsonrpc.php'),
    zabbixUser: value('--zabbix-user', 'Admin'),
    zabbixPassword: value('--zabbix-password', 'zabbix'),
    reportDir: value('--report-dir', 'reports'),
    timeoutMs: Number(value('--timeout-ms', '120000')),
    pollMs: Number(value('--poll-ms', '3000')),
    codes: new Set(codes),
    cleanupZabbix: argv.includes('--cleanup-zabbix') || process.env.C2M_DEMO_CLEANUP_ZABBIX === 'true'
  };
}

function commonArgs(argv) {
  const result = [];
  const withValue = new Set(['--base-url', '--username', '--password', '--prefix']);
  const withoutValue = new Set(['--apply', '--dry-run', '--no-update-existing', '--help', '-h']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (withValue.has(item)) {
      result.push(item, argv[index + 1]);
      index += 1;
    } else if (withoutValue.has(item)) {
      result.push(item);
    } else if (item.startsWith('--')) {
      index += argv[index + 1] && !argv[index + 1].startsWith('--') ? 1 : 0;
    }
  }
  return result;
}

function nameToEnv(name) {
  return name.replace(/^--/, 'C2M_DEMO_').replaceAll('-', '_').toUpperCase();
}

async function loadCards() {
  const result = await cmdb.get(`/classes/${encodeURIComponent(names.ci)}/cards?limit=1000`);
  return asArray(result)
    .filter(card => String(card.Code ?? '').startsWith('C2M-DEMO-'))
    .filter(card => args.codes.size === 0 || args.codes.has(String(card.Code ?? '')))
    .sort((left, right) => String(left.Code).localeCompare(String(right.Code)));
}

function filterScenarioRows(rows) {
  if (args.codes.size === 0) {
    return rows;
  }

  return rows.filter(item => args.codes.has(item.code));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function assertServiceHealth(url, name) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} health check failed: ${response.status} ${await response.text()}`);
  }
}

async function reloadRules() {
  const response = await fetch(args.converterReloadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.converterReloadToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Rules reload failed: ${response.status} ${await response.text()}`);
  }
}

async function postWebhook(card) {
  const payload = {
    eventType: 'create',
    className: names.ci,
    id: String(card._id),
    code: card.Code,
    description: card.Description,
    ip_address: card.PrimaryIp,
    dns_name: card.DnsName,
    LifecycleState: card.LifecycleState,
    MonitoringPolicy: card.MonitoringPolicy,
    ExtraInterface1Ip: card.ExtraInterface1Ip,
    ExtraInterface2Ip: card.ExtraInterface2Ip,
    SeparateProfile1Ip: card.SeparateProfile1Ip,
    SeparateProfile2Ip: card.SeparateProfile2Ip,
    AddressRef: card.AddressRef,
    Reference1: card.Reference1
  };

  const response = await fetch(args.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Webhook failed for ${card.Code}: ${response.status} ${await response.text()}`);
  }
}

async function zabbixLogin() {
  const result = await zabbixCall(null, 'user.login', {
    username: args.zabbixUser,
    password: args.zabbixPassword
  });
  return result;
}

async function zabbixCall(auth, method, params) {
  const body = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now()
  };
  if (auth) {
    body.auth = auth;
  }

  const response = await fetch(args.zabbixUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json-rpc' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (json.error) {
    throw new Error(`Zabbix ${method} failed: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function deleteHosts(auth, hosts) {
  const existing = await getHosts(auth, hosts);
  const ids = existing.map(host => host.hostid);
  if (ids.length === 0) {
    return;
  }

  await zabbixCall(auth, 'host.delete', ids);
  console.log(`deleted ${ids.length} old Zabbix demo host(s)`);
}

async function getHosts(auth, hosts) {
  if (hosts.length === 0) {
    return [];
  }

  return await zabbixCall(auth, 'host.get', {
    output: ['hostid', 'host', 'name', 'status', 'tls_connect', 'tls_accept', 'tls_psk_identity'],
    selectGroups: ['groupid', 'name'],
    selectParentTemplates: ['templateid', 'name'],
    selectInterfaces: ['interfaceid', 'type', 'main', 'useip', 'ip', 'dns', 'port'],
    selectMacros: ['macro', 'value', 'description'],
    selectInventory: 'extend',
    selectTags: ['tag', 'value'],
    filter: { host: hosts }
  });
}

async function waitForExpectedHosts(auth) {
  const expectedHosts = expected.map(item => item.host);
  const suppressedHosts = suppressed.map(item => item.host);
  const deadline = Date.now() + args.timeoutMs;
  let hosts = [];

  while (Date.now() < deadline) {
    hosts = await getHosts(auth, [...expectedHosts, ...suppressedHosts]);
    const found = new Set(hosts.map(item => item.host));
    const allExpectedFound = expectedHosts.every(host => found.has(host));
    const allSuppressedMissing = suppressedHosts.every(host => !found.has(host));
    if (allExpectedFound && allSuppressedMissing) {
      break;
    }

    await sleep(args.pollMs);
  }

  return buildReport(hosts);
}

function buildReport(hosts) {
  const byHost = new Map(hosts.map(host => [host.host, host]));
  const expectedRows = expected.map(item => {
    const host = byHost.get(item.host);
    return {
      ...item,
      status: host ? 'present' : 'missing',
      technicalHost: host?.host ?? '',
      visibleName: host?.name ?? '',
      zabbixStatusValue: host ? String(host.status) : '',
      zabbixStatus: host ? formatHostStatus(host.status) : '',
      groups: host?.groups ?? [],
      templates: host?.parentTemplates ?? [],
      interfaces: host?.interfaces ?? [],
      tags: host?.tags ?? [],
      macros: host?.macros ?? [],
      inventory: normalizeInventory(host?.inventory),
      tls: {
        connect: host?.tls_connect,
        accept: host?.tls_accept,
        identity: host?.tls_psk_identity
      }
    };
  });
  const suppressedRows = suppressed.map(item => {
    const host = byHost.get(item.host);
    return {
      ...item,
      status: host ? 'unexpected_present' : 'absent'
    };
  });

  const checks = [
    checkAllTechnicalHostNames(expectedRows),
    checkAllVisibleNames(expectedRows)
  ];
  if (hasExpected(expectedRows, 'C2M-DEMO-007-MULTI-IP-SAME-HOST')) {
    checks.push(
      checkHostInterfaces(expectedRows, 'C2M-DEMO-007-MULTI-IP-SAME-HOST', ['10.20.7.10', '10.20.7.11', '10.20.7.12']),
      checkHostInterfaceType(expectedRows, 'C2M-DEMO-007-MULTI-IP-SAME-HOST', 'main', '10.20.7.11', 2)
    );
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-001-SCALAR')) {
    checks.push(
      checkHostGroup(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', '2', 'Linux servers'),
      checkHostTemplate(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', '10001', 'Linux by Zabbix agent'),
      checkHostMacro(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', '{$CMDB_CLASS}', names.ci),
      checkHostMacro(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', '{$C2M_DEMO_CODE}', 'C2M-DEMO-001-SCALAR'),
      checkInventoryField(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', 'alias', 'C2M-DEMO-001-SCALAR'),
      checkInventoryMatchesTag(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', 'asset_tag', 'cmdb.id'),
      checkHostStatus(expectedRows, 'C2M-DEMO-001-SCALAR', 'main', '0')
    );
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-008-SEPARATE-PROFILES', 'separate-profile-1')) {
    checks.push(
      checkHostGroup(expectedRows, 'C2M-DEMO-008-SEPARATE-PROFILES', 'separate-profile-1', '5', 'Discovered hosts'),
      checkHostTemplate(expectedRows, 'C2M-DEMO-008-SEPARATE-PROFILES', 'separate-profile-1', '10563', 'Generic by SNMP')
    );
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-010-BUSINESS-HOURS')) {
    checks.push(checkHostTag(expectedRows, 'C2M-DEMO-010-BUSINESS-HOURS', 'monitoring.policy', 'business_hours_08_18'));
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-004-DEEP-REFERENCE')) {
    checks.push(
      checkHostTag(expectedRows, 'C2M-DEMO-004-DEEP-REFERENCE', 'cmdb.deepReference.lookup', 'production'),
      checkHostTls(expectedRows, 'C2M-DEMO-004-DEEP-REFERENCE', 'main', '2', '2')
    );
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-012-DISABLED-STATUS')) {
    checks.push(checkHostStatus(expectedRows, 'C2M-DEMO-012-DISABLED-STATUS', 'main', '1'));
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR')) {
    checks.push(checkHostDoesNotHaveInterface(expectedRows, 'C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR', '10.20.11.10'));
  }
  if (hasExpected(expectedRows, 'C2M-DEMO-013-DNS-ONLY')) {
    checks.push(checkHostDnsInterface(expectedRows, 'C2M-DEMO-013-DNS-ONLY', 'demo-dns-only.example.test'));
  }

  return {
    generatedAt: new Date().toISOString(),
    cmdbuildClass: names.ci,
    expected: expectedRows,
    suppressed: suppressedRows,
    checks
  };
}

function hasExpected(rows, code, profile = 'main') {
  return rows.some(item => item.code === code && item.profile === profile);
}

function checkAllTechnicalHostNames(rows) {
  const failed = rows
    .filter(row => row.status === 'present')
    .filter(row => row.technicalHost !== row.host)
    .map(row => `${row.host}: got ${row.technicalHost || 'empty'}`);
  return {
    name: 'all expected hosts: Zabbix host name',
    ok: failed.length === 0,
    details: failed.length === 0 ? `${rows.length} host name assignment(s)` : failed.join('; ')
  };
}

function checkAllVisibleNames(rows) {
  const failed = rows
    .filter(row => row.status === 'present')
    .filter(row => row.visibleName !== expectedVisibleName(row))
    .map(row => `${row.host}: got ${row.visibleName || 'empty'}, expected ${expectedVisibleName(row)}`);
  return {
    name: 'all expected hosts: Zabbix visible name',
    ok: failed.length === 0,
    details: failed.length === 0 ? `${rows.length} visible name assignment(s)` : failed.join('; ')
  };
}

function checkHostInterfaces(rows, code, ips) {
  const row = rows.find(item => item.code === code && item.profile === 'main');
  const actual = new Set((row?.interfaces ?? []).map(item => item.ip).filter(Boolean));
  const missing = ips.filter(ip => !actual.has(ip));
  return {
    name: `${code}: expected interfaces`,
    ok: missing.length === 0,
    details: missing.length === 0 ? ips.join(', ') : `missing ${missing.join(', ')}`
  };
}

function checkHostInterfaceType(rows, code, profile, ip, type) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const found = (row?.interfaces ?? []).find(item => item.ip === ip);
  const actual = found ? String(found.type) : '';
  return {
    name: `${code}/${profile}: interface ${ip} type`,
    ok: actual === String(type),
    details: actual ? `type=${actual}` : 'missing'
  };
}

function checkHostGroup(rows, code, profile, groupid, name) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const found = (row?.groups ?? []).some(item => String(item.groupid) === String(groupid));
  return {
    name: `${code}/${profile}: group ${name}`,
    ok: found,
    details: found ? `${name} (${groupid})` : 'missing'
  };
}

function checkHostTemplate(rows, code, profile, templateid, name) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const found = (row?.templates ?? []).some(item => String(item.templateid) === String(templateid));
  return {
    name: `${code}/${profile}: template ${name}`,
    ok: found,
    details: found ? `${name} (${templateid})` : 'missing'
  };
}

function checkHostDoesNotHaveInterface(rows, code, ip) {
  const row = rows.find(item => item.code === code && item.profile === 'main');
  const actual = new Set((row?.interfaces ?? []).map(item => item.ip).filter(Boolean));
  return {
    name: `${code}: excluded domain leaf interface`,
    ok: !actual.has(ip),
    details: actual.has(ip) ? `${ip} is present` : `${ip} is absent`
  };
}

function checkHostDnsInterface(rows, code, dns) {
  const row = rows.find(item => item.code === code && item.profile === 'main');
  const found = (row?.interfaces ?? []).find(item => item.dns === dns);
  const useIp = found ? String(found.useip) : '';
  return {
    name: `${code}: DNS interface useip=0`,
    ok: Boolean(found) && useIp === '0',
    details: found ? `${dns}, useip=${useIp}, type=${found.type}` : 'missing'
  };
}

function checkHostTag(rows, code, tag, value) {
  const row = rows.find(item => item.code === code && item.profile === 'main');
  const found = (row?.tags ?? []).some(item => item.tag === tag && item.value === value);
  return {
    name: `${code}: tag ${tag}`,
    ok: found,
    details: found ? value : 'missing'
  };
}

function checkHostMacro(rows, code, profile, macro, value) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const found = (row?.macros ?? []).some(item => item.macro === macro && item.value === value);
  return {
    name: `${code}/${profile}: macro ${macro}`,
    ok: found,
    details: found ? value : 'missing'
  };
}

function checkInventoryField(rows, code, profile, field, value) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const actual = row?.inventory?.[field] ?? '';
  return {
    name: `${code}/${profile}: inventory ${field}`,
    ok: actual === value,
    details: actual || 'missing'
  };
}

function checkInventoryMatchesTag(rows, code, profile, field, tag) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const tagValue = (row?.tags ?? []).find(item => item.tag === tag)?.value ?? '';
  const actual = row?.inventory?.[field] ?? '';
  return {
    name: `${code}/${profile}: inventory ${field} matches ${tag}`,
    ok: actual !== '' && actual === tagValue,
    details: actual || 'missing'
  };
}

function checkHostStatus(rows, code, profile, status) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const actual = row?.zabbixStatusValue ?? '';
  return {
    name: `${code}/${profile}: Zabbix status ${status}`,
    ok: actual === String(status),
    details: row?.zabbixStatus || 'missing'
  };
}

function checkHostTls(rows, code, profile, connect, accept) {
  const row = rows.find(item => item.code === code && item.profile === profile);
  const actualConnect = String(row?.tls?.connect ?? '');
  const actualAccept = String(row?.tls?.accept ?? '');
  const actualIdentity = row?.tls?.identity ?? '';
  return {
    name: `${code}/${profile}: TLS/PSK mode`,
    ok: actualConnect === connect && actualAccept === accept,
    details: actualIdentity
      ? `connect=${actualConnect}, accept=${actualAccept}, identity=${actualIdentity}`
      : `connect=${actualConnect}, accept=${actualAccept}; identity is not returned by host.get`
  };
}

async function writeReport(report) {
  await fs.mkdir(args.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replace(/\..+$/, 'Z');
  const file = path.join(args.reportDir, `cmdbuild-demo-e2e-${stamp}.md`);
  const lines = [
    '# CMDBuild Demo E2E Report',
    '',
    `Generated: ${report.generatedAt}`,
    `CMDBuild class: ${report.cmdbuildClass}`,
    '',
    '## Zabbix Assignment Coverage',
    '',
    'Checked live on Zabbix hosts: technical host name, visible name, interfaces, host groups, templates, tags, host macros, inventory fields, host status, TLS/PSK mode. Zabbix host.get does not expose the PSK secret and may omit PSK identity, so the live assertion checks the effective TLS mode fields.',
    '',
    'Not checked by this host-create demo: proxy/proxy group, maintenance, value maps. They require dedicated Zabbix catalog objects or API operations outside the direct host payload currently applied by this runner.',
    '',
    '## Expected Zabbix Hosts',
    '',
    '| Expected Host | Zabbix Host Name | Visible Name | Scenario | Presence | Zabbix Status | Interfaces | Groups | Templates | Macros | Inventory | TLS/PSK | Tags |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.expected.map(row => `| ${row.host} | ${row.technicalHost} | ${row.visibleName} | ${row.scenario} | ${row.status} | ${row.zabbixStatus} | ${formatInterfaces(row.interfaces)} | ${formatGroups(row.groups)} | ${formatTemplates(row.templates)} | ${formatMacros(row.macros)} | ${formatInventory(row.inventory)} | ${formatTls(row.tls)} | ${formatTags(row.tags)} |`),
    '',
    '## Suppressed Hosts',
    '',
    '| Host | Scenario | Status |',
    '| --- | --- | --- |',
    ...report.suppressed.map(row => `| ${row.host} | ${row.scenario} | ${row.status} |`),
    '',
    '## Checks',
    '',
    '| Check | Result | Details |',
    '| --- | --- | --- |',
    ...report.checks.map(check => `| ${check.name} | ${check.ok ? 'OK' : 'FAIL'} | ${check.details} |`)
  ];
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function printSummary(report, reportPath) {
  const missing = report.expected.filter(row => row.status !== 'present');
  const unexpected = report.suppressed.filter(row => row.status !== 'absent');
  const failedChecks = report.checks.filter(check => !check.ok);
  console.log(`report=${reportPath}`);
  console.log(`expected_present=${report.expected.length - missing.length}/${report.expected.length}`);
  console.log(`suppressed_absent=${report.suppressed.length - unexpected.length}/${report.suppressed.length}`);
  console.log(`checks_ok=${report.checks.length - failedChecks.length}/${report.checks.length}`);
  if (missing.length || unexpected.length || failedChecks.length) {
    process.exitCode = 1;
  }
}

function formatInterfaces(interfaces) {
  return interfaces
    .map(item => {
      const address = item.ip || item.dns;
      return address ? `${address} (type ${item.type})` : '';
    })
    .filter(Boolean)
    .join('<br>');
}

function formatGroups(groups) {
  return groups
    .map(item => `${item.name ?? item.groupid} (${item.groupid})`)
    .join('<br>');
}

function formatTemplates(templates) {
  return templates
    .map(item => `${item.name ?? item.templateid} (${item.templateid})`)
    .join('<br>');
}

function formatTags(tags) {
  return tags
    .map(item => `${item.tag}=${item.value}`)
    .join('<br>');
}

function formatMacros(macros) {
  return macros
    .map(item => `${item.macro}=${item.value}`)
    .join('<br>');
}

function formatInventory(inventory) {
  return Object.entries(inventory ?? {})
    .filter(([, value]) => value !== null && value !== undefined && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('<br>');
}

function formatTls(tls) {
  if (!tls || (!tls.connect && !tls.accept && !tls.identity)) {
    return '';
  }

  return [
    tls.connect ? `connect=${tls.connect}` : '',
    tls.accept ? `accept=${tls.accept}` : '',
    tls.identity ? `identity=${tls.identity}` : ''
  ].filter(Boolean).join('<br>');
}

function formatHostStatus(status) {
  const value = String(status);
  return value === '0'
    ? 'monitored (0)'
    : value === '1'
      ? 'disabled (1)'
      : value;
}

function normalizeInventory(inventory) {
  return inventory && !Array.isArray(inventory) && typeof inventory === 'object'
    ? inventory
    : {};
}

function expectedVisibleName(row) {
  if (row.profile === 'separate-profile-1') {
    return `${names.ci} ${row.code} separate profile 1`;
  }

  if (row.profile === 'separate-profile-2') {
    return `${names.ci} ${row.code} separate profile 2`;
  }

  return `${names.ci} ${row.code}`;
}

function mainHost(code, scenario) {
  return {
    code,
    profile: 'main',
    host: hostName(code),
    scenario
  };
}

function suffixedHost(code, suffix, scenario) {
  return {
    code,
    profile: suffix,
    host: `${hostName(code)}-${suffix}`,
    scenario
  };
}

function hostName(code) {
  return `cmdb-c2mtestci-${code}`.toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
