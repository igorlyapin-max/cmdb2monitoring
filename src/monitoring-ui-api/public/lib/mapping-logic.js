export function ensureMinimalHostProfileForClass(rules, className, fieldKey, fieldRule = {}, target = {}) {
  if (!rules || !className || !fieldKey || classHasHostProfile(rules, className)) {
    return { created: false };
  }

  const mode = minimalHostProfileInterfaceMode(fieldKey, fieldRule, target);
  if (!['ip', 'dns'].includes(mode)) {
    return { created: false };
  }

  rules.hostProfiles = Array.isArray(rules.hostProfiles) ? rules.hostProfiles : [];
  const baseName = `${normalizeRuleName(className)}-main`;
  const profileName = uniqueHostProfileName(rules, baseName);
  const nextPriority = Math.max(0, ...rules.hostProfiles.map(profile => Number(profile.priority) || 0)) + 10;
  const profile = {
    name: profileName,
    priority: nextPriority,
    createOnUpdateWhenMissing: true,
    when: {
      allRegex: [
        {
          field: 'className',
          pattern: `(?i)^${escapeRegex(className)}$`
        }
      ]
    },
    hostNameTemplate: 'cmdb-<#= Model.ClassName #>-<#= Model.Code ?? Model.EntityId #>',
    visibleNameTemplate: '<#= Model.ClassName #> <#= Model.Code ?? Model.EntityId #>',
    interfaces: [
      {
        name: `${profileName}-agent-${mode}`,
        priority: 10,
        interfaceProfileRef: 'agent',
        mode,
        valueField: fieldKey,
        when: {
          fieldExists: fieldKey
        }
      }
    ]
  };

  rules.hostProfiles.push(profile);
  return { created: true, profileName, profile };
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

  const classes = ruleClassConditions(profile);
  return classes.length === 0 || classes.some(item => sameNormalized(item, className));
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

export function sourceFieldAddressKind(fieldKey, fieldRule = {}) {
  const type = String(fieldRule.type ?? '').toLowerCase();
  const resolveLeafType = String(fieldRule.resolve?.leafType ?? '').toLowerCase();
  if (type.includes('lookup') || resolveLeafType === 'lookup' || fieldRule.lookupType) {
    return 'lookup';
  }
  if (type === 'reference') {
    return 'reference';
  }

  const tokens = [
    fieldKey,
    canonicalSourceField(fieldKey),
    fieldRule.source,
    fieldRule.cmdbAttribute,
    ...(Array.isArray(fieldRule.sources) ? fieldRule.sources : []),
    ...(Array.isArray(fieldRule.cmdbAttributes) ? fieldRule.cmdbAttributes : []),
    ...String(fieldRule.cmdbPath ?? '').split('.')
  ].map(value => String(value ?? '').toLowerCase());
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

export function ruleClassConditions(rule) {
  const matchers = [
    ...(rule?.when?.anyRegex ?? []),
    ...(rule?.when?.allRegex ?? [])
  ].filter(matcher => canonicalSourceField(matcher.field) === 'className');

  return uniqueTokens(matchers.flatMap(matcher => regexLiteralValues(matcher.pattern)));
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
