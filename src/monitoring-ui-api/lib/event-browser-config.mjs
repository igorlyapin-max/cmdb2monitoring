const supportedSaslMechanisms = {
  plain: 'plain',
  scramsha256: 'scram-sha-256',
  scramsha512: 'scram-sha-512'
};

const supportedSaslMechanismLabels = 'Plain, ScramSha256, ScramSha512';

export function applyEventBrowserTopicsEnvironmentOverride(target, {
  environment = 'Development',
  environmentVariables = process.env
} = {}) {
  const jsonTopics = environmentVariables.MONITORING_UI_EVENTS_TOPICS_JSON;
  const csvTopics = environmentVariables.MONITORING_UI_EVENTS_TOPICS;
  const production = String(environment).toLowerCase() === 'production';

  if (jsonTopics !== undefined && csvTopics !== undefined) {
    throw new Error('MONITORING_UI_EVENTS_TOPICS_JSON and MONITORING_UI_EVENTS_TOPICS cannot be used together.');
  }

  if (production && csvTopics !== undefined) {
    throw new Error('MONITORING_UI_EVENTS_TOPICS is a development-only override. Use MONITORING_UI_EVENTS_TOPICS_JSON in Production.');
  }

  if (jsonTopics !== undefined) {
    target.EventBrowser ??= {};
    target.EventBrowser.Topics = parseEventBrowserTopicsJson(jsonTopics);
    return;
  }

  if (csvTopics !== undefined) {
    target.EventBrowser ??= {};
    target.EventBrowser.Topics = String(csvTopics)
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .map(Name => ({ Name, Service: '', Direction: '', Description: '' }));
  }
}

export function hasDeploymentEventTopicsOverride(environmentVariables = process.env) {
  return environmentVariables.MONITORING_UI_EVENTS_TOPICS_JSON !== undefined;
}

export function parseEventBrowserTopicsJson(value) {
  let topics;
  try {
    topics = JSON.parse(String(value));
  } catch (error) {
    throw new Error('MONITORING_UI_EVENTS_TOPICS_JSON must be valid JSON: ' + error.message);
  }

  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error('MONITORING_UI_EVENTS_TOPICS_JSON must be a non-empty JSON array.');
  }

  const names = new Set();
  return topics.map((topic, index) => {
    if (!isPlainObject(topic)) {
      throw new Error(`MONITORING_UI_EVENTS_TOPICS_JSON[${index}] must be an object.`);
    }

    const name = requiredString(topic.Name ?? topic.name, `MONITORING_UI_EVENTS_TOPICS_JSON[${index}].Name`);
    const key = name.toLowerCase();
    if (names.has(key)) {
      throw new Error(`MONITORING_UI_EVENTS_TOPICS_JSON contains duplicate topic ${JSON.stringify(name)}.`);
    }
    names.add(key);

    return {
      Name: name,
      Service: optionalString(topic.Service ?? topic.service, `MONITORING_UI_EVENTS_TOPICS_JSON[${index}].Service`),
      Direction: optionalString(topic.Direction ?? topic.direction, `MONITORING_UI_EVENTS_TOPICS_JSON[${index}].Direction`),
      Description: optionalString(topic.Description ?? topic.description, `MONITORING_UI_EVENTS_TOPICS_JSON[${index}].Description`)
    };
  });
}

export function kafkaSaslMechanism(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return supportedSaslMechanisms[normalized] ?? '';
}

export function validateEventBrowserConfiguration(eventBrowser = {}) {
  if (!eventBrowser.Enabled || !isSaslProtocol(eventBrowser.SecurityProtocol)) {
    return;
  }

  const protocol = String(eventBrowser.SecurityProtocol ?? 'Plaintext');
  if (!kafkaSaslMechanism(eventBrowser.SaslMechanism)) {
    throw new Error(
      `EventBrowser.SaslMechanism for SecurityProtocol '${protocol}' must be one of: ${supportedSaslMechanismLabels}. Actual value: ${JSON.stringify(eventBrowser.SaslMechanism ?? '')}.`
    );
  }

  if (isBlank(eventBrowser.Username) || isBlank(eventBrowser.Password)) {
    throw new Error(`EventBrowser Username and Password are required for SecurityProtocol '${protocol}'.`);
  }
}

export function isSaslProtocol(value) {
  return String(value ?? '').toLowerCase().includes('sasl');
}

function requiredString(value, field) {
  const normalized = optionalString(value, field);
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function optionalString(value, field) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  return value.trim();
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
