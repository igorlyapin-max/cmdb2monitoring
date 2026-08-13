import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ignoredProfileScopedRules,
  isProfileScopedRule,
  matchesConditionExpression,
  profileBoundCondition,
  validateRulesConditions
} from '../public/lib/condition-expression.js';

test('nested condition evaluates (A AND B) OR C', () => {
  const condition = {
    expression: {
      operator: 'any',
      items: [
        {
          operator: 'all',
          items: [
            { operator: 'equals', field: 'criticality', value: 'High' },
            { operator: 'notEquals', field: 'lifecycle', value: 'Retired' }
          ]
        },
        { operator: 'regex', field: 'service', pattern: '(?i)^network$' }
      ]
    }
  };

  assert.equal(matchesConditionExpression(condition, field => ({ criticality: 'High', lifecycle: 'Active' })[field]), true);
  assert.equal(matchesConditionExpression(condition, field => ({ criticality: 'High', lifecycle: 'Retired' })[field]), false);
  assert.equal(matchesConditionExpression(condition, field => ({ service: 'Network' })[field]), true);
});

test('profile-bound condition preserves nested object conditions under root all', () => {
  const objectExpression = {
    operator: 'any',
    items: [
      {
        operator: 'all',
        items: [
          { operator: 'equals', field: 'criticality', value: '1' },
          { operator: 'notEquals', field: 'criticality', value: '2' }
        ]
      },
      { operator: 'regex', field: 'criticality', pattern: '(?i)^3$' }
    ]
  };
  const condition = profileBoundCondition('arm-main', objectExpression);

  assert.equal(condition.expression.operator, 'all');
  assert.deepEqual(condition.expression.items[0], {
    operator: 'equals', field: 'hostProfile', value: 'arm-main'
  });
  assert.deepEqual(condition.expression.items[1], objectExpression);
});

test('notEquals and notRegex do not match blank values', () => {
  assert.equal(matchesConditionExpression({ expression: { operator: 'notEquals', field: 'criticality', value: 'Critical' } }, () => ''), false);
  assert.equal(matchesConditionExpression({ expression: { operator: 'notRegex', field: 'criticality', pattern: '^Critical$' } }, () => undefined), false);
});

test('legacy conditions and defaults.templates are rejected', () => {
  const errors = validateRulesConditions({
    defaults: { templates: [{ templateid: '10564' }] },
    hostProfiles: [{ when: { allRegex: [{ field: 'className', pattern: '.*' }] } }],
    templateSelectionRules: [{ templatesRef: 'defaults.templates' }]
  });

  assert.ok(errors.some(error => error.includes('allRegex')));
  assert.ok(errors.some(error => error.includes('defaults.templates')));
  assert.ok(errors.some(error => error.includes('templatesRef')));
});

test('profile-scoped rules derive class from hostProfile and reject foreign condition fields', () => {
  const rules = {
    source: {
      fields: {
        criticality: { cmdbPath: 'ARM.Criticality' },
        printerModel: { cmdbPath: 'Printer.Model' }
      }
    },
    hostProfiles: [{
      name: 'arm-main',
      when: { expression: { operator: 'equals', field: 'className', value: 'ARM' } }
    }],
    templateSelectionRules: [{
      when: {
        expression: {
          operator: 'all',
          items: [
            { operator: 'equals', field: 'hostProfile', value: 'arm-main' },
            { operator: 'exists', field: 'criticality' }
          ]
        }
      }
    }]
  };

  assert.deepEqual(validateRulesConditions(rules), []);

  rules.templateSelectionRules[0].when.expression.items.push({
    operator: 'equals', field: 'className', value: 'ARM'
  });
  rules.templateSelectionRules[0].when.expression.items.push({
    operator: 'exists', field: 'printerModel'
  });
  const errors = validateRulesConditions(rules);

  assert.ok(errors.some(error => error.includes("cannot use 'className'")));
  assert.ok(errors.some(error => error.includes("field 'printerModel' belongs to CMDBuild class 'Printer'")));
});

test('manual hostProfile conditions keep regex and branching semantics', () => {
  const errors = validateRulesConditions({
    hostProfiles: [{
      name: 'arm-main',
      when: { expression: { operator: 'equals', field: 'className', value: 'ARM' } }
    }],
    templateSelectionRules: [{
      when: {
        expression: {
          operator: 'any',
          items: [
            { operator: 'equals', field: 'hostProfile', value: 'arm-main' },
            { operator: 'always' }
          ]
        }
      }
    }]
  });

  assert.deepEqual(errors, []);
});

test('rules without one required known hostProfile are ignored', () => {
  const rules = {
    hostProfiles: [{
      name: 'arm-main',
      when: { expression: { operator: 'equals', field: 'className', value: 'ARM' } }
    }],
    templateSelectionRules: [{
      when: {
        expression: {
          operator: 'any',
          items: [
            { operator: 'equals', field: 'hostProfile', value: 'arm-main' },
            { operator: 'equals', field: 'className', value: 'ARM' }
          ]
        }
      }
    }, {
      when: { expression: { operator: 'always' } }
    }]
  };

  assert.equal(isProfileScopedRule(rules.templateSelectionRules[0], rules), false);
  assert.equal(isProfileScopedRule(rules.templateSelectionRules[1], rules), false);
  assert.deepEqual(validateRulesConditions(rules), []);
  assert.deepEqual(ignoredProfileScopedRules(rules).map(item => item.reason), [
    'host_profile_required',
    'host_profile_required'
  ]);
});
