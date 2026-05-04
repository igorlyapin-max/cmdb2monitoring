import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCmdbuildWebhookOperations,
  buildWebhookRequirements
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
    url: 'http://localhost/webhook',
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

  const operations = buildCmdbuildWebhookOperations(rules, catalog, [currentUpdateWebhook()]);
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
  const operations = buildCmdbuildWebhookOperations(rules, catalog, [currentUpdateWebhook()]);
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
      body: {}
    }
  ]);

  const deleted = operations.find(item => item.code === 'cmdbwebhooks2kafka-obsolete-update');

  assert.equal(deleted.action, 'delete');
  assert.equal(deleted.selected, false);
});
