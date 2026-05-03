import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classHasHostProfile,
  ensureMinimalHostProfileForClass,
  hostProfileAppliesToClass,
  interfaceAddressCompatibilityIssue,
  minimalHostProfileInterfaceMode,
  sourceFieldAddressKind,
  sourceFieldMayReturnMultiple
} from '../public/lib/mapping-logic.js';

test('sourceFieldAddressKind recognizes IP fields by validation regex', () => {
  assert.equal(sourceFieldAddressKind('primaryAddress', {
    validationRegex: '^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$'
  }), 'ip');
});

test('sourceFieldAddressKind recognizes DNS fields by alias and metadata', () => {
  assert.equal(sourceFieldAddressKind('host_name', { source: 'FQDN' }), 'dns');
  assert.equal(sourceFieldAddressKind('dns_name', {}), 'dns');
});

test('sourceFieldAddressKind classifies lookup and reference leaves before address heuristics', () => {
  assert.equal(sourceFieldAddressKind('AddressState', { type: 'lookup', lookupType: 'AddressState' }), 'lookup');
  assert.equal(sourceFieldAddressKind('AddressRef', { type: 'reference', source: 'IPAddress' }), 'reference');
});

test('interfaceAddressCompatibilityIssue blocks IP-looking fields in DNS target', () => {
  assert.deepEqual(
    interfaceAddressCompatibilityIssue('ipAddress', { source: 'ip_address' }, 'interfaceAddress', { mode: 'dns' }),
    { code: 'ipFieldForDnsTarget', params: { field: 'ipAddress' } });
});

test('interfaceAddressCompatibilityIssue blocks DNS-looking fields in IP target', () => {
  assert.deepEqual(
    interfaceAddressCompatibilityIssue('dnsName', { source: 'fqdn' }, 'interfaceAddress', { mode: 'ip' }),
    { code: 'dnsFieldForIpTarget', params: { field: 'dnsName' } });
});

test('interfaceAddressCompatibilityIssue blocks unconfirmed address fields', () => {
  assert.deepEqual(
    interfaceAddressCompatibilityIssue('Room', { source: 'Room' }, 'interfaceAddress', { mode: 'ip' }),
    { code: 'unknownFieldForInterfaceTarget', params: { field: 'Room', target: 'IP' } });
});

test('interfaceAddressCompatibilityIssue allows matching IP and DNS targets', () => {
  assert.equal(interfaceAddressCompatibilityIssue('ipAddress', { source: 'ip_address' }, 'interfaceAddress', { mode: 'ip' }), null);
  assert.equal(interfaceAddressCompatibilityIssue('dnsName', { source: 'fqdn' }, 'interfaceAddress', { mode: 'dns' }), null);
});

test('sourceFieldMayReturnMultiple blocks domain collections unless collectionMode is first', () => {
  assert.equal(sourceFieldMayReturnMultiple({ cmdbPath: 'Class.{domain:Endpoint}.AddressValue' }), true);
  assert.equal(sourceFieldMayReturnMultiple({
    cmdbPath: 'Class.{domain:Endpoint}.AddressValue',
    resolve: { collectionMode: 'first' }
  }), false);
});

test('ensureMinimalHostProfileForClass creates an IP profile for a new class', () => {
  const rules = { hostProfiles: [] };
  const result = ensureMinimalHostProfileForClass(rules, 'Server', 'ipAddress', { source: 'ip_address' }, { mode: 'ip' });

  assert.equal(result.created, true);
  assert.equal(result.profileName, 'server-main');
  assert.equal(rules.hostProfiles.length, 1);
  assert.equal(rules.hostProfiles[0].createOnUpdateWhenMissing, true);
  assert.equal(rules.hostProfiles[0].when.allRegex[0].pattern, '(?i)^Server$');
  assert.deepEqual(rules.hostProfiles[0].interfaces[0], {
    name: 'server-main-agent-ip',
    priority: 10,
    interfaceProfileRef: 'agent',
    mode: 'ip',
    valueField: 'ipAddress',
    when: { fieldExists: 'ipAddress' }
  });
});

test('ensureMinimalHostProfileForClass uses DNS mode when target is DNS', () => {
  const rules = { hostProfiles: [] };
  const result = ensureMinimalHostProfileForClass(rules, 'DnsOnlyCI', 'dnsName', { source: 'fqdn' }, { mode: 'dns' });

  assert.equal(result.created, true);
  assert.equal(rules.hostProfiles[0].interfaces[0].mode, 'dns');
  assert.equal(rules.hostProfiles[0].interfaces[0].valueField, 'dnsName');
});

test('ensureMinimalHostProfileForClass does not create a profile when one already matches', () => {
  const rules = {
    hostProfiles: [
      {
        name: 'existing',
        when: { allRegex: [{ field: 'className', pattern: '(?i)^Server$' }] }
      }
    ]
  };

  const result = ensureMinimalHostProfileForClass(rules, 'Server', 'ipAddress', { source: 'ip_address' }, { mode: 'ip' });
  assert.equal(result.created, false);
  assert.equal(rules.hostProfiles.length, 1);
});

test('disabled profiles do not satisfy class matching and can be replaced', () => {
  const rules = {
    hostProfiles: [
      {
        name: 'disabled',
        enabled: false,
        when: { allRegex: [{ field: 'className', pattern: '(?i)^Server$' }] }
      }
    ]
  };

  assert.equal(classHasHostProfile(rules, 'Server'), false);
  const result = ensureMinimalHostProfileForClass(rules, 'Server', 'ipAddress', { source: 'ip_address' }, { mode: 'ip' });
  assert.equal(result.created, true);
  assert.equal(result.profileName, 'server-main');
  assert.equal(rules.hostProfiles.length, 2);
});

test('hostProfileAppliesToClass supports class regex alternatives and global profiles', () => {
  assert.equal(hostProfileAppliesToClass({
    when: { allRegex: [{ field: 'className', pattern: '(?i)^(Server|NetworkDevice)$' }] }
  }, 'NetworkDevice'), true);

  assert.equal(hostProfileAppliesToClass({ name: 'global' }, 'AnyConcreteClass'), true);
});

test('minimalHostProfileInterfaceMode returns empty mode for non-address leaves', () => {
  assert.equal(minimalHostProfileInterfaceMode('Location', { source: 'Room' }, {}), '');
});
