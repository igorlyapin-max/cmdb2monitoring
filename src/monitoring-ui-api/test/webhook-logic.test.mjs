import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCmdbuildWebhookOperations,
  buildWebhookRequirements,
  webhookDiffFields
} from '../public/lib/webhook-logic.js';

const catalog = {
  classes: [
    { name: 'Class' },
    { name: 'Other' }
  ],
  attributes: [
    {
      className: 'Class',
      items: [
        { name: 'Id' },
        { name: 'Code' },
        { name: 'Address' },
        { name: 'LookupRef' }
      ]
    },
    {
      className: 'Other',
      items: [
        { name: 'Name' }
      ]
    }
  ]
};
const defaultWebhookUrl = 'http://192.168.202.100:5080/webhooks/cmdbuild';
const managedIdentifier = 'cmdb2monitoring-zabbix-host-lifecycle';

function baseRules(overrides = {}) {
  return {
    source: {
      entityClasses: ['Class'],
      supportedEvents: ['update'],
      fields: {
        entityId: { source: 'id', cmdbAttribute: 'Id', required: true },
        code: { source: 'code', cmdbAttribute: 'Code', required: true },
        ...overrides.fields
      }
    },
    ...overrides.rules
  };
}

function currentUpdateWebhook(body = {}) {
  return {
    code: 'cmdbwebhooks2kafka-class-update',
    event: 'card_update_after',
    target: 'Class',
    method: 'post',
    url: defaultWebhookUrl,
    body: {
      source: 'cmdbuild',
      className: 'Class',
      eventType: 'update',
      cmdbuildEvent: 'card_update_after',
      id: '{card:Id}',
      code: '{card:Code}',
      ...body
    },
    active: true
  };
}

function currentNamespacedUpdateWebhook(body = {}) {
  return {
    ...currentUpdateWebhook(body),
    code: 'cmdbwebhooks2kafka-zabbix-host-class-update'
  };
}

test('webhook requirements derive reference leaf payload from the root reference attribute', () => {
  const rules = baseRules({
    fields: {
      refIp: { source: 'addressIp', type: 'ipAddress', cmdbPath: 'Class.Address.Ip' }
    },
    rules: {
      hostProfiles: [
        {
          name: 'class-main',
          when: { allRegex: [{ field: 'className', pattern: '(?i)^Class$' }] },
          interfaces: [{ valueField: 'refIp' }]
        }
      ]
    }
  });

  const requirements = buildWebhookRequirements(rules, catalog)[0].fields;
  const addressRequirement = requirements.find(item => item.payloadKey === 'addressIp');

  assert.equal(addressRequirement.placeholderAttribute, 'Address');
  assert.equal(addressRequirement.cmdbPath, 'Class.Address.Ip');
  assert.match(addressRequirement.reason, /Host profiles: class-main/);
});

test('cmdbPath reference root payload shadows normalized generic ipAddress requirement', () => {
  const vpnCatalog = {
    classes: [{ name: 'VPN_HUB' }],
    attributes: [
      {
        className: 'VPN_HUB',
        items: [
          { name: 'Id' },
          { name: 'Code' },
          { name: 'ipaddress', alias: 'ip_address', type: 'reference', targetClass: 'IpAddress' }
        ]
      }
    ]
  };
  const rules = {
    source: {
      entityClasses: ['VPN_HUB'],
      supportedEvents: ['update'],
      fields: {
        entityId: { source: 'id', required: true },
        code: { source: 'code' },
        className: { source: 'className', required: true },
        ipAddress: {
          source: 'ip_address',
          sources: ['ip_address', 'PrimaryIp'],
          cmdbAttribute: 'PrimaryIp',
          validationRegex: '^(?:\\d{1,3}\\.){3}\\d{1,3}$'
        },
        vPNHUBIpaddressIpAddr: {
          source: 'ipaddress',
          cmdbAttribute: 'ipaddress',
          cmdbPath: 'VPN_HUB.ipaddress.ipAddr',
          type: 'ipAddress',
          resolve: { mode: 'cmdbPath', valueMode: 'leaf', maxDepth: 2 }
        }
      }
    },
    hostProfiles: [
      {
        name: 'vpn_hub-main',
        when: { allRegex: [{ field: 'className', pattern: '(?i)^VPN_HUB$' }] },
        interfaces: [
          {
            name: 'vpn_hub-main-agent-ip',
            mode: 'ip',
            valueField: 'vPNHUBIpaddressIpAddr',
            when: { fieldExists: 'vPNHUBIpaddressIpAddr' }
          }
        ]
      }
    ],
    interfaceAddressRules: [
      {
        name: 'prefer-ip-address',
        mode: 'ip',
        valueField: 'ipAddress',
        when: { fieldExists: 'ipAddress' }
      }
    ]
  };

  const requirements = buildWebhookRequirements(rules, vpnCatalog)[0].fields;
  const ipRequirement = requirements.find(item => item.payloadKey === 'ipaddress');
  const operations = buildCmdbuildWebhookOperations(rules, vpnCatalog, []);
  const create = operations.find(item => item.action === 'create');

  assert.ok(ipRequirement);
  assert.equal(requirements.some(item => item.payloadKey === 'ip_address'), false);
  assert.equal(ipRequirement.placeholderAttribute, 'ipaddress');
  assert.match(ipRequirement.reason, /Host profiles: vpn_hub-main/);
  assert.match(ipRequirement.reason, /Interface address rules: prefer-ip-address/);
  assert.equal(create.desired.body.ipaddress, '{card:ipaddress}');
  assert.equal(Object.prototype.hasOwnProperty.call(create.desired.body, 'ip_address'), false);
});

test('literal ipAddress payload keeps the generic ip_address key', () => {
  const rules = baseRules({
    fields: {
      ipAddress: {
        source: 'ip_address',
        cmdbAttribute: 'ip_address',
        validationRegex: '^(?:\\d{1,3}\\.){3}\\d{1,3}$'
      }
    },
    rules: {
      interfaceAddressRules: [
        {
          name: 'prefer-ip-address',
          mode: 'ip',
          valueField: 'ipAddress',
          when: { fieldExists: 'ipAddress' }
        }
      ]
    }
  });
  const literalCatalog = {
    classes: [{ name: 'Class' }],
    attributes: [
      {
        className: 'Class',
        items: [
          { name: 'Id' },
          { name: 'Code' },
          { name: 'ip_address', type: 'inet' }
        ]
      }
    ]
  };

  const requirement = buildWebhookRequirements(rules, literalCatalog)[0].fields
    .find(item => item.payloadKey === 'ip_address');
  const operations = buildCmdbuildWebhookOperations(rules, literalCatalog, []);
  const create = operations.find(item => item.action === 'create');

  assert.ok(requirement);
  assert.equal(requirement.placeholderAttribute, 'ip_address');
  assert.equal(create.desired.body.ip_address, '{card:ip_address}');
});

test('webhook operations report missing payload requirements with rule context', () => {
  const rules = baseRules({
    fields: {
      refIp: { source: 'addressIp', type: 'ipAddress', cmdbPath: 'Class.Address.Ip' }
    },
    rules: {
      hostProfiles: [
        {
          name: 'class-main',
          when: { allRegex: [{ field: 'className', pattern: '(?i)^Class$' }] },
          interfaces: [{ valueField: 'refIp' }]
        }
      ]
    }
  });

  const operations = buildCmdbuildWebhookOperations(rules, catalog, [currentNamespacedUpdateWebhook()]);
  const update = operations.find(item => item.action === 'update');

  assert.ok(update);
  assert.deepEqual(update.missingPayloadRequirements.map(item => item.payloadKey), ['addressIp']);
  assert.match(update.missingPayloadRequirements[0].reason, /Host profiles: class-main/);
});

test('domain leaf requirements use the current card id as resolver payload', () => {
  const rules = baseRules({
    fields: {
      domainState: { source: 'domainState', type: 'lookup', cmdbPath: 'Class.{domain:Related}.State' }
    },
    rules: {
      groupSelectionRules: [
        {
          name: 'domain state host group',
          when: { allRegex: [{ field: 'className', pattern: '(?i)^Class$' }] },
          targetMode: 'dynamicFromLeaf',
          valueField: 'domainState'
        }
      ]
    }
  });

  const requirement = buildWebhookRequirements(rules, catalog)[0].fields
    .find(item => item.payloadKey === 'domainState');
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [currentNamespacedUpdateWebhook()]);
  const update = operations.find(item => item.action === 'update');

  assert.equal(requirement.placeholderAttribute, 'Id');
  assert.equal(requirement.domainResolver, true);
  assert.equal(update.desired.body.domainState, '{card:Id}');
  assert.equal(update.missingPayloadRequirements[0].domainResolver, true);
});

test('foreign-root cmdbPath does not add payload to unrelated class webhook', () => {
  const rules = baseRules({
    fields: {
      foreignName: { source: 'foreignName', cmdbPath: 'Other.Name.Value' }
    },
    rules: {
      tagSelectionRules: [
        {
          name: 'foreign tag',
          when: { allRegex: [{ field: 'className', pattern: '(?i)^Class$' }] },
          valueField: 'foreignName'
        }
      ]
    }
  });

  const requirements = buildWebhookRequirements(rules, catalog)[0].fields;

  assert.equal(requirements.some(item => item.payloadKey === 'foreignName'), false);
});

test('virtual runtime fields are not serialized into CMDBuild webhook payload', () => {
  const rules = baseRules({
    fields: {
      hostProfile: { source: 'hostProfile', required: true },
      outputProfile: { source: 'outputProfile', required: true }
    },
    rules: {
      templateSelectionRules: [
        {
          name: 'profile template',
          when: { allRegex: [{ field: 'hostProfile', pattern: '(?i)^class-main$' }] },
          template: 'Template OS'
        }
      ]
    }
  });

  const requirements = buildWebhookRequirements(rules, catalog)[0].fields;

  assert.equal(requirements.some(item => item.payloadKey === 'hostProfile'), false);
  assert.equal(requirements.some(item => item.payloadKey === 'outputProfile'), false);
});

test('obsolete managed webhooks are proposed for explicit delete only', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [
    currentUpdateWebhook(),
    {
      code: 'cmdbwebhooks2kafka-obsolete-update',
      event: 'card_update_after',
      target: 'Obsolete',
      url: defaultWebhookUrl,
      body: {}
    }
  ]);

  const deleted = operations.find(item => item.code === 'cmdbwebhooks2kafka-obsolete-update');

  assert.equal(deleted.action, 'delete');
  assert.equal(deleted.selected, false);
});

test('foreign managed webhook with same base code is not updated', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [
    {
      code: 'cmdbwebhooks2kafka-class-update',
      event: 'card_update_after',
      target: 'Class',
      method: 'post',
      url: 'http://172.18.0.1:5180/webhooks/cmdbuild',
      body: {
        source: 'cmdbuild',
        managedIdentifier: 'cmdb2monitoring-service-suppression',
        targetTopic: 'service-suppression.cmdb.events.raw',
        className: 'Class',
        eventType: 'update',
        id: '{card:Id}',
        code: '{card:Code}'
      }
    }
  ]);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].action, 'create');
  assert.equal(operations[0].code, 'cmdbwebhooks2kafka-zabbix-host-class-update');
  assert.equal(operations[0].desired.body.managedIdentifier, managedIdentifier);
});

test('foreign managed obsolete webhooks are ignored', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [
    currentUpdateWebhook(),
    {
      code: 'cmdbwebhooks2kafka-obsolete-update',
      event: 'card_update_after',
      target: 'Obsolete',
      body: {
        source: 'cmdbuild',
        managedIdentifier: 'cmdb2monitoring-service-suppression',
        targetTopic: 'service-suppression.cmdb.events.raw'
      }
    }
  ]);

  assert.equal(operations.some(item => item.code === 'cmdbwebhooks2kafka-obsolete-update'), false);
});

test('legacy owned webhooks are replaced by namespaced lifecycle webhooks', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [currentUpdateWebhook()]);
  const create = operations.find(item => item.action === 'create');
  const removeLegacy = operations.find(item => item.action === 'delete');

  assert.ok(create);
  assert.equal(create.code, 'cmdbwebhooks2kafka-zabbix-host-class-update');
  assert.equal(create.desired.body.managedIdentifier, managedIdentifier);
  assert.ok(removeLegacy);
  assert.equal(removeLegacy.code, 'cmdbwebhooks2kafka-class-update');
  assert.equal(removeLegacy.selected, false);
});

test('unmanaged current webhooks are not matched, deleted, or used as defaults', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [
    {
      code: 'other-system-class-update',
      event: 'card_update_after',
      target: 'Class',
      method: 'post',
      url: 'http://foreign.example/webhook',
      headers: { Authorization: 'Bearer foreign' },
      body: {
        source: 'foreign',
        id: '{card:Id}',
        code: '{card:Code}'
      }
    }
  ]);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].action, 'create');
  assert.equal(operations[0].code, 'cmdbwebhooks2kafka-zabbix-host-class-update');
  assert.equal(operations[0].desired.url, 'http://192.168.202.100:5080/webhooks/cmdbuild');
  assert.equal(operations.some(item => item.code === 'other-system-class-update'), false);
});

test('new managed webhooks use zabbix host code segment', () => {
  const rules = baseRules();
  const operations = buildCmdbuildWebhookOperations(rules, catalog, []);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].action, 'create');
  assert.equal(operations[0].code, 'cmdbwebhooks2kafka-zabbix-host-class-update');
});

test('authorization header drift is outside normal webhook configuration diff', () => {
  const current = {
    ...currentUpdateWebhook({ managedIdentifier }),
    headers: {
      Authorization: 'Bearer old',
      'X-Webhook-Mode': 'managed'
    }
  };
  const desiredWithNewToken = {
    ...current,
    headers: {
      Authorization: 'Bearer new',
      'X-Webhook-Mode': 'managed'
    }
  };
  const desiredWithHeaderConfigChange = {
    ...current,
    headers: {
      Authorization: 'Bearer old',
      'X-Webhook-Mode': 'manual'
    }
  };

  assert.deepEqual(webhookDiffFields(current, desiredWithNewToken), []);
  assert.deepEqual(webhookDiffFields(current, desiredWithHeaderConfigChange), ['headers']);
});
