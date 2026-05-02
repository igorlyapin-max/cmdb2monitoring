#!/usr/bin/env node
import {
  CmdbuildClient,
  className,
  domainName,
  encodePath,
  ensureCard,
  ensureRelation,
  findCardByCode,
  lookupName,
  lookupValueId,
  parseCommonArgs,
  statusLine
} from './lib/cmdbuild-rest.mjs';

const args = parseCommonArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage:
  node scripts/cmdbuild-demo-instances.mjs [--dry-run|--apply] [--base-url URL] [--username USER] [--password PASSWORD] [--prefix C2MTest]

Creates repeatable demonstration cards for the abstract CI / КЕ test model.
Run scripts/cmdbuild-demo-schema.mjs --apply before applying this script.
Dry-run is the default. Use --apply to write to CMDBuild.
`);
  process.exit(0);
}

const client = new CmdbuildClient(args);
const names = {
  ci: className(args.prefix, 'CI'),
  address: className(args.prefix, 'Address'),
  ref1: className(args.prefix, 'ReferenceLevel1'),
  ref2: className(args.prefix, 'ReferenceLevel2'),
  lifecycle: lookupName(args.prefix, 'LifecycleState'),
  policy: lookupName(args.prefix, 'MonitoringPolicy'),
  addressRole: lookupName(args.prefix, 'AddressRole'),
  addressState: lookupName(args.prefix, 'AddressState'),
  ciAddressDomain: domainName(args.prefix, 'CIAddressDomain')
};

console.log(statusLine(args));

if (args.apply) {
  await assertSchemaExists();
} else {
  console.log('schema check skipped in dry-run');
}

const lookup = {
  lifecycleProduction: await demoLookupValueId(names.lifecycle, 'production'),
  lifecycleTest: await demoLookupValueId(names.lifecycle, 'test'),
  lifecycleRetired: await demoLookupValueId(names.lifecycle, 'retired'),
  lifecycleDoNotMonitor: await demoLookupValueId(names.lifecycle, 'do_not_monitor'),
  policyAlways: await demoLookupValueId(names.policy, 'monitor_always'),
  policyBusinessHours: await demoLookupValueId(names.policy, 'monitor_business_hours'),
  policyDoNotMonitor: await demoLookupValueId(names.policy, 'do_not_monitor'),
  rolePrimary: await demoLookupValueId(names.addressRole, 'primary'),
  roleExtraInterface: await demoLookupValueId(names.addressRole, 'extra_interface'),
  roleSeparateProfile: await demoLookupValueId(names.addressRole, 'separate_profile'),
  roleBackup: await demoLookupValueId(names.addressRole, 'backup'),
  addressActive: await demoLookupValueId(names.addressState, 'active'),
  addressStandby: await demoLookupValueId(names.addressState, 'standby'),
  addressDoNotMonitor: await demoLookupValueId(names.addressState, 'do_not_monitor')
};

const addressReference = await addressCard('C2M-DEMO-ADDR-003', '10.20.3.10', lookup.rolePrimary, lookup.addressActive,
  'Проверочный адрес для scenario 003: используется как leaf в пути Класс.АтрибутReference.АтрибутScalar.');
const deepRef2 = await ref2Card('C2M-DEMO-REF2-004', '10.20.4.20', lookup.lifecycleProduction,
  'Второй уровень reference-цепочки для scenario 004: проверяет путь Класс.АтрибутReference1.АтрибутReference2.АтрибутScalar и lookup leaf.');
const deepRef1 = await ref1Card('C2M-DEMO-REF1-004', deepRef2._id, lookup.lifecycleTest,
  'Первый уровень reference-цепочки для scenario 004: содержит ссылку на ReferenceLevel2.');

await ciCard('C2M-DEMO-001-SCALAR', {
  Description: 'Проверка scalar attribute: этот экземпляр КЕ нужен, чтобы через UI создать правило по пути Класс.АтрибутScalar.',
  PrimaryIp: '10.20.1.10',
  DnsName: 'demo-scalar.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});

await ciCard('C2M-DEMO-002-LOOKUP', {
  Description: 'Проверка lookup attribute: этот экземпляр КЕ нужен, чтобы UI создал правило по Класс.АтрибутLookup и сохранил lookup metadata.',
  PrimaryIp: '10.20.2.10',
  DnsName: 'demo-lookup.example.test',
  LifecycleState: lookup.lifecycleTest,
  MonitoringPolicy: lookup.policyBusinessHours
});

await ciCard('C2M-DEMO-003-REFERENCE-LEAF', {
  Description: 'Проверка reference -> scalar: этот экземпляр КЕ ссылается на адрес, leaf читается как Класс.АтрибутReference.АтрибутScalar.',
  PrimaryIp: '10.20.3.1',
  DnsName: 'demo-reference.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways,
  AddressRef: addressReference._id
});

await ciCard('C2M-DEMO-004-DEEP-REFERENCE', {
  Description: 'Проверка reference -> reference -> scalar/lookup: экземпляр КЕ ссылается на цепочку из двух связанных объектов.',
  PrimaryIp: '10.20.4.1',
  DnsName: 'demo-deep-reference.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways,
  Reference1: deepRef1._id
});

const domainSingleAddress = await addressCard('C2M-DEMO-ADDR-005', '10.20.5.10', lookup.rolePrimary, lookup.addressActive,
  'Связанный domain-адрес для scenario 005: одна связь, domain path возвращает одно значение.');
const domainSingleCi = await ciCard('C2M-DEMO-005-DOMAIN-SINGLE', {
  Description: 'Проверка domain -> scalar: этот КЕ связан с одним адресом через domain, путь Класс.{domain:СвязанныйКласс}.АтрибутScalar возвращает одно значение.',
  PrimaryIp: '10.20.5.1',
  DnsName: 'demo-domain-single.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});
await domainRelation(domainSingleCi, domainSingleAddress);

const domainMultiAddress1 = await addressCard('C2M-DEMO-ADDR-006-A', '10.20.6.10', lookup.roleExtraInterface, lookup.addressActive,
  'Первый связанный domain-адрес для scenario 006: проверка множественного результата.');
const domainMultiAddress2 = await addressCard('C2M-DEMO-ADDR-006-B', '10.20.6.11', lookup.roleBackup, lookup.addressStandby,
  'Второй связанный domain-адрес для scenario 006: UI не должен давать такой multi-value field в скалярную Zabbix structure.');
const domainMultiCi = await ciCard('C2M-DEMO-006-DOMAIN-MULTI', {
  Description: 'Проверка domain -> collection: этот КЕ связан с двумя адресами; UI должен разрешать selection rules и запрещать scalar Zabbix targets без collectionMode=first.',
  PrimaryIp: '10.20.6.1',
  DnsName: 'demo-domain-multi.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});
await domainRelation(domainMultiCi, domainMultiAddress1);
await domainRelation(domainMultiCi, domainMultiAddress2);

await ciCard('C2M-DEMO-007-MULTI-IP-SAME-HOST', {
  Description: 'Проверка нескольких IP в одном объекте мониторинга: PrimaryIp, ExtraInterface1Ip и ExtraInterface2Ip должны попадать в один host profile как несколько interfaces[].',
  PrimaryIp: '10.20.7.10',
  ExtraInterface1Ip: '10.20.7.11',
  ExtraInterface2Ip: '10.20.7.12',
  DnsName: 'demo-multi-interface.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});

await ciCard('C2M-DEMO-008-SEPARATE-PROFILES', {
  Description: 'Проверка отдельных профилей мониторинга: SeparateProfile1Ip и SeparateProfile2Ip должны использоваться как отдельные hostProfiles, а не как interfaces одного host.',
  PrimaryIp: '10.20.8.10',
  SeparateProfile1Ip: '10.20.8.21',
  SeparateProfile2Ip: '10.20.8.22',
  DnsName: 'demo-separate-profiles.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});

await ciCard('C2M-DEMO-009-DONT-MONITOR-INSTANCE', {
  Description: 'Проверка исключения экземпляра: этот КЕ существует в CMDBuild, но MonitoringPolicy=do_not_monitor должен использоваться правилами как запрет постановки на мониторинг.',
  PrimaryIp: '10.20.9.10',
  DnsName: 'demo-do-not-monitor.example.test',
  LifecycleState: lookup.lifecycleDoNotMonitor,
  MonitoringPolicy: lookup.policyDoNotMonitor
});

await ciCard('C2M-DEMO-010-BUSINESS-HOURS', {
  Description: 'Проверка точки выбора по среде: тестовый КЕ с MonitoringPolicy=monitor_business_hours должен вести к сценарию мониторинга только 08:00-18:00.',
  PrimaryIp: '10.20.10.10',
  DnsName: 'demo-business-hours.example.test',
  LifecycleState: lookup.lifecycleTest,
  MonitoringPolicy: lookup.policyBusinessHours
});

const skipAddress = await addressCard('C2M-DEMO-ADDR-011', '10.20.11.10', lookup.roleSeparateProfile, lookup.addressDoNotMonitor,
  'Проверка исключения связанного атрибута: адрес существует, но AddressState=do_not_monitor значит его нельзя брать в monitoring profile.');
const skipCi = await ciCard('C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR', {
  Description: 'Проверка исключения связанного объекта: КЕ связан с address через domain, но leaf address помечен как do_not_monitor.',
  PrimaryIp: '10.20.11.1',
  DnsName: 'demo-domain-leaf-disabled.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});
await domainRelation(skipCi, skipAddress);

await ciCard('C2M-DEMO-012-DISABLED-STATUS', {
  Description: 'Проверка назначения Zabbix host status: КЕ должен быть создан в Zabbix, но как disabled host, а не подавлен suppression rule.',
  PrimaryIp: '10.20.12.10',
  DnsName: 'demo-disabled-status.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});

await ciCard('C2M-DEMO-013-DNS-ONLY', {
  Description: 'Проверка постановки на мониторинг только по DNS hostname: PrimaryIp пустой, поэтому Zabbix interface должен получить dns/useip=0.',
  PrimaryIp: null,
  DnsName: 'demo-dns-only.example.test',
  LifecycleState: lookup.lifecycleProduction,
  MonitoringPolicy: lookup.policyAlways
});

console.log('Done.');

async function assertSchemaExists() {
  for (const item of [names.ci, names.address, names.ref1, names.ref2]) {
    await client.get(`/classes/${encodePath(item)}`);
  }
}

async function demoLookupValueId(type, code) {
  if (!args.apply) {
    return `dry-run:${type}:${code}`;
  }

  return lookupValueId(client, type, code);
}

async function ciCard(code, fields) {
  return ensureCard(client, args, names.ci, {
    Code: code,
    ...fields
  });
}

async function addressCard(code, addressValue, addressRole, addressState, description) {
  return ensureCard(client, args, names.address, {
    Code: code,
    Description: description,
    AddressValue: addressValue,
    AddressRole: addressRole,
    AddressState: addressState
  });
}

async function ref1Card(code, reference2Id, referenceLookup, description) {
  return ensureCard(client, args, names.ref1, {
    Code: code,
    Description: description,
    Reference2: reference2Id,
    ReferenceLookup: referenceLookup
  });
}

async function ref2Card(code, leafIp, leafLookup, description) {
  return ensureCard(client, args, names.ref2, {
    Code: code,
    Description: description,
    LeafIp: leafIp,
    LeafLookup: leafLookup
  });
}

async function domainRelation(ci, address) {
  return ensureRelation(client, args, {
    sourceClass: names.ci,
    sourceId: ci._id,
    domain: names.ciAddressDomain,
    destinationClass: names.address,
    destinationId: address._id
  });
}
