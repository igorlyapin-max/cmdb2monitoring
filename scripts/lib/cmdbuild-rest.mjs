import process from 'node:process';

export function parseCommonArgs(argv) {
  const args = {
    apply: false,
    updateExisting: true,
    baseUrl: process.env.CMDBUILD_BASE_URL || 'http://localhost:8090/cmdbuild/services/rest/v3',
    username: process.env.CMDBUILD_USERNAME || 'admin',
    password: process.env.CMDBUILD_PASSWORD || 'admin',
    prefix: process.env.C2M_DEMO_PREFIX || 'C2MTest'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--apply') {
      args.apply = true;
    } else if (item === '--dry-run') {
      args.apply = false;
    } else if (item === '--no-update-existing') {
      args.updateExisting = false;
    } else if (item === '--base-url') {
      args.baseUrl = argv[++index] ?? args.baseUrl;
    } else if (item === '--username') {
      args.username = argv[++index] ?? args.username;
    } else if (item === '--password') {
      args.password = argv[++index] ?? args.password;
    } else if (item === '--prefix') {
      args.prefix = argv[++index] ?? args.prefix;
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, '');
  return args;
}

export class CmdbuildClient {
  constructor(options) {
    this.options = options;
  }

  async request(method, path, body = undefined, { allowNotFound = false } = {}) {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok || payload?.success === false) {
      const message = payload?.messages?.map(item => item.message || item._message_translation).filter(Boolean).join('; ')
        || payload?.error
        || text
        || response.statusText;
      throw new Error(`${method} ${path} failed: ${response.status} ${message}`);
    }

    return payload?.data ?? payload;
  }

  async get(path, options = {}) {
    return this.request('GET', path, undefined, options);
  }

  async post(path, body) {
    return this.request('POST', path, body);
  }

  async put(path, body) {
    return this.request('PUT', path, body);
  }
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function encodePath(value) {
  return encodeURIComponent(String(value));
}

export function statusLine(args) {
  return args.apply
    ? `APPLY to ${args.baseUrl} as ${args.username}`
    : `DRY-RUN for ${args.baseUrl} as ${args.username}. Add --apply to write.`;
}

export function className(prefix, suffix) {
  return `${prefix}${suffix}`;
}

export function lookupName(prefix, suffix) {
  return `${prefix}${suffix}`;
}

export function domainName(prefix, suffix) {
  return `${prefix}${suffix}`;
}

export async function ensureClass(client, args, definition) {
  const classes = await client.get('/classes');
  const existing = asArray(classes).find(item => equals(item.name, definition.name) || equals(item._id, definition.name));
  if (existing) {
    console.log(`class exists: ${definition.name}`);
    return existing;
  }

  console.log(`class create: ${definition.name} parent=${definition.parent}`);
  if (!args.apply) {
    return definition;
  }

  return client.post('/classes', {
    type: 'standard',
    speciality: 'default',
    active: true,
    prototype: false,
    description_attribute_name: 'Description',
    ...definition
  });
}

export async function ensureAttribute(client, args, classNameValue, definition) {
  let attributes = [];
  try {
    attributes = await client.get(`/classes/${encodePath(classNameValue)}/attributes`);
  } catch (error) {
    if (args.apply) {
      throw error;
    }
  }
  const existing = asArray(attributes).find(item => equals(item.name, definition.name) || equals(item._id, definition.name));
  if (existing) {
    console.log(`attribute exists: ${classNameValue}.${definition.name}`);
    return existing;
  }

  console.log(`attribute create: ${classNameValue}.${definition.name} type=${definition.type}`);
  if (!args.apply) {
    return definition;
  }

  return client.post(`/classes/${encodePath(classNameValue)}/attributes`, {
    active: true,
    mode: 'write',
    showInGrid: true,
    showInReducedGrid: false,
    mandatory: false,
    unique: false,
    ...definition
  });
}

export async function ensureLookupType(client, args, definition) {
  const lookupTypes = await client.get('/lookup_types');
  const existing = asArray(lookupTypes).find(item => equals(item.name, definition.name) || equals(item._id, definition.name));
  if (existing) {
    console.log(`lookup type exists: ${definition.name}`);
    return existing;
  }

  console.log(`lookup type create: ${definition.name}`);
  if (!args.apply) {
    return definition;
  }

  return client.post('/lookup_types', {
    parent: null,
    speciality: 'default',
    accessType: 'default',
    ...definition
  });
}

export async function ensureLookupValue(client, args, lookupType, definition) {
  let values = [];
  try {
    values = await client.get(`/lookup_types/${encodePath(lookupType)}/values`);
  } catch (error) {
    if (args.apply) {
      throw error;
    }
  }
  const existing = asArray(values).find(item => equals(item.code, definition.code) || equals(item.description, definition.description));
  if (existing) {
    console.log(`lookup value exists: ${lookupType}.${definition.code}`);
    return existing;
  }

  console.log(`lookup value create: ${lookupType}.${definition.code}`);
  if (!args.apply) {
    return definition;
  }

  return client.post(`/lookup_types/${encodePath(lookupType)}/values`, {
    active: true,
    ...definition
  });
}

export async function lookupValueId(client, lookupType, code) {
  const values = await client.get(`/lookup_types/${encodePath(lookupType)}/values`);
  const value = asArray(values).find(item => equals(item.code, code) || equals(item.description, code));
  if (!value?._id) {
    throw new Error(`Lookup value not found: ${lookupType}.${code}`);
  }
  return value._id;
}

export async function ensureDomain(client, args, definition) {
  const domains = await client.get('/domains');
  const existing = asArray(domains).find(item => equals(item.name, definition.name) || equals(item._id, definition.name));
  if (existing) {
    console.log(`domain exists: ${definition.name}`);
    return existing;
  }

  console.log(`domain create: ${definition.name} ${definition.source}->${definition.destination} ${definition.cardinality}`);
  if (!args.apply) {
    return definition;
  }

  return client.post('/domains', {
    active: true,
    sourceProcess: false,
    destinationProcess: false,
    sourceInline: false,
    destinationInline: false,
    cardinality: 'N:N',
    ...definition
  });
}

export async function ensureCard(client, args, classNameValue, card) {
  let existing = null;
  try {
    existing = await findCardByCode(client, classNameValue, card.Code);
  } catch (error) {
    if (args.apply) {
      throw error;
    }
  }
  if (existing) {
    console.log(`card exists: ${classNameValue}.${card.Code}`);
    if (args.apply && args.updateExisting) {
      return client.put(`/classes/${encodePath(classNameValue)}/cards/${encodePath(existing._id)}`, card);
    }
    return existing;
  }

  console.log(`card create: ${classNameValue}.${card.Code}`);
  if (!args.apply) {
    return { ...card, _id: `dry-run:${classNameValue}:${card.Code}` };
  }

  return client.post(`/classes/${encodePath(classNameValue)}/cards`, card);
}

export async function findCardByCode(client, classNameValue, code) {
  const cards = await client.get(`/classes/${encodePath(classNameValue)}/cards?limit=1000`);
  return asArray(cards).find(item => equals(item.Code, code));
}

export async function ensureRelation(client, args, { sourceClass, sourceId, domain, destinationClass, destinationId }) {
  if (String(sourceId).startsWith('dry-run:') || String(destinationId).startsWith('dry-run:')) {
    console.log(`relation create: ${domain} ${sourceClass}.${sourceId} -> ${destinationClass}.${destinationId}`);
    return null;
  }

  const relations = await client.get(`/classes/${encodePath(sourceClass)}/cards/${encodePath(sourceId)}/relations`);
  const existing = asArray(relations).find(item => equals(item._type, domain)
    && ((equals(item._sourceType, sourceClass) && String(item._sourceId) === String(sourceId)
        && equals(item._destinationType, destinationClass) && String(item._destinationId) === String(destinationId))
      || (equals(item._destinationType, sourceClass) && String(item._destinationId) === String(sourceId)
        && equals(item._sourceType, destinationClass) && String(item._sourceId) === String(destinationId))));
  if (existing) {
    console.log(`relation exists: ${domain} ${sourceId}<->${destinationId}`);
    return existing;
  }

  console.log(`relation create: ${domain} ${sourceClass}.${sourceId} -> ${destinationClass}.${destinationId}`);
  if (!args.apply) {
    return null;
  }

  const attempts = [
    {
      path: `/domains/${encodePath(domain)}/relations`,
      body: {
        _type: domain,
        _sourceType: sourceClass,
        _sourceId: sourceId,
        _destinationType: destinationClass,
        _destinationId: destinationId
      }
    },
    {
      path: `/classes/${encodePath(sourceClass)}/cards/${encodePath(sourceId)}/relations`,
      body: {
        _type: domain,
        _sourceType: sourceClass,
        _sourceId: sourceId,
        _destinationType: destinationClass,
        _destinationId: destinationId
      }
    },
    {
      path: `/classes/${encodePath(sourceClass)}/cards/${encodePath(sourceId)}/relations`,
      body: { _type: domain, _destinationType: destinationClass, _destinationId: destinationId }
    }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return await client.post(attempt.path, attempt.body);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.data)) {
    return value.data;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  return [];
}

export function equals(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}
