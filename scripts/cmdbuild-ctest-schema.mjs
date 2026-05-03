#!/usr/bin/env node
import {
  CmdbuildClient,
  ensureAttribute,
  ensureClass,
  ensureDomain,
  ensureCard,
  ensureLookupType,
  ensureLookupValue,
  ensureRelation,
  lookupValueId,
  parseCommonArgs,
  statusLine
} from './lib/cmdbuild-rest.mjs';

const args = parseCommonArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage:
  node scripts/cmdbuild-ctest-schema.mjs [--dry-run|--apply] [--base-url URL] [--username USER] [--password PASSWORD]

Creates the logical-test CMDBuild schema described in ./сtest.txt.
Dry-run is the default. Use --apply to write to CMDBuild.
`);
  process.exit(0);
}

const client = new CmdbuildClient(args);
const names = {
  superclass: 'ZabbixMonitoring',
  ipAddress: 'IpAddress',
  maintenance: 'Maintance',
  informationSystem: 'IS',
  server: 'serveri',
  netman: 'Netman',
  env: 'Env',
  os: 'OSyste',
  maint: 'Maint',
  vendors: 'ModelVendorNames'
};

console.log(statusLine(args));

const existingServer = await findClass(client, names.server);

await ensureLookupType(client, args, {
  name: names.env,
  description: 'Logical-test environments'
});
await ensureLookupType(client, args, {
  name: names.os,
  description: 'Logical-test operating systems'
});
await ensureLookupType(client, args, {
  name: names.maint,
  description: 'Logical-test maintenance windows'
});
await ensureLookupType(client, args, {
  name: names.vendors,
  description: 'Logical-test model/vendor names'
});

for (const value of ['Dev', 'ITtest', 'Btest', 'Pord']) {
  await ensureLookupValue(client, args, names.env, lookupValue(value));
}
for (const value of ['Windows', 'Windows server', 'Linux', 'AIX', 'VMWARE', 'Other']) {
  await ensureLookupValue(client, args, names.os, lookupValue(value));
}
for (const value of ['утром', 'вечером', 'никогда']) {
  await ensureLookupValue(client, args, names.maint, lookupValue(value));
}
for (const value of ['Cisco', 'HP', 'Huawai', 'IBM']) {
  await ensureLookupValue(client, args, names.vendors, lookupValue(value));
}

await ensureClass(client, args, {
  name: names.superclass,
  description: 'Superclass for logical Zabbix monitoring tests',
  prototype: true
});
await ensureAttribute(client, args, names.superclass, stringAttribute('zabbix_hostid', 'Zabbix hostid cache field', 10));

await ensureClass(client, args, {
  name: names.ipAddress,
  description: 'ip address',
  parent: names.superclass,
  description_attribute_name: 'ipAddr'
});
await ensureClass(client, args, {
  name: names.maintenance,
  description: 'Maintance',
  parent: names.superclass
});
await ensureClass(client, args, {
  name: names.informationSystem,
  description: 'ИС',
  parent: names.superclass
});
await ensureClass(client, args, {
  name: names.server,
  description: 'ServerI',
  parent: names.superclass
});
await ensureClass(client, args, {
  name: names.netman,
  description: 'Netman',
  parent: names.superclass
});

if (existingServer && !same(existingServer.parent, names.superclass)) {
  console.log(`class note: ${names.server} already exists under parent=${existingServer.parent || '<none>'}; parent is not changed`);
  await ensureAttribute(client, args, names.server, stringAttribute('zabbix_hostid', 'Zabbix hostid cache field', 10));
}

await ensureAttribute(client, args, names.ipAddress, {
  name: 'ipAddr',
  description: 'IP address value',
  type: 'ipAddress',
  index: 10
});
await ensureAttribute(client, args, names.ipAddress, stringAttribute('MACaddress', 'MAC address', 11));

await ensureAttribute(client, args, names.maintenance, stringAttribute('Name', 'Name', 10));
await ensureAttribute(client, args, names.maintenance, lookupAttribute('Time', 'Maintenance time', names.maint, 11));

await ensureAttribute(client, args, names.informationSystem, stringAttribute('Name', 'Name', 10));
await ensureAttribute(client, args, names.informationSystem, lookupAttribute('Environment', 'Окружение', names.env, 11));

await ensureAttribute(client, args, names.server, stringAttribute('hostname', 'hostname', 20));
await ensureReference(client, names.server, 'ipaddress', names.ipAddress, 'ServerIIpaddressDomain', 21);
await ensureReference(client, names.server, 'interface1', names.ipAddress, 'ServerIInterface1Domain', 22);
await ensureReference(client, names.server, 'interface2', names.ipAddress, 'ServerIInterface2Domain', 23);
await ensureReference(client, names.server, 'iLo', names.ipAddress, 'ServerIIloDomain', 24);
await ensureReference(client, names.server, 'mgmt', names.ipAddress, 'ServerIMgmtDomain', 25);
await ensureAttribute(client, args, names.server, stringAttribute('serialnum', 'serialnum', 26));
await ensureReference(client, names.server, 'Maintenance', names.maintenance, 'ServerIMaintanceDomain', 27, 'обслуживание');

await ensureAttribute(client, args, names.netman, stringAttribute('hostname', 'hostname', 20));
await ensureReference(client, names.netman, 'ipaddress', names.ipAddress, 'NetmanIpaddressDomain', 21);
await ensureReference(client, names.netman, 'mgmt', names.ipAddress, 'NetmanMgmtDomain', 22);
await ensureAttribute(client, args, names.netman, stringAttribute('serialnum', 'serialnum', 23));

await ensureDomain(client, args, {
  name: 'ISServerIDomain',
  description: 'N:N relation between IS and ServerI for logical monitoring tests',
  source: names.informationSystem,
  destination: names.server,
  cardinality: 'N:N',
  descriptionDirect: 'contains servers',
  descriptionInverse: 'belongs to information systems'
});
await ensureDomain(client, args, {
  name: 'ISNetmanDomain',
  description: 'N:N relation between IS and Netman for logical monitoring tests',
  source: names.informationSystem,
  destination: names.netman,
  cardinality: 'N:N',
  descriptionDirect: 'contains network devices',
  descriptionInverse: 'belongs to information systems'
});

await ensureDemoCards(client, args, names);

console.log('Done.');

async function ensureDemoCards(clientValue, argsValue, currentNames) {
  const envDev = await lookupValueId(clientValue, currentNames.env, 'Dev');
  const envProd = await lookupValueId(clientValue, currentNames.env, 'Pord');
  const maintMorning = await lookupValueId(clientValue, currentNames.maint, 'утром');
  const maintNever = await lookupValueId(clientValue, currentNames.maint, 'никогда');

  const ipMain = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-main', '10.20.0.10', '02:00:00:20:00:10'));
  const ipInterface1 = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-if1', '10.20.0.11', '02:00:00:20:00:11'));
  const ipInterface2 = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-if2', '10.20.0.12', '02:00:00:20:00:12'));
  const ipIlo = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-ilo', '10.20.0.13', '02:00:00:20:00:13'));
  const ipMgmt = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-mgmt', '10.20.0.14', '02:00:00:20:00:14'));
  const ipNoMonitor = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-ip-no-monitor', '10.20.0.99', '02:00:00:20:00:99'));
  const netMain = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-net-main', '10.30.0.10', '02:00:00:30:00:10'));
  const netMgmt = await ensureCard(clientValue, argsValue, currentNames.ipAddress, ipCard('ctest-net-mgmt', '10.30.0.11', '02:00:00:30:00:11'));

  const maintenanceMorning = await ensureCard(clientValue, argsValue, currentNames.maintenance, {
    Code: 'ctest-maint-morning',
    Description: 'Logical test maintenance morning',
    Name: 'Logical test maintenance morning',
    Time: maintMorning
  });
  const maintenanceNever = await ensureCard(clientValue, argsValue, currentNames.maintenance, {
    Code: 'ctest-maint-never',
    Description: 'Logical test maintenance never',
    Name: 'Logical test maintenance never',
    Time: maintNever
  });

  const isDev = await ensureCard(clientValue, argsValue, currentNames.informationSystem, {
    Code: 'ctest-is-dev',
    Description: 'Logical test IS Dev',
    Name: 'Logical test IS Dev',
    Environment: envDev
  });
  const isProd = await ensureCard(clientValue, argsValue, currentNames.informationSystem, {
    Code: 'ctest-is-prod',
    Description: 'Logical test IS Prod',
    Name: 'Logical test IS Prod',
    Environment: envProd
  });

  const serverMain = await ensureCard(clientValue, argsValue, currentNames.server, {
    Code: 'ctest-serveri-01',
    Description: 'ServerI logical test with primary, two data interfaces, iLo and mgmt references',
    hostname: 'ctest-serveri-01',
    ipaddress: cardId(ipMain),
    interface1: cardId(ipInterface1),
    interface2: cardId(ipInterface2),
    iLo: cardId(ipIlo),
    mgmt: cardId(ipMgmt),
    serialnum: 'CTEST-SERVERI-0001',
    Maintenance: cardId(maintenanceMorning)
  });
  const serverNoMonitor = await ensureCard(clientValue, argsValue, currentNames.server, {
    Code: 'ctest-serveri-no-monitor',
    Description: 'ServerI logical test object for no-monitor branch through maintenance=never',
    hostname: 'ctest-serveri-no-monitor',
    ipaddress: cardId(ipNoMonitor),
    serialnum: 'CTEST-SERVERI-0099',
    Maintenance: cardId(maintenanceNever)
  });

  const netman = await ensureCard(clientValue, argsValue, currentNames.netman, {
    Code: 'ctest-netman-01',
    Description: 'Netman logical test network device with management reference',
    hostname: 'ctest-netman-01',
    ipaddress: cardId(netMain),
    mgmt: cardId(netMgmt),
    serialnum: 'CTEST-NETMAN-0001'
  });

  await ensureRelation(clientValue, argsValue, {
    sourceClass: currentNames.informationSystem,
    sourceId: cardId(isDev),
    domain: 'ISServerIDomain',
    destinationClass: currentNames.server,
    destinationId: cardId(serverMain)
  });
  await ensureRelation(clientValue, argsValue, {
    sourceClass: currentNames.informationSystem,
    sourceId: cardId(isProd),
    domain: 'ISServerIDomain',
    destinationClass: currentNames.server,
    destinationId: cardId(serverNoMonitor)
  });
  await ensureRelation(clientValue, argsValue, {
    sourceClass: currentNames.informationSystem,
    sourceId: cardId(isDev),
    domain: 'ISNetmanDomain',
    destinationClass: currentNames.netman,
    destinationId: cardId(netman)
  });
}

async function ensureReference(clientValue, ownerClass, attributeName, targetClass, domain, index, description = attributeName) {
  await ensureDomain(clientValue, args, {
    name: domain,
    description: `${ownerClass}.${attributeName} reference to ${targetClass}`,
    source: targetClass,
    destination: ownerClass,
    cardinality: '1:N',
    descriptionDirect: `is referenced by ${ownerClass}`,
    descriptionInverse: `references ${targetClass}`
  });
  await ensureAttribute(clientValue, args, ownerClass, referenceAttribute(attributeName, description, domain, 'inverse', targetClass, index));
}

async function findClass(clientValue, name) {
  const classes = await clientValue.get('/classes');
  return asArray(classes).find(item => same(item.name, name) || same(item._id, name)) ?? null;
}

function lookupValue(value) {
  return {
    code: value,
    description: value
  };
}

function ipCard(code, ipAddr, macAddress) {
  return {
    Code: code,
    Description: ipAddr,
    ipAddr,
    MACaddress: macAddress
  };
}

function cardId(card) {
  return card?._id ?? card?.Id ?? card?.id;
}

function stringAttribute(name, description, index) {
  return {
    name,
    description,
    type: 'string',
    index,
    metadata: {
      cm_length: '250',
      cm_multiline: 'false'
    }
  };
}

function lookupAttribute(name, description, lookupType, index) {
  return {
    name,
    description,
    type: 'lookup',
    lookupType,
    index
  };
}

function referenceAttribute(name, description, domain, direction, targetClass, index) {
  return {
    name,
    description,
    type: 'reference',
    domain,
    direction,
    targetClass,
    targetType: 'class',
    index
  };
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.data)) {
    return value.data;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  return [];
}

function same(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}
