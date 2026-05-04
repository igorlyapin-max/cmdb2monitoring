# cmdb2monitoring Testing Development Plan

Last updated: 2026-05-04.

## Goal

Reduce regression risk in the core chain `CMDBuild catalog -> UI draft -> conversion rules -> converter -> Zabbix request`. The latest `source.entityClasses` without a matching `hostProfiles[]` issue showed that live E2E catches some problems too late, while some UI buttons can finish with no visible result.

## Full Additional Set

| Block | Scenario count |
| --- | ---: |
| JS unit/regression tests for mapping/rules logic | 15+ |
| .NET unit tests for `cmdbkafka2zabbix` | 15 |
| .NET unit tests for `zabbixrequests2api` | 8 |
| JSON contract / fixture tests | 10 |
| Playwright UI tests for Mapping | 20 |
| Playwright UI tests for Webhooks | 10 |
| Playwright UI tests for Zabbix template compatibility | 5 |
| UI no-silent-action regression | 7 |
| Live E2E smoke for the latest defect class | 2 |
| **Total** | **92+** |

## First Package

The first package should catch the highest-risk regressions without requiring the full live environment:

- JS unit/regression tests for mapping/rules logic;
- contract fixture tests for rules/catalog consistency;
- Playwright `No Silent Actions` checks for active buttons;
- several Playwright scenarios for Logical Control and Webhook Setup;
- two live smoke checks for `no_host_profile_matched`.

### Started Implementation

The first JS unit/regression subpackage has started:

- pure mapping/rules logic moved from `public/app.js` to `public/lib/mapping-logic.js`;
- tests added in `src/monitoring-ui-api/test/mapping-logic.test.mjs`;
- run from `src/monitoring-ui-api` with `npm test` or `npm run test:mapping`.

Covered starter scenarios:

1. IP field is recognized by `validationRegex`.
2. DNS/FQDN field is recognized by alias/metadata.
3. Lookup/reference leaf is not accepted as an interface address.
4. IP field is blocked for DNS target.
5. DNS field is blocked for IP target.
6. Unknown address field is blocked for IP/DNS target.
7. Compatible IP/DNS targets are allowed.
8. Domain path is treated as multi-value.
9. `resolve.collectionMode=first` removes the multi-value block.
10. New class with IP leaf gets a minimal `hostProfiles[]`.
11. New class with DNS leaf gets a DNS profile.
12. Existing matching profile is not duplicated.
13. Disabled profile is not treated as matching and can be replaced.
14. Regex alternatives and global profile match classes correctly.
15. Dynamic target is allowed only for `tags` and `hostGroups` when explicit runtime switches are enabled.
16. Dynamic target is serialized as `targetMode=dynamicFromLeaf`, not as an empty Zabbix target.
17. Dynamic tag/host group helpers build explicit `valueField`, `createIfMissing`, and T4 value/name templates.
18. Virtual `hostProfile`/`outputProfile` fields are available in the add/modify rule editor, can be used as `Template rule` conditions, and are not serialized into `source.fields`.

Added the .NET regression suite `tests/cmdbresolver`, included in `scripts/test-configs.sh`. It verifies that a source-card update rereads mutable CMDBuild data through the same resolver instance:

1. A lookup id is reread from lookup values and converted to the current code.
2. A reference leaf card is reread and returns the new leaf value.
3. A domain leaf card is reread through relations and returns the new leaf value.
4. The updated domain leaf value goes through the converter and reaches the final JSON-RPC `groups[]` as a dynamic host group.

Next dynamic-target subpackage:

- Playwright Mapping: with switches disabled, empty target for `Tag rule`/`Host group rule` cannot be saved; with switches enabled, the explicit `Create/expand from CMDBuild leaf` mode appears;
- JSON contract: dynamic rules without `valueField` or with an unsupported conversion structure are invalid;
- configvalidation converter fixture: dynamic tag is emitted into `tags[]`, dynamic host group is emitted into `groups[]` as name/createIfMissing before the Zabbix writer;
- configvalidation Zabbix writer fixture: when a leaf group appears for the first time, `hostgroup.create` returns `groupid`, and that `groupid` is written into the same `host.create/update` payload; dynamic tags remain in the same host payload;
- live smoke: an existing host group is resolved by name, a missing one is created only with `AllowDynamicHostGroupCreate=true`, and disabled creation returns `auto_expand_disabled`.

Next Zabbix writer validation subpackage:

- .NET unit: duplicate item key in two templates returns `template_conflict`, `zabbixRequestSent=false`, and does not call `ExecuteAsync`;
- .NET unit: duplicate LLD rule key in two templates returns `template_conflict`;
- .NET unit: duplicate `inventory_link` in two templates returns `template_conflict`;
- .NET unit: update fallback validates compatibility after merging current and target templates with `templates_clear`;
- JSON contract: a `template_conflict` response contains the conflicting key or inventory link, template names/templateids, and the reading location `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`.

Next UI validation subpackage for incompatible Zabbix templates:

- Playwright Mapping: trying to add a template rule that creates an item key, LLD rule key, or `inventory_link` conflict inside one final host profile highlights the chain in red, blocks save, and shows the conflicting templates;
- Playwright Mapping: when the conflict is resolved through `templateConflictRules`/`templates_clear` or by choosing a compatible template set, the red state is cleared, save becomes available, and `Undo`/`Redo` reflect the draft change;
- Playwright Logical Control: an existing rules file with an incompatible final template set shows a critical inconsistency and offers `Edit`, `Delete`, and `Cancel` actions without a silent no-op;
- Playwright Zabbix metadata: UI uses metadata from the Zabbix catalog/template metadata, not hardcoded template pairs, and separately displays item key, LLD rule key, and `inventory_link` conflicts;
- Playwright Zabbix metadata: `Sync` and `Load` update tables/summary/status, show the Zabbix version, and do not produce a silent no-op when the cache is empty;
- Playwright Git Settings: `Read from git`, `RulesFilePath`, and `Git repository URL` are saved separately from Runtime Settings, `Check access` shows resolved path, `schemaVersion`, and `rulesVersion`, and leaving the page with unsaved changes warns the operator;
- UI response view/Event status: a response with `errorCode=template_conflict` and `zabbixRequestSent=false` is visible to the operator with the conflicting key/template names and the reading location `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`.

## UI Regression: No Silent Actions

Separate UI-test rule: every active button must either change state or show an explainable error.

Accepted effects:

- draft JSON changed;
- toast/status message appeared;
- `Undo`/`Redo`/`Save file as` state changed;
- selected field was cleared;
- red/green/yellow border appeared;
- result panel received JSON;
- button remained disabled with a clear explanation nearby.

A silent no-op from an active button is a UI test failure.

Priority Mapping buttons:

- `Add`;
- `Save changes`;
- `Reset fields`;
- `Apply selected`;
- `Undo`;
- `Redo`;
- `Save file as`.

## UI Regression: Webhook Visual Diff

Verify that row state and payload diff match operation semantics:

- `Create`: row and added payload keys are green;
- `Update`: row is marked as update, additions are green, removals are red, unchanged values are black;
- `Delete`: row is red and delete operations are not selected by default;
- expanding a row shows details in the expected place with the same diff;
- `Edit` changes only the selected operation;
- `Undo/Redo` restores selection/edit-plan state;
- repeated analyze after synchronization must not mass-mark old classes as `Update`.

## Future Bug Rule

Every fixed bug gets a regression test at the lowest practical level:

- pure function test when the defect is in rules/mapping logic;
- contract fixture when the defect is in JSON rules/catalog structure;
- Playwright test when the defect is in UI reaction or button behavior;
- live E2E smoke when the defect appears only across services.
