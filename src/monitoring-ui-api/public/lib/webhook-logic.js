import {
  canonicalSourceField,
  normalizeRuleName,
  normalizeToken,
  uniqueTokens
} from './mapping-logic.js';

const defaultManagedPrefix = 'cmdbwebhooks2kafka-';
const defaultWebhookUrl = 'http://192.168.202.100:5080/webhooks/cmdbuild';
const defaultManagedIdentifier = 'cmdb2monitoring-zabbix-host-lifecycle';
const defaultManagedCodeSegment = 'zabbix-host';

const ruleCollections = [
  { key: 'eventRoutingRules', label: 'Event routing' },
  { key: 'hostProfiles', label: 'Host profiles' },
  { key: 'groupSelectionRules', label: 'Group rules' },
  { key: 'templateSelectionRules', label: 'Template rules' },
  { key: 'templateGroupSelectionRules', label: 'Template group rules' },
  { key: 'interfaceAddressRules', label: 'Interface address rules' },
  { key: 'interfaceSelectionRules', label: 'Interface selection rules' },
  { key: 'tagSelectionRules', label: 'Tag rules' },
  { key: 'monitoringSuppressionRules', label: 'Monitoring suppression rules' },
  { key: 'proxySelectionRules', label: 'Proxy rules' },
  { key: 'proxyGroupSelectionRules', label: 'Proxy group rules' },
  { key: 'globalMacroSelectionRules', label: 'Global macro rules' },
  { key: 'hostMacroSelectionRules', label: 'Host macro rules' },
  { key: 'inventorySelectionRules', label: 'Inventory rules' },
  { key: 'interfaceProfileSelectionRules', label: 'Interface profile rules' },
  { key: 'hostStatusSelectionRules', label: 'Host status rules' },
  { key: 'maintenanceSelectionRules', label: 'Maintenance rules' },
  { key: 'tlsPskSelectionRules', label: 'TLS/PSK rules' },
  { key: 'valueMapSelectionRules', label: 'Value map rules' }
];

export function buildWebhookRequirements(rules = {}, cmdbuildCatalog = {}) {
  return allWebhookClasses(rules, cmdbuildCatalog).map(className => {
    const requirements = requirementsForClass(rules, cmdbuildCatalog, className);
    return {
      className,
      eventTypes: webhookEventsForRules(rules).map(event => event.eventType),
      fields: requirements
    };
  });
}

export function buildDesiredCmdbuildWebhooks(rules = {}, cmdbuildCatalog = {}, currentHooks = [], options = {}) {
  const requirements = buildWebhookRequirements(rules, cmdbuildCatalog);
  const events = webhookEventsForRules(rules);
  const defaults = currentWebhookDefaults(currentHooks, options);
  const currentItems = currentHooks.map(normalizeWebhookItem);
  const currentByCode = new Map(currentItems
    .filter(hook => isManagedWebhook(hook, options))
    .map(hook => [normalizeWebhookCode(hook.code), hook]));
  const allCurrentByCode = new Map(currentItems.map(hook => [normalizeWebhookCode(hook.code), hook]));
  const desired = [];

  for (const classRequirements of requirements) {
    for (const event of events) {
      const code = desiredWebhookCode(classRequirements.className, event.eventType, allCurrentByCode, currentByCode, options);
      const current = currentByCode.get(normalizeWebhookCode(code));
      const currentPrefix = currentWebhookPlaceholderPrefix(current);
      const prefix = webhookPlaceholderPrefixMatchesClass(currentPrefix, classRequirements.className)
        ? currentPrefix
        : defaults.placeholderPrefix;
      desired.push(normalizeWebhookItem({
        code,
        description: current?.description || `cmdb2monitoring ${classRequirements.className} ${event.eventType}`,
        event: event.cmdbuildEvent,
        eventType: event.eventType,
        target: classRequirements.className,
        method: current?.method || defaults.method,
        url: current?.url || defaults.url,
        headers: current?.headers ?? defaults.headers,
        body: webhookBodyForRequirements(event, prefix, current?.body, classRequirements.fields, classRequirements.className, options),
        requirements: classRequirements.fields,
        language: current?.language ?? defaults.language,
        active: current?.active ?? true
      }));
    }
  }

  return desired;
}

export function buildCmdbuildWebhookOperations(rules = {}, cmdbuildCatalog = {}, currentHooks = [], options = {}) {
  const desired = buildDesiredCmdbuildWebhooks(rules, cmdbuildCatalog, currentHooks, options);
  const currentItems = currentHooks.map(normalizeWebhookItem);
  const currentByCode = new Map(currentItems
    .filter(hook => isManagedWebhook(hook, options))
    .map(hook => [normalizeWebhookCode(hook.code), hook]));
  const desiredByCode = new Map(desired.map(hook => [normalizeWebhookCode(hook.code), normalizeWebhookItem(hook)]));
  const operations = [];

  for (const desiredHook of desired) {
    const currentHook = currentByCode.get(normalizeWebhookCode(desiredHook.code));
    if (!currentHook) {
      operations.push({
        action: 'create',
        selected: true,
        code: desiredHook.code,
        target: desiredHook.target,
        event: desiredHook.event,
        eventType: desiredHook.eventType,
        reasonKey: 'webhooks.reasonMissing',
        current: null,
        desired: desiredHook,
        webhookRequirements: desiredHook.requirements ?? [],
        missingPayloadRequirements: desiredHook.requirements ?? []
      });
      continue;
    }

    const diff = webhookDiffFields(currentHook, desiredHook);
    if (diff.length > 0) {
      operations.push({
        action: 'update',
        selected: true,
        code: desiredHook.code,
        target: desiredHook.target,
        event: desiredHook.event,
        eventType: desiredHook.eventType,
        reasonKey: 'webhooks.reasonChanged',
        diff,
        current: currentHook,
        desired: desiredHook,
        webhookRequirements: desiredHook.requirements ?? [],
        missingPayloadRequirements: missingPayloadRequirements(currentHook, desiredHook)
      });
    }
  }

  for (const currentHook of currentItems) {
    if (!isManagedWebhook(currentHook, options) || desiredByCode.has(normalizeWebhookCode(currentHook.code))) {
      continue;
    }

    operations.push({
      action: 'delete',
      selected: false,
      code: currentHook.code,
      target: currentHook.target,
      event: currentHook.event,
      eventType: zabbixEventTypeFromCmdbEvent(currentHook.event),
      reasonKey: 'webhooks.reasonObsolete',
      current: currentHook,
      desired: null
    });
  }

  return operations.sort((left, right) =>
    compareText(left.target, right.target)
    || compareText(left.eventType, right.eventType)
    || compareText(left.action, right.action)
    || compareText(left.code, right.code));
}

function requirementsForClass(rules, cmdbuildCatalog, className) {
  const sourceFields = rules.source?.fields ?? {};
  const usage = sourceFieldUsageForClass(rules, className);
  const result = [];
  const byPayloadKey = new Map();
  const catalogClass = findCatalogClass(cmdbuildCatalog, className);
  const attributes = catalogAttributesForClass(cmdbuildCatalog, catalogClass ?? className);

  for (const [fieldKey, field] of Object.entries(sourceFields)) {
    const canonical = canonicalSourceField(fieldKey);
    if (['className', 'eventType', 'hostProfile', 'outputProfile'].includes(canonical)) {
      continue;
    }

    const usageItem = usage.get(normalizeToken(canonical)) ?? usage.get(normalizeToken(fieldKey));
    if (!usageItem && !field.required) {
      continue;
    }

    if (field.cmdbPath && !cmdbPathRootAppliesToClass(field.cmdbPath, className, cmdbuildCatalog, rules)) {
      continue;
    }

    const requirement = requirementForField(className, attributes, fieldKey, field, usageItem);
    if (!requirement?.payloadKey || !requirement.placeholderAttribute) {
      continue;
    }

    const existing = byPayloadKey.get(normalizeToken(requirement.payloadKey));
    if (existing) {
      mergeRequirement(existing, requirement);
    } else {
      byPayloadKey.set(normalizeToken(requirement.payloadKey), requirement);
      result.push(requirement);
    }
  }

  return result;
}

function requirementForField(className, attributes, fieldKey, field, usageItem) {
  const payloadKey = webhookBodyKeyForField(fieldKey, field);
  const placeholderAttribute = webhookPlaceholderAttributeForField(className, attributes, fieldKey, field);
  if (!payloadKey || !placeholderAttribute) {
    return null;
  }

  const requiredByRules = uniqueTokens([
    ...(usageItem?.reasons ?? []),
    field.required ? 'source field required' : ''
  ].filter(Boolean));
  const reason = requiredByRules.join(', ') || 'source field required';
  return {
    fieldKey,
    payloadKey,
    cmdbAttribute: firstText(sourceFieldCatalogSources(field)) || placeholderAttribute,
    cmdbPath: field.cmdbPath ?? '',
    placeholderAttribute,
    source: firstText(sourceFieldSources(field)) || fieldKey,
    type: field.type ?? '',
    reason,
    requiredByRules,
    domainResolver: cmdbPathIncludesDomain(field.cmdbPath)
  };
}

function mergeRequirement(target, source) {
  target.fieldKey = uniqueTokens([target.fieldKey, source.fieldKey].filter(Boolean)).join(', ');
  target.cmdbAttribute = target.cmdbAttribute || source.cmdbAttribute;
  target.cmdbPath = uniqueTokens([target.cmdbPath, source.cmdbPath].filter(Boolean)).join(', ');
  target.requiredByRules = uniqueTokens([...(target.requiredByRules ?? []), ...(source.requiredByRules ?? [])]);
  target.reason = target.requiredByRules.join(', ');
  target.domainResolver = Boolean(target.domainResolver || source.domainResolver);
}

function sourceFieldUsageForClass(rules, className) {
  const usage = new Map();
  const add = (fieldName, reason) => {
    const canonical = canonicalSourceField(fieldName);
    if (!canonical || ['className', 'eventType', 'hostProfile', 'outputProfile'].includes(canonical)) {
      return;
    }
    for (const key of uniqueTokens([fieldName, canonical].map(normalizeToken).filter(Boolean))) {
      const item = usage.get(key) ?? { reasons: [] };
      item.reasons = uniqueTokens([...item.reasons, reason].filter(Boolean));
      usage.set(key, item);
    }
  };

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    if (field.required) {
      add(fieldKey, 'source field required');
    }
  }

  for (const fieldName of sourceFieldsFromSerializedValue(rules.t4Templates ?? {})) {
    add(fieldName, 'T4 templates');
  }
  for (const fieldName of sourceFieldsFromSerializedValue(rules.normalization ?? {})) {
    add(fieldName, 'normalization');
  }

  for (const collection of ruleCollections) {
    for (const rule of asArray(rules[collection.key])) {
      if (!ruleAppliesToClass(rule, className)) {
        continue;
      }
      const reason = `${collection.label}: ${ruleDisplayName(rule)}`;
      for (const fieldName of sourceFieldsForClassScopedRule(rule, className)) {
        add(fieldName, reason);
      }
    }
  }

  return usage;
}

function webhookBodyForRequirements(event, prefix, baseBody = {}, requirements = [], className = '', options = {}) {
  const body = {
    ...plainObjectOrEmpty(baseBody),
    source: 'cmdbuild',
    className,
    eventType: event.eventType,
    cmdbuildEvent: event.cmdbuildEvent
  };
  const identifier = managedIdentifier(options);
  if (identifier) {
    body.managedIdentifier = identifier;
  }

  for (const requirement of requirements) {
    if (!requirement.payloadKey || !requirement.placeholderAttribute) {
      continue;
    }
    removeWebhookBodyAliasFields(body, requirement);
    if (bodyHasKey(body, requirement.payloadKey)) {
      continue;
    }
    body[requirement.payloadKey] = cmdbuildPlaceholder(prefix, requirement.placeholderAttribute);
  }

  return body;
}

function missingPayloadRequirements(currentHook, desiredHook) {
  const currentBody = plainObjectOrEmpty(currentHook?.body);
  const desiredBody = plainObjectOrEmpty(desiredHook?.body);
  const requirementsByPayload = new Map((desiredHook?.requirements ?? [])
    .map(item => [normalizeToken(item.payloadKey), item]));
  return Object.keys(desiredBody)
    .filter(key => normalizeToken(key) !== 'managedidentifier')
    .filter(key => !Object.prototype.hasOwnProperty.call(currentBody, key))
    .map(key => requirementsByPayload.get(normalizeToken(key)) ?? { payloadKey: key, requiredByRules: [] })
    .sort((left, right) => compareText(left.payloadKey, right.payloadKey));
}

function webhookPlaceholderAttributeForField(className, attributes, fieldKey, field) {
  const canonical = canonicalSourceField(fieldKey);
  if (field.cmdbPath) {
    return webhookBodyValueForCmdbPath(className, attributes, field.cmdbPath);
  }

  const attribute = findCatalogAttributeForField(attributes, field, fieldKey);
  if (attribute) {
    return attribute.name;
  }
  if (canonical === 'entityId') {
    return 'Id';
  }
  if (canonical === 'code') {
    return 'Code';
  }

  return '';
}

function webhookBodyValueForCmdbPath(className, attributes, cmdbPath) {
  const segments = String(cmdbPath ?? '').split('.').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return '';
  }

  let currentSegments = segments;
  if (normalizeClassName(currentSegments[0]) === normalizeClassName(className)) {
    currentSegments = currentSegments.slice(1);
  }

  const firstSegment = currentSegments[0] ?? '';
  if (!firstSegment || firstSegment.toLowerCase().startsWith('{domain:')) {
    return 'Id';
  }

  const attribute = findCatalogAttribute(attributes, firstSegment, firstSegment);
  return attribute?.name ?? firstSegment;
}

function removeWebhookBodyAliasFields(body, requirement) {
  const candidates = uniqueTokens([
    requirement.fieldKey,
    canonicalSourceField(requirement.fieldKey),
    requirement.source,
    requirement.cmdbAttribute,
    requirement.placeholderAttribute
  ].filter(Boolean));
  for (const key of Object.keys(plainObjectOrEmpty(body))) {
    if (equalsIgnoreCase(key, requirement.payloadKey)) {
      continue;
    }
    if (candidates.some(candidate => equalsIgnoreCase(key, candidate) || normalizeToken(key) === normalizeToken(candidate))) {
      delete body[key];
    }
  }
}

function webhookBodyKeyForField(fieldKey, field) {
  const canonical = canonicalSourceField(fieldKey);
  if (canonical === 'eventType') {
    return 'eventType';
  }
  if (canonical === 'className') {
    return 'className';
  }

  return firstText(sourceFieldSources(field)) || fieldKey;
}

function cmdbPathRootAppliesToClass(cmdbPath, className, cmdbuildCatalog, rules) {
  const segments = String(cmdbPath ?? '').split('.').map(segment => segment.trim()).filter(Boolean);
  if (segments.length < 2) {
    return true;
  }

  const root = segments[0];
  if (!root || root.toLowerCase().startsWith('{domain:')) {
    return true;
  }

  const knownClass = findCatalogClass(cmdbuildCatalog ?? {}, root)
    || asArray(rules.source?.entityClasses).some(item => normalizeClassName(item) === normalizeClassName(root));
  return !knownClass || normalizeClassName(root) === normalizeClassName(className);
}

function sourceFieldsFromSerializedValue(value) {
  return sourceFieldsForRule({ serializedValue: value });
}

function sourceFieldsForClassScopedRule(value, className) {
  const result = [];
  collectSourceFieldsForClassScopedNode(value, className, true, result);
  return uniqueTokens(result.map(canonicalSourceField));
}

function collectSourceFieldsForClassScopedNode(value, className, parentApplies, result) {
  if (Array.isArray(value)) {
    value.forEach(item => collectSourceFieldsForClassScopedNode(item, className, parentApplies, result));
    return result;
  }
  if (typeof value === 'string') {
    result.push(...sourceFieldsFromTemplateText(value));
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }

  const applies = parentApplies && ruleAppliesToClass(value, className);
  if (!applies) {
    return result;
  }

  result.push(...sourceFieldsForRuleOwnScope(value));
  for (const [key, item] of Object.entries(value)) {
    if (key === 'when') {
      continue;
    }
    collectSourceFieldsForClassScopedNode(item, className, applies, result);
  }
  return result;
}

function sourceFieldsForRuleOwnScope(rule = {}) {
  const when = rule.when ?? {};
  const fields = [
    ...(when.anyRegex ?? []).map(matcher => matcher.field),
    ...(when.allRegex ?? []).map(matcher => matcher.field),
    when.fieldExists,
    ...(Array.isArray(when.fieldsExist) ? when.fieldsExist : []),
    rule.field,
    rule.valueField,
    rule.sourceField,
    rule.fieldName
  ].filter(Boolean);

  for (const [key, value] of Object.entries(rule)) {
    if (key === 'when') {
      continue;
    }
    if (typeof value === 'string') {
      fields.push(...sourceFieldsFromTemplateText(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          fields.push(...sourceFieldsFromTemplateText(item));
        }
      }
    }
  }

  return uniqueTokens(fields.map(canonicalSourceField));
}

function sourceFieldsForRule(rule = {}) {
  const fields = sourceFieldsForRuleOwnScope(rule);
  fields.push(...sourceFieldsFromTemplateText(JSON.stringify(rule)));
  return uniqueTokens(fields.map(canonicalSourceField));
}

function sourceFieldsFromTemplateText(text) {
  const fields = [];
  const serialized = String(text ?? '');
  for (const match of serialized.matchAll(/Model\.Source\(["']([^"']+)["']\)/g)) {
    fields.push(match[1]);
  }
  for (const match of serialized.matchAll(/Model\.Field\(["']([^"']+)["']\)/g)) {
    fields.push(match[1]);
  }
  for (const match of serialized.matchAll(/Model\.([A-Za-z0-9_]+)/g)) {
    if (!['Source', 'Field'].includes(match[1])) {
      fields.push(match[1]);
    }
  }
  return uniqueTokens(fields);
}

function ruleAppliesToClass(rule, className) {
  const matchers = {
    all: asArray(rule?.when?.allRegex).filter(matcher => canonicalSourceField(matcher.field) === 'className'),
    any: asArray(rule?.when?.anyRegex).filter(matcher => canonicalSourceField(matcher.field) === 'className'),
    anyOther: asArray(rule?.when?.anyRegex).filter(matcher => canonicalSourceField(matcher.field) !== 'className')
  };
  if (matchers.all.length === 0 && matchers.any.length === 0) {
    return true;
  }

  const matchesClass = matcher => {
    try {
      return compileRuleRegex(matcher.pattern).test(className);
    } catch {
      return false;
    }
  };

  if (matchers.all.length > 0 && !matchers.all.every(matchesClass)) {
    return false;
  }

  return matchers.any.length === 0
    || matchers.anyOther.length > 0
    || matchers.any.some(matchesClass);
}

function allWebhookClasses(rules, cmdbuildCatalog) {
  return uniqueTokens((rules.source?.entityClasses ?? [])
    .map(className => webhookClassItem(className, cmdbuildCatalog))
    .filter(item => item?.name)
    .map(item => item.name));
}

function webhookClassItem(className, cmdbuildCatalog) {
  const classItem = findCatalogClass(cmdbuildCatalog ?? {}, className) ?? { name: className };
  return classItem?.name && !isCmdbCatalogSuperclass(cmdbuildCatalog ?? {}, classItem)
    ? classItem
    : null;
}

function isCmdbCatalogSuperclass(catalog, classItem) {
  const raw = classItem?.raw ?? classItem ?? {};
  return Boolean(
    raw.prototype
    || raw._prototype
    || raw.isSuperclass
    || raw.superclass
    || classItem?.prototype
    || classItem?.isSuperclass
    || catalog?.superclasses?.some(item => normalizeClassName(item.name) === normalizeClassName(classItem?.name)));
}

function webhookEventsForRules(rules) {
  const supported = rules.source?.supportedEvents?.length
    ? rules.source.supportedEvents
    : ['create', 'update', 'delete'];
  return supported.map(eventType => ({
    eventType,
    cmdbuildEvent: cmdbuildWebhookEventName(eventType)
  }));
}

function cmdbuildWebhookEventName(eventType) {
  return {
    create: 'card_create_after',
    update: 'card_update_after',
    delete: 'card_delete_after'
  }[String(eventType).toLowerCase()] ?? `card_${eventType}_after`;
}

function currentWebhookDefaults(currentHooks, options) {
  const managed = currentHooks.map(normalizeWebhookItem).filter(hook => isManagedWebhook(hook, options));
  const sample = managed.find(hook => hook.url) ?? managed[0] ?? {};
  return {
    method: sample.method || 'post',
    url: sample.url || options.defaultUrl || defaultWebhookUrl,
    headers: sample.headers ?? {},
    language: sample.language ?? '',
    placeholderPrefix: currentWebhookPlaceholderPrefix(sample) || 'card'
  };
}

function webhookPlaceholderPrefixMatchesClass(prefix, className) {
  return String(prefix ?? '').trim() !== ''
    && (normalizeToken(prefix) === 'card' || normalizeToken(prefix) === normalizeToken(className));
}

function desiredWebhookCode(className, eventType, allCurrentByCode, ownedCurrentByCode, options) {
  const baseCode = cmdbuildWebhookCode(className, eventType, options);
  const baseKey = normalizeWebhookCode(baseCode);
  if (ownedCurrentByCode.has(baseKey) || !allCurrentByCode.has(baseKey)) {
    return baseCode;
  }

  const ownedCode = cmdbuildWebhookCode(className, eventType, {
    ...options,
    managedCodeSegment: options.managedCodeSegment ?? defaultManagedCodeSegment
  });
  return ownedCode;
}

function cmdbuildWebhookCode(className, eventType, options) {
  return [
    options.managedPrefix ?? defaultManagedPrefix,
    options.managedCodeSegment ? `${normalizeRuleName(options.managedCodeSegment)}-` : '',
    normalizeRuleName(className),
    '-',
    normalizeRuleName(eventType)
  ].join('');
}

function normalizeWebhookItem(item = {}) {
  return {
    _id: item._id ?? item.id ?? item.code ?? '',
    id: item.id ?? item._id ?? item.code ?? '',
    code: item.code ?? item._id ?? item.id ?? '',
    description: item.description ?? '',
    event: item.event ?? '',
    eventType: item.eventType ?? zabbixEventTypeFromCmdbEvent(item.event),
    target: item.target ?? '',
    method: String(item.method ?? 'post').toLowerCase(),
    url: item.url ?? '',
    headers: plainObjectOrEmpty(item.headers),
    body: plainObjectOrEmpty(item.body),
    requirements: Array.isArray(item.requirements) ? item.requirements : [],
    language: item.language ?? '',
    active: item.active !== false,
    raw: item.raw ?? undefined
  };
}

function webhookDiffFields(current, desired) {
  const currentComparable = webhookComparable(current);
  const desiredComparable = webhookComparable(desired);
  return Object.keys(desiredComparable).filter(key => stableJson(currentComparable[key]) !== stableJson(desiredComparable[key]));
}

function webhookComparable(hook) {
  const normalized = normalizeWebhookItem(hook);
  return {
    description: normalized.description,
    event: normalized.event,
    target: normalized.target,
    method: normalized.method,
    url: normalized.url,
    headers: normalized.headers,
    body: normalized.body,
    language: normalized.language,
    active: normalized.active
  };
}

function currentWebhookPlaceholderPrefix(hook) {
  const values = [];
  collectWebhookBodyValues(hook?.body, values);
  for (const value of values) {
    const match = String(value).match(/^\{([^}:]+):[^}]+\}$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
}

function collectWebhookBodyValues(value, result) {
  if (Array.isArray(value)) {
    value.forEach(item => collectWebhookBodyValues(item, result));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectWebhookBodyValues(item, result));
    return;
  }
  result.push(value);
}

function managedIdentifier(options = {}) {
  return options.managedIdentifier ?? defaultManagedIdentifier;
}

function ownedWebhookUrls(options = {}) {
  return uniqueTokens([
    options.defaultUrl || defaultWebhookUrl,
    ...(Array.isArray(options.ownedUrls) ? options.ownedUrls : [])
  ].filter(Boolean).map(normalizeWebhookUrl));
}

function normalizeWebhookUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

function isManagedWebhook(hook, options) {
  if (!String(hook?.code ?? '').startsWith(options.managedPrefix ?? defaultManagedPrefix)) {
    return false;
  }

  const body = plainObjectOrEmpty(hook?.body);
  const identifier = firstText([body.managedIdentifier, body.ManagedIdentifier]);
  if (identifier) {
    return identifier === managedIdentifier(options);
  }

  if (firstText([body.targetTopic, body.TargetTopic])) {
    return false;
  }

  const ownedUrls = ownedWebhookUrls(options);
  return ownedUrls.length === 0 || ownedUrls.includes(normalizeWebhookUrl(hook?.url));
}

function normalizeWebhookCode(code) {
  return normalizeRuleName(code);
}

function zabbixEventTypeFromCmdbEvent(eventName) {
  const text = String(eventName ?? '').toLowerCase();
  if (text.includes('create')) {
    return 'create';
  }
  if (text.includes('update')) {
    return 'update';
  }
  if (text.includes('delete')) {
    return 'delete';
  }
  return text.replace(/^card_/, '').replace(/_after$/, '') || '';
}

function findCatalogClass(catalog, className) {
  const wanted = normalizeClassName(className);
  return (catalog.classes ?? []).find(item => catalogClassAliases(item).some(alias => normalizeClassName(alias) === wanted));
}

function catalogClassAliases(item = {}) {
  return uniqueTokens([
    item.name,
    item.description,
    item.label,
    item.text,
    item.raw?.name,
    item.raw?.description,
    item.raw?._description
  ]);
}

function catalogAttributesForClass(catalog, classNameOrItem) {
  const classItem = typeof classNameOrItem === 'object'
    ? classNameOrItem
    : findCatalogClass(catalog ?? {}, classNameOrItem);
  const aliases = new Set(catalogClassAliases(classItem ?? { name: classNameOrItem }).map(normalizeClassName));
  return (catalog?.attributes ?? [])
    .find(item => aliases.has(normalizeClassName(item.className)))
    ?.items ?? [];
}

function findCatalogAttributeForField(attributes, field, fieldKey) {
  for (const sourceName of sourceFieldCatalogSources(field)) {
    const attribute = findCatalogAttribute(attributes, sourceName, fieldKey);
    if (attribute) {
      return attribute;
    }
  }

  for (const sourceName of sourceFieldSources(field)) {
    const attribute = findCatalogAttribute(attributes, sourceName, fieldKey);
    if (attribute) {
      return attribute;
    }
  }

  return findCatalogAttribute(attributes, fieldKey, fieldKey);
}

function findCatalogAttribute(attributes, sourceName, fieldKey) {
  const wanted = [sourceName, fieldKey, canonicalSourceField(fieldKey)].map(normalizeToken);
  return attributes.find(attribute => wanted.includes(normalizeToken(attribute.name)) || wanted.includes(normalizeToken(attribute.alias)));
}

function sourceFieldSources(field = {}) {
  return uniqueTokens([
    field.source,
    ...(Array.isArray(field.sources) ? field.sources : [])
  ].filter(Boolean));
}

function sourceFieldCatalogSources(field = {}) {
  return uniqueTokens([
    field.cmdbAttribute,
    ...(Array.isArray(field.cmdbAttributes) ? field.cmdbAttributes : [])
  ].filter(Boolean));
}

function normalizeClassName(value) {
  const token = normalizeToken(value);
  return token.endsWith('s') ? token.slice(0, -1) : token;
}

function cmdbPathIncludesDomain(cmdbPath) {
  return String(cmdbPath ?? '')
    .split('.')
    .some(segment => segment.trim().toLowerCase().startsWith('{domain:'));
}

function ruleDisplayName(rule = {}) {
  return rule.name
    || rule.eventType
    || rule.method
    || rule.interfaceRef
    || rule.interfaceProfileRef
    || stableJson(rule).slice(0, 80)
    || 'rule';
}

function compileRuleRegex(pattern) {
  const text = String(pattern ?? '');
  if (text.startsWith('(?i)')) {
    return new RegExp(text.slice(4), 'i');
  }
  return new RegExp(text);
}

function plainObjectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bodyHasKey(body, wantedKey) {
  return Object.keys(plainObjectOrEmpty(body)).some(key => equalsIgnoreCase(key, wantedKey));
}

function firstText(values) {
  return values.find(value => String(value ?? '').trim() !== '') ?? '';
}

function cmdbuildPlaceholder(prefix, attributeName) {
  return `{${prefix}:${attributeName}}`;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function equalsIgnoreCase(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
