# cmdb2monitoring Testing Development Plan

Last updated: 2026-05-03.

## Goal

Reduce regression risk in the core chain `CMDBuild catalog -> UI draft -> conversion rules -> converter -> Zabbix request`. The latest `source.entityClasses` without a matching `hostProfiles[]` issue showed that live E2E catches some problems too late, while some UI buttons can finish with no visible result.

## Full Additional Set

| Block | Scenario count |
| --- | ---: |
| JS unit/regression tests for mapping/rules logic | 12+ |
| .NET unit tests for `cmdbkafka2zabbix` | 15 |
| .NET unit tests for `zabbixrequests2api` | 5 |
| JSON contract / fixture tests | 9 |
| Playwright UI tests for Mapping | 20 |
| Playwright UI tests for Webhooks | 10 |
| UI no-silent-action regression | 7 |
| Live E2E smoke for the latest defect class | 2 |
| **Total** | **80+** |

## First Package

The first package should catch the highest-risk regressions without requiring the full live environment:

- JS unit/regression tests for mapping/rules logic;
- contract fixture tests for rules/catalog consistency;
- Playwright `No Silent Actions` checks for active buttons;
- several Playwright scenarios for Logical Control and Webhook Setup;
- two live smoke checks for `no_host_profile_matched`.

### Started Implementation

The first JS unit/regression subpackage has started:

- pure mapping/rules logic moved from `public/app.js` to `public/lib/mapping-logic.mjs`;
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
