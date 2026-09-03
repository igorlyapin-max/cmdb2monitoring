import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEventBrowserTopicsEnvironmentOverride,
  kafkaSaslMechanism,
  parseEventBrowserTopicsJson,
  validateEventBrowserConfiguration
} from '../lib/event-browser-config.mjs';

test('structured deployment topics preserve names and display metadata', () => {
  const topics = parseEventBrowserTopicsJson(JSON.stringify([
    { Name: 'customer.pipeline', Service: 'converter', Direction: 'output', Description: 'Pipeline' },
    { Name: 'customer.pipeline.dlq', Service: 'converter', Direction: 'dead-letter', Description: 'Rejected events' }
  ]));

  assert.deepEqual(topics, [
    { Name: 'customer.pipeline', Service: 'converter', Direction: 'output', Description: 'Pipeline' },
    { Name: 'customer.pipeline.dlq', Service: 'converter', Direction: 'dead-letter', Description: 'Rejected events' }
  ]);
});

test('production accepts JSON topics and rejects CSV topic override', () => {
  const target = { EventBrowser: { Topics: [] } };
  applyEventBrowserTopicsEnvironmentOverride(target, {
    environment: 'Production',
    environmentVariables: {
      MONITORING_UI_EVENTS_TOPICS_JSON: '[{"Name":"customer.pipeline"}]'
    }
  });
  assert.equal(target.EventBrowser.Topics[0].Name, 'customer.pipeline');

  assert.throws(() => applyEventBrowserTopicsEnvironmentOverride({ EventBrowser: {} }, {
    environment: 'Production',
    environmentVariables: { MONITORING_UI_EVENTS_TOPICS: 'customer.pipeline' }
  }), /development-only/);
});

test('development CSV override remains available but cannot be combined with JSON', () => {
  const target = { EventBrowser: {} };
  applyEventBrowserTopicsEnvironmentOverride(target, {
    environmentVariables: { MONITORING_UI_EVENTS_TOPICS: 'one, two' }
  });
  assert.deepEqual(target.EventBrowser.Topics.map(topic => topic.Name), ['one', 'two']);

  assert.throws(() => applyEventBrowserTopicsEnvironmentOverride({ EventBrowser: {} }, {
    environmentVariables: {
      MONITORING_UI_EVENTS_TOPICS_JSON: '[{"Name":"one"}]',
      MONITORING_UI_EVENTS_TOPICS: 'two'
    }
  }), /cannot be used together/);
});

test('SASL mechanisms accept supported aliases and reject an empty mechanism', () => {
  assert.equal(kafkaSaslMechanism('Plain'), 'plain');
  assert.equal(kafkaSaslMechanism('SCRAM-SHA-256'), 'scram-sha-256');
  assert.equal(kafkaSaslMechanism('scram_sha_512'), 'scram-sha-512');

  assert.throws(() => validateEventBrowserConfiguration({
    Enabled: true,
    SecurityProtocol: 'SaslSsl',
    SaslMechanism: '',
    Username: 'reader',
    Password: 'secret'
  }), /SaslMechanism.*SaslSsl.*Plain, ScramSha256, ScramSha512/);
});

test('SASL credentials are validated only when Event Browser is enabled', () => {
  assert.doesNotThrow(() => validateEventBrowserConfiguration({
    Enabled: false,
    SecurityProtocol: 'SaslSsl'
  }));
  assert.throws(() => validateEventBrowserConfiguration({
    Enabled: true,
    SecurityProtocol: 'SaslPlaintext',
    SaslMechanism: 'Plain',
    Username: '',
    Password: ''
  }), /Username and Password are required/);
});
