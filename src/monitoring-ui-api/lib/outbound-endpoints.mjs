function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

export function normalizeAllowedOutboundHosts(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');

  return [...new Set(entries
    .map(entry => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .map(entry => {
      if (!/^[a-z0-9.-]+$/i.test(entry) || entry.startsWith('.') || entry.endsWith('.')) {
        throw new Error(`Outbound host '${entry}' must be a hostname without a scheme, port, or path.`);
      }
      return entry;
    }))];
}

export function assertOutboundEndpoint(value, {
  name,
  environment = 'Development',
  allowedHosts = []
} = {}) {
  if (isBlank(value)) {
    return '';
  }

  let endpoint;
  try {
    endpoint = new URL(String(value).trim());
  } catch {
    throw new Error(`${name ?? 'Outbound'} endpoint must be an absolute HTTP(S) URL.`);
  }

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error(`${name ?? 'Outbound'} endpoint must use HTTP or HTTPS.`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`${name ?? 'Outbound'} endpoint must not embed credentials in its URL.`);
  }

  const normalizedHosts = normalizeAllowedOutboundHosts(allowedHosts);
  if (environment === 'Production') {
    if (endpoint.protocol !== 'https:') {
      throw new Error(`Production ${name ?? 'outbound'} endpoint requires HTTPS.`);
    }
    if (normalizedHosts.length === 0) {
      throw new Error('Production Security.OutboundAllowedHosts must list every outbound endpoint host.');
    }
    if (!normalizedHosts.includes(endpoint.hostname.toLowerCase())) {
      throw new Error(`Production ${name ?? 'outbound'} endpoint host '${endpoint.hostname}' is not allowed.`);
    }
  }

  return endpoint.toString();
}

export function assertConfiguredEndpointOverride(value, configuredValue, name) {
  if (isBlank(value)) {
    return configuredValue;
  }

  let supplied;
  let configured;
  try {
    supplied = new URL(String(value).trim());
    configured = new URL(String(configuredValue).trim());
  } catch {
    throw new Error(`${name} endpoint must be a valid URL.`);
  }

  if (supplied.href !== configured.href) {
    throw new Error(`${name} endpoint is managed by deployment configuration and cannot be overridden in a user session.`);
  }

  return configuredValue;
}
