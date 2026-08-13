const groupOperators = new Set(['all', 'any', 'not']);
const leafOperators = new Set(['always', 'equals', 'notequals', 'regex', 'notregex', 'exists', 'empty']);
const legacyProperties = new Set(['allRegex', 'anyRegex', 'fieldExists', 'fieldsExist', 'fallback']);
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

export function requiredHostProfileName(rule = {}) {
  const root = conditionExpression(rule.when);
  if (String(root?.operator ?? '').trim().toLowerCase() !== 'all') {
    return '';
  }
  const values = [];
  collectRequiredEqualsValues(root, 'hostProfile', values);
  const unique = [...new Map(values.map(value => [normalizeValue(value), value])).values()];
  return unique.length === 1 ? unique[0] : '';
}

export function isProfileScopedRule(rule = {}, rules = {}) {
  const profileName = requiredHostProfileName(rule);
  return Boolean(profileName) && (rules.hostProfiles ?? [])
    .some(profile => sameValue(profile?.name, profileName, {}));
}

export function ignoredProfileScopedRules(rules = {}) {
  const ignored = [];
  for (const collection of profileScopedRuleCollections) {
    const entries = rules?.[collection];
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((rule, index) => {
      const required = requiredHostProfileName(rule);
      if (!required) {
        ignored.push({ collection, index, reason: 'host_profile_required' });
      } else if (!(rules.hostProfiles ?? []).some(profile => sameValue(profile?.name, required, {}))) {
        ignored.push({ collection, index, reason: 'host_profile_unknown', profileName: required });
      }
    });
  }
  return ignored;
}

export function alwaysCondition() {
  return { expression: { operator: 'always' } };
}

export function conditionLeaf(field, operator, value = '') {
  const expression = { operator, field };
  if (operator === 'regex' || operator === 'notRegex') {
    expression.pattern = value;
  } else if (operator === 'equals' || operator === 'notEquals') {
    expression.value = value;
  }
  return expression;
}

export function allCondition(items) {
  const filtered = items.filter(Boolean);
  return filtered.length === 1 ? filtered[0] : { operator: 'all', items: filtered };
}

export function profileBoundCondition(profileName, objectExpression = { operator: 'always' }) {
  const items = [conditionLeaf('hostProfile', 'equals', String(profileName ?? '').trim())];
  if (String(objectExpression?.operator ?? '').toLowerCase() !== 'always') {
    items.push(objectExpression);
  }
  return { expression: { operator: 'all', items } };
}

export function conditionExpression(condition = {}) {
  return condition?.expression ?? null;
}

export function validateRulesConditions(rules = {}) {
  const errors = [];
  rejectLegacyShape(rules, '$', errors);
  if (rules?.defaults && Object.hasOwn(rules.defaults, 'templates')) {
    errors.push('defaults.templates is not supported; declare every monitoring template in templateSelectionRules.');
  }

  for (const [collection, entries] of conditionCollections(rules)) {
    entries.forEach((rule, index) => validateRuleCondition(rule, `${collection}[${index}]`, errors));
  }
  validateProfileScopedRules(rules, errors);
  return errors;
}

export function validateCondition(condition, path = 'when') {
  const errors = [];
  if (!condition || typeof condition !== 'object') {
    return [`${path} must be an object with expression.`];
  }
  validateExpression(condition.expression, `${path}.expression`, errors);
  return errors;
}

export function conditionFields(condition = {}) {
  const fields = [];
  collectConditionFields(conditionExpression(condition), fields);
  return [...new Set(fields.filter(Boolean))];
}

export function ruleMayApplyToClass(rule = {}, className, options = {}) {
  return expressionMayApplyToClass(conditionExpression(rule.when), className, options);
}

export function conditionExactValues(condition = {}, fieldName) {
  const values = [];
  collectExactValues(conditionExpression(condition), fieldName, values);
  return [...new Set(values)];
}

export function replaceConditionField(condition, oldField, newField, options = {}) {
  const expression = conditionExpression(condition);
  const changed = replaceExpressionField(expression, oldField, newField);
  if (!changed && options.setWhenMissing && condition && typeof condition === 'object') {
    condition.expression = conditionLeaf(newField, 'exists');
    return true;
  }
  return changed;
}

export function conditionSummary(condition = {}, fieldLabel = field => field) {
  return expressionSummary(conditionExpression(condition), fieldLabel) || 'некорректное условие';
}

export function matchesConditionExpression(condition, readField) {
  return matchesExpression(conditionExpression(condition), readField);
}

function conditionCollections(rules) {
  const result = [
    ['monitoringSuppressionRules', rules.monitoringSuppressionRules ?? []],
    ['hostProfiles', rules.hostProfiles ?? []],
    ['groupSelectionRules', rules.groupSelectionRules ?? []],
    ['templateSelectionRules', rules.templateSelectionRules ?? []],
    ['interfaceAddressRules', rules.interfaceAddressRules ?? []],
    ['interfaceSelectionRules', rules.interfaceSelectionRules ?? []],
    ['tagSelectionRules', rules.tagSelectionRules ?? []],
    ['proxySelectionRules', rules.proxySelectionRules ?? []],
    ['proxyGroupSelectionRules', rules.proxyGroupSelectionRules ?? []],
    ['hostMacroSelectionRules', rules.hostMacroSelectionRules ?? []],
    ['inventorySelectionRules', rules.inventorySelectionRules ?? []],
    ['interfaceProfileSelectionRules', rules.interfaceProfileSelectionRules ?? []],
    ['hostStatusSelectionRules', rules.hostStatusSelectionRules ?? []],
    ['maintenanceSelectionRules', rules.maintenanceSelectionRules ?? []],
    ['tlsPskSelectionRules', rules.tlsPskSelectionRules ?? []],
    ['valueMapSelectionRules', rules.valueMapSelectionRules ?? []]
  ];
  for (const [index, profile] of (rules.hostProfiles ?? []).entries()) {
    result.push([`hostProfiles[${index}].interfaces`, profile?.interfaces ?? []]);
  }
  return result.filter(([, entries]) => Array.isArray(entries));
}

function validateRuleCondition(rule, path, errors) {
  validateExpression(rule?.when?.expression, `${path}.when.expression`, errors);
}

function validateProfileScopedRules(rules, errors) {
  for (const collection of profileScopedRuleCollections) {
    const entries = rules?.[collection];
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((rule, index) => validateProfileScopedRule(rule, `${collection}[${index}]`, rules, errors));
  }
}

function validateProfileScopedRule(rule, path, rules, errors) {
  const expression = rule?.when?.expression;
  const fields = conditionFields(rule?.when);
  if (!isProfileScopedRule(rule, rules)) {
    return;
  }

  for (const field of fields) {
    if (sameField(field, 'className') || sameField(field, 'outputProfile')) {
      errors.push(`${path} cannot use '${field}' when scoped to hostProfile; derive the class from the profile.`);
    }
  }

  const profileNames = [requiredHostProfileName(rule)];
  const profile = (rules?.hostProfiles ?? [])
    .find(item => sameValue(item?.name, profileNames[0], {}));
  if (!profile) {
    errors.push(`${path}.when.expression references unknown hostProfile '${profileNames[0]}'.`);
    return;
  }

  const profileClasses = conditionExactValues(profile.when, 'className');
  if (profileClasses.length !== 1) {
    errors.push(`${path}.when.expression cannot derive exactly one CMDBuild class from hostProfile '${profile.name}'.`);
    return;
  }

  for (const field of [...fields, rule?.valueField].filter(Boolean)) {
    if (sameField(field, 'eventType') || sameField(field, 'hostProfile')) {
      continue;
    }
    if (sameField(field, 'className') || sameField(field, 'outputProfile')) {
      continue;
    }

    const sourceField = sourceFieldRule(rules, field);
    const sourceClass = cmdbPathClassName(sourceField?.cmdbPath);
    if (sourceClass && !sameValue(sourceClass, profileClasses[0], {})) {
      errors.push(`${path} field '${field}' belongs to CMDBuild class '${sourceClass}', not hostProfile '${profile.name}' class '${profileClasses[0]}'.`);
    }
  }
}

function collectRequiredEqualsValues(expression, fieldName, values) {
  if (!expression || typeof expression !== 'object') {
    return;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'all') {
    (expression.items ?? []).forEach(item => collectRequiredEqualsValues(item, fieldName, values));
    return;
  }
  if (operator === 'equals' && sameField(expression.field, fieldName) && String(expression.value ?? '').trim()) {
    values.push(String(expression.value));
  }
}

function normalizeValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function requiredProfileValues(expression, fieldName, values = []) {
  if (!expression || typeof expression !== 'object') {
    return values;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'all') {
    (expression.items ?? []).forEach(item => requiredProfileValues(item, fieldName, values));
  } else if (operator === 'equals' && sameField(expression.field, fieldName) && String(expression.value ?? '').trim()) {
    values.push(String(expression.value));
  } else if (operator === 'regex' && sameField(expression.field, fieldName)) {
    values.push(...regexLiteralValues(expression.pattern));
  }
  return [...new Map(values.map(value => [String(value).trim().toLowerCase(), value])).values()];
}

function sourceFieldRule(rules, fieldName) {
  return Object.entries(rules?.source?.fields ?? {})
    .find(([field]) => sameField(field, fieldName))?.[1];
}

function cmdbPathClassName(cmdbPath) {
  return String(cmdbPath ?? '').split('.')[0].trim();
}

function validateExpression(expression, path, errors) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    errors.push(`${path} is required.`);
    return;
  }

  const operator = String(expression.operator ?? '').trim();
  const normalized = operator.toLowerCase();
  if (!groupOperators.has(normalized) && !leafOperators.has(normalized)) {
    errors.push(`${path}.operator '${operator}' is unsupported.`);
    return;
  }

  const items = Array.isArray(expression.items) ? expression.items : [];
  if (normalized === 'all' || normalized === 'any') {
    if (items.length === 0) {
      errors.push(`${path}.items must contain at least one condition.`);
    }
    items.forEach((item, index) => validateExpression(item, `${path}.items[${index}]`, errors));
    return;
  }

  if (normalized === 'not') {
    if (items.length !== 1) {
      errors.push(`${path}.items must contain exactly one condition for operator 'not'.`);
    }
    items.forEach((item, index) => validateExpression(item, `${path}.items[${index}]`, errors));
    return;
  }

  if (normalized === 'always') {
    return;
  }

  if (!String(expression.field ?? '').trim()) {
    errors.push(`${path}.field is required for operator '${operator}'.`);
  }
  if (normalized === 'equals' || normalized === 'notequals') {
    if (!String(expression.value ?? '').trim()) {
      errors.push(`${path}.value is required for operator '${operator}'; use 'empty' for blank values.`);
    }
  }
  if (normalized === 'regex' || normalized === 'notregex') {
    const pattern = String(expression.pattern ?? '');
    if (!pattern) {
      errors.push(`${path}.pattern is required for operator '${operator}'.`);
    } else {
      try {
        compileRegex(pattern);
      } catch (error) {
        errors.push(`${path}.pattern is invalid: ${error.message}`);
      }
    }
  }
}

function rejectLegacyShape(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectLegacyShape(item, `${path}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (legacyProperties.has(key)) {
      errors.push(`${path}.${key} is not supported; use when.expression.`);
    }
    if (key === 'templatesRef' && item === 'defaults.templates') {
      errors.push(`${path}.${key} is not supported; declare every monitoring template in templateSelectionRules.`);
    }
    rejectLegacyShape(item, `${path}.${key}`, errors);
  }
}

function collectConditionFields(expression, fields) {
  if (!expression || typeof expression !== 'object') {
    return;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (groupOperators.has(operator)) {
    (expression.items ?? []).forEach(item => collectConditionFields(item, fields));
  } else if (operator !== 'always' && expression.field) {
    fields.push(expression.field);
  }
}

function collectExactValues(expression, fieldName, values) {
  if (!expression || typeof expression !== 'object') {
    return;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (groupOperators.has(operator)) {
    (expression.items ?? []).forEach(item => collectExactValues(item, fieldName, values));
    return;
  }
  if ((operator === 'equals' || operator === 'regex') && sameField(expression.field, fieldName)) {
    if (operator === 'equals' && expression.value) {
      values.push(expression.value);
    } else if (operator === 'regex') {
      values.push(...regexLiteralValues(expression.pattern));
    }
  }
}

function replaceExpressionField(expression, oldField, newField) {
  if (!expression || typeof expression !== 'object') {
    return false;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (groupOperators.has(operator)) {
    return (expression.items ?? []).some(item => replaceExpressionField(item, oldField, newField));
  }
  if (expression.field && sameField(expression.field, oldField)) {
    expression.field = newField;
    return true;
  }
  return false;
}

function expressionMayApplyToClass(expression, className, options) {
  if (!expression || typeof expression !== 'object') {
    return true;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'all') {
    return (expression.items ?? []).every(item => expressionMayApplyToClass(item, className, options));
  }
  if (operator === 'any') {
    return (expression.items ?? []).some(item => expressionMayApplyToClass(item, className, options));
  }
  if (operator === 'not') {
    return true;
  }
  if (!sameField(expression.field, 'className')) {
    return true;
  }
  if (operator === 'equals') {
    return sameValue(expression.value, className, options);
  }
  if (operator === 'notequals') {
    return !sameValue(expression.value, className, options);
  }
  if (operator === 'regex') {
    try {
      return compileRegex(expression.pattern).test(className);
    } catch {
      return false;
    }
  }
  if (operator === 'notregex') {
    try {
      return !compileRegex(expression.pattern).test(className);
    } catch {
      return true;
    }
  }
  return true;
}

function matchesExpression(expression, readField) {
  if (!expression || typeof expression !== 'object') {
    return false;
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'always') {
    return true;
  }
  if (operator === 'all') {
    return Array.isArray(expression.items)
      && expression.items.length > 0
      && expression.items.every(item => matchesExpression(item, readField));
  }
  if (operator === 'any') {
    return Array.isArray(expression.items)
      && expression.items.length > 0
      && expression.items.some(item => matchesExpression(item, readField));
  }
  if (operator === 'not') {
    return Array.isArray(expression.items)
      && expression.items.length === 1
      && !matchesExpression(expression.items[0], readField);
  }

  const value = String(readField(expression.field) ?? '').trim();
  if (operator === 'exists') {
    return value !== '';
  }
  if (operator === 'empty') {
    return value === '';
  }
  if (value === '') {
    return false;
  }
  if (operator === 'equals') {
    return value.localeCompare(String(expression.value ?? '').trim(), undefined, { sensitivity: 'accent' }) === 0;
  }
  if (operator === 'notequals') {
    return value.localeCompare(String(expression.value ?? '').trim(), undefined, { sensitivity: 'accent' }) !== 0;
  }
  try {
    if (operator === 'regex') {
      return compileRegex(expression.pattern).test(value);
    }
    if (operator === 'notregex') {
      return !compileRegex(expression.pattern).test(value);
    }
  } catch {
    return false;
  }
  return false;
}

function expressionSummary(expression, fieldLabel) {
  if (!expression || typeof expression !== 'object') {
    return '';
  }
  const operator = String(expression.operator ?? '').toLowerCase();
  if (operator === 'always') {
    return 'Всегда';
  }
  if (operator === 'all' || operator === 'any') {
    const separator = operator === 'all' ? ' И ' : ' ИЛИ ';
    return `(${(expression.items ?? []).map(item => expressionSummary(item, fieldLabel)).filter(Boolean).join(separator)})`;
  }
  if (operator === 'not') {
    return `НЕ (${expressionSummary(expression.items?.[0], fieldLabel)})`;
  }
  const field = fieldLabel(expression.field || '?');
  return {
    equals: `${field} = ${expression.value ?? ''}`,
    notequals: `${field} != ${expression.value ?? ''}`,
    regex: `${field} regex ${expression.pattern ?? ''}`,
    notregex: `${field} not regex ${expression.pattern ?? ''}`,
    exists: `${field} заполнено`,
    empty: `${field} пусто`
  }[operator] ?? '';
}

function compileRegex(pattern) {
  const value = String(pattern ?? '');
  const ignoreCase = value.startsWith('(?i)');
  return new RegExp(ignoreCase ? value.slice(4) : value, ignoreCase ? 'i' : '');
}

function regexLiteralValues(pattern) {
  const cleaned = String(pattern ?? '').replaceAll('(?i)', '').replace(/\^|\$/g, '').replace(/[()]/g, '');
  if (!cleaned.includes('|')) {
    const value = cleaned.replace(/\\/g, '').replace(/[\[\]{}.*+?^$]/g, '').trim();
    return value ? [value] : [];
  }
  return cleaned.split('|').map(value => value.replace(/\\/g, '').replace(/[\[\]{}.*+?^$]/g, '').trim()).filter(Boolean);
}

function sameField(left, right) {
  return String(left ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
    === String(right ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sameValue(left, right, options) {
  const normalize = options.normalize ?? (value => String(value ?? '').trim().toLowerCase());
  return normalize(left) === normalize(right);
}
