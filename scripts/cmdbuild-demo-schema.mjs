#!/usr/bin/env node
import {
  CmdbuildClient,
  className,
  domainName,
  ensureAttribute,
  ensureClass,
  ensureDomain,
  ensureLookupType,
  ensureLookupValue,
  lookupName,
  parseCommonArgs,
  statusLine
} from './lib/cmdbuild-rest.mjs';

const args = parseCommonArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage:
  node scripts/cmdbuild-demo-schema.mjs [--dry-run|--apply] [--base-url URL] [--username USER] [--password PASSWORD] [--prefix C2MTest]

Creates an abstract CMDBuild test model under the existing prototype class CI / КЕ.
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
  ciAddressDomain: domainName(args.prefix, 'CIAddressDomain'),
  addressRefDomain: domainName(args.prefix, 'AddressReferenceDomain'),
  ref1Domain: domainName(args.prefix, 'ReferenceLevel1Domain'),
  ref2Domain: domainName(args.prefix, 'ReferenceLevel2Domain')
};

console.log(statusLine(args));

await ensureLookupType(client, args, {
  name: names.lifecycle,
  description: 'C2M demo lifecycle states for conversion-rule tests'
});
await ensureLookupType(client, args, {
  name: names.policy,
  description: 'C2M demo monitoring policy values'
});
await ensureLookupType(client, args, {
  name: names.addressRole,
  description: 'C2M demo address roles'
});
await ensureLookupType(client, args, {
  name: names.addressState,
  description: 'C2M demo address states'
});

for (const value of [
  { code: 'production', description: 'Production: normal monitoring candidate' },
  { code: 'test', description: 'Test environment: monitoring can be time-limited' },
  { code: 'retired', description: 'Retired: usually not monitored' },
  { code: 'do_not_monitor', description: 'Do not monitor this object' }
]) {
  await ensureLookupValue(client, args, names.lifecycle, value);
}

for (const value of [
  { code: 'monitor_always', description: 'Monitor all day' },
  { code: 'monitor_business_hours', description: 'Monitor only 08:00-18:00' },
  { code: 'do_not_monitor', description: 'Do not create monitoring' }
]) {
  await ensureLookupValue(client, args, names.policy, value);
}

for (const value of [
  { code: 'primary', description: 'Primary monitoring address' },
  { code: 'extra_interface', description: 'Additional interface in the same monitoring object' },
  { code: 'separate_profile', description: 'Address for a separate monitoring profile' },
  { code: 'backup', description: 'Backup address' }
]) {
  await ensureLookupValue(client, args, names.addressRole, value);
}

for (const value of [
  { code: 'active', description: 'Address can be used by monitoring rules' },
  { code: 'standby', description: 'Standby address; selection point for rules' },
  { code: 'do_not_monitor', description: 'Address exists, but must not be monitored' }
]) {
  await ensureLookupValue(client, args, names.addressState, value);
}

for (const definition of [
  {
    name: names.ci,
    description: 'КЕ demo: основной тестовый класс для проверки редактора правил',
    parent: 'CI'
  },
  {
    name: names.address,
    description: 'КЕ demo: связанный адрес или endpoint',
    parent: 'CI'
  },
  {
    name: names.ref1,
    description: 'КЕ demo: первый уровень reference-цепочки',
    parent: 'CI'
  },
  {
    name: names.ref2,
    description: 'КЕ demo: второй уровень reference-цепочки',
    parent: 'CI'
  }
]) {
  await ensureClass(client, args, definition);
}

await ensureDomain(client, args, {
  name: names.ciAddressDomain,
  description: 'КЕ demo: N:N связь основного КЕ с адресами',
  source: names.ci,
  destination: names.address,
  cardinality: 'N:N',
  descriptionDirect: 'has demo addresses',
  descriptionInverse: 'belongs to demo CI'
});
await ensureDomain(client, args, {
  name: names.addressRefDomain,
  description: 'КЕ demo: reference from demo CI to one address',
  source: names.address,
  destination: names.ci,
  cardinality: '1:N',
  descriptionDirect: 'is referenced by demo CI',
  descriptionInverse: 'references demo address'
});
await ensureDomain(client, args, {
  name: names.ref1Domain,
  description: 'КЕ demo: reference from demo CI to level 1',
  source: names.ref1,
  destination: names.ci,
  cardinality: '1:N',
  descriptionDirect: 'is referenced by demo CI',
  descriptionInverse: 'references level 1'
});
await ensureDomain(client, args, {
  name: names.ref2Domain,
  description: 'КЕ demo: reference from level 1 to level 2',
  source: names.ref2,
  destination: names.ref1,
  cardinality: '1:N',
  descriptionDirect: 'is referenced by level 1',
  descriptionInverse: 'references level 2'
});

await ensureAttribute(client, args, names.ci, textAttribute('PrimaryIp', 'АтрибутScalar: основной IP КЕ', 'ipAddress', 10));
await ensureAttribute(client, args, names.ci, textAttribute('DnsName', 'АтрибутScalar: DNS имя КЕ', 'string', 11));
await ensureAttribute(client, args, names.ci, lookupAttribute('LifecycleState', 'АтрибутLookup: жизненный статус КЕ', names.lifecycle, 12));
await ensureAttribute(client, args, names.ci, lookupAttribute('MonitoringPolicy', 'АтрибутLookup: политика постановки на мониторинг', names.policy, 13));
await ensureAttribute(client, args, names.ci, textAttribute('ExtraInterface1Ip', 'Дополнительный IP для interface в том же Zabbix host', 'ipAddress', 14));
await ensureAttribute(client, args, names.ci, textAttribute('ExtraInterface2Ip', 'Второй дополнительный IP для interface в том же Zabbix host', 'ipAddress', 15));
await ensureAttribute(client, args, names.ci, textAttribute('SeparateProfile1Ip', 'IP для отдельного профиля мониторинга 1', 'ipAddress', 16));
await ensureAttribute(client, args, names.ci, textAttribute('SeparateProfile2Ip', 'IP для отдельного профиля мониторинга 2', 'ipAddress', 17));
await ensureAttribute(client, args, names.ci, referenceAttribute('AddressRef', 'АтрибутReference: ссылка на один адрес', names.addressRefDomain, 'inverse', names.address, 18));
await ensureAttribute(client, args, names.ci, referenceAttribute('Reference1', 'АтрибутReference1: первый уровень глубокой цепочки', names.ref1Domain, 'inverse', names.ref1, 19));

await ensureAttribute(client, args, names.address, textAttribute('AddressValue', 'АтрибутScalar связанного адреса', 'ipAddress', 10));
await ensureAttribute(client, args, names.address, lookupAttribute('AddressRole', 'АтрибутLookup: роль адреса', names.addressRole, 11));
await ensureAttribute(client, args, names.address, lookupAttribute('AddressState', 'АтрибутLookup: можно ли использовать адрес мониторингом', names.addressState, 12));

await ensureAttribute(client, args, names.ref1, referenceAttribute('Reference2', 'АтрибутReference2: второй уровень глубокой цепочки', names.ref2Domain, 'inverse', names.ref2, 10));
await ensureAttribute(client, args, names.ref1, lookupAttribute('ReferenceLookup', 'Lookup на первом уровне reference-цепочки', names.lifecycle, 11));
await ensureAttribute(client, args, names.ref2, textAttribute('LeafIp', 'Leaf scalar после двух reference-переходов', 'ipAddress', 10));
await ensureAttribute(client, args, names.ref2, lookupAttribute('LeafLookup', 'Leaf lookup после двух reference-переходов', names.lifecycle, 11));

console.log('Done.');

function textAttribute(name, description, type, index) {
  return {
    name,
    description,
    type,
    index,
    metadata: type === 'string' ? { cm_length: '250', cm_multiline: 'false' } : {}
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
