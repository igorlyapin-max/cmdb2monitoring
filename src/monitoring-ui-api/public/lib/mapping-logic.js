import {
  allCondition,
  conditionFields,
  conditionLeaf,
  requiredHostProfileName,
  replaceConditionField,
  ruleMayApplyToClass
} from './condition-expression.js';

const profileScopedRuleCollections = [
  'groupSelectionRules',
  'templateSelectionRules',
  'interfaceSelectionRules',
  'tagSelectionRules',
  'proxySelectionRules',
  'proxyGroupSelectionRules',
  'hostMacroSelectionRules',
  'inventorySelectionRules',
  'interfaceProfileSelectionRules',
  'hostStatusSelectionRules',
  'maintenanceSelectionRules',
  'tlsPskSelectionRules',
  'valueMapSelectionRules'
];

const classScopedRuleCollections = [
  'monitoringSuppressionRules',
  'groupSelectionRules',
  'templateSelectionRules',
  'templateConflictRules',
  'interfaceAddressRules',
  'interfaceSelectionRules',
  'tagSelectionRules',
  'proxySelectionRules',
  'proxyGroupSelectionRules',
  'hostMacroSelectionRules',
  'inventorySelectionRules',
  'interfaceProfileSelectionRules',
  'hostStatusSelectionRules',
  'maintenanceSelectionRules',
  'tlsPskSelectionRules',
  'valueMapSelectionRules'
];

export function removeHostProfileAndDependentConfiguration(rules, profileName) {
  const normalizedProfileName = normalizeToken(profileName);
  const profile = (rules?.hostProfiles ?? [])
    .find(item => normalizeToken(item?.name) === normalizedProfileName);
  if (!profile) {
    return { removedRules: 0, removedFields: [], removedClasses: [], affectedClasses: [] };
  }

  const affectedClasses = ruleClassConditions(profile);
  rules.hostProfiles = (rules.hostProfiles ?? [])
    .filter(item => normalizeToken(item?.name) !== normalizedProfileName);

  let removedRules = 0;
  for (const collection of profileScopedRuleCollections) {
    const before = Array.isArray(rules[collection]) ? rules[collection] : [];
    const after = before.filter(rule => !requiredHostProfile(rule, normalizedProfileName));
    rules[collection] = after;
    removedRules += before.length - after.length;
  }

  for (const className of affectedClasses) {
    if (hasHostProfileForClass(rules, className)) {
      continue;
    }
    for (const collection of classScopedRuleCollections) {
      const before = Array.isArray(rules[collection]) ? rules[collection] : [];
      const after = before.filter(rule => !isExclusiveClassRule(rule, className));
      rules[collection] = after;
      removedRules += before.length - after.length;
    }
  }

  const referencedFields = referencedSourceFields(rules);
  const remainingClasses = configuredClassNames(rules);
  const removedFields = [];
  rules.source ??= {};
  rules.source.fields ??= {};
  for (const className of affectedClasses) {
    if (remainingClasses.has(normalizeToken(className))) {
      continue;
    }
    for (const [fieldName, fieldRule] of Object.entries(rules.source.fields)) {
      if (!sourceFieldBelongsToClass(fieldRule, className) || referencedFields.has(normalizeToken(fieldName))) {
        continue;
      }
      delete rules.source.fields[fieldName];
      removedFields.push(fieldName);
    }
  }

  const removedClasses = [];
  if (Array.isArray(rules.source.entityClasses)) {
    rules.source.entityClasses = rules.source.entityClasses.filter(className => {
      const remove = affectedClasses.some(affected => normalizeToken(affected) === normalizeToken(className))
        && !remainingClasses.has(normalizeToken(className));
      if (remove) {
        removedClasses.push(className);
      }
      return !remove;
    });
  }

  return { removedRules, removedFields, removedClasses, affectedClasses };
}

export function ensureMinimalHostProfileForClass(rules, className, fieldKey, fieldRule = {}, target = {}, options = {}) {
  const forceAdditional = Boolean(options.forceAdditional);
  if (!rules || !className || !fieldKey || (!forceAdditional && classHasHostProfile(rules, className))) {
    return { created: false };
  }

  const mode = minimalHostProfileInterfaceMode(fieldKey, fieldRule, target);
  if (!['ip', 'dns'].includes(mode)) {
    return { created: false };
  }

  rules.hostProfiles = Array.isArray(rules.hostProfiles) ? rules.hostProfiles : [];
  const requestedProfileName = normalizeRuleName(options.profileName ?? '');
  const baseName = requestedProfileName || (forceAdditional
    ? `${normalizeRuleName(className)}-${normalizeRuleName(fieldKey)}`
    : `${normalizeRuleName(className)}-main`);
  const profileName = uniqueHostProfileName(rules, baseName);
  const nextPriority = Math.max(0, ...rules.hostProfiles.map(profile => Number(profile.priority) || 0)) + 10;
  const interfaceProfileRef = String(options.interfaceProfileRef ?? '').trim() || 'agent';
  const createOnUpdateWhenMissing = options.createOnUpdateWhenMissing === undefined
    ? true
    : Boolean(options.createOnUpdateWhenMissing);
  const conditions = [conditionLeaf('className', 'equals', className)];
  if (forceAdditional) {
    conditions.push({
      operator: 'any',
      items: [
        conditionLeaf(fieldKey, 'exists'),
        conditionLeaf('eventType', 'equals', 'delete')
      ]
    });
  }
  const profile = {
    name: profileName,
    priority: nextPriority,
    isMainProfile: !forceAdditional,
    createOnUpdateWhenMissing,
    when: { expression: allCondition(conditions) },
    hostNameTemplate: forceAdditional
      ? 'cmdb-<#= Model.ClassName #>-<#= Model.Code ?? Model.EntityId #>-<#= Model.HostProfileName #>'
      : 'cmdb-<#= Model.ClassName #>-<#= Model.Code ?? Model.EntityId #>',
    visibleNameTemplate: forceAdditional
      ? '<#= Model.ClassName #> <#= Model.Code ?? Model.EntityId #> <#= Model.HostProfileName #>'
      : '<#= Model.ClassName #> <#= Model.Code ?? Model.EntityId #>',
    interfaces: [
      {
        name: `${profileName}-${normalizeRuleName(interfaceProfileRef) || 'interface'}-${mode}`,
        priority: 10,
        interfaceProfileRef,
        mode,
        valueField: fieldKey,
        when: { expression: conditionLeaf(fieldKey, 'exists') }
      }
    ]
  };

  rules.hostProfiles.push(profile);
  return { created: true, additional: forceAdditional, profileName, profile };
}

export function replaceHostProfileAddressFieldForClass(rules, className, fieldKey, fieldRule = {}, target = {}, options = {}) {
  if (!rules || !className || !fieldKey) {
    return { changed: false, count: 0, profiles: [] };
  }

  const mode = minimalHostProfileInterfaceMode(fieldKey, fieldRule, target);
  if (!['ip', 'dns'].includes(mode)) {
    return { changed: false, count: 0, profiles: [] };
  }

  const shouldReplace = typeof options.shouldReplace === 'function'
    ? options.shouldReplace
    : defaultHostProfileAddressFieldNeedsReplacement;
  let count = 0;
  const profiles = [];
  for (const profile of rules.hostProfiles ?? []) {
    if (!hostProfileAppliesToClass(profile, className)) {
      continue;
    }

    const profileName = profile.name || 'default';
    const originalProfileField = profile.valueField;
    const originalProfileMode = profile.mode;
    let profileChanged = false;
    if (profile.valueField && shouldReplaceProfileAddressField(rules, shouldReplace, profile.valueField, {
      mode: profile.mode || mode,
      profile,
      scope: 'profile'
    })) {
      profile.valueField = fieldKey;
      profile.mode = mode;
      replaceFieldExistsCondition(profile.when, originalProfileField, fieldKey);
      count += 1;
      profileChanged = true;
    }

    for (const item of profile.interfaces ?? []) {
      const currentField = item.valueField || originalProfileField || profile.valueField;
      const currentMode = item.mode || originalProfileMode || profile.mode || mode;
      if (!currentField || shouldReplaceProfileAddressField(rules, shouldReplace, currentField, {
        mode: currentMode,
        profile,
        interface: item,
        scope: 'interface'
      })) {
        item.valueField = fieldKey;
        item.mode = mode;
        item.when ??= {};
        replaceFieldExistsCondition(item.when, currentField, fieldKey, { setWhenMissing: true });
        count += 1;
        profileChanged = true;
      }
    }

    if (profileChanged) {
      profiles.push(profileName);
    }
  }

  return { changed: count > 0, count, profiles: uniqueTokens(profiles) };
}

function shouldReplaceProfileAddressField(rules, shouldReplace, currentField, context) {
  const fieldRule = rules.source?.fields?.[currentField] ?? { source: currentField };
  return shouldReplace(currentField, fieldRule, context);
}

function defaultHostProfileAddressFieldNeedsReplacement(currentField, fieldRule = {}, context = {}) {
  const mode = String(context.mode ?? '').toLowerCase();
  const kind = sourceFieldAddressKind(currentField, fieldRule);
  return !['ip', 'dns'].includes(kind)
    || Boolean(interfaceAddressCompatibilityIssue(currentField, fieldRule, 'interfaceAddress', { mode: ['ip', 'dns'].includes(mode) ? mode : kind }));
}

function replaceFieldExistsCondition(when, oldField, newField, options = {}) {
  return replaceConditionField(when, oldField, newField, options);
}

export function minimalHostProfileInterfaceMode(fieldKey, fieldRule = {}, target = {}) {
  const targetMode = String(target?.mode ?? '').toLowerCase();
  if (targetMode === 'ip' || targetMode === 'dns') {
    return targetMode;
  }

  const kind = sourceFieldAddressKind(fieldKey, fieldRule);
  return kind === 'dns' ? 'dns' : kind === 'ip' ? 'ip' : '';
}

export function dynamicZabbixTargetAllowed(type, runtimeSettings = {}) {
  const zabbix = runtimeSettings?.zabbix ?? {};
  if (type === 'tags') {
    return Boolean(zabbix.allowDynamicTagsFromCmdbLeaf);
  }
  if (type === 'hostGroups') {
    return Boolean(zabbix.allowDynamicHostGroupsFromCmdbLeaf);
  }

  return false;
}

export function isDynamicFromLeafTarget(target = {}) {
  return String(target?.targetMode ?? '').toLowerCase() === 'dynamicfromleaf';
}

export function dynamicTargetForField(type, fieldKey) {
  const valueField = fieldKey || 'value';
  if (type === 'hostGroups') {
    return {
      targetMode: 'dynamicFromLeaf',
      valueField,
      createIfMissing: true,
      nameTemplate: sourceFieldTemplate(valueField)
    };
  }
  if (type === 'tags') {
    return {
      targetMode: 'dynamicFromLeaf',
      valueField,
      createIfMissing: true,
      tag: dynamicTagNameForField(valueField),
      valueTemplate: sourceFieldTemplate(valueField)
    };
  }

  return {};
}

export function dynamicTagNameForField(fieldKey) {
  const canonical = canonicalSourceField(fieldKey);
  const readable = String(canonical || fieldKey || 'value')
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2');
  const normalized = normalizeRuleName(readable)
    .replace(/_/g, '.')
    .replace(/-+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return `cmdb.${normalized || 'value'}`;
}

export function sourceFieldTemplate(fieldKey) {
  return `<#= Model.Source("${escapeTemplateString(fieldKey || 'value')}") #>`;
}

export function classHasHostProfile(rules, className) {
  return (rules?.hostProfiles ?? []).some(profile => hostProfileAppliesToClass(profile, className));
}

export function hostProfileAppliesToClass(profile, className) {
  if (!profile || profile.enabled === false) {
    return false;
  }

  return ruleMayApplyToClass(profile, className, { normalize: normalizeToken });
}

export function interfaceAddressCompatibilityIssue(fieldKey, fieldRule = {}, targetType = '', target = {}) {
  if (targetType !== 'interfaceAddress') {
    return null;
  }

  const mode = String(target?.mode ?? '').toLowerCase();
  if (!['ip', 'dns'].includes(mode)) {
    return null;
  }

  const kind = sourceFieldAddressKind(fieldKey, fieldRule);
  if (kind === 'lookup' || kind === 'reference') {
    return { code: 'lookupFieldForInterfaceTarget', params: { field: fieldKey } };
  }
  if (mode === 'dns' && kind === 'ip') {
    return { code: 'ipFieldForDnsTarget', params: { field: fieldKey } };
  }
  if (mode === 'ip' && kind === 'dns') {
    return { code: 'dnsFieldForIpTarget', params: { field: fieldKey } };
  }
  if (kind === 'unknown') {
    return { code: 'unknownFieldForInterfaceTarget', params: { field: fieldKey, target: mode.toUpperCase() } };
  }

  return null;
}

export function interfaceAddressTargetForForm(ruleOrTarget = {}) {
  const mode = String(ruleOrTarget?.mode ?? '').toLowerCase();
  return { mode: mode === 'dns' ? 'dns' : 'ip' };
}

export function sourceFieldMayReturnMultiple(field = {}) {
  if (!cmdbPathIncludesDomain(field.cmdbPath)) {
    return false;
  }

  const mode = String(field.resolve?.collectionMode ?? '').toLowerCase();
  return mode !== 'first';
}

export function disambiguateSourceFieldKey(defaultFieldKey, fieldRule = {}, sourceFields = {}) {
  const existing = sourceFieldRuleByKey(sourceFields, defaultFieldKey);
  if (!existing?.cmdbPath || sourceFieldRulesShareCmdbPath(existing, fieldRule)) {
    return defaultFieldKey;
  }

  return uniqueSourceFieldKey(sourceFields, sourceFieldKeyForCmdbPath(fieldRule.cmdbPath, defaultFieldKey), fieldRule);
}

export function sourceFieldKeyForCmdbPath(cmdbPath, fallback = 'cmdbPathField') {
  const segments = String(cmdbPath ?? '')
    .split('.')
    .map(cmdbPathSegmentForFieldKey)
    .filter(Boolean);
  if (segments.length === 0) {
    return fallback || 'cmdbPathField';
  }

  return segments
    .map((segment, index) => camelFieldKeySegment(segment, index === 0))
    .join('') || fallback || 'cmdbPathField';
}

export function sourceFieldLabelForCmdbPath(cmdbPath) {
  const segments = String(cmdbPath ?? '')
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return '';
  }

  const root = segments[0];
  const leafPath = segments.slice(1).map(cmdbPathSegmentForDisplay);
  return leafPath.length > 0
    ? `${leafPath.join(' -> ')} / ${root}`
    : root;
}

export function sourceFieldRulesShareCmdbPath(left = {}, right = {}) {
  const leftPath = normalizeCmdbPath(left.cmdbPath);
  const rightPath = normalizeCmdbPath(right.cmdbPath);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

export function sourceFieldCanUseCatalogAttribute(attribute, fieldRule = {}) {
  return Boolean(attribute) && !sourceFieldUsesReferenceAttributeDirectly(attribute, fieldRule);
}

export function sourceFieldUsesReferenceAttributeDirectly(attribute, fieldRule = {}) {
  return sourceFieldAttributeIsReference(attribute) && !fieldRule?.cmdbPath;
}

export function sourceFieldAddressKind(fieldKey, fieldRule = {}) {
  const type = String(fieldRule.type ?? '').toLowerCase();
  const resolveLeafType = String(fieldRule.resolve?.leafType ?? '').toLowerCase();
  if (type.includes('lookup') || resolveLeafType === 'lookup' || fieldRule.lookupType) {
    return 'lookup';
  }
  if (type === 'reference') {
    return 'reference';
  }

  const tokens = sourceFieldAddressTokens(fieldKey, fieldRule);
  const joined = tokens.join(' ');
  const compact = normalizeToken(joined);
  const validationRegex = String(fieldRule.validationRegex ?? '').toLowerCase();

  if (type.includes('ip') || validationRegex.includes('25[0-5]') || /\b(ip|ipaddress|ip_address|addressvalue)\b/.test(joined) || compact.includes('ipaddress')) {
    return 'ip';
  }
  if (canonicalSourceField(fieldKey) === 'dnsName'
    || /\b(dns|fqdn|hostname|host_dns|dnsname)\b/.test(joined)
    || compact.includes('dnsname')
    || compact.includes('fqdn')
    || compact.includes('hostname')) {
    return 'dns';
  }

  return 'unknown';
}

function sourceFieldAddressTokens(fieldKey, fieldRule = {}) {
  const cmdbPathSegments = String(fieldRule.cmdbPath ?? '')
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean)
    .filter(segment => !segment.toLowerCase().startsWith('{domain:'));
  if (cmdbPathSegments.length > 1) {
    const leaf = cmdbPathSegments[cmdbPathSegments.length - 1];
    return [
      leaf,
      fieldRule.type,
      fieldRule.validationRegex
    ].map(value => String(value ?? '').toLowerCase());
  }

  return [
    fieldKey,
    canonicalSourceField(fieldKey),
    fieldRule.source,
    fieldRule.cmdbAttribute,
    ...(Array.isArray(fieldRule.sources) ? fieldRule.sources : []),
    ...(Array.isArray(fieldRule.cmdbAttributes) ? fieldRule.cmdbAttributes : [])
  ].map(value => String(value ?? '').toLowerCase());
}

export function cmdbPathIncludesDomain(cmdbPath) {
  return String(cmdbPath ?? '')
    .split('.')
    .some(segment => segment.trim().toLowerCase().startsWith('{domain:'));
}

export function normalizeRuleName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function nextRulesVersion(currentVersion, fallbackName = 'rules-save', now = new Date()) {
  const prefix = formatRulesVersionTimestamp(now);
  const suffix = rulesVersionSuffix(currentVersion) || normalizeRuleName(fallbackName) || 'rules-save';
  const maxSuffixLength = Math.max(1, 128 - prefix.length - 1);
  const trimmedSuffix = suffix.slice(0, maxSuffixLength).replace(/-+$/g, '') || 'rules-save';
  return `${prefix}-${trimmedSuffix}`;
}

function rulesVersionSuffix(currentVersion) {
  const value = String(currentVersion ?? '').trim();
  const dated = value.match(/^\d{4}\.\d{2}\.\d{2}-\d{4}(?:\d{2})?-(.+)$/);
  if (dated?.[1]) {
    return normalizeRuleName(dated[1]);
  }

  return normalizeRuleName(value);
}

function formatRulesVersionTimestamp(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('.')
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function ruleClassConditions(rule) {
  return uniqueTokens(conditionClassValues(rule?.when?.expression));
}

function requiredHostProfile(rule, profileName) {
  return normalizeToken(requiredHostProfileName(rule)) === normalizeToken(profileName);
}

function hasHostProfileForClass(rules, className) {
  return (rules.hostProfiles ?? []).some(profile => hostProfileAppliesToClass(profile, className));
}

function isExclusiveClassRule(rule, className) {
  const classes = ruleClassConditions(rule);
  return classes.length === 1 && normalizeToken(classes[0]) === normalizeToken(className);
}

function configuredClassNames(rules) {
  const classes = new Set();
  for (const profile of rules.hostProfiles ?? []) {
    ruleClassConditions(profile).forEach(className => classes.add(normalizeToken(className)));
  }
  for (const collection of classScopedRuleCollections) {
    for (const rule of rules[collection] ?? []) {
      ruleClassConditions(rule).forEach(className => classes.add(normalizeToken(className)));
    }
  }
  return classes;
}

function sourceFieldBelongsToClass(fieldRule, className) {
  const root = String(fieldRule?.cmdbPath ?? '').split('.')[0];
  return Boolean(root) && normalizeToken(root) === normalizeToken(className);
}

function referencedSourceFields(rules) {
  const fields = new Set();
  const collect = value => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'when') {
        conditionFields(item).forEach(field => fields.add(normalizeToken(field)));
      } else if (key === 'valueField' && item) {
        fields.add(normalizeToken(item));
      } else {
        collect(item);
      }
    }
  };

  for (const collection of classScopedRuleCollections) {
    collect(rules[collection]);
  }
  collect(rules.hostProfiles);
  for (const lines of Object.values(rules.t4Templates ?? {})) {
    if (!Array.isArray(lines)) {
      continue;
    }
    const sourceCalls = lines.join('\n').matchAll(/Model\.Source\(\s*["']([^"']+)["']\s*\)/g);
    for (const match of sourceCalls) {
      fields.add(normalizeToken(match[1]));
    }
  }
  return fields;
}

function conditionClassValues(expression, values = []) {
  if (!expression || typeof expression !== 'object') {
    return values;
  }
  if (Array.isArray(expression.items)) {
    expression.items.forEach(item => conditionClassValues(item, values));
    return values;
  }
  if (canonicalSourceField(expression.field) !== 'className') {
    return values;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'equals' && String(expression.value ?? '').trim()) {
    values.push(String(expression.value));
  } else if (operator === 'regex') {
    values.push(...exactRegexLiteralValues(expression.pattern));
  }
  return values;
}

function exactRegexLiteralValues(pattern) {
  const normalized = String(pattern ?? '').replaceAll('(?i)', '').trim();
  if (!normalized.startsWith('^') || !normalized.endsWith('$')) {
    return [];
  }
  const body = normalized.slice(1, -1);
  return /[\[\]{}.*+?\\]/.test(body) ? [] : regexLiteralValues(normalized);
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function regexLiteralValues(pattern) {
  const cleaned = String(pattern ?? '')
    .replaceAll('(?i)', '')
    .replaceAll('\\b', '')
    .replace(/^\^|\$$/g, '')
    .replace(/[()]/g, '');
  if (!cleaned.includes('|')) {
    const singleValue = cleaned
      .replace(/\\/g, '')
      .replace(/[[\]{}.*+?^$]/g, '')
      .trim();
    return singleValue ? [singleValue] : [];
  }

  return cleaned
    .split('|')
    .map(item => item.replace(/\\/g, '').replace(/[[\]{}.*+?^$]/g, '').trim())
    .filter(item => item.length > 0);
}

export function canonicalSourceField(field) {
  const normalized = normalizeToken(field);
  return {
    entityid: 'entityId',
    id: 'entityId',
    code: 'code',
    classname: 'className',
    class: 'className',
    ipaddress: 'ipAddress',
    ip_address: 'ipAddress',
    profileipaddress: 'profileIpAddress',
    profile_ip: 'profileIpAddress',
    profile: 'profileIpAddress',
    profile2ipaddress: 'profile2IpAddress',
    profile2_ip: 'profile2IpAddress',
    profile2: 'profile2IpAddress',
    interfaceipaddress: 'interfaceIpAddress',
    interface_ip_address: 'interfaceIpAddress',
    interfaceip: 'interfaceIpAddress',
    interface_ip: 'interfaceIpAddress',
    interface: 'interfaceIpAddress',
    interface2ipaddress: 'interface2IpAddress',
    interface2_ip_address: 'interface2IpAddress',
    interface2ip: 'interface2IpAddress',
    interface2_ip: 'interface2IpAddress',
    interface2: 'interface2IpAddress',
    dnsname: 'dnsName',
    dns_name: 'dnsName',
    profiledns: 'profileDnsName',
    profile_dns: 'profileDnsName',
    fqdn: 'dnsName',
    hostname: 'dnsName',
    hostdns: 'dnsName',
    description: 'description',
    os: 'os',
    operatingsystem: 'os',
    zabbixtag: 'zabbixTag',
    zabbix_tag: 'zabbixTag',
    zabbixhostid: 'zabbixHostId',
    zabbix_hostid: 'zabbixHostId',
    eventtype: 'eventType',
    hostprofile: 'hostProfile',
    hostprofilename: 'hostProfileName',
    outputprofile: 'outputProfile'
  }[normalized] ?? field;
}

export function uniqueTokens(tokens) {
  return [...new Set(tokens.filter(Boolean).map(String))];
}

export function normalizeToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function sameNormalized(left, right) {
  return normalizeToken(left) === normalizeToken(right);
}

function sourceFieldAttributeIsReference(attribute = {}) {
  return String(attribute?.type ?? '').toLowerCase() === 'reference';
}

function sourceFieldRuleByKey(sourceFields = {}, fieldKey = '') {
  if (sourceFields[fieldKey]) {
    return sourceFields[fieldKey];
  }

  const wanted = normalizeToken(fieldKey);
  return Object.entries(sourceFields)
    .find(([key]) => normalizeToken(key) === wanted)
    ?.[1];
}

function uniqueSourceFieldKey(sourceFields = {}, baseKey = '', fieldRule = {}) {
  const base = baseKey || 'cmdbPathField';
  let candidate = base;
  let index = 2;
  while (sourceFieldRuleByKey(sourceFields, candidate)
    && !sourceFieldRulesShareCmdbPath(sourceFieldRuleByKey(sourceFields, candidate), fieldRule)) {
    candidate = `${base}${index}`;
    index += 1;
  }

  return candidate;
}

function normalizeCmdbPath(cmdbPath) {
  return String(cmdbPath ?? '')
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.toLowerCase())
    .join('.');
}

function cmdbPathSegmentForFieldKey(segment) {
  const text = String(segment ?? '').trim();
  const domain = text.match(/^\{domain:(.+)\}$/i);
  return domain ? `domain ${domain[1]}` : text;
}

function cmdbPathSegmentForDisplay(segment) {
  return cmdbPathSegmentForFieldKey(segment);
}

function camelFieldKeySegment(value, lowerFirst) {
  const text = String(value ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return lowerFirst ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function escapeTemplateString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function uniqueHostProfileName(rules, baseName) {
  const existing = new Set((rules.hostProfiles ?? []).map(profile => normalizeRuleName(profile.name)));
  let candidate = baseName || 'class-main';
  let index = 2;
  while (existing.has(normalizeRuleName(candidate))) {
    candidate = `${baseName}-${index}`;
    index += 1;
  }
  return candidate;
}
