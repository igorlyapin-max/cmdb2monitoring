import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyHealthEndpointsConfig,
  normalizeHealthEndpoints,
  parseHealthEndpointsJson
} from '../lib/health-endpoints-config.mjs';

function productionEndpoints(converter = {}) {
  return [
    { Name: 'cmdbwebhooks2kafka', Url: 'http://cmdbwebhooks2kafka:8080/health' },
    {
      Name: 'cmdbkafka2zabbix',
      Url: 'http://cmdbkafka2zabbix:8080/health',
      RulesReloadUrl: 'http://cmdbkafka2zabbix:8080/admin/reload-rules',
      RulesReloadTokenEnv: 'MONITORING_UI_RULES_RELOAD_TOKEN',
      RulesStatusUrl: 'http://cmdbkafka2zabbix:8080/admin/rules-status',
      RulesStatusTokenEnv: 'MONITORING_UI_RULES_STATUS_TOKEN',
      ...converter
    },
    { Name: 'zabbixrequests2api', Url: 'http://zabbixrequests2api:8080/health' },
    { Name: 'zabbixbindings2cmdbuild', Url: 'http://zabbixbindings2cmdbuild:8080/health' }
  ];
}

const productionEnvironment = {
  MONITORING_UI_RULES_RELOAD_TOKEN: 'reload-secret',
  MONITORING_UI_RULES_STATUS_TOKEN: 'status-secret'
};

test('development accepts localhost endpoint defaults and direct reload token', () => {
  const endpoints = normalizeHealthEndpoints([{
    Name: 'cmdbkafka2zabbix',
    Url: 'http://localhost:5081/health',
    RulesReloadUrl: 'http://localhost:5081/admin/reload-rules',
    RulesReloadToken: 'dev-rules-reload-token'
  }]);

  assert.deepEqual(endpoints, [{
    Name: 'cmdbkafka2zabbix',
    Url: 'http://localhost:5081/health',
    RulesReloadUrl: 'http://localhost:5081/admin/reload-rules',
    RulesReloadToken: 'dev-rules-reload-token'
  }]);
});

test('production JSON override uses all Compose services and separate token environment references', () => {
  const target = { Services: { HealthEndpoints: [] } };
  applyHealthEndpointsConfig(target, {
    environment: 'Production',
    environmentVariables: {
      ...productionEnvironment,
      MONITORING_UI_HEALTH_ENDPOINTS_JSON: JSON.stringify(productionEndpoints())
    }
  });

  const converter = target.Services.HealthEndpoints.find(endpoint => endpoint.Name === 'cmdbkafka2zabbix');
  assert.equal(target.Services.HealthEndpoints.length, 4);
  assert.equal(converter.RulesReloadToken, 'reload-secret');
  assert.equal(converter.RulesStatusToken, 'status-secret');
});

test('production rejects incomplete or non-Compose endpoint topology', () => {
  assert.throws(
    () => normalizeHealthEndpoints([], { environment: 'Production' }),
    /must contain exactly/
  );
  assert.throws(
    () => normalizeHealthEndpoints(productionEndpoints({ Url: 'http://localhost:5081/health' }), { environment: 'Production', environmentVariables: productionEnvironment }),
    /Compose DNS/
  );
  assert.throws(
    () => normalizeHealthEndpoints(productionEndpoints({ Url: 'http://[::ffff:127.0.0.1]:8080/health' }), { environment: 'Production', environmentVariables: productionEnvironment }),
    /Compose DNS/
  );
  assert.throws(
    () => normalizeHealthEndpoints(productionEndpoints({ Url: 'http://169.254.169.254:8080/health' }), { environment: 'Production', environmentVariables: productionEnvironment }),
    /Compose DNS/
  );
  assert.throws(
    () => normalizeHealthEndpoints(productionEndpoints({ Url: 'http://cmdbkafka2zabbix:8080/health?token=secret' }), { environment: 'Production', environmentVariables: productionEnvironment }),
    /query or fragment/
  );
});

test('production rejects duplicate names and reload without token', () => {
  const endpoints = productionEndpoints();
  endpoints[3] = { Name: 'CMDBKAFKA2ZABBIX', Url: 'http://cmdbkafka2zabbix:8080/health' };
  assert.throws(() => normalizeHealthEndpoints(endpoints, { environment: 'Production', environmentVariables: productionEnvironment }), /duplicates/);
  assert.throws(
    () => normalizeHealthEndpoints(productionEndpoints({ RulesReloadTokenEnv: '' }), { environment: 'Production' }),
    /requires RulesReloadToken/
  );
});

test('JSON override must be a valid endpoint array', () => {
  assert.throws(() => parseHealthEndpointsJson('{'), /must be valid JSON/);
  assert.throws(() => normalizeHealthEndpoints(parseHealthEndpointsJson('{}')), /must be a JSON array/);
});
