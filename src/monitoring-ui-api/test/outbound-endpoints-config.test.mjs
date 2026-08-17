import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertConfiguredEndpointOverride,
  assertOutboundEndpoint,
  normalizeAllowedOutboundHosts
} from '../lib/outbound-endpoints.mjs';

test('production outbound endpoints require HTTPS and a configured allowlist host', () => {
  const options = {
    name: 'CMDBuild',
    environment: 'Production',
    allowedHosts: ['cmdbuild.example.local', 'idp.example.local']
  };

  assert.equal(
    assertOutboundEndpoint('https://cmdbuild.example.local/cmdbuild/services/rest/v4', options),
    'https://cmdbuild.example.local/cmdbuild/services/rest/v4'
  );
  assert.throws(
    () => assertOutboundEndpoint('http://cmdbuild.example.local/cmdbuild/services/rest/v4', options),
    /requires HTTPS/
  );
  assert.throws(
    () => assertOutboundEndpoint('https://untrusted.example.local/rest', options),
    /is not allowed/
  );
});

test('SAML metadata uses the same production outbound policy', () => {
  const options = {
    name: 'SAML metadata',
    environment: 'Production',
    allowedHosts: ['idp.example.local']
  };

  assert.equal(
    assertOutboundEndpoint('https://idp.example.local/saml/metadata', options),
    'https://idp.example.local/saml/metadata'
  );
  assert.throws(
    () => assertOutboundEndpoint('http://idp.example.local/saml/metadata', options),
    /requires HTTPS/
  );
  assert.throws(
    () => assertOutboundEndpoint('https://untrusted.example.local/saml/metadata', options),
    /is not allowed/
  );
});

test('development allows local endpoint topology without weakening production validation', () => {
  assert.equal(
    assertOutboundEndpoint('http://localhost:8090/cmdbuild/services/rest/v4', {
      name: 'CMDBuild',
      environment: 'Development'
    }),
    'http://localhost:8090/cmdbuild/services/rest/v4'
  );
  assert.deepEqual(normalizeAllowedOutboundHosts('CMDBUILD.example.local, idp.example.local'), [
    'cmdbuild.example.local',
    'idp.example.local'
  ]);
});

test('a user session cannot replace deployment-owned integration endpoints', () => {
  const configured = 'https://cmdbuild.example.local/cmdbuild/services/rest/v4';
  assert.equal(assertConfiguredEndpointOverride('', configured, 'CMDBuild'), configured);
  assert.equal(assertConfiguredEndpointOverride(configured, configured, 'CMDBuild'), configured);
  assert.throws(
    () => assertConfiguredEndpointOverride('https://untrusted.example.local/cmdbuild/services/rest/v4', configured, 'CMDBuild'),
    /cannot be overridden/
  );
});
